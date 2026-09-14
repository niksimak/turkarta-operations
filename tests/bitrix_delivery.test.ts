import assert from "node:assert/strict";
import { mock, test } from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example", ROSTER: "[]",
  LEADS_WEBHOOK_SECRET: "test", TELEGRAM_WEBHOOK_SECRET: "test",
  BITRIX_CONNECTOR_ID: "turkarta_support", BITRIX_LINE_ID: "5",
});

const messages = new Map<string, { id: string }>();
const receipts = new Map<string, any>();
const confirmations: any[] = [];
let sends = 0;
let sendFails = false;
let confirmationFails: "throw" | "reject" | false = false;
let pushFails = false;
let channel = "telegram";
const ticket = () => ({ id: "ticket-1", channel, user_tg: 42, web_user_id: channel === "web" ? "user-1" : null });

mock.module("../dist/db.js", { namedExports: {
  getTicket: async () => ticket(),
  addAgentMessageFromBitrix: async (_ticket: string, _text: string, id: string) => {
    if (messages.has(id)) return null;
    const row = { id: `external-${id}` };
    messages.set(id, row);
    return row;
  },
} });
mock.module("../dist/bitrix_delivery_store.js", { namedExports: {
  prepareReceipt: async (receipt: any) => receipts.set(receipt.bitrix_message_id, { ...receipt, attempts: 0 }),
  recordDelivery: async (id: string, externalId: string) => Object.assign(receipts.get(id), {
    external_message_id: externalId, delivered_at: new Date("2026-09-14T12:00:00Z"),
  }),
  claimReceipt: async () => {
    const receipt = [...receipts.values()].find(r => r.delivered_at && !r.confirmed && !r.leased);
    if (!receipt) return null;
    receipt.leased = true;
    receipt.attempts++;
    return receipt;
  },
  confirmReceipt: async (id: string) => { receipts.get(id).confirmed = true; },
  retryReceipt: async (id: string) => { receipts.get(id).retry = true; },
} });
mock.module("../dist/bitrix_app.js", { namedExports: {
  BitrixAppError: class extends Error {},
  call: async (method: string, params: any) => {
    confirmations.push({ method, params });
    if (confirmationFails === "throw") throw new Error("timeout");
    return { SUCCESS: confirmationFails !== "reject" };
  },
} });
mock.module("../dist/turkarta_api.js", { namedExports: {
  notifySupportReply: async () => { if (pushFails) throw new Error("push unavailable"); },
} });

const { supportBot } = await import("../dist/bots/support.js");
supportBot.api.config.use(async (_prev, method) => {
  assert.equal(method, "sendMessage");
  sends++;
  if (sendFails) return { ok: false, error_code: 400, description: "Bad Request: chat not found" };
  return { ok: true, result: { message_id: 777, date: 1, chat: { id: 42, type: "private" } } };
});
const { app } = await import("../dist/server.js");
const { flushDeliveryConfirmations } = await import("../dist/bitrix_delivery.js");

function reset() {
  messages.clear(); receipts.clear(); confirmations.length = 0;
  sends = 0; sendFails = false; confirmationFails = false; pushFails = false; channel = "telegram";
}
async function post(id = "101", overrides: Record<string, string> = {}) {
  const body = new URLSearchParams({
    event: "ONIMCONNECTORMESSAGEADD",
    "data[CONNECTOR]": "turkarta_support", "data[LINE]": "5",
    "data[MESSAGES][0][im][chat_id]": "99", "data[MESSAGES][0][im][message_id]": id,
    "data[MESSAGES][0][chat][id]": "tk-ticket-1",
    "data[MESSAGES][0][message][text]": "Test reply", ...overrides,
  });
  const response = await app.request("/bitrix/app/handler", { method: "POST", body });
  await flushDeliveryConfirmations();
  return { status: response.status, body: await response.json() };
}

test("Telegram success confirms exact Bitrix IM IDs and the external message ID", async () => {
  reset();
  assert.deepEqual(await post(), { status: 200, body: { ok: true, delivered: 1, failed: 0, duplicates: 0 } });
  assert.equal(sends, 1);
  assert.deepEqual(confirmations, [{ method: "imconnector.send.status.delivery", params: {
    CONNECTOR: "turkarta_support", LINE: 5,
    MESSAGES: [{ im: { chat_id: "99", message_id: "101" },
      message: { id: ["777"], date: 1789387200 }, chat: { id: "tk-ticket-1" } }],
  } }]);
  assert.equal(receipts.get("ol-101").confirmed, true);
  assert.equal((await post()).body.duplicates, 1);
  assert.equal(sends, 1);
  assert.equal(confirmations.length, 1);
});

test("Telegram rejection is failed, never acknowledged or resent on duplicate", async () => {
  reset(); sendFails = true;
  assert.deepEqual((await post()).body, { ok: true, delivered: 0, failed: 1, duplicates: 0 });
  assert.equal(confirmations.length, 0);
  assert.equal(receipts.get("ol-101").delivered_at, undefined);
  sendFails = false;
  assert.equal((await post()).body.duplicates, 1);
  assert.equal(sends, 1);
  assert.equal(confirmations.length, 0);
});

for (const failure of ["throw", "reject"] as const) {
  test(`Bitrix ${failure} retries confirmation without another customer message`, async () => {
    reset(); confirmationFails = failure;
    assert.equal((await post()).body.delivered, 1);
    assert.equal(receipts.get("ol-101").retry, true);
    assert.equal(receipts.get("ol-101").confirmed, undefined);
    confirmationFails = false;
    receipts.get("ol-101").leased = false; // retry becomes due
    await Promise.all([flushDeliveryConfirmations(), flushDeliveryConfirmations()]);
    assert.equal(receipts.get("ol-101").confirmed, true);
    assert.equal(confirmations.length, 2);
    assert.equal(sends, 1);
  });
}

test("web inbox delivery is acknowledged even if optional push fails", async () => {
  reset(); channel = "web"; pushFails = true;
  assert.equal((await post()).body.delivered, 1);
  assert.equal(sends, 0);
  assert.deepEqual(confirmations[0].params.MESSAGES[0].message.id, ["external-ol-101"]);
});

test("legacy duplicate without proof is neither resent nor falsely confirmed", async () => {
  reset(); messages.set("ol-101", { id: "old-message" });
  assert.equal((await post()).body.duplicates, 1);
  assert.equal(sends, 0); assert.equal(confirmations.length, 0);
});

test("events for a different connector/line cannot deliver or confirm", async () => {
  reset();
  assert.equal((await post("101", { "data[LINE]": "6" })).status, 400);
  assert.equal((await post("101", { "data[CONNECTOR]": "other" })).status, 400);
  assert.equal(sends, 0); assert.equal(confirmations.length, 0);
});

test("missing internal chat ID is rejected before forwarding", async () => {
  reset();
  assert.equal((await post("101", { "data[MESSAGES][0][im][chat_id]": "" })).body.delivered, 0);
  assert.equal(sends, 0); assert.equal(confirmations.length, 0);
});
