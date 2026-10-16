import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;
const SSO_SECRET = "k".repeat(40);

test("CRM API end to end: SSO, operators, canned replies, stats, logout", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
    CRM_SSO_SECRET: SSO_SECRET,
  });
  delete process.env.TURKARTA_API_URL;
  const { signSsoToken } = await import("../dist/crm/auth.js");
  const { app } = await import("../dist/server.js");
  const sql = await freshCrmDb(url!);

  const events: Array<Record<string, unknown>> = [];
  const listener = await sql.listen("crm_events", (p) => { events.push(JSON.parse(p)); });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  let jti = 0;
  const token = (sub: number, name: string, role: "admin" | "support", next?: string) => signSsoToken({
    sub, name, email: null, role, jti: `j-${++jti}`, exp: Math.floor(Date.now() / 1000) + 60, ...(next ? { next } : {}),
  }, SSO_SECRET);
  async function login(sub: number, name: string, role: "admin" | "support"): Promise<string> {
    const res = await app.request(`/crm/sso?t=${token(sub, name, role)}`);
    assert.equal(res.status, 302);
    const cookie = res.headers.get("set-cookie")!;
    return cookie.split(";")[0]!.split("=")[1]!;
  }
  const H = (session: string) => ({ cookie: `crm_session=${session}`, "X-CRM": "1", "content-type": "application/json" });
  const call = async (session: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/crm/api${path}`, {
      method, headers: H(session), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  try {
    await t.test("SSO sets the session cookie and honours next; replay fails", async () => {
      const tok = token(7, "Anna", "support", "/crm/tickets/abc");
      const res = await app.request(`/crm/sso?t=${tok}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/crm/tickets/abc");
      const cookie = res.headers.get("set-cookie")!;
      assert.match(cookie, /^crm_session=[A-Za-z0-9_-]{43};/);
      for (const part of ["Max-Age=43200", "Path=/crm", "HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(cookie.includes(part), cookie);
      const again = await app.request(`/crm/sso?t=${tok}`);
      assert.equal(again.headers.get("location"), "/crm/login-failed?reason=replay");
    });

    const anna = await login(7, "Anna", "support");
    const boris = await login(8, "Boris", "support");
    const lena = await login(10, "Lena", "support");
    const admin = await login(9, "Admin", "admin");
    await sql`update crm_operators set is_lead = true where id = 10`;

    await t.test("me, shift and heartbeat stamp last_active_at", async () => {
      const me = await call(anna, "GET", "/me");
      assert.equal(me.status, 200);
      assert.equal(me.body.name, "Anna");
      assert.equal(me.body.prefs.send_key, "mod_enter");

      await sql`update crm_operators set last_active_at = null, on_shift = false where id = 7`;
      events.length = 0;
      const on = await call(anna, "POST", "/me/shift", { on: true });
      assert.equal(on.status, 200);
      assert.equal(on.body.on_shift, true);
      assert.ok(on.body.last_active_at);
      await settle();
      assert.deepEqual(events, [{ type: "operator.updated", operatorId: 7 }]);

      await sql`update crm_operators set last_active_at = now() - interval '1 hour' where id = 7`;
      const hb = await call(anna, "POST", "/me/heartbeat");
      assert.deepEqual(hb, { status: 200, body: { ok: true } });
      const [row] = await sql`select last_active_at > now() - interval '1 minute' as fresh from crm_operators where id = 7`;
      assert.equal(row!.fresh, true);

      const off = await call(anna, "POST", "/me/shift", { on: false });
      assert.equal(off.body.on_shift, false);
      assert.equal((await call(anna, "POST", "/me/shift", { on: "yes" })).status, 422);
    });

    await t.test("prefs merge and validate", async () => {
      const ok = await call(anna, "PUT", "/me/prefs", { theme: "dark", volume: 0.2 });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.prefs.theme, "dark");
      assert.equal(ok.body.prefs.volume, 0.2);
      assert.equal(ok.body.prefs.send_key, "mod_enter");
      const again = await call(anna, "PUT", "/me/prefs", { send_key: "enter" });
      assert.equal(again.body.prefs.theme, "dark");
      assert.equal(again.body.prefs.send_key, "enter");
      const bad = await call(anna, "PUT", "/me/prefs", { theme: "neon", extra: 1 });
      assert.equal(bad.status, 422);
      assert.equal(bad.body.error, "validation");
      assert.ok(bad.body.fields.theme);
      assert.equal((await call(anna, "PUT", "/me/prefs", { volume: 2 })).status, 422);
    });

    await t.test("operators list with open ticket counts and permissioned updates", async () => {
      await sql`insert into support_requests (user_tg, user_name, source, first_message, status, assigned_operator_id)
        values (5001, 'u', 'bot', 'x', 'allocated', 8), (5002, 'u', 'bot', 'x', 'awaiting', 8), (5003, 'u', 'bot', 'x', 'resolved', 8)`;
      const list = await call(anna, "GET", "/operators");
      assert.equal(list.status, 200);
      const b = list.body.find((o: { id: number }) => o.id === 8);
      assert.equal(b.open_tickets, 2);
      assert.equal(list.body.find((o: { id: number }) => o.id === 7).open_tickets, 0);
      assert.equal(b.prefs, undefined);

      assert.equal((await call(lena, "PUT", "/operators/8", { is_lead: true })).status, 403);
      assert.equal((await call(boris, "PUT", "/operators/8", { auto_assign_enabled: false })).status, 403);
      events.length = 0;
      const lead = await call(lena, "PUT", "/operators/8", { auto_assign_enabled: false, on_shift: false });
      assert.equal(lead.status, 200);
      assert.equal(lead.body.auto_assign_enabled, false);
      const adm = await call(admin, "PUT", "/operators/8", { is_lead: true });
      assert.equal(adm.body.is_lead, true);
      assert.equal((await call(admin, "PUT", "/operators/999", { is_lead: true })).status, 404);
      assert.equal((await call(admin, "PUT", "/operators/8", {})).status, 422);
      await settle();
      assert.deepEqual(events, [{ type: "operator.updated", operatorId: 8 }, { type: "operator.updated", operatorId: 8 }]);
    });

    await t.test("canned replies: order, use, edit by anyone, delete by author/lead/admin", async () => {
      const a = await call(anna, "POST", "/canned", { title: "Привет", body: "Здравствуйте!" });
      assert.equal(a.status, 200);
      const b = await call(boris, "POST", "/canned", { title: "Апдейт", body: "Проверяем." });
      const c = await call(boris, "POST", "/canned", { title: "Возврат", body: "Деньги вернутся." });
      assert.equal((await call(anna, "POST", "/canned", { title: "x".repeat(81), body: "y" })).status, 422);
      assert.equal((await call(anna, "POST", "/canned", { title: "ok", body: "y".repeat(4001) })).status, 422);
      assert.equal((await call(anna, "POST", "/canned", { title: "  ", body: "y" })).status, 422);

      const used = await call(boris, "POST", `/canned/${a.body.id}/use`);
      assert.deepEqual(used, { status: 200, body: { ok: true, use_count: 1 } });
      const list = await call(anna, "GET", "/canned");
      assert.deepEqual(list.body.map((r: { title: string }) => r.title), ["Привет", "Апдейт", "Возврат"]);
      assert.equal(list.body[0].created_by_name, "Anna");
      const found = await call(anna, "GET", "/canned?q=вернутся");
      assert.deepEqual(found.body.map((r: { title: string }) => r.title), ["Возврат"]);

      const edited = await call(anna, "PUT", `/canned/${b.body.id}`, { body: "Уже проверяем." });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.body, "Уже проверяем.");
      assert.equal(edited.body.title, "Апдейт");

      assert.equal((await call(anna, "DELETE", `/canned/${b.body.id}`)).status, 403);
      assert.deepEqual(await call(boris, "DELETE", `/canned/${b.body.id}`), { status: 200, body: { ok: true } });
      assert.equal((await call(lena, "DELETE", `/canned/${c.body.id}`)).status, 200);
      assert.equal((await call(admin, "DELETE", `/canned/${a.body.id}`)).status, 200);
      assert.equal((await call(admin, "DELETE", `/canned/${a.body.id}`)).status, 404);
      assert.equal((await call(admin, "POST", "/canned/not-a-uuid/use")).status, 404);
      assert.deepEqual((await call(anna, "GET", "/canned")).body, []);
    });

    await t.test("settings and stats through the real stores", async () => {
      assert.equal((await call(anna, "PUT", "/settings", { sla_first_minutes: 7 })).status, 403);
      const bad = await call(lena, "PUT", "/settings", { sla_first_minutes: 0 });
      assert.equal(bad.status, 422);
      assert.equal(bad.body.fields.sla_first_minutes, "От 1 до 240 минут");
      const ok = await call(lena, "PUT", "/settings", { sla_first_minutes: 7 });
      assert.equal(ok.body.sla_first_minutes, 7);
      const log = await call(admin, "GET", "/settings/log");
      assert.equal(log.body[0].operator_name, "Lena");
      const st = await call(anna, "GET", "/stats");
      assert.equal(st.status, 200);
      assert.equal(st.body.team.new_per_day.length, 7);
    });

    await t.test("logout ends the session", async () => {
      assert.deepEqual(await call(boris, "POST", "/logout"), { status: 200, body: { ok: true } });
      assert.equal((await call(boris, "GET", "/me")).status, 401);
    });
  } finally {
    await listener.unlisten();
    const db = await import("../dist/db.js");
    await db.sql.end();
    await sql.end();
  }
});
