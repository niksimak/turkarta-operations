import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

// Fixed Moscow-time range [10-01 00:00, 10-05 00:00): days 10-01..10-04; 10-03 has no new tickets.
const FROM = new Date("2026-10-01T00:00:00+03:00");
const TO = new Date("2026-10-05T00:00:00+03:00");
const msk = (s: string) => `2026-${s}+03:00`;

// The resolution metrics have their own fixture (crm_stats_resolution_postgres.test.ts).
const NEW_TEAM = ["resolution_median_s", "one_reply_pct", "messages_per_ticket", "heatmap", "csat_pct", "csat_answers", "csat_asked"];
const NEW_OP = ["resolution_median_s", "one_reply_pct", "csat_pct", "csat_answers"];
const omit = (o: object, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";
const T3 = "00000000-0000-0000-0000-000000000003";
const T4 = "00000000-0000-0000-0000-000000000004";
const T5 = "00000000-0000-0000-0000-000000000005";

function op(id: number, name: string, role: "admin" | "support", is_lead: boolean) {
  return {
    id, name, email: null, role, is_lead, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null,
    prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
  } as const;
}

test("stats: team block and per-operator rows from a fixed fixture", { skip: !url }, async () => {
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
  const settings = { ...DEFAULT_SETTINGS, sla_first_minutes: 5, sla_followup_minutes: 15 };
  try {
    await sql`insert into crm_operators(id,name,role,is_lead) values
      (1,'Anna','support',false), (2,'Boris','support',true), (3,'Zoe','admin',false)`;

    const ticket = (id: string, source: string, created: string, status: string, extra: {
      first_response_at?: string; waiting_since?: unknown; assigned?: number | null;
    } = {}) => sql`insert into support_requests
      (id, user_tg, source, status, created_at, first_response_at, waiting_since, assigned_operator_id)
      values (${id}, ${Number(id.slice(-1))}, ${source}, ${status}, ${created},
              ${extra.first_response_at ?? null}, ${(extra.waiting_since as string) ?? null}, ${extra.assigned ?? null})`;
    const msg = (ticketId: string, sender: string, kind: string, at: string, author: string | null, resp: number | null) =>
      sql`insert into support_messages (ticket_id, sender, body, kind, author_id, response_seconds, created_at)
          values (${ticketId}, ${sender}, 'x', ${kind}, ${author}, ${resp}, ${at})`;
    const ev = (ticketId: string, type: string, actor: number | null, payload: object, at: string) =>
      sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
          values (${ticketId}, ${type}, ${actor}, ${sql.json(payload as never)}, ${at})`;

    // T1 bot, created exactly at FROM (UTC day 09-30, Moscow day 10-01). Anna takes, replies twice, resolves; reopened.
    await ticket(T1, "bot", msk("10-01T00:00:00"), "new", { first_response_at: msk("10-01T00:04:00") });
    await sql`update support_requests set waiting_since = now() - interval '10 minutes' where id = ${T1}`;
    await ev(T1, "created", null, {}, msk("10-01T00:00:00"));
    await ev(T1, "assigned", 1, { operator_id: 1, operator_name: "Anna" }, msk("10-01T00:02:00"));
    await msg(T1, "user", "text", msk("10-01T00:00:00"), null, null);
    await msg(T1, "agent", "text", msk("10-01T00:04:00"), "crm:1", 240); // first reply, in SLA (<=300)
    await msg(T1, "user", "text", msk("10-01T00:10:00"), null, null);
    await msg(T1, "agent", "text", msk("10-01T00:30:00"), "crm:1", 1200); // follow-up, out (>900)
    await ev(T1, "status_changed", 1, { from: "awaiting", to: "resolved" }, msk("10-01T00:40:00"));
    await ev(T1, "reopened", null, {}, msk("10-01T01:00:00"));

    // T2 miniapp, Moscow day 10-02 (UTC 10-01). Auto-assigned to Boris, first reply 600 s (out), resolved.
    await ticket(T2, "miniapp", msk("10-02T01:00:00"), "resolved", { first_response_at: msk("10-02T01:10:00"), assigned: 2 });
    await ev(T2, "auto_assigned", null, { operator_id: 2, operator_name: "Boris" }, msk("10-02T01:05:00"));
    await msg(T2, "agent", "text", msk("10-02T01:10:00"), "crm:2", 600);
    await ev(T2, "status_changed", 2, { from: "awaiting", to: "resolved" }, msk("10-02T01:20:00"));

    // T3 web-onboarding: a welcome ticket created at signup, 3 h before the customer wrote. Its first-response
    // time is the reply's 180 s, not first_response_at - created_at. Anna assigns to Boris (counts for nobody).
    // Boris: first 180 (in), note, photo 1000 (out), unmeasured video reply.
    await ticket(T3, "web-onboarding", msk("10-02T09:00:00"), "awaiting", { first_response_at: msk("10-02T12:03:00"), assigned: 2 });
    await ev(T3, "assigned", 1, { operator_id: 2, operator_name: "Boris" }, msk("10-02T12:00:30"));
    await msg(T3, "agent", "text", msk("10-02T12:03:00"), "crm:2", 180);
    await msg(T3, "agent", "note", msk("10-02T12:05:00"), "crm:2", null);
    await msg(T3, "agent", "photo", msk("10-02T12:20:00"), "crm:2", 1000);
    await msg(T3, "agent", "video", msk("10-02T12:21:00"), "crm:2", null);
    await msg(T3, "agent", "text", msk("10-05T00:00:00"), "crm:2", 30); // at TO: excluded (half-open)

    // T4 web, Moscow day 10-04. Anna takes over; a Bitrix reply (no crm author) is ignored; waiting 42m10s.
    await ticket(T4, "web", msk("10-04T09:00:00"), "allocated", { assigned: 1 });
    await sql`update support_requests set waiting_since = now() - interval '42 minutes 10 seconds' where id = ${T4}`;
    await ev(T4, "taken_over", 1, { operator_id: 1, operator_name: "Anna" }, msk("10-04T09:30:00"));
    await msg(T4, "agent", "text", msk("10-04T09:40:00"), null, 50);
    await ev(T4, "status_changed", 1, { from: "allocated", to: "awaiting" }, msk("10-04T09:45:00"));
    await ev(T4, "taken_over", 1, { operator_id: 1, operator_name: "Anna" }, msk("10-05T00:00:00")); // at TO: excluded

    // T5 bot, created before FROM. Pre-range take and first reply excluded; in-range follow-up 100 (in) and resolve count.
    await ticket(T5, "bot", msk("09-30T23:00:00"), "resolved", { first_response_at: msk("09-30T23:10:00"), assigned: 1 });
    await ev(T5, "assigned", 1, { operator_id: 1, operator_name: "Anna" }, msk("09-30T23:05:00"));
    await msg(T5, "agent", "text", msk("09-30T23:10:00"), "crm:1", 600);
    await msg(T5, "agent", "text", msk("10-03T14:00:00"), "crm:1", 100);
    await ev(T5, "status_changed", 1, { from: "awaiting", to: "resolved" }, msk("10-03T15:00:00"));

    const range = { from: FROM, to: TO };
    const zoe = await mod.stats(range, op(3, "Zoe", "admin", false), settings);

    assert.deepEqual(omit(zoe.team, NEW_TEAM), {
      new_per_day: [
        { day: "2026-10-01", bot: 1, miniapp: 0, web: 0 },
        { day: "2026-10-02", bot: 0, miniapp: 1, web: 1 },
        { day: "2026-10-03", bot: 0, miniapp: 0, web: 0 },
        { day: "2026-10-04", bot: 0, miniapp: 0, web: 1 },
      ],
      backlog: 3,
      oldest_waiting_minutes: 42,
      within_sla_pct: 50, // 3 of 6 measured CRM replies
    });

    const anna = {
      operator_id: 1, name: "Anna", taken: 2, auto_assigned: 0, resolved: 2, replies: 3,
      response_median_s: 240, response_p90_s: 1008, // [100, 240, 1200]
      first_response_median_s: 240, first_response_p90_s: 240,
      within_sla_pct: 66.7, reopen_rate_pct: 50,
    };
    const boris = {
      operator_id: 2, name: "Boris", taken: 0, auto_assigned: 1, resolved: 1, replies: 4,
      response_median_s: 600, response_p90_s: 920, // [180, 600, 1000]
      first_response_median_s: 390, first_response_p90_s: 558, // [180, 600]; T3 is not 10980
      within_sla_pct: 33.3, reopen_rate_pct: 0,
    };
    const zoeRow = {
      operator_id: 3, name: "Zoe", taken: 0, auto_assigned: 0, resolved: 0, replies: 0,
      response_median_s: null, response_p90_s: null, first_response_median_s: null, first_response_p90_s: null,
      within_sla_pct: null, reopen_rate_pct: null,
    };
    assert.deepEqual(zoe.operators.map((o) => omit(o, NEW_OP)), [anna, boris, zoeRow]);

    // Lead sees every row; a plain support operator sees the team block and only their own row.
    const lead = await mod.stats(range, op(2, "Boris", "support", true), settings);
    assert.deepEqual(lead.operators.map((o) => omit(o, NEW_OP)), [anna, boris, zoeRow]);
    const own = await mod.stats(range, op(1, "Anna", "support", false), settings);
    assert.deepEqual(own.team, zoe.team);
    assert.deepEqual(own.operators.map((o) => omit(o, NEW_OP)), [anna]);

    // Stricter follow-up target moves Anna's 100 s reply out of SLA: 1 of 3.
    const strict = await mod.stats(range, op(1, "Anna", "support", false), { ...settings, sla_followup_minutes: 1 });
    assert.equal(strict.operators[0]!.within_sla_pct, 33.3);
    assert.equal(strict.team.within_sla_pct, 33.3); // T1 240 first + T3 180 first of 6

    // Empty range: one zero day, null percentages, backlog still reflects now.
    const empty = await mod.stats({ from: new Date("2026-01-01T00:00:00+03:00"), to: new Date("2026-01-02T00:00:00+03:00") },
      op(3, "Zoe", "admin", false), settings);
    assert.deepEqual(omit(empty.team, NEW_TEAM), {
      new_per_day: [{ day: "2026-01-01", bot: 0, miniapp: 0, web: 0 }],
      backlog: 3, oldest_waiting_minutes: 42, within_sla_pct: null,
    });
    assert.deepEqual(empty.operators.map((o) => [o.name, o.replies, o.within_sla_pct, o.response_median_s]),
      [["Anna", 0, null, null], ["Boris", 0, null, null], ["Zoe", 0, null, null]]);

    // No open tickets: backlog 0 and no oldest wait.
    await sql`update support_requests set status = 'resolved', waiting_since = null`;
    const closed = await mod.stats(range, op(3, "Zoe", "admin", false), settings);
    assert.equal(closed.team.backlog, 0);
    assert.equal(closed.team.oldest_waiting_minutes, null);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
