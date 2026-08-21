import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.DATABASE_URL, { max: 5 });

/** Ensure additive support-media schema exists before accepting updates. */
export async function ensureSupportPhotoSchema(): Promise<void> {
  await sql`alter table public.support_requests
    add column if not exists first_photo_file_id text`;
  await sql`create table if not exists public.support_attachments (
    id uuid primary key default gen_random_uuid(),
    message_id uuid not null unique references public.support_messages(id) on delete cascade,
    media_type text not null check (media_type in ('image/jpeg', 'image/png', 'image/webp')),
    filename text not null,
    size_bytes integer not null check (size_bytes > 0 and size_bytes <= 8388608),
    content bytea not null,
    created_at timestamptz not null default now()
  )`;
  await sql`create index if not exists support_attachments_message_idx
    on public.support_attachments (message_id)`;
}

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
  first_photo_file_id: string | null; // Telegram photo received during intake
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
  first_photo_file_id?: string | null;
}

/**
 * Create (or return the existing open) ticket for a user. Used by both the bot
 * intake and the in-app webhook. One open ticket per user is enforced by a partial
 * unique index; the on-conflict path returns the existing row unchanged.
 */
export async function openTicket(t: OpenTicketInput): Promise<Ticket> {
  const [row] = await sql<Ticket[]>`
    insert into support_requests
      (user_tg, user_username, user_name, source, first_message, email, device, intake_step,
       first_photo_file_id)
    values (${t.user_tg}, ${t.user_username}, ${t.user_name}, ${t.source},
            ${t.request}, ${t.email ?? null}, ${t.device ?? null}, ${t.intake_step ?? null},
            ${t.first_photo_file_id ?? null})
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

/**
 * Find an open ticket by the Telegram message id of its ops card — used when an
 * operator replies directly to the card instead of typing inside the relay
 * topic, so the reply still reaches the user.
 */
export async function ticketByCardMessage(messageId: number): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    select * from support_requests
     where tg_message_id = ${messageId} and ${OPEN}
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

/**
 * Park a taken ticket as 'awaiting' (still open). Any operator may — the caller
 * (bot handler) gates on roster membership; we only guard that it's still open.
 */
export async function awaitTicket(id: string): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set status = 'awaiting'
     where id = ${id} and status in ('allocated','awaiting')
    returning *`;
  return rows[0] ?? null;
}

