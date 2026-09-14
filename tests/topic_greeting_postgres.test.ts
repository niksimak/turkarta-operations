import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { TopicGreetingStore } from "../src/topic-greeting-store.js";
import { AgentStore, type Job } from "../src/agents/store.js";

const socket = process.env.SUPPORT_AI_TEST_SOCKET;
test("greeting DB: concurrent dedup, first-message scope, automation attribution and AI freshness", { skip: !socket }, async () => {
  assert.match(socket!, /^\/private\/tmp\/turkarta-support-ai-[a-zA-Z0-9_-]+$/);
  const options = { host: socket, port: 55437, username: userInfo().username, max: 5, onnotice: () => {} };
  const admin = postgres({ ...options, database: "postgres" });
  const name = `greeting_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(name)}`;
  const sql = postgres({ ...options, database: name });
  const store = new TopicGreetingStore(sql);
  const agents = new AgentStore(sql);
  async function ticket(channel = "web") {
    const [row] = await sql`insert into support_requests(channel,web_user_id,user_tg,source,first_message)
      values(${channel},${channel === "web" ? crypto.randomUUID() : null},${channel === "telegram" ? 123456 : null},'test','Вопрос') returning id`;
    return String(row!.id);
  }
  async function message(id: string, body: string, actor = "customer") {
    const [row] = await sql`insert into support_messages(ticket_id,sender,body,actor_type)
      values(${id},${actor === "customer" ? "user" : "agent"},${body},${actor}) returning id,seq`;
    return row!;
  }
  try {
    for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) {
      await sql.unsafe(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    const id = await ticket(); const first = await message(id, "Пополнение не пришло");
    const claims = await Promise.all([store.prepare(id, String(first.id)), store.prepare(id, String(first.id))]);
    assert.equal(claims.filter(Boolean).length, 1);
    const [greeting] = await sql`select * from support_topic_greetings where ticket_id=${id}`;
    assert.equal(greeting!.status, "sent"); assert.equal(greeting!.topic, "payment");
    const replies = await sql`select actor_type,source_message_id from support_messages where ticket_id=${id} and sender='agent'`;
    assert.equal(replies.length, 1); assert.equal(replies[0]!.actor_type, "automation");
    assert.equal((await sql`select id from support_agent_jobs where ticket_id=${id} and kind='review'`).length, 0);
    const [job] = await sql<Job[]>`update support_agent_jobs set status='running',lease_token=gen_random_uuid()
      where ticket_id=${id} and kind='triage' returning *`;
    await agents.finish(job!, { draft_reply_ru: "Проверка" });
    let result = (await agents.results(id))[0]!;
    assert.equal(result.status, "completed"); assert.equal(result.stale, false, "automatic greeting cannot invalidate triage");
    const followup = await message(id, "Ещё вопрос");
    assert.equal(await store.prepare(id, String(followup.id)), null);
    assert.equal((await agents.results(id)).find(r => r.id === job!.id)!.stale, true);

    const old = await ticket(); await message(old, "Первый вопрос до включения");
    const next = await message(old, "Повторный вопрос");
    assert.equal(await store.prepare(old, String(next.id)), null, "do not greet ongoing conversations");
    const stale = await ticket(); const staleMessage = await message(stale, "Старое обращение");
    await sql`update support_messages set created_at=now()-interval '1 hour' where id=${staleMessage.id}`;
    assert.equal(await store.prepare(stale, String(staleMessage.id)), null, "a retry must not greet an old first message");
    const closed = await ticket(); const closedMessage = await message(closed, "Закрыто");
    await sql`update support_requests set status='resolved' where id=${closed}`;
    assert.equal(await store.prepare(closed, String(closedMessage.id)), null);
    const handled = await ticket(); const request = await message(handled, "Помогите");
    await message(handled, "Оператор уже ответил", "human");
    assert.equal(await store.prepare(handled, String(request.id)), null);
    const welcome = await ticket(); await message(welcome, "Добро пожаловать", "automation");
    const actual = await message(welcome, "Не проходит KYC");
    assert.equal((await store.prepare(welcome, String(actual.id)))!.topic, "kyc");
    assert.equal(await store.prepare(welcome, String(request.id)), null, "never use another ticket's message");

    const tg = await ticket("telegram"); const tgFirst = await message(tg, "Карта не работает");
    assert.equal((await store.prepare(tg, String(tgFirst.id)))!.userTg, 123456);
    assert.equal((await sql`select id from support_messages where ticket_id=${tg} and sender='agent'`).length, 0);
    await store.delivered(tg, "777"); await store.delivered(tg, "777");
    assert.equal((await sql`select id from support_messages where ticket_id=${tg} and actor_type='automation'`).length, 1);
    assert.equal(await store.prepare(tg, String(tgFirst.id)), null);
  } finally {
    await sql.end(); await admin`drop database ${admin(name)}`; await admin.end();
  }
});
