import { useRef } from "react";
import { Icon } from "./Icon";
import { formatTime } from "../lib/format";
import { attachmentUrl, type Attachment, type CrmMessage } from "../lib/tickets";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

// Exact strings from the task brief; the glyphs are functional (media type at a glance).
export const UNSUPPORTED_TEXT: Record<string, string> = {
  video: "🎥 Видео не поддерживается",
  animation: "🎞 GIF не поддерживается",
  voice: "🎤 Голосовое не поддерживается",
  document: "📎 Файл не поддерживается",
  sticker: "Стикер",
  video_note: "🎥 Кружок не поддерживается",
  audio: "🎵 Аудио не поддерживается",
};

export function unsupportedText(type: string | null): string {
  return (type && UNSUPPORTED_TEXT[type]) || "Вложение не поддерживается";
}

/** Delivery error codes come as «tg_<code>: <description>»; empty when there is nothing more to say. */
export function deliveryErrorText(error: string | null): string {
  const code = error?.split(":")[0]?.trim() ?? "";
  if (code === "tg_403") return "Клиент заблокировал бота.";
  if (code === "tg_429") return "Telegram ограничил отправку. Повторите через минуту.";
  if (code === "tg_400") return "Telegram отклонил сообщение.";
  if (code === "tg_network") return "Нет связи с Telegram.";
  if (code === "tg_interrupted") return "Отправка прервалась.";
  return "";
}

interface Props {
  message: CrmMessage;
  /** Arrived after the thread was opened: plays the enter motion. */
  entering: boolean;
  onOpenPhoto: (photos: Attachment[], index: number, thumbs: Array<HTMLElement | null>) => void;
  onRetry: (messageId: string) => void;
  retrying: boolean;
}

export function MessageBubble({ message: m, entering, onOpenPhoto, onRetry, retrying }: Props) {
  const thumbs = useRef<Array<HTMLElement | null>>([]);

  if (m.sender === "system") {
    return (
      <p className={cx("px-6 text-center text-sm text-text-muted", entering && "enter-rise")}>
        {m.body}
        <span className="num ml-2 text-xs">{formatTime(m.created_at)}</span>
      </p>
    );
  }

  const mine = m.sender === "agent";
  const note = m.kind === "note";
  const failed = mine && m.delivery_status === "failed";
  const photos = [...m.attachments].sort((a, b) => a.position - b.position);

  return (
    <div
      data-message-id={m.id}
      className={cx("flex flex-col gap-1", mine ? "items-end pl-10" : "items-start pr-10", entering && "enter-rise")}
    >
      <p className="flex items-center gap-2 px-1 text-xs text-text-muted">
        {note && <span className="font-semibold text-note-text">Заметка</span>}
        {mine && m.author_name && <span className="font-semibold">{m.author_name}</span>}
        <time className="num" dateTime={m.created_at}>
          {formatTime(m.created_at)}
        </time>
      </p>
      <div
        className={cx(
          "flex max-w-[min(70ch,100%)] flex-col gap-2 rounded-md px-3 py-2 text-md",
          note
            ? "bg-note-bg text-text shadow-[inset_0_0_0_1px_var(--note-border)]"
            : mine
              ? "bg-surface shadow-[inset_0_0_0_1px_var(--border)]"
              : "bg-surface-2",
          failed && "shadow-[inset_0_0_0_1px_var(--danger)]",
        )}
      >
        {photos.length > 0 && (
          <div className={cx("grid gap-1", photos.length === 1 ? "w-64 grid-cols-1" : "w-64 grid-cols-2", photos.length > 4 && "w-72 grid-cols-3")}>
            {photos.map((p, i) => (
              <button
                key={p.id}
                ref={(el) => {
                  thumbs.current[i] = el;
                }}
                type="button"
                aria-label={photos.length > 1 ? `Открыть фото ${i + 1} из ${photos.length}` : "Открыть фото"}
                onClick={() => onOpenPhoto(photos, i, thumbs.current)}
                className={cx(
                  "press block cursor-zoom-in overflow-hidden rounded-sm bg-hover",
                  photos.length === 1 ? "max-h-72" : "aspect-square",
                )}
              >
                <img
                  src={attachmentUrl(p.id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className={cx("block size-full", photos.length === 1 ? "max-h-72 object-contain" : "object-cover")}
                />
              </button>
            ))}
          </div>
        )}
        {m.kind === "unsupported" && (
          <span className="inline-flex w-fit items-center rounded-xs bg-hover px-2 py-0.5 text-sm text-text-muted">
            {unsupportedText(m.unsupported_type)}
          </span>
        )}
        {m.body && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.body}</p>}
      </div>
      {mine && !note && m.delivery_status && <Delivery message={m} onRetry={onRetry} retrying={retrying} />}
    </div>
  );
}

function Delivery({ message: m, onRetry, retrying }: { message: CrmMessage; onRetry: (id: string) => void; retrying: boolean }) {
  if (m.delivery_status === "pending") {
    return <p className="px-1 text-xs text-text-muted">Отправляется…</p>;
  }
  if (m.delivery_status === "sent") {
    return (
      <p className="flex items-center gap-1 px-1 text-xs text-text-muted">
        <Icon name="check" size={12} />
        Отправлено
      </p>
    );
  }
  return (
    <div role="alert" className="flex items-center gap-2 px-1 text-xs text-danger" title={m.delivery_error ?? undefined}>
      <span>{["Не доставлено.", deliveryErrorText(m.delivery_error)].filter(Boolean).join(" ")}</span>
      <button
        type="button"
        onClick={() => onRetry(m.id)}
        disabled={retrying}
        className="press hover-surface inline-flex h-6 items-center gap-1 rounded-xs px-1.5 font-semibold text-danger shadow-[inset_0_0_0_1px_var(--danger)] disabled:opacity-60"
      >
        <Icon name="retry" size={12} />
        Повторить
      </button>
    </div>
  );
}
