import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("payout tickets: one per payout, queued for auto-assign, closed by the API, never merged", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    SUPPORT_SURFACE: "crm",
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const payouts = await import("../dist/crm/payouts.js");
  const worker = await import("../dist/crm/worker.js");
  const db = await import("../dist/db.js");

  const events: Array<Record<string, unknown>> = [];
  const listener = await sql.listen("crm_events", (p) => { events.push(JSON.parse(p)); });
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const open = (key: string) => payouts.openPayoutTicket({
    payout_key: key, title: "Реферальная выплата 5 000 ₽", body: "Способ: на карту", who: "Иван Петров",
    admin_url: "https://api.turkarta.me/admin/referrals",
  });

  try {
    await sql`insert into crm_operators (id, name, role, on_shift, auto_assign_enabled, last_active_at)
              values (7, 'Anna', 'support', true, true, now())`;

    await t.test("opens once per payout and announces it", async () => {
      const a = await open("referral:p1");
      const b = await open("referral:p1");
      assert.equal(a.created, true);
      assert.equal(b.created, false);
      assert.equal(b.ticket.id, a.ticket.id);
      const [r] = await sql`select channel, source, status, user_tg, web_user_id, waiting_since, admin_url,
                                   (select count(*)::int from support_messages m where m.ticket_id = r.id) as msgs
                              from support_requests r where id = ${a.ticket.id}`;
      assert.equal(r!.channel, "payout");
      assert.equal(r!.status, "new");
      assert.equal(r!.user_tg, null);
      assert.equal(r!.web_user_id, null);
      assert.ok(r!.waiting_since instanceof Date, "queued for the auto-assign worker");
      assert.equal(r!.admin_url, "https://api.turkarta.me/admin/referrals");
      assert.equal(r!.msgs, 1);
      await settle();
      const notify = events.filter((e) => e.type === "notify" && e.kind === "new_ticket" && e.ticketId === a.ticket.id);
      assert.equal(notify.length, 1);
    });

    await t.test("the auto-assign worker hands it to the operator on shift", async () => {
      const [r] = await sql`select id from support_requests where payout_key = 'referral:p1'`;
      // Past the auto-assign delay, as if it had waited in the queue.
      await sql`update support_requests set queued_at = now() - interval '1 hour', waiting_since = now() - interval '1 hour' where id = ${r!.id}`;
      await worker.tick();
      const [after] = await sql`select status, assigned_operator_id::int as op from support_requests where id = ${r!.id}`;
      assert.equal(after!.status, "allocated");
      assert.equal(after!.op, 7);
    });

    await t.test("two payouts of one payee are two tickets, and a web chat of the same person stays apart", async () => {
      const second = await open("referral:p2");
      const chat = await db.openWebTicket({ web_user_id: "u-ivan", user_name: "Иван", source: "web", request: "привет" });
      const [p1] = await sql`select id from support_requests where payout_key = 'referral:p1'`;
      assert.notEqual(second.ticket.id, p1!.id);
      assert.notEqual(chat.id, second.ticket.id);
      assert.notEqual(chat.id, p1!.id);
    });

    await t.test("close resolves it with the outcome, once, without a review job", async () => {
      const [r] = await sql`select id from support_requests where payout_key = 'referral:p1'`;
      assert.equal(await payouts.closePayoutTicket("referral:p1", "paid", "СБП 12345"), true);
      assert.equal(await payouts.closePayoutTicket("referral:p1", "paid", "СБП 12345"), true);
      const [after] = await sql`select status, resolved_at, waiting_since from support_requests where id = ${r!.id}`;
      assert.equal(after!.status, "resolved");
      assert.ok(after!.resolved_at instanceof Date);
      assert.equal(after!.waiting_since, null);
      const bodies = await sql<{ body: string }[]>`select body from support_messages where ticket_id = ${r!.id} order by seq`;
      assert.deepEqual(bodies.map((m) => m.body).slice(1), ["Выплачено: СБП 12345"]);
      const [jobs] = await sql`select count(*)::int as n from support_agent_jobs where ticket_id = ${r!.id}`;
      assert.equal(jobs!.n, 0);
      assert.equal(await payouts.closePayoutTicket("referral:p2", "rejected", null), true);
      const [rej] = await sql<{ body: string }[]>`select m.body from support_messages m join support_requests r on r.id = m.ticket_id
                                                   where r.payout_key = 'referral:p2' order by m.seq desc limit 1`;
      assert.equal(rej!.body, "Отклонено");
    });

    await t.test("closing an unknown payout says so", async () => {
      assert.equal(await payouts.closePayoutTicket("partner:nope", "paid", null), false);
    });
  } finally {
    await listener.unlisten();
    await sql.end();
    await db.sql.end();
  }
});
