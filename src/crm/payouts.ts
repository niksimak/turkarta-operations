// «Выплата» tickets: the main API asks the team to settle a referral or partner
// payout. One ticket per payout (`payout_key`), on its own channel with no
// customer behind it, so it never merges into a support chat and nothing is
// ever sent out from it. It queues like any new ticket (auto-assign, toast,
// sound, push), and the API closes it once the payout is paid or rejected.
import { sql, type Ticket } from "../db.js";
import { activeAlerts, firstLine } from "./alerts.js";
import { publish } from "./events.js";
import { getSettings } from "./settings.js";
import { logEvent, ticketItem } from "./tickets.js";

export interface PayoutOpen {
  payout_key: string; // "referral:<id>" / "partner:<id>"
  title: string; // one line: «Реферальная выплата 5 000 ₽»
  body: string; // the details the operator needs to act
  who: string; // the payee, shown as the ticket's name
  admin_url: string; // where the payout is settled
}

/** Opens the payout's ticket, or returns the one already open for it. */
export async function openPayoutTicket(p: PayoutOpen): Promise<{ ticket: Ticket; created: boolean }> {
  const created = await sql.begin(async (tx) => {
    const [row] = await tx<Ticket[]>`
      insert into support_requests
        (channel, source, payout_key, admin_url, user_name, first_message, queued_at, waiting_since, last_message_at)
      values ('payout', 'payout', ${p.payout_key}, ${p.admin_url}, ${p.who}, ${p.title}, now(), now(), now())
      on conflict (payout_key) where payout_key is not null do nothing
      returning *`;
    if (!row) return null;
    await tx`
      insert into support_messages (ticket_id, sender, body, actor_type, author_id, source_message_id, kind)
      values (${row.id}, 'system', ${`${p.title}\n\n${p.body}`}, 'system', 'api:payout', ${`payout-open:${p.payout_key}`}, 'text')`;
    return row;
  });
  if (!created) {
    const [existing] = await sql<Ticket[]>`select * from support_requests where payout_key = ${p.payout_key}`;
    return { ticket: existing!, created: false };
  }
  await publish({ type: "ticket.created", ticketId: created.id });
  await publish({
    type: "notify", operatorId: null, kind: "new_ticket", ticketId: created.id,
    title: "Выплата", body: `${p.who}: ${firstLine(p.title)}`,
  });
  // Not awaited: a slow Telegram must not hold the API's request.
  if ((await getSettings()).tg_ping_new_ticket) void alertNewPayout(created.id);
  return { ticket: created, created: true };
}

/** Resolves the payout's ticket with the outcome. False when there is no such ticket. */
export async function closePayoutTicket(
  payoutKey: string, outcome: "paid" | "rejected", note: string | null,
): Promise<boolean> {
  const done = await sql.begin(async (tx) => {
    const [t] = await tx<{ id: string; status: string }[]>`
      select id, status from support_requests where payout_key = ${payoutKey} for update`;
    if (!t) return null;
    if (t.status === "resolved") return { id: t.id, changed: false };
    const head = outcome === "paid" ? "Выплачено" : "Отклонено";
    await tx`
      insert into support_messages (ticket_id, sender, body, actor_type, author_id, source_message_id, kind)
      values (${t.id}, 'system', ${note ? `${head}: ${note}` : head}, 'system', 'api:payout', ${`payout-close:${payoutKey}`}, 'text')
      on conflict (source_message_id) where source_message_id is not null do nothing`;
    await tx`
      update support_requests set status = 'resolved', resolved_at = now(), waiting_since = null, last_message_at = now()
       where id = ${t.id}`;
    await logEvent(tx, t.id, "status_changed", null, { from: t.status, to: "resolved", by: "api", outcome });
    return { id: t.id, changed: true };
  });
  if (!done) return false;
  if (done.changed) {
    await publish({ type: "message.created", ticketId: done.id });
    await publish({ type: "ticket.updated", ticketId: done.id });
  }
  return true;
}

async function alertNewPayout(ticketId: string): Promise<void> {
  const alerts = activeAlerts();
  if (!alerts) return;
  try {
    const item = await ticketItem(ticketId);
    if (item) await alerts.newTicket(item);
  } catch (err) {
    console.error(`[crm-payouts] new payout alert failed ticket=${ticketId} code=${(err as { code?: string }).code ?? "error"}`);
  }
}
