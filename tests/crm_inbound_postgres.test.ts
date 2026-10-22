import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("inbound capture: albums, timers, reopen, idempotent retries, events", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    // Reopen is CRM-mode behaviour; bitrix mode is covered in crm_reopen_postgres.test.ts.
    SUPPORT_SURFACE: "crm",
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const inbound = await import("../dist/crm/inbound.js");
  const db = await import("../dist/db.js");
  type Part = import("../dist/crm/inbound.js").InboundPart;

  const events: Array<Record<string, unknown>> = [];
  const listener = await sql.listen("crm_events", (p) => { events.push(JSON.parse(p)); });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  let userSeq = 1000;
  async function ticket(fields: Record<string, unknown> = {}) {
    const row = { user_tg: ++userSeq, user_name: "Иван", source: "bot", first_message: "help", ...fields };
    const [r] = await sql`insert into support_requests ${sql(row)} returning *`;
    return r as unknown as import("../dist/db.js").Ticket;
  }
  const photo = (id: string, group?: string): Part => ({
    kind: "photo", body: "", tgPhoto: { fileId: `f-${id}`, fileUniqueId: `u-${id}` },
    ...(group ? { mediaGroupId: group } : {}),
  });
  const meta = (tk: { user_tg: number | null }, id: string) => ({ authorId: `tg:${tk.user_tg}`, sourceId: `tg:${tk.user_tg}:${id}` });
  const count = async (q: string, ...args: unknown[]) =>
    ((await sql.unsafe(q, args as never[]))[0] as { n: number }).n;

  try {
    await sql`insert into crm_operators (id, name, role, on_shift) values (7, 'Anna', 'support', true), (8, 'Boris', 'support', false)`;

    await t.test("openTicket and openWebTicket stamp queued_at and last_message_at", async () => {
      const tg = await db.openTicket({ user_tg: 1, user_username: null, user_name: null, source: "bot", request: "hi" });
      const web = await db.openWebTicket({ web_user_id: "w-1", user_name: null, source: "web", request: "hi" });
      for (const id of [tg.id, web.id]) {
        const [r] = await sql`select queued_at, last_message_at from support_requests where id = ${id}`;
        assert.ok(r!.queued_at instanceof Date && r!.last_message_at instanceof Date);
      }
    });

    await t.test("openWebTicket stores segment and org_name; a second open keeps the first mark", async () => {
      const a = await db.openWebTicket({ web_user_id: "biz:cu1", user_name: "Ольга", source: "web", request: "q", segment: "business_owner", org_name: "Travelata" });
      assert.equal(a.segment, "business_owner"); assert.equal(a.org_name, "Travelata");
      const b = await db.openWebTicket({ web_user_id: "biz:cu1", user_name: null, source: "web", request: "q2", segment: "business_admin", org_name: "Other" });
      assert.equal(b.id, a.id); assert.equal(b.segment, "business_owner"); assert.equal(b.org_name, "Travelata");
      const legacy = await db.openWebTicket({ web_user_id: "u-old", user_name: null, source: "web", request: "q" });
      assert.equal(legacy.segment, null);
    });

    await t.test("(a) 3-part album within 10 s → 1 message, 3 attachments at positions 0..2", async () => {
      const tk = await ticket();
      const res = [];
      for (const [i, id] of ["a1", "a2", "a3"].entries()) res.push(await inbound.recordUserMessage(tk, photo(id, "g-a"), meta(tk, String(i))));
      assert.deepEqual(res.map((r) => r.appendedToAlbum), [false, true, true]);
      assert.equal(new Set(res.map((r) => r.messageId)).size, 1);
      const msgs = await sql`select id, kind, body, tg_media_group_id from support_messages where ticket_id = ${tk.id}`;
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0]!.kind, "photo");
      assert.equal(msgs[0]!.body, "📷 [фото]");
      assert.equal(msgs[0]!.tg_media_group_id, "g-a");
      const atts = await sql`select position, tg_file_id, content from support_attachments where message_id = ${msgs[0]!.id} order by position`;
      assert.deepEqual(atts.map((a) => [a.position, a.tg_file_id, a.content]), [[0, "f-a1", null], [1, "f-a2", null], [2, "f-a3", null]]);
      assert.equal(res[2]!.attachment!.filename, "photo.jpg");

      // Webhook retries of the first part and of an appended part change nothing.
      const again = await inbound.recordUserMessage(tk, photo("a1", "g-a"), meta(tk, "0"));
      const againPart = await inbound.recordUserMessage(tk, photo("a2", "g-a"), meta(tk, "1"));
      assert.equal(again.messageId, res[0]!.messageId);
      assert.equal(againPart.messageId, res[0]!.messageId);
      assert.equal(await count("select count(*)::int n from support_attachments where message_id = $1", res[0]!.messageId), 3);
    });

    await t.test("(b) 11th album photo starts a new message; a stale album starts a new message", async () => {
      const tk = await ticket();
      const ids = [];
      for (let i = 0; i < 11; i++) ids.push((await inbound.recordUserMessage(tk, photo(`b${i}`, "g-b"), meta(tk, `b${i}`))).messageId);
      assert.equal(new Set(ids.slice(0, 10)).size, 1);
      assert.notEqual(ids[10], ids[0]);
      assert.equal(await count("select count(*)::int n from support_attachments where message_id = $1", ids[0]), 10);
      assert.equal(await count("select count(*)::int n from support_messages where ticket_id = $1", tk.id), 2);

      const tk2 = await ticket();
      const first = await inbound.recordUserMessage(tk2, photo("s1", "g-s"), meta(tk2, "s1"));
      await sql`update support_messages set created_at = now() - interval '11 seconds' where id = ${first.messageId}`;
      const late = await inbound.recordUserMessage(tk2, photo("s2", "g-s"), meta(tk2, "s2"));
      assert.equal(late.appendedToAlbum, false);
      assert.notEqual(late.messageId, first.messageId);
    });

    await t.test("(c) awaiting → allocated; waiting_since set once; text/unsupported kinds stored", async () => {
      const tk = await ticket({ status: "awaiting", assigned_operator_id: 7 });
      const r1 = await inbound.recordUserMessage(tk, { kind: "text", body: "Ау" }, meta(tk, "c1"));
      const [s1] = await sql`select status, waiting_since, last_message_at from support_requests where id = ${tk.id}`;
      assert.equal(s1!.status, "allocated");
      assert.ok(s1!.waiting_since instanceof Date);
      await new Promise((r) => setTimeout(r, 20));
      await inbound.recordUserMessage(tk, { kind: "unsupported", body: "", unsupportedType: "voice" }, meta(tk, "c2"));
      const [s2] = await sql`select waiting_since, last_message_at from support_requests where id = ${tk.id}`;
      assert.equal(s2!.waiting_since.getTime(), s1!.waiting_since.getTime());
      assert.ok(s2!.last_message_at.getTime() > s1!.last_message_at.getTime());
      const rows = await sql`select kind, unsupported_type, body, actor_type, author_id, source_message_id
        from support_messages where ticket_id = ${tk.id} order by seq`;
      assert.deepEqual(rows.map((r) => ({ ...r })), [
        { kind: "text", unsupported_type: null, body: "Ау", actor_type: "customer", author_id: `tg:${tk.user_tg}`, source_message_id: `tg:${tk.user_tg}:c1` },
        { kind: "unsupported", unsupported_type: "voice", body: "🎤 [голосовое]", actor_type: "customer", author_id: `tg:${tk.user_tg}`, source_message_id: `tg:${tk.user_tg}:c2` },
      ]);

      // A retried update must not move timers or emit events.
      await settle();
      const before = events.length;
      const [t0] = await sql`select last_message_at from support_requests where id = ${tk.id}`;
      const dup = await inbound.recordUserMessage(tk, { kind: "text", body: "Ау" }, meta(tk, "c1"));
      assert.equal(dup.messageId, r1.messageId);
      const [t1] = await sql`select last_message_at from support_requests where id = ${tk.id}`;
      assert.equal(t1!.last_message_at.getTime(), t0!.last_message_at.getTime());
      assert.equal(await count("select count(*)::int n from support_messages where ticket_id = $1", tk.id), 2);
      await settle();
      assert.equal(events.length, before);
    });

    await t.test("(d) resolved 2 days ago reopens: on-shift assignee keeps it, off-shift goes to the queue", async () => {
      const on = await ticket({ status: "resolved", resolved_at: sql`now() - interval '2 days'`, assigned_operator_id: 7 });
      const r = await inbound.recordUserMessage(on, { kind: "text", body: "снова я" }, meta(on, "d1"));
      assert.equal(r.reopened, true);
      const [a] = await sql`select status, assigned_operator_id from support_requests where id = ${on.id}`;
      assert.equal(a!.status, "allocated");
      assert.equal(Number(a!.assigned_operator_id), 7);
      const ev = await sql`select type, payload from crm_ticket_events where ticket_id = ${on.id}`;
      assert.deepEqual(ev.map((e) => [e.type, e.payload]), [["reopened", { status: "allocated" }]]);

      const off = await ticket({ status: "resolved", resolved_at: sql`now() - interval '2 days'`, assigned_operator_id: 8,
        auto_assigned: true, queued_at: sql`now() - interval '3 days'` });
      const r2 = await inbound.recordUserMessage(off, { kind: "text", body: "снова я" }, meta(off, "d2"));
      assert.equal(r2.reopened, true);
      const [b] = await sql`select status, assigned_operator_id, auto_assigned, queued_at > now() - interval '1 minute' as fresh
        from support_requests where id = ${off.id}`;
      assert.deepEqual({ ...b }, { status: "new", assigned_operator_id: null, auto_assigned: false, fresh: true });
      const offEv = await sql`select type, payload from crm_ticket_events where ticket_id = ${off.id} order by id`;
      assert.deepEqual(offEv.map((e) => [e.type, e.payload]), [
        ["reopened", { status: "new" }], ["unassigned", { operator_id: null, operator_name: null }],
      ]);
    });

    await t.test("resolved ticket stays closed when older than reopen_days or the user already has an open ticket", async () => {
      const old = await ticket({ status: "resolved", resolved_at: sql`now() - interval '8 days'`, assigned_operator_id: 7 });
      const r = await inbound.recordUserMessage(old, { kind: "text", body: "x" }, meta(old, "o1"));
      assert.equal(r.reopened, false);
      assert.equal((await sql`select status from support_requests where id = ${old.id}`)[0]!.status, "resolved");

      const closed = await ticket({ status: "resolved", resolved_at: sql`now() - interval '1 day'` });
      await ticket({ user_tg: closed.user_tg, status: "new" });
      const r2 = await inbound.recordUserMessage(closed, { kind: "text", body: "x" }, meta(closed, "o2"));
      assert.equal(r2.reopened, false);
      assert.equal((await sql`select status from support_requests where id = ${closed.id}`)[0]!.status, "resolved");
    });

    await t.test("(e) reopen_days = 0 disables reopen", async () => {
      await sql`insert into crm_settings (key, value) values ('reopen_days', '0'::jsonb)`;
      try {
        const tk = await ticket({ status: "resolved", resolved_at: sql`now() - interval '1 minute'`, assigned_operator_id: 7 });
        const r = await inbound.recordUserMessage(tk, { kind: "text", body: "x" }, meta(tk, "e1"));
        assert.equal(r.reopened, false);
        assert.equal((await sql`select status from support_requests where id = ${tk.id}`)[0]!.status, "resolved");
        assert.equal(await count("select count(*)::int n from crm_ticket_events where ticket_id = $1", tk.id), 0);
      } finally {
        await sql`delete from crm_settings where key = 'reopen_days'`;
      }
    });

    await t.test("web photo stores bytes and returns the first attachment", async () => {
      const tk = await ticket({ channel: "web", user_tg: null, web_user_id: "w-9" });
      const content = new Uint8Array([0xff, 0xd8, 0xff, 1, 2]);
      const r = await inbound.recordUserMessage(tk,
        { kind: "photo", body: "📷 Фото", webPhoto: { content, mediaType: "image/jpeg", filename: "a.jpg" } },
        { authorId: "web:w-9" });
      assert.equal(r.attachment!.filename, "a.jpg");
      const [att] = await sql`select size_bytes, content, position from support_attachments where id = ${r.attachment!.id}`;
      assert.equal(att!.size_bytes, 5);
      assert.deepEqual(new Uint8Array(att!.content), content);
      const [m] = await sql`select kind, body, source_message_id from support_messages where id = ${r.messageId}`;
      assert.deepEqual({ ...m }, { kind: "photo", body: "📷 Фото", source_message_id: null });
    });

    await t.test("publishes message.created, ticket.updated and user_replied for the assignee only", async () => {
      await settle();
      events.length = 0;
      const tk = await ticket({ status: "allocated", assigned_operator_id: 7, user_name: "Пётр" });
      const r = await inbound.recordUserMessage(tk, photo("p1", "g-p"), meta(tk, "p1"));
      await inbound.recordUserMessage(tk, photo("p2", "g-p"), meta(tk, "p2"));
      const unassigned = await ticket();
      await inbound.recordUserMessage(unassigned, { kind: "text", body: "hi" }, meta(unassigned, "p3"));
      await settle();
      assert.deepEqual(events, [
        { type: "message.created", ticketId: tk.id, messageId: r.messageId },
        { type: "ticket.updated", ticketId: tk.id },
        { type: "notify", operatorId: null, kind: "new_ticket", ticketId: tk.id, title: "Новое обращение", body: "Пётр: 📷 [фото]" },
        { type: "notify", operatorId: 7, kind: "user_replied", ticketId: tk.id, title: "Пётр", body: "📷 [фото]" },
        { type: "message.created", ticketId: tk.id, messageId: r.messageId },
        { type: "message.created", ticketId: unassigned.id, messageId: events[5]!.messageId },
        { type: "ticket.updated", ticketId: unassigned.id },
        { type: "notify", operatorId: null, kind: "new_ticket", ticketId: unassigned.id, title: "Новое обращение", body: "Иван: hi" },
      ]);
    });
    await t.test("a reopen back to the queue announces itself like a new ticket; a kept assignee gets user_replied", async () => {
      const { setActiveAlerts } = await import("../dist/crm/alerts.js");
      const alerted: string[] = [];
      setActiveAlerts({ newTicket: async (i) => { alerted.push(i.id); }, overdue: async () => {}, noOneOnShift: async () => {} });
      try {
        const queued = await ticket({ status: "resolved", resolved_at: sql`now() - interval '1 day'`, assigned_operator_id: 8, user_name: "Ольга" });
        const kept = await ticket({ status: "resolved", resolved_at: sql`now() - interval '1 day'`, assigned_operator_id: 7, user_name: "Ира" });
        // Both had a conversation already, so neither message is the ticket's first.
        await sql`insert into support_messages (ticket_id, sender, body) values (${queued.id}, 'user', 'old'), (${kept.id}, 'user', 'old')`;
        await settle();
        events.length = 0;
        await inbound.recordUserMessage(queued, { kind: "text", body: "опять" }, meta(queued, "rq1"));
        await inbound.recordUserMessage(kept, { kind: "text", body: "опять" }, meta(kept, "rq2"));
        await settle();
        const notifies = events.filter((e) => e.type === "notify");
        assert.deepEqual(notifies, [
          { type: "notify", operatorId: null, kind: "new_ticket", ticketId: queued.id, title: "Новое обращение", body: "Ольга: опять" },
          { type: "notify", operatorId: 7, kind: "user_replied", ticketId: kept.id, title: "Ира", body: "опять" },
        ]);
        assert.deepEqual(alerted, [queued.id]);
      } finally {
        setActiveAlerts(null);
      }
    });
  } finally {
    await listener.unlisten();
    await db.sql.end();
    await sql.end();
  }
});
