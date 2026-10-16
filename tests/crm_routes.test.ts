import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

// Router tests: real auth middleware and router, stores replaced by module mocks.
// Never load .env or touch a real database or Telegram.
const SSO_SECRET = "s".repeat(40);
Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret",
  ROSTER: "[]", CRM_SSO_SECRET: SSO_SECRET,
});

type Op = { id: number; name: string; role: "admin" | "support"; is_lead: boolean };
const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" };
const opRow = (o: Op) => ({
  ...o, email: null, auto_assign_enabled: true, on_shift: true, last_active_at: null, last_assigned_at: null, prefs,
});
const sessions = new Map<string, Op>([
  ["tok-support", { id: 1, name: "Anna", role: "support", is_lead: false }],
  ["tok-lead", { id: 2, name: "Lena", role: "support", is_lead: true }],
  ["tok-admin", { id: 3, name: "Admin", role: "admin", is_lead: false }],
]);
const byHash = new Map([...sessions].map(([tok, op]) => [createHash("sha256").update(tok).digest("hex"), op]));
const queries: string[] = [];

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const q = strings.join("?");
  queries.push(q);
  if (q.includes("from crm_sessions")) {
    const op = byHash.get(values[0] as string);
    return Promise.resolve(op ? [opRow(op)] : []);
  }
  return Promise.resolve([]);
}
fakeSql.notify = async () => {};
mock.module("../dist/db.js", { namedExports: { sql: fakeSql } });

class Conflict extends Error {
  constructor(readonly code: string, readonly assignee?: { id: number; name: string }) { super(code); this.name = "Conflict"; }
}
class Forbidden extends Error { constructor(m = "forbidden") { super(m); this.name = "Forbidden"; } }
class NotFound extends Error { constructor(m = "not_found") { super(m); this.name = "NotFound"; } }
class BadCursor extends Error { constructor() { super("bad_cursor"); this.name = "BadCursor"; } }
class InvalidReply extends Error { constructor(readonly code: string) { super(code); this.name = "InvalidReply"; } }

const TICKET = "11111111-1111-1111-1111-111111111111";
const calls: Array<{ fn: string; args: unknown[] }> = [];
const record = (fn: string, ...args: unknown[]) => { calls.push({ fn, args }); };
const callsOf = (fn: string) => calls.filter((c) => c.fn === fn);

mock.module("../dist/crm/tickets.js", { namedExports: {
  Conflict, Forbidden, NotFound, BadCursor,
  listTickets: async (...a: unknown[]) => {
    record("listTickets", ...a);
    if ((a[1] as { cursor?: string }).cursor === "bad") throw new BadCursor();
    return { items: [], nextCursor: null, counts: { queue: 0, mine: 0, overdue: 0 } };
  },
  ticketDetail: async (id: string) => (id === TICKET
    ? { ticket: { id, user_tg: 42, web_user_id: null }, messages: [], events: [] }
    : null),
  ticketItem: async (id: string) => ({ id }),
  take: async (id: string, me: Op) => {
    record("take", id, me.id);
    throw new Conflict("assigned_to_other", { id: 9, name: "Boris" });
  },
  takeOver: async () => {},
  assign: async () => { throw new NotFound("operator_not_found"); },
  setStatus: async (...a: unknown[]) => { record("setStatus", ...a); },
} });
mock.module("../dist/crm/reply.js", { namedExports: {
  InvalidReply,
  sendReply: async (id: string, me: Op, input: { kind: string; body: string; photos: Array<{ filename: string }> }) => {
    record("sendReply", id, me.id, input);
    return { id: "m1", kind: input.kind };
  },
  retryDelivery: async () => ({ id: "m1" }),
} });
mock.module("../dist/crm/settings.js", { namedExports: {
  getSettings: async () => ({ sla_first_minutes: 5 }),
  updateSettings: async (patch: unknown, opId: number) => {
    record("updateSettings", patch, opId);
    return { ok: true, settings: { sla_first_minutes: 7 } };
  },
  settingsLog: async () => [],
} });
mock.module("../dist/crm/stats.js", { namedExports: {
  stats: async (...a: unknown[]) => { record("stats", ...a); return { team: {}, operators: [] }; },
} });
mock.module("../dist/crm/attachments.js", { namedExports: {
  attachmentResponse: async () => new Response("x", { headers: { "content-type": "image/jpeg" } }),
} });
mock.module("../dist/crm/user_context.js", { namedExports: {
  userContext: async (t: { user_tg: number | null }) => ({ found: true, tg_id: t.user_tg }),
} });

