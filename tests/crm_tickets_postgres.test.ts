import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("ticket workflow: take, take-over, assign, status, list, detail", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  // Import before opening the test pool so a missing module fails fast instead of hanging.
  const tickets = await import("../dist/crm/tickets.js");
  const { DEFAULT_SETTINGS } = await import("../dist/crm/settings.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const sql = await freshCrmDb(url!);
  type Operator = import("../dist/crm/types.js").Operator;

  const events: Array<Record<string, unknown>> = [];
  const listener = await sql.listen("crm_events", (p) => { events.push(JSON.parse(p)); });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const op = (id: number, name: string, role: "admin" | "support", is_lead = false): Operator => ({
    id, name, email: null, role, is_lead, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
  });
  const anna = op(7, "Anna", "support");
  const boris = op(8, "Boris", "support");
  const lead = op(10, "Lena", "support", true);
  const admin = op(9, "Admin", "admin");
  const s = { ...DEFAULT_SETTINGS, sla_first_minutes: 5, sla_followup_minutes: 15 };

  let userSeq = 5000;
  async function ticket(fields: Record<string, unknown> = {}) {
    const row = { user_tg: ++userSeq, user_name: "Иван", source: "bot", first_message: "help", queued_at: sql`now()`, ...fields };
    const [r] = await sql`insert into support_requests ${sql(row)} returning id`;
    return r!.id as string;
  }
  const row = async (id: string) => (await sql`select * from support_requests where id = ${id}`)[0]!;
  const eventsOf = async (id: string) =>
    await sql`select type, actor_operator_id::int as actor, payload from crm_ticket_events where ticket_id = ${id} order by id`;
  const reset = async () => { await sql`truncate support_requests cascade`; events.length = 0; };

  try {
    await sql`insert into crm_operators (id, name, role, is_lead) values
      (7, 'Anna', 'support', false), (8, 'Boris', 'support', false), (9, 'Admin', 'admin', false), (10, 'Lena', 'support', true)`;

    await t.test("two concurrent takes: one wins, the other gets Conflict with the winner", async () => {
      await reset();
      const id = await ticket();
      const res = await Promise.allSettled([tickets.take(id, anna), tickets.take(id, boris)]);
      const ok = res.filter((r) => r.status === "fulfilled");
      const bad = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(ok.length, 1);
      assert.equal(bad.length, 1);
      const err = bad[0]!.reason;
      assert.ok(err instanceof tickets.Conflict);
      assert.equal(err.code, "assigned_to_other");
      const r = await row(id);
      const winner = Number(r.assigned_operator_id);
      assert.deepEqual(err.assignee, { id: winner, name: winner === 7 ? "Anna" : "Boris" });
      assert.equal(r.status, "allocated");
      assert.equal(r.auto_assigned, false);
      const ev = await eventsOf(id);
      assert.deepEqual(ev.map((e) => [e.type, e.actor, e.payload]),
        [["assigned", winner, { operator_id: winner, operator_name: winner === 7 ? "Anna" : "Boris" }]]);
      const [o] = await sql`select last_assigned_at from crm_operators where id = ${winner}`;
      assert.ok(o!.last_assigned_at instanceof Date);
      await settle();
      assert.ok(events.some((e) => e.type === "ticket.updated" && e.ticketId === id));
      assert.ok(!events.some((e) => e.type === "notify"), "taking a ticket yourself sends no notify");
    });

    await t.test("take on a resolved ticket is a Conflict(resolved); taking your own ticket is a no-op", async () => {
      await reset();
      const id = await ticket({ status: "resolved", resolved_at: sql`now()` });
      await assert.rejects(tickets.take(id, anna), (e: unknown) => e instanceof tickets.Conflict && e.code === "resolved");
      const mine = await ticket();
      await tickets.take(mine, anna);
      await tickets.take(mine, anna);
      assert.equal((await eventsOf(mine)).length, 1);
      await assert.rejects(tickets.take("00000000-0000-0000-0000-000000000000", anna), tickets.NotFound);
      await assert.rejects(tickets.take("not-a-uuid", anna), tickets.NotFound);
    });

    await t.test("takeOver reassigns to me and logs taken_over with the new assignee", async () => {
      await reset();
      const id = await ticket();
      await tickets.take(id, anna);
      await tickets.takeOver(id, boris);
      const r = await row(id);
      assert.equal(Number(r.assigned_operator_id), 8);
      assert.equal(r.status, "allocated");
      const ev = await eventsOf(id);
      assert.deepEqual(ev.at(-1), { type: "taken_over", actor: 8, payload: { operator_id: 8, operator_name: "Boris" } });
    });

    await t.test("support assign on a ticket not theirs is Forbidden; admin can; leads have no extra rights", async () => {
      await reset();
      const queued = await ticket();
      await assert.rejects(tickets.assign(queued, 8, anna), tickets.Forbidden);
      const annas = await ticket();
      await tickets.take(annas, anna);
      await assert.rejects(tickets.assign(annas, 8, boris), tickets.Forbidden);
      await assert.rejects(tickets.assign(annas, null, boris), tickets.Forbidden);
      await assert.rejects(tickets.assign(annas, 8, lead), tickets.Forbidden);

      events.length = 0;
      await tickets.assign(annas, 8, admin);
      const r = await row(annas);
      assert.equal(Number(r.assigned_operator_id), 8);
      assert.deepEqual((await eventsOf(annas)).at(-1),
        { type: "assigned", actor: 9, payload: { operator_id: 8, operator_name: "Boris" } });
      await settle();
      const notify = events.find((e) => e.type === "notify");
      assert.deepEqual(notify, {
        type: "notify", operatorId: 8, kind: "assigned", ticketId: annas,
        title: "Вам назначено обращение", body: "Иван",
      });

      await tickets.assign(queued, 7, admin);
      assert.equal(Number((await row(queued)).assigned_operator_id), 7);
      assert.equal((await row(queued)).status, "allocated");
      await assert.rejects(tickets.assign(queued, 999, admin), tickets.NotFound);
    });

    await t.test("support operator hands own ticket to a colleague and can unassign it to the queue", async () => {
      await reset();
      const id = await ticket({ user_name: null, user_username: "petrov" });
      await tickets.take(id, anna);
      events.length = 0;
      await tickets.assign(id, 8, anna);
      await settle();
      assert.equal(events.find((e) => e.type === "notify")?.body, "@petrov");

      await tickets.assign(id, null, boris);
      const r = await row(id);
      assert.equal(r.assigned_operator_id, null);
      assert.equal(r.status, "new");
      assert.ok(r.queued_at instanceof Date);
      assert.deepEqual((await eventsOf(id)).at(-1),
        { type: "unassigned", actor: 8, payload: { operator_id: null, operator_name: null } });
    });

    await t.test("setStatus: resolved clears waiting_since; awaiting assigns me; new returns to queue", async () => {
      await reset();
      const id = await ticket({ waiting_since: sql`now() - interval '2 minutes'` });
      await tickets.setStatus(id, "awaiting", anna);
      let r = await row(id);
      assert.equal(r.status, "awaiting");
      assert.equal(Number(r.assigned_operator_id), 7);

      const resolvedCalls: string[] = [];
      await tickets.setStatus(id, "resolved", anna, { onResolved: async (tk) => { resolvedCalls.push(tk.id); } });
      r = await row(id);
      assert.equal(r.status, "resolved");
      assert.equal(r.waiting_since, null);
      assert.ok(r.resolved_at instanceof Date);
      assert.deepEqual(resolvedCalls, [], "resolve message is off by default");
      const ev = await eventsOf(id);
      assert.deepEqual(ev.map((e) => e.type), ["assigned", "status_changed", "status_changed"]);
      assert.deepEqual(ev.at(-1)!.payload, { from: "awaiting", to: "resolved" });

      const id2 = await ticket();
      await sql`insert into crm_settings (key, value) values ('resolve_message_enabled', 'true'::jsonb)`;
      try {
        await tickets.setStatus(id2, "resolved", anna, { onResolved: async (tk) => { resolvedCalls.push(tk.id); } });
      } finally {
        await sql`delete from crm_settings where key = 'resolve_message_enabled'`;
      }
      assert.deepEqual(resolvedCalls, [id2]);

      const id3 = await ticket();
      await tickets.take(id3, anna);
      await sql`update support_requests set queued_at = now() - interval '1 hour' where id = ${id3}`;
      await tickets.setStatus(id3, "new", anna);
      r = await row(id3);
      assert.equal(r.status, "new");
      assert.equal(r.assigned_operator_id, null);
      assert.ok(Date.now() - (r.queued_at as Date).getTime() < 60_000);

      // Reopening a resolved ticket keeps its assignee.
      await tickets.setStatus(id, "allocated", boris);
      r = await row(id);
      assert.equal(r.status, "allocated");
      assert.equal(Number(r.assigned_operator_id), 7);
      await assert.rejects(tickets.take(id, boris),
        (e: unknown) => e instanceof tickets.Conflict && e.code === "assigned_to_other");
      // A support operator cannot send a colleague's ticket back to the queue.
      await assert.rejects(tickets.setStatus(id, "new", boris), tickets.Forbidden);
      await assert.rejects(tickets.setStatus("00000000-0000-0000-0000-000000000000", "new", boris), tickets.NotFound);
    });

    await t.test("list queue orders by queued_at asc and counts", async () => {
      await reset();
      const a = await ticket({ queued_at: sql`now() - interval '3 minutes'` });
      const b = await ticket({ queued_at: sql`now() - interval '1 minute'` });
      const c = await ticket({ queued_at: sql`now() - interval '2 minutes'` });
      const mine = await ticket();
      await tickets.take(mine, anna);
      const res = await tickets.listTickets(anna, { view: "queue" }, s);
      assert.deepEqual(res.items.map((i) => i.id), [a, c, b]);
      assert.equal(res.counts.queue, 3);
      assert.equal(res.counts.mine, 1);
      assert.equal(res.nextCursor, null);
      const m = await tickets.listTickets(anna, { view: "mine" }, s);
      assert.deepEqual(m.items.map((i) => [i.id, i.assigned_operator_id, i.assigned_operator_name]), [[mine, 7, "Anna"]]);
    });

    await t.test("overdue filter uses first vs follow-up target", async () => {
      await reset();
      const late = await ticket({ waiting_since: sql`now() - interval '6 minutes'` });
      await ticket({ waiting_since: sql`now() - interval '4 minutes'` });
      await ticket({ waiting_since: sql`now() - interval '6 minutes'`, first_response_at: sql`now() - interval '10 minutes'` });
      await ticket();
      const res = await tickets.listTickets(anna, { view: "all", overdue: true }, s);
      assert.deepEqual(res.items.map((i) => i.id), [late]);
      assert.equal(res.counts.overdue, 1);
      const relaxed = await tickets.listTickets(anna, { view: "all", overdue: true }, { ...s, sla_first_minutes: 7 });
      assert.deepEqual(relaxed.items, []);
    });

    await t.test("search by @username substring, email, tg id, id prefix; LIKE wildcards are literal", async () => {
      await reset();
      const ivan = await ticket({ user_username: "ivan_petrov", user_name: "Ivan" });
      const other = await ticket({ user_username: "olga", user_name: "Olga", email: "olga@example.com", user_tg: 777123 });
      const q = async (text: string) => (await tickets.listTickets(anna, { view: "all", q: text }, s)).items.map((i) => i.id);
      assert.deepEqual(await q("@petro"), [ivan]);
      assert.deepEqual(await q("EXAMPLE.com"), [other]);
      assert.deepEqual(await q("7771"), [other]);
      assert.deepEqual(await q(ivan.slice(0, 8)), [ivan]);
      assert.deepEqual(await q("%"), []);
      assert.deepEqual(await q("_"), [ivan]);
    });

    await t.test("filters: status, channel, operator", async () => {
      await reset();
      const bot = await ticket({ source: "bot" });
      const mini = await ticket({ source: "miniapp" });
      const web = await ticket({ source: "web_pwa", channel: "web", user_tg: null, web_user_id: "w1" });
      await tickets.take(mini, boris);
      const ids = async (q: Record<string, unknown>) =>
        (await tickets.listTickets(anna, { view: "all", ...q }, s)).items.map((i) => i.id).sort();
      assert.deepEqual(await ids({ channel: "bot" }), [bot]);
      assert.deepEqual(await ids({ channel: "miniapp" }), [mini]);
      assert.deepEqual(await ids({ channel: "web" }), [web]);
      assert.deepEqual(await ids({ status: "allocated" }), [mini]);
      assert.deepEqual(await ids({ operatorId: 8 }), [mini]);
    });

    await t.test("cursor pagination returns disjoint pages in sort order", async () => {
      await reset();
      const ids = [
        await ticket({ waiting_since: sql`now() - interval '9 minutes'`, last_message_at: sql`now()` }),
        await ticket({ waiting_since: sql`now() - interval '5 minutes'`, last_message_at: sql`now()` }),
        await ticket({ last_message_at: sql`now() - interval '1 minute'` }),
        await ticket({ last_message_at: sql`now() - interval '1 minute'` }),
        await ticket({ last_message_at: sql`now() - interval '1 minute'` }),
        await ticket({ last_message_at: sql`now() - interval '3 minutes'` }),
        await ticket({}),
      ];
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await tickets.listTickets(anna, { view: "all", limit: 2, ...(cursor ? { cursor } : {}) }, s);
        assert.ok(res.items.length <= 2);
        seen.push(...res.items.map((i) => i.id));
        cursor = res.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);
      assert.equal(pages, 4);
      assert.equal(new Set(seen).size, ids.length);
      const all = await tickets.listTickets(anna, { view: "all", limit: 100 }, s);
      assert.deepEqual(seen, all.items.map((i) => i.id));
      assert.deepEqual(seen.slice(0, 2), ids.slice(0, 2));
      assert.equal(seen.at(-1), ids[6]);
      assert.equal(seen.at(-2), ids[5]);
      await assert.rejects(tickets.listTickets(anna, { view: "all", cursor: "garbage" }, s), tickets.BadCursor);
    });

    await t.test("ticketDetail and list item fields: preview, intake, messages, attachments, events", async () => {
      await reset();
      const id = await ticket({ user_username: "ivan", email: "i@x.io", device: "iPhone", intake_step: "email" });
      const [m1] = await sql`insert into support_messages (ticket_id, sender, body, kind) values (${id}, 'user', 'hello', 'text') returning id`;
      const [m2] = await sql`insert into support_messages (ticket_id, sender, body, kind) values (${id}, 'user', '', 'photo') returning id`;
      await sql`insert into support_attachments (message_id, media_type, filename, position, tg_file_id)
        values (${m2!.id}, 'image/jpeg', 'b.jpg', 1, 'f2'), (${m2!.id}, 'image/jpeg', 'a.jpg', 0, 'f1')`;
      await sql`insert into support_messages (ticket_id, sender, body, kind, author_name) values (${id}, 'agent', 'internal', 'note', 'Anna')`;

      const list = await tickets.listTickets(anna, { view: "queue" }, s);
      const item = list.items[0]!;
      assert.equal(item.last_message_preview, "Фото");
      assert.equal(item.intake_pending, true);
      assert.equal(item.user_tg, userSeq);
      assert.equal(item.channel, "telegram");
      assert.equal(typeof item.created_at, "string");

      await sql`insert into support_messages (ticket_id, sender, body, kind) values (${id}, 'user', ${"я".repeat(200)}, 'text')`;
      const again = await tickets.listTickets(anna, { view: "queue" }, s);
      assert.equal(again.items[0]!.last_message_preview, "я".repeat(120));

      await tickets.take(id, anna);
      const d = await tickets.ticketDetail(id);
      assert.ok(d);
      assert.equal(d.ticket.device, "iPhone");
      assert.equal(d.ticket.email, "i@x.io");
      assert.equal(d.ticket.web_user_id, null);
      assert.equal(d.ticket.assigned_operator_name, "Anna");
      assert.deepEqual(d.messages.map((m) => [m.id, m.kind]).slice(0, 3), [[m1!.id, "text"], [m2!.id, "photo"], [d.messages[2]!.id, "note"]]);
      assert.deepEqual(d.messages[1]!.attachments.map((a) => a.position), [0, 1]);
      assert.deepEqual(d.messages[0]!.attachments, []);
      assert.equal(d.messages[2]!.author_name, "Anna");
      assert.deepEqual(d.events.map((e) => [e.type, e.actor_name]), [["assigned", "Anna"]]);
      assert.equal(typeof d.events[0]!.created_at, "string");
      assert.equal(await tickets.ticketDetail("00000000-0000-0000-0000-000000000000"), null);
      assert.equal(await tickets.ticketDetail("nope"), null);
    });
  } finally {
    await listener.unlisten();
    const db = await import("../dist/db.js");
    await db.sql.end();
    await sql.end();
  }
});
