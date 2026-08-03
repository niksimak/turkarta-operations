/**
 * The ONE module that calls the turkarta API (the reverse of its
 * `services/ops_support.py` boundary — same shared secret, opposite direction).
 *
 * Best-effort by contract: a callback tells the app "an operator answered, go
 * notify the user" (bell + Web Push). The chat's own message log stays the
 * source of truth via polling, so a missed callback loses one push, never a
 * message. Nothing here may throw into a reply path.
 */
import { config } from "./config.js";

const TIMEOUT_MS = 20_000; // the API runs on a warm starter instance

export async function notifySupportReply(input: {
  web_user_id: string;
  ticket_id: string;
  message_id: string;
  preview: string;
}): Promise<void> {
  const base = config.TURKARTA_API_URL;
  const secret = config.TURKARTA_API_SECRET ?? config.APP_WEBHOOK_SECRET ?? config.LEADS_WEBHOOK_SECRET;
  if (!base || !secret) return; // callback not configured — feature dark
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/webhooks/ops/support-reply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify({ ...input, preview: input.preview.slice(0, 500) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[turkarta-api] support-reply callback HTTP ${res.status}`);
  } catch (err) {
    console.warn(
      "[turkarta-api] support-reply callback failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
