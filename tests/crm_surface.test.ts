import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { OpenTicketInput, Ticket } from "../src/db.js";

// SUPPORT_SURFACE=crm: Bitrix and the TG forum go quiet. Real compiled bot and
// router; database, Bitrix and Telegram are replaced. Never load .env.
Object.assign(process.env, {
  SUPPORT_SURFACE: "crm",
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret",
  BITRIX_CONNECTOR_ID: "turkarta_support", BITRIX_LINE_ID: "5",
  ROSTER: "[]",
});
const SUPPORT_CHAT = -1002;

const tickets = new Map<string, Ticket>();
const dbCalls: string[] = [];
const bitrix: string[] = [];
const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
const recorded: Array<{ ticket: string; body: string }> = [];
const parts: Array<Record<string, unknown>> = [];
const published: Array<{ type: string; ticketId?: string }> = [];
let reopenable: Ticket | null = null;
// Simulates losing the one-open-ticket race: recording on this ticket fails with 23505
// after `raceWinner` has become the user's open ticket.
let raceOn: string | null = null;
let raceWinner: Ticket | null = null;
let reopenLookups: Array<{ who: unknown; days: number }> = [];

function fixture(fields: Partial<Ticket>): Ticket {
  return {
    id: "ticket-x", channel: "telegram", user_tg: null,
    web_user_id: null, user_username: null, user_name: "Test", segment: null, org_name: null,
    source: "bot", first_message: "help", first_photo_file_id: null,
    email: null, device: null, category: null, intake_step: null,
    status: "new", claimed_by: null, claimed_by_tg: null,
    tg_chat_id: null, tg_message_id: null, thread_id: null, payout_key: null, admin_url: null, ...fields,
  };
}
const openOf = (pred: (t: Ticket) => boolean) =>
  [...tickets.values()].find(t => t.status !== "resolved" && pred(t)) ?? null;
const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => {
  dbCalls.push(name);
  return fn(...a);
};

const sql = (strings: TemplateStringsArray) => {
  // getSettings reads crm_settings; empty rows = defaults (reopen_days 7).
  if (strings.join("?").includes("crm_settings")) return Promise.resolve([]);
  throw new Error("Unexpected database call in surface test");
};

