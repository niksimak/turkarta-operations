import { sql } from "../db.js";
import { activeAlerts, type Alerts } from "./alerts.js";
import { publish } from "./events.js";
import { getSettings } from "./settings.js";
import { assignTo, notifyAssigned, overdueCond, ticketItem, ticketWho } from "./tickets.js";

const BATCH = 20;
const NO_ONE_THROTTLE_MS = 15 * 60_000;
// Longer than two 60 s Telegram calls (media group + trailing text).
const STUCK_DELIVERY = "3 minutes";
const STUCK_DELIVERY_ERROR = "tg_interrupted: повторите отправку";
const ASSIGN_LOCK_KEY = 160010;
// Queue work means a customer is waiting: onboarding welcome tickets stay untouched until the user writes.

let lastNoOneAlertAt: number | null = null;

/** Test hook: forget the nobody-on-shift throttle. */
export function resetWorkerState(): void {
  lastNoOneAlertAt = null;
}

const code = (err: unknown) => (err as { code?: string }).code ?? "error";

async function safeAlert(what: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[crm-worker] ${what} alert failed code=${code(err)}`);
    return false;
  }
}

/** One worker pass. `now` overrides the DB clock (tests); production uses Postgres now(). */
export async function tick(
  now?: Date,
  deps: { alert?: Alerts } = {},
): Promise<{ assigned: number; overdue: number; noOneAlerted: boolean }> {
  const s = await getSettings();
  const alert = deps.alert ?? activeAlerts();
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

  const offline = await sql<{ id: string }[]>`
    update crm_operators set on_shift = false, updated_at = now()
     where on_shift and last_active_at < ${at} - make_interval(mins => ${s.offline_after_minutes})
    returning id::text as id`;
  for (const o of offline) await publish({ type: "operator.updated", operatorId: Number(o.id) });

  let assigned: Array<{ ticketId: string; operatorId: number; who: string }> = [];
  let unassigned = false;
  if (s.auto_assign_enabled) {
    ({ assigned, unassigned } = await sql.begin(async (tx) => {
      // Serializes ticks so the per-operator open count (and the cap) sees prior assignments.
      await tx`select pg_advisory_xact_lock(${ASSIGN_LOCK_KEY})`;
      const due = await tx<{ id: string; user_name: string | null; user_username: string | null }[]>`
        select id, user_name, user_username from support_requests
         where status = 'new' and waiting_since is not null
           and greatest(queued_at, waiting_since) < ${at} - make_interval(mins => ${s.auto_assign_minutes})
         order by queued_at
         for update skip locked
         limit ${BATCH}`;
      const done: Array<{ ticketId: string; operatorId: number; who: string }> = [];
      for (const t of due) {
        const [o] = await tx<{ id: string; name: string }[]>`
          select o.id::text as id, o.name from crm_operators o
           where o.on_shift and o.auto_assign_enabled and o.last_active_at > ${at} - make_interval(mins => ${s.offline_after_minutes})
             and (${s.auto_assign_max_open}::int is null or (select count(*) from support_requests r
                   where r.assigned_operator_id = o.id and r.status in ('allocated','awaiting')) < ${s.auto_assign_max_open}::int)
           order by (select count(*) from support_requests r where r.assigned_operator_id = o.id and r.status in ('allocated','awaiting')) asc,
                    o.last_assigned_at asc nulls first
           limit 1`;
        if (!o) return { assigned: done, unassigned: true };
        await assignTo(tx, t, { id: Number(o.id), name: o.name }, "auto_assigned", null);
        done.push({ ticketId: t.id, operatorId: Number(o.id), who: ticketWho(t) });
      }
      return { assigned: done, unassigned: false };
    }));
    for (const a of assigned) {
      await publish({ type: "ticket.updated", ticketId: a.ticketId });
      await notifyAssigned(a.ticketId, a.operatorId, a.who);
    }
  }

  let noOneAlerted = false;
  const nowMs = (now ?? new Date()).getTime();
  if (unassigned && s.tg_ping_no_one_on_shift && alert
      && (lastNoOneAlertAt === null || nowMs - lastNoOneAlertAt >= NO_ONE_THROTTLE_MS)) {
    const [q] = await sql<{ n: number }[]>`select count(*)::int as n from support_requests where status = 'new' and waiting_since is not null`;
    // Throttle only a delivered ping, so a Telegram failure retries on the next tick.
    if (await safeAlert("no_one_on_shift", () => alert.noOneOnShift(q!.n))) {
      lastNoOneAlertAt = nowMs;
      noOneAlerted = true;
    }
  }

  // Marked even when the ping is off, so turning it on later does not flush a backlog.
  const overdue = await sql<{ id: string; minutes: number }[]>`
    update support_requests r set overdue_pinged_at = ${at}
     where ${overdueCond(s, at)}
       and (r.overdue_pinged_at is null or r.overdue_pinged_at < r.waiting_since)
    returning r.id, floor(extract(epoch from (${at} - r.waiting_since)) / 60)::int as minutes`;
  if (s.tg_ping_overdue && alert) {
    for (const o of overdue) {
      await safeAlert("overdue", async () => {
        const item = await ticketItem(o.id);
        if (item) await alert.overdue(item, o.minutes);
      });
    }
  }

  // A reply interrupted mid-send (deploy, crash) would stay "sending" forever. Keyed on the attempt, not
  // created_at, so a retry of an old message is not failed mid-send; system texts fall back to created_at.
  const stuck = await sql<{ id: string; ticket_id: string }[]>`
    update support_messages set delivery_status = 'failed', delivery_error = ${STUCK_DELIVERY_ERROR}
     where sender = 'agent' and delivery_status = 'pending'
       and coalesce(delivery_attempt_at, created_at) < ${at} - ${STUCK_DELIVERY}::interval
    returning id, ticket_id`;
  for (const m of stuck) await publish({ type: "message.created", ticketId: m.ticket_id, messageId: m.id });

  return { assigned: assigned.length, overdue: overdue.length, noOneAlerted };
}

export function startCrmWorker(intervalMs = 30_000): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const loop = () => {
    active = tick().then(() => {}).catch((err) => console.error(`[crm-worker] tick failed code=${code(err)}`))
      .finally(() => { if (!stopped) timer = setTimeout(loop, intervalMs); });
  };
  timer = setTimeout(loop, intervalMs);
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
