import { useNow } from "../lib/now";
import { formatWait, slaState, slaTarget, type SlaLevel, type SlaSettings } from "../lib/sla";
import { formatStamp } from "../lib/format";
import type { TicketListItem } from "../lib/tickets";

const TONE: Record<Exclude<SlaLevel, "none">, string> = {
  ok: "text-sla-ok",
  warn: "bg-sla-warn-soft text-sla-warn",
  late: "bg-sla-late-soft text-sla-late",
};

const LEVEL_WORD: Record<Exclude<SlaLevel, "none">, string> = {
  ok: "в срок",
  warn: "скоро просрочка",
  late: "просрочено",
};

type Props = {
  ticket: Pick<TicketListItem, "status" | "waiting_since" | "first_response_at" | "last_message_at">;
  settings: SlaSettings;
};

/** Wait timer in SLA colour while a customer waits; the last activity time otherwise. Re-renders every 15 s. */
export function SlaBadge({ ticket, settings }: Props) {
  const now = useNow();
  const waiting = ticket.status === "resolved" ? null : ticket.waiting_since;
  const { minutes, level } = slaState(waiting, ticket.first_response_at, settings, now);

  if (level === "none") {
    return ticket.last_message_at ? (
      <span className="num shrink-0 text-xs text-text-muted">{formatStamp(ticket.last_message_at, new Date(now))}</span>
    ) : null;
  }

  const target = slaTarget(ticket.first_response_at, settings);
  const label = `Ждёт ${formatWait(minutes, true)}, ${LEVEL_WORD[level]}. Цель ${target} мин`;
  return (
    <span
      title={label}
      aria-label={label}
      data-level={level}
      className={`num inline-flex h-5 shrink-0 items-center rounded-xs px-1.5 text-xs font-semibold ${TONE[level]}`}
    >
      {formatWait(minutes)}
    </span>
  );
}