mock.module("../dist/db.js", { namedExports: {
  sql,
  SEGMENTS: ["business_owner", "business_admin", "corporate_employee", "partner", "retail"],
  ticketByUser: track("ticketByUser", async (id: number) => openOf(t => t.user_tg === id)),
  ticketByWebUser: track("ticketByWebUser", async (id: string) => openOf(t => t.web_user_id === id)),
  resolvedTicketWithin: track("resolvedTicketWithin", async (who: unknown, days: number) => {
    reopenLookups.push({ who, days });
    return reopenable;
  }),
  openTicket: track("openTicket", async (input: OpenTicketInput) => {
    const existing = openOf(t => t.user_tg === input.user_tg);
    if (existing) return existing;
    const row = fixture({ id: `tg-${input.user_tg}`, user_tg: input.user_tg, first_message: input.request,
      intake_step: input.intake_step ?? null, first_photo_file_id: input.first_photo_file_id ?? null,
      source: input.source });
    tickets.set(row.id, row);
    return row;
  }),
  openWebTicket: track("openWebTicket", async (input: { web_user_id: string; request: string; source: string;
    user_name?: string | null; segment?: Ticket["segment"]; org_name?: string | null }) => {
    const existing = openOf(t => t.web_user_id === input.web_user_id);
    if (existing) return existing;
    const row = fixture({ id: `web-${input.web_user_id}`, channel: "web", web_user_id: input.web_user_id,
      first_message: input.request, source: input.source, user_name: input.user_name ?? null,
      segment: input.segment ?? null, org_name: input.org_name ?? null });
    tickets.set(row.id, row);
    return row;
  }),
  finishIntake: track("finishIntake", async (id: string, email: string | null) => {
    const row = tickets.get(id);
    if (!row || row.intake_step !== "email") return null;
    row.email = email;
    row.intake_step = null;
    return row;
  }),
  getTicket: track("getTicket", async (id: string) => tickets.get(id) ?? null),
  setCard: track("setCard", async () => {}),
  ticketByThread: track("ticketByThread", async (thread: number) =>
    openOf(t => t.thread_id === thread)),
  markAgentReplied: track("markAgentReplied", async () => {}),
  ticketByCardMessage: track("ticketByCardMessage", async () => null),
  claim: track("claim", async () => null),
  addMessage: track("addMessage", async () => ({ id: "stored-message" })),
  getBitrixTokens: async () => null,
} });
mock.module("../dist/crm/inbound.js", { namedExports: {
  classifyTelegram: (m: { text?: string; caption?: string; video?: { file_size?: number } }) =>
    (m.video?.file_size ?? 0) > 20 * 1024 * 1024
      ? { kind: "unsupported", body: m.caption ?? "", unsupportedType: "video_too_large" }
      : { kind: "text", body: m.text ?? m.caption ?? "" },
  recordUserMessage: async (ticket: Ticket, part: { body: string }) => {
    parts.push(part);
    if (raceOn === ticket.id) {
      raceOn = null;
      tickets.set(raceWinner!.id, raceWinner!);
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
    recorded.push({ ticket: ticket.id, body: part.body });
    return { messageId: "stored-message", appendedToAlbum: false, reopened: false, attachment: null };
  },
} });
mock.module("../dist/crm/events.js", { namedExports: {
  publish: async (event: { type: string; ticketId?: string }) => { published.push(event); },
  // The CRM router imports these; unused here.
  subscribe: () => () => {},
  presence: { set: () => {}, clear: () => {}, list: () => [] },
} });
mock.module("../dist/bitrix_openlines.js", { namedExports: {
  sendUserMessage: async () => { bitrix.push("sendUserMessage"); },
  ensureBootstrapped: async () => { bitrix.push("ensureBootstrapped"); },
  ticketIdFromChatId: () => { bitrix.push("ticketIdFromChatId"); return "ticket-x"; },
  chatIdForTicket: (id: string) => `tk-${id}`,
} });
mock.module("../dist/bitrix_app.js", { namedExports: {
  BitrixAppError: class extends Error {},
  enabled: () => true,
  saveInstall: async () => { bitrix.push("saveInstall"); },
  call: async (method: string) => { bitrix.push(`call:${method}`); return {}; },
} });

const payoutCalls: Array<{ fn: string; args: unknown[] }> = [];
mock.module("../dist/crm/payouts.js", { namedExports: {
  openPayoutTicket: async (...args: unknown[]) => {
    payoutCalls.push({ fn: "open", args });
    return { ticket: fixture({ id: "payout-1", channel: "payout" }), created: payoutCalls.length === 1 };
  },
  closePayoutTicket: async (...args: unknown[]) => { payoutCalls.push({ fn: "close", args }); return args[0] !== "partner:nope"; },
} });

const { supportBot } = await import("../dist/bots/support.js");
supportBot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload: payload as Record<string, unknown> });
  if (method === "getMe") return { ok: true, result: {
    id: 456, is_bot: true, first_name: "Test", username: "test_support_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  } };
  return { ok: true, result: { message_id: sent.length, date: 1,
    chat: { id: SUPPORT_CHAT, type: "supergroup" }, text: "test" } };
});
await supportBot.init();
const { app } = await import("../dist/server.js");
const { config } = await import("../dist/config.js");
const { setVideoStore } = await import("../dist/video_storage.js");

