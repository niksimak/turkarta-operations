import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;
const msk = (s: string) => `2026-${s}+03:00`;
// Range [10-03, 10-05): previous equal range is [10-01, 10-03).
const FROM = new Date(msk("10-03T00:00:00"));
const TO = new Date(msk("10-05T00:00:00"));
const admin = {
  id: 1, name: "Anna", email: null, role: "admin", is_lead: false, auto_assign_enabled: true, on_shift: true,
  last_active_at: null, last_assigned_at: null,
  prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
} as const;

test("stats: contact reasons per topic with previous range and «Без темы»", { skip: !url }, async () => {
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
    await sql`insert into crm_operators(id,name,role,is_lead) values (1,'Anna','admin',false)`;
    const topic = async (name: string) => Number((await sql`select id from crm_topics where name = ${name}`)[0]!.id);
    const topup = await topic("Пополнение не пришло");
    const card = await topic("Карта отклонена");
    const kyc = await topic("KYC/верификация");
    let tg = 500;
    // One customer message 10 minutes before an operator resolve.
    const resolved = async (topicId: number | null, at: string, actor: number | null = 1) => {
      const [r] = await sql`insert into support_requests (user_tg, source, status, topic_id, topic_source)
        values (${tg++}, 'bot', 'resolved', ${topicId}, ${topicId === null ? null : "ai"}) returning id`;
      const id = r!.id as string;
      const at10 = new Date(new Date(at).getTime() - 600_000).toISOString();
      await sql`insert into support_messages (ticket_id, sender, body, actor_type, created_at) values (${id}, 'user', 'x', 'customer', ${at10})`;
      await sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
        values (${id}, 'status_changed', ${actor}, ${sql.json({ from: "awaiting", to: "resolved" } as never)}, ${at})`;
    };
    await resolved(topup, msk("10-03T10:00:00"));
    await resolved(topup, msk("10-03T11:00:00"));
    await resolved(topup, msk("10-04T09:00:00"));
    await resolved(card, msk("10-04T10:00:00"));
    await resolved(null, msk("10-04T11:00:00"));
    await resolved(card, msk("10-01T10:00:00")); // previous range
    await resolved(card, msk("10-02T10:00:00")); // previous range
    await resolved(kyc, msk("10-02T12:00:00")); // previous range only: still listed with 0
    await resolved(kyc, msk("10-04T12:00:00"), null); // cutover close: never counts
    await resolved(topup, msk("09-30T10:00:00")); // before both ranges

    const s = await mod.stats({ from: FROM, to: TO }, admin, DEFAULT_SETTINGS);
    assert.deepEqual(s.topics, [
      { topic_id: topup, name: "Пополнение не пришло", resolved: 3, prev_resolved: 0, share_pct: 60, resolution_median_s: 600, csat_pct: null, csat_answers: 0 },
      { topic_id: card, name: "Карта отклонена", resolved: 1, prev_resolved: 2, share_pct: 20, resolution_median_s: 600, csat_pct: null, csat_answers: 0 },
      { topic_id: null, name: "Без темы", resolved: 1, prev_resolved: 0, share_pct: 20, resolution_median_s: 600, csat_pct: null, csat_answers: 0 },
      { topic_id: kyc, name: "KYC/верификация", resolved: 0, prev_resolved: 1, share_pct: 0, resolution_median_s: null, csat_pct: null, csat_answers: 0 },
    ]);

    const empty = await mod.stats({ from: new Date(msk("01-01T00:00:00")), to: new Date(msk("01-02T00:00:00")) }, admin, DEFAULT_SETTINGS);
    assert.deepEqual(empty.topics, []);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
