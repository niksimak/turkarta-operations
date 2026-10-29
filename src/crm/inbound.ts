import type { Message as TgMessage } from "grammy/types";
import { legacySurface } from "../config.js";
import { sql, type Ticket } from "../db.js";
import { MAX_VIDEO_BYTES, VIDEO_TYPES, type ValidPhoto, type ValidVideo } from "../support_media.js";
import type { StoredVideo } from "../video_storage.js";
import { activeAlerts, firstLine } from "./alerts.js";
import { publish } from "./events.js";
import { getSettings } from "./settings.js";
import { ticketItem, ticketWho } from "./tickets.js";
import type { TicketStatus, UnsupportedType } from "./types.js";

export interface InboundPart {
  kind: "text" | "photo" | "video" | "unsupported";
  body: string;                          // text or caption ("" allowed for photo and video)
  unsupportedType?: UnsupportedType;
  stickerEmoji?: string;
  tgPhoto?: { fileId: string; fileUniqueId: string };
  tgVideo?: { fileId: string; fileUniqueId: string; mediaType: ValidVideo["mediaType"]; filename: string };
  mediaGroupId?: string;
  webPhoto?: ValidPhoto;
  webVideo?: StoredVideo;
}

export interface RecordedMessage {
  messageId: string;
  appendedToAlbum: boolean;
  reopened: boolean;
  /** First attachment of the stored message (for the signed Bitrix photo URL). */
  attachment: { id: string; filename: string } | null;
}

const ALBUM_WINDOW = "10 seconds";
const MAX_ATTACHMENTS = 10;
const TG_PHOTO = { mediaType: "image/jpeg", filename: "photo.jpg" } as const;

/** The Telegram file a part carries, with what the attachment row needs. */
function tgFile(part: InboundPart): { fileId: string; fileUniqueId: string; mediaType: string; filename: string } | null {
  if (part.tgPhoto) return { ...part.tgPhoto, ...TG_PHOTO };
  return part.tgVideo ?? null;
}

// Same strings as contentLabel in bots/support.ts, so Bitrix and AI triggers see no change. One exception:
// a GIF arrives as a document too, so contentLabel said «📎 [файл]»; here it is «🎞 [GIF]».
const UNSUPPORTED_LABEL: Record<Exclude<UnsupportedType, "sticker">, string> = {
  video: "🎬 [видео]",
  video_note: "🎬 [видео]",
  video_too_large: "🎬 [видео больше 20 МБ, не загрузилось]",
  animation: "🎞 [GIF]",
  voice: "🎤 [голосовое]",
  document: "📎 [файл]",
  audio: "🎵 [аудио]",
};

function unsupportedType(m: TgMessage): UnsupportedType | null {
  // Telegram sends a GIF as animation AND document; animation must win.
  if (m.animation) return "animation";
  if (m.video) return "video";
  if (m.voice) return "voice";
  if (m.document) return "document";
  if (m.sticker) return "sticker";
  if (m.video_note) return "video_note";
  if (m.audio) return "audio";
  return null;
}

/** A video, a round video note, or a video sent "as a file". */
function tgVideoFile(m: TgMessage): { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string } | null {
  if (m.animation) return null;
  if (m.video) return m.video;
  if (m.video_note) return { ...m.video_note, mime_type: "video/mp4" };
  if (m.document?.mime_type && VIDEO_TYPES.has(m.document.mime_type)) return m.document;
  return null;
}

export function classifyTelegram(m: TgMessage): InboundPart | null {
  if (m.text) return { kind: "text", body: m.text };
  const caption = m.caption ?? "";
  const group = m.media_group_id ? { mediaGroupId: m.media_group_id } : {};
  const largest = m.photo?.at(-1);
  if (largest) {
    return {
      kind: "photo",
      body: caption,
      tgPhoto: { fileId: largest.file_id, fileUniqueId: largest.file_unique_id },
      ...group,
    };
  }
  const video = tgVideoFile(m);
  if (video) {
    // Telegram reports the size up front; past the bot download cap nobody could ever open it.
    if (video.file_size !== undefined && video.file_size > MAX_VIDEO_BYTES) {
      return { kind: "unsupported", body: caption, unsupportedType: "video_too_large" };
    }
    const mediaType = video.mime_type && VIDEO_TYPES.has(video.mime_type)
      ? video.mime_type as ValidVideo["mediaType"]
      : "video/mp4";
    const filename = mediaType === "video/quicktime" ? "video.mov" : mediaType === "video/webm" ? "video.webm" : "video.mp4";
    return {
      kind: "video",
      body: caption,
      tgVideo: { fileId: video.file_id, fileUniqueId: video.file_unique_id, mediaType, filename },
      ...group,
    };
  }
  const type = unsupportedType(m);
  if (!type) return null;
  return {
    kind: "unsupported",
    body: caption,
    unsupportedType: type,
    ...(type === "sticker" && m.sticker?.emoji ? { stickerEmoji: m.sticker.emoji } : {}),
  };
}

