import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.DATABASE_URL, { max: 5 });

const CLAIMABLE = new Set(["leads", "support_requests"]);

export interface Lead {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  tg_username: string | null;
  contact: string | null;
  message: string | null;
  source: string | null;
  status: "new" | "allocated";
  claimed_by: string | null;
  claimed_by_tg: number | null;
  tg_chat_id: number | null;
  tg_message_id: number | null;
}

export type TicketCategory = "tech_issue" | "bug_report" | "feature_request";

export type TicketChannel = "telegram" | "web";

export interface Ticket {
  id: string;
  channel: TicketChannel;
  user_tg: number | null; // null for web-channel tickets
  web_user_id: string | null; // the main app's user.id, for web tickets
  user_username: string | null;
  user_name: string | null;
  source: string | null;
  first_message: string | null; // the user's request text
  email: string | null;
  device: string | null;
  category: TicketCategory | null;
  intake_step: string | null; // 'email' while the bot is still collecting; null = done
  status: "new" | "allocated" | "awaiting" | "resolved";
  claimed_by: string | null;
  claimed_by_tg: number | null;
  tg_chat_id: number | null;
  tg_message_id: number | null;
  thread_id: number | null;
}

export type LeadInput = Pick<
  Lead,
  "name" | "company" | "phone" | "email" | "tg_username" | "contact" | "message" | "source"
>;

/** Insert a fresh lead (form-POST path). */
export async function insertLead(input: LeadInput): Promise<Lead> {
  const [row] = await sql<Lead[]>`
    insert into leads (name, company, phone, email, tg_username, contact, message, source)
    values (${input.name}, ${input.company}, ${input.phone}, ${input.email},
            ${input.tg_username}, ${input.contact}, ${input.message}, ${input.source})
    returning *`;
  return row!;
}

/**
 * Atomically allocate a 'new' record. Returns the row if we won, else null.
 * Guarded by status='new' so only the first tapper wins the race.
 */
export async function claim<T extends object>(
  table: "leads" | "support_requests",
  id: string,
  byName: string,
  byTg: number,
): Promise<T | null> {
  if (!CLAIMABLE.has(table)) throw new Error(`refusing to claim ${table}`);
  const rows = await sql<T[]>`
    update ${sql(table)}
       set status = 'allocated', claimed_by = ${byName},
           claimed_by_tg = ${byTg}, claimed_at = now()
     where id = ${id} and status = 'new'
    returning *`;
  return rows[0] ?? null;
}

export async function getRow<T extends object>(
  table: "leads" | "support_requests",
  id: string,
): Promise<T | null> {
  if (!CLAIMABLE.has(table)) throw new Error(`unknown table ${table}`);
  const rows = await sql<T[]>`select * from ${sql(table)} where id = ${id}`;
  return rows[0] ?? null;
}

export async function setCard(
  table: "leads" | "support_requests",
  id: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  if (!CLAIMABLE.has(table)) throw new Error(`unknown table ${table}`);
  await sql`update ${sql(table)} set tg_chat_id = ${chatId}, tg_message_id = ${messageId} where id = ${id}`;
}

// ---- support relay helpers ----------------------------------------------

/** "Open" = unresolved: parked (awaiting) tickets still route relay + block new ones. */
const OPEN = sql`status in ('new','allocated','awaiting')`;

export interface OpenTicketInput {
  user_tg: number;
  user_username: string | null;
  user_name: string | null;
  source: string;
  request: string;
  email?: string | null;
  device?: string | null;
  intake_step?: string | null;
}

/**
 * Create (or return the existing open) ticket for a user. Used by both the bot
 * intake and the in-app webhook. One open ticket per user is enforced by a partial
 * unique index; the on-conflict path returns the existing row unchanged.
 */
export async function openTicket(t: OpenTicketInput): Promise<Ticket> {
  const [row] = await sql<Ticket[]>`
    insert into support_requests
      (user_tg, user_username, user_name, source, first_message, email, device, intake_step)
    values (${t.user_tg}, ${t.user_username}, ${t.user_name}, ${t.source},
            ${t.request}, ${t.email ?? null}, ${t.device ?? null}, ${t.intake_step ?? null})
    on conflict (user_tg) where status in ('new','allocated','awaiting')
      do update set first_message = support_requests.first_message
    returning *`;
  return row!;
}

