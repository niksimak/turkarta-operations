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

  SUPABASE_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  // Secret the Mini App sends to POST /webhooks/support. Optional: falls back to
  // SUPABASE_WEBHOOK_SECRET so the endpoint works before a dedicated one is set.
  APP_WEBHOOK_SECRET: z.string().optional(),

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