let sequence = 0;
function dm(user: number, content: object) {
  const id = ++sequence;
  return supportBot.handleUpdate({ update_id: id, message: {
    message_id: id, date: 1,
    chat: { id: user, type: "private", first_name: "Test" },
    from: { id: user, is_bot: false, first_name: "Test" }, ...content,
  } });
}
const photo = (id: string) => ({ photo: [{ file_id: id, file_unique_id: id, width: 9, height: 9 }] });
function reset() {
  tickets.clear(); dbCalls.length = 0; bitrix.length = 0; sent.length = 0; recorded.length = 0; parts.length = 0;
  published.length = 0; reopenable = null; reopenLookups = []; raceOn = null; raceWinner = null;
  config.SUPPORT_SURFACE = "crm";
}
const toGroup = () => sent.filter(m => m.payload.chat_id === SUPPORT_CHAT);
const toUser = (user: number) => sent.filter(m => m.payload.chat_id === user).map(m => String(m.payload.text));
const authed = { "x-webhook-secret": "test-secret", "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: authed, body: JSON.stringify(body) });

test("crm: DM intake keeps its replies, records every message, never touches Bitrix or the support group", async () => {
  reset();
  await dm(1, photo("p1"));
  await dm(1, { text: "me@example.com" });
  const ticket = tickets.get("tg-1")!;
  assert.equal(ticket.email, "me@example.com");
  // Taken in the CRM: a thread id left over from the forum era must not relay.
  Object.assign(ticket, { status: "allocated", thread_id: 77 });
  await dm(1, { text: "ещё вопрос" });
  await dm(1, photo("p2"));

  assert.deepEqual(toUser(1), ["📧 Оставьте email для связи (или отправьте /skip).", "Принято! Подключаем оператора…"]);
  assert.deepEqual(recorded.map(r => r.ticket), ["tg-1", "tg-1", "tg-1"]);
  assert.deepEqual(toGroup(), []);
  assert.equal(sent.filter(m => m.method === "copyMessage" || m.method === "sendPhoto").length, 0);
  assert.deepEqual(bitrix, []);
  assert.equal(dbCalls.includes("setCard"), false);
  // Only first contact looks for a reopenable ticket; later messages have an open one.
  assert.deepEqual(reopenLookups, [{ who: { userTg: 1 }, days: 7 }]);
});

test("crm: operator message in the support group passes through without relay", async () => {
  reset();
  await supportBot.handleUpdate({ update_id: ++sequence, message: {
    message_id: 900, date: 1, message_thread_id: 77,
    chat: { id: SUPPORT_CHAT, type: "supergroup", title: "Support", is_forum: true },
    from: { id: 5, is_bot: false, first_name: "Op" }, text: "ответ",
  } });
  assert.deepEqual(dbCalls, []);
  assert.deepEqual(sent, []);
});

test("crm: forum card buttons answer without claiming, closing or messaging", async () => {
  reset();
  tickets.set("ticket-x", fixture({ status: "allocated", user_tg: 9, thread_id: 77 }));
  for (const data of ["claim:support_requests:ticket-x", "resolve_do:ticket-x", "await:ticket-x", "cat:ticket-x:bug_report"]) {
    await supportBot.handleUpdate({ update_id: ++sequence, callback_query: {
      id: `cb-${sequence}`, chat_instance: "ci", data,
      // The version-controlled support operator, so the roster guard passes.
      from: { id: 1298059682, is_bot: false, first_name: "Op" },
      message: { message_id: 3, date: 1, chat: { id: SUPPORT_CHAT, type: "supergroup", title: "Support" }, text: "card" },
    } });
  }
  assert.deepEqual(sent.map(m => m.method), Array(4).fill("answerCallbackQuery"));
  assert.deepEqual(dbCalls, []);
  for (const m of sent) assert.equal(m.payload.text, "Поддержка переехала в CRM. Откройте обращение там.");
});

test("crm: no open ticket but a recently resolved one: the message goes there, no intake", async () => {
  reset();
  const prior = fixture({ id: "resolved-1", user_tg: 2, status: "resolved" });
  tickets.set(prior.id, prior);
  reopenable = prior;
  await dm(2, { text: "снова я" });
  assert.deepEqual(reopenLookups, [{ who: { userTg: 2 }, days: 7 }]);
  assert.deepEqual(recorded, [{ ticket: "resolved-1", body: "снова я" }]);
  assert.equal(dbCalls.includes("openTicket"), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(published, []);
  assert.deepEqual(bitrix, []);
});

test("crm: no reopenable ticket opens a new one with the usual intake", async () => {
  reset();
  await dm(3, { text: "помогите" });
  assert.deepEqual(reopenLookups, [{ who: { userTg: 3 }, days: 7 }]);
  assert.ok(tickets.has("tg-3"));
  assert.deepEqual(toUser(3), ["📧 Оставьте email для связи (или отправьте /skip).",]);
  assert.deepEqual(published, [{ type: "ticket.created", ticketId: "tg-3" }]);
});

test("crm: Bitrix connector events are ignored and logged; install skips the bootstrap", async () => {
  reset();
  const logs: string[] = [];
  const log = mock.method(console, "log", (...a: unknown[]) => { logs.push(a.join(" ")); });
  try {
    const event = new URLSearchParams({
      event: "ONIMCONNECTORMESSAGEADD",
      "data[CONNECTOR]": "turkarta_support", "data[LINE]": "5",
      "data[MESSAGES][0][im][chat_id]": "99", "data[MESSAGES][0][im][message_id]": "101",
      "data[MESSAGES][0][chat][id]": "tk-ticket-x", "data[MESSAGES][0][message][text]": "Test reply",
    });
    const res = await app.request("/bitrix/app/handler", { method: "POST", body: event });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: "surface=crm" });
    assert.ok(logs.includes("[bitrix-ol] ignored surface=crm"));

    const install = new URLSearchParams({
      event: "ONAPPINSTALL", "auth[access_token]": "a", "auth[refresh_token]": "r",
      "auth[member_id]": "m", "auth[domain]": "b24.example",
    });
    assert.equal((await app.request("/bitrix/app/handler", { method: "POST", body: install })).status, 200);
  } finally {
    log.mock.restore();
  }
  assert.deepEqual(bitrix, ["saveInstall"]);
  assert.deepEqual(sent, []);
});

