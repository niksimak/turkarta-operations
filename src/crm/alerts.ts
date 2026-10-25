import type { Bot } from "grammy";
import { escapeHtml } from "../cards.js";
import { ticketWho, type TicketListItem } from "./tickets.js";

export interface Alerts {
  newTicket(t: TicketListItem): Promise<void>;
  overdue(t: TicketListItem, minutes: number): Promise<void>;
  noOneOnShift(queued: number): Promise<void>;
}

const FIRST_LINE_MAX = 120;
const SEND_TIMEOUT_MS = 5000;

const CHANNEL_LABEL: Record<string, string> = { bot: "Telegram", miniapp: "Mini App", web: "Web", "web-onboarding": "Web", payout: "Выплата" };

function channelLabel(t: Pick<TicketListItem, "source" | "channel">): string {
  return (t.source ? CHANNEL_LABEL[t.source] : undefined) ?? (t.channel === "web" ? "Web" : "Telegram");
}

export function firstLine(text: string): string {
  // Code points, so an emoji at the cut is not split into a broken surrogate.
  return Array.from((text.split("\n", 1)[0] ?? "").trim()).slice(0, FIRST_LINE_MAX).join("");
}

/** Group pings for CRM mode: plain messages to the support chat, no topic. */
export function telegramAlerts(api: Bot["api"], chatId: number, baseUrl: string): Alerts {
  const base = baseUrl.replace(/\/+$/, "");
  const link = (id: string) => `${base}/crm/t/${id}`;
  const send = async (text: string) => {
    // grammY types name the older abort-controller shim; the native signal is runtime-compatible.
    const signal = AbortSignal.timeout(SEND_TIMEOUT_MS) as unknown as Parameters<typeof api.sendMessage>[3];
    await api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }, signal);
  };
  return {
    async newTicket(t) {
      const line = firstLine(t.last_message_preview);
      const head = `🆕 Новое обращение · ${channelLabel(t)} · ${escapeHtml(ticketWho(t))}`;
      await send([head, ...(line ? [escapeHtml(line)] : []), link(t.id)].join("\n"));
    },
    async overdue(t, minutes) {
      await send(`⏰ Ждёт ответа ${minutes} мин · ${escapeHtml(ticketWho(t))}\n${link(t.id)}`);
    },
    async noOneOnShift(queued) {
      await send(`🚨 Никого нет на смене, в очереди ${queued}\n${base}/crm`);
    },
  };
}

// Set by index.ts in CRM mode only; bitrix mode keeps its forum cards and sends no pings.
let active: Alerts | null = null;

export function setActiveAlerts(a: Alerts | null): void {
  active = a;
}

export function activeAlerts(): Alerts | null {
  return active;
}
