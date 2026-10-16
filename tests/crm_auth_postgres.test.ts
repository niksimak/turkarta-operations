import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;
const SECRET = "p".repeat(32);

test("sso consume, sessions, replay, next guard, re-login", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
    CRM_SSO_SECRET: SECRET,
  });
  const sql = await freshCrmDb(url!);
  const auth = await import("../dist/crm/auth.js");
  const { Hono } = await import("hono");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const now = () => Math.floor(Date.now() / 1000);
  const mk = (over: Record<string, unknown> = {}) =>
    auth.signSsoToken({ sub: 7, name: "Anna", email: "a@example.com", role: "support", jti: `j-${Math.random()}`, exp: now() + 60, ...over }, SECRET);
  try {
    const t1 = mk({ jti: "once" });
    const r1 = await auth.consumeSso(t1);
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.next, undefined);
    assert.equal(r1.operator.id, 7);
    assert.deepEqual(r1.operator.prefs, DEFAULT_PREFS, "stored {} merges with defaults");

    const [stored] = await sql`select token_hash, expires_at > now() + interval '11 hours 59 minutes' as long_enough,
      expires_at < now() + interval '12 hours 1 minute' as short_enough from crm_sessions`;
    assert.notEqual(stored!.token_hash, r1.sessionToken, "only the hash is stored");
    assert.match(stored!.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(stored!.long_enough && stored!.short_enough, "12 h ttl");

    assert.equal((await auth.operatorForSession(r1.sessionToken))?.name, "Anna");
    assert.equal(await auth.operatorForSession("nope"), null);
    assert.equal(await auth.operatorForSession(""), null);

    assert.deepEqual(await auth.consumeSso(t1), { ok: false, reason: "replay" });
    assert.equal((await sql`select 1 from crm_sessions`).length, 1, "replay creates no session");

    await sql`update crm_sessions set expires_at = now() - interval '1 second'`;
    assert.equal(await auth.operatorForSession(r1.sessionToken), null);

    const kept = await auth.consumeSso(mk({ next: "/crm/t/abc" }));
    assert.equal(kept.ok && kept.next, "/crm/t/abc");
    const rootNext = await auth.consumeSso(mk({ next: "/crm" }));
    assert.equal(rootNext.ok && rootNext.next, "/crm");
    for (const bad of ["https://evil", "//evil.com", "/crm/../x?y", "/crmx", "/crm\\evil", "/crm//evil.com"]) {
      const r = await auth.consumeSso(mk({ next: bad }));
      assert.equal(r.ok, true, bad);
      if (r.ok && bad !== "/crm//evil.com") assert.equal(r.next, undefined, bad);
    }

    assert.equal((await sql`select 1 from crm_sessions where expires_at < now()`).length, 0, "expired sessions purged on login");

    await sql`update crm_operators set is_lead = true, prefs = '{"theme":"dark"}'::jsonb where id = 7`;
    const re = await auth.consumeSso(mk({ name: "Anna B", email: null, role: "admin" }));
    assert.equal(re.ok, true);
    if (!re.ok) return;
    assert.equal(re.operator.is_lead, true, "re-login keeps is_lead");
    assert.equal(re.operator.prefs.theme, "dark");
    assert.equal(re.operator.prefs.sound, DEFAULT_PREFS.sound);
    assert.equal(re.operator.name, "Anna B");
    assert.equal(re.operator.role, "admin");
    assert.equal(re.operator.email, null);

    await sql`insert into crm_sso_nonces(jti, expires_at) values ('old', now() - interval '1 second')`;
    await auth.consumeSso(mk());
    assert.equal((await sql`select 1 from crm_sso_nonces where jti = 'old'`).length, 0, "expired nonces purged");

    assert.deepEqual(await auth.consumeSso(mk({ role: "manager" })), { ok: false, reason: "role" });
    assert.deepEqual(await auth.consumeSso(mk({ exp: now() - 5 })), { ok: false, reason: "expired" });
    assert.equal((await sql`select 1 from crm_operators where id = 7`).length, 1);

    const app = new Hono();
    app.use("/api/*", auth.requireOperator());
    app.get("/api/me", (c) => c.json({ id: c.var.operator.id }));
    const cookie = `${auth.SESSION_COOKIE}=${re.sessionToken}`;
    const ok = await app.request("/api/me", { headers: { Cookie: cookie, "X-CRM": "1" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: 7 });
    assert.equal((await app.request("/api/me", { headers: { Cookie: cookie } })).status, 401, "missing X-CRM");
    assert.equal((await app.request("/api/me", { headers: { Cookie: `${auth.SESSION_COOKIE}=bogus`, "X-CRM": "1" } })).status, 401);

    await auth.deleteSession(re.sessionToken);
    assert.equal(await auth.operatorForSession(re.sessionToken), null);
    assert.equal((await app.request("/api/me", { headers: { Cookie: cookie, "X-CRM": "1" } })).status, 401, "logout kills the session");
  } finally {
    await sql.end();
    const { sql: appSql } = await import("../dist/db.js");
    await appSql.end();
  }
});

test("consumeSso is disabled without a secret", { skip: !url }, async () => {
  // Separate process so config is parsed without CRM_SSO_SECRET.
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env, DATABASE_URL: "postgres://x:x@127.0.0.1:1/x" };
  delete env.CRM_SSO_SECRET;
  const code = `const {consumeSso}=await import("./dist/crm/auth.js");const r=await consumeSso("a.b");process.stdout.write(JSON.stringify(r));process.exit(0)`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
  assert.equal(out.stdout, JSON.stringify({ ok: false, reason: "disabled" }));
});
