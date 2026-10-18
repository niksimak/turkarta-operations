import type postgres from "postgres";
import { sql, type Ticket } from "../db.js";
import { publish } from "./events.js";
import { sendSystemText, type ReplyDeps, type TgExtra } from "./reply.js";
import { logEvent } from "./tickets.js";

export type Rating = "up" | "down";
export type CsatWho = { userTg: number } | { webUserId: string };
export const CSAT_UP = "👍 Да";
export const CSAT_DOWN = "👎 Нет";
export const CSAT_THANKS = "Спасибо за оценку!";
export const CSAT_ASK_COMMENT = "Что пошло не так? Ответьте на это сообщение — это необязательно.";
export const CSAT_COMMENT_THANKS = "Спасибо, передали команде.";
export const CSAT_CLOSED = "Оценка уже не принимается.";
const COMMENT_MAX = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sql = postgres.Sql | postgres.TransactionSql;

/** A human operator answered in the current cycle (after the last reopen). */
async function humanAnswered(ticketId: string): Promise<boolean> {
  const [r] = await sql`
    select exists (
      select 1 from support_messages m
       where m.ticket_id = ${ticketId} and m.actor_type = 'human'
         and m.created_at > coalesce((select max(e.created_at) from crm_ticket_events e
                                       where e.ticket_id = ${ticketId} and e.type = 'reopened'), '-infinity'::timestamptz)
    ) as ok`;
  return r?.ok === true;
}

/** The 👍/👎 buttons of a survey prompt. */
function csatExtra(id: string): TgExtra {
  return { reply_markup: { inline_keyboard: [[
    { text: CSAT_UP, callback_data: `csat:${id}:up` },
    { text: CSAT_DOWN, callback_data: `csat:${id}:down` },
  ]] } };
}

/** Send options for retrying a message: the survey's buttons when it is a CSAT prompt. */
export async function csatPromptExtra(messageId: string): Promise<TgExtra | undefined> {
  const [r] = await sql<{ id: string }[]>`select id from crm_csat where prompt_message_id = ${messageId}`;
  return r ? csatExtra(r.id) : undefined;
}

/** Asks once per resolution. Returns the survey id, or null when it is not asked. */
export async function askCsat(ticket: Ticket, text: string, deps: ReplyDeps = {}): Promise<string | null> {
  if (ticket.status !== "resolved" || !ticket.resolved_at || !(await humanAnswered(ticket.id))) return null;
  // resolved_at is copied in SQL: a JS Date drops the microseconds, and the survey is
  // matched to its resolution by exact equality (lockFor, csatForWeb).
  const [row] = await sql<{ id: string }[]>`
    insert into crm_csat (ticket_id, resolved_at, operator_id, channel)
    select r.id, r.resolved_at, r.assigned_operator_id, case when r.user_tg is not null then 'telegram' else 'web' end
      from support_requests r
     where r.id = ${ticket.id} and r.status = 'resolved' and r.resolved_at is not null
    on conflict (ticket_id, resolved_at) do nothing
    returning id`;
  if (!row) return null;
  const messageId = await sendSystemText(ticket, text, deps, csatExtra(row.id));
  await sql`update crm_csat set prompt_message_id = ${messageId} where id = ${row.id}`;
  return row.id;
}

type Locked = { id: string; ticket_id: string; rating: Rating | null; commented: boolean; open: boolean };

/** Locks the survey for its own customer; `open` = the ticket is still in the resolution that was asked about. */
async function lockFor(tx: Sql, id: string, who: CsatWho): Promise<Locked | null> {
  if (!UUID_RE.test(id)) return null;
  const owner = "userTg" in who ? tx`r.user_tg = ${who.userTg}` : tx`r.web_user_id = ${who.webUserId}`;
  const [r] = await tx<Array<Locked>>`
    select c.id, c.ticket_id, c.rating, c.comment is not null as commented, (r.status = 'resolved' and r.resolved_at = c.resolved_at) as open
      from crm_csat c join support_requests r on r.id = c.ticket_id
     where c.id = ${id} and ${owner}
       for update of c`;
  return r ?? null;
}

export async function rateCsat(id: string, who: CsatWho, rating: Rating):
  Promise<{ ok: true; askComment: boolean } | { ok: false; reason: "not_found" | "closed" }> {
  const res = await sql.begin(async (tx) => {
    const c = await lockFor(tx, id, who);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    if (!c.open) return { ok: false as const, reason: "closed" as const };
    if (c.rating === rating) return { ok: true as const, changed: false, ticketId: c.ticket_id };
    await tx`update crm_csat set rating = ${rating}, answered_at = now() where id = ${id}`;
    await logEvent(tx, c.ticket_id, "csat", null, { rating });
    return { ok: true as const, changed: true, ticketId: c.ticket_id };
  });
  if (!res.ok) return res;
  if (res.changed) await publish({ type: "ticket.updated", ticketId: res.ticketId });
  return { ok: true, askComment: rating === "down" };
}

export async function commentCsat(id: string, who: CsatWho, comment: string):
  Promise<{ ok: true } | { ok: false; reason: "not_found" | "closed" | "invalid" }> {
  const text = comment.trim();
  if (!text || text.length > COMMENT_MAX) return { ok: false, reason: "invalid" };
  const res = await sql.begin(async (tx) => {
    const c = await lockFor(tx, id, who);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    if (!c.open) return { ok: false as const, reason: "closed" as const };
    // A comment needs a 👎 and is accepted once.
    if (c.rating !== "down" || c.commented) return { ok: false as const, reason: "invalid" as const };
    await tx`update crm_csat set comment = ${text}, commented_at = now() where id = ${id}`;
    await logEvent(tx, c.ticket_id, "csat", null, { rating: "down", comment: text });
    return { ok: true as const, ticketId: c.ticket_id };
  });
  if (!res.ok) return res;
  await publish({ type: "ticket.updated", ticketId: res.ticketId });
  return { ok: true };
}

export async function setCommentPrompt(id: string, tgMessageId: number): Promise<void> {
  await sql`update crm_csat set comment_prompt_tg_id = ${tgMessageId} where id = ${id}`;
}

/** The survey whose comment prompt this Telegram message replies to, for that same customer. */
export async function csatByCommentPrompt(userTg: number, replyToMessageId: number): Promise<string | null> {
  const [r] = await sql<{ id: string }[]>`
    select c.id from crm_csat c join support_requests r on r.id = c.ticket_id
     where c.comment_prompt_tg_id = ${replyToMessageId} and r.user_tg = ${userTg} and c.rating = 'down'
     limit 1`;
  return r?.id ?? null;
}

/** The open survey of a resolved web ticket, for the web chat poll. */
export async function csatForWeb(ticketId: string): Promise<{ id: string; rating: Rating | null; comment_allowed: boolean } | null> {
  const [r] = await sql<Array<{ id: string; rating: Rating | null; comment: string | null }>>`
    select c.id, c.rating, c.comment from crm_csat c join support_requests r on r.id = c.ticket_id
     where c.ticket_id = ${ticketId} and r.status = 'resolved' and r.resolved_at = c.resolved_at`;
  return r ? { id: r.id, rating: r.rating, comment_allowed: r.rating === "down" && r.comment === null } : null;
}