type Listener = (e: { type: string; operatorId?: number | null; ticketId?: string }) => void;
const listeners = new Set<Listener>();
mock.module("../dist/crm/events.js", { namedExports: {
  subscribe: (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  publish: async (e: unknown) => { record("publish", e); },
  presence: {
    set: (...a: unknown[]) => { record("presence.set", ...a); },
    list: () => [{ operatorId: 2, name: "Lena", state: "viewing" }],
  },
} });

const { crmRoutes } = await import("../dist/crm/routes.js");
const { Hono } = await import("hono");

const webRoot = mkdtempSync(join(tmpdir(), "crm-web-"));
mkdirSync(join(webRoot, "assets"));
writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>CRM</title>");
writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");

const app = new Hono().route("/crm", crmRoutes({ webRoot }));
const H = (token?: string, crm = true): Record<string, string> => ({
  ...(token ? { cookie: `crm_session=${token}` } : {}),
  ...(crm ? { "X-CRM": "1" } : {}),
});
const req = (path: string, init: RequestInit = {}) => app.request(path, init);
const json = (method: string, token: string, body: unknown): RequestInit => ({
  method, headers: { ...H(token), "content-type": "application/json" }, body: JSON.stringify(body),
});

test("API requires session cookie plus X-CRM header", async () => {
  assert.equal((await req("/crm/api/me")).status, 401);
  assert.equal((await req("/crm/api/me", { headers: H("tok-support", false) })).status, 401);
  assert.equal((await req("/crm/api/me", { headers: H("tok-unknown") })).status, 401);
  const ok = await req("/crm/api/me", { headers: H("tok-support") });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).id, 1);
});

test("Conflict maps to 409 with code and assignee", async () => {
  const res = await req(`/crm/api/tickets/${TICKET}/take`, { method: "POST", headers: H("tok-support") });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "assigned_to_other", assignee: { id: 9, name: "Boris" } });
});

test("NotFound, BadCursor and validation errors map to 404, 400, 422", async () => {
  assert.equal((await req(`/crm/api/tickets/${TICKET}/assign`, json("POST", "tok-admin", { operator_id: 99 }))).status, 404);
  assert.equal((await req("/crm/api/tickets/22222222-2222-2222-2222-222222222222", { headers: H("tok-support") })).status, 404);
  assert.equal((await req("/crm/api/tickets?cursor=bad", { headers: H("tok-support") })).status, 400);
  const bad = await req(`/crm/api/tickets/${TICKET}/status`, json("POST", "tok-support", { status: "bogus" }));
  assert.equal(bad.status, 422);
  const body = await bad.json();
  assert.equal(body.error, "validation");
  assert.ok(body.fields.status);
  const notJson = await req(`/crm/api/tickets/${TICKET}/status`, {
    method: "POST", headers: { ...H("tok-support"), "content-type": "application/json" }, body: "{",
  });
  assert.equal(notJson.status, 422);
  assert.equal(callsOf("setStatus").length, 0);
});

test("ticket list parses filters; detail carries user context and viewers", async () => {
  const list = await req("/crm/api/tickets?view=mine&status=awaiting&channel=web&operator=3&overdue=1&q=ivan&limit=5",
    { headers: H("tok-support") });
  assert.equal(list.status, 200);
  const q = callsOf("listTickets").at(-1)!.args[1];
  assert.deepEqual(q, { view: "mine", status: "awaiting", channel: "web", operatorId: 3, overdue: true, q: "ivan", limit: 5 });
  const d = await (await req(`/crm/api/tickets/${TICKET}`, { headers: H("tok-support") })).json();
  assert.deepEqual(d.user, { found: true, tg_id: 42 });
  assert.deepEqual(d.viewers, [{ operatorId: 2, name: "Lena", state: "viewing" }]);
  assert.equal(d.ticket.id, TICKET);
});

const jpeg = (n: number) => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n])], `p${n}.jpg`, { type: "image/jpeg" });

