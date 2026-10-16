import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("crm schema: constraints, multi-attachment, backfill, idempotence, addMessage retry", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  try {
    // Pre-existing open ticket before the CRM migration would have run: simulate by clearing the backfilled column.
    const [t] = await sql`insert into support_requests(channel,web_user_id,source,first_message)
      values('web',${crypto.randomUUID()},'test','hi') returning id`;
    const ticketId = String(t!.id);
    await sql`update support_requests set queued_at = null where id = ${ticketId}`;

    const dbMod = await import("../dist/db.js");
    await dbMod.ensureCrmSchema();
    await dbMod.ensureCrmSchema();

    const [q] = await sql`select queued_at, created_at from support_requests where id = ${ticketId}`;
    assert.ok(q!.queued_at, "queued_at backfilled");

    const [m] = await sql`insert into support_messages(ticket_id,sender,body) values(${ticketId},'user','x') returning id`;
    const mid = String(m!.id);

    await assert.rejects(
      sql`insert into support_attachments(message_id,media_type,filename) values(${mid},'image/png','a.png')`,
      (e: any) => e.code === "23514",
    );
    await sql`insert into support_attachments(message_id,media_type,filename,size_bytes,content)
      values(${mid},'image/png','a.png',3,${Buffer.from([1, 2, 3])})`;
    await sql`insert into support_attachments(message_id,media_type,filename,tg_file_id,position)
      values(${mid},'image/png','b.png','tgfile',1)`;
    const [{ n }] = await sql`select count(*)::int as n from support_attachments where message_id = ${mid}` as any;
    assert.equal(n, 2);

    await assert.rejects(
      sql`insert into support_messages(ticket_id,sender,body,kind) values(${ticketId},'user','x','bogus')`,
      (e: any) => e.code === "23514",
    );

    // Retried web photo (same source id) must not double-attach.
    const photo = { content: new Uint8Array([1, 2, 3]), mediaType: "image/png", filename: "p.png" };
    const first = await dbMod.addMessage(ticketId, "user", "pic", photo, { sourceId: "web:retry-1" });
    const second = await dbMod.addMessage(ticketId, "user", "pic", photo, { sourceId: "web:retry-1" });
    assert.equal(first.id, second.id);
    assert.ok(second.attachment_id);
    assert.equal(second.attachment_id, first.attachment_id);
    const [{ c }] = await sql`select count(*)::int as c from support_attachments where message_id = ${first.id}` as any;
    assert.equal(c, 1);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
