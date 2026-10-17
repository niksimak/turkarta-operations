import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("cutover timers: Bitrix and forum replies stop the clock; crm_cutover resets carried state", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const db = await import("../dist/db.js");
  const { crmCutover } = await import("../dist/crm/cutover.js");

  let tg = 1000;
  const ticket = async (row: Record<string, unknown> = {}) => {
    const [r] = await sql`insert into support_requests ${sql({
      user_tg: ++tg, first_message: "help", status: "new",
      waiting_since: sql`now() - interval '1 hour'`, ...row,
    } as Record<string, unknown>)} returning id`;
    return r!.id as string;
  };
  const msg = (ticketId: string, sender: string, kind = "text") =>
    sql`insert into support_messages (ticket_id, sender, body, kind) values (${ticketId}, ${sender}, 'x', ${kind})`;
  const row = async (id: string) =>
    (await sql`select status, waiting_since, first_response_at, overdue_pinged_at, queued_at from support_requests where id = ${id}`)[0]!;

  try {
    await t.test("a Bitrix reply clears waiting_since and stamps first_response_at once; status unchanged", async () => {
      const id = await ticket({ status: "allocated" });
      const first = await db.addAgentMessageFromBitrix(id, "ok", "bx-1");
      assert.ok(first);
      const a = await row(id);
      assert.equal(a.waiting_since, null);
      assert.ok(a.first_response_at instanceof Date);
      assert.equal(a.status, "allocated");

      await sql`update support_requests set waiting_since = now() where id = ${id}`;
      assert.equal(await db.addAgentMessageFromBitrix(id, "ok", "bx-1"), null, "duplicate inserts nothing");
      assert.notEqual((await row(id)).waiting_since, null, "a duplicate event does not touch the ticket");

      await db.addAgentMessageFromBitrix(id, "again", "bx-2");
      const b = await row(id);
      assert.equal(b.waiting_since, null);
      assert.equal(b.first_response_at.getTime(), a.first_response_at.getTime(), "first response keeps the first time");
    });

    await t.test("a forum relay reply clears waiting_since and stamps first_response_at", async () => {
      const id = await ticket({ status: "awaiting" });
      await db.addMessage(id, "agent", "ok", undefined, { actor: "human", authorId: "tg:1", sourceId: "tg:-1002:1" });
      await db.markAgentReplied(id);
      const r = await row(id);
      assert.equal(r.waiting_since, null);
      assert.ok(r.first_response_at instanceof Date);
      assert.equal(r.status, "awaiting");
    });

    await t.test("crm_cutover: dry run counts and writes nothing; apply writes in one go", async () => {
      await sql`delete from support_requests`;
      await sql`insert into crm_operators (id, name, role) values (1, 'Anna', 'support') on conflict do nothing`;
      const agentLast = await ticket();
      await msg(agentLast, "user");
      await msg(agentLast, "agent");
      const userLast = await ticket({ status: "awaiting" });
      await msg(userLast, "agent");
      await msg(userLast, "user");
      await msg(userLast, "agent", "note"); // a note is not an answer
      const claimed = await ticket({ status: "allocated", claimed_by: "Oleg", queued_at: sql`now() - interval '2 hours'` });
      await msg(claimed, "user");
      const assigned = await ticket({ status: "allocated", assigned_operator_id: 1 });
      await msg(assigned, "user");
      const resolved = await ticket({ status: "resolved" });
      await msg(resolved, "agent");

      const before = await sql`select * from support_requests order by id`;
      const dry = await crmCutover(sql, false);
      assert.deepEqual(dry, { waitingCleared: 1, pingsStamped: 4, requeued: 1 });
      assert.deepEqual(await sql`select * from support_requests order by id`, before, "dry run writes nothing");

      const applied = await crmCutover(sql, true);
      assert.deepEqual(applied, dry);
      assert.equal((await row(agentLast)).waiting_since, null);
      assert.notEqual((await row(userLast)).waiting_since, null);
      for (const id of [agentLast, userLast, claimed, assigned]) assert.ok((await row(id)).overdue_pinged_at instanceof Date);
      const r = await row(resolved);
      assert.equal(r.overdue_pinged_at, null);
      assert.notEqual(r.waiting_since, null, "resolved tickets are left alone");
      const c = await row(claimed);
      assert.equal(c.status, "new");
      assert.ok(Date.now() - c.queued_at.getTime() < 60_000, "requeued now");
      assert.equal((await row(assigned)).status, "allocated");
      assert.equal((await sql`select count(*)::int as n from crm_ticket_events`)[0]!.n, 0);

      assert.deepEqual(await crmCutover(sql, true), { waitingCleared: 0, pingsStamped: 4, requeued: 0 }, "a rerun is safe");
    });

    await t.test("archiveBacklog: resolves open tickets silent since the cutover, keeps ones the customer wrote to", async () => {
      await sql`delete from support_requests`;
      await sql`insert into crm_operators (id, name, role) values (1, 'Anna', 'support') on conflict do nothing`;
      const { archiveBacklog } = await import("../dist/crm/cutover.js");
      const cutoverAt = new Date(Date.now() - 60 * 60_000);
      const old = { created_at: sql`now() - interval '3 days'` };
      const silentQueued = await ticket(old);
      await sql`insert into support_messages (ticket_id, sender, body, kind, created_at)
                values (${silentQueued}, 'user', 'x', 'text', now() - interval '3 days')`;
      const silentAssigned = await ticket({ ...old, status: "allocated", assigned_operator_id: 1 });
      const wroteAgain = await ticket(old);
      await msg(wroteAgain, "user"); // now(): after the cutover
      const fresh = await ticket();
      const done = await ticket({ ...old, status: "resolved" });

      const before = await sql`select * from support_requests order by id`;
      assert.equal(await archiveBacklog(sql, cutoverAt, false), 2);
      assert.deepEqual(await sql`select * from support_requests order by id`, before, "dry run writes nothing");

      assert.equal(await archiveBacklog(sql, cutoverAt, true), 2);
      for (const id of [silentQueued, silentAssigned]) {
        const r = (await sql`select status, waiting_since, resolved_at from support_requests where id = ${id}`)[0]!;
        assert.equal(r.status, "resolved");
        assert.equal(r.waiting_since, null);
        assert.ok(r.resolved_at instanceof Date);
      }
      assert.equal((await row(wroteAgain)).status, "new");
      assert.equal((await row(fresh)).status, "new");
      assert.equal((await row(done)).status, "resolved");
      const ev = await sql`select ticket_id, type, actor_operator_id, payload from crm_ticket_events order by ticket_id`;
      assert.equal(ev.length, 2);
      assert.deepEqual(new Set(ev.map((e) => e.payload.from)), new Set(["new", "allocated"]));
      for (const e of ev) {
        assert.equal(e.type, "status_changed");
        assert.equal(e.actor_operator_id, null);
        assert.equal(e.payload.to, "resolved");
        assert.equal(e.payload.reason, "cutover_backlog");
      }
      assert.equal((await sql`select count(*)::int as n from support_messages where sender = 'system'`)[0]!.n, 0, "no resolve message");
      assert.equal(await archiveBacklog(sql, cutoverAt, true), 0, "a rerun is safe");
    });
  } finally {
    await db.sql.end();
    await sql.end();
  }
});
