import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.DATABASE_URL, { max: 5 });

const CLAIMABLE = new Set(["leads", "support_requests"]);

export interface Lead {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
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

export interface Ticket {
  id: string;
  user_tg: number;
  user_username: string | null;
  user_name: string | null;
  source: string | null;
  first_message: string | null;
  status: "new" | "allocated" | "resolved";
  claimed_by: string | null;
  claimed_by_tg: number | null;
  tg_chat_id: number | null;
  tg_message_id: number | null;
  thread_id: number | null;
}

export type LeadInput = Pick<
  Lead,
  "name" | "company" | "phone" | "tg_username" | "contact" | "message" | "source"
>;

/** Insert a fresh lead (form-POST path). */
export async function insertLead(input: LeadInput): Promise<Lead> {
  const [row] = await sql<Lead[]>`
    insert into leads (name, company, phone, tg_username, contact, message, source)
    values (${input.name}, ${input.company}, ${input.phone}, ${input.tg_username},
            ${input.contact}, ${input.message}, ${input.source})
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

export async function openTicket(t: {
  user_tg: number;
  user_username: string | null;
  user_name: string | null;
  source: string;
  first_message: string;
}): Promise<Ticket> {
  const [row] = await sql<Ticket[]>`
    insert into support_requests (user_tg, user_username, user_name, source, first_message)
    values (${t.user_tg}, ${t.user_username}, ${t.user_name}, ${t.source}, ${t.first_message})
    on conflict (user_tg) where status in ('new','allocated')
      do update set first_message = support_requests.first_message
    returning *`;
  return row!;
}

export async function ticketByUser(userTg: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where user_tg = ${userTg} and status in ('new','allocated')
     order by created_at desc limit 1`;
  return rows[0] ?? null;
}

export async function ticketByThread(threadId: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where thread_id = ${threadId} and status in ('new','allocated')
     order by created_at desc limit 1`;
  return rows[0] ?? null;
}

export async function setThread(id: string, threadId: number): Promise<void> {
  await sql`update support_requests set thread_id = ${threadId} where id = ${id}`;
}

export async function resolveTicket(id: string, byTg: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set status = 'resolved', resolved_at = now()
     where id = ${id} and status = 'allocated' and claimed_by_tg = ${byTg}
    returning *`;
  return rows[0] ?? null;
}
