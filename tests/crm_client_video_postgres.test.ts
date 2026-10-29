import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("client videos: Telegram rows by file id, web rows by bucket key, both at most 20 MB", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    SUPPORT_SURFACE: "crm",
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const dbMod = await import("../dist/db.js");
  try {
    await dbMod.ensureCrmSchema();
    await dbMod.ensureCrmSchema();
    const [t] = await sql`insert into support_requests (user_tg, first_message, status, waiting_since)
      values (778, 'hi', 'new', now()) returning id`;
    const [m] = await sql`insert into support_messages (ticket_id, sender, body, kind)
      values (${t!.id}, 'user', '', 'video') returning id`;
    const row = (fields: { size: number; key?: string; tg?: string }) => sql`insert into support_attachments
      (message_id, media_type, filename, size_bytes, storage_key, tg_file_id)
      values (${m!.id}, 'video/mp4', 'v.mp4', ${fields.size}, ${fields.key ?? null}, ${fields.tg ?? null})`;

    await row({ size: 20 * 1024 * 1024, key: "support/video/a/v.mp4" });
    await assert.rejects(row({ size: 20 * 1024 * 1024 + 1, key: "k" }), /support_attachments_size_check/);
    await row({ size: 20 * 1024 * 1024, tg: "f1" });
    await assert.rejects(row({ size: 20 * 1024 * 1024 + 1, tg: "f2" }), /support_attachments_size_check/);
    await assert.rejects(sql`insert into support_attachments (message_id, media_type, filename)
      values (${m!.id}, 'video/mp4', 'v.mp4')`, /support_attachments_source_check/);

    // recordUserMessage stores a Telegram video by file id and a web video by bucket key; an album keeps both kinds.
    const inbound = await import("../dist/crm/inbound.js");
    const [tk] = await sql`insert into support_requests (user_tg, first_message, status, waiting_since)
      values (779, 'hi', 'allocated', now()) returning *`;
    const ticket = tk as unknown as import("../dist/db.js").Ticket;
    const first = await inbound.recordUserMessage(ticket, {
      kind: "video", body: "", mediaGroupId: "alb",
      tgVideo: { fileId: "tv-1", fileUniqueId: "utv-1", mediaType: "video/quicktime", filename: "video.mov" },
    }, { authorId: "tg:779", sourceId: "tg:779:1" });
    const second = await inbound.recordUserMessage(ticket, {
      kind: "photo", body: "", mediaGroupId: "alb", tgPhoto: { fileId: "tp-1", fileUniqueId: "utp-1" },
    }, { authorId: "tg:779", sourceId: "tg:779:2" });
    assert.equal(second.appendedToAlbum, true);
    assert.equal(second.messageId, first.messageId);
    const album = await sql`select media_type, filename, tg_file_id from support_attachments
      where message_id = ${first.messageId} order by position`;
    assert.deepEqual(album.map((r) => ({ ...r })), [
      { media_type: "video/quicktime", filename: "video.mov", tg_file_id: "tv-1" },
      { media_type: "image/jpeg", filename: "photo.jpg", tg_file_id: "tp-1" },
    ]);
    const [msg] = await sql`select kind, body from support_messages where id = ${first.messageId}`;
    assert.deepEqual({ ...msg }, { kind: "video", body: "🎬 [видео]" });

    const web = await inbound.recordUserMessage(ticket, {
      kind: "video", body: "вот",
      webVideo: { storageKey: "support/video/b/clip.webm", mediaType: "video/webm", filename: "clip.webm", sizeBytes: 15 * 1024 * 1024 },
    }, { authorId: "web:x" });
    const [w] = await sql`select media_type, size_bytes, storage_key, content from support_attachments where message_id = ${web.messageId}`;
    assert.deepEqual({ ...w }, { media_type: "video/webm", size_bytes: 15 * 1024 * 1024, storage_key: "support/video/b/clip.webm", content: null });

    const [a] = await sql`select a.id from support_attachments a where storage_key = 'support/video/a/v.mp4'`;
    const att = await dbMod.supportAttachment(String(a!.id));
    assert.equal(att!.storage_key, "support/video/a/v.mp4");
    assert.equal(att!.content, null);
  } finally {
    await dbMod.sql.end();
    await sql.end();
  }
});
