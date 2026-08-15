/**
 * Открытые линии relay: ops-hub tickets <-> the Bitrix custom connector.
 *
 * Registered connector `turkarta_support` on line 5 (docs/TZ-BITRIX-SUPPORT.md
 * §4.1). Outbound uses `imconnector.send.messages`; operator replies come back
 * as `OnImConnectorMessageAdd` and are handled in server.ts.
 *
 * The ops hub stays the source of truth for tickets and messages — Bitrix is
 * the operator surface over it. So EVERY export here is best-effort and never
 * throws: a Bitrix outage must not stop a user opening a ticket or sending a
 * message, exactly as the Telegram relay behaves.
 */
import * as bitrixApp from "./bitrix_app.js";
import * as db from "./db.js";
import { config } from "./config.js";

/** The connector chat id for a ticket. Deterministic BOTH ways: an inbound
 *  event echoes this string back, so the ticket is parsed out of it instead of
 *  being looked up in a mapping table. One ticket = one Open Lines session. */
export function chatIdForTicket(ticketId: string): string {
  return `tk-${ticketId}`;
}

/** Inverse of `chatIdForTicket`; null when the chat isn't one of ours. */
export function ticketIdFromChatId(chatId: string): string | null {
  return chatId.startsWith("tk-") ? chatId.slice(3) : null;
}

function warn(what: string, err: unknown): void {
  console.warn(`[bitrix-ol] ${what} failed:`, err instanceof Error ? err.message : err);
}

/** Events the app must subscribe to for operator replies to reach us. */
const EVENTS = ["OnImConnectorMessageAdd", "OnImConnectorLineDelete"];

/**
 * Re-assert the portal-side setup: the connector registration and the event
 * bindings.
 *
 * 🔴 `imconnector.register` does NOT subscribe you to messages — that needs a
 * separate `event.bind`. Missing it is invisible: outbound works perfectly,
 * operator replies just never arrive because Bitrix has nowhere to send them
 * (diagnosed 2026-08-03 — `event.get` returned []).
 *
 * Called on ONAPPINSTALL so a reinstall re-arms everything instead of leaving a
 * half-configured portal. All calls are idempotent on Bitrix's side, and the
 * whole thing is best-effort: a failure here must not break installation.
 */
export async function ensureBootstrapped(handlerUrl: string): Promise<void> {
  if (!bitrixApp.enabled() || !config.BITRIX_LINE_ID) return;
  try {
    const bound = await bitrixApp.call<Array<{ event: string }>>("event.get");
    const have = new Set(bound.map((b) => b.event.toUpperCase()));
    for (const ev of EVENTS) {
      if (have.has(ev.toUpperCase())) continue;
      await bitrixApp.call("event.bind", { event: ev, handler: handlerUrl });
      console.log(`[bitrix-ol] bound ${ev}`);
    }
  } catch (err) {
    warn("ensureBootstrapped", err);
  }
}

/**
 * Push one user message into the ticket's Open Lines chat.
 *
 * `messageId` is OUR message row id — echoed by Bitrix on the way back, which
 * is how the inbound handler tells "a line we sent" from "an operator reply"
 * and avoids echoing the user's own words at them.
 */
export async function sendUserMessage(
  ticket: db.Ticket,
  body: string,
  messageId: string,
  files: Array<{ url: string; name: string }> = [],
): Promise<void> {
  if (!bitrixApp.enabled() || !config.BITRIX_LINE_ID) return;
  const who = ticket.user_name || ticket.user_username || "Пользователь";
  try {
    // send.messages reports per-message outcomes INSIDE the result envelope —
    // a rejected line yields SUCCESS:false with no top-level `error`, so it
    // never throws. Without inspecting it, a silently dropped message looks
    // identical to a delivered one (2026-08-03: only the first message of a
    // conversation was reaching the line, with nothing logged).
    const res = await bitrixApp.call<{
      SUCCESS?: boolean;
      DATA?: { RESULT?: Array<Record<string, unknown>> };
    }>("imconnector.send.messages", {
      CONNECTOR: config.BITRIX_CONNECTOR_ID,
      LINE: config.BITRIX_LINE_ID,
      MESSAGES: [
        {
          user: {
            id: ticket.web_user_id ?? String(ticket.user_tg ?? ticket.id),
            name: who,
            email: ticket.email ?? undefined,
          },
          chat: {
            id: chatIdForTicket(ticket.id),
            name: `ТурКарта · ${ticket.channel} · ${who}`,
            url: "https://app.turkarta.me",
          },
          message: {
            id: messageId,
            date: Math.floor(Date.now() / 1000),
            text: body,
            ...(files.length ? { files } : {}),
          },
        },
      ],
    });
    const per = res?.DATA?.RESULT?.[0];
    const ok = res?.SUCCESS === true && per?.SUCCESS !== false;
    console.log(
      `[bitrix-ol] send ticket=${ticket.id} msg=${messageId} ok=${ok} ` +
        `raw=${JSON.stringify(res).slice(0, 400)}`,
    );
  } catch (err) {
    warn(`sendUserMessage(${ticket.id})`, err);
  }
}
