import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

// Moscow range [10-01 00:00, 10-05 00:00). 2026-10-01 is a Thursday (ISO 4), 10-03 a Saturday (ISO 6).
const FROM = new Date("2026-10-01T00:00:00+03:00");
const TO = new Date("2026-10-05T00:00:00+03:00");
const msk = (s: string) => `2026-${s}+03:00`;

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const D = "00000000-0000-0000-0000-00000000000d";
const E = "00000000-0000-0000-0000-00000000000e";
const F = "00000000-0000-0000-0000-00000000000f";

const admin = {
  id: 1, name: "Anna", email: null, role: "admin", is_lead: false, auto_assign_enabled: true, on_shift: true,
  last_active_at: null, last_assigned_at: null,
  prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
} as const;

test("stats: resolution time, one-reply share, messages per ticket, heatmap", { skip: !url }, async () => {
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

    let tg = 100;
    const ticket = (id: string, source: string, status: string, created: string) =>
      sql`insert into support_requests (id, user_tg, source, status, created_at)
          values (${id}, ${tg++}, ${source}, ${status}, ${created})`;
    const msg = (t: string, sender: string, kind: string, actor: string, author: string | null, at: string) =>
      sql`insert into support_messages (ticket_id, sender, body, kind, actor_type, author_id, created_at)
          values (${t}, ${sender}, 'x', ${kind}, ${actor}, ${author}, ${at})`;
    const user = (t: string, at: string) => msg(t, "user", "text", "customer", null, at);
    const resolve = (t: string, op: number | null, at: string, payload: object = { from: "awaiting", to: "resolved" }) =>
      sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
          values (${t}, 'status_changed', ${op}, ${sql.json(payload as never)}, ${at})`;
    const reopened = (t: string, at: string) =>
      sql`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload, created_at)
          values (${t}, 'reopened', null, ${sql.json({} as never)}, ${at})`;

    // A (bot): customer 10:00, Anna reply 10:05, Anna note 10:10 (not a message), automated resolve text 10:20
    // (not a message), Anna resolves 10:20. Cycle 1200 s, 1 reply, 2 messages, not reopened.
    await ticket(A, "bot", "resolved", msk("10-01T10:00:00"));
    await user(A, msk("10-01T10:00:00"));
    await msg(A, "agent", "text", "human", "crm:1", msk("10-01T10:05:00"));
    await msg(A, "agent", "note", "human", "crm:1", msk("10-01T10:10:00"));
    await msg(A, "agent", "text", "automation", "crm:system", msk("10-01T10:20:00"));
    await resolve(A, 1, msk("10-01T10:20:00"));

    // F (miniapp): first cycle before the range (customer 09-30 09:00, Boris 09:05, Boris resolves 09:10).
    // Reopened 10-02 09:00 by a new customer message; Boris text 09:10 + photo 09:20, resolves 09:30.
    // Second cycle starts at 10-02 09:00: 1800 s, 2 replies, 3 messages.
    await ticket(F, "miniapp", "resolved", msk("09-30T09:00:00"));
    await user(F, msk("09-30T09:00:00"));
    await msg(F, "agent", "text", "human", "crm:2", msk("09-30T09:05:00"));
    await resolve(F, 2, msk("09-30T09:10:00"));
    await reopened(F, msk("10-02T09:00:00"));
    await user(F, msk("10-02T09:00:00"));
    await msg(F, "agent", "text", "human", "crm:2", msk("10-02T09:10:00"));
    await msg(F, "agent", "photo", "human", "crm:2", msk("10-02T09:20:00"));
    await resolve(F, 2, msk("10-02T09:30:00"));

    // B (web-onboarding): welcome ticket created at signup 08:00; customer first writes 12:00, Anna video 12:10,
    // Anna resolves 12:40 → 2400 s (not 16800), 1 reply, 2 messages; then reopened 13:00 → not one-reply.
    await ticket(B, "web-onboarding", "awaiting", msk("10-03T08:00:00"));
    await user(B, msk("10-03T12:00:00"));
    await msg(B, "agent", "video", "human", "crm:1", msk("10-03T12:10:00"));
    await resolve(B, 1, msk("10-03T12:40:00"));
    await reopened(B, msk("10-03T13:00:00"));
    await user(B, msk("10-03T13:00:00"));

    // C (bot): customer 23:00 МСК (20:00 UTC), closed by the backlog cutover (no actor): heatmap only.
    await ticket(C, "bot", "resolved", msk("10-03T23:00:00"));
    await user(C, msk("10-03T23:00:00"));
    await resolve(C, null, msk("10-04T00:00:00"), { from: "new", to: "resolved", reason: "cutover_backlog" });

    // D (bot): resolved before the range: excluded everywhere.
    await ticket(D, "bot", "resolved", msk("09-30T10:00:00"));
    await user(D, msk("09-30T10:00:00"));
    await msg(D, "agent", "text", "human", "crm:1", msk("09-30T10:05:00"));
    await resolve(D, 1, msk("09-30T11:00:00"));

    // E (web-onboarding): Anna resolves a welcome ticket nobody wrote in: no cycle.
    await ticket(E, "web-onboarding", "resolved", msk("10-04T09:00:00"));
    await resolve(E, 1, msk("10-04T10:00:00"));

    const s = await mod.stats({ from: FROM, to: TO }, admin, DEFAULT_SETTINGS);

    assert.equal(s.team.resolution_median_s, 1800); // [1200, 1800, 2400]
    assert.equal(s.team.one_reply_pct, 33.3); // A of {A, F, B}
    assert.equal(s.team.messages_per_ticket, 2.3); // (2 + 3 + 2) / 3
    assert.deepEqual(s.team.heatmap, [
      { dow: 4, hour: 10, n: 1 }, // A
      { dow: 6, hour: 12, n: 1 }, // B (first customer message, not created_at 08:00)
      { dow: 6, hour: 23, n: 1 }, // C, Moscow hour
    ]); // F's first customer message is 09-30, D's too; E has none

    const pick = (id: number) => {
      const o = s.operators.find((r) => r.operator_id === id)!;
      return { resolution_median_s: o.resolution_median_s, one_reply_pct: o.one_reply_pct };
    };
    assert.deepEqual(pick(1), { resolution_median_s: 1800, one_reply_pct: 50 }); // A 1200, B 2400; A yes, B reopened
    assert.deepEqual(pick(2), { resolution_median_s: 1800, one_reply_pct: 0 }); // F 1800, two replies

    // Empty range: no cycles, no heatmap.
    const empty = await mod.stats({ from: new Date("2026-01-01T00:00:00+03:00"), to: new Date("2026-01-02T00:00:00+03:00") },
      admin, DEFAULT_SETTINGS);
    assert.equal(empty.team.resolution_median_s, null);
    assert.equal(empty.team.one_reply_pct, null);
    assert.equal(empty.team.messages_per_ticket, null);
    assert.deepEqual(empty.team.heatmap, []);
    assert.deepEqual(empty.operators.map((o) => [o.name, o.resolution_median_s, o.one_reply_pct]),
      [["Anna", null, null], ["Boris", null, null]]);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
