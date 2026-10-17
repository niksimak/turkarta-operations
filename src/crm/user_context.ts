import { z } from "zod";
import { turkartaApiAuth } from "../turkarta_api.js";

const TIMEOUT_MS = 3_000;
const TTL_MS = 60_000;
// A slow or failing turkarta must not add the full timeout to every thread refetch.
const FAILURE_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

const Nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();

const UserContextSchema = z.object({
  found: z.boolean(),
  user_id: z.string().optional(),
  tg_id: Nullable(z.number()),
  tg_username: Nullable(z.string()),
  name: Nullable(z.string()),
  email: Nullable(z.string()),
  email_verified: z.boolean().optional(),
  csb_email: Nullable(z.string()),
  registered_at: Nullable(z.string()),
  kyc_level: Nullable(z.number()),
  cards: z.array(z.object({
    last4: z.string(), status: z.string(), plan: z.string().nullable(), product_id: Nullable(z.string()),
    balance_usd: z.string().nullable(),
  })).optional(),
  recent_topups: z.array(z.object({
    amount_rub: z.string().nullable(), amount_usd: z.string().nullable(),
    status: z.string(), created_at: z.string(),
  })).optional(),
  admin_url: Nullable(z.string()),
});

export type UserContext = z.infer<typeof UserContextSchema>;

const cache = new Map<string, { at: number; ttl: number; value: UserContext | null }>();

function remember(key: string, at: number, value: UserContext | null): UserContext | null {
  cache.delete(key);
  cache.set(key, { at, ttl: value ? TTL_MS : FAILURE_TTL_MS, value });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return value;
}

export async function userContext(
  t: { user_tg: number | null; web_user_id: string | null },
  deps: {
    fetch?: typeof fetch; now?: () => number;
    api?: { base: string; secret: string } | null;
  } = {},
): Promise<UserContext | null> {
  const key = t.user_tg != null ? `tg:${t.user_tg}` : t.web_user_id ? `web:${t.web_user_id}` : null;
  if (!key) return null;
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const api = deps.api === undefined ? turkartaApiAuth() : deps.api;
  if (!api) return null;
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${api.base}/webhooks/ops/support/user-context`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": api.secret },
      body: JSON.stringify({ tg_id: t.user_tg, user_id: t.web_user_id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[crm-user-context] failed code=${res.status}`);
      return remember(key, now, null);
    }
    const parsed = UserContextSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("[crm-user-context] failed code=invalid");
      return remember(key, now, null);
    }
    return remember(key, now, parsed.data);
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.warn(`[crm-user-context] failed code=${timeout ? "timeout" : "invalid"}`);
    return remember(key, now, null);
  }
}

export function clearUserContextCache(): void {
  cache.clear();
}
