import { Hono } from "hono";
import { webhookCallback } from "grammy";
import { z } from "zod";
import { config } from "./config.js";
import { leadsBot, postLead } from "./bots/leads.js";
import { supportBot } from "./bots/support.js";

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
  tg_username: z.string().nullish(),
  telegram: z.string().nullish(), // alias for tg_username
  tg: z.string().nullish(), //       alias for tg_username
  username: z.string().nullish(), // alias for tg_username
  contact: z.string().nullish(),
  message: z.string().nullish(),
  source: z.string().nullish(),
});

app.post("/webhooks/leads", async (c) => {
  if (c.req.header("x-webhook-secret") !== config.SUPABASE_WEBHOOK_SECRET) {
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
    tg_username: d.tg_username ?? d.telegram ?? d.tg ?? d.username ?? null,
    contact: d.contact ?? null,
    message: d.message ?? null,
    source: d.source ?? "lovable-landing",
  });
  return c.json({ ok: true });
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