export function legacyLabel(part: InboundPart): string {
  if (part.body) return part.body;
  if (part.kind === "photo") return "📷 [фото]";
  if (part.kind === "video") return "🎬 [видео]";
  if (part.kind === "unsupported") {
    if (part.unsupportedType === "sticker") return `${part.stickerEmoji ?? ""} [стикер]`;
    return part.unsupportedType ? UNSUPPORTED_LABEL[part.unsupportedType] : "[вложение]";
  }
  return part.body;
}

interface LockedTicket {
  id: string;
  status: TicketStatus;
  assigned_operator_id: string | number | null;
  within_reopen: boolean | null;
  other_open: boolean;
  operator_on_shift: boolean | null;
}

type TxOutcome =
  | { kind: "duplicate"; messageId: string }
  | { kind: "appended"; messageId: string }
  | {
    kind: "inserted"; messageId: string; reopened: boolean; requeued: boolean;
    assignee: number | null; who: string; firstOfTicket: boolean;
  };

/** Store a user message with CRM fields, update ticket timers, reopen if needed, publish events. */
export async function recordUserMessage(
  ticket: Ticket,
  part: InboundPart,
  meta: { authorId: string; sourceId?: string },
): Promise<RecordedMessage> {
  const { reopen_days, tg_ping_new_ticket } = await getSettings();
  const body = legacyLabel(part);
  const sourceId = meta.sourceId ?? null;

  const outcome = await sql.begin(async (tx): Promise<TxOutcome> => {
    // Row lock serializes concurrent album parts and status changes for one ticket.
    const [row] = await tx<LockedTicket[]>`
      select r.id, r.status, r.assigned_operator_id,
             (r.resolved_at > now() - make_interval(days => ${reopen_days})) as within_reopen,
             exists (
               select 1 from support_requests o
                where o.id <> r.id and o.status in ('new','allocated','awaiting')
                  and ((r.user_tg is not null and o.user_tg = r.user_tg)
                    or (r.web_user_id is not null and o.web_user_id = r.web_user_id))
             ) as other_open,
             (select on_shift from crm_operators where id = r.assigned_operator_id) as operator_on_shift
        from support_requests r
       where r.id = ${ticket.id}
       for update of r`;
    if (!row) throw Object.assign(new Error("ticket not found"), { code: "ticket_not_found" });

    // Telegram webhook retries: same source id, or an album part already appended.
    if (sourceId) {
      const [dup] = await tx<{ id: string }[]>`
        select id from support_messages where source_message_id = ${sourceId}`;
      if (dup) return { kind: "duplicate", messageId: dup.id };
    }
    const file = tgFile(part);
    if (part.mediaGroupId && file) {
      const [dup] = await tx<{ message_id: string }[]>`
        select a.message_id from support_attachments a
          join support_messages m on m.id = a.message_id
         where m.ticket_id = ${row.id} and m.tg_media_group_id = ${part.mediaGroupId}
           and a.tg_file_unique_id = ${file.fileUniqueId}
         limit 1`;
      if (dup) return { kind: "duplicate", messageId: dup.message_id };

      const [latest] = await tx<{ id: string; tg_media_group_id: string | null; fresh: boolean; n: number }[]>`
        select m.id, m.tg_media_group_id,
               m.created_at > now() - ${ALBUM_WINDOW}::interval as fresh,
               (select count(*)::int from support_attachments a where a.message_id = m.id) as n
          from support_messages m
         where m.ticket_id = ${row.id} and m.sender = 'user'
         order by m.seq desc limit 1`;
      if (latest && latest.tg_media_group_id === part.mediaGroupId && latest.fresh && latest.n < MAX_ATTACHMENTS) {
        await tx`
          insert into support_attachments (message_id, media_type, filename, position, tg_file_id, tg_file_unique_id)
          values (${latest.id}, ${file.mediaType}, ${file.filename}, ${latest.n},
                  ${file.fileId}, ${file.fileUniqueId})`;
        return { kind: "appended", messageId: latest.id };
      }
    }

    const [prior] = await tx<{ any: boolean }[]>`
      select exists (select 1 from support_messages where ticket_id = ${row.id} and sender = 'user') as any`;

    const [inserted] = await tx<{ id: string }[]>`
      insert into support_messages
        (ticket_id, sender, body, actor_type, author_id, source_message_id, kind, unsupported_type, tg_media_group_id)
      values (${row.id}, 'user', ${body}, 'customer', ${meta.authorId}, ${sourceId}, ${part.kind},
              ${part.unsupportedType ?? null}, ${part.mediaGroupId ?? null})
      on conflict (source_message_id) where source_message_id is not null do nothing
      returning id`;
    if (!inserted) {
      const [dup] = await tx<{ id: string }[]>`select id from support_messages where source_message_id = ${sourceId}`;
      return { kind: "duplicate", messageId: dup!.id };
    }

    if (file) {
      await tx`
        insert into support_attachments (message_id, media_type, filename, position, tg_file_id, tg_file_unique_id)
        values (${inserted.id}, ${file.mediaType}, ${file.filename}, 0, ${file.fileId}, ${file.fileUniqueId})`;
    } else if (part.webVideo) {
      const v = part.webVideo;
      await tx`
        insert into support_attachments (message_id, media_type, filename, size_bytes, storage_key, position)
        values (${inserted.id}, ${v.mediaType}, ${v.filename}, ${v.sizeBytes}, ${v.storageKey}, 0)`;
    } else if (part.webPhoto) {
      const p = part.webPhoto;
      await tx`
        insert into support_attachments (message_id, media_type, filename, size_bytes, content, position)
        values (${inserted.id}, ${p.mediaType}, ${p.filename}, ${p.content.length}, ${p.content}, 0)`;
    }

    // A second open ticket for the same user would violate the one-open index.
    // Bitrix mode keeps the pre-CRM rule: a message on a resolved ticket is only appended.
    const reopen = !legacySurface() && row.status === "resolved" && reopen_days > 0
      && row.within_reopen === true && !row.other_open;
    const reopenTo: TicketStatus | null = reopen ? (row.operator_on_shift ? "allocated" : "new") : null;
    const statusSet =
      // A ticket resolved mid-intake must not keep asking for an email after it reopens.
      reopenTo === "new"
        ? tx`status = 'new', queued_at = now(), assigned_operator_id = null, auto_assigned = false, intake_step = null`
        : reopenTo === "allocated"
          ? tx`status = 'allocated', intake_step = null`
          : tx`status = case when status = 'awaiting' then 'allocated' else status end`;
    const [updated] = await tx<{ assigned_operator_id: string | number | null; user_name: string | null; user_username: string | null }[]>`
      update support_requests
         set waiting_since = coalesce(waiting_since, now()), last_message_at = now(), ${statusSet}
       where id = ${row.id}
      returning assigned_operator_id, user_name, user_username`;
    if (reopenTo) {
      await tx`
        insert into crm_ticket_events (ticket_id, type, payload)
        values (${row.id}, 'reopened', ${JSON.stringify({ status: reopenTo })}::text::jsonb)`;
      if (reopenTo === "new" && row.assigned_operator_id !== null) {
        await tx`
          insert into crm_ticket_events (ticket_id, type, payload)
          values (${row.id}, 'unassigned', ${JSON.stringify({ operator_id: null, operator_name: null })}::text::jsonb)`;
      }
    }
    return {
      kind: "inserted",
      messageId: inserted.id,
      reopened: reopenTo !== null,
      requeued: reopenTo === "new",
      assignee: updated!.assigned_operator_id == null ? null : Number(updated!.assigned_operator_id),
      who: ticketWho(updated!),
      firstOfTicket: !prior!.any,
    };
  });

  const [attachment] = await sql<{ id: string; filename: string }[]>`
    select id, filename from support_attachments
     where message_id = ${outcome.messageId}
     order by position, created_at limit 1`;
  const result: RecordedMessage = {
    messageId: outcome.messageId,
    appendedToAlbum: outcome.kind === "appended",
    reopened: outcome.kind === "inserted" && outcome.reopened,
    attachment: attachment ? { id: attachment.id, filename: attachment.filename } : null,
  };

  if (outcome.kind === "duplicate") return result;
  // An album append changes the message operators see, but is not a new reply to notify about.
  await publish({ type: "message.created", ticketId: ticket.id, messageId: outcome.messageId });
  if (outcome.kind === "appended") return result;
  await publish({ type: "ticket.updated", ticketId: ticket.id });
  // A reopen that lands back in the queue needs a taker, exactly like a new ticket.
  if (outcome.firstOfTicket || outcome.requeued) {
    const line = firstLine(body);
    await publish({
      type: "notify", operatorId: null, kind: "new_ticket", ticketId: ticket.id,
      title: "Новое обращение", body: line ? `${outcome.who}: ${line}` : outcome.who,
    });
    // Not awaited: a slow Telegram must not hold the user's webhook or request.
    if (tg_ping_new_ticket) void alertNewTicket(ticket.id);
  }
  if (outcome.assignee !== null) {
    await publish({
      type: "notify", operatorId: outcome.assignee, kind: "user_replied",
      ticketId: ticket.id, title: outcome.who, body,
    });
  }
  return result;
}

async function alertNewTicket(ticketId: string): Promise<void> {
  const alerts = activeAlerts();
  if (!alerts) return;
  try {
    const item = await ticketItem(ticketId);
    if (item) await alerts.newTicket(item);
  } catch (err) {
    console.error(`[crm-alerts] new ticket alert failed ticket=${ticketId} code=${(err as { code?: string }).code ?? "error"}`);
  }
}
