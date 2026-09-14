import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticClient, attachDiagnostics, ticketSubject, type Snapshot } from "../src/agents/diagnostics.js";
import { taskSummary } from "../src/agents/operations-contracts.js";
import { readiness } from "../src/agents/readiness.js";
import { createAgentRoutes } from "../src/agents/routes.js";

const id = "00000000-0000-4000-8000-000000000001";
const ticket = { channel: "web", web_user_id: id, user_tg: null };
function snapshot(): Snapshot {
  return { schema_version: 1, subject: { kind: "web", id }, observed_at: new Date().toISOString(),
    source: "internal_snapshot", provider_verified: false, status: "available", truncated: false, cards: [], csb_kyc: null,
    topups: [{ id, card_id: null, provider: "csb", state: "funding_failed", created_at: new Date().toISOString(),
      record_updated_at: new Date().toISOString(), rail_paid_at: new Date().toISOString(), funded_at: null,
      error_category: "upstream_5xx", prior_auto_retry_recorded: true }] };
}
const options = { url: "https://api.example.test", secret: "test-only-diagnostic-secret-0000000" };
const result = { classification: { categories: ["payment"], summary_ru: "Пополнение не пришло" },
  policy: { teams: ["payments"] as ["payments"], money_related: true, off_topic_only: false,
    automatic_send_allowed: false, financial_actions_allowed: false },
  diagnostic_status: "not_connected", escalation_ru: "Требуется проверка", draft_reply_ru: "Оператор проверит." };

test("diagnostics use stored identity, fixed endpoint and separate secret; 500 remains uncertain", async () => {
  let calls = 0;
  const client = new DiagnosticClient({ ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), `${options.url}/internal/support-diagnostics/snapshot`);
    assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { kind: "web", id });
    assert.equal((init?.headers as Record<string,string>)["X-Support-Diagnostics-Secret"], options.secret);
    return Response.json(snapshot());
  } });
  const diagnosed = await attachDiagnostics(result, ticket, client);
  assert.equal(calls, 1);
  assert.equal(diagnosed.diagnostic_status, "available");
  assert.match(diagnosed.escalation_ru!, /не доказывает отсутствие зачисления/);
  assert.match(diagnosed.escalation_ru!, /предыдущая автоматическая попытка/);
  assert.equal(diagnosed.draft_reply_ru, result.draft_reply_ru);
  assert.equal(diagnosed.policy.financial_actions_allowed, false);
  assert.match(taskSummary(diagnosed), /внутренний снимок/);
});

test("wrong subject, stale evidence, raw provider fields, and oversized responses fail closed", async () => {
  for (const payload of [
    { ...snapshot(), subject: { kind: "telegram", id: "123" } },
    { ...snapshot(), observed_at: "2020-01-01T00:00:00Z" },
    { ...snapshot(), raw_body: "secret" },
    { ...snapshot(), provider_verified: true },
    { ...snapshot(), status: "identity_ambiguous" },
    "x".repeat(65000),
  ]) {
    const client = new DiagnosticClient({ ...options, fetch: async () => Response.json(payload) });
    const diagnosed = await client.inspect(ticket);
    assert.equal(diagnosed.status, "unavailable"); assert.equal(diagnosed.snapshot, undefined);
  }
});

test("missing or untrusted identity and unsafe origins do not cause outbound requests", async () => {
  const noFetch: typeof fetch = async () => { assert.fail("No outbound call allowed"); };
  assert.equal(ticketSubject({ ...ticket, web_user_id: "user-supplied-email@example.test" }), null);
  assert.equal(ticketSubject({ ...ticket, channel: "other" }), null);
  assert.equal(ticketSubject({ channel: "telegram", web_user_id: id, user_tg: null }), null);
  assert.equal((await new DiagnosticClient({ fetch: noFetch }).inspect(ticket)).status, "not_connected");
  assert.equal((await new DiagnosticClient({ ...options, fetch: noFetch }).inspect({ ...ticket, web_user_id: null })).status, "identity_missing");
  for (const url of ["http://api.example.test", "https://api.example.test/admin", "https://user:pass@api.example.test"]) {
    assert.equal((await new DiagnosticClient({ ...options, url, fetch: noFetch }).inspect(ticket)).status, "unavailable");
  }
});

test("diagnostic outages preserve human handoff, and off-topic/general cases skip account reads", async () => {
  const client = new DiagnosticClient({ ...options, fetch: async () => { throw new Error("secret network failure"); } });
  const diagnosed = await attachDiagnostics(result, ticket, client);
  assert.equal(diagnosed.diagnostic_status, "unavailable");
  assert.equal(diagnosed.draft_reply_ru, result.draft_reply_ru);
  assert.ok(!JSON.stringify(diagnosed).includes("secret network"));
  const forbidden = new DiagnosticClient({ ...options, fetch: async () => { assert.fail("No account lookup"); } });
  const general = { ...result, classification: { categories: ["general"] }, policy: { money_related: false, off_topic_only: false } };
  assert.equal(await attachDiagnostics(general, ticket, forbidden), general);
  const offTopic = { ...general, policy: { money_related: false, off_topic_only: true } };
  assert.equal(await attachDiagnostics(offTopic, ticket, forbidden), offTopic);
});

test("readiness is protected, contains no credentials and does not claim connectivity", async () => {
  const env = { SUPPORT_AI_MODE: "shadow", SUPPORT_AI_MODEL: "gpt-5.4-nano", OPENAI_API_KEY: "secret-model-key",
    SUPPORT_AI_ADMIN_SECRET: "secret-admin", SUPPORT_AI_KB_API: "https://private.example.test/kb",
    SUPPORT_AI_OWNER_ROUTES: { support: { primary_tg: 123, backup_tg: 456 } },
    SUPPORT_AI_DIAGNOSTICS_URL: options.url, SUPPORT_AI_DIAGNOSTICS_SECRET: options.secret };
  const inspect = () => readiness(env as Parameters<typeof readiness>[0]);
  const app = createAgentRoutes({ async results() { return []; }, async feedback() { return true; } }, "test-admin", undefined, "shadow", inspect);
  assert.equal((await app.request("/readiness")).status, 403);
  const response = await app.request("/readiness", { headers: { "x-support-ai-secret": "test-admin" } });
  const text = await response.text(); const body = JSON.parse(text);
  assert.equal(body.connectivity, "not_checked"); assert.equal(body.financial_actions, false);
  assert.ok(!text.includes("secret") && !text.includes("example.test") && !text.includes("123"));
});
