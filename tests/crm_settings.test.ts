import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});
const { validateSettingsPatch, DEFAULT_SETTINGS } = await import("../dist/crm/settings.js");

test("rejects out-of-range and unknown keys with field errors", () => {
  const r = validateSettingsPatch({ sla_first_minutes: 0, nope: 1 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.sla_first_minutes);
  assert.ok(r.errors.nope);
});

test("accepts edges and a null cap", () => {
  assert.equal(validateSettingsPatch({ sla_first_minutes: 1, sla_followup_minutes: 240, auto_assign_max_open: null }).ok, true);
});

test("rejects wrong types, fractions and blank text", () => {
  const r = validateSettingsPatch({ sla_warn_percent: 9, reopen_days: 1.5, auto_assign_enabled: "yes", resolve_message_text: "   " });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(Object.keys(r.errors).sort(), ["auto_assign_enabled", "reopen_days", "resolve_message_text", "sla_warn_percent"]);
  assert.equal(r.errors.sla_warn_percent, "От 10 до 90 процентов");
});

test("non-object patch is a form-level error", () => {
  const r = validateSettingsPatch(null);
  assert.equal(r.ok, false);
});

test("defaults match the spec", () => {
  assert.equal(DEFAULT_SETTINGS.sla_first_minutes, 5);
  assert.equal(DEFAULT_SETTINGS.sla_followup_minutes, 15);
  assert.equal(DEFAULT_SETTINGS.auto_assign_minutes, 5);
  assert.equal(DEFAULT_SETTINGS.sla_warn_percent, 50);
  assert.equal(DEFAULT_SETTINGS.auto_assign_max_open, null);
  assert.equal(DEFAULT_SETTINGS.offline_after_minutes, 15);
  assert.equal(DEFAULT_SETTINGS.reopen_days, 7);
  assert.equal(DEFAULT_SETTINGS.resolve_message_enabled, false);
  assert.equal(DEFAULT_SETTINGS.resolve_message_text, "Мы закрыли обращение. Если вопрос остался, просто напишите сюда.");
});
