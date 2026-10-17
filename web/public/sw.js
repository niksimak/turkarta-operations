// Service worker for the CRM PWA: shows Web Push sent by src/crm/push.ts.
// Plain JS, served as-is from /crm/sw.js (scope /crm/), never cached (routes.ts).

const ICON = "/crm/icons/icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let msg;
    try {
      msg = event.data ? event.data.json() : null;
    } catch {
      msg = null;
    }
    if (!msg || !msg.title) return;
    // A focused CRM tab already blips and toasts this event in-app: do not notify twice.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((w) => w.focused && w.visibilityState === "visible")) return;
    await self.registration.showNotification(msg.title, {
      body: msg.body || "",
      tag: msg.tag,
      icon: ICON,
      badge: ICON,
      data: { url: msg.url || "/crm/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/crm/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const crm = windows.find((w) => new URL(w.url).pathname.startsWith("/crm"));
    if (crm) {
      await crm.focus();
      if ("navigate" in crm) await crm.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
