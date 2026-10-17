/**
 * Web Push for operators (the CRM as an installed PWA).
 *
 * The same `notify` events that drive the in-tab blip, toast and desktop notification fan out
 * here to every browser an operator subscribed (crm_push_subscriptions). Targets mirror the web
 * `shouldNotify` rule: a personal event (assigned, mention, client replied, reply reminder) goes to
 * that operator; a broadcast (operatorId null) goes to operators watching «Все». The service worker
 * (web/public/sw.js) always shows it (iOS revokes subscriptions that push silently), but silently
 * while a CRM tab is focused, which already blips and toasts in-app.
 *
 * Dark until CRM_VAPID_PUBLIC_KEY / CRM_VAPID_PRIVATE_KEY are set. Sends are fire-and-forget with
 * a per-send timeout; a 404/410 from the push service means the browser dropped the subscription,
 * so the row is deleted. Endpoints and keys are never logged.
 */
import webpush from "web-push";
import { config } from "../config.js";
import { sql } from "../db.js";
import { subscribe, type CrmEvent } from "./events.js";

type NotifyEvent = Extract<CrmEvent, { type: "notify" }>;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSender = (sub: PushSubscriptionInput, payload: string) => Promise<void>;

const TTL_SECONDS = 3600;
const SEND_TIMEOUT_MS = 10_000;
const GONE = new Set([404, 410]);

const code = (err: unknown) => {
  const e = err as { statusCode?: number; code?: string };
  return e.statusCode ?? e.code ?? "error";
};

export function pushPublicKey(): string | null {
  return config.CRM_VAPID_PUBLIC_KEY && config.CRM_VAPID_PRIVATE_KEY ? config.CRM_VAPID_PUBLIC_KEY : null;
}

/** Same endpoint again (a re-subscribe, or another operator on a shared device) re-binds the row. */
export async function saveSubscription(operatorId: number, s: PushSubscriptionInput, userAgent: string | null): Promise<void> {
  await sql`insert into crm_push_subscriptions (operator_id, endpoint, p256dh, auth, user_agent)
    values (${operatorId}, ${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth}, ${userAgent})
    on conflict (endpoint) do update set operator_id = excluded.operator_id, p256dh = excluded.p256dh,
      auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`;
}

export async function deleteSubscription(operatorId: number, endpoint: string): Promise<boolean> {
  const rows = await sql`delete from crm_push_subscriptions where endpoint = ${endpoint} and operator_id = ${operatorId}`;
  return rows.count > 0;
}

export async function pushTargets(e: NotifyEvent): Promise<StoredSubscription[]> {
  return e.operatorId !== null
    ? sql<StoredSubscription[]>`select id::text, endpoint, p256dh, auth from crm_push_subscriptions
        where operator_id = ${e.operatorId}`
    : sql<StoredSubscription[]>`select s.id::text, s.endpoint, s.p256dh, s.auth from crm_push_subscriptions s
        join crm_operators o on o.id = s.operator_id
        where coalesce(o.prefs->>'notify_scope', 'all') = 'all'`;
}

function payload(e: NotifyEvent): string {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return JSON.stringify({
    title: e.title, body: e.body, url: `${base}/crm/t/${encodeURIComponent(e.ticketId)}`,
    tag: `crm-${e.kind}-${e.ticketId}`, kind: e.kind,
  });
}

function vapidSender(): PushSender {
  const vapidDetails = {
    subject: config.PUBLIC_BASE_URL, publicKey: config.CRM_VAPID_PUBLIC_KEY!, privateKey: config.CRM_VAPID_PRIVATE_KEY!,
  };
  return async (sub, body) => {
    await webpush.sendNotification(sub, body, { TTL: TTL_SECONDS, urgency: "high", timeout: SEND_TIMEOUT_MS, vapidDetails });
  };
}

export async function deliverPush(e: NotifyEvent, send: PushSender): Promise<{ sent: number; pruned: number; failed: number }> {
  const subs = await pushTargets(e);
  const body = payload(e);
  const result = { sent: 0, pruned: 0, failed: 0 };
  await Promise.all(subs.map(async (s) => {
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      await sql`update crm_push_subscriptions set last_ok_at = now(), failures = 0 where id = ${s.id}`;
      result.sent++;
    } catch (err) {
      if (GONE.has((err as { statusCode?: number }).statusCode ?? 0)) {
        await sql`delete from crm_push_subscriptions where id = ${s.id}`;
        result.pruned++;
      } else {
        await sql`update crm_push_subscriptions set failures = failures + 1 where id = ${s.id}`;
        console.warn(`[crm-push] send failed sub=${s.id} code=${code(err)}`);
        result.failed++;
      }
    }
  }));
  return result;
}

/** Pushes every notify event; a no-op until VAPID is configured. Returns the unsubscribe. */
export function startPushFanout(send?: PushSender): () => void {
  if (!send && !pushPublicKey()) return () => {};
  const sender = send ?? vapidSender();
  return subscribe((e) => {
    if (e.type !== "notify") return;
    deliverPush(e, sender).catch((err) => console.error(`[crm-push] fan-out failed code=${code(err)}`));
  });
}
