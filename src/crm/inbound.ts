import type { Message as TgMessage } from "grammy/types";
import { sql, type Ticket } from "../db.js";
import type { ValidPhoto } from "../support_media.js";
import { publish } from "./events.js";
import { getSettings } from "./settings.js";
import type { TicketStatus, UnsupportedType } from "./types.js";

export interface InboundPart {
  kind: "text" | "photo" | "unsupported";
  body: string;                          // text or caption ("" allowed for photo)
  unsupportedType?: UnsupportedType;
  stickerEmoji?: string;
  tgPhoto?: { fileId: string; fileUniqueId: string };
  mediaGroupId?: string;
  webPhoto?: ValidPhoto;
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

// Same strings the bot has always relayed, so Bitrix and AI triggers see no change.
const UNSUPPORTED_LABEL: Record<Exclude<UnsupportedType, "sticker">, string> = {
  video: "🎬 [видео]",
  video_note: "🎬 [видео]",
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

export function classifyTelegram(m: TgMessage): InboundPart | null {
  if (m.text) return { kind: "text", body: m.text };
  const caption = m.caption ?? "";
  const largest = m.photo?.at(-1);
  if (largest) {
    return {
      kind: "photo",
      body: caption,
      tgPhoto: { fileId: largest.file_id, fileUniqueId: largest.file_unique_id },
      ...(m.media_group_id ? { mediaGroupId: m.media_group_id } : {}),
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
  | { kind: "inserted"; messageId: string; reopened: boolean; assignee: number | null; who: string };

function displayName(t: { user_name: string | null; user_username: string | null }): string {
  return t.user_name || (t.user_username ? `@${t.user_username}` : "Клиент");
}

/** Store a user message with CRM fields, update ticket timers, reopen if needed, publish events. */
export async function recordUserMessage(
  ticket: Ticket,
  part: InboundPart,
  meta: { authorId: string; sourceId?: string },
): Promise<RecordedMessage> {
  const { reopen_days } = await getSettings();
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
    if (part.mediaGroupId && part.tgPhoto) {
      const [dup] = await tx<{ message_id: string }[]>`
        select a.message_id from support_attachments a
          join support_messages m on m.id = a.message_id
         where m.ticket_id = ${row.id} and m.tg_media_group_id = ${part.mediaGroupId}
           and a.tg_file_unique_id = ${part.tgPhoto.fileUniqueId}
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
          values (${latest.id}, ${TG_PHOTO.mediaType}, ${TG_PHOTO.filename}, ${latest.n},
                  ${part.tgPhoto.fileId}, ${part.tgPhoto.fileUniqueId})`;
        return { kind: "appended", messageId: latest.id };
      }
    }

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

    if (part.tgPhoto) {
      await tx`
        insert into support_attachments (message_id, media_type, filename, position, tg_file_id, tg_file_unique_id)
        values (${inserted.id}, ${TG_PHOTO.mediaType}, ${TG_PHOTO.filename}, 0,
                ${part.tgPhoto.fileId}, ${part.tgPhoto.fileUniqueId})`;
    } else if (part.webPhoto) {
      const p = part.webPhoto;
      await tx`
        insert into support_attachments (message_id, media_type, filename, size_bytes, content, position)
        values (${inserted.id}, ${p.mediaType}, ${p.filename}, ${p.content.length}, ${p.content}, 0)`;
    }

    // A second open ticket for the same user would violate the one-open index.
    const reopen = row.status === "resolved" && reopen_days > 0 && row.within_reopen === true && !row.other_open;
    const reopenTo: TicketStatus | null = reopen ? (row.operator_on_shift ? "allocated" : "new") : null;
    const statusSet =
      reopenTo === "new"
        ? tx`status = 'new', queued_at = now(), assigned_operator_id = null, auto_assigned = false`
        : reopenTo === "allocated"
          ? tx`status = 'allocated'`
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
    }
    return {
      kind: "inserted",
      messageId: inserted.id,
      reopened: reopenTo !== null,
      assignee: updated!.assigned_operator_id == null ? null : Number(updated!.assigned_operator_id),
      who: displayName(updated!),
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
  if (outcome.assignee !== null) {
    await publish({
      type: "notify", operatorId: outcome.assignee, kind: "user_replied",
      ticketId: ticket.id, title: outcome.who, body,
    });
  }
  return result;
}
