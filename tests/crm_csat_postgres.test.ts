import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("CSAT: ask after a CRM resolve, rate, comment, lookups", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
    SUPPORT_SURFACE: "crm",
  });
  // Import before opening the test pool so a missing module fails fast instead of hanging.
  const tickets = await import("../dist/crm/tickets.js");
  const csat = await import("../dist/crm/csat.js");
  const db = await import("../dist/db.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const sql = await freshCrmDb(url!);
  type Operator = import("../dist/crm/types.js").Operator;

  const op = (id: number, name: string, role: "admin" | "support", is_lead = false): Operator => ({
    id, name, email: null, role, is_lead, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
  });
  const anna = op(7, "Anna", "support");

  const sent: Array<{ chat: number; text: string; extra: unknown }> = [];
  const tg = {
    async sendMessage(chat: number, text: string, extra?: unknown) { sent.push({ chat, text, extra }); return { message_id: 900 + sent.length }; },
    async sendPhoto(): Promise<never> { throw new Error("unused"); },
    async sendMediaGroup(): Promise<never> { throw new Error("unused"); },
    async sendVideo(): Promise<never> { throw new Error("unused"); },
  };

  async function ticket(fields: Record<string, unknown> = {}) {
    const row = {
      user_tg: 7001, user_name: "Иван", source: "bot", first_message: "help", queued_at: sql`now()`,
      status: "allocated", assigned_operator_id: 7, ...fields,
    };
    const [r] = await sql`insert into support_requests ${sql(row)} returning id`;
    return r!.id as string;
  }
  const customer = (id: string) =>
    sql`insert into support_messages (ticket_id, sender, body, actor_type) values (${id}, 'user', 'help', 'customer')`;
  const human = (id: string, at = sql`now()`) =>
    sql`insert into support_messages (ticket_id, sender, body, actor_type, author_id, author_name, kind, created_at)
        values (${id}, 'agent', 'answer', 'human', 'crm:7', 'Anna', 'text', ${at})`;
  const resolve = (id: string) => tickets.setStatus(id, "resolved", anna, { onResolved: async () => {}, csatDeps: { tg } });
  const csatRows = (id: string) => sql`select * from crm_csat where ticket_id = ${id} order by asked_at`;
  const csatEvents = (id: string) =>
    sql`select payload, actor_operator_id from crm_ticket_events where ticket_id = ${id} and type = 'csat' order by id`;

  try {
    await sql`insert into crm_operators (id, name, role, is_lead) values (7, 'Anna', 'support', false)`;

    let tgCsat = "";
    let tgTicket = "";
    let webCsat = "";
    let webTicket = "";

    await t.test("asks after a CRM resolve with a human reply", async () => {
      sent.length = 0;
      const id = await ticket();
      tgTicket = id;
      await customer(id);
      await human(id);
      await resolve(id);

      const rows = await csatRows(id);
      assert.equal(rows.length, 1);
      const c = rows[0]!;
      tgCsat = c.id as string;
      const [tk] = await sql`select resolved_at, assigned_operator_id from support_requests where id = ${id}`;
      assert.equal(c.channel, "telegram");
      assert.equal(Number(c.operator_id), Number(tk!.assigned_operator_id));
      assert.equal(Number(c.operator_id), 7);
      assert.equal((c.resolved_at as Date).getTime(), (tk!.resolved_at as Date).getTime());
      assert.equal(c.rating, null);

      const prompts = await sql`select id, seq, actor_type, author_id, delivery_status, sender, kind from support_messages
        where ticket_id = ${id} and body = 'Мы смогли вам помочь?'`;
      assert.equal(prompts.length, 1);
      const p = prompts[0]!;
      assert.equal(p.actor_type, "automation");
      assert.equal(p.author_id, "crm:system");
      assert.equal(p.delivery_status, "sent");
      assert.equal(p.sender, "agent");
      assert.equal(p.kind, "text");

      assert.deepEqual(sent[0], {
        chat: 7001, text: "Мы смогли вам помочь?",
        extra: { reply_markup: { inline_keyboard: [[
          { text: "👍 Да", callback_data: `csat:${tgCsat}:up` },
          { text: "👎 Нет", callback_data: `csat:${tgCsat}:down` },
        ]] } },
      });
      assert.equal(sent.length, 1);
      assert.equal(c.prompt_message_id, p.id);

      const jobs = await sql`select kind from support_agent_jobs
        where ticket_id = ${id} and kind in ('triage','review') and through_seq = ${p.seq}`;
      assert.equal(jobs.length, 0, "the prompt message queues no AI triage/review");
    });

    await t.test("not asked: no human reply, disabled, reply only before reopen, second ask", async () => {
      sent.length = 0;
      // (a) no human reply
      const a = await ticket({ user_tg: 7101 });
      await customer(a);
      await resolve(a);
      assert.equal((await csatRows(a)).length, 0);

      // (b) csat_enabled = false
      const b = await ticket({ user_tg: 7102 });
      await customer(b);
      await human(b);
      await sql`insert into crm_settings (key, value) values ('csat_enabled', 'false'::jsonb)`;
      try {
        await resolve(b);
      } finally {
        await sql`delete from crm_settings where key = 'csat_enabled'`;
      }
      assert.equal((await csatRows(b)).length, 0);

      // (c) a human reply only before the last reopen
      const c = await ticket({ user_tg: 7103 });
      await customer(c);
      await human(c, sql`now() - interval '10 minutes'`);
      await sql`insert into crm_ticket_events (ticket_id, type, payload, created_at)
                values (${c}, 'reopened', '{}'::jsonb, now() - interval '5 minutes')`;
      await resolve(c);
      assert.equal((await csatRows(c)).length, 0);

      // (d) a second ask for the same resolution
      const tk = await db.getTicket(tgTicket);
      assert.equal(await csat.askCsat(tk!, "Мы смогли вам помочь?", { tg }), null);

      assert.equal(sent.length, 0);
      assert.equal((await csatRows(tgTicket)).length, 1);
    });

    await t.test("web channel", async () => {
      sent.length = 0;
      const id = await ticket({ user_tg: null, web_user_id: "w-1", channel: "web", source: "web" });
      webTicket = id;
      await customer(id);
      await human(id);
      await resolve(id);
      const rows = await csatRows(id);
      assert.equal(rows.length, 1);
      webCsat = rows[0]!.id as string;
      assert.equal(rows[0]!.channel, "web");
      const [m] = await sql`select delivery_status from support_messages where id = ${rows[0]!.prompt_message_id}`;
      assert.equal(m!.delivery_status, "sent");
      assert.equal(sent.length, 0);
      assert.deepEqual(await csat.csatForWeb(id), { id: webCsat, rating: null, comment_allowed: false });
    });

    await t.test("rate: own customer only, idempotent", async () => {
      assert.deepEqual(await csat.rateCsat(tgCsat, { userTg: 7001 }, "down"), { ok: true, askComment: true });
      const [c] = await csatRows(tgTicket);
      assert.equal(c!.rating, "down");
      assert.ok(c!.answered_at instanceof Date);
      let ev = await csatEvents(tgTicket);
      assert.equal(ev.length, 1);
      assert.deepEqual(ev[0]!.payload, { rating: "down" });
      assert.equal(ev[0]!.actor_operator_id, null);

      assert.deepEqual(await csat.rateCsat(tgCsat, { userTg: 7001 }, "down"), { ok: true, askComment: true });
      ev = await csatEvents(tgTicket);
      assert.equal(ev.length, 1, "a repeated tap logs no second event");

      assert.deepEqual(await csat.rateCsat(tgCsat, { userTg: 9999 }, "up"), { ok: false, reason: "not_found" });
      assert.equal((await csatRows(tgTicket))[0]!.rating, "down");

      assert.deepEqual(await csat.rateCsat(webCsat, { webUserId: "w-2" }, "up"), { ok: false, reason: "not_found" });
      assert.deepEqual(await csat.rateCsat(webCsat, { webUserId: "w-1" }, "up"), { ok: true, askComment: false });
      assert.deepEqual(await csat.csatForWeb(webTicket), { id: webCsat, rating: "up", comment_allowed: false });
    });

    await t.test("closed after reopen, and stays closed after a new resolve", async () => {
      await sql`update support_requests set status = 'new' where id = ${tgTicket}`;
      assert.deepEqual(await csat.rateCsat(tgCsat, { userTg: 7001 }, "up"), { ok: false, reason: "closed" });
      await sql`update support_requests set status = 'resolved', resolved_at = now() + interval '1 second' where id = ${tgTicket}`;
      assert.deepEqual(await csat.rateCsat(tgCsat, { userTg: 7001 }, "up"), { ok: false, reason: "closed" });
      assert.equal((await csatRows(tgTicket))[0]!.rating, "down");
    });

    await t.test("comment", async () => {
      sent.length = 0;
      const id = await ticket({ user_tg: 7001 });
      await customer(id);
      await human(id);
      await resolve(id);
      const [c] = await csatRows(id);
      const cid = c!.id as string;
      const who = { userTg: 7001 };
      assert.deepEqual(await csat.rateCsat(cid, who, "down"), { ok: true, askComment: true });

      assert.deepEqual(await csat.commentCsat(cid, who, "  долго ждал ответа  "), { ok: true });
      const [after] = await csatRows(id);
      assert.equal(after!.comment, "долго ждал ответа");
      assert.ok(after!.commented_at instanceof Date);
      const ev = await csatEvents(id);
      assert.deepEqual(ev.map((e) => e.payload), [{ rating: "down" }, { rating: "down", comment: "долго ждал ответа" }]);

      assert.deepEqual(await csat.commentCsat(webCsat, { webUserId: "w-1" }, "ok"), { ok: false, reason: "invalid" });
      assert.deepEqual(await csat.commentCsat(cid, who, "   "), { ok: false, reason: "invalid" });
      assert.deepEqual(await csat.commentCsat(cid, who, "x".repeat(1001)), { ok: false, reason: "invalid" });

      await csat.setCommentPrompt(cid, 4242);
      assert.equal(await csat.csatByCommentPrompt(7001, 4242), cid);
      assert.equal(await csat.csatByCommentPrompt(7002, 4242), null);
      assert.equal(await csat.csatByCommentPrompt(7001, 1), null);
    });

    await t.test("resolve never fails because of CSAT", async () => {
      const id = await ticket({ user_tg: 7003 });
      await customer(id);
      await human(id);
      const broken = { ...tg, async sendMessage(): Promise<never> { throw new Error("network down"); } };
      const logged: string[] = [];
      const origError = console.error;
      console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      try {
        await tickets.setStatus(id, "resolved", anna, { onResolved: async () => {}, csatDeps: { tg: broken } });
      } finally {
        console.error = origError;
      }
      const [r] = await sql`select status from support_requests where id = ${id}`;
      assert.equal(r!.status, "resolved");
      const rows = await csatRows(id);
      assert.equal(rows.length, 1);
      const [m] = await sql`select delivery_status from support_messages where id = ${rows[0]!.prompt_message_id}`;
      assert.equal(m!.delivery_status, "failed");
    });
  } finally {
    await db.sql.end();
    await sql.end();
  }
});
