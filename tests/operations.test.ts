import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Bot } from "grammy";
import { canAct, type InternalTask, type Notification, type OperationsOptions } from "../src/agents/operations-contracts.js";
import { DeliveryError, deliverOne, renderDigest, renderTask } from "../src/agents/operations-delivery.js";
import { registerOperationsHandlers } from "../src/agents/operations-telegram.js";
import type { OperationsStore } from "../src/agents/operations-store.js";

const id = "00000000-0000-4000-8000-000000000001";
const options: OperationsOptions = { chatId: -100101, qaChatId: -100102,
  routes: { support: { primary_tg: 111, backup_tg: 222 } },
  acknowledgeMinutes: 10, updateMinutes: 60, maxReminders: 3, digestHourUtc: 4 };
const task: InternalTask = { id, ticket_id: id, job_id: id, team: "payments", through_seq: 1, revision: 1,
  primary_tg: 111, backup_tg: 222, owner_tg: 111, status: "assigned", summary_ru: "Ошибка CSB 500 <b>test</b>",
  money_related: true, due_at: "2026-09-06T12:00:00Z", reminder_count: 0, needs_attention: false };
const notification: Notification = { id, task_id: id, kind: "task", chat_id: options.chatId,
  payload: { revision: 1 }, lease_token: id, attempts: 1 };

function deliveryStore(n = notification, t: InternalTask | null = task) {
  const outcomes: unknown[] = [];
  return {
    outcomes,
    async claimNotification() { return n; }, async task() { return t; },
    async notificationSent(_n: Notification, messageId: number) { outcomes.push(["sent",messageId]); },
    async notificationFailed(_n: Notification, status: string, code: string, retry = 0) { outcomes.push([status,code,retry]); },
  };
}

test("only configured owner/backup may accept; only actual owner may update", () => {
  assert.equal(canAct(task, 111, "accept"), true);
  assert.equal(canAct(task, 222, "accept"), true);
  assert.equal(canAct(task, 333, "accept"), false);
  assert.equal(canAct(task, 111, "done"), false);
  assert.equal(canAct({ ...task, status: "accepted", owner_tg: 222 }, 111, "done"), false);
  assert.equal(canAct({ ...task, status: "accepted", owner_tg: 222 }, 222, "done"), true);
  assert.equal(canAct({ ...task, status: "resolved" }, 111, "accept"), false);
});

test("internal message escapes untrusted HTML, retains financial boundary and fits Telegram buttons", () => {
  const message = renderTask(task, true);
  assert.ok(message.html.includes("&lt;b&gt;test&lt;/b&gt;"));
  assert.ok(message.html.includes("Денежные действия — только вручную оператором"));
  assert.ok(message.html.includes("tg://user?id=222"));
  assert.ok(message.html.length < 4096);
  for (const b of message.buttons!) assert.ok(Buffer.byteLength(b.data) <= 64);
});

test("dispatch uses configured internal group and saves delivery receipt", async () => {
  const store = deliveryStore();
  await deliverOne(store, { async send(chatId, message) {
    assert.equal(chatId, options.chatId); assert.ok(message.html.includes("Внутренняя задача")); return 321;
  } }, options);
  assert.deepEqual(store.outcomes, [["sent",321]]);
});

test("changed destinations, task revisions and closed tasks prevent delivery", async () => {
  for (const store of [deliveryStore({ ...notification, chat_id: -999 }),
    deliveryStore(notification, { ...task, revision: 2 }), deliveryStore(notification, { ...task, status: "resolved" })]) {
    await deliverOne(store, { async send() { assert.fail("Must not send"); } }, options);
    assert.equal((store.outcomes[0] as string[])[0], "cancelled");
  }
});

test("ambiguous delivery never schedules an automatic resend", async () => {
  const store = deliveryStore();
  await deliverOne(store, { async send() { throw new Error("timeout"); } }, options);
  assert.deepEqual(store.outcomes, [["unknown","delivery_unknown",0]]);
});

test("Telegram rate limits allow bounded retry; definite failures stop", async () => {
  const store = deliveryStore();
  await deliverOne(store, { async send() { throw new DeliveryError("rate_limited",120); } }, options);
  assert.deepEqual(store.outcomes, [["pending","telegram_rate_limited",120]]);
  const exhausted = deliveryStore({ ...notification, attempts: 3 });
  await deliverOne(exhausted, { async send() { throw new DeliveryError("rate_limited",120); } }, options);
  assert.equal((exhausted.outcomes[0] as string[])[0], "failed");
});

test("QA is confined to supervisor destination and labels provisional findings", async () => {
  const store = deliveryStore({ ...notification, task_id: null, kind: "critical", chat_id: options.qaChatId!,
    payload: { ticket_id: id, job_id: id, summary_ru: "Проверьте ответ оператора" } });
  await deliverOne(store, { async send(chatId, message) {
    assert.equal(chatId, options.qaChatId); assert.ok(message.html.includes("предварительное замечание ИИ")); return 123;
  } }, options);
  assert.ok(renderDigest({ day_utc: "2026-09-05", critical_candidates: 2, stale_reviews: 1 }).html.includes("это не рейтинг сотрудников"));
});

