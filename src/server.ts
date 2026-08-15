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
import * as openlines from "./bitrix_openlines.js";
import * as turkartaApi from "./turkarta_api.js";
import { validTelegramPhotoRequest } from "./telegram_media.js";

export const app = new Hono();

const TG_LEADS_PATH = `/tg/leads/${config.TELEGRAM_WEBHOOK_SECRET}`;
const TG_SUPPORT_PATH = `/tg/support/${config.TELEGRAM_WEBHOOK_SECRET}`;

app.get("/health", (c) => c.json({ status: "ok" }));

// Bitrix requires an externally reachable file URL. This proxy keeps the
// Telegram bot token out of that URL and rejects expired or modified links.
app.get("/media/telegram/photo.jpg", async (c) => {
  const fileId = c.req.query("file_id") ?? "";
  const expires = c.req.query("expires") ?? "";
  const signature = c.req.query("signature") ?? "";
  if (
    !fileId ||
    !validTelegramPhotoRequest(
      fileId,
      expires,
      signature,
      config.TELEGRAM_WEBHOOK_SECRET,
    )
  ) {
    return c.json({ error: "invalid or expired media link" }, 403);
  }

  const file = await supportBot.api.getFile(fileId).catch(() => null);
  if (!file?.file_path) return c.json({ error: "media unavailable" }, 404);

  const upstream = await fetch(
    `https://api.telegram.org/file/bot${config.SUPPORT_BOT_TOKEN}/${file.file_path}`,
    { signal: AbortSignal.timeout(20_000) },
  ).catch(() => null);
  if (!upstream?.ok || !upstream.body) return c.json({ error: "media unavailable" }, 502);

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "content-disposition": 'inline; filename="photo.jpg"',
      "cache-control": "private, no-store",
    },
  });
});

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

/**
 * Parse PHP-style bracketed form encoding into nested objects:
 * `data[MESSAGES][0][message][text]=hi` -> {data:{MESSAGES:{0:{message:{text:"hi"}}}}}.
 *
 * Needed because Bitrix posts connector events this way and Hono's parseBody
 * keeps the bracketed key flat, so the message array can't be walked otherwise.
 */
function parsePhpForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = [key.replace(/\[.*$/, ""), ...[...key.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!)];
    let node: Record<string, unknown> = out;
    path.forEach((seg, i) => {
      if (i === path.length - 1) node[seg] = value;
      else node = (node[seg] ??= {}) as Record<string, unknown>;
    });
  }
  return out;
}

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
  if (!accessToken || !refreshToken || !memberId) return false;

  // The PORTAL host — every REST call targets https://<domain>/rest/…
  // Bitrix supplies it as DOMAIN (query string on the install callback),
  // auth[domain] (events), or inside auth[client_endpoint]
  // ("https://<portal>/rest/"). There is deliberately NO fallback to our own
  // host: an earlier `|| PUBLIC_BASE_URL` silently stored
  // turkarta-operations.onrender.com and every REST call would have been sent
  // to ourselves. A missing domain must fail loudly, not guess.
  let domain = formValue(form, "DOMAIN", "auth[domain]");
  if (!domain) {
    const endpoint = formValue(form, "auth[client_endpoint]", "client_endpoint");
    if (endpoint) domain = new URL(endpoint).host;
  }
  if (!domain) {
    console.error("[bitrix-app] install payload carried NO portal domain — refusing");
    return false;
  }

  await bitrixApp.saveInstall({
    memberId,
    domain,
    accessToken,
    refreshToken,
    expiresInSeconds: Number(formValue(form, "AUTH_EXPIRES", "auth[expires_in]")) || 3600,
    // ONLY auth[application_token]. APP_SID is a placement session id, NOT the
    // event-verification token — treating them as interchangeable stored a
    // useless value and left inbound events unverifiable.
    applicationToken: formValue(form, "auth[application_token]") || null,
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

/**
 * Bitrix splits the install callback across BOTH transports: DOMAIN / PROTOCOL /
 * LANG / APP_SID ride the QUERY STRING while AUTH_ID / REFRESH_ID / member_id /
 * AUTH_EXPIRES are POSTed in the body. Reading only the body loses the portal
 * domain — which is exactly how the first install stored a broken host.
 */
interface BitrixPayload {
  /** Keys exactly as sent ("auth[access_token]") — what formValue looks up. */
  flat: Record<string, unknown>;
  /** Bracket-expanded ({auth:{access_token}}) — needed to walk MESSAGES. */
  nested: Record<string, unknown>;
  /** The raw body, for diagnostics. */
  raw: string;
}

/**
 * Read the request ONCE and expose both views.
 *
 * The body is a stream and can only be consumed once, so reading it twice
 * (parseBody for the flat keys, then text() for the nested walk) yields an
 * empty second read. Everything is derived from a single `text()` here.
 */
async function bitrixPayload(c: Context): Promise<BitrixPayload> {
  const raw = await c.req.text().catch(() => "");
  const flat: Record<string, unknown> = { ...c.req.query() };
  for (const [k, v] of new URLSearchParams(raw)) flat[k] = v;
  return { flat, nested: parsePhpForm(raw), raw };
}

app.post("/bitrix/app/install", async (c) => {
  const stored = await storeBitrixInstall((await bitrixPayload(c)).flat);
  if (!stored) console.warn("[bitrix-app] install POST carried no usable tokens");
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
  const payload = await bitrixPayload(c);
  const form = payload.flat;
  const event = formValue(form, "event").toUpperCase();

  // ONAPPINSTALL is the authoritative install signal — the install PAGE can be
  // opened by a human, but this event only comes from Bitrix. It is also the
  // only payload carrying auth[application_token], so a reinstall is how a
  // missing verification token gets healed.
  if (event === "ONAPPINSTALL") {
    await storeBitrixInstall(form);
    console.log("[bitrix-app] ONAPPINSTALL stored");
    // Re-arm the event bindings a reinstall would otherwise drop, leaving
    // outbound working and operator replies silently going nowhere.
    await openlines.ensureBootstrapped(`${config.PUBLIC_BASE_URL}/bitrix/app/handler`);
    return c.json({ ok: true });
  }

  // Operator reply from Открытые линии → back into the ticket's message log,
  // which the PWA is already polling. Bitrix sends PHP-style nested form keys
  // (data[MESSAGES][0][message][text]), so the RAW body is reparsed rather than
  // read through Hono's flat parseBody.
  if (event === "ONIMCONNECTORMESSAGEADD") {
    const data = payload.nested.data as Record<string, unknown> | undefined;
    const messages = data?.MESSAGES;
    const list = Array.isArray(messages) ? messages : Object.values(messages ?? {});
    let delivered = 0;
    for (const raw of list) {
      const m = raw as Record<string, Record<string, string>>;
      const chatId = m.chat?.id ?? "";
      const ticketId = openlines.ticketIdFromChatId(chatId);
      const text = (m.message?.text ?? "").trim();
      // Idempotency key: the operator message's id lives in im.message_id —
      // Bitrix's internal-ids object — NOT in message.id, which only exists on
      // messages WE send outbound. Reading message.id made every operator
      // reply skip as id-less ("1 seen, 0 delivered", 2026-08-03); the docs'
      // event example carries im: {chat_id, message_id} alongside chat/message.
      const rawId = m.im?.message_id ?? m.message?.id;
      const bitrixId = rawId ? `ol-${rawId}` : null;
      // Say WHICH guard rejected it. "1 seen, 0 delivered" with no reason meant
      // re-deploying blind; the inbound chat id in particular is not guaranteed
      // to be the `tk-…` string we send outbound.
      const ticket = ticketId ? await db.getTicket(ticketId) : null;
      if (!ticketId || !text || !bitrixId || !ticket) {
        console.log(
          `[bitrix-ol] SKIP chat="${chatId}" ticketId=${ticketId} ticketFound=${Boolean(ticket)} ` +
            `hasText=${Boolean(text)} msgId=${bitrixId} keys=${JSON.stringify(Object.keys(m))} ` +
            `msg=${JSON.stringify(m).slice(0, 500)}`,
        );
        continue;
      }
      const stored = await db.addAgentMessageFromBitrix(ticket.id, text, bitrixId);
      if (!stored) console.log(`[bitrix-ol] duplicate ${bitrixId} — already delivered`);
      if (stored) {
        delivered++;
        // Delivery leg by channel — all behind the dedup insert, so a Bitrix
        // event retry can never double-deliver. Best-effort by contract.
        if (ticket.channel === "telegram" && ticket.user_tg != null) {
          // TG ticket: the reply goes out as a bot DM (web polling never sees
          // these users). A user who blocked the bot must not 500 the webhook.
          await supportBot.api
            .sendMessage(ticket.user_tg, text)
            .catch((err) =>
              console.warn(
                `[bitrix-ol] DM to ${ticket.user_tg} failed:`,
                err instanceof Error ? err.message : err,
              ),
            );
        } else if (ticket.web_user_id) {
          await turkartaApi.notifySupportReply({
            web_user_id: ticket.web_user_id,
            ticket_id: ticket.id,
            message_id: stored.id,
            preview: text,
          });
        }
      }
    }
    console.log(`[bitrix-ol] operator messages: ${list.length} seen, ${delivered} delivered`);
    if (list.length === 0) {
      // The payload arrived but carried no messages we could read — dump the
      // shape (tokens redacted) so the real key layout is visible instead of
      // guessed. Bitrix's nesting is not documented per-field.
      const redacted = payload.raw
        .replace(/(auth%5B[^=]*token[^=]*%5D|auth\[[^\]]*token[^\]]*\])=[^&]*/gi, "$1=REDACTED")
        .slice(0, 900);
      console.log(`[bitrix-ol] EMPTY payload shape: ${redacted}`);
    }
    return c.json({ ok: true, delivered });
  }

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
