import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("reopen on a returning user: CRM mode continues the resolved ticket, bitrix mode opens a new one", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    SUPPORT_SURFACE: "crm",
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  // Bitrix stays inert without app credentials; the turkarta callback stays dark.
  for (const k of ["BITRIX_CLIENT_ID", "BITRIX_CLIENT_SECRET", "TURKARTA_API_URL"]) delete process.env[k];
  const sql = await freshCrmDb(url!);
  const db = await import("../dist/db.js");
  const inbound = await import("../dist/crm/inbound.js");
  const { config } = await import("../dist/config.js");
  const { supportBot } = await import("../dist/bots/support.js");
  const { app } = await import("../dist/server.js");

  const sent: Array<{ method: string; chat: unknown; text: unknown }> = [];
  supportBot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    sent.push({ method, chat: p.chat_id, text: p.text });
    if (method === "getMe") return { ok: true, result: {
      id: 456, is_bot: true, first_name: "Test", username: "test_support_bot",
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    } } as never;
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: p.chat_id, type: "private" } } } as never;
  });
  await supportBot.init();

  let seq = 0;
  const dm = (user: number, text: string) => supportBot.handleUpdate({ update_id: ++seq, message: {
    message_id: seq, date: 1, text,
    chat: { id: user, type: "private", first_name: "Иван" },
    from: { id: user, is_bot: false, first_name: "Иван" },
  } });
  let userSeq = 5000;
  async function resolved(age: string, fields: Record<string, unknown> = {}) {
    const row = { user_tg: ++userSeq, user_name: "Иван", source: "bot", first_message: "help",
      status: "resolved", resolved_at: sql`now() - ${age}::interval`, ...fields };
    const [r] = await sql`insert into support_requests ${sql(row)} returning id, user_tg`;
    return r as { id: string; user_tg: number };
  }
  const ticketsOf = (userTg: number) =>
    sql`select id, status, assigned_operator_id, intake_step from support_requests where user_tg = ${userTg} order by created_at`;
  const eventsOf = async (id: string) =>
    (await sql`select type, payload from crm_ticket_events where ticket_id = ${id} order by id`).map((e) => [e.type, e.payload]);
  const lastUserMessage = async (id: string) =>
    (await sql`select body from support_messages where ticket_id = ${id} and sender = 'user' order by seq desc limit 1`)[0]?.body;
  const ASK_EMAIL = "📧 Оставьте email для связи (или отправьте /skip).";

  try {
    await sql`insert into crm_operators (id, name, role, on_shift) values (7, 'Anna', 'support', true), (8, 'Boris', 'support', false)`;

    await t.test("crm: within the window, on-shift operator keeps it; no new ticket, no reply", async () => {
      sent.length = 0;
      const tk = await resolved("2 days", { assigned_operator_id: 7 });
      await dm(tk.user_tg, "снова я");
      const rows = await ticketsOf(tk.user_tg);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "allocated");
      assert.equal(Number(rows[0]!.assigned_operator_id), 7);
      assert.equal(await lastUserMessage(tk.id), "снова я");
      assert.deepEqual(await eventsOf(tk.id), [["reopened", { status: "allocated" }]]);
      assert.deepEqual(sent, []);
    });

    await t.test("crm: within the window, off-shift operator: back to the queue with an unassigned event", async () => {
      sent.length = 0;
      const tk = await resolved("2 days", { assigned_operator_id: 8 });
      await dm(tk.user_tg, "ау");
      const rows = await ticketsOf(tk.user_tg);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "new");
      assert.equal(rows[0]!.assigned_operator_id, null);
      assert.deepEqual(await eventsOf(tk.id), [
        ["reopened", { status: "new" }],
        ["unassigned", { operator_id: null, operator_name: null }],
      ]);
      assert.deepEqual(sent, []);
    });

    await t.test("crm: outside the window opens a new ticket with the email question", async () => {
      sent.length = 0;
      const tk = await resolved("8 days", { assigned_operator_id: 7 });
      await dm(tk.user_tg, "новый вопрос");
      const rows = await ticketsOf(tk.user_tg);
      assert.deepEqual(rows.map((r) => [r.status, r.intake_step]), [["resolved", null], ["new", "email"]]);
      assert.equal(await lastUserMessage(rows[1]!.id), "новый вопрос");
      assert.deepEqual(await eventsOf(tk.id), []);
      assert.deepEqual(sent.map((m) => [m.chat, m.text]), [[tk.user_tg, ASK_EMAIL]]);
    });

    await t.test("crm web: a message after a recent resolve reopens; an old resolve still 404s", async () => {
      const recent = await resolved("1 day", { channel: "web", user_tg: null, web_user_id: "w-recent", assigned_operator_id: 7 });
      const headers = { "x-webhook-secret": "test-secret", "content-type": "application/json" };
      const res = await app.request("/api/support/web/message", { method: "POST", headers,
        body: JSON.stringify({ web_user_id: "w-recent", body: "ещё" }) });
      assert.equal(res.status, 200);
      assert.equal((await sql`select status from support_requests where id = ${recent.id}`)[0]!.status, "allocated");
      assert.equal(await lastUserMessage(recent.id), "ещё");

      await resolved("9 days", { channel: "web", user_tg: null, web_user_id: "w-old" });
      const old = await app.request("/api/support/web/message", { method: "POST", headers,
        body: JSON.stringify({ web_user_id: "w-old", body: "ещё" }) });
      assert.equal(old.status, 404);
    });

    await t.test("bitrix: a recent resolve still opens a new ticket, and recordUserMessage never reopens", async () => {
      config.SUPPORT_SURFACE = "bitrix";
      try {
        sent.length = 0;
        const tk = await resolved("1 day", { assigned_operator_id: 7 });
        await dm(tk.user_tg, "снова я");
        const rows = await ticketsOf(tk.user_tg);
        assert.deepEqual(rows.map((r) => [r.status, r.intake_step]), [["resolved", null], ["new", "email"]]);
        assert.deepEqual(sent.map((m) => [m.chat, m.text]), [[tk.user_tg, ASK_EMAIL]]);

        const other = await resolved("1 day", { assigned_operator_id: 8 });
        const ticket = (await db.getTicket(other.id))!;
        const r = await inbound.recordUserMessage(ticket, { kind: "text", body: "x" }, { authorId: `tg:${other.user_tg}` });
        assert.equal(r.reopened, false);
        const [row] = await sql`select status, assigned_operator_id from support_requests where id = ${other.id}`;
        assert.deepEqual([row!.status, Number(row!.assigned_operator_id)], ["resolved", 8]);
        assert.deepEqual(await eventsOf(other.id), []);
      } finally {
        config.SUPPORT_SURFACE = "crm";
      }
    });
  } finally {
    await db.sql.end();
    await sql.end();
  }
});
