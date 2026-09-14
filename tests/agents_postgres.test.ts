import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { AgentStore } from "../src/agents/store.js";

const socket = process.env.SUPPORT_AI_TEST_SOCKET;
test("PostgreSQL: migrations, deduplication, leases, stale results and concurrent budget reservations", { skip: !socket }, async () => {
  // This test only accepts the disposable cluster created for this task.
  assert.match(socket!, /^\/private\/tmp\/turkarta-support-ai-[a-zA-Z0-9_-]+$/);
  const options = { host: socket, port: 55437, username: userInfo().username, max: 5, onnotice: () => {} };
  const admin = postgres({ ...options, database: "postgres" });
  const database = `support_ai_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(database)}`;
  const sql = postgres({ ...options, database });
  try {
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort();
    for (const file of migrations) await sql.unsafe(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    await sql.unsafe(await readFile(new URL("../migrations/0012_support_agents.sql", import.meta.url), "utf8"));
    const [ticket] = await sql`insert into support_requests(user_tg,first_message) values(99887766,'Тест') returning id`;
    const id = String(ticket!.id);
    const store = new AgentStore(sql);
    const [first] = await sql`insert into support_messages(ticket_id,sender,body,actor_type,source_message_id)
      values(${id},'user','CSB 500','customer','test-first') returning seq`;
    await sql`insert into support_messages(ticket_id,sender,body,actor_type,source_message_id)
      values(${id},'user','CSB 500','customer','test-first')
      on conflict(source_message_id) where source_message_id is not null
      do update set source_message_id=support_messages.source_message_id`;
    let [count] = await sql`select count(*)::int as n from support_agent_jobs where ticket_id=${id}`;
    assert.equal(count!.n, 1, "duplicate provider event must not schedule twice");
    await sql`insert into support_messages(ticket_id,sender,body,actor_type)
      values(${id},'agent','Автоматическое приветствие','automation')`;
    [count] = await sql`select count(*)::int as n from support_agent_jobs where ticket_id=${id}`;
    assert.equal(count!.n, 1, "automation must not trigger human QA");
    await sql`insert into support_messages(ticket_id,sender,body,actor_type,author_id)
      values(${id},'agent','Проверяем','human','tg:123')`;
    await sql`update support_agent_jobs set available_at=now() where ticket_id=${id}`;
    const claimed = await Promise.all([store.claim(), store.claim()]);
    assert.ok(claimed[0] && claimed[1]);
    assert.notEqual(claimed[0].id, claimed[1].id, "concurrent workers claim different jobs");
    const triage = claimed.find((j) => j?.kind === "triage")!;
    const qa = claimed.find((j) => j?.kind === "review")!;
    assert.equal(Number(triage.through_seq), Number(first!.seq));
    const transcript = await store.transcript(qa);
    assert.equal(transcript.messages.at(-1)?.author_id, "tg:123");
    assert.equal(transcript.truncated, false);
    await store.finish(triage, { draft_reply_ru: "Проверка" });
    const results = await store.results(id);
    assert.equal(results.find((r) => r.id === triage.id)?.status, "superseded", "human reply invalidates older draft");

    const budget = { dailyUsd: 0.0015, monthlyUsd: 0.0015, ticketDailyCalls: 12 };
    const reservations = await Promise.allSettled([
      store.reserve(qa, "gpt-5.4-nano", "review", 0.001, budget),
      store.reserve(qa, "gpt-5.4-nano", "review", 0.001, budget),
    ]);
    assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1, "concurrent reservations cannot overspend");
    const fulfilled = reservations.find((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")!;
    await store.settle(fulfilled.value, 0.0001, 100, 10, 100);
    await store.reserve(qa, "gpt-5.4-nano", "review", 0.001, budget);
    await assert.rejects(store.reserve(qa, "gpt-5.4-nano", "review", 0.0001,
      { dailyUsd: 1, monthlyUsd: 1, ticketDailyCalls: 2 }), /budget_exceeded/);

    await sql`update support_agent_jobs set lease_until=now()-interval '1 second' where id=${qa.id}`;
    const renewed = await store.claim();
    assert.equal(renewed?.id, qa.id);
    assert.notEqual(renewed?.lease_token, qa.lease_token);
    await store.finish(qa, { obsolete: true });
    const [pending] = await sql`select result from support_agent_jobs where id=${qa.id}`;
    assert.equal(pending!.result, null, "old lease cannot publish a result");
    await store.finish(renewed!, { summary_ru: "Проверено" });
    assert.equal(await store.feedback(qa.id, { verdict: "accepted" }), true);

    await sql`insert into support_messages(ticket_id,sender,body,actor_type)
      values(${id},'user','Ещё вопрос','customer'),(${id},'user','Уточнение','customer')`;
    await sql`update support_agent_jobs set available_at=now() where ticket_id=${id}`;
    const latest = await store.claim();
    assert.ok(latest);
    const [queue] = await sql`select count(*)::int as n from support_agent_jobs where ticket_id=${id} and status='pending'`;
    assert.equal(queue!.n, 0, "rapid message fragments supersede obsolete queued triage");
    await store.finish(latest!, {});

    await sql`update support_requests set status='allocated' where id=${id}`;
    await sql`update support_requests set status='resolved' where id=${id}`;
    const closedReview = await store.claim();
    assert.equal(closedReview?.kind, "review", "resolution schedules a conversation review");
  } finally {
    await sql.end({ timeout: 5 });
    await admin`drop database ${admin(database)}`;
    await admin.end({ timeout: 5 });
  }
});
