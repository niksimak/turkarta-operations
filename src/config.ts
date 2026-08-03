import { z } from "zod";

const RosterMember = z.object({
  name: z.string(),
  username: z.string().optional(),
  tg_id: z.number().int().optional(),
});
export type RosterMember = z.infer<typeof RosterMember>;

const Env = z.object({
  LEADS_BOT_TOKEN: z.string().min(1),
  SUPPORT_BOT_TOKEN: z.string().min(1),

  LEADS_CHAT_ID: z.coerce.number().int(),
  SUPPORT_CHAT_ID: z.coerce.number().int(),
  SUPPORT_FORUM: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),

  // Shared secret guarding the inbound webhooks (Lovable leads + app fallback),
  // sent as the `x-webhook-secret` header. Not a Supabase resource — just a name.
  LEADS_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  // Secret the Mini App / web app sends to the support webhooks. Optional: falls
  // back to LEADS_WEBHOOK_SECRET so the endpoints work before a dedicated one is set.
  APP_WEBHOOK_SECRET: z.string().optional(),

  // --- Bitrix24 local application (docs/TZ-BITRIX-SUPPORT.md §4.1) ---
  // OAuth credentials from Разработчикам → Локальное приложение. Optional:
  // every Bitrix path is inert unless BITRIX_CLIENT_ID is set, so a deploy
  // without them behaves exactly as before.
  // NOTE: unlike a webhook URL these can be rotated in the Bitrix UI — do so if
  // the secret is ever pasted into a chat, screenshot or log.
  BITRIX_CLIENT_ID: z.string().optional(),
  BITRIX_CLIENT_SECRET: z.string().optional(),
  // Connector id registered via imconnector.register. Lowercase + underscores
  // ONLY (Bitrix rejects dots), and immutable once registered — changing it
  // orphans every existing chat, so it is config, not a literal.
  BITRIX_CONNECTOR_ID: z.string().default("turkarta_support"),
  // Открытая линия the connector is activated on. 0 = relay disabled, so the
  // Bitrix leg stays dark until a line is explicitly chosen. Line 5 =
  // «Открытая линия 3» on b24-zmr5uh (registered 2026-08-03).
  BITRIX_LINE_ID: z.coerce.number().int().default(0),

  // --- turkarta API callback (support-reply push notifications) ---
  // Base URL of the main app's API; unset = no callbacks (feature dark).
  TURKARTA_API_URL: z.string().url().optional(),
  // Defaults to the same shared secret the API already sends US, so one value
  // guards the boundary in both directions.
  TURKARTA_API_SECRET: z.string().optional(),

  ROSTER: z
    .string()
    .default("[]")
    .transform((s) => z.array(RosterMember).parse(JSON.parse(s))),

  PORT: z.coerce.number().int().default(8000),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:\n", JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const config = parsed.data;

/** A Telegram mention that actually pings the person. */
export function mention(m: RosterMember): string {
  if (m.tg_id) return `<a href="tg://user?id=${m.tg_id}">${m.name}</a>`;
  if (m.username) return `@${m.username}`;
  return m.name;
}

export const rosterIds = new Set(
  config.ROSTER.map((m) => m.tg_id).filter((id): id is number => id != null),
);

export function memberFor(tgId: number): RosterMember | undefined {
  return config.ROSTER.find((m) => m.tg_id === tgId);
}

export function rosterPing(): string {
  return config.ROSTER.map(mention).join(" ");
}
