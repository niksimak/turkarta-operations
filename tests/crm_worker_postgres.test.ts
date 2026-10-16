import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("crm worker: auto-assign, shift timeout, nobody on shift, overdue, stuck deliveries, new-ticket alerts", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  // Import before opening the test pool so a missing module fails fast instead of hanging.
  const worker = await import("../dist/crm/worker.js");
  const alertsMod = await import("../dist/crm/alerts.js");
  const inbound = await import("../dist/crm/inbound.js");
  type Item = import("../dist/crm/tickets.js").TicketListItem;
  const sql = await freshCrmDb(url!);

  const events: Array<Record<string, unknown>> = [];
  const listener = await sql.listen("crm_events", (p) => { events.push(JSON.parse(p)); });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const sent = { newTicket: [] as Item[], overdue: [] as Array<{ id: string; minutes: number }>, noOne: [] as number[] };
  const alert = {
    newTicket: async (i: Item) => { sent.newTicket.push(i); },
    overdue: async (i: Item, minutes: number) => { sent.overdue.push({ id: i.id, minutes }); },
    noOneOnShift: async (n: number) => { sent.noOne.push(n); },
  };
  const deps = { alert };
  const minsFromNow = (m: number) => new Date(Date.now() + m * 60_000);

  let userSeq = 9000;
  async function ticket(fields: Record<string, unknown> = {}) {
    const row = {
      user_tg: ++userSeq, user_name: "Иван", source: "bot", first_message: "help",
      queued_at: sql`now() - interval '10 minutes'`, ...fields,
    };
    const [r] = await sql`insert into support_requests ${sql(row)} returning id`;
    return r!.id as string;
  }
  async function operator(id: number, name: string, fields: Record<string, unknown> = {}) {
    const row = { id, name, role: "support", on_shift: true, auto_assign_enabled: true, last_active_at: sql`now()`, ...fields };
    await sql`insert into crm_operators ${sql(row)}`;
  }
  async function load(opId: number, n: number) {
    for (let i = 0; i < n; i++) await ticket({ status: "allocated", assigned_operator_id: opId, queued_at: null });
  }
  async function setting(key: string, value: unknown) {
    await sql`insert into crm_settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
      on conflict (key) do update set value = excluded.value`;
  }
  const row = async (id: string) => (await sql`select * from support_requests where id = ${id}`)[0]!;
  const reset = async () => {
    await sql`truncate support_requests, crm_operators, crm_settings cascade`;
    events.length = 0;
    sent.newTicket.length = 0; sent.overdue.length = 0; sent.noOne.length = 0;
    worker.resetWorkerState();
    alertsMod.setActiveAlerts(null);
  };

  try {
    await t.test("least-loaded online operator wins; event, flags and notify are written", async () => {
      await reset();
      await operator(1, "Anna");
      await operator(2, "Boris");
      await operator(3, "Off", { auto_assign_enabled: false });
      await load(1, 2);
      await load(2, 1);
      const due = await ticket();
      const fresh = await ticket({ queued_at: sql`now() - interval '1 minute'` });
      const r = await worker.tick(undefined, deps);
      assert.deepEqual(r, { assigned: 1, overdue: 0, noOneAlerted: false });
      const d = await row(due);
      assert.equal(d.status, "allocated");
      assert.equal(Number(d.assigned_operator_id), 2);
      assert.equal(d.auto_assigned, true);
      assert.equal((await row(fresh)).status, "new");
      const ev = await sql`select type, actor_operator_id, payload from crm_ticket_events where ticket_id = ${due}`;
      assert.deepEqual(ev.map((e) => [e.type, e.actor_operator_id, e.payload]),
        [["auto_assigned", null, { operator_id: 2, operator_name: "Boris" }]]);
      const [o] = await sql`select last_assigned_at from crm_operators where id = 2`;
      assert.ok(o!.last_assigned_at instanceof Date);
      await settle();
      assert.ok(events.some((e) => e.type === "notify" && e.kind === "assigned" && e.operatorId === 2 && e.ticketId === due));
      assert.ok(events.some((e) => e.type === "ticket.updated" && e.ticketId === due));
    });

    await t.test("tie on load goes to the oldest last_assigned_at, never-assigned first", async () => {
      await reset();
      await operator(1, "Anna", { last_assigned_at: sql`now() - interval '1 hour'` });
      await operator(2, "Boris", { last_assigned_at: sql`now() - interval '2 hours'` });
      const a = await ticket({ queued_at: sql`now() - interval '20 minutes'` });
      const b = await ticket({ queued_at: sql`now() - interval '10 minutes'` });
      await worker.tick(undefined, deps);
      assert.equal(Number((await row(a)).assigned_operator_id), 2, "oldest last_assigned_at wins the tie");
      assert.equal(Number((await row(b)).assigned_operator_id), 1, "then the less loaded one");

      await reset();
      await operator(1, "Anna", { last_assigned_at: sql`now() - interval '1 hour'` });
      await operator(2, "Boris");
      const c = await ticket();
      await worker.tick(undefined, deps);
      assert.equal(Number((await row(c)).assigned_operator_id), 2);
    });

    await t.test("stale heartbeat: flipped off shift, skipped for assignment", async () => {
      await reset();
      await operator(1, "Anna", { last_active_at: sql`now() - interval '20 minutes'` });
      await operator(2, "Boris");
      await load(2, 3);
      const id = await ticket();
      await worker.tick(undefined, deps);
      assert.equal(Number((await row(id)).assigned_operator_id), 2);
      const [a] = await sql`select on_shift from crm_operators where id = 1`;
      assert.equal(a!.on_shift, false);
      const [b] = await sql`select on_shift from crm_operators where id = 2`;
      assert.equal(b!.on_shift, true);
      await settle();
      assert.ok(events.some((e) => e.type === "operator.updated" && e.operatorId === 1));
      assert.ok(!events.some((e) => e.type === "operator.updated" && e.operatorId === 2));
    });

    await t.test("cap respected: tickets beyond it stay queued", async () => {
      await reset();
      await setting("auto_assign_max_open", 1);
      await operator(1, "Anna");
      await operator(2, "Boris");
      await load(1, 1);
      const x = await ticket({ queued_at: sql`now() - interval '20 minutes'` });
      const y = await ticket({ queued_at: sql`now() - interval '10 minutes'` });
      const r = await worker.tick(undefined, deps);
      assert.equal(r.assigned, 1);
      assert.equal(Number((await row(x)).assigned_operator_id), 2);
      const yr = await row(y);
      assert.equal(yr.status, "new");
      assert.equal(yr.assigned_operator_id, null);
      assert.equal(r.noOneAlerted, true);
      assert.deepEqual(sent.noOne, [1]);
    });

    await t.test("nobody on shift: one alert per 15 minutes, none when the setting is off", async () => {
      await reset();
      await operator(1, "Anna", { on_shift: false });
      await ticket();
      await ticket({ queued_at: sql`now() - interval '1 minute'` });
      const now = new Date();
      const r1 = await worker.tick(now, deps);
      const r2 = await worker.tick(new Date(now.getTime() + 5 * 60_000), deps);
      assert.equal(r1.noOneAlerted, true);
      assert.equal(r2.noOneAlerted, false);
      assert.deepEqual(sent.noOne, [2], "queue size counts every new ticket");
      const r3 = await worker.tick(new Date(now.getTime() + 16 * 60_000), deps);
      assert.equal(r3.noOneAlerted, true);
      assert.equal(sent.noOne.length, 2);

      await reset();
      await setting("tg_ping_no_one_on_shift", false);
      await ticket();
      const r4 = await worker.tick(undefined, deps);
      assert.equal(r4.noOneAlerted, false);
      assert.equal(sent.noOne.length, 0);

      await reset();
      await setting("auto_assign_enabled", false);
      await operator(1, "Anna");
      const off = await ticket();
      const r5 = await worker.tick(undefined, deps);
      assert.deepEqual(r5, { assigned: 0, overdue: 0, noOneAlerted: false });
      assert.equal((await row(off)).status, "new");
    });

    await t.test("two concurrent ticks assign each ticket exactly once", async () => {
      await reset();
      await operator(1, "Anna");
      await operator(2, "Boris");
      await operator(3, "Vera");
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) ids.push(await ticket({ queued_at: sql`now() - make_interval(mins => ${10 + i})` }));
      const [a, b] = await Promise.all([worker.tick(undefined, deps), worker.tick(undefined, deps)]);
      assert.equal(a.assigned + b.assigned, 9);
      const ev = await sql`select ticket_id, count(*)::int as n from crm_ticket_events where type = 'auto_assigned' group by ticket_id`;
      assert.equal(ev.length, 9);
      assert.ok(ev.every((e) => e.n === 1));
      const loads = await sql`select assigned_operator_id::int as op, count(*)::int as n from support_requests group by 1 order by 1`;
      assert.deepEqual(loads.map((l) => [l.op, l.n]), [[1, 3], [2, 3], [3, 3]]);
    });

    await t.test("two concurrent ticks over more than one batch never exceed the cap", async () => {
      await reset();
      await setting("auto_assign_max_open", 5);
      await operator(1, "Anna");
      await operator(2, "Boris");
      await operator(3, "Vera");
      for (let i = 0; i < 30; i++) await ticket({ queued_at: sql`now() - make_interval(mins => ${10 + i})` });
      const [a, b] = await Promise.all([worker.tick(undefined, deps), worker.tick(undefined, deps)]);
      assert.equal(a.assigned + b.assigned, 15);
      const loads = await sql`select assigned_operator_id::int as op, count(*)::int as n from support_requests
        where assigned_operator_id is not null group by 1 order by 1`;
      assert.deepEqual(loads.map((l) => [l.op, l.n]), [[1, 5], [2, 5], [3, 5]]);
    });

    await t.test("auto_assign_minutes changed between ticks takes effect", async () => {
      await reset();
      await operator(1, "Anna");
      await setting("auto_assign_minutes", 10);
      const id = await ticket({ queued_at: sql`now() - interval '7 minutes'` });
      assert.equal((await worker.tick(undefined, deps)).assigned, 0);
      assert.equal((await row(id)).status, "new");
      await setting("auto_assign_minutes", 5);
      assert.equal((await worker.tick(undefined, deps)).assigned, 1);
      assert.equal(Number((await row(id)).assigned_operator_id), 1);
    });

    await t.test("overdue: one alert per waiting period, again after a new user message", async () => {
      await reset();
      await operator(1, "Anna");
      const id = await ticket({
        status: "allocated", assigned_operator_id: 1, queued_at: null,
        waiting_since: sql`now() - interval '6 minutes'`,
      });
      const ok = await ticket({ status: "allocated", assigned_operator_id: 1, queued_at: null, waiting_since: sql`now() - interval '3 minutes'` });
      const r1 = await worker.tick(undefined, deps);
      assert.equal(r1.overdue, 1);
      assert.equal(sent.overdue.length, 1);
      assert.equal(sent.overdue[0]!.id, id);
      assert.equal(sent.overdue[0]!.minutes, 6);
      assert.ok((await row(id)).overdue_pinged_at instanceof Date);
      assert.equal((await row(ok)).overdue_pinged_at, null);

      assert.equal((await worker.tick(undefined, deps)).overdue, 0, "same waiting period pings once");
      assert.equal(sent.overdue.length, 1);

      // Agent replies, then the user writes again: a new waiting period on the follow-up target (15 min).
      await sql`update support_requests set waiting_since = null where id = ${ok}`;
      await sql`update support_requests set first_response_at = now(), waiting_since = null where id = ${id}`;
      await sql`update support_requests set waiting_since = now() + interval '1 minute' where id = ${id}`;
      await sql`update crm_operators set last_active_at = now() + interval '30 minutes'`;
      assert.equal((await worker.tick(minsFromNow(10), deps)).overdue, 0, "follow-up target not reached yet");
      const r2 = await worker.tick(minsFromNow(17), deps);
      assert.equal(r2.overdue, 1);
      assert.equal(sent.overdue.length, 2);
      assert.equal(sent.overdue[1]!.minutes, 16);

      await reset();
      await setting("tg_ping_overdue", false);
      const quiet = await ticket({ status: "awaiting", queued_at: null, waiting_since: sql`now() - interval '30 minutes'` });
      assert.equal((await worker.tick(undefined, deps)).overdue, 1);
      assert.equal(sent.overdue.length, 0);
      assert.ok((await row(quiet)).overdue_pinged_at instanceof Date, "marked even when the ping is off");
    });

    await t.test("alert failures never break tick", async () => {
      await reset();
      const boom = async () => { throw Object.assign(new Error("tg down"), { code: "ETIMEDOUT" }); };
      await ticket({ status: "awaiting", queued_at: null, waiting_since: sql`now() - interval '30 minutes'` });
      await ticket();
      const r = await worker.tick(undefined, { alert: { newTicket: boom, overdue: boom, noOneOnShift: boom } });
      assert.equal(r.overdue, 1);
    });

    await t.test("stuck pending agent deliveries older than 2 minutes become failed", async () => {
      await reset();
      const id = await ticket({ status: "allocated", queued_at: null });
      const [old] = await sql`insert into support_messages (ticket_id, sender, body, delivery_status, created_at)
        values (${id}, 'agent', 'hi', 'pending', now() - interval '3 minutes') returning id`;
      const [young] = await sql`insert into support_messages (ticket_id, sender, body, delivery_status, created_at)
        values (${id}, 'agent', 'hi', 'pending', now() - interval '30 seconds') returning id`;
      const [sentOk] = await sql`insert into support_messages (ticket_id, sender, body, delivery_status, created_at)
        values (${id}, 'agent', 'hi', 'sent', now() - interval '3 minutes') returning id`;
      await worker.tick(undefined, deps);
      const m = async (mid: string) => (await sql`select delivery_status, delivery_error from support_messages where id = ${mid}`)[0]!;
      assert.deepEqual({ ...(await m(old!.id)) }, { delivery_status: "failed", delivery_error: "tg_interrupted: повторите отправку" });
      assert.deepEqual({ ...(await m(young!.id)) }, { delivery_status: "pending", delivery_error: null });
      assert.equal((await m(sentOk!.id)).delivery_status, "sent");
      await settle();
      assert.ok(events.some((e) => e.type === "message.created" && e.ticketId === id && e.messageId === old!.id));
    });

    await t.test("first user message of a ticket: notify new_ticket broadcast + TG alert, once", async () => {
      await reset();
      alertsMod.setActiveAlerts(alert);
      const [tk] = await sql`insert into support_requests (user_tg, user_name, source, first_message, queued_at)
        values (777, 'Иван', 'bot', 'help', now()) returning *`;
      const ticketRow = tk as unknown as import("../dist/db.js").Ticket;
      await inbound.recordUserMessage(ticketRow, { kind: "text", body: `Не работает карта ${"я".repeat(150)}\nподробности` },
        { authorId: "tg:777", sourceId: "tg:777:1" });
      await inbound.recordUserMessage(ticketRow, { kind: "text", body: "ещё" }, { authorId: "tg:777", sourceId: "tg:777:2" });
      await settle();
      const notes = events.filter((e) => e.type === "notify" && e.kind === "new_ticket");
      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.operatorId, null);
      assert.equal(notes[0]!.title, "Новое обращение");
      assert.equal(notes[0]!.ticketId, tk!.id);
      assert.ok(String(notes[0]!.body).startsWith("Иван: Не работает карта"));
      assert.equal(sent.newTicket.length, 1);
      assert.equal(sent.newTicket[0]!.id, tk!.id);
      assert.equal(sent.newTicket[0]!.user_name, "Иван");

      await reset();
      await setting("tg_ping_new_ticket", false);
      alertsMod.setActiveAlerts(alert);
      const [tk2] = await sql`insert into support_requests (user_tg, user_name, source, first_message, queued_at)
        values (778, null, 'bot', 'help', now()) returning *`;
      await inbound.recordUserMessage(tk2 as never, { kind: "text", body: "привет" }, { authorId: "tg:778", sourceId: "tg:778:1" });
      await settle();
      assert.equal(sent.newTicket.length, 0, "TG ping off");
      assert.equal(events.filter((e) => e.type === "notify" && e.kind === "new_ticket").length, 1, "in-CRM notify still goes out");

      await reset();
      const [tk3] = await sql`insert into support_requests (user_tg, user_name, source, first_message, queued_at)
        values (779, 'Ира', 'bot', 'help', now()) returning *`;
      await inbound.recordUserMessage(tk3 as never, { kind: "text", body: "привет" }, { authorId: "tg:779", sourceId: "tg:779:1" });
      await settle();
      assert.equal(sent.newTicket.length, 0, "no TG alerts registered (bitrix mode)");
    });
  } finally {
    alertsMod.setActiveAlerts(null);
    await listener.unlisten();
    await sql.end({ timeout: 5 });
    const { sql: appSql } = await import("../dist/db.js");
    await appSql.end({ timeout: 5 });
  }
});
