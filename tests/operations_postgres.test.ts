import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import postgres from "postgres";
import { OperationsStore } from "../src/agents/operations-store.js";
import { deliverOne } from "../src/agents/operations-delivery.js";
import { AgentStore } from "../src/agents/store.js";
import type { OperationsOptions } from "../src/agents/operations-contracts.js";

const socket = process.env.SUPPORT_AI_TEST_SOCKET;
test("PostgreSQL: atomic internal tasks, authorized actions, reminders, delivery uncertainty and QA summaries", { skip: !socket }, async () => {
  assert.match(socket!, /^\/private\/tmp\/turkarta-support-ai-[a-zA-Z0-9_-]+$/);
  const settings = { host: socket, port: 55437, username: userInfo().username, max: 5, onnotice: () => {} };
  const admin = postgres({ ...settings, database: "postgres" });
  const database = `support_ai_ops_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(database)}`;
  const sql = postgres({ ...settings, database });
  const options: OperationsOptions = { chatId: -100101, qaChatId: -100102, routes: {
    support: { primary_tg: 111, backup_tg: 222 }, payments: { primary_tg: 111, backup_tg: 222 } },
    acknowledgeMinutes: 10, updateMinutes: 60, maxReminders: 3, digestHourUtc: 4 };
  try {
    for (const f of (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort()) {
      await sql.unsafe(await readFile(new URL(`../migrations/${f}`,import.meta.url),"utf8"));
    }
    await sql.unsafe(await readFile(new URL("../migrations/0013_support_agent_operations.sql",import.meta.url),"utf8"));
    const store = new OperationsStore(sql);
    const [ticket] = await sql`insert into support_requests(user_tg,first_message) values(12345,'CSB 500') returning id`;
    const ticketId = String(ticket!.id);
    await sql`insert into support_messages(ticket_id,sender,actor_type,body) values(${ticketId},'user','customer','CSB 500')`;
    const snapshot = { classification: { summary_ru: "CSB вернул 500 при пополнении" },
      diagnostics: { summary_ru: "Прочитан внутренний снимок. Результат зачисления требует сверки." },
      policy: { teams: ["payments"], money_related: true, off_topic_only: false } };
    await sql`update support_agent_jobs set status='completed',finished_at=now(),result=${sql.json(snapshot)} where ticket_id=${ticketId}`;
    const materialized = await Promise.all([store.materialize(options),store.materialize(options)]);
    assert.equal(materialized.filter(Boolean).length,1);
    const [task] = await sql`select * from support_agent_tasks where ticket_id=${ticketId}`;
    const taskId = String(task!.id);
    assert.match(task!.summary_ru, /внутренний снимок/);
    let [count] = await sql`select count(*)::int as n from support_agent_notifications`;
    assert.equal(count!.n,1);
    await sql`update support_agent_jobs set operations_processed_at=null where ticket_id=${ticketId}`;
    await store.materialize(options);
    [count] = await sql`select count(*)::int as n from support_agent_notifications`;
    assert.equal(count!.n,1,"reprocessing must not duplicate an unchanged task");
    await deliverOne(store,{ async send(chat) { assert.equal(chat,options.chatId); return 432; } },options);
    assert.equal(await store.callbackBelongs(taskId,options.chatId,432),true);
    assert.equal(await store.callbackBelongs(taskId,-99,432),false);

    assert.equal(await store.act(taskId,999,"accept","","unauthorized",60),"denied");
    const claims = await Promise.all([store.act(taskId,111,"accept","","claim-primary",60),store.act(taskId,222,"accept","","claim-backup",60)]);
    assert.equal(claims.filter((r)=>r==="ok").length,1);
    const owner = Number((await store.task(taskId))!.owner_tg);
    assert.equal(await store.act(taskId,owner,"done","","empty-outcome",60),"denied");
    assert.equal(await store.act(taskId,999,"update","Проверил","wrong-owner",60),"denied");

    await sql`update support_agent_tasks set due_at=now()-interval '2 minutes' where id=${taskId}`;
    const originalDue = new Date((await store.task(taskId))!.due_at).toISOString();
    await Promise.all([store.scheduleReminders(options),store.scheduleReminders(options)]);
    assert.equal((await store.task(taskId))!.reminder_count,1,"concurrent workers schedule one reminder");
    assert.equal(new Date((await store.task(taskId))!.due_at).toISOString(),originalDue,"reminders do not rewrite missed deadlines");
    await store.act(taskId,owner,"update","Запрошено подтверждение провайдера","operator-update",60);
    await deliverOne(store,{ async send() { assert.fail("obsolete reminder must be cancelled"); } },options);
    assert.equal(await store.act(taskId,owner,"update","Повтор доставки команды","operator-update",60),"duplicate");
    assert.equal(await store.act(taskId,owner,"done","Оператор проверил зачисление вручную","operator-done",60),"ok");
    const [customerTicket] = await sql`select status from support_requests where id=${ticketId}`;
    assert.equal(customerTicket!.status,"new","internal closure cannot resolve a customer conversation");

    // A failed model run still creates accountable fallback work.
    await sql`insert into support_messages(ticket_id,sender,actor_type,body) values(${ticketId},'user','customer','Новый вопрос')`;
    await sql`update support_agent_jobs set status='failed',finished_at=now(),error_code='budget_exceeded'
      where ticket_id=${ticketId} and status='pending'`;
    await store.materialize(options);
    const [fallback] = await sql`select * from support_agent_tasks where ticket_id=${ticketId} and status='assigned'`;
    assert.equal(fallback!.team,"support");
    const inFlight = await store.claimNotification();
    assert.ok(inFlight);
    await sql`update support_agent_notifications set lease_until=now()-interval '1 second' where id=${inFlight!.id}`;
    assert.equal(await store.claimNotification(),null,"ambiguous send lease is not retried");
    const [unknown] = await sql`select status from support_agent_notifications where id=${inFlight!.id}`;
    assert.equal(unknown!.status,"unknown");

    await sql`insert into support_messages(ticket_id,sender,actor_type,author_id,body)
      values(${ticketId},'agent','human','tg:111','Просто заплатите снова')`;
    const [review] = await sql`update support_agent_jobs set status='completed',finished_at=now(),result=${sql.json({
      summary_ru: "Рекомендация повторить оплату требует проверки", assessments: [{ verdict: "critical", attribution_incomplete: false }],
    })} where ticket_id=${ticketId} and kind='review' returning id`;
    await store.materialize(options);
    const today = new Date().toISOString().slice(0,10);
    const before = await store.dailyReport(today);
    assert.equal(before.reviewed_conversations,1);
    assert.equal(before.critical_candidates,1);
    const agentStore = new AgentStore(sql);
    await agentStore.feedback(String(review!.id), { verdict: "rejected", comment_ru: "Нужна проверка фактов" });
    await agentStore.feedback(String(review!.id), { verdict: "rejected", comment_ru: "Уточнение руководителя" });
    const after = await store.dailyReport(today);
    assert.equal(after.critical_candidates,0);
    [count] = await sql`select count(*)::int as n from support_agent_review_feedback_events where job_id=${review!.id}`;
    assert.equal(count!.n,2,"feedback changes preserve audit history");
    assert.equal(await store.claimNotification(),null,"rejected finding must not alert a supervisor");

    const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime()+86400000+5*3600000);
    await Promise.all([store.scheduleDigest(options,tomorrow),store.scheduleDigest(options,tomorrow)]);
    [count] = await sql`select count(*)::int as n from support_agent_notifications where kind='digest'`;
    assert.equal(count!.n,1,"one digest per supervisor group/day");
    await sql`update support_requests set status='resolved' where id=${ticketId}`;
    await store.scheduleReminders(options);
    assert.equal((await store.task(String(fallback!.id)))!.status,"cancelled");
  } finally {
    await sql.end({timeout:5}); await admin`drop database ${admin(database)}`; await admin.end({timeout:5});
  }
});