test("crm: web and Mini App tickets get no card and no Bitrix mirror", async () => {
  reset();
  assert.equal((await post("/api/support/web/open", { web_user_id: "u1", request: "не работает" })).status, 200);
  // Re-submit of the same open ticket is not a second new ticket.
  assert.equal((await post("/api/support/web/open", { web_user_id: "u1", request: "не работает" })).status, 200);
  tickets.get("web-u1")!.thread_id = 77;
  assert.equal((await post("/api/support/web/message", { web_user_id: "u1", body: "ау" })).status, 200);
  assert.equal((await post("/webhooks/support", { tg: 4, request: "из мини-аппа" })).status, 200);
  assert.equal((await post("/webhooks/support", { tg: 4, request: "из мини-аппа" })).status, 200);

  assert.deepEqual(recorded.map(r => r.ticket), ["web-u1", "web-u1", "tg-4", "tg-4"]);
  assert.deepEqual(published, [
    { type: "ticket.created", ticketId: "web-u1" },
    { type: "ticket.created", ticketId: "tg-4" },
  ]);
  assert.deepEqual(toGroup(), []);
  assert.deepEqual(bitrix, []);
  assert.equal(dbCalls.includes("setCard"), false);
});

test("crm: web open passes segment, org_name and name to the new ticket", async () => {
  reset();
  const res = await post("/api/support/web/open", {
    web_user_id: "biz:cu1", request: "x", name: "Ольга", segment: "business_owner", org_name: "Travelata",
  });
  assert.equal(res.status, 200);
  const t = tickets.get("web-biz:cu1")!;
  assert.equal(t.segment, "business_owner");
  assert.equal(t.org_name, "Travelata");
  assert.equal(t.user_name, "Ольга");
});

test("crm: an unknown segment opens the ticket with no mark", async () => {
  reset();
  const res = await post("/api/support/web/open", {
    web_user_id: "u7", request: "x", segment: "vip", org_name: "o".repeat(300),
  });
  assert.equal(res.status, 200);
  const t = tickets.get("web-u7")!;
  assert.equal(t.segment, null);
  assert.equal(t.org_name, "o".repeat(128));
});

