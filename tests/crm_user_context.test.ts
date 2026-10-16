import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});
const { userContext, clearUserContextCache } = await import("../dist/crm/user_context.js");

const api = { base: "https://api.example", secret: "s3" };
const tg = { user_tg: 42, web_user_id: null };

function fakeFetch(status = 200, body: unknown = { found: false }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("caches within 60 s and refetches after", async () => {
  clearUserContextCache();
  const { f, calls } = fakeFetch(200, { found: true, user_id: "u1", extra: "x", cards: [] });
  let t = 1000;
  const deps = { fetch: f, now: () => t, api };
  const a = await userContext(tg, deps);
  assert.equal(a?.found, true);
  assert.equal((a as Record<string, unknown>).extra, undefined);
  t += 59_000;
  await userContext(tg, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/webhooks/ops/support/user-context");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-webhook-secret"], "s3");
  assert.equal(calls[0].init.body, JSON.stringify({ tg_id: 42, user_id: null }));
  t += 2_000;
  await userContext(tg, deps);
  assert.equal(calls.length, 2);
});

test("500 and invalid JSON and bad shape return null and are not cached", async () => {
  clearUserContextCache();
  for (const [status, body] of [[500, {}], [200, "not json"], [200, { found: "yes" }]] as const) {
    const { f, calls } = fakeFetch(status, body);
    assert.equal(await userContext(tg, { fetch: f, api }), null);
    assert.equal(await userContext(tg, { fetch: f, api }), null);
    assert.equal(calls.length, 2);
  }
});

test("fetch rejection returns null", async () => {
  clearUserContextCache();
  const f = (async () => { throw new DOMException("t", "TimeoutError"); }) as unknown as typeof fetch;
  assert.equal(await userContext(tg, { fetch: f, api }), null);
});

test("unconfigured or no identity returns null without fetching", async () => {
  clearUserContextCache();
  const { f, calls } = fakeFetch();
  assert.equal(await userContext(tg, { fetch: f, api: null }), null);
  assert.equal(await userContext({ user_tg: null, web_user_id: null }, { fetch: f, api }), null);
  assert.equal(calls.length, 0);
});

test("web key is separate and evicts oldest beyond 500", async () => {
  clearUserContextCache();
  const { f, calls } = fakeFetch();
  const deps = { fetch: f, now: () => 1, api };
  for (let i = 0; i < 501; i++) await userContext({ user_tg: i + 1, web_user_id: null }, deps);
  assert.equal(calls.length, 501);
  await userContext({ user_tg: 501, web_user_id: null }, deps);
  assert.equal(calls.length, 501);
  await userContext({ user_tg: 1, web_user_id: null }, deps);
  assert.equal(calls.length, 502);
  await userContext({ user_tg: null, web_user_id: "w" }, deps);
  assert.equal(calls.length, 503);
});
