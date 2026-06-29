import { InlineKeyboard } from "grammy";
import { rosterPing } from "./config.js";
import type { Lead, Ticket, TicketCategory } from "./db.js";

// callback_data:  "claim:<table>:<id>"  /  "resolve:<id>"

export function escapeHtml(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const esc = escapeHtml;

// ---- Leads ---------------------------------------------------------------

/** A "<b>Label:</b> value\n" line, or "" when the value is empty. */
function row(label: string, value: string | null | undefined): string {
  return value ? `<b>${label}:</b> ${esc(value)}\n` : "";
}

/** Normalize a Telegram handle for display: ensure a single leading "@". */
function tgHandle(value: string | null): string | null {
  if (!value) return null;
  const h = value.trim().replace(/^@+/, "");
  return h ? `@${h}` : null;
}

/** Shared field block for a lead, omitting empty fields. */
function leadFields(l: Lead): string {
  return (
    row("Имя", l.name) +
    row("Компания", l.company) +
    row("Телефон", l.phone) +
    row("Email", l.email) +
    row("Telegram", tgHandle(l.tg_username)) +
    row("Контакт", l.contact) +
    row("Сообщение", l.message) +
    row("Источник", l.source)
  );
}

export function leadCard(l: Lead): string {
  return "🆕 <b>Новый лид</b>\n" + leadFields(l) + "\n" + rosterPing();
}

export function leadClaimedCard(l: Lead, byName: string): string {
  return "🟢 <b>Лид — взят</b>\n" + leadFields(l) + `\n👤 Взял <b>${esc(byName)}</b>`;
}

export function claimKb(table: string, id: string): InlineKeyboard {
  return new InlineKeyboard().text("✋ Взять", `claim:${table}:${id}`);
}

// ---- Support -------------------------------------------------------------

function fromLine(t: Ticket): string {
  if (t.channel === "web") {
    return `${esc(t.user_name) === "—" ? "Веб-пользователь" : esc(t.user_name)} · 🌐 web`;
  }
  const handle = t.user_username ? `@${t.user_username}` : esc(t.user_name);
  return `${handle} (id <code>${t.user_tg}</code>)`;
}

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  tech_issue: "🔧 Тех. проблема",
  bug_report: "🐞 Баг",
  feature_request: "💡 Пожелание",
};

const STATUS_LABEL: Record<Ticket["status"], string> = {
  new: "🆕 Новое",
  allocated: "🟢 В работе",
  awaiting: "⏳ Ожидает",
  resolved: "✅ Закрыто",
};

/** Shared field block for a support ticket, omitting empty fields. */
function ticketFields(t: Ticket): string {
  return (
    `<b>От:</b> ${fromLine(t)}\n` +
    row("Email", t.email) +
    row("Устройство", t.device) +
    row("Источник", t.source) +
    row("Запрос", t.first_message)
  );
}

export function supportCard(t: Ticket): string {
  return "🎫 <b>Новое обращение</b>\n" + ticketFields(t) + "\n" + rosterPing();
}

/** Card shown after an operator takes the ticket; reflects category + status. */
export function supportClaimedCard(t: Ticket, byName: string): string {
  return (
    `${STATUS_LABEL[t.status]} <b>· Поддержка</b>\n` +
    ticketFields(t) +
    row("Категория", t.category ? CATEGORY_LABEL[t.category] : null) +
    `\n👤 Ведёт <b>${esc(byName)}</b>\n` +
    "Отвечайте в этой теме — сообщение уйдёт пользователю."
  );
}

/** "Take" button for an unclaimed ticket. */
export function supportClaimKb(id: string): InlineKeyboard {
  return new InlineKeyboard().text("✋ Взять", `claim:support_requests:${id}`);
}

/**
 * Operator controls for a taken ticket: a category row (selected one marked ✓)
 * and a status row (Awaiting / Resolve).
 */
export function supportManageKb(t: Ticket): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cats: [TicketCategory, string][] = [
    ["tech_issue", "🔧 Тех"],
    ["bug_report", "🐞 Баг"],
    ["feature_request", "💡 Идея"],
  ];
  for (const [key, label] of cats) {
    kb.text(t.category === key ? `✓ ${label}` : label, `cat:${t.id}:${key}`);
  }
  kb.row();
  if (t.status !== "awaiting") kb.text("⏳ Отложить", `await:${t.id}`);
  kb.text("✅ Закрыть", `resolve:${t.id}`);
  return kb;
}

/**
 * Confirmation row shown after the first tap on "Закрыть" — a second deliberate
 * tap is required to actually close, so an accidental tap can't end a ticket.
 */
export function supportConfirmResolveKb(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Да, закрыть", `resolve_do:${id}`)
    .text("↩️ Отмена", `resolve_cancel:${id}`);
}
