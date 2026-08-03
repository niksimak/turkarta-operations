import { Hono, type Context } from "hono";
import { webhookCallback } from "grammy";
import { z } from "zod";
import { config } from "./config.js";
import { leadsBot, postLead } from "./bots/leads.js";
import {
  supportBot,
  createAppTicket,
  createWebTicket,
  createWelcomeTicket,
  pushWebUserMessage,
} from "./bots/support.js";
import * as db from "./db.js";
import * as bitrixApp from "./bitrix_app.js";

export const app = new Hono();

const TG_LEADS_PATH = `/tg/leads/${config.TELEGRAM_WEBHOOK_SECRET}`;
const TG_SUPPORT_PATH = `/tg/support/${config.TELEGRAM_WEBHOOK_SECRET}`;

app.get("/health", (c) => c.json({ status: "ok" }));

// Telegram update webhooks (grammy verifies the secret_token header).
app.post(
  TG_LEADS_PATH,
  webhookCallback(leadsBot, "hono", { secretToken: config.TELEGRAM_WEBHOOK_SECRET }),
);
app.post(
  TG_SUPPORT_PATH,
  webhookCallback(supportBot, "hono", { secretToken: config.TELEGRAM_WEBHOOK_SECRET }),
);

// Inbound lead from the Lovable landing form.
// Field names vary by form, so accept common aliases and normalize below.
const LeadPayload = z.object({
  name: z.string().nullish(),
  company: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  tg_username: z.string().nullish(),
  telegram: z.string().nullish(), // alias for tg_username
  tg: z.string().nullish(), //       alias for tg_username
  username: z.string().nullish(), // alias for tg_username
  contact: z.string().nullish(),
  message: z.string().nullish(),
  source: z.string().nullish(),
});

