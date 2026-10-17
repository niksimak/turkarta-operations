import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// public/sw.js is plain JS served as-is; run it against a fake service-worker global.
// vitest runs from web/ (jsdom gives import.meta.url an http scheme).
const SOURCE = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(windows: Array<Record<string, unknown>> = []) {
  const listeners = new Map<string, Listener>();
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => {}) },
  };
  new Function("self", SOURCE)(self);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  return { self, fire };
}

const pushEvent = (msg: unknown) => ({ data: { json: () => msg } });
const MSG = { title: "Новое обращение", body: "Иван: Не пришёл код", url: "https://support.turkarta.me/crm/t/t-1", tag: "crm-new_ticket-t-1" };

describe("sw.js", () => {
  it("shows the push with its link when no CRM tab is focused", async () => {
    const { self, fire } = loadWorker([{ focused: false, visibilityState: "hidden", url: "https://support.turkarta.me/crm/" }]);
    await fire("push", pushEvent(MSG));
    expect(self.registration.showNotification).toHaveBeenCalledWith("Новое обращение", expect.objectContaining({
      body: "Иван: Не пришёл код", tag: "crm-new_ticket-t-1", data: { url: MSG.url },
    }));
  });

  // Every push must show a notification: Chrome otherwise shows its own generic one, and iOS
  // revokes the subscription after a few silent pushes.
  it("always notifies: silently while a CRM tab is focused, generically on a malformed push", async () => {
    const focused = loadWorker([{ focused: true, visibilityState: "visible", url: "https://support.turkarta.me/crm/" }]);
    await focused.fire("push", pushEvent(MSG));
    expect(focused.self.registration.showNotification).toHaveBeenCalledWith("Новое обращение", expect.objectContaining({ silent: true }));
    const bad = loadWorker();
    await bad.fire("push", { data: { json: () => { throw new Error("not json"); } } });
    await bad.fire("push", pushEvent({ body: "no title" }));
    expect(bad.self.registration.showNotification).toHaveBeenCalledTimes(2);
    expect(bad.self.registration.showNotification).toHaveBeenCalledWith("Поддержка", expect.objectContaining({ silent: false }));
  });

  it("a tap focuses the open CRM tab and opens the ticket there, else opens a window", async () => {
    const tab = { url: "https://support.turkarta.me/crm/", focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
    const withTab = loadWorker([tab]);
    const notification = { close: vi.fn(), data: { url: MSG.url } };
    await withTab.fire("notificationclick", { notification });
    expect(notification.close).toHaveBeenCalled();
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith(MSG.url);
    expect(withTab.self.clients.openWindow).not.toHaveBeenCalled();

    const none = loadWorker([]);
    await none.fire("notificationclick", { notification: { close: vi.fn(), data: { url: MSG.url } } });
    expect(none.self.clients.openWindow).toHaveBeenCalledWith(MSG.url);
  });
});