test("multipart reply: 11 photos rejected before sending", async () => {
  const fd = new FormData();
  fd.set("body", "hi");
  for (let i = 0; i < 11; i++) fd.append("photos", jpeg(i));
  const before = callsOf("sendReply").length;
  const res = await req(`/crm/api/tickets/${TICKET}/messages`, { method: "POST", headers: H("tok-support"), body: fd });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, "too_many_photos");
  assert.equal(callsOf("sendReply").length, before);
});

test("multipart reply: an invalid photo reports its index", async () => {
  const fd = new FormData();
  fd.append("photos", jpeg(1));
  fd.append("photos", new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" }));
  const res = await req(`/crm/api/tickets/${TICKET}/messages`, { method: "POST", headers: H("tok-support"), body: fd });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "photo_invalid", index: 1 });
});

test("multipart reply with one photo and JSON note reach sendReply", async () => {
  const fd = new FormData();
  fd.set("body", " привет ");
  fd.set("photos", jpeg(7));
  const res = await req(`/crm/api/tickets/${TICKET}/messages`, { method: "POST", headers: H("tok-support"), body: fd });
  assert.equal(res.status, 200);
  const input = callsOf("sendReply").at(-1)!.args[2] as { kind: string; body: string; photos: Array<{ mediaType: string; filename: string }> };
  assert.equal(input.kind, "reply");
  assert.equal(input.body, " привет ");
  assert.deepEqual(input.photos.map((p) => [p.mediaType, p.filename]), [["image/jpeg", "p7.jpg"]]);

  const note = await req(`/crm/api/tickets/${TICKET}/messages`, json("POST", "tok-support", { kind: "note", body: "@Lena глянь" }));
  assert.equal(note.status, 200);
  const n = callsOf("sendReply").at(-1)!.args[2] as { kind: string; photos: unknown[] };
  assert.equal(n.kind, "note");
  assert.deepEqual(n.photos, []);
});

