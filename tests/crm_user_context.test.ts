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

test("keeps the CSB email and card product_id, and parses a payload without them", async () => {
  clearUserContextCache();
  const card = { last4: "1234", status: "active", plan: "travel", balance_usd: "1.00" };
  const topup = { amount_rub: "3000", amount_usd: "31.19", status: "funded", created_at: "2026-10-17T10:12:00Z" };
  const { f } = fakeFetch(200, {
    found: true, csb_email: "a@cards.turkarta.me", antarctic_user_id: "ant-7", cards: [{ ...card, product_id: "p-ecom" }],
    recent_topups: [{ ...topup, rail: "antarctic", antarctic: { order_id: "o-1", payment_uuid: null } }],
  });
  const a = await userContext(tg, { fetch: f, now: () => 1, api });
  assert.equal(a?.csb_email, "a@cards.turkarta.me");
  assert.equal(a?.cards?.[0]?.product_id, "p-ecom");
  assert.equal(a?.antarctic_user_id, "ant-7");
  assert.equal(a?.recent_topups?.[0]?.rail, "antarctic");
  assert.deepEqual(a?.recent_topups?.[0]?.antarctic, { order_id: "o-1", payment_uuid: null });
  clearUserContextCache();
  const old = await userContext(tg, { fetch: fakeFetch(200, { found: true, cards: [card] }).f, now: () => 1, api });
  assert.equal(old?.found, true);
  assert.equal(old?.csb_email, undefined);
  assert.equal(old?.cards?.[0]?.product_id, undefined);
});

test("500, invalid JSON and bad shape return null, cached for 30 s only", async () => {
  for (const [status, body] of [[500, {}], [200, "not json"], [200, { found: "yes" }]] as const) {
    clearUserContextCache();
    const { f, calls } = fakeFetch(status, body);
    let t = 1000;
    const deps = { fetch: f, now: () => t, api };
    assert.equal(await userContext(tg, deps), null);
    t += 29_000;
    assert.equal(await userContext(tg, deps), null);
    assert.equal(calls.length, 1);
    t += 2_000;
    assert.equal(await userContext(tg, deps), null);
    assert.equal(calls.length, 2);
  }
});

test("a timeout returns null and is not retried on every refetch", async () => {
  clearUserContextCache();
  let calls = 0;
  const f = (async () => { calls++; throw new DOMException("t", "TimeoutError"); }) as unknown as typeof fetch;
  let t = 1000;
  const deps = { fetch: f, now: () => t, api };
  assert.equal(await userContext(tg, deps), null);
  t += 5_000;
  assert.equal(await userContext(tg, deps), null);
  assert.equal(calls, 1);
  t += 26_000;
  await userContext(tg, deps);
  assert.equal(calls, 2);
});

test("after a failure clears, a good answer is cached for the full 60 s", async () => {
  clearUserContextCache();
  let t = 1000;
  const bad = fakeFetch(500, {});
  assert.equal(await userContext(tg, { fetch: bad.f, now: () => t, api }), null);
  t += 31_000;
  const good = fakeFetch(200, { found: true });
  assert.equal((await userContext(tg, { fetch: good.f, now: () => t, api }))?.found, true);
  t += 59_000;
  await userContext(tg, { fetch: good.f, now: () => t, api });
  assert.equal(good.calls.length, 1);
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
