import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});
const { telegramAlerts } = await import("../dist/crm/alerts.js");
type Item = import("../dist/crm/tickets.js").TicketListItem;

const ID = "0b5c3a52-1f7e-4c1a-9a51-0d5e6f7a8b9c";

function item(fields: Partial<Item> = {}): Item {
  return {
    id: ID, status: "new", channel: "telegram", source: "bot",
    user_name: "<b>Ivan</b> & Co", user_username: "ivan", user_tg: 1, email: null,
    last_message_preview: "Не проходит <оплата>\nвторая строка", last_message_at: null, waiting_since: null,
    first_response_at: null, assigned_operator_id: null, assigned_operator_name: null,
    auto_assigned: false, intake_pending: false, created_at: new Date(0).toISOString(), ...fields,
  };
}

function fakeApi() {
  const calls: Array<{ chatId: number; text: string; opts: Record<string, unknown> }> = [];
  const api = {
    sendMessage: async (chatId: number, text: string, opts: Record<string, unknown> = {}) => {
      calls.push({ chatId, text, opts });
      return { message_id: 1 };
    },
  };
  return { api: api as never, calls };
}

test("newTicket escapes names and text, builds the ticket link, sends to the group without a thread", async () => {
  const { api, calls } = fakeApi();
  await telegramAlerts(api, -1002, "https://ops.example/").newTicket(item());
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.chatId, -1002);
  assert.equal(c.opts.parse_mode, "HTML");
  assert.equal(c.opts.message_thread_id, undefined);
  assert.equal(c.text,
    "🆕 Новое обращение · Telegram · &lt;b&gt;Ivan&lt;/b&gt; &amp; Co\n"
    + "Не проходит &lt;оплата&gt;\n"
    + `https://ops.example/crm/t/${ID}`);
});

test("newTicket falls back to @username and caps the first line at 120 chars", async () => {
  const { api, calls } = fakeApi();
  await telegramAlerts(api, -1002, "https://ops.example").newTicket(
    item({ user_name: null, user_username: "a<b", source: "web", channel: "web", last_message_preview: "x".repeat(200) }));
  assert.equal(calls[0]!.text, `🆕 Новое обращение · Web · @a&lt;b\n${"x".repeat(120)}\nhttps://ops.example/crm/t/${ID}`);
});

test("first line is cut by code points, never inside an emoji", async () => {
  const { api, calls } = fakeApi();
  await telegramAlerts(api, -1002, "https://ops.example").newTicket(item({ last_message_preview: "😀".repeat(130) }));
  assert.equal(calls[0]!.text.split("\n")[1], "😀".repeat(120));
});

test("missing name falls back to the shared «Без имени»", async () => {
  const { api, calls } = fakeApi();
  await telegramAlerts(api, -1002, "https://ops.example").overdue(item({ user_name: null, user_username: null }), 6);
  assert.equal(calls[0]!.text, `⏰ Ждёт ответа 6 мин · Без имени\nhttps://ops.example/crm/t/${ID}`);
});

test("overdue and nobody-on-shift messages", async () => {
  const { api, calls } = fakeApi();
  const a = telegramAlerts(api, -1002, "https://ops.example");
  await a.overdue(item(), 7);
  await a.noOneOnShift(3);
  assert.equal(calls[0]!.text, `⏰ Ждёт ответа 7 мин · &lt;b&gt;Ivan&lt;/b&gt; &amp; Co\nhttps://ops.example/crm/t/${ID}`);
  assert.equal(calls[1]!.text, "🚨 Никого нет на смене, в очереди 3\nhttps://ops.example/crm");
  assert.equal(calls[1]!.opts.parse_mode, "HTML");
});
