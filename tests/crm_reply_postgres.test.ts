import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("operator replies: delivery, notes, timers, web API, retry, resolve message", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  // The default notifySupportReply stays dark without a turkarta URL.
  delete process.env.TURKARTA_API_URL;
  const reply = await import("../dist/crm/reply.js");
  const tickets = await import("../dist/crm/tickets.js");
  const db = await import("../dist/db.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const { app } = await import("../dist/server.js");
  const sql = await freshCrmDb(url!);
  type Operator = import("../dist/crm/types.js").Operator;
  type TgTransport = import("../dist/crm/reply.js").TgTransport;

  const events: Array<Record<string, unknown>> = [];
  const listener = await sql.listen("crm_events", (p) => { events.push(JSON.parse(p)); });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const op = (id: number, name: string): Operator => ({
    id, name, email: null, role: "support", is_lead: false, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
  });
  const anna = op(7, "Anna");
  const boris = op(8, "Boris");

  type Call = { method: string; chatId: number; text?: string; caption?: string; count?: number };
  function transport() {
    const calls: Call[] = [];
    let n = 0;
    const state: { fail: Record<string, unknown> | null } = { fail: null };
    const file = () => ({ message_id: ++n, fileId: `file-${n}`, fileUniqueId: `uniq-${n}` });
    const check = (method: string) => { if (state.fail && state.fail.method === method) throw state.fail.error; };
    const tg: TgTransport = {
      async sendMessage(chatId, text) { calls.push({ method: "sendMessage", chatId, text }); check("sendMessage"); return { message_id: ++n }; },
      async sendPhoto(chatId, _p, caption) { calls.push({ method: "sendPhoto", chatId, caption }); check("sendPhoto"); return file(); },
      async sendMediaGroup(chatId, photos, caption) {
        calls.push({ method: "sendMediaGroup", chatId, caption, count: photos.length });
        check("sendMediaGroup");
        return photos.map(file);
      },
    };
    return { tg, calls, state };
  }
  function notifier() {
    const calls: Array<{ web_user_id: string; ticket_id: string; message_id: string; preview: string }> = [];
    return { calls, notify: async (i: (typeof calls)[number]) => { calls.push(i); } };
  }
  const blocked = { error_code: 403, description: "Forbidden: bot was blocked by the user" };
  const jpeg = (i: number) => ({
    content: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, i]), mediaType: "image/jpeg" as const, filename: `shot-${i}.jpg`,
  });

  let userSeq = 9000;
  async function ticket(fields: Record<string, unknown> = {}) {
    const row = { user_tg: ++userSeq, user_name: "Иван", source: "bot", first_message: "help", queued_at: sql`now()`, ...fields };
    const [r] = await sql`insert into support_requests ${sql(row)} returning id`;
    return r!.id as string;
  }
  const mine = (fields: Record<string, unknown> = {}) =>
    ticket({ status: "allocated", assigned_operator_id: 7, waiting_since: sql`now() - interval '90 seconds'`, ...fields });
  const row = async (id: string) => (await sql`select * from support_requests where id = ${id}`)[0]!;
  const msg = async (id: string) => (await sql`select * from support_messages where id = ${id}`)[0]!;

  try {
    await sql`insert into crm_operators (id, name, role) values (7, 'Anna', 'support'), (8, 'Boris', 'support'), (9, 'Annabel', 'support')`;

    await t.test("TG reply: sent via transport, response_seconds, first_response_at once, status awaiting", async () => {
      events.length = 0;
      const { tg, calls } = transport();
      const n = notifier();
      const id = await mine();
      const m = await reply.sendReply(id, anna, { kind: "reply", body: "  Проверьте ещё раз  ", photos: [] }, { tg, notify: n.notify });
      const r = await row(id);
      assert.deepEqual(calls, [{ method: "sendMessage", chatId: Number(r.user_tg), text: "Проверьте ещё раз" }]);
      assert.equal(m.delivery_status, "sent");
      assert.equal(m.delivery_error, null);
      assert.equal(m.kind, "text");
      assert.equal(m.sender, "agent");
      assert.equal(m.author_name, "Anna");
      assert.equal(m.body, "Проверьте ещё раз");
      assert.deepEqual(n.calls, [], "TG tickets do not ping the turkarta bell");

      const stored = await msg(m.id);
      assert.equal(stored.actor_type, "human");
      assert.equal(stored.author_id, "crm:7");
      assert.ok(Math.abs(stored.response_seconds - 90) <= 2, `response_seconds=${stored.response_seconds}`);
      assert.equal(r.status, "awaiting");
      assert.equal(r.waiting_since, null);
      assert.equal((r.first_response_at as Date).getTime(), (stored.created_at as Date).getTime());
      const [same] = await sql`select (r.first_response_at = m.created_at) as eq, (r.last_message_at = m.created_at) as last
        from support_requests r, support_messages m where r.id = ${id} and m.id = ${m.id}`;
      assert.equal(same!.eq, true, "first_response_at equals the first reply's created_at exactly");
      assert.equal(same!.last, true);

      await settle();
      assert.ok(events.some((e) => e.type === "message.created" && e.ticketId === id && e.messageId === m.id));
      assert.ok(events.some((e) => e.type === "ticket.updated" && e.ticketId === id));

      // A later reply keeps the first response time and measures its own wait.
      const first = r.first_response_at as Date;
      await sql`update support_requests set waiting_since = now() - interval '30 seconds', status = 'allocated' where id = ${id}`;
      const m2 = await reply.sendReply(id, anna, { kind: "reply", body: "Готово", photos: [] }, { tg, notify: n.notify });
      const r2 = await row(id);
      assert.equal((r2.first_response_at as Date).getTime(), first.getTime());
      assert.ok(Math.abs((await msg(m2.id)).response_seconds - 30) <= 2);
      // A human reply queues the AI review job (0012 trigger) as before.
      const [job] = await sql`select count(*)::int n from support_agent_jobs where ticket_id = ${id} and kind = 'review'`;
      assert.ok(job!.n >= 1);
    });

    await t.test("note: no delivery, no timer or status change, mentions notify, no AI job", async () => {
      events.length = 0;
      const { tg, calls } = transport();
      const n = notifier();
      const id = await mine();
      const before = await row(id);
      const m = await reply.sendReply(id, boris, { kind: "note", body: "@anna глянь, @Annabelle нет", photos: [] }, { tg, notify: n.notify });
      assert.equal(m.kind, "note");
      assert.equal(m.delivery_status, null);
      assert.deepEqual(calls, []);
      assert.deepEqual(n.calls, []);
      const after = await row(id);
      assert.equal(after.status, "allocated");
      assert.equal((after.waiting_since as Date).getTime(), (before.waiting_since as Date).getTime());
      assert.equal(after.first_response_at, null);
      assert.equal(Number(after.assigned_operator_id), 7, "a note on a colleague's ticket does not take it");
      const stored = await msg(m.id);
      assert.equal(stored.actor_type, "system");
      assert.equal(stored.author_id, "crm:8");
      assert.equal(stored.author_name, "Boris");
      assert.equal(stored.response_seconds, null);
      const [jobs] = await sql`select count(*)::int n from support_agent_jobs where ticket_id = ${id}`;
      assert.equal(jobs!.n, 0, "notes never queue an AI review");

      await settle();
      const mentions = events.filter((e) => e.type === "notify" && e.kind === "mention");
      assert.deepEqual(mentions.map((e) => e.operatorId), [7]);
      assert.equal(mentions[0]!.ticketId, id);
      assert.ok(events.some((e) => e.type === "message.created" && e.messageId === m.id));

      // A note on a queued ticket does not claim it.
      const queued = await ticket({ waiting_since: sql`now()` });
      await reply.sendReply(queued, anna, { kind: "note", body: "посмотрю позже", photos: [] }, { tg, notify: n.notify });
      const q = await row(queued);
      assert.equal(q.status, "new");
      assert.equal(q.assigned_operator_id, null);
    });

    await t.test("reply on a colleague's ticket is Conflict(assigned_to_other) and stores nothing", async () => {
      const { tg, calls } = transport();
      const id = await mine();
      await assert.rejects(
        reply.sendReply(id, boris, { kind: "reply", body: "hi", photos: [] }, { tg }),
        (e: unknown) => e instanceof tickets.Conflict && e.code === "assigned_to_other" && e.assignee?.name === "Anna",
      );
      const [c] = await sql`select count(*)::int n from support_messages where ticket_id = ${id}`;
      assert.equal(c!.n, 0);
      assert.deepEqual(calls, []);

      const resolved = await ticket({ status: "resolved", resolved_at: sql`now()` });
      await assert.rejects(reply.sendReply(resolved, anna, { kind: "reply", body: "hi", photos: [] }, { tg }),
        (e: unknown) => e instanceof tickets.Conflict && e.code === "resolved");
      await assert.rejects(reply.sendReply("nope", anna, { kind: "reply", body: "hi", photos: [] }, { tg }), tickets.NotFound);
      await assert.rejects(reply.sendReply(id, anna, { kind: "reply", body: " ", photos: [] }, { tg }), reply.InvalidReply);
    });

    await t.test("reply on a queued ticket assigns me and logs assigned", async () => {
      const { tg } = transport();
      const id = await ticket({ waiting_since: sql`now() - interval '10 seconds'` });
      await reply.sendReply(id, anna, { kind: "reply", body: "Беру", photos: [] }, { tg });
      const r = await row(id);
      assert.equal(Number(r.assigned_operator_id), 7);
      assert.equal(r.status, "awaiting");
      const ev = await sql`select type, payload from crm_ticket_events where ticket_id = ${id} order by id`;
      assert.deepEqual(ev.map((e) => [e.type, e.payload]), [["assigned", { operator_id: 7, operator_name: "Anna" }]]);
    });

    await t.test("TG photos: one sendPhoto, 3 as a media group, file ids stored", async () => {
      const { tg, calls } = transport();
      const id = await mine();
      const one = await reply.sendReply(id, anna, { kind: "reply", body: "Вот", photos: [jpeg(1)] }, { tg });
      assert.equal(one.kind, "photo");
      assert.equal(one.attachments.length, 1);
      const three = await reply.sendReply(id, anna, { kind: "reply", body: "", photos: [jpeg(1), jpeg(2), jpeg(3)] }, { tg });
      assert.deepEqual(calls.map((c) => [c.method, c.caption ?? null, c.count ?? null]),
        [["sendPhoto", "Вот", null], ["sendMediaGroup", null, 3]]);
      assert.deepEqual(three.attachments.map((a) => a.position), [0, 1, 2]);
      const atts = await sql`select position, tg_file_id, size_bytes, media_type from support_attachments where message_id = ${three.id} order by position`;
      assert.deepEqual(atts.map((a) => [a.position, a.tg_file_id, a.size_bytes, a.media_type]),
        [[0, "file-2", 5, "image/jpeg"], [1, "file-3", 5, "image/jpeg"], [2, "file-4", 5, "image/jpeg"]]);
    });

    await t.test("blocked bot: failed with tg_403, never throws; retry resends and flips to sent", async () => {
      const { tg, calls, state } = transport();
      state.fail = { method: "sendMessage", error: blocked };
      const id = await mine();
      const m = await reply.sendReply(id, anna, { kind: "reply", body: "Ответ", photos: [] }, { tg });
      assert.equal(m.delivery_status, "failed");
      assert.ok(m.delivery_error!.startsWith("tg_403"), m.delivery_error!);
      assert.equal(m.delivery_error, "tg_403: Forbidden: bot was blocked by the user");
      // The reply still counts as a response; the delivery problem is visible on the message.
      assert.equal((await row(id)).status, "awaiting");

      await assert.rejects(reply.retryDelivery(m.id, boris, { tg }),
        (e: unknown) => e instanceof tickets.Conflict && e.code === "assigned_to_other");
      state.fail = null;
      const again = await reply.retryDelivery(m.id, anna, { tg });
      assert.equal(again.delivery_status, "sent");
      assert.equal(again.delivery_error, null);
      assert.equal(calls.filter((c) => c.method === "sendMessage").length, 2);

      // Retrying a sent message is a no-op.
      const noop = await reply.retryDelivery(m.id, anna, { tg });
      assert.equal(noop.delivery_status, "sent");
      assert.equal(calls.length, 2);
      await assert.rejects(reply.retryDelivery("00000000-0000-0000-0000-000000000000", anna, { tg }), tickets.NotFound);
    });

    await t.test("photos delivered but long text failed: retry sends only the text", async () => {
      const { tg, calls, state } = transport();
      state.fail = { method: "sendMessage", error: blocked };
      const id = await mine();
      const body = "т".repeat(1500);
      const m = await reply.sendReply(id, anna, { kind: "reply", body, photos: [jpeg(1), jpeg(2)] }, { tg });
      assert.equal(m.delivery_status, "failed");
      state.fail = null;
      calls.length = 0;
      const again = await reply.retryDelivery(m.id, anna, { tg });
      assert.equal(again.delivery_status, "sent");
      assert.deepEqual(calls.map((c) => c.method), ["sendMessage"]);
    });

    await t.test("web ticket: no transport, notify once, note hidden from the web API", async () => {
      const { tg, calls } = transport();
      const n = notifier();
      const id = await ticket({
        user_tg: null, channel: "web", web_user_id: "web-42", source: "web", status: "allocated", assigned_operator_id: 7,
        waiting_since: sql`now()`,
      });
      const user = await db.addMessage(id, "user", "не работает карта");
      const r1 = await reply.sendReply(id, anna, { kind: "reply", body: "Смотрите фото", photos: [jpeg(1), jpeg(2)] }, { tg, notify: n.notify });
      const note = await reply.sendReply(id, anna, { kind: "note", body: "секрет: проверить KYC", photos: [jpeg(3)] }, { tg, notify: n.notify });
      const r2 = await reply.sendReply(id, anna, { kind: "reply", body: "", photos: [jpeg(4)] }, { tg, notify: n.notify });
      assert.deepEqual(calls, []);
      assert.equal(r1.delivery_status, "sent");
      assert.deepEqual(n.calls, [
        { web_user_id: "web-42", ticket_id: id, message_id: r1.id, preview: "Смотрите фото" },
        { web_user_id: "web-42", ticket_id: id, message_id: r2.id, preview: "📷 Фото" },
      ]);

      const rows = await db.messagesSince(id);
      assert.deepEqual(rows.map((m) => m.id), [user.id, r1.id, r2.id]);
      assert.deepEqual(rows[1]!.attachments.map((a) => a.id), r1.attachments.map((a) => a.id));
      assert.deepEqual(rows[0]!.attachments, []);

      const res = await app.request("/api/support/web/messages?web_user_id=web-42", { headers: { "x-webhook-secret": "test-secret" } });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("секрет"), "note text never reaches the web API");
      const json = JSON.parse(text) as { messages: Array<{ id: string; attachments: Array<{ id: string; mediaType: string; filename: string }>; attachment: unknown }> };
      assert.deepEqual(json.messages.map((m) => m.id), [user.id, r1.id, r2.id]);
      assert.deepEqual(json.messages[1]!.attachments, [
        { id: r1.attachments[0]!.id, mediaType: "image/jpeg", filename: "shot-1.jpg" },
        { id: r1.attachments[1]!.id, mediaType: "image/jpeg", filename: "shot-2.jpg" },
      ]);
      assert.deepEqual(json.messages[1]!.attachment, json.messages[1]!.attachments[0]);
      assert.equal(json.messages[0]!.attachment, null);
      assert.deepEqual(json.messages[0]!.attachments, []);

      const photo = await app.request(`/api/support/web/attachment/${r1.attachments[1]!.id}?web_user_id=web-42`, { headers: { "x-webhook-secret": "test-secret" } });
      assert.equal(photo.status, 200);
      assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), jpeg(2).content);
      const hidden = await app.request(`/api/support/web/attachment/${note.attachments[0]!.id}?web_user_id=web-42`, { headers: { "x-webhook-secret": "test-secret" } });
      assert.equal(hidden.status, 404, "note photos are not served to the customer");
      const stranger = await app.request(`/api/support/web/attachment/${r1.attachments[0]!.id}?web_user_id=web-other`, { headers: { "x-webhook-secret": "test-secret" } });
      assert.equal(stranger.status, 404);
    });

    await t.test("resolve message: setStatus default sends the configured text", async () => {
      const id = await ticket({ user_tg: null, channel: "web", web_user_id: "web-77", source: "web", status: "allocated", assigned_operator_id: 7 });
      await sql`insert into crm_settings (key, value) values ('resolve_message_enabled', 'true'::jsonb), ('resolve_message_text', '"Закрыли. Пишите, если что."'::jsonb)`;
      try {
        await tickets.setStatus(id, "resolved", anna);
      } finally {
        await sql`delete from crm_settings where key in ('resolve_message_enabled', 'resolve_message_text')`;
      }
      const msgs = await sql`select sender, kind, body, author_name, actor_type, delivery_status from support_messages where ticket_id = ${id}`;
      assert.deepEqual(msgs.map((m) => ({ ...m })), [{
        sender: "agent", kind: "text", body: "Закрыли. Пишите, если что.", author_name: null, actor_type: "automation", delivery_status: "sent",
      }]);
      assert.equal((await row(id)).status, "resolved");

      const { tg, calls } = transport();
      const tgId = await mine({ status: "resolved" });
      await reply.sendSystemText(await db.getTicket(tgId) as never, "Закрыли.", { tg });
      assert.deepEqual(calls.map((c) => [c.method, c.text]), [["sendMessage", "Закрыли."]]);
      const [m] = await sql`select delivery_status, response_seconds from support_messages where ticket_id = ${tgId}`;
      assert.equal(m!.delivery_status, "sent");
      assert.equal(m!.response_seconds, null);
    });
  } finally {
    await listener.unlisten();
    await db.sql.end();
    await sql.end();
  }
});
