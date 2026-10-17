import { InputFile, type Bot } from "grammy";
import { getTicket, sql, type Ticket } from "../db.js";
import type { ValidPhoto } from "../support_media.js";
import * as turkartaApi from "../turkarta_api.js";
import { publish } from "./events.js";
import { claim, Conflict, crmMessage, NotFound, withLockedTicket, type CrmMessage } from "./tickets.js";
import type { Operator } from "./types.js";

export interface OutPhoto { bytes: Uint8Array; filename: string }
export interface SentPhoto { message_id: number; fileId: string; fileUniqueId: string }
export interface TgTransport {
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: number, photo: OutPhoto, caption?: string): Promise<SentPhoto>;
  sendMediaGroup(chatId: number, photos: OutPhoto[], caption?: string): Promise<SentPhoto[]>;
}
export interface ReplyInput { kind: "reply" | "note"; body: string; photos: ValidPhoto[] }
export interface ReplyDeps { tg?: TgTransport; notify?: typeof turkartaApi.notifySupportReply }

export type InvalidReplyCode = "empty" | "note_needs_body" | "too_many_photos" | "too_long";
export class InvalidReply extends Error {
  readonly code: InvalidReplyCode;
  constructor(code: InvalidReplyCode) {
    super(code);
    this.name = "InvalidReply";
    this.code = code;
  }
}

const MAX_BODY = 4000;
const MAX_PHOTOS = 10;
const CAPTION_MAX = 1024;
const ERROR_MAX = 200;
const SEND_TIMEOUT_MS = 60_000;
const WEB_PHOTO_PREVIEW = "📷 Фото";
const SYSTEM_AUTHOR = "crm:system";

type TgPhotoMessage = { message_id: number; photo?: Array<{ file_id: string; file_unique_id: string }> };

export function grammyTransport(api: Bot["api"]): TgTransport {
  // grammY's Node typings name the older abort-controller shim; native signals implement the same interface.
  const signal = () => AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as Parameters<Bot["api"]["sendMessage"]>[3];
  const largest = (m: TgPhotoMessage): SentPhoto => {
    const p = m.photo?.at(-1);
    if (!p) throw Object.assign(new Error("no photo in Telegram response"), { code: "no_photo" });
    return { message_id: m.message_id, fileId: p.file_id, fileUniqueId: p.file_unique_id };
  };
  return {
    async sendMessage(chatId, text) {
      const m = await api.sendMessage(chatId, text, {}, signal());
      return { message_id: m.message_id };
    },
    async sendPhoto(chatId, photo, caption) {
      const file = new InputFile(photo.bytes, photo.filename);
      return largest(await api.sendPhoto(chatId, file, caption ? { caption } : {}, signal()));
    },
    async sendMediaGroup(chatId, photos, caption) {
      const media = photos.map((p, i) => ({
        type: "photo" as const,
        media: new InputFile(p.bytes, p.filename),
        ...(i === 0 && caption ? { caption } : {}),
      }));
      const sent = await api.sendMediaGroup(chatId, media, {}, signal());
      return sent.map((m) => largest(m as TgPhotoMessage));
    },
  };
}

let fallbackTransport: TgTransport | undefined;
// Lazy so importing this module does not construct the bot (tests, tickets.ts).
async function defaultTransport(): Promise<TgTransport> {
  if (!fallbackTransport) {
    const { supportBot } = await import("../bots/support.js");
    fallbackTransport = grammyTransport(supportBot.api);
  }
  return fallbackTransport;
}

/**
 * Sends text and photos as one Telegram message where possible. A body over the
 * caption limit goes as a separate text after the photos. `onPhotosSent` runs before
 * that text so a retry can tell the photos already arrived.
 */
export async function sendTelegram(
  tg: TgTransport, chatId: number, body: string, photos: OutPhoto[],
  onPhotosSent: (sent: SentPhoto[]) => Promise<void> = async () => {},
): Promise<SentPhoto[]> {
  if (photos.length === 0) {
    await tg.sendMessage(chatId, body);
    return [];
  }
  const caption = body && body.length <= CAPTION_MAX ? body : undefined;
  const sent = photos.length === 1 ? [await tg.sendPhoto(chatId, photos[0]!, caption)] : await tg.sendMediaGroup(chatId, photos, caption);
  await onPhotosSent(sent);
  if (body && !caption) await tg.sendMessage(chatId, body);
  return sent;
}

