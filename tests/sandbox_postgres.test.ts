import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const socket = process.env.SUPPORT_AI_TEST_SOCKET;
test("sandbox DB: isolated tickets enqueue analysis; merged photo/metadata writes remain idempotent", { skip: !socket }, async () => {
  assert.match(socket!, /^\/private\/tmp\/turkarta-support-ai-[a-zA-Z0-9_-]+$/);
  const username = userInfo().username;
  const admin = postgres({ host: socket, port: 55437, username, database: "postgres", onnotice: () => {} });
  const database = `support_ai_sandbox_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(database)}`;
  Object.assign(process.env, { SUPPORT_RUNTIME: "sandbox", DATABASE_URL: `postgres://${username}@127.0.0.1:55437/${database}`,
    PUBLIC_BASE_URL: "https://dev.example" });
  const db = await import("../dist/db.js");
  const { sandboxStore } = await import("../dist/agents/sandbox-store.js");
  try {
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter(f => f.endsWith(".sql")).sort();
    for (const name of migrations) await db.sql.unsafe(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const id = await sandboxStore.create("Как добавить карту в Wallet?");
    const ticket = await db.getTicket(id);
    assert.equal(ticket!.source, "support-ai-dev");
    assert.equal(ticket!.user_tg, null);
    assert.equal(await sandboxStore.append(id, "human", "Проверим инструкцию"), true);
    const jobs = await db.sql`select kind from support_agent_jobs where ticket_id=${id} order by kind`;
    assert.deepEqual(jobs.map(x => x.kind), ["review", "triage"]);
    await db.sql`update support_requests set source='web' where id=${id}`;
    assert.equal(await sandboxStore.append(id, "customer", "Must not modify ordinary tickets"), false);

    const photo = { content: Uint8Array.from([1, 2, 3]), mediaType: "image/jpeg", filename: "test.jpg" };
    const meta = { authorId: "sandbox:customer", sourceId: "dedup-photo-test" };
    const first = await db.addMessage(id, "user", "Фото", photo, meta);
    const duplicate = await db.addMessage(id, "user", "Фото", photo, meta);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.attachment_id, duplicate.attachment_id);
    const [counts] = await db.sql`select
      (select count(*)::int from support_attachments where message_id=${first.id}) as attachments,
      (select count(*)::int from support_agent_jobs where ticket_id=${id} and through_seq=${first.seq}) as jobs`;
    assert.deepEqual(counts, { attachments: 1, jobs: 1 });
  } finally {
    await db.sql.end({ timeout: 5 });
    await admin`drop database ${admin(database)}`;
    await admin.end({ timeout: 5 });
  }
});
