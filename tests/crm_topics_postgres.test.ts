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
  const events = async () => (await sql`select type, actor_operator_id, payload from crm_ticket_events
    where ticket_id = ${id} and type = 'topic_changed' order by id`).map((e) => ({ actor: e.actor_operator_id, ...e.payload }));
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
    });

    await t.test("operator sets, changes and clears the topic; archived and unknown ids are refused", async () => {
      const list = await topics.listTopics();
      const card = list.find((x) => x.name === "Карта отклонена")!;
      const kyc = list.find((x) => x.name === "KYC/верификация")!;
      const archived = list.find((x) => x.archived)!;
      await topics.setTicketTopic(id, card.id, anna);
      await topics.setTicketTopic(id, card.id, anna); // same choice: no second event
      await topics.setTicketTopic(id, kyc.id, anna);
      for (const bad of [archived.id, 9999]) {
        await assert.rejects(topics.setTicketTopic(id, bad, anna),
          (e: { issues?: Array<{ path: string[]; message: string }> }) => e.issues?.[0]?.path[0] === "topic_id");
      }
      const d = await tickets.ticketDetail(id);
      assert.deepEqual([d!.ticket.topic_id, d!.ticket.topic_name, d!.ticket.topic_source], [kyc.id, "KYC/верификация", "operator"]);
      await topics.setTicketTopic(id, null, anna);
      const cleared = await tickets.ticketDetail(id);
      assert.deepEqual([cleared!.ticket.topic_id, cleared!.ticket.topic_source], [null, null]);
      assert.deepEqual(await events(), [
        { actor: "7", from: null, to: "Карта отклонена", source: "operator" },
        { actor: "7", from: "Карта отклонена", to: "KYC/верификация", source: "operator" },
        { actor: "7", from: "KYC/верификация", to: null, source: "operator" },
      ]);
    });

    await t.test("AI applies only when no operator choice, never an archived topic", async () => {
      await sql`delete from crm_ticket_events where ticket_id = ${id}`;
      const list = await topics.listTopics();
      const topup = list.find((x) => x.name === "Пополнение не пришло")!;
      const other = list.find((x) => x.name === "Другое")!;
      const archived = list.find((x) => x.archived)!;
      assert.equal(await topics.applyAiTopic(id, archived.id), false);
      assert.equal(await topics.applyAiTopic(id, topup.id), true); // topic was cleared above: AI may set
      assert.equal(await topics.applyAiTopic(id, topup.id), false); // same: no change, no event
      await topics.setTicketTopic(id, other.id, anna);
      assert.equal(await topics.applyAiTopic(id, topup.id), false); // operator choice wins
      const d = await tickets.ticketDetail(id);
      assert.deepEqual([d!.ticket.topic_name, d!.ticket.topic_source], ["Другое", "operator"]);
      assert.deepEqual(await events(), [
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
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
