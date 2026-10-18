import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("topics: seed, list, create, rename, archive, ticket topic by operator and AI", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const topics = await import("../dist/crm/topics.js");
  const tickets = await import("../dist/crm/tickets.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const sql = await freshCrmDb(url!);
  type Operator = import("../dist/crm/types.js").Operator;
  const op = (id: number, name: string, role: "admin" | "support", is_lead = false): Operator => ({
    id, name, email: null, role, is_lead, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
  });
  const anna = op(7, "Anna", "support");
  const lead = op(10, "Lena", "support", true);
  await sql`insert into crm_operators(id,name,role,is_lead) values (7,'Anna','support',false), (10,'Lena','support',true)`;
  const [tk] = await sql`insert into support_requests (user_tg, source, status) values (777, 'bot', 'resolved') returning id`;
  const id = tk!.id as string;
  const events = async (ticketId = id) => (await sql`select type, actor_operator_id, payload from crm_ticket_events
    where ticket_id = ${ticketId} and type = 'topic_changed' order by id`).map((e) => ({ actor: e.actor_operator_id, ...e.payload }));
  try {
    await t.test("seed: ten topics in order, idempotent on re-run", async () => {
      const { readFileSync } = await import("node:fs");
      await sql.unsafe(readFileSync(new URL("../migrations/0019_crm_topics.sql", import.meta.url), "utf8"));
      const list = await topics.listTopics();
      assert.deepEqual(list.map((x) => x.name), ["Пополнение не пришло", "Карта отклонена", "Выпуск карты",
        "KYC/верификация", "Antarctic", "Вывод/возврат", "Тарифы и цены", "Как пользоваться", "Жалоба", "Другое"]);
      assert.ok(list.every((x) => !x.archived));
    });

    await t.test("create/rename/archive: lead only, duplicates are a field error", async () => {
      await assert.rejects(topics.createTopic({ name: "Возврат" }, anna), { name: "Forbidden" });
      const created = await topics.createTopic({ name: "  Возврат комиссии " }, lead);
      assert.equal(created.name, "Возврат комиссии");
      assert.equal(created.position, 11);
      await assert.rejects(topics.createTopic({ name: "возврат КОМИССИИ" }, lead),
        (e: { issues?: Array<{ path: string[]; message: string }> }) => e.issues?.[0]?.message === "duplicate" && e.issues[0]!.path[0] === "name");
      const renamed = await topics.updateTopic(created.id, { name: "Комиссия" }, lead);
      assert.equal(renamed.name, "Комиссия");
      const archived = await topics.updateTopic(created.id, { archived: true }, lead);
      assert.equal(archived.archived, true);
      assert.equal((await topics.listTopics()).at(-1)!.name, "Комиссия"); // archived stay listed, last
      await assert.rejects(topics.updateTopic(created.id, { name: "x" }, anna), { name: "Forbidden" });
      await assert.rejects(topics.updateTopic(9999, { name: "x" }, lead), { name: "NotFound" });
      await assert.rejects(topics.updateTopic(2147483648, { name: "x" }, lead), { name: "NotFound" }); // above int4
    });

    await t.test("operator sets, changes and clears the topic; archived and unknown ids are refused", async () => {
      const list = await topics.listTopics();
      const card = list.find((x) => x.name === "Карта отклонена")!;
      const kyc = list.find((x) => x.name === "KYC/верификация")!;
      const archived = list.find((x) => x.archived)!;
      await topics.setTicketTopic(id, card.id, anna);
      await topics.setTicketTopic(id, card.id, anna); // same choice: no second event
      await topics.setTicketTopic(id, kyc.id, anna);
      for (const bad of [archived.id, 9999, 2147483648]) {
        await assert.rejects(topics.setTicketTopic(id, bad, anna),
          (e: { issues?: Array<{ path: string[]; message: string }> }) => e.issues?.[0]?.path[0] === "topic_id");
      }
      const d = await tickets.ticketDetail(id);
      assert.deepEqual([d!.ticket.topic_id, d!.ticket.topic_name, d!.ticket.topic_source], [kyc.id, "KYC/верификация", "operator"]);
      await topics.setTicketTopic(id, null, anna);
      await topics.setTicketTopic(id, null, anna); // clearing again: no second event
      const cleared = await tickets.ticketDetail(id);
      assert.deepEqual([cleared!.ticket.topic_id, cleared!.ticket.topic_source], [null, "operator"]);
      // Clearing is an operator choice: the AI may not fill it in, and resolving queues no topic job.
      assert.equal(await topics.applyAiTopic(id, card.id), false);
      await topics.enqueueTopicJob(sql, id);
      assert.equal((await sql`select 1 from support_agent_jobs where ticket_id = ${id} and kind = 'topic'`).length, 0);
      assert.deepEqual(await events(), [
        { actor: "7", from: null, to: "Карта отклонена", source: "operator" },
        { actor: "7", from: "Карта отклонена", to: "KYC/верификация", source: "operator" },
        { actor: "7", from: "KYC/верификация", to: null, source: "operator" },
      ]);
    });

    await t.test("AI applies only when no operator choice, never an archived topic", async () => {
      const [fresh] = await sql`insert into support_requests (user_tg, source, status) values (779, 'bot', 'resolved') returning id`;
      const id3 = fresh!.id as string;
      const list = await topics.listTopics();
      const topup = list.find((x) => x.name === "Пополнение не пришло")!;
      const other = list.find((x) => x.name === "Другое")!;
      const archived = list.find((x) => x.archived)!;
      assert.equal(await topics.applyAiTopic(id3, archived.id), false);
      assert.equal(await topics.applyAiTopic(id3, 2147483648), false); // above int4: unknown, not a 500
      assert.equal(await topics.applyAiTopic(id3, topup.id), true); // no topic and no operator choice: AI may set
      assert.equal(await topics.applyAiTopic(id3, topup.id), false); // same: no change, no event
      await topics.setTicketTopic(id3, other.id, anna);
      assert.equal(await topics.applyAiTopic(id3, topup.id), false); // operator choice wins
      const d = await tickets.ticketDetail(id3);
      assert.deepEqual([d!.ticket.topic_name, d!.ticket.topic_source], ["Другое", "operator"]);
      assert.deepEqual(await events(id3), [
        { actor: null, from: null, to: "Пополнение не пришло", source: "ai" },
        { actor: "7", from: "Пополнение не пришло", to: "Другое", source: "operator" },
      ]);
    });

    await t.test("enqueueTopicJob: one pending topic job at the last seq, none after an operator choice", async () => {
      const [t2] = await sql`insert into support_requests (user_tg, source, status) values (778, 'bot', 'resolved') returning id`;
      const id2 = t2!.id as string;
      await sql`insert into support_messages (ticket_id, sender, body, actor_type) values (${id2}, 'user', 'help', 'customer')`;
      await topics.enqueueTopicJob(sql, id2);
      await topics.enqueueTopicJob(sql, id2);
      const jobs = await sql`select kind, through_seq::int as seq from support_agent_jobs where ticket_id = ${id2} and kind = 'topic'`;
      const [{ max }] = await sql`select max(seq)::int as max from support_messages where ticket_id = ${id2}` as unknown as [{ max: number }];
      assert.deepEqual(jobs.map((j) => [j.kind, j.seq]), [["topic", max]]);
      await topics.enqueueTopicJob(sql, id); // ticket 1 has an operator topic
      const none = await sql`select 1 from support_agent_jobs where ticket_id = ${id} and kind = 'topic'`;
      assert.equal(none.length, 0);
    });

    await t.test("reserve: topic calls have their own 3-per-ticket-day allowance; $ caps still apply", async () => {
      const { AgentStore } = await import("../dist/agents/store.js");
      const store = new AgentStore(sql);
      const budget = { dailyUsd: 1000, monthlyUsd: 10000, ticketDailyCalls: 12 };
      let userTg = 780;
      const job = async (kind: string) => {
        const [tk] = await sql`insert into support_requests (user_tg, source, status) values (${++userTg}, 'bot', 'resolved') returning id`;
        const [j] = await sql`insert into support_agent_jobs (ticket_id, kind, through_seq) values (${tk!.id}, ${kind}, 0)
          returning id, ticket_id, kind, through_seq::int, gen_random_uuid() as lease_token`;
        return j as unknown as import("../dist/agents/store.js").Job;
      };
      const prior = async (j: { id: string; ticket_id: string }, task: string, n: number) => {
        for (let i = 0; i < n; i++) {
          await sql`insert into support_agent_calls (job_id, ticket_id, model, task, reserved_usd) values (${j.id}, ${j.ticket_id}, 'm', ${task}, 0)`;
        }
      };
      // 12 triage/review calls today exhaust the shared allowance but not the topic one.
      const busy = await job("topic");
      await prior(busy, "classify", 6);
      await prior(busy, "review", 6);
      await assert.rejects(store.reserve(busy, "m", "classify", 0, budget), /budget_exceeded/);
      await store.reserve(busy, "m", "topic", 0, budget);
      await prior(busy, "topic", 2);
      await assert.rejects(store.reserve(busy, "m", "topic", 0, budget), /budget_exceeded/); // 3 topic calls today
      // Topic calls never count against triage.
      const triage = await job("triage");
      await prior(triage, "topic", 3);
      await prior(triage, "classify", 11);
      await store.reserve(triage, "m", "classify", 0, budget);
      await assert.rejects(store.reserve(triage, "m", "classify", 0, budget), /budget_exceeded/);
      // The daily $ cap applies to topic calls too.
      const fresh = await job("topic");
      await assert.rejects(store.reserve(fresh, "m", "topic", 0.001, { ...budget, dailyUsd: 0.0001 }), /budget_exceeded/);
      await assert.rejects(store.reserve(fresh, "m", "topic", 0.001, { ...budget, monthlyUsd: 0.0001 }), /budget_exceeded/);
      await store.reserve(fresh, "m", "topic", 0.001, budget);
    });

    await t.test("daily digest: failed topic jobs are not analysis failures", async () => {
      const { OperationsStore } = await import("../dist/agents/operations-store.js");
      const ops = new OperationsStore(sql);
      const day = new Date().toISOString().slice(0, 10);
      const failures = async () => ((await ops.dailyReport(day)) as { analysis_failures: number }).analysis_failures;
      const [tk] = await sql`insert into support_requests (user_tg, source, status) values (790, 'bot', 'resolved') returning id`;
      const before = await failures();
      await sql`insert into support_agent_jobs (ticket_id, kind, through_seq, status, error_code, finished_at)
        values (${tk!.id}, 'topic', 1, 'failed', 'budget_exceeded', now())`;
      assert.equal(await failures(), before);
      await sql`insert into support_agent_jobs (ticket_id, kind, through_seq, status, error_code, finished_at)
        values (${tk!.id}, 'triage', 1, 'failed', 'analysis_failed', now())`;
      assert.equal(await failures(), before + 1);
    });
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
