import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});
const { signSsoToken, verifySsoToken, requireOperator } = await import("../dist/crm/auth.js");
const { Hono } = await import("hono");

const SECRET = "s".repeat(32);
const NOW = 1_800_000_000;
const claims = { sub: 7, name: "Аня", email: null, role: "support" as const, jti: "j1", exp: NOW + 60 };

// Shared with turkarta's Python issuer tests: secret "x"*32, claims below, JSON key order as listed.
// {sub:7,name:"Аня",email:null,role:"support",jti:"j1",exp:2000000000}
export const SHARED_TEST_VECTOR =
  "eyJzdWIiOjcsIm5hbWUiOiLQkNC90Y8iLCJlbWFpbCI6bnVsbCwicm9sZSI6InN1cHBvcnQiLCJqdGkiOiJqMSIsImV4cCI6MjAwMDAwMDAwMH0.ScYBXu2cYkJ16bkTrcK0rkxSy2mfvdiYfdpi2YUsq9g";

test("shared test vector is byte-exact", () => {
  const t = signSsoToken({ sub: 7, name: "Аня", email: null, role: "support", jti: "j1", exp: 2000000000 }, "x".repeat(32));
  assert.equal(t, SHARED_TEST_VECTOR);
});

test("valid token verifies", () => {
  const r = verifySsoToken(signSsoToken(claims, SECRET), SECRET, NOW);
  assert.deepEqual(r, { ok: true, claims });
});

test("tampered payload fails the signature check", () => {
  const [, sig] = signSsoToken(claims, SECRET).split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, role: "admin" })).toString("base64url");
  assert.deepEqual(verifySsoToken(`${forged}.${sig}`, SECRET, NOW), { ok: false, reason: "signature" });
  assert.deepEqual(verifySsoToken(signSsoToken(claims, SECRET), "z".repeat(32), NOW), { ok: false, reason: "signature" });
});

test("expiry boundary", () => {
  const t = signSsoToken(claims, SECRET);
  assert.equal(verifySsoToken(t, SECRET, claims.exp).ok, true);
  assert.deepEqual(verifySsoToken(t, SECRET, claims.exp + 1), { ok: false, reason: "expired" });
});

test("role outside admin/support is rejected", () => {
  const t = signSsoToken({ ...claims, role: "manager" as never }, SECRET);
  assert.deepEqual(verifySsoToken(t, SECRET, NOW), { ok: false, reason: "role" });
});

test("garbage is malformed", () => {
  for (const t of ["", "abc", "a.b.c", ".", "a.", ".b", "!!!.???"]) {
    assert.deepEqual(verifySsoToken(t, SECRET, NOW), { ok: false, reason: "malformed" }, t);
  }
});

function signRaw(payload: string): string {
  const p = Buffer.from(payload).toString("base64url");
  return `${p}.${createHmac("sha256", SECRET).update(p).digest("base64url")}`;
}

test("validly signed but wrong-shape claims are malformed", () => {
  for (const bad of ["not json", "null", "[]", JSON.stringify({ ...claims, sub: "7" }), JSON.stringify({ ...claims, jti: "" }),
    JSON.stringify({ ...claims, exp: "x" }), JSON.stringify({ ...claims, email: 5 }), JSON.stringify({ ...claims, name: "" }),
    JSON.stringify({ ...claims, next: 3 })]) {
    assert.deepEqual(verifySsoToken(signRaw(bad), SECRET, NOW), { ok: false, reason: "malformed" }, bad);
  }
});

test("exp more than 120 s ahead is malformed", () => {
  const far = signSsoToken({ ...claims, exp: NOW + 3600 }, SECRET);
  assert.deepEqual(verifySsoToken(far, SECRET, NOW), { ok: false, reason: "malformed" });
  assert.equal(verifySsoToken(signSsoToken({ ...claims, exp: NOW + 120 }, SECRET), SECRET, NOW).ok, true);
});

test("signature of wrong length does not throw", () => {
  const [p] = signSsoToken(claims, SECRET).split(".");
  assert.deepEqual(verifySsoToken(`${p}.AAAA`, SECRET, NOW), { ok: false, reason: "signature" });
});

test("requireOperator answers 401 without a cookie or without X-CRM", async () => {
  const app = new Hono();
  app.use("/api/*", requireOperator());
  app.get("/api/me", (c) => c.json({ ok: true }));
  for (const headers of [{}, { "X-CRM": "1" }, { Cookie: "crm_session=abc" }, { Cookie: "crm_session=abc", "X-CRM": "0" }]) {
    const res = await app.request("/api/me", { headers });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
});
