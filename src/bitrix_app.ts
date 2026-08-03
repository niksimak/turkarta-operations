/**
 * Bitrix24 LOCAL APPLICATION — OAuth lifecycle + authenticated REST.
 *
 * This is the piece a webhook never needed. `imconnector.register` refuses
 * webhook auth outright (`WRONG_AUTH_TYPE` / `NO_APPLICATION_ID`: a connector is
 * bound to an application id), so an Открытые линии connector REQUIRES a real
 * OAuth app — see docs/TZ-BITRIX-SUPPORT.md §4.1.
 *
 * The cost of that is token lifecycle: an access token lives ~1h and refreshing
 * ROTATES the refresh token too, so the new pair must be persisted every time
 * or the app has to be re-installed by hand.
 */
import { config } from "./config.js";
import * as db from "./db.js";

/** Bitrix's central OAuth server — NOT the portal domain. */
const OAUTH_URL = "https://oauth.bitrix.info/oauth/token/";

/** Refresh this long before the deadline, to cover clock skew + a slow call. */
const REFRESH_SKEW_MS = 5 * 60_000;

const TIMEOUT_MS = 20_000;

export class BitrixAppError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    description: string,
  ) {
    super(`bitrix-app ${method}: ${code} ${description}`);
  }
}

export function enabled(): boolean {
  return Boolean(config.BITRIX_CLIENT_ID && config.BITRIX_CLIENT_SECRET);
}

/**
 * Persist the tokens Bitrix hands over at install time.
 *
 * Bitrix posts these to the install URL (and again inside ONAPPINSTALL), with
 * `AUTH_EXPIRES` as a duration in SECONDS — converted to an absolute instant
 * here, because a stored TTL is meaningless once the process restarts.
 */
export async function saveInstall(p: {
  memberId: string;
  domain: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  applicationToken?: string | null;
}): Promise<void> {
  await db.saveBitrixTokens({
    member_id: p.memberId,
    domain: p.domain,
    access_token: p.accessToken,
    refresh_token: p.refreshToken,
    expires_at: new Date(Date.now() + p.expiresInSeconds * 1000),
    application_token: p.applicationToken ?? null,
  });
}

// A single in-flight refresh shared by concurrent callers. Without this, a
// burst of messages after an idle period all see an expired token and refresh
// in parallel — and since refresh ROTATES the refresh token, the losers would
// present an already-consumed one and get logged out.
let refreshing: Promise<db.BitrixTokens> | null = null;

async function refreshTokens(current: db.BitrixTokens): Promise<db.BitrixTokens> {
  const url = new URL(OAUTH_URL);
  url.searchParams.set("grant_type", "refresh_token");
  url.searchParams.set("client_id", config.BITRIX_CLIENT_ID!);
  url.searchParams.set("client_secret", config.BITRIX_CLIENT_SECRET!);
  url.searchParams.set("refresh_token", current.refresh_token);

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    member_id?: string;
    domain?: string;
    client_endpoint?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!json || json.error || !json.access_token || !json.refresh_token) {
    throw new BitrixAppError(
      "oauth/refresh",
      json?.error ?? String(res.status),
      json?.error_description ?? "refresh failed — the app may need reinstalling",
    );
  }

  // 🔴 The refresh response's `domain` is the OAUTH SERVER ("oauth.bitrix.info"),
  // NOT the portal — trusting it overwrites a working host and every REST call
  // then goes to Bitrix's auth server (measured 2026-08-03). The portal lives in
  // `client_endpoint` ("https://<portal>/rest/"); keep the stored host otherwise.
  const portal = json.client_endpoint
    ? new URL(json.client_endpoint).host
    : current.domain;

  await db.saveBitrixTokens({
    member_id: json.member_id ?? current.member_id,
    domain: portal,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
  });
  const fresh = await db.getBitrixTokens();
  if (!fresh) throw new BitrixAppError("oauth/refresh", "persist", "tokens vanished");
  return fresh;
}

/** Current tokens, refreshed if they are expired or close to it. */
export async function validTokens(): Promise<db.BitrixTokens> {
  const current = await db.getBitrixTokens();
  if (!current) {
    throw new BitrixAppError("tokens", "not_installed", "app has not been installed yet");
  }
  const expiresAt = new Date(current.expires_at).getTime();
  if (expiresAt - Date.now() > REFRESH_SKEW_MS) return current;

  refreshing ??= refreshTokens(current).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * One authenticated REST call against the installed portal.
 *
 * Retries ONCE on `expired_token`: our stored expiry can be wrong (clock skew,
 * or the token revoked early), and the only reliable signal is Bitrix rejecting
 * it. Any other error is surfaced — retrying an `insufficient_scope` forever
 * would just hammer the portal.
 */
export async function call<T>(method: string, params: unknown = {}): Promise<T> {
  if (!enabled()) {
    throw new BitrixAppError(method, "disabled", "BITRIX_CLIENT_ID/SECRET unset");
  }
  let tokens = await validTokens();

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://${tokens.domain}/rest/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(params as object), auth: tokens.access_token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as {
      result?: T;
      error?: string;
      error_description?: string;
    } | null;

    if (!json) throw new BitrixAppError(method, String(res.status), "non-JSON response");
    if (!json.error) return json.result as T;

    if (json.error === "expired_token" && attempt === 0) {
      tokens = await refreshTokens(tokens);
      continue;
    }
    throw new BitrixAppError(method, json.error, json.error_description ?? "");
  }
  throw new BitrixAppError(method, "unreachable", "retry loop exhausted");
}