test("crm: photo-first and welcome carry the mark", async () => {
  reset();
  const form = new FormData();
  form.set("web_user_id", "p1");
  form.set("segment", "partner");
  form.set("org_name", "Агентство");
  form.set("name", "Пётр");
  form.set("email", "a@b.c");
  form.set("photo", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
  const res = await app.request("/api/support/web/photo", {
    method: "POST", headers: { "x-webhook-secret": "test-secret" }, body: form,
  });
  assert.equal(res.status, 200);
  const t = tickets.get("web-p1")!;
  assert.equal(t.segment, "partner");
  assert.equal(t.org_name, "Агентство");
  assert.equal(t.user_name, "Пётр");

  assert.equal((await post("/api/support/web/welcome", { web_user_id: "w8", segment: "retail" })).status, 200);
  assert.equal(tickets.get("web-w8")!.segment, "retail");
});

test("crm: web user with no open ticket writes into a recently resolved one", async () => {
  reset();
  const prior = fixture({ id: "resolved-web", channel: "web", web_user_id: "u2", status: "resolved" });
  tickets.set(prior.id, prior);
  reopenable = prior;
  const res = await post("/api/support/web/message", { web_user_id: "u2", body: "опять" });
  assert.equal(res.status, 200);
  const open = await post("/api/support/web/open", { web_user_id: "u2", request: "и ещё" });
  assert.equal((await open.json()).ticketId, "resolved-web");
  assert.deepEqual(recorded, [{ ticket: "resolved-web", body: "опять" }, { ticket: "resolved-web", body: "и ещё" }]);
  assert.equal(dbCalls.includes("openWebTicket"), false);
  assert.deepEqual(reopenLookups.map(l => l.who), [{ webUserId: "u2" }, { webUserId: "u2" }]);
  assert.deepEqual(published, []);
  assert.deepEqual(toGroup(), []);
  assert.deepEqual(bitrix, []);
});

test("bitrix (same process, switched back): cards, photo copy and Bitrix mirror resume", async () => {
  reset();
  config.SUPPORT_SURFACE = "bitrix";
  try {
    await dm(6, photo("p6"));
    await dm(6, { text: "/skip" });
    await new Promise(r => setImmediate(r));
    assert.equal(toGroup().filter(m => m.method === "sendMessage").length, 1); // ticket card
    assert.equal(toGroup().filter(m => m.method === "sendPhoto").length, 1);
    assert.ok(bitrix.includes("sendUserMessage"));
    assert.deepEqual(reopenLookups, []);
    assert.equal(dbCalls.includes("resolvedTicketWithin"), false);
  } finally {
    config.SUPPORT_SURFACE = "crm";
  }
});

test("bitrix: an operator reply in the forum topic is relayed and stops the CRM clock", async () => {
  reset();
  config.SUPPORT_SURFACE = "bitrix";
  try {
    tickets.set("topic-8", fixture({ id: "topic-8", user_tg: 8, status: "allocated", thread_id: 77 }));
    await supportBot.handleUpdate({ update_id: ++sequence, message: {
      message_id: sequence, date: 1, message_thread_id: 77, is_topic_message: true,
      chat: { id: SUPPORT_CHAT, type: "supergroup", title: "Support", is_forum: true },
      from: { id: 900, is_bot: false, first_name: "Oleg" }, text: "Проверяю",
    } });
    const relay = dbCalls.filter(c => c === "addMessage" || c === "markAgentReplied");
    assert.deepEqual(relay, ["addMessage", "markAgentReplied"]);
    assert.equal(toUser(8).length, 1);
  } finally {
    config.SUPPORT_SURFACE = "crm";
  }
});

test("crm: welcome is not injected into an open ticket; a fresh welcome ticket is published", async () => {
  reset();
  tickets.set("web-u5", fixture({ id: "web-u5", channel: "web", web_user_id: "u5", status: "allocated" }));
  assert.equal((await post("/api/support/web/welcome", { web_user_id: "u5" })).status, 200);
  assert.equal(dbCalls.includes("addMessage"), false);
  assert.deepEqual(published, []);

  assert.equal((await post("/api/support/web/welcome", { web_user_id: "u6" })).status, 200);
  assert.equal(dbCalls.filter(c => c === "addMessage").length, 1);
  assert.deepEqual(published, [{ type: "ticket.created", ticketId: "web-u6" }]);
  assert.deepEqual(toGroup(), []);
});

test("crm: losing the one-open race on reopen keeps the message on the winning ticket", async () => {
  reset();
  const prior = fixture({ id: "resolved-7", user_tg: 7, status: "resolved" });
  tickets.set(prior.id, prior);
  reopenable = prior;
  raceOn = prior.id;
  raceWinner = fixture({ id: "open-7", user_tg: 7, status: "new" });
  await dm(7, { text: "я тут" });
  assert.deepEqual(recorded, [{ ticket: "open-7", body: "я тут" }]);

  const webPrior = fixture({ id: "resolved-w7", channel: "web", web_user_id: "w7", status: "resolved" });
  tickets.set(webPrior.id, webPrior);
  reopenable = webPrior;
  raceOn = webPrior.id;
  raceWinner = fixture({ id: "open-w7", channel: "web", web_user_id: "w7", status: "new" });
  assert.equal((await post("/api/support/web/message", { web_user_id: "w7", body: "и я" })).status, 200);
  assert.deepEqual(recorded.at(-1), { ticket: "open-w7", body: "и я" });
});

test("payout endpoints: secret required, http(s) panel links only, open and close pass through", async () => {
  payoutCalls.length = 0;
  const payout = {
    payout_key: "referral:p1", title: "Реферальная выплата 5 000 ₽", body: "Способ: на карту", who: "Иван",
    admin_url: "https://api.turkarta.me/admin/referrals",
  };
  const noSecret = await app.request("/api/support/payout/open", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payout),
  });
  assert.equal(noSecret.status, 403);
  for (const admin_url of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
    assert.equal((await post("/api/support/payout/open", { ...payout, admin_url })).status, 422, admin_url);
  }
  assert.equal(payoutCalls.length, 0);

  const opened = await post("/api/support/payout/open", payout);
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true, ticketId: "payout-1", created: true });

  assert.equal((await post("/api/support/payout/close", { payout_key: "referral:p1", outcome: "lost" })).status, 422);
  assert.equal((await post("/api/support/payout/close", { payout_key: "referral:p1", outcome: "paid", note: "  СБП 1 " })).status, 200);
  assert.equal((await post("/api/support/payout/close", { payout_key: "partner:nope", outcome: "rejected" })).status, 404);
  assert.deepEqual(payoutCalls.slice(1).map((c) => c.args), [["referral:p1", "paid", "СБП 1"], ["partner:nope", "rejected", null]]);
});


