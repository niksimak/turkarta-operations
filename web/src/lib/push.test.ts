import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disablePush, enablePush, syncPush, urlBase64ToUint8Array, type PushEnv } from "./push";
import { resetApiStateForTests } from "./api";
import { jsonResponse } from "../test/fakes";

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BKey", auth: "auth1" } };

function fakeEnv(over: { permission?: NotificationPermission; subscribed?: boolean; ua?: string; standalone?: boolean; supported?: boolean } = {}) {
  let current = over.subscribed ? { ...SUB } : null;
  const subscription = () => ({
    endpoint: SUB.endpoint,
    toJSON: () => ({ ...SUB }),
    unsubscribe: vi.fn(async () => { current = null; return true; }),
  });
  const pushManager = {
    getSubscription: vi.fn(async () => (current ? subscription() : null)),
    subscribe: vi.fn(async () => { current = { ...SUB }; return subscription(); }),
  };
  const permission = { value: over.permission ?? "default" };
  const env: PushEnv = {
    supported: over.supported ?? true,
    ua: over.ua ?? "Mozilla/5.0 (Macintosh) Chrome/130",
    standalone: over.standalone ?? false,
    ready: async () => ({ pushManager }) as unknown as ServiceWorkerRegistration,
    permission: () => permission.value as NotificationPermission,
    requestPermission: vi.fn(async () => {
      if (permission.value === "default") permission.value = "granted";
      return permission.value as NotificationPermission;
    }),
  };
  return { env, pushManager, permission };
}

function mockApi(key: number | string = "BPubKey") {
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body as string | undefined });
    if (url === "/crm/api/push/key") return typeof key === "number" ? jsonResponse(key, { error: "not_found" }) : jsonResponse(200, { publicKey: key });
    return jsonResponse(200, { ok: true });
  }));
  return calls;
}

describe("push", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => vi.unstubAllGlobals());

  it("decodes the VAPID key from base64url", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID_-8"))).toEqual([1, 2, 3, 255, 239]);
  });

  it("reports why push is unavailable", async () => {
    mockApi();
    expect(await syncPush(fakeEnv({ supported: false }).env)).toBe("unsupported");
    expect(await syncPush(fakeEnv({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)", supported: false }).env)).toBe("ios_install");
    expect(await syncPush(fakeEnv({ permission: "denied" }).env)).toBe("denied");
    mockApi(404);
    expect(await syncPush(fakeEnv().env)).toBe("disabled_server");
  });

  it("an installed iPhone app with push support is treated like any browser", async () => {
    mockApi();
    const { env } = fakeEnv({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)", standalone: true });
    expect(await syncPush(env)).toBe("off");
  });

  it("enable asks permission, subscribes with the server key and registers it", async () => {
    const calls = mockApi();
    const { env, pushManager } = fakeEnv();
    expect(await syncPush(env)).toBe("off");
    expect(await enablePush(env)).toBe("on");
    expect(env.requestPermission).toHaveBeenCalledTimes(1);
    const opts = (pushManager.subscribe.mock.calls as unknown as Array<[PushSubscriptionOptionsInit]>)[0]![0];
    expect(opts.userVisibleOnly).toBe(true);
    expect(opts.applicationServerKey).toBeInstanceOf(Uint8Array);
    const sub = calls.find((c) => c.url === "/crm/api/push/subscribe")!;
    expect(JSON.parse(sub.body!)).toEqual(SUB);
  });

  it("enable stops at a refused permission", async () => {
    const calls = mockApi();
    const { env, pushManager, permission } = fakeEnv();
    env.requestPermission = vi.fn(async () => { permission.value = "denied"; return "denied" as NotificationPermission; });
    expect(await enablePush(env)).toBe("denied");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "/crm/api/push/subscribe")).toBe(false);
  });

  it("an existing browser subscription is re-sent on load, so the server always knows this device", async () => {
    const calls = mockApi();
    expect(await syncPush(fakeEnv({ permission: "granted", subscribed: true }).env)).toBe("on");
    expect(calls.filter((c) => c.url === "/crm/api/push/subscribe")).toHaveLength(1);
  });

  it("disable removes it on the server and in the browser", async () => {
    const calls = mockApi();
    const { env, pushManager } = fakeEnv({ permission: "granted", subscribed: true });
    expect(await disablePush(env)).toBe("off");
    expect(JSON.parse(calls.find((c) => c.url === "/crm/api/push/unsubscribe")!.body!)).toEqual({ endpoint: SUB.endpoint });
    expect(await pushManager.getSubscription()).toBeNull();
  });
});
