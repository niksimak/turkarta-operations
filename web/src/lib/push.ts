import { api, ApiError, json } from "./api";

/**
 * Web Push on this device (src/crm/push.ts sends, public/sw.js shows). The subscription lives in the
 * browser; the server keeps a copy per operator, re-sent on every load so a pruned or re-bound row heals.
 */
export type PushState = "unsupported" | "ios_install" | "disabled_server" | "denied" | "off" | "on";

export interface PushEnv {
  supported: boolean;
  ua: string;
  /** Opened from the Home Screen (installed PWA). */
  standalone: boolean;
  ready: () => Promise<ServiceWorkerRegistration>;
  permission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
}

const SW_URL = "/crm/sw.js";
const SW_SCOPE = "/crm/";

export function browserPushEnv(): PushEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const supported =
    Boolean(nav && "serviceWorker" in nav) && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
  return {
    supported,
    ua: nav?.userAgent ?? "",
    standalone:
      (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches) ||
      (nav as Navigator & { standalone?: boolean } | undefined)?.standalone === true,
    ready: () => navigator.serviceWorker.ready,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
  };
}

const isIos = (ua: string) => /iPhone|iPad|iPod/.test(ua);

/** VAPID public keys travel as base64url; PushManager wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

async function serverKey(): Promise<string | null> {
  try {
    return (await api<{ publicKey: string }>("/push/key")).publicKey;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

async function register(sub: PushSubscription): Promise<void> {
  const { endpoint, keys } = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api("/push/subscribe", json("POST", { endpoint, keys }));
}

/** Where push stands on this device; an existing subscription is re-registered with the server. */
export async function syncPush(env: PushEnv = browserPushEnv()): Promise<PushState> {
  // iPhone Safari offers push only to an app added to the Home Screen.
  if (!env.supported) return isIos(env.ua) && !env.standalone ? "ios_install" : "unsupported";
  if (!(await serverKey())) return "disabled_server";
  if (env.permission() === "denied") return "denied";
  const sub = await (await env.ready()).pushManager.getSubscription();
  if (!sub || env.permission() !== "granted") return "off";
  await register(sub);
  return "on";
}

export async function enablePush(env: PushEnv = browserPushEnv()): Promise<PushState> {
  const key = await serverKey();
  if (!key) return "disabled_server";
  if ((await env.requestPermission()) !== "granted") return "denied";
  const pm = (await env.ready()).pushManager;
  const sub =
    (await pm.getSubscription()) ??
    (await pm.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
  await register(sub);
  return "on";
}

export async function disablePush(env: PushEnv = browserPushEnv()): Promise<PushState> {
  const sub = await (await env.ready()).pushManager.getSubscription();
  if (sub) {
    await api("/push/unsubscribe", json("POST", { endpoint: sub.endpoint }));
    await sub.unsubscribe();
  }
  return "off";
}

/** Installs the service worker that shows pushes. Production only: the Vite dev server has no /crm/sw.js. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch(() => {
    // Push stays off on this device; the in-tab notifications still work.
  });
}