/** Finish bot intake: store the (optional) email and clear the intake gate. */
export async function finishIntake(id: string, email: string | null): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set email = ${email}, intake_step = null
     where id = ${id}
    returning *`;
  return rows[0] ?? null;
}

export async function ticketByUser(userTg: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where user_tg = ${userTg} and ${OPEN}
     order by created_at desc limit 1`;
  return rows[0] ?? null;
}

export async function ticketByThread(threadId: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where thread_id = ${threadId} and ${OPEN}
     order by created_at desc limit 1`;
  return rows[0] ?? null;
}

export async function setThread(id: string, threadId: number): Promise<void> {
  await sql`update support_requests set thread_id = ${threadId} where id = ${id}`;
}

/** Operator tags the ticket's category. Returns the updated row. */
export async function setCategory(
  id: string,
  category: TicketCategory,
): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set category = ${category}
     where id = ${id} and ${OPEN}
    returning *`;
  return rows[0] ?? null;
}

/** Park a taken ticket as 'awaiting' (still open). Only the assigned agent may. */
export async function awaitTicket(id: string, byTg: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set status = 'awaiting'
     where id = ${id} and claimed_by_tg = ${byTg} and status in ('allocated','awaiting')
    returning *`;
  return rows[0] ?? null;
}

export async function resolveTicket(id: string, byTg: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set status = 'resolved', resolved_at = now()
     where id = ${id} and claimed_by_tg = ${byTg} and status in ('allocated','awaiting')
    returning *`;
  return rows[0] ?? null;
}

export async function getTicket(id: string): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`select * from support_requests where id = ${id}`;
  return rows[0] ?? null;
}

// ---- web channel ---------------------------------------------------------

/** Create (or return the existing open) web-channel ticket for an app user.id. */
export async function openWebTicket(t: {
  web_user_id: string;
  user_name: string | null;
  source: string;
  request: string;
  email?: string | null;
  device?: string | null;
}): Promise<Ticket> {
  const [row] = await sql<Ticket[]>`
    insert into support_requests
      (channel, web_user_id, user_name, source, first_message, email, device)
    values ('web', ${t.web_user_id}, ${t.user_name}, ${t.source},
            ${t.request}, ${t.email ?? null}, ${t.device ?? null})
    on conflict (web_user_id)
      where web_user_id is not null and status in ('new','allocated','awaiting')
      do update set first_message = support_requests.first_message
    returning *`;
  return row!;
}

/** The current open web ticket for a user, if any. */
export async function ticketByWebUser(webUserId: string): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where web_user_id = ${webUserId} and ${OPEN}
     order by created_at desc limit 1`;
  return rows[0] ?? null;
}

/** Most recent web ticket (any status) — for polling so the user sees closure too. */
export async function latestTicketByWebUser(webUserId: string): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where web_user_id = ${webUserId}
     order by created_at desc limit 1`;
  return rows[0] ?? null;
}

// ---- conversation log (web channel) --------------------------------------

export interface Message {
  id: string;
  ticket_id: string;
  sender: "user" | "agent" | "system";
  body: string;
  created_at: string;
}

export async function addMessage(
  ticketId: string,
  sender: Message["sender"],
  body: string,
): Promise<Message> {
  const [row] = await sql<Message[]>`
    insert into support_messages (ticket_id, sender, body)
    values (${ticketId}, ${sender}, ${body})
    returning *`;
  return row!;
}

/** Messages for a ticket newer than `since` (ISO timestamp); all if omitted. */
export async function messagesSince(
  ticketId: string,
  since?: string | null,
): Promise<Message[]> {
  return sql<Message[]>`
    select * from support_messages
     where ticket_id = ${ticketId}
       ${since ? sql`and created_at > ${since}` : sql``}
     order by created_at asc
     limit 200`;
}