/** Resolve (close) a ticket. Roster gating is enforced by the caller. */
export async function resolveTicket(id: string): Promise<Ticket | null> {
  const rows = await sql<Ticket[]>`
    update support_requests set status = 'resolved', resolved_at = now()
     where id = ${id} and status in ('allocated','awaiting')
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
  seq: number; // monotonic cursor
  attachment_id: string | null;
  attachment_media_type: string | null;
  attachment_filename: string | null;
}

export interface PhotoInput {
  content: Uint8Array;
  mediaType: string;
  filename: string;
}

export async function addMessage(
  ticketId: string,
  sender: Message["sender"],
  body: string,
  photo?: PhotoInput | null,
): Promise<Message> {
  const [row] = photo
    ? await sql<Message[]>`
        with new_message as (
          insert into support_messages (ticket_id, sender, body)
          values (${ticketId}, ${sender}, ${body})
          returning *
        ), new_attachment as (
          insert into support_attachments
            (message_id, media_type, filename, size_bytes, content)
          select id, ${photo.mediaType}, ${photo.filename}, ${photo.content.length}, ${photo.content}
            from new_message
          returning id, media_type, filename
        )
        select m.*, a.id as attachment_id,
               a.media_type as attachment_media_type,
               a.filename as attachment_filename
          from new_message m cross join new_attachment a`
    : await sql<Message[]>`
        with new_message as (
          insert into support_messages (ticket_id, sender, body)
          values (${ticketId}, ${sender}, ${body})
          returning *
        )
        select m.*, null::uuid as attachment_id,
               null::text as attachment_media_type,
               null::text as attachment_filename
          from new_message m`;
  return row!;
}

/**
 * Messages for a ticket after the `since` sequence cursor; all if omitted.
 * `seq` is a monotonic integer — an exact, URL-safe cursor (unlike a timestamp,
 * whose '+00' offset gets mangled to a space in query strings). `created_at` is
 * returned as text for display only.
 */
export async function messagesSince(
  ticketId: string,
  since?: number | null,
): Promise<Message[]> {
  return sql<Message[]>`
    select m.id, m.ticket_id, m.sender, m.body, m.created_at::text as created_at, m.seq,
           a.id as attachment_id, a.media_type as attachment_media_type,
           a.filename as attachment_filename
      from support_messages m
      left join support_attachments a on a.message_id = m.id
     where m.ticket_id = ${ticketId}
       ${since != null ? sql`and m.seq > ${since}` : sql``}
     order by m.seq asc
     limit 200`;
}

export interface SupportAttachment {
  id: string;
  media_type: string;
  filename: string;
  size_bytes: number;
  content: Uint8Array;
}

export async function supportAttachment(id: string): Promise<SupportAttachment | null> {
  const rows = await sql<SupportAttachment[]>`
    select id, media_type, filename, size_bytes, content
      from support_attachments where id = ${id}`;
  return rows[0] ?? null;
}

export async function supportAttachmentForWebUser(
  id: string,
  webUserId: string,
): Promise<SupportAttachment | null> {
  const rows = await sql<SupportAttachment[]>`
    select a.id, a.media_type, a.filename, a.size_bytes, a.content
      from support_attachments a
      join support_messages m on m.id = a.message_id
      join support_requests r on r.id = m.ticket_id
     where a.id = ${id} and r.web_user_id = ${webUserId}`;
  return rows[0] ?? null;
}

// ---- Bitrix24 local-application tokens (migration 0009) ------------------

export interface BitrixTokens {
  member_id: string;
  domain: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  application_token: string | null;
  connector_registered_at: string | null;
}

/**
 * Store (or replace) the portal's OAuth tokens.
 *
 * Upsert rather than insert: Bitrix re-sends ONAPPINSTALL on every reinstall,
 * and a refresh rotates both tokens, so this is the single write path for both.
 */
export async function saveBitrixTokens(t: {
  member_id: string;
  domain: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  application_token?: string | null;
}): Promise<void> {
  await sql`
    insert into bitrix_app_tokens
      (member_id, domain, access_token, refresh_token, expires_at, application_token, updated_at)
    values (${t.member_id}, ${t.domain}, ${t.access_token}, ${t.refresh_token},
            ${t.expires_at}, ${t.application_token ?? null}, now())
    on conflict (member_id) do update set
      domain        = excluded.domain,
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      -- A refresh carries no application_token; keep the installed one.
      application_token = coalesce(excluded.application_token,
                                   bitrix_app_tokens.application_token),
      updated_at    = now()`;
}

/** The single installed portal's tokens, if the app has been installed. */
export async function getBitrixTokens(): Promise<BitrixTokens | null> {
  const rows = await sql<BitrixTokens[]>`
    select member_id, domain, access_token, refresh_token,
           expires_at::text  as expires_at,
           application_token,
           connector_registered_at::text as connector_registered_at
      from bitrix_app_tokens
     order by updated_at desc limit 1`;
  return rows[0] ?? null;
}

/**
 * Record an operator reply from Bitrix exactly once.
 *
 * `bitrix_message_id` carries a partial UNIQUE index, so a retried event
 * (TZ §4.4 — Bitrix retries, duplicates unacceptable) collides and inserts
 * nothing. Returns null when the row already existed = "already delivered".
 */
export async function addAgentMessageFromBitrix(
  ticketId: string,
  body: string,
  bitrixMessageId: string,
): Promise<Message | null> {
  const rows = await sql<Message[]>`
    insert into support_messages (ticket_id, sender, body, bitrix_message_id)
    values (${ticketId}, 'agent', ${body}, ${bitrixMessageId})
    on conflict (bitrix_message_id) where bitrix_message_id is not null
      do nothing
    returning *`;
  return rows[0] ?? null;
}

export async function markBitrixConnectorRegistered(memberId: string): Promise<void> {
  await sql`
    update bitrix_app_tokens
       set connector_registered_at = now()
     where member_id = ${memberId}`;
}
