import { InlineKeyboard } from "grammy";
import { rosterPing } from "./config.js";
import type { Lead, Ticket } from "./db.js";

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

function userHandle(t: Ticket): string {
  return t.user_username ? `@${t.user_username}` : esc(t.user_name);
}

export function supportCard(t: Ticket): string {
  return (
    "🎫 <b>New support request</b>\n" +
    `<b>From:</b> ${userHandle(t)} (id <code>${t.user_tg}</code>)\n` +
    `<b>Source:</b> ${esc(t.source)}\n` +
    `<b>Message:</b> ${esc(t.first_message)}\n\n` +
    rosterPing()
  );
}

export function supportClaimedCard(t: Ticket, byName: string): string {
  return (
    "🟢 <b>Support — in progress</b>\n" +
    `<b>From:</b> ${userHandle(t)} (id <code>${t.user_tg}</code>)\n` +
    `<b>Message:</b> ${esc(t.first_message)}\n\n` +
    `👤 Handled by <b>${esc(byName)}</b>\n` +
    "Reply in this thread to talk to the user."
  );
}

export function supportKb(id: string, resolvable = false): InlineKeyboard {
  return resolvable
    ? new InlineKeyboard().text("✅ Закрыть / Resolve", `resolve:${id}`)
    : new InlineKeyboard().text("✋ Взять / Take", `claim:support_requests:${id}`);
}
