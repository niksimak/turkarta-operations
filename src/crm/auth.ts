import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { sql } from "../db.js";
import { DEFAULT_PREFS, type CrmRole, type Operator } from "./types.js";

export interface SsoClaims { sub: number; name: string; email: string | null; role: "admin" | "support"; jti: string; exp: number; next?: string }

export const SESSION_COOKIE = "crm_session";
export const SESSION_TTL_HOURS = 12;

const MAX_EXP_AHEAD_SEC = 120;
const B64URL = /^[A-Za-z0-9_-]+$/;
const NEXT_RE = /^\/crm(\/[\w\-/]*)?$/;

const sign = (payloadPart: string, secret: string) => createHmac("sha256", secret).update(payloadPart).digest();
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Token = base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, payloadPart)). */
export function signSsoToken(claims: SsoClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

type VerifyResult =
  | { ok: true; claims: SsoClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "role" };

export function verifySsoToken(token: string, secret: string, nowSec: number = Math.floor(Date.now() / 1000)): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadPart, sigPart] = parts as [string, string];
  if (!B64URL.test(payloadPart) || !B64URL.test(sigPart)) return { ok: false, reason: "malformed" };

  const got = Buffer.from(sigPart, "base64url");
  const want = sign(payloadPart, secret);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "signature" };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const c = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(c.sub) ||
    typeof c.name !== "string" || c.name === "" ||
    !(c.email === null || typeof c.email === "string") ||
    typeof c.role !== "string" ||
    typeof c.jti !== "string" || c.jti === "" ||
    !Number.isSafeInteger(c.exp) ||
    !(c.next === undefined || typeof c.next === "string")
  ) return { ok: false, reason: "malformed" };

  const exp = c.exp as number;
  if (exp - nowSec > MAX_EXP_AHEAD_SEC) return { ok: false, reason: "malformed" };
  if (exp < nowSec) return { ok: false, reason: "expired" };
  if (c.role !== "admin" && c.role !== "support") return { ok: false, reason: "role" };

  const claims: SsoClaims = { sub: c.sub as number, name: c.name, email: c.email as string | null, role: c.role, jti: c.jti, exp };
  if (c.next !== undefined) claims.next = c.next as string;
  return { ok: true, claims };
}

export interface OperatorRow {
  id: string | number; name: string; email: string | null; role: CrmRole; is_lead: boolean;
  auto_assign_enabled: boolean; on_shift: boolean; last_active_at: Date | null; last_assigned_at: Date | null;
  prefs: Partial<Operator["prefs"]> | null;
}

export function toOperator(r: OperatorRow): Operator {
  return {
    id: Number(r.id), name: r.name, email: r.email, role: r.role, is_lead: r.is_lead,
    auto_assign_enabled: r.auto_assign_enabled, on_shift: r.on_shift,
    last_active_at: r.last_active_at ? r.last_active_at.toISOString() : null,
    last_assigned_at: r.last_assigned_at ? r.last_assigned_at.toISOString() : null,
    prefs: { ...DEFAULT_PREFS, ...(r.prefs ?? {}) },
  };
}

export type ConsumeResult =
  | { ok: true; sessionToken: string; operator: Operator; next?: string }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "role" | "replay" | "disabled" };

export async function consumeSso(token: string): Promise<ConsumeResult> {
  const secret = config.CRM_SSO_SECRET;
  if (!secret) return { ok: false, reason: "disabled" };
  const v = verifySsoToken(token, secret);
  if (!v.ok) return v;
  const { claims } = v;

  const sessionToken = randomBytes(32).toString("base64url");
  const out = await sql.begin(async (tx) => {
    const fresh = await tx`
      insert into crm_sso_nonces (jti, expires_at)
      values (${claims.jti}, to_timestamp(${claims.exp}) + interval '1 hour')
      on conflict do nothing returning jti`;
    if (fresh.length === 0) return null;
    const [row] = await tx<OperatorRow[]>`
      insert into crm_operators (id, name, email, role)
      values (${claims.sub}, ${claims.name}, ${claims.email}, ${claims.role})
      on conflict (id) do update
        set name = excluded.name, email = excluded.email, role = excluded.role, updated_at = now()
      returning *`;
    await tx`
      insert into crm_sessions (token_hash, operator_id, expires_at)
      values (${sha256Hex(sessionToken)}, ${claims.sub}, now() + make_interval(hours => ${SESSION_TTL_HOURS}))`;
    await tx`delete from crm_sso_nonces where expires_at < now()`;
    await tx`delete from crm_sessions where expires_at < now()`;
    return row!;
  });
  if (!out) return { ok: false, reason: "replay" };

  const res: ConsumeResult = { ok: true, sessionToken, operator: toOperator(out) };
  if (claims.next !== undefined && NEXT_RE.test(claims.next)) res.next = claims.next;
  return res;
}

export async function operatorForSession(sessionToken: string): Promise<Operator | null> {
  if (!sessionToken) return null;
  const [row] = await sql<OperatorRow[]>`
    select o.* from crm_sessions s
    join crm_operators o on o.id = s.operator_id
    where s.token_hash = ${sha256Hex(sessionToken)} and s.expires_at > now()`;
  return row ? toOperator(row) : null;
}

export async function deleteSession(sessionToken: string): Promise<void> {
  await sql`delete from crm_sessions where token_hash = ${sha256Hex(sessionToken)}`;
}

/** Cookie + X-CRM header (CSRF guard with SameSite); sets c.var.operator. */
export function requireOperator(): MiddlewareHandler<{ Variables: { operator: Operator } }> {
  return async (c, next) => {
    const deny = () => c.json({ error: "unauthorized" }, 401);
    if (c.req.header("X-CRM") !== "1") return deny();
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) return deny();
    const operator = await operatorForSession(cookie);
    if (!operator) return deny();
    c.set("operator", operator);
    await next();
  };
}
