import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("settings store: merge, changed-only audit log, invalid stored value falls back", { skip: !url }, async () => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  const sql = await freshCrmDb(url!);
  const mod = await import("../dist/crm/settings.js");
  try {
    await sql`insert into crm_operators(id,name,role) values (7,'Anna','support')`;

    assert.deepEqual(await mod.getSettings(), mod.DEFAULT_SETTINGS);

    const r1 = await mod.updateSettings({ sla_first_minutes: 10, auto_assign_max_open: 4, sla_followup_minutes: 15 }, 7);
    assert.equal(r1.ok, true);
    const logs1 = await sql`select key, old_value, new_value, operator_id from crm_settings_log order by key`;
    assert.equal(logs1.length, 2, "unchanged sla_followup_minutes is not logged");
    assert.deepEqual(logs1.map((l) => l.key), ["auto_assign_max_open", "sla_first_minutes"]);
    assert.equal(logs1[1]!.old_value, 5);
    assert.equal(logs1[1]!.new_value, 10);
    assert.equal(logs1[0]!.old_value, null);

    const s = await mod.getSettings();
    assert.equal(s.sla_first_minutes, 10);
    assert.equal(s.auto_assign_max_open, 4);
    assert.equal(s.sla_followup_minutes, 15);

    // Same values again: nothing written.
    await mod.updateSettings({ sla_first_minutes: 10 }, 7);
    assert.equal((await sql`select count(*)::int n from crm_settings_log`)[0]!.n, 2);

    // Invalid patch writes nothing and returns field errors.
    const bad = await mod.updateSettings({ sla_first_minutes: 999, bogus: true }, 7);
    assert.equal(bad.ok, false);
    assert.equal((await sql`select count(*)::int n from crm_settings_log`)[0]!.n, 2);

    // Null cap can be set back to null; log records the transition.
    await mod.updateSettings({ auto_assign_max_open: null }, 7);
    assert.equal((await mod.getSettings()).auto_assign_max_open, null);

    // Corrupt stored value falls back to the default for that key only.
    await sql`insert into crm_settings(key,value) values ('reopen_days', '"abc"'::jsonb)
      on conflict (key) do update set value = excluded.value`;
    const s2 = await mod.getSettings();
    assert.equal(s2.reopen_days, 7);
    assert.equal(s2.sla_first_minutes, 10);

    const log = await mod.settingsLog();
    assert.equal(log.length, 3);
    assert.equal(log[0]!.key, "auto_assign_max_open");
    assert.equal(log[0]!.operator_name, "Anna");
    assert.equal((await mod.settingsLog(1)).length, 1);
  } finally {
    await sql.end();
    await (await import("../dist/db.js")).sql.end();
  }
});
