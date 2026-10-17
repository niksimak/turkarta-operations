import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("video replies: schema survives the boot migration, reply stores and sends one video", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const dbMod = await import("../dist/db.js");
  const reply = await import("../dist/crm/reply.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  try {
    // Boot re-applies the CRM migrations; it must not put the photo-only checks back.
    await dbMod.ensureCrmSchema();
    await dbMod.ensureCrmSchema();

    const [t] = await sql`insert into support_requests (user_tg, first_message, status, waiting_since)
      values (777, 'hi', 'new', now()) returning id`;
    const ticketId = String(t!.id);
    const msg = async (kind: string) => (await sql`insert into support_messages (ticket_id, sender, body, kind)
      values (${ticketId}, 'agent', '', ${kind}) returning id`)[0]!.id as string;
    const attach = (messageId: string, mediaType: string, size: number) => sql`insert into support_attachments
      (message_id, media_type, filename, size_bytes, content) values (${messageId}, ${mediaType}, 'f', ${size}, ${Buffer.from([1])})`;

    const v = await msg("video");
    await attach(v, "video/mp4", 15 * 1024 * 1024);
    await attach(v, "video/quicktime", 20 * 1024 * 1024);
    await assert.rejects(attach(v, "video/mp4", 20 * 1024 * 1024 + 1), /support_attachments_size_check/);
    await assert.rejects(attach(v, "image/jpeg", 9 * 1024 * 1024), /support_attachments_size_check/, "photos keep 8 MB");
    await assert.rejects(attach(v, "video/x-msvideo", 100), /support_attachments_media_type_check/);
    await assert.rejects(msg("gif"), /support_messages_kind_check/);

    await sql`insert into crm_operators (id, name, role) values (7, 'Anna', 'support')`;
    const anna = {
      id: 7, name: "Anna", email: null, role: "support" as const, is_lead: false, auto_assign_enabled: true,
      on_shift: true, last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
    };
    const calls: Array<{ method: string; caption?: string }> = [];
    const tg = {
      async sendMessage() { calls.push({ method: "sendMessage" }); return { message_id: 1 }; },
      async sendPhoto() { throw new Error("no photos here"); },
      async sendMediaGroup() { throw new Error("no photos here"); },
      async sendVideo(_c: number, _v: unknown, caption?: string) {
        calls.push({ method: "sendVideo", caption });
        return { message_id: 2, fileId: "vid-1", fileUniqueId: "uvid-1" };
      },
    };
    const bytes = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypisom")]);
    const m = await reply.sendReply(ticketId, anna,
      { kind: "reply", body: "Смотрите видео", photos: [], video: { content: bytes, mediaType: "video/mp4", filename: "how.mp4" } },
      { tg });
    assert.equal(m.kind, "video");
    assert.equal(m.delivery_status, "sent");
    assert.deepEqual(calls, [{ method: "sendVideo", caption: "Смотрите видео" }]);
    const [a] = await sql`select media_type, size_bytes, tg_file_id from support_attachments where message_id = ${m.id}`;
    assert.deepEqual({ ...a }, { media_type: "video/mp4", size_bytes: bytes.length, tg_file_id: "vid-1" });
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0]!.media_type, "video/mp4");
  } finally {
    await dbMod.sql.end();
    await sql.end();
  }
});