app.post("/webhooks/leads", async (c) => {
  if (c.req.header("x-webhook-secret") !== config.LEADS_WEBHOOK_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  // Accept either a flat form payload or a Supabase DB-webhook envelope.
  const raw = body?.record ?? body;
  const parsed = LeadPayload.safeParse(raw);
  if (!parsed.success) return c.json({ error: "bad payload" }, 422);
  const d = parsed.data;

  await postLead({
    name: d.name ?? null,
    company: d.company ?? null,
    phone: d.phone ?? null,
    email: d.email ?? null,
    tg_username: d.tg_username ?? d.telegram ?? d.tg ?? d.username ?? null,
    contact: d.contact ?? null,
    message: d.message ?? null,
    source: d.source ?? "lovable-landing",
  });
  return c.json({ ok: true });
});

// Inbound support ticket from the Mini App (structured: it already has tg/email/device).
const SupportPayload = z.object({
  tg: z.coerce.number().int(), // end-user's telegram id — required to relay back
  username: z.string().nullish(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  device: z.string().nullish(),
  request: z.string().min(1),
  message: z.string().nullish(), // alias for request
});

app.post("/webhooks/support", async (c) => {
  const expected = config.APP_WEBHOOK_SECRET ?? config.LEADS_WEBHOOK_SECRET;
  if (c.req.header("x-webhook-secret") !== expected) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  const raw = body?.record ?? body;
  // Allow `message` as an alias for `request` before validation.
  if (raw && typeof raw === "object" && raw.request == null && raw.message != null) {
    raw.request = raw.message;
  }
  const parsed = SupportPayload.safeParse(raw);
  if (!parsed.success) return c.json({ error: "bad payload" }, 422);
  const d = parsed.data;

  const ticket = await createAppTicket({
    user_tg: d.tg,
    user_username: d.username ?? null,
    user_name: d.name ?? null,
    email: d.email ?? null,
    device: d.device ?? null,
    request: d.request,
  });
  return c.json({ ok: true, ticketId: ticket.id });
});

// ---- Web in-app chat (server-to-server; called by the web app's backend) ----
// The web backend authenticates the user and proxies here with the shared secret,
// passing the app's user.id as web_user_id. The frontend never calls these directly.

function appAuthed(c: Context): boolean {
  const expected = config.APP_WEBHOOK_SECRET ?? config.LEADS_WEBHOOK_SECRET;
  return c.req.header("x-webhook-secret") === expected;
}

const serializeMessages = (msgs: db.Message[]) =>
  msgs.map((m) => ({ id: m.id, seq: m.seq, sender: m.sender, body: m.body, at: m.created_at }));

// Open (or return the existing open) web ticket.
const WebOpenPayload = z.object({
  web_user_id: z.string().min(1),
  name: z.string().nullish(),
  email: z.string().nullish(),
  device: z.string().nullish(),
  request: z.string().min(1),
  message: z.string().nullish(), // alias for request
});

app.post("/api/support/web/open", async (c) => {
  if (!appAuthed(c)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (body && typeof body === "object" && body.request == null && body.message != null) {
    body.request = body.message;
  }
  const parsed = WebOpenPayload.safeParse(body);
  if (!parsed.success) return c.json({ error: "bad payload" }, 422);
  const d = parsed.data;

  const ticket = await createWebTicket({
    web_user_id: d.web_user_id,
    user_name: d.name ?? null,
    email: d.email ?? null,
    device: d.device ?? null,
    request: d.request,
  });
  return c.json({ ok: true, ticketId: ticket.id, status: ticket.status });
});

// Proactive onboarding welcome: open a ticket seeded with a support greeting.
const WebWelcomePayload = z.object({
  web_user_id: z.string().min(1),
  name: z.string().nullish(),
  email: z.string().nullish(),
  device: z.string().nullish(),
});

app.post("/api/support/web/welcome", async (c) => {
  if (!appAuthed(c)) return c.json({ error: "forbidden" }, 403);
  const parsed = WebWelcomePayload.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad payload" }, 422);
  const d = parsed.data;
  const ticket = await createWelcomeTicket({
    web_user_id: d.web_user_id,
    user_name: d.name ?? null,
    email: d.email ?? null,
    device: d.device ?? null,
  });
  return c.json({ ok: true, ticketId: ticket.id });
});

// Web user sends a message into their open ticket.
const WebMessagePayload = z.object({
  web_user_id: z.string().min(1),
  body: z.string().min(1),
});

app.post("/api/support/web/message", async (c) => {
  if (!appAuthed(c)) return c.json({ error: "forbidden" }, 403);
  const parsed = WebMessagePayload.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad payload" }, 422);

  const ticket = await db.ticketByWebUser(parsed.data.web_user_id);
  if (!ticket) return c.json({ error: "no open ticket" }, 404);
  await pushWebUserMessage(ticket, parsed.data.body);
  return c.json({ ok: true });
});

// Web app polls for new messages + ticket status.
app.get("/api/support/web/messages", async (c) => {
  if (!appAuthed(c)) return c.json({ error: "forbidden" }, 403);
  const webUserId = c.req.query("web_user_id");
  if (!webUserId) return c.json({ error: "web_user_id required" }, 422);
  const sinceRaw = c.req.query("since");
  const since = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
  if (since != null && !Number.isFinite(since)) {
    return c.json({ error: "since must be a number" }, 422);
  }

  const ticket = await db.latestTicketByWebUser(webUserId);
  if (!ticket) return c.json({ ticketId: null, status: null, messages: [], cursor: since ?? 0 });
  const messages = await db.messagesSince(ticket.id, since);
  return c.json({
    ticketId: ticket.id,
    status: ticket.status,
    category: ticket.category,
    messages: serializeMessages(messages),
    // Convenience: the cursor to pass as `since` on the next poll.
    cursor: messages.length ? messages[messages.length - 1]!.seq : (since ?? 0),
  });
});

// ---- Bitrix24 local application: install + handler ------------------------
//
// Configured in Разработчикам → Локальное приложение:
//   Путь для первоначальной установки → /bitrix/app/install
//   Путь вашего обработчика           → /bitrix/app/handler
//
// Bitrix POSTs x-www-form-urlencoded with UPPERCASE keys on install
// (AUTH_ID / REFRESH_ID / AUTH_EXPIRES / member_id / DOMAIN) and lowercase
// bracketed keys on events (auth[access_token] …). Both shapes are read here.

function formValue(form: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = form[k];
    if (v != null && String(v) !== "") return String(v);
  }
  return "";
}

/**
 * Persist whatever credentials a Bitrix POST carried. Returns false when the
 * payload had no token pair (e.g. a placement GET), so callers can skip.
 */
async function storeBitrixInstall(form: Record<string, unknown>): Promise<boolean> {
  const accessToken = formValue(form, "AUTH_ID", "auth[access_token]");
  const refreshToken = formValue(form, "REFRESH_ID", "auth[refresh_token]");
  const memberId = formValue(form, "member_id", "auth[member_id]");
  const domain = formValue(form, "DOMAIN", "auth[domain]");
  if (!accessToken || !refreshToken || !memberId) return false;

  await bitrixApp.saveInstall({
    memberId,
    domain: domain || new URL(config.PUBLIC_BASE_URL).host,
    accessToken,
    refreshToken,
    expiresInSeconds: Number(formValue(form, "AUTH_EXPIRES", "auth[expires_in]")) || 3600,
    applicationToken: formValue(form, "APP_SID", "auth[application_token]") || null,
  });
  return true;
}

// Bitrix renders this inside an iframe and waits for BX24.installFinish() —
// without that call the install spinner never completes, even though we already
// hold the tokens.
const INSTALL_FINISH_HTML = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>ТурКарта Поддержка</title>
<script src="//api.bitrix24.com/api/v1/"></script></head>
<body style="font:14px/1.5 -apple-system,sans-serif;padding:24px">
<p>Приложение установлено ✅</p>
<script>if (window.BX24) { BX24.init(function(){ BX24.installFinish(); }); }</script>
</body></html>`;

app.post("/bitrix/app/install", async (c) => {
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const stored = await storeBitrixInstall(form);
  if (!stored) console.warn("[bitrix-app] install POST carried no tokens");
  return c.html(INSTALL_FINISH_HTML);
});

// Bitrix sometimes opens the install path with GET (re-install from the UI).
app.get("/bitrix/app/install", (c) => c.html(INSTALL_FINISH_HTML));

/**
 * The app handler. Two very different callers share this URL by Bitrix's design:
 *  - an OPERATOR clicking the app's menu item (GET, rendered in an iframe) —
 *    serve a human status page, since a JSON blob there reads as "broken";
 *  - BITRIX posting events (POST), starting with ONAPPINSTALL.
 */
app.get("/bitrix/app/handler", async (c) => {
  const tokens = await db.getBitrixTokens().catch(() => null);
  const expiresAt = tokens ? new Date(tokens.expires_at) : null;
  const rows = [
    ["Приложение", tokens ? "установлено ✅" : "НЕ установлено ❌"],
    ["Портал", tokens?.domain ?? "—"],
    [
      "Токен действителен до",
      expiresAt ? `${expiresAt.toISOString()} (${Math.round((expiresAt.getTime() - Date.now()) / 60000)} мин)` : "—",
    ],
    ["Коннектор", tokens?.connector_registered_at ? `зарегистрирован ${tokens.connector_registered_at}` : "не зарегистрирован ❌"],
  ];
  return c.html(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>ТурКарта Поддержка</title></head>
<body style="font:14px/1.6 -apple-system,sans-serif;padding:24px">
<h2 style="margin:0 0 16px">ТурКарта · интеграция поддержки</h2>
<table cellpadding="6" style="border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="color:#666">${k}</td><td><b>${v}</b></td></tr>`).join("")}
</table>
</body></html>`);
});

app.post("/bitrix/app/handler", async (c) => {
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const event = formValue(form, "event").toUpperCase();

  // ONAPPINSTALL is the authoritative install signal — the install PAGE can be
  // opened by a human, but this event only comes from Bitrix.
  if (event === "ONAPPINSTALL") {
    await storeBitrixInstall(form);
    console.log("[bitrix-app] ONAPPINSTALL stored");
    return c.json({ ok: true });
  }

  // Operator replies (OnImConnectorMessageAdd) land here once the connector is
  // registered — wired in the next step, ACKed for now so Bitrix stops retrying.
  console.log(`[bitrix-app] event ${event || "(none)"} received`);
  return c.json({ ok: true, event: event || null });
});

/** Register Telegram webhooks on boot. */
export async function registerWebhooks(): Promise<void> {
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  await leadsBot.api.setWebhook(`${base}${TG_LEADS_PATH}`, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    // false: on Render free tier the service cold-starts on the incoming webhook,
    // so keep the queued update that woke us instead of dropping it.
    drop_pending_updates: false,
    allowed_updates: ["message", "callback_query"],
  });
  await supportBot.api.setWebhook(`${base}${TG_SUPPORT_PATH}`, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    // false: on Render free tier the service cold-starts on the incoming webhook,
    // so keep the queued update that woke us instead of dropping it.
    drop_pending_updates: false,
    allowed_updates: ["message", "callback_query"],
  });
}
