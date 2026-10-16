export const LOGIN_FAILED_SESSION = "/crm/login-failed?reason=session";

/** Paths the Turkarta SSO issuer accepts as `next`; anything else is dropped. */
export const NEXT_PATH_RE = /^\/crm(\/[\w-]+)*\/?$/;

/** Login-failed URL that remembers where the operator was, so a re-login lands there (TG alert links). */
export function loginFailedUrl(reason: string, from?: string): string {
  const url = `/crm/login-failed?reason=${encodeURIComponent(reason)}`;
  return from && NEXT_PATH_RE.test(from) && !from.startsWith("/crm/login-failed") ? `${url}&next=${encodeURIComponent(from)}` : url;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`CRM API ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// Several queries can 401 at once when the session ends; only the first one
// navigates, so the browser never queues a chain of redirects.
let redirecting = false;

/** Leave the SPA for a full page load; later 401s from in-flight calls stay quiet. */
export function leaveTo(url: string): void {
  if (redirecting) return;
  redirecting = true;
  window.location.assign(url);
}

export function resetApiStateForTests(): void {
  redirecting = false;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-CRM", "1");
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/crm/api${path}`, { ...init, headers, credentials: "same-origin" });
  const body = await readBody(res);
  if (res.status === 401) {
    leaveTo(loginFailedUrl("session", window.location.pathname));
    throw new ApiError(401, body);
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** RequestInit for a JSON body: `api("/me/shift", json("POST", { on: true }))`. */
export function json(method: "POST" | "PUT" | "PATCH" | "DELETE", data?: unknown): RequestInit {
  return data === undefined ? { method } : { method, body: JSON.stringify(data) };
}

/** Client errors will not fix themselves on retry; server and network errors might. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}
