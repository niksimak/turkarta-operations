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
    row("Name", l.name) +
    row("Company", l.company) +
    row("Phone", l.phone) +
    row("Email", l.email) +
    row("Telegram", tgHandle(l.tg_username)) +
    row("Contact", l.contact) +
    row("Message", l.message) +
    row("Source", l.source)
  );
}

export function leadCard(l: Lead): string {
  return "🆕 <b>New lead</b>\n" + leadFields(l) + "\n" + rosterPing();
}

export function leadClaimedCard(l: Lead, byName: string): string {
  return (
    "🟢 <b>Lead — allocated</b>\n" + leadFields(l) + `\n👤 Taken by <b>${esc(byName)}</b>`
  );
}

export function claimKb(table: string, id: string): InlineKeyboard {
  return new InlineKeyboard().text("✋ Взять / Take", `claim:${table}:${id}`);
}

// ---- Support -------------------------------------------------------------

function fromLine(t: Ticket): string {
  if (t.channel === "web") {
    return `${esc(t.user_name) === "—" ? "Web user" : esc(t.user_name)} · 🌐 web`;
  }
  const handle = t.user_username ? `@${t.user_username}` : esc(t.user_name);
  return `${handle} (id <code>${t.user_tg}</code>)`;
}

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  tech_issue: "🔧 Tech issue",
  bug_report: "🐞 Bug report",
  feature_request: "💡 Feature request",
};

const STATUS_LABEL: Record<Ticket["status"], string> = {
  new: "🆕 New",
  allocated: "🟢 In progress",
  awaiting: "⏳ Awaiting resolution",
  resolved: "✅ Resolved",
};

/** Shared field block for a support ticket, omitting empty fields. */
function ticketFields(t: Ticket): string {
  return (
    `<b>From:</b> ${fromLine(t)}\n` +
    row("Email", t.email) +
    row("Device", t.device) +
    row("Source", t.source) +
    row("Request", t.first_message)
  );
}

export function supportCard(t: Ticket): string {
  return "🎫 <b>New support request</b>\n" + ticketFields(t) + "\n" + rosterPing();
}

/** Card shown after an operator takes the ticket; reflects category + status. */
export function supportClaimedCard(t: Ticket, byName: string): string {
  return (
    `${STATUS_LABEL[t.status]} <b>· Support</b>\n` +
    ticketFields(t) +
    row("Category", t.category ? CATEGORY_LABEL[t.category] : null) +
    `\n👤 Handled by <b>${esc(byName)}</b>\n` +
    "Reply in this thread to talk to the user."
  );
}

/** "Take" button for an unclaimed ticket. */
export function supportClaimKb(id: string): InlineKeyboard {
  return new InlineKeyboard().text("✋ Взять / Take", `claim:support_requests:${id}`);
}

/**
 * Operator controls for a taken ticket: a category row (selected one marked ✓)
 * and a status row (Awaiting / Resolve).
 */
export function supportManageKb(t: Ticket): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cats: [TicketCategory, string][] = [
    ["tech_issue", "🔧 Tech"],
    ["bug_report", "🐞 Bug"],
    ["feature_request", "💡 Feature"],
  ];
  for (const [key, label] of cats) {
    kb.text(t.category === key ? `✓ ${label}` : label, `cat:${t.id}:${key}`);
  }
  kb.row();
  if (t.status !== "awaiting") kb.text("⏳ Awaiting", `await:${t.id}`);
  kb.text("✅ Resolve", `resolve:${t.id}`);
  return kb;
}
