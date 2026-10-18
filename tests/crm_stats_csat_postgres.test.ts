import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;
const msk = (s: string) => `2026-${s}+03:00`;
const FROM = new Date(msk("10-03T00:00:00"));
const TO = new Date(msk("10-05T00:00:00"));
const admin = {
  id: 1, name: "Anna", email: null, role: "admin", is_lead: false, auto_assign_enabled: true, on_shift: true,
  last_active_at: null, last_assigned_at: null,
  prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
} as const;

test("stats: CSAT for team, operators and topics", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const mod = await import("../dist/crm/stats.js");
  const { DEFAULT_SETTINGS } = await import("../dist/crm/settings.js");
  try {
    await sql`insert into crm_operators(id,name,role,is_lead) values (1,'Anna','admin',false), (2,'Boris','support',false)`;
    const topic = async (name: string) => Number((await sql`select id from crm_topics where name = ${name}`)[0]!.id);
    const T = await topic("Пополнение не пришло");
    const K = await topic("Карта отклонена");
    let tg = 700;
    // Resolved ticket with an operator resolve event at `at` and a survey stamped with the same resolved_at (set in SQL).
    const survey = async (op: number, topicId: number | null, at: string, rating: "up" | "down" | null) => {
      const [r] = await sql`insert into support_requests (user_tg, source, status, topic_id, topic_source)
        values (${tg++}, 'bot', 'resolved', ${topicId}, ${topicId === null ? null : "ai"}) returning id`;
      const id = r!.id as string;
      await sql`insert into support_messages (ticket_id, sender, body, actor_type, created_at)
        values (${id}, 'user', 'x', 'customer', ${at}::timestamptz - interval '10 minutes')`;
      await sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
        values (${id}, 'status_changed', ${op}, ${sql.json({ from: "awaiting", to: "resolved" } as never)}, ${at}::timestamptz)`;
      await sql`insert into crm_csat (ticket_id, resolved_at, operator_id, channel, rating, answered_at)
        values (${id}, ${at}::timestamptz, ${op}, 'telegram', ${rating}, ${rating ? sql`now()` : null})`;
    };
    await survey(1, T, msk("10-03T10:00:00"), "up");
    await survey(1, T, msk("10-03T11:00:00"), "up");
    await survey(1, T, msk("10-03T12:00:00"), "down");
    await survey(1, K, msk("10-04T10:00:00"), "up");
    await survey(2, K, msk("10-04T11:00:00"), "down");
    await survey(2, null, msk("10-04T12:00:00"), null);
    await survey(1, T, msk("10-02T10:00:00"), "up"); // before the range: excluded

    const s = await mod.stats({ from: FROM, to: TO }, admin, DEFAULT_SETTINGS);
    const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    assert.deepEqual(pick(s.team, ["csat_pct", "csat_answers", "csat_asked"]), { csat_pct: 60, csat_answers: 5, csat_asked: 6 });
    const op = (id: number) => pick(s.operators.find((o: { operator_id: number }) => o.operator_id === id)!, ["csat_pct", "csat_answers"]);
    assert.deepEqual(op(1), { csat_pct: 75, csat_answers: 4 });
    assert.deepEqual(op(2), { csat_pct: 0, csat_answers: 1 });
    const tp = (id: number | null) => pick(s.topics.find((t: { topic_id: number | null }) => t.topic_id === id)!, ["csat_pct", "csat_answers"]);
    assert.deepEqual(tp(T), { csat_pct: 66.7, csat_answers: 3 });
    assert.deepEqual(tp(K), { csat_pct: 50, csat_answers: 2 });
    assert.deepEqual(tp(null), { csat_pct: null, csat_answers: 0 });

    const empty = await mod.stats({ from: new Date(msk("01-01T00:00:00")), to: new Date(msk("01-02T00:00:00")) }, admin, DEFAULT_SETTINGS);
    assert.deepEqual(pick(empty.team, ["csat_pct", "csat_answers", "csat_asked"]), { csat_pct: null, csat_answers: 0, csat_asked: 0 });
    for (const o of empty.operators) assert.deepEqual(pick(o, ["csat_pct", "csat_answers"]), { csat_pct: null, csat_answers: 0 });
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
