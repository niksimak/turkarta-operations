import { forwardRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { SlaBadge } from "./SlaBadge";
import { usePresence } from "../lib/presence";
import type { SlaSettings } from "../lib/sla";
import {
  CHANNEL_LABEL,
  channelOf,
  displayName,
  initials,
  segmentLabel,
  STATUS_LABEL,
  type ChannelFilter,
  type TicketListItem,
  usePrefetchTicket,
  type Viewer,
} from "../lib/tickets";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const CHANNEL_DOT: Record<ChannelFilter, string> = {
  bot: "bg-ch-bot",
  miniapp: "bg-ch-miniapp",
  web: "bg-ch-web",
};

export function ChannelDot({ ticket, className }: { ticket: Pick<TicketListItem, "channel" | "source">; className?: string }) {
  const ch = channelOf(ticket);
  return (
    <span
      role="img"
      aria-label={CHANNEL_LABEL[ch]}
      title={CHANNEL_LABEL[ch]}
      className={cx("inline-block size-2 shrink-0 rounded-full", CHANNEL_DOT[ch], className)}
    />
  );
}

export function Chip({ children, title }: { children: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-4 shrink-0 items-center rounded-xs px-1 text-xs text-text-muted shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {children}
    </span>
  );
}

export function SegmentBadge({ ticket }: { ticket: Pick<TicketListItem, "segment" | "org_name"> }) {
  const label = segmentLabel(ticket);
  return label ? <Chip title={label}>{label}</Chip> : null;
}

export function Avatar({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      title={name}
      aria-label={name}
      role="img"
      className={cx(
        "grid shrink-0 place-items-center rounded-full bg-surface-2 font-semibold text-text-muted shadow-[inset_0_0_0_1px_var(--border)]",
        size === "sm" ? "size-5 text-xs leading-none tracking-tight" : "size-7 text-xs",
      )}
    >
      {initials(name)}
    </span>
  );
}

export function PresenceDots({ viewers }: { viewers: Viewer[] }) {
  if (!viewers.length) return null;
  const typing = viewers.filter((v) => v.state === "typing");
  const label = typing.length
    ? `Печатает: ${typing.map((v) => v.name).join(", ")}`
    : `Смотрит: ${viewers.map((v) => v.name).join(", ")}`;
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0 items-center gap-0.5">
      {viewers.slice(0, 3).map((v) => (
        <span
          key={v.operatorId}
          className={cx("size-1.5 rounded-full", v.state === "typing" ? "bg-accent" : "bg-text-muted")}
        />
      ))}
    </span>
  );
}

interface Props {
  ticket: TicketListItem;
  href: string;
  settings: SlaSettings;
  open: boolean;
  cursor: boolean;
  meId: number | undefined;
}

export const TicketRow = forwardRef<HTMLAnchorElement, Props>(function TicketRow(
  { ticket, href, settings, open, cursor, meId },
  ref,
) {
  const viewers = usePresence(ticket.id, meId);
  const prefetch = usePrefetchTicket();
  // j/k moves the cursor ahead of Enter: warm the ticket it lands on.
  useEffect(() => {
    if (cursor) prefetch(ticket.id);
  }, [cursor, prefetch, ticket.id]);
  const name = displayName(ticket);
  const showHandle = Boolean(ticket.user_name?.trim() && ticket.user_username);
  return (
    <Link
      ref={ref}
      to={href}
      aria-current={open ? "true" : undefined}
      data-ticket-id={ticket.id}
      data-cursor={cursor || undefined}
      onMouseEnter={() => prefetch(ticket.id)}
      onFocus={() => prefetch(ticket.id)}
      className={cx(
        "relative flex h-14 flex-col justify-center gap-0.5 px-3 transition-colors duration-fast",
        open ? "bg-accent-soft" : "hover-surface",
        // The keyboard cursor: an inset ring, so it never shifts layout.
        cursor && "shadow-[inset_0_0_0_2px_var(--focus)]",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ChannelDot ticket={ticket} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{name}</span>
          {showHandle && <span className="text-sm text-text-muted"> @{ticket.user_username}</span>}
        </span>
        <SlaBadge ticket={ticket} settings={settings} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-4">
        <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
          {ticket.last_message_preview || "Без сообщений"}
        </span>
        <SegmentBadge ticket={ticket} />
        {ticket.status === "resolved" && <Chip>{STATUS_LABEL.resolved}</Chip>}
        {ticket.intake_pending && <Chip title="Клиент ещё не оставил email">ждём email</Chip>}
        {ticket.auto_assigned && <Chip title="Назначено автоматически">авто</Chip>}
        <PresenceDots viewers={viewers} />
        {ticket.assigned_operator_name && <Avatar name={ticket.assigned_operator_name} />}
      </span>
    </Link>
  );
});