/** Telegram's own error description never contains customer text. */
export function deliveryError(err: unknown): string {
  const e = err as { error_code?: unknown; description?: unknown } | null;
  const text = e && typeof e.error_code === "number"
    ? `tg_${e.error_code}: ${String(e.description ?? "")}`
    : "tg_network: request failed";
  return text.slice(0, ERROR_MAX);
}

/** Returns the trimmed body. */
export function validateReply(input: ReplyInput): string {
  const body = input.body.trim();
  if (input.photos.length > MAX_PHOTOS) throw new InvalidReply("too_many_photos");
  if (body.length > MAX_BODY) throw new InvalidReply("too_long");
  if (input.kind === "note" && !body) throw new InvalidReply("note_needs_body");
  if (input.kind === "reply" && !body && input.photos.length === 0) throw new InvalidReply("empty");
  return body;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Operators whose full name follows an `@` as a whole word, case-insensitive. */
export function mentionedOperators<T extends { id: number; name: string }>(text: string, ops: T[]): T[] {
  return ops.filter((o) => {
    const name = o.name.trim();
    return name !== "" && new RegExp(`(?<![\\p{L}\\p{N}_])@${escapeRe(name)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  });
}

async function setDelivery(messageId: string, status: "sent" | "failed", error: string | null): Promise<void> {
  await sql`update support_messages set delivery_status = ${status}, delivery_error = ${error} where id = ${messageId}`;
}

/** Delivers a committed agent message and records the outcome. Never throws on a send failure. */
async function deliver(messageId: string, ticket: Ticket, deps: ReplyDeps): Promise<void> {
  const [m] = await sql<{ body: string }[]>`select body from support_messages where id = ${messageId}`;
  const body = m!.body;

  if (ticket.user_tg != null) {
    const files = await sql<{ id: string; filename: string; content: Uint8Array | null; tg_file_id: string | null }[]>`
      select id, filename, content, tg_file_id from support_attachments
       where message_id = ${messageId} order by position, created_at`;
    const chatId = Number(ticket.user_tg);
    try {
      const tg = deps.tg ?? (await defaultTransport());
      // Photos already carry Telegram file ids after a partial send; only the trailing text is left.
      if (files.length > 0 && files.every((f) => f.tg_file_id)) {
        if (body.length > CAPTION_MAX) await tg.sendMessage(chatId, body);
      } else {
        const photos = files.map((f) => {
          if (!f.content) throw Object.assign(new Error("attachment has no bytes"), { code: "no_bytes" });
          return { bytes: f.content, filename: f.filename };
        });
        await sendTelegram(tg, chatId, body, photos, async (sent) => {
          for (const [i, s] of sent.entries()) {
            await sql`update support_attachments set tg_file_id = ${s.fileId}, tg_file_unique_id = ${s.fileUniqueId}
              where id = ${files[i]!.id}`;
          }
        });
      }
    } catch (err) {
      const error = deliveryError(err);
      await setDelivery(messageId, "failed", error);
      console.error(`[crm-reply] delivery failed message=${messageId} ticket=${ticket.id} code=${error.slice(0, error.indexOf(":"))}`);
      return;
    }
    await setDelivery(messageId, "sent", null);
    return;
  }

  // Web users poll the thread; there is nothing to push except the bell.
  await setDelivery(messageId, "sent", null);
  if (!ticket.web_user_id) return;
  try {
    await (deps.notify ?? turkartaApi.notifySupportReply)({
      web_user_id: ticket.web_user_id, ticket_id: ticket.id, message_id: messageId, preview: body || WEB_PHOTO_PREVIEW,
    });
  } catch (err) {
    console.error(`[crm-reply] web notify failed message=${messageId} code=${(err as { code?: string }).code ?? "error"}`);
  }
}

async function notifyMentions(ticketId: string, me: Operator, body: string): Promise<void> {
  const rows = await sql<{ id: string; name: string }[]>`select id::text as id, name from crm_operators where id <> ${me.id}`;
  const ops = rows.map((o) => ({ id: Number(o.id), name: o.name }));
  for (const o of mentionedOperators(body, ops)) {
    await publish({ type: "notify", operatorId: o.id, kind: "mention", ticketId, title: `Упоминание от ${me.name}`, body });
  }
}

export async function sendReply(ticketId: string, me: Operator, input: ReplyInput, deps: ReplyDeps = {}): Promise<CrmMessage> {
  const body = validateReply(input);
  const isReply = input.kind === "reply";
  const { messageId, ticket } = await withLockedTicket(ticketId, async (tx, t) => {
    if (t.status === "resolved") throw new Conflict("resolved");
    if (isReply) await claim(tx, t, me);
    const kind = isReply ? (input.photos.length ? "photo" : "text") : "note";
    // Notes are 'system' so the AI review trigger (0012) never queues them.
    const [m] = await tx<{ id: string }[]>`
      insert into support_messages
        (ticket_id, sender, body, actor_type, author_id, author_name, kind, delivery_status, delivery_attempt_at, response_seconds)
      select r.id, 'agent', ${body}, ${isReply ? "human" : "system"}, ${`crm:${me.id}`}, ${me.name}, ${kind},
             ${isReply ? tx`'pending'` : tx`null`}, ${isReply ? tx`now()` : tx`null`},
             ${isReply ? tx`extract(epoch from now() - r.waiting_since)::int` : tx`null`}
        from support_requests r where r.id = ${t.id}
      returning id`;
    for (const [i, p] of input.photos.entries()) {
      await tx`
        insert into support_attachments (message_id, media_type, filename, size_bytes, content, position)
        values (${m!.id}, ${p.mediaType}, ${p.filename}, ${p.content.length}, ${p.content}, ${i})`;
    }
    // now() is fixed per transaction, so first_response_at equals the first reply's created_at.
    const [r] = isReply
      ? await tx<Ticket[]>`
          update support_requests
             set first_response_at = coalesce(first_response_at, now()), waiting_since = null,
                 status = 'awaiting', last_message_at = now()
           where id = ${t.id}
          returning *`
      : await tx<Ticket[]>`select * from support_requests where id = ${t.id}`;
    return { messageId: m!.id, ticket: r! };
  });

  if (isReply) await deliver(messageId, ticket, deps);
  else await notifyMentions(ticket.id, me, body);
  await publish({ type: "message.created", ticketId: ticket.id, messageId });
  await publish({ type: "ticket.updated", ticketId: ticket.id });
  return (await crmMessage(messageId))!;
}

export async function retryDelivery(messageId: string, me: Operator, deps: ReplyDeps = {}): Promise<CrmMessage> {
  const current = await crmMessage(messageId);
  if (!current) throw new NotFound();
  if (current.delivery_status !== "failed") return current;

  const [owner] = await sql<{ id: string | null; name: string | null }[]>`
    select r.assigned_operator_id::text as id, o.name
      from support_messages m
      join support_requests r on r.id = m.ticket_id
      left join crm_operators o on o.id = r.assigned_operator_id
     where m.id = ${messageId}`;
  if (owner?.id != null && Number(owner.id) !== me.id) {
    throw new Conflict("assigned_to_other", { id: Number(owner.id), name: owner.name ?? "" });
  }

  // Flip failed -> pending atomically so two clicks cannot send twice.
  const [claimed] = await sql<{ ticket_id: string }[]>`
    update support_messages set delivery_status = 'pending', delivery_error = null, delivery_attempt_at = now()
     where id = ${messageId} and delivery_status = 'failed'
    returning ticket_id`;
  if (!claimed) return (await crmMessage(messageId))!;
  const ticket = await getTicket(claimed.ticket_id);
  await deliver(messageId, ticket!, deps);
  await publish({ type: "message.created", ticketId: claimed.ticket_id, messageId });
  return (await crmMessage(messageId))!;
}

/** An automated agent text (resolve message): no author, no timers, normal delivery state. */
export async function sendSystemText(ticket: Ticket, text: string, deps: ReplyDeps = {}): Promise<void> {
  const [m] = await sql<{ id: string }[]>`
    insert into support_messages (ticket_id, sender, body, actor_type, author_id, kind, delivery_status)
    values (${ticket.id}, 'agent', ${text}, 'automation', ${SYSTEM_AUTHOR}, 'text', 'pending')
    returning id`;
  await deliver(m!.id, ticket, deps);
  await publish({ type: "message.created", ticketId: ticket.id, messageId: m!.id });
}