test("team settings: support 403, lead 200; log is lead-only", async () => {
  const denied = await req("/crm/api/settings", json("PUT", "tok-support", { sla_first_minutes: 7 }));
  assert.equal(denied.status, 403);
  assert.equal(callsOf("updateSettings").length, 0);
  const ok = await req("/crm/api/settings", json("PUT", "tok-lead", { sla_first_minutes: 7 }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { sla_first_minutes: 7 });
  assert.deepEqual(callsOf("updateSettings")[0]!.args, [{ sla_first_minutes: 7 }, 2]);
  assert.equal((await req("/crm/api/settings/log", { headers: H("tok-support") })).status, 403);
  assert.equal((await req("/crm/api/settings/log", { headers: H("tok-lead") })).status, 200);
  assert.equal((await req("/crm/api/settings", { headers: H("tok-support") })).status, 200);
});

test("is_lead is admin-only; flags need admin or lead", async () => {
  assert.equal((await req("/crm/api/operators/1", json("PUT", "tok-lead", { is_lead: true }))).status, 403);
  assert.equal((await req("/crm/api/operators/2", json("PUT", "tok-support", { auto_assign_enabled: false }))).status, 403);
  assert.equal((await req("/crm/api/operators/2", json("PUT", "tok-support", { on_shift: false }))).status, 403);
  assert.equal((await req("/crm/api/operators/2", json("PUT", "tok-admin", { bogus: 1 }))).status, 422);
});

test("presence and heartbeat answer 200, never 204", async () => {
  const p = await req(`/crm/api/tickets/${TICKET}/presence`, json("POST", "tok-support", { state: "typing" }));
  assert.equal(p.status, 200);
  assert.deepEqual(await p.json(), { ok: true });
  assert.deepEqual(callsOf("presence.set").at(-1)!.args, [TICKET, { id: 1, name: "Anna" }, "typing"]);
  assert.equal((await req("/crm/api/tickets/nope/presence", json("POST", "tok-support", { state: "typing" }))).status, 404);
  const hb = await req("/crm/api/me/heartbeat", { method: "POST", headers: H("tok-support") });
  assert.equal(hb.status, 200);
  assert.deepEqual(await hb.json(), { ok: true });
  assert.ok(queries.some((q) => q.includes("last_active_at = now()")));
});

test("stats: default range is 7 Moscow days; bad dates are 422", async () => {
  const res = await req("/crm/api/stats", { headers: H("tok-support") });
  assert.equal(res.status, 200);
  const range = callsOf("stats").at(-1)!.args[0] as { from: Date; to: Date };
  // Moscow midnight is 21:00 UTC.
  assert.equal(range.from.getUTCHours(), 21);
  assert.equal(range.from.getUTCMinutes(), 0);
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  assert.ok(days > 6 && days <= 7, `days=${days}`);
  assert.equal((await req("/crm/api/stats?from=yesterday", { headers: H("tok-support") })).status, 422);
  assert.equal((await req("/crm/api/stats?from=2026-10-10T00:00:00Z&to=2026-10-01T00:00:00Z", { headers: H("tok-support") })).status, 422);
  const explicit = await req("/crm/api/stats?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z", { headers: H("tok-support") });
  assert.equal(explicit.status, 200);
  assert.equal((callsOf("stats").at(-1)!.args[0] as { from: Date }).from.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("SSE: cookie only, own and broadcast notifies, unsubscribes on close", async () => {
  assert.equal((await req("/crm/api/stream")).status, 401);
  const res = await req("/crm/api/stream", { headers: H("tok-support", false) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  let cancelled = false;
  try {
    await readUntil("\n\n");
    assert.equal(listeners.size, 1);
    for (const fn of listeners) {
      fn({ type: "notify", operatorId: 2, ticketId: "for-lena" });
      fn({ type: "notify", operatorId: 1, ticketId: "for-anna" });
      fn({ type: "notify", operatorId: null, ticketId: "for-all" });
      fn({ type: "ticket.updated", ticketId: "t-upd" });
    }
    await readUntil("t-upd");
    assert.ok(text.includes('event: notify\ndata: {"type":"notify","operatorId":1,"ticketId":"for-anna"}\n\n'));
    assert.ok(text.includes("for-all"));
    assert.ok(text.includes("event: ticket.updated\n"));
    assert.ok(!text.includes("for-lena"));
    await reader.cancel();
    cancelled = true;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(listeners.size, 0);
  } finally {
    // An open stream keeps its ping timer alive and would hang the run on a failed assertion.
    if (!cancelled) await reader.cancel();
  }
});

test("SSO failure redirects with a reason and never logs the token", async () => {
  const logs: string[] = [];
  const restore = ["log", "warn", "error", "info"].map((k) => {
    const c = console as unknown as Record<string, (...a: unknown[]) => void>;
    const orig = c[k]!;
    c[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    return () => { c[k] = orig; };
  });
  try {
    const token = "eyJzdWIiOjF9.c2VjcmV0LXNpZw";
    const res = await req(`/crm/sso?t=${token}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/crm/login-failed?reason=signature");
    assert.equal(res.headers.get("set-cookie"), null);
    const missing = await req("/crm/sso");
    assert.equal(missing.headers.get("location"), "/crm/login-failed?reason=malformed");
    assert.ok(!logs.some((l) => l.includes(token) || l.includes("c2VjcmV0")), logs.join("\n"));
  } finally {
    restore.forEach((r) => r());
  }
});

test("logout deletes the session and clears the cookie", async () => {
  const res = await req("/crm/api/logout", { method: "POST", headers: H("tok-support") });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /crm_session=;.*Max-Age=0/);
  assert.ok(queries.some((q) => q.includes("delete from crm_sessions")));
});

test("static SPA: assets, deep links and login-failed; API paths stay JSON", async () => {
  const deep = await req("/crm/tickets/abc");
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /<title>CRM<\/title>/);
  assert.match(await (await req("/crm/login-failed?reason=expired")).text(), /<title>CRM/);
  assert.match(await (await req("/crm")).text(), /<title>CRM/);
  const asset = await req("/crm/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log(1)");
  const api404 = await req("/crm/api/nope", { headers: H("tok-support") });
  assert.equal(api404.status, 404);
  assert.doesNotMatch(await api404.text(), /<title>/);

  const bare = new Hono().route("/crm", crmRoutes({ webRoot: join(webRoot, "missing") }));
  assert.equal((await bare.request("/crm/tickets/abc")).status, 404);
});