const BIG_VIDEO_REPLY = "Видео больше 20 МБ, оно до нас не дошло. Пришлите, пожалуйста, видео покороче или ссылку на него.";

test("crm: a Telegram video over 20 MB is recorded as a note and the client is asked for a shorter one", async () => {
  reset();
  tickets.set("tg-9", fixture({ id: "tg-9", user_tg: 9, status: "allocated" }));
  await dm(9, { video: { file_id: "v", file_unique_id: "v", width: 1, height: 1, duration: 90, file_size: 30 * 1024 * 1024 } });
  assert.deepEqual(toUser(9), [BIG_VIDEO_REPLY]);
  assert.equal(parts[0]!.unsupportedType, "video_too_large");
  await dm(9, { text: "вот ссылка" });
  assert.deepEqual(toUser(9), [BIG_VIDEO_REPLY], "only the oversized video gets the reply");
});

const ftypMp4 = () => new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
function videoForm(webUserId: string, file: File) {
  const form = new FormData();
  form.set("web_user_id", webUserId);
  form.set("email", "a@b.c");
  form.set("video", file);
  return app.request("/api/support/web/video", { method: "POST", headers: { "x-webhook-secret": "test-secret" }, body: form });
}

test("crm: web video upload needs the bucket, checks the bytes, stores the key", async () => {
  reset();
  const clip = new File([ftypMp4()], "Экран.mp4", { type: "video/mp4" });
  assert.equal((await videoForm("v1", clip)).status, 503, "no bucket configured yet");

  const put: Array<{ key: string; size: number; type: string }> = [];
  setVideoStore({
    async put(key, bytes, type) { put.push({ key, size: bytes.length, type }); },
    async get() { throw new Error("unused"); },
  });
  Object.assign(config, { BUCKET_NAME: "b", AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" });
  try {
    const fake = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], "x.mp4", { type: "video/mp4" });
    assert.equal((await videoForm("v1", fake)).status, 415);
    assert.equal(put.length, 0);

    const res = await videoForm("v1", clip);
    assert.equal(res.status, 200);
    assert.equal(put.length, 1);
    assert.match(put[0]!.key, /^support\/video\/[0-9a-f-]{36}\/video\.mp4$/);
    assert.deepEqual({ size: put[0]!.size, type: put[0]!.type }, { size: 16, type: "video/mp4" });
    assert.deepEqual(recorded, [{ ticket: "web-v1", body: "🎬 Видео" }]);
    const part = parts[0] as { kind: string; webVideo: { storageKey: string; sizeBytes: number } };
    assert.equal(part.kind, "video");
    assert.equal(part.webVideo.storageKey, put[0]!.key);
    assert.equal(part.webVideo.sizeBytes, 16);
  } finally {
    Object.assign(config, { BUCKET_NAME: undefined, AWS_ENDPOINT_URL_S3: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined });
  }
});

test("crm: web video over 20 MB is refused before anything is stored", async () => {
  reset();
  Object.assign(config, { BUCKET_NAME: "b", AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" });
  let stored = 0;
  setVideoStore({ async put() { stored++; }, async get() { throw new Error("unused"); } });
  try {
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(ftypMp4());
    const res = await videoForm("v2", new File([big], "big.mp4", { type: "video/mp4" }));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "video_too_large" });
    assert.equal(stored, 0);
    assert.deepEqual(recorded, []);
  } finally {
    Object.assign(config, { BUCKET_NAME: undefined, AWS_ENDPOINT_URL_S3: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined });
  }
});
