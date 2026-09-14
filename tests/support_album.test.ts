import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { OpenTicketInput, Ticket } from "../src/db.js";

// Exercise the real compiled bot/router, replacing only database and network
// boundaries. Never load .env or contact Telegram, Bitrix, or a real database.
Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret",
  ROSTER: "[]",
});

const tickets = new Map<number, Ticket>();
const relayed: Array<{ id: string; body: string; files: Array<{ url: string; name: string }> }> = [];
const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
let opens = 0;
let failLookup = false;

function fixture(user: number, fields: Partial<Ticket> = {}): Ticket {
  return {
    id: `ticket-${user}`, channel: "telegram", user_tg: user,
    web_user_id: null, user_username: null, user_name: "Test",
    source: "bot", first_message: "help", first_photo_file_id: null,
    email: null, device: null, category: null, intake_step: "email",
    status: "new", claimed_by: null, claimed_by_tg: null,
    tg_chat_id: null, tg_message_id: null, thread_id: null, ...fields,
  };
}

mock.module("../dist/db.js", { namedExports: {
  sql: () => { throw new Error("Unexpected database call in album test"); },
  addMessage: async (_ticket: string, _sender: string, _body: string) => ({ id: "stored-message" }),
  ticketByUser: async (id: number) => {
    if (failLookup) { failLookup = false; throw new Error("temporary lookup failure"); }
    // Snapshot before yielding reproduces concurrent first-contact lookups.
    const row = tickets.get(id) ?? null;
    await Promise.resolve();
    return row;
  },
  openTicket: async (input: OpenTicketInput) => {
    opens++;
    const row = tickets.get(input.user_tg) ?? fixture(input.user_tg, {
      first_message: input.request, first_photo_file_id: input.first_photo_file_id ?? null,
    });
    tickets.set(input.user_tg, row);
    return row;
  },
  finishIntake: async (id: string, email: string | null) => {
    const row = [...tickets.values()].find(t => t.id === id);
    if (!row || row.intake_step !== "email") return null;
    row.email = email;
    row.intake_step = null;
    return row;
  },
  getTicket: async (id: string) => [...tickets.values()].find(t => t.id === id) ?? null,
  setCard: async (_table: string, id: string, chat: number, message: number) => {
    const row = [...tickets.values()].find(t => t.id === id)!;
    row.tg_chat_id = chat;
    row.tg_message_id = message;
  },
} });
mock.module("../dist/bitrix_openlines.js", { namedExports: {
  sendUserMessage: async (_ticket: Ticket, body: string, id: string, files = []) => {
    relayed.push({ body, id, files });
  },
} });

const { supportBot } = await import("../dist/bots/support.js");
supportBot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload: payload as Record<string, unknown> });
  if (method === "getMe") return { ok: true, result: {
    id: 456, is_bot: true, first_name: "Test", username: "test_support_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  } };
  return { ok: true, result: { message_id: sent.length, date: 1,
    chat: { id: -1002, type: "supergroup" }, text: "test" } };
});
await supportBot.init();

let sequence = 0;
function update(user: number, content: object) {
  const id = ++sequence;
  return supportBot.handleUpdate({ update_id: id, message: {
    message_id: id, date: 1,
    chat: { id: user, type: "private", first_name: "Test" },
    from: { id: user, is_bot: false, first_name: "Test" }, ...content,
  } });
}
function photo(id: string, caption?: string) {
  return { media_group_id: "album-1", caption, photo: [
    { file_id: `small-${id}`, file_unique_id: `s-${id}`, width: 90, height: 90 },
    { file_id: id, file_unique_id: id, width: 1024, height: 1024 },
  ] };
}
function reset() { tickets.clear(); relayed.length = 0; sent.length = 0; opens = 0; }
function fileIds() {
  return relayed.flatMap(m => m.files.map(f => new URL(f.url).searchParams.get("file_id"))).sort();
}

test("two-photo first-contact album preserves both photos and waits for email", async () => {
  reset();
  await update(1, photo("first", "My screenshots"));
  await update(1, photo("second", "not-an-email@example.com"));
  assert.equal(tickets.get(1)!.intake_step, "email");
  assert.equal(tickets.get(1)!.email, null);
  assert.equal(relayed[0]!.body, "not-an-email@example.com");
  await update(1, { text: "customer@example.com" });
  assert.equal(tickets.get(1)!.email, "customer@example.com");
  assert.deepEqual(fileIds(), ["first", "second"]);
  assert.equal(sent.filter(m => m.method === "sendPhoto").length, 2);
  assert.equal(relayed.find(m => m.files.some(f => new URL(f.url).searchParams.get("file_id") === "first"))!.body, "My screenshots");
});

test("ten concurrent first-contact album items create one intake and lose none", async () => {
  reset();
  await Promise.all(Array.from({ length: 10 }, (_, i) => update(2, photo(`photo-${i}`))));
  assert.equal(opens, 1);
  assert.equal(tickets.get(2)!.intake_step, "email");
  assert.equal(sent.filter(m => String(m.payload.text).includes("Оставьте email")).length, 1);
  await update(2, { text: "/skip" });
  assert.deepEqual(fileIds(), Array.from({ length: 10 }, (_, i) => `photo-${i}`));
  assert.equal(new Set(relayed.map(m => m.id)).size, 10);
  assert.equal(sent.filter(m => m.method === "sendPhoto").length, 10);
  assert.equal(sent.filter(m => String(m.payload.text).includes("Подключаем оператора")).length, 1);
});

test("photos after text-first intake and after completion all reach the same ticket", async () => {
  reset();
  await update(3, { text: "Please help" });
  await update(3, photo("before-email"));
  await update(3, { text: "/skip" });
  await Promise.all([update(3, photo("after-1")), update(3, photo("after-2"))]);
  assert.equal(opens, 1);
  assert.deepEqual(fileIds(), ["after-1", "after-2", "before-email"]);
  assert.equal(tickets.get(3)!.intake_step, null);
});

test("an old pending ticket still forwards its persisted first photo", async () => {
  reset();
  tickets.set(4, fixture(4, { first_photo_file_id: "legacy-photo" }));
  await update(4, { text: "/skip" });
  assert.deepEqual(fileIds(), ["legacy-photo"]);
});

test("failed handling releases the chat queue for subsequent updates", async () => {
  reset();
  failLookup = true;
  await assert.rejects(update(5, photo("failed")), /temporary lookup failure/);
  await update(5, photo("retry"));
  await update(5, { text: "/skip" });
  assert.deepEqual(fileIds(), ["retry"]);
});
