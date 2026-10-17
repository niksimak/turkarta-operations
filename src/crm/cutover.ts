import type postgres from "postgres";

export interface CutoverCounts {
  /** Open tickets whose last customer-visible message is the agent's: no longer waiting. */
  waitingCleared: number;
  /** Open tickets stamped as already pinged, so the first worker tick posts no overdue burst. */
  pingsStamped: number;
  /** Claimed in the forum or Bitrix but never assigned in the CRM: back to the queue. */
  requeued: number;
}

class DryRun extends Error {
  constructor(readonly counts: CutoverCounts) { super("dry_run"); }
}

const OPEN = ["new", "allocated", "awaiting"];

/**
 * One-off at SUPPORT_SURFACE=crm cutover (scripts/crm_cutover.ts). One transaction; a dry run
 * performs the same writes and rolls back, so its counts are exact.
 * Requeued tickets get no crm_ticket_events row: assigned_operator_id stays null, so no assignee changed.
 */
export async function crmCutover(sql: postgres.Sql, apply: boolean): Promise<CutoverCounts> {
  try {
    return await sql.begin(async (tx) => {
      const waiting = await tx`
        update support_requests r set waiting_since = null
         where r.status in ${tx(OPEN)} and r.waiting_since is not null
           and (select m.sender from support_messages m
                 where m.ticket_id = r.id and m.kind <> 'note'
                 order by m.seq desc limit 1) = 'agent'`;
      const pinged = await tx`
        update support_requests set overdue_pinged_at = now() where status in ${tx(OPEN)}`;
      const requeued = await tx`
        update support_requests set status = 'new', queued_at = now()
         where status = 'allocated' and assigned_operator_id is null`;
      const counts = { waitingCleared: waiting.count, pingsStamped: pinged.count, requeued: requeued.count };
      if (!apply) throw new DryRun(counts);
      return counts;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.counts;
    throw err;
  }
}

class ArchiveDryRun extends Error {
  constructor(readonly count: number) { super("dry_run"); }
}

/**
 * One-off after cutover (scripts/crm_archive_backlog.ts): resolves open tickets opened before `before`
 * that the customer has not written to since, so the Bitrix-era backlog stops feeding auto-assign and
 * the queue. No resolve message is sent; a customer who writes again reopens the ticket as new.
 * Each one gets a status_changed event with reason cutover_backlog, which is also the rollback key.
 */
export async function archiveBacklog(sql: postgres.Sql, before: Date, apply: boolean): Promise<number> {
  const at = before.toISOString();
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx<{ id: string; from: string }[]>`
        with old as (
          select r.id, r.status from support_requests r
           where r.status in ${tx(OPEN)} and r.created_at < ${at}::timestamptz
             and not exists (select 1 from support_messages m
                              where m.ticket_id = r.id and m.sender = 'user' and m.created_at >= ${at}::timestamptz)
           for update of r
        )
        update support_requests r set status = 'resolved', resolved_at = now(), waiting_since = null
          from old where r.id = old.id
        returning r.id, old.status as from`;
      for (const r of rows) {
        await tx`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload)
          values (${r.id}, 'status_changed', null,
                  ${JSON.stringify({ from: r.from, to: "resolved", reason: "cutover_backlog" })}::text::jsonb)`;
      }
      if (!apply) throw new ArchiveDryRun(rows.length);
      return rows.length;
    });
  } catch (err) {
    if (err instanceof ArchiveDryRun) return err.count;
    throw err;
  }
}
