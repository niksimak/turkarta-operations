import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createAgentRoutes } from "../src/agents/routes.js";
import { createSandboxApp } from "../src/agents/sandbox.js";

const secret = "sandbox-test-secret-of-at-least-32-characters";
const id = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const writes: unknown[] = [];
  const routes = createAgentRoutes({ results: async () => [], feedback: async () => true }, secret);
  const app = createSandboxApp(routes, {
    create: async text => { writes.push(text); return id; },
    append: async (...args) => { writes.push(args); return args[0] === id; },
  });
  const request = (path: string, body: unknown, key = secret) => app.request(`/api/internal/support-ai${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-support-ai-secret": key }, body: JSON.stringify(body),
  });
  return { app, writes, request };
}

test("sandbox writes require authentication and cannot accept a real customer identity", async () => {
  const { request, writes } = fixture();
  assert.equal((await request("/sandbox/tickets", { text_ru: "Тест" }, "wrong")).status, 403);
  assert.equal((await request("/sandbox/tickets", { text_ru: "Тест", web_user_id: id })).status, 422);
  assert.equal((await request("/sandbox/tickets", { text_ru: "Тест", user_tg: 123 })).status, 422);
  assert.equal(writes.length, 0);
  const response = await request("/sandbox/tickets", { text_ru: "Можно добавить карту в Wallet?" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ticket_id: id });
  assert.equal(writes.length, 1);
});

test("sandbox permits simulated customer/operator text but rejects invented actors and missing tickets", async () => {
  const { request, writes } = fixture();
  assert.equal((await request(`/sandbox/tickets/${id}/messages`, { actor: "customer", text_ru: "Уточнение" })).status, 200);
  assert.equal((await request(`/sandbox/tickets/${id}/messages`, { actor: "human", text_ru: "Проверяем" })).status, 200);
  assert.equal((await request(`/sandbox/tickets/${id}/messages`, { actor: "automation", text_ru: "Тест" })).status, 422);
  assert.equal((await request("/sandbox/tickets/00000000-0000-4000-8000-000000000002/messages", { actor: "human", text_ru: "Тест" })).status, 404);
  assert.equal(writes.length, 3);
});

test("sandbox has no Telegram/Bitrix relay routes or public QA endpoint", async () => {
  const { app } = fixture();
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/bitrix/app/handler", { method: "POST" })).status, 404);
  assert.equal((await app.request("/tg/support/test", { method: "POST" })).status, 404);
  assert.equal((await app.request(`/api/internal/support-ai/tickets/${id}`)).status, 403);
});

test("sandbox config needs no bot credentials and rejects relay credentials or assist mode", () => {
  const env = { PATH: process.env.PATH, SUPPORT_RUNTIME: "sandbox", DATABASE_URL: "postgres://localhost/test",
    PUBLIC_BASE_URL: "https://dev.example" };
  const run = (extra = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./dist/config.js')"], {
    cwd: new URL("..", import.meta.url), env: { ...env, ...extra }, encoding: "utf8",
  });
  assert.equal(run().status, 0);
  assert.notEqual(run({ SUPPORT_BOT_TOKEN: "real-token-must-not-be-used" }).status, 0);
  assert.notEqual(run({ BITRIX_CLIENT_ID: "production-app" }).status, 0);
  assert.notEqual(run({ SUPPORT_AI_MODE: "assist" }).status, 0);
  assert.notEqual(run({ SUPPORT_RUNTIME: "relay" }).status, 0);
});
