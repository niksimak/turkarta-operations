import assert from "node:assert/strict";
import test from "node:test";
import { AgentStore } from "../src/agents/store.js";
import { OperationsStore } from "../src/agents/operations-store.js";
import type { OperationsOptions } from "../src/agents/operations-contracts.js";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("operator notes never make AI triage or QA results stale", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  const sql = await freshCrmDb(url!);
  const agents = new AgentStore(sql);
  const ops = new OperationsStore(sql);
  const options: OperationsOptions = { chatId: -100101, qaChatId: -100102, routes: {
    support: { primary_tg: 111, backup_tg: 222 }, payments: { primary_tg: 111, backup_tg: 222 } },
    acknowledgeMinutes: 10, updateMinutes: 60, maxReminders: 3, digestHourUtc: 4 };
  const snapshot = { classification: { summary_ru: "CSB вернул 500 при пополнении" },
    policy: { teams: ["payments"], money_related: true, off_topic_only: false } };

  let userSeq = 70000;
  const ticket = async () => String((await sql`insert into support_requests (user_tg, first_message) values (${++userSeq}, 'help') returning id`)[0]!.id);
  const customer = (id: string, body: string) =>
    sql`insert into support_messages (ticket_id, sender, body, actor_type) values (${id}, 'user', ${body}, 'customer')`;
  // Same shape reply.ts writes for an internal note.
  const note = (id: string, body: string) =>
    sql`insert into support_messages (ticket_id, sender, body, actor_type, author_id, author_name, kind)
        values (${id}, 'agent', ${body}, 'system', 'crm:7', 'Anna', 'note')`;
  const claimTriage = async (id: string) => {
    await sql`update support_agent_jobs set available_at = now() where ticket_id = ${id} and status = 'pending'`;
    const job = await agents.claim();
    assert.ok(job && job.ticket_id === id && job.kind === "triage");
    return job;
  };
  const drain = async () => { while (await ops.materialize(options)) { /* consume all */ } };

  try {
    await t.test("triage: a later note neither supersedes the job nor enters the transcript", async () => {
      const id = await ticket();
      await note(id, "внутреннее: проверить KYC");
      await customer(id, "Не прошло пополнение");
      const job = await claimTriage(id);
      const { messages } = await agents.transcript(job);
      assert.deepEqual(messages.map((m) => m.body), ["Не прошло пополнение"], "notes are not conversation context");

      await note(id, "@Boris глянь");
      await agents.finish(job, snapshot);
      const [j] = await sql`select status from support_agent_jobs where id = ${job.id}`;
      assert.equal(j!.status, "completed");
      const [r] = await agents.results(id);
      assert.equal(r!.stale, false);

      await drain();
      const tasks = await sql`select team from support_agent_tasks where ticket_id = ${id}`;
      assert.deepEqual(tasks.map((x) => x.team), ["payments"], "the internal task is still created");
    });

    await t.test("triage: a later customer message still supersedes (unchanged)", async () => {
      const id = await ticket();
      await customer(id, "первое");
      const job = await claimTriage(id);
      await customer(id, "второе");
      await agents.finish(job, snapshot);
      const [j] = await sql`select status from support_agent_jobs where id = ${job.id}`;
      assert.equal(j!.status, "superseded");
    });

    await t.test("QA: a note after a critical review keeps the alert and the review fresh", async () => {
      const id = await ticket();
      await customer(id, "вопрос");
      await sql`update support_agent_jobs set status = 'superseded', finished_at = now() where ticket_id = ${id}`;
      await sql`insert into support_messages (ticket_id, sender, body, actor_type, author_id) values (${id}, 'agent', 'Повторите оплату', 'human', 'crm:7')`;
      const critical = { summary_ru: "Рекомендация повторить оплату", assessments: [{ verdict: "critical", attribution_incomplete: false }] };
      await sql`update support_agent_jobs set status = 'completed', finished_at = now(), result = ${sql.json(critical)}
        where ticket_id = ${id} and kind = 'review'`;
      await drain();
      const [n] = await sql`select id from support_agent_notifications where kind = 'critical' and payload->>'ticket_id' = ${id}`;
      assert.ok(n, "critical alert queued");

      await note(id, "разберусь");
      await sql`update support_agent_notifications set available_at = now() where id = ${n!.id}`;
      await ops.claimNotification();
      const [after] = await sql`select status, error_code from support_agent_notifications where id = ${n!.id}`;
      assert.notEqual(after!.error_code, "review_changed");
      assert.notEqual(after!.status, "cancelled");

      const day = new Date().toISOString().slice(0, 10);
      const items = await ops.reviewItems(day);
      assert.equal(items.find((i) => String(i.ticket_id) === id)!.stale, false);
      const report = await ops.dailyReport(day) as Record<string, unknown>;
      assert.equal(report.stale_reviews, 0);
      assert.equal(report.critical_candidates, 1);
    });
  } finally {
    await sql.end();
  }
});