function botFixture(opts: OperationsOptions | undefined, belongs = true) {
  const calls: unknown[][] = [];
  const replies: unknown[] = [];
  const bot = new Bot("900:test", { botInfo: { id: 900, is_bot: true, first_name: "Support", username: "support_test_bot" } });
  bot.api.config.use(async (_prev, method, payload) => {
    replies.push([method,payload]);
    return { ok: true, result: method === "answerCallbackQuery" ? true : { message_id: 100 } } as any;
  });
  const store = { async callbackBelongs() { return belongs; }, async task() { return task; },
    async act(...args: unknown[]) { calls.push(args); return "ok"; } } as unknown as OperationsStore;
  registerOperationsHandlers(bot, store, opts);
  return { bot, calls, replies };
}
function command(chatId: number, actor = 111) {
  return { update_id: 1, message: { message_id: 7, date: 1, chat: { id: chatId, type: "supergroup" as const, title: "Internal" },
    from: { id: actor, is_bot: false, first_name: "Operator" },
    text: `/ai_done ${id} Оператор проверил результат`, entities: [{ type: "bot_command" as const, offset: 0, length: 8 }] } };
}

test("Telegram commands bind actor to update and cannot run in the customer relay group", async () => {
  const f = botFixture(options);
  await f.bot.handleUpdate(command(-100999));
  assert.equal(f.calls.length, 0);
  await f.bot.handleUpdate(command(options.chatId));
  assert.equal(f.calls[0]?.[1], 111);
  assert.equal(f.calls[0]?.[2], "done");
  const disabled = botFixture(undefined);
  await disabled.bot.handleUpdate(command(options.chatId));
  assert.equal(disabled.calls.length, 0);
});

test("callback requires known bot message and rejects unassigned actor", async () => {
  const update = { update_id: 2, callback_query: { id: "cb", chat_instance: "instance",
    from: { id: 111, is_bot: false, first_name: "Operator" }, data: `ai:accept:${id}`,
    message: { message_id: 4, date: 1, chat: { id: options.chatId, type: "supergroup" as const, title: "Internal" } } } };
  const forged = botFixture(options, false); await forged.bot.handleUpdate(update); assert.equal(forged.calls.length, 0);
  const other = botFixture(options); await other.bot.handleUpdate({ ...update, callback_query: { ...update.callback_query,
    from: { ...update.callback_query.from, id: 999 } } }); assert.equal(other.calls.length, 0);
  const valid = botFixture(options); await valid.bot.handleUpdate(update); assert.equal(valid.calls[0]?.[1], 111);
});

test("configuration refuses relay-group reuse, missing owners and public QA grouping", () => {
  const env = { PATH: process.env.PATH, LEADS_BOT_TOKEN: "test", SUPPORT_BOT_TOKEN: "test", LEADS_CHAT_ID: "-2", SUPPORT_CHAT_ID: "-1",
    DATABASE_URL: "postgres://unused", PUBLIC_BASE_URL: "https://example.com", LEADS_WEBHOOK_SECRET: "test", TELEGRAM_WEBHOOK_SECRET: "test",
    SUPPORT_AI_MODE: "assist", OPENAI_API_KEY: "test", SUPPORT_AI_ADMIN_SECRET: "x".repeat(32),
    SUPPORT_AI_OWNER_ROUTES: JSON.stringify(options.routes), SUPPORT_AI_INTERNAL_CHAT_ID: "-3", SUPPORT_AI_QA_CHAT_ID: "-4" };
  const run = (overrides: Record<string,string>) => spawnSync(process.execPath, ["--import","tsx","--input-type=module","-e","await import('./src/config.ts')"],
    { cwd: new URL("../",import.meta.url), env: { ...env, ...overrides }, encoding: "utf8" }).status;
  assert.equal(run({}), 0);
  assert.equal(run({ SUPPORT_AI_INTERNAL_CHAT_ID: "-1" }), 1);
  assert.equal(run({ SUPPORT_AI_QA_CHAT_ID: "-3" }), 1);
  assert.equal(run({ SUPPORT_AI_OWNER_ROUTES: "{}" }), 1);
  assert.equal(run({ SUPPORT_AI_DIAGNOSTICS_URL: "https://api.example.test" }), 1);
  assert.equal(run({ SUPPORT_AI_DIAGNOSTICS_SECRET: "d".repeat(32) }), 1);
  assert.equal(run({ SUPPORT_AI_DIAGNOSTICS_URL: "http://api.example.test", SUPPORT_AI_DIAGNOSTICS_SECRET: "d".repeat(32) }), 1);
  assert.equal(run({ SUPPORT_AI_DIAGNOSTICS_URL: "https://api.example.test", SUPPORT_AI_DIAGNOSTICS_SECRET: "x".repeat(32) }), 1);
  assert.equal(run({ SUPPORT_AI_DIAGNOSTICS_URL: "https://api.example.test", SUPPORT_AI_DIAGNOSTICS_SECRET: "d".repeat(32) }), 0);
});
