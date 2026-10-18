import assert from "node:assert/strict";
import test from "node:test";
import { assertScratchDb, freshCrmDb } from "./helpers/crm_pg.js";

const url = process.env.CRM_TEST_DATABASE_URL;

test("CSAT channels: Telegram buttons and comment reply, web API, retry keeps the buttons", { skip: !url }, async (t) => {
  assertScratchDb(url!);
  Object.assign(process.env, {
    SUPPORT_SURFACE: "crm",
    LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
    DATABASE_URL: url!, PUBLIC_BASE_URL: "https://ops.example",
    LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
  });
  for (const k of ["BITRIX_CLIENT_ID", "BITRIX_CLIENT_SECRET", "TURKARTA_API_URL"]) delete process.env[k];
  const sql = await freshCrmDb(url!);
  const db = await import("../dist/db.js");
  const csat = await import("../dist/crm/csat.js");
  const reply = await import("../dist/crm/reply.js");
  const { DEFAULT_PREFS } = await import("../dist/crm/types.js");
  const { supportBot } = await import("../dist/bots/support.js");
  const { app } = await import("../dist/server.js");
  type Operator = import("../dist/crm/types.js").Operator;
  const anna: Operator = {
    id: 7, name: "Anna", email: null, role: "support", is_lead: false, auto_assign_enabled: true, on_shift: true,
    last_active_at: null, last_assigned_at: null, prefs: DEFAULT_PREFS,
  };

  const calls: Array<{ method: string; payload: Record<string, unknown>; messageId?: number }> = [];
  let nextMessageId = 1000;
  // Methods listed here answer like Telegram does for a stale query or a blocked bot.
  const failing = new Set<string>();
  supportBot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    if (method === "getMe") return { ok: true, result: {
      id: 456, is_bot: true, first_name: "Test", username: "test_support_bot",
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    } } as never;
    const call: (typeof calls)[number] = { method, payload: p };
    calls.push(call);
    if (failing.has(method)) return { ok: false, error_code: 400, description: "Bad Request: query is too old" } as never;
    if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
    call.messageId = ++nextMessageId;
    return { ok: true, result: { message_id: call.messageId, date: 1, chat: { id: p.chat_id, type: "private" }, text: p.text } } as never;
  });
  await supportBot.init();

  let seq = 0;
  const dm = (user: number, text: string, replyTo?: number) => supportBot.handleUpdate({ update_id: ++seq, message: {
    message_id: seq, date: 1, text,
    chat: { id: user, type: "private", first_name: "Иван" },
    from: { id: user, is_bot: false, first_name: "Иван" },
    ...(replyTo != null ? { reply_to_message: {
      message_id: replyTo, date: 1, text: "Что пошло не так? Ответьте на это сообщение — это необязательно.",
      chat: { id: user, type: "private", first_name: "Иван" },
      from: { id: 456, is_bot: true, first_name: "Test" },
    } } : {}),
  } as never });
  const tap = (from: number, chat: number, data: string) => supportBot.handleUpdate({ update_id: ++seq, callback_query: {
    id: `cb${seq}`, chat_instance: "ci", data,
    from: { id: from, is_bot: false, first_name: "Иван" },
    message: { message_id: 50, chat: { id: chat, type: "private", first_name: "Иван" }, date: 1, text: "Мы смогли вам помочь?" },
  } as never });

  async function resolvedTicket(fields: Record<string, unknown>) {
    const row = { user_name: "Иван", source: "bot", first_message: "help", queued_at: sql`now()`,
      status: "resolved", resolved_at: sql`now() - interval '1 hour'`, assigned_operator_id: 7, ...fields };
    const [r] = await sql`insert into support_requests ${sql(row)} returning id`;
    return r!.id as string;
  }
  // resolved_at is copied in SQL so the survey matches its resolution exactly.
  async function survey(ticketId: string, channel: "telegram" | "web") {
    const [r] = await sql`insert into crm_csat (ticket_id, resolved_at, operator_id, channel)
      select id, resolved_at, assigned_operator_id, ${channel} from support_requests where id = ${ticketId} returning id`;
    return r!.id as string;
  }
  const csatRow = async (id: string) => (await sql`select * from crm_csat where id = ${id}`)[0]!;
  const headers = { "x-webhook-secret": "test-secret", "content-type": "application/json" };

  try {
    await sql`insert into crm_operators (id, name, role, on_shift) values (7, 'Anna', 'support', true)`;

    const userTg = 7301;
    const tgTicket = await resolvedTicket({ user_tg: userTg });
    const tgCsat = await survey(tgTicket, "telegram");
    let promptId = 0;

    await t.test("👎 tap: rating saved, thanks in place, comment prompt with force_reply", async () => {
      calls.length = 0;
      await tap(userTg, userTg, `csat:${tgCsat}:down`);
      const row = await csatRow(tgCsat);
      assert.equal(row.rating, "down");
      assert.ok(calls.some((c) => c.method === "answerCallbackQuery"));
      const edit = calls.find((c) => c.method === "editMessageText");
      assert.equal(edit?.payload.text, "Спасибо за оценку!");
      const ask = calls.find((c) => c.method === "sendMessage");
      assert.equal(ask?.payload.text, "Что пошло не так? Ответьте на это сообщение — это необязательно.");
      assert.equal(ask?.payload.chat_id, userTg);
      assert.equal((ask?.payload.reply_markup as { force_reply?: boolean }).force_reply, true);
      promptId = ask!.messageId!;
      assert.equal(Number(row.comment_prompt_tg_id), promptId);
    });

    await t.test("a reply to the comment prompt is the comment, not a new question", async () => {
      calls.length = 0;
      const before = await sql`select count(*)::int as n from support_messages where ticket_id = ${tgTicket} and sender = 'user'`;
      await dm(userTg, "долго ждал", promptId);
      assert.equal((await csatRow(tgCsat)).comment, "долго ждал");
      assert.deepEqual(calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text), ["Спасибо, передали команде."]);
      const tickets = await sql`select id, status from support_requests where user_tg = ${userTg}`;
      assert.deepEqual(tickets.map((r) => [r.id, r.status]), [[tgTicket, "resolved"]]);
      const after = await sql`select count(*)::int as n from support_messages where ticket_id = ${tgTicket} and sender = 'user'`;
      assert.equal(after[0]!.n, before[0]!.n);
    });

    await t.test("a plain DM after the comment follows the normal path and reopens", async () => {
      calls.length = 0;
      await dm(userTg, "ещё вопрос");
      const [tk] = await sql`select status from support_requests where id = ${tgTicket}`;
      assert.notEqual(tk!.status, "resolved");
      const events = await sql`select type from crm_ticket_events where ticket_id = ${tgTicket} and type = 'reopened'`;
      assert.equal(events.length, 1);
      assert.equal((await csatRow(tgCsat)).comment, "долго ждал");
      const userMsgs = await sql`select body from support_messages where ticket_id = ${tgTicket} and sender = 'user'`;
      assert.deepEqual(userMsgs.map((m) => m.body), ["ещё вопрос"]);
    });

    await t.test("stale taps: another user, and a tap after the reopen", async () => {
      const other = await resolvedTicket({ user_tg: 7302 });
      const otherCsat = await survey(other, "telegram");
      calls.length = 0;
      await tap(9999, 9999, `csat:${otherCsat}:down`);
      assert.deepEqual(calls.map((c) => [c.method, c.payload.text]), [["answerCallbackQuery", "Оценка уже не принимается."]]);
      assert.equal((await csatRow(otherCsat)).rating, null);

      calls.length = 0;
      await tap(userTg, userTg, `csat:${tgCsat}:up`);
      assert.deepEqual(calls.map((c) => [c.method, c.payload.text]), [["answerCallbackQuery", "Оценка уже не принимается."]]);
      assert.equal((await csatRow(tgCsat)).rating, "down");
    });

    await t.test("web: poll shows the survey; POST rates and comments; owner, secret, body, reopen checks", async () => {
      const webTicket = await resolvedTicket({ channel: "web", user_tg: null, web_user_id: "w-9" });
      const webCsat = await survey(webTicket, "web");
      const poll = async () => {
        const res = await app.request("/api/support/web/messages?web_user_id=w-9", { headers });
        assert.equal(res.status, 200);
        return (await res.json()).csat;
      };
      const post = (body: unknown, h: Record<string, string> = headers) =>
        app.request("/api/support/web/csat", { method: "POST", headers: h, body: JSON.stringify(body) });

      assert.deepEqual(await poll(), { id: webCsat, rating: null, comment_allowed: false });
      const rated = await post({ csat_id: webCsat, web_user_id: "w-9", rating: "down" });
      assert.equal(rated.status, 200);
      assert.deepEqual(await rated.json(), { ok: true });
      assert.deepEqual(await poll(), { id: webCsat, rating: "down", comment_allowed: true });

      const commented = await post({ csat_id: webCsat, web_user_id: "w-9", comment: "не помогли" });
      assert.equal(commented.status, 200);
      assert.deepEqual(await poll(), { id: webCsat, rating: "down", comment_allowed: false });
      assert.equal((await csatRow(webCsat)).comment, "не помогли");
      const again = await post({ csat_id: webCsat, web_user_id: "w-9", comment: "и ещё" });
      assert.equal(again.status, 422);
      assert.deepEqual(await again.json(), { error: "invalid" });
      assert.equal((await csatRow(webCsat)).comment, "не помогли");

      const foreign = await post({ csat_id: webCsat, web_user_id: "w-8", rating: "up" });
      assert.equal(foreign.status, 404);
      assert.deepEqual(await foreign.json(), { error: "not_found" });
      const noSecret = await post({ csat_id: webCsat, web_user_id: "w-9", rating: "up" }, { "content-type": "application/json" });
      assert.equal(noSecret.status, 403);
      const bad = await post({ csat_id: "x" });
      assert.equal(bad.status, 422);
      assert.deepEqual(await bad.json(), { error: "invalid" });
      assert.equal((await csatRow(webCsat)).rating, "down");

      await sql`update support_requests set status = 'new' where id = ${webTicket}`;
      const closed = await post({ csat_id: webCsat, web_user_id: "w-9", rating: "up" });
      assert.equal(closed.status, 409);
      assert.deepEqual(await closed.json(), { error: "closed" });
      assert.equal(await poll(), null);
    });

    await t.test("web: no ticket polls csat null; a comment without a down rating is 422", async () => {
      const none = await app.request("/api/support/web/messages?web_user_id=w-none", { headers });
      assert.equal((await none.json()).csat, null);
      const tk = await resolvedTicket({ channel: "web", user_tg: null, web_user_id: "w-10" });
      const id = await survey(tk, "web");
      const res = await app.request("/api/support/web/csat", { method: "POST", headers,
        body: JSON.stringify({ csat_id: id, web_user_id: "w-10", comment: "сразу коммент" }) });
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { error: "invalid" });
      assert.equal((await csatRow(id)).comment, null);
    });

    await t.test("a second reply to the comment prompt is not a comment: it follows the normal path", async () => {
      const user = 7311;
      const tk = await resolvedTicket({ user_tg: user });
      const id = await survey(tk, "telegram");
      calls.length = 0;
      await tap(user, user, `csat:${id}:down`);
      const prompt = calls.find((c) => c.method === "sendMessage")!.messageId!;
      await dm(user, "первый", prompt);
      calls.length = 0;
      await dm(user, "второй", prompt);
      assert.equal((await csatRow(id)).comment, "первый");
      assert.ok(!calls.some((c) => c.payload.text === "Спасибо, передали команде."));
      const [row] = await sql`select status from support_requests where id = ${tk}`;
      assert.notEqual(row!.status, "resolved");
      const userMsgs = await sql`select body from support_messages where ticket_id = ${tk} and sender = 'user'`;
      assert.deepEqual(userMsgs.map((m) => m.body), ["второй"]);
    });

    await t.test("a failing answerCallbackQuery does not fail the update; the comment prompt still goes out", async () => {
      const user = 7321;
      const id = await survey(await resolvedTicket({ user_tg: user }), "telegram");
      failing.add("answerCallbackQuery");
      try {
        calls.length = 0;
        await tap(user, user, `csat:${id}:down`);
        const row = await csatRow(id);
        assert.equal(row.rating, "down");
        const ask = calls.find((c) => c.method === "sendMessage");
        assert.equal(ask?.payload.text, "Что пошло не так? Ответьте на это сообщение — это необязательно.");
        assert.equal(Number(row.comment_prompt_tg_id), ask!.messageId);
        // A stale tap answers through the same failing call.
        await tap(9998, 9998, `csat:${id}:up`);
        assert.equal((await csatRow(id)).rating, "down");
      } finally {
        failing.clear();
      }
    });

    await t.test("a failing comment prompt or thanks send does not fail the update; the answers are saved", async () => {
      const user = 7331;
      const id = await survey(await resolvedTicket({ user_tg: user }), "telegram");
      failing.add("sendMessage");
      try {
        await tap(user, user, `csat:${id}:down`);
        const row = await csatRow(id);
        assert.equal(row.rating, "down");
        assert.equal(row.comment_prompt_tg_id, null);
        await csat.setCommentPrompt(id, 4321);
        await dm(user, "всё плохо", 4321);
        assert.equal((await csatRow(id)).comment, "всё плохо");
      } finally {
        failing.clear();
      }
    });

    await t.test("retrying a failed CSAT prompt resends the 👍/👎 buttons", async () => {
      const id = await resolvedTicket({ user_tg: 7303 });
      await sql`insert into support_messages (ticket_id, sender, body, actor_type, author_id, author_name, kind, created_at)
        values (${id}, 'agent', 'answer', 'human', 'crm:7', 'Anna', 'text', now() - interval '2 hours')`;
      const sends: Array<{ chat: number; text: string; extra: unknown }> = [];
      let fail = true;
      const tg = {
        async sendMessage(chat: number, text: string, extra?: unknown) {
          if (fail) throw Object.assign(new Error("down"), { error_code: 502, description: "Bad Gateway" });
          sends.push({ chat, text, extra });
          return { message_id: 77 };
        },
        async sendPhoto(): Promise<never> { throw new Error("unused"); },
        async sendMediaGroup(): Promise<never> { throw new Error("unused"); },
        async sendVideo(): Promise<never> { throw new Error("unused"); },
      };
      const ticket = (await db.getTicket(id))!;
      const csatId = await csat.askCsat(ticket, "Мы смогли вам помочь?", { tg });
      assert.ok(csatId);
      const row = await csatRow(csatId!);
      const [m] = await sql`select delivery_status from support_messages where id = ${row.prompt_message_id}`;
      assert.equal(m!.delivery_status, "failed");

      fail = false;
      const retried = await reply.retryDelivery(row.prompt_message_id as string, anna, { tg });
      assert.equal(retried.delivery_status, "sent");
      assert.deepEqual(sends, [{
        chat: 7303, text: "Мы смогли вам помочь?",
        extra: { reply_markup: { inline_keyboard: [[
          { text: "👍 Да", callback_data: `csat:${csatId}:up` },
          { text: "👎 Нет", callback_data: `csat:${csatId}:down` },
        ]] } },
      }]);
    });

    await t.test("retrying an ordinary failed message sends no keyboard", async () => {
      const id = await resolvedTicket({ user_tg: 7304 });
      const [m] = await sql`insert into support_messages (ticket_id, sender, body, actor_type, author_id, kind, delivery_status)
        values (${id}, 'agent', 'Обращение закрыто', 'automation', 'crm:system', 'text', 'failed') returning id`;
      const sends: unknown[] = [];
      const tg = {
        async sendMessage(_chat: number, _text: string, extra?: unknown) { sends.push(extra); return { message_id: 78 }; },
        async sendPhoto(): Promise<never> { throw new Error("unused"); },
        async sendMediaGroup(): Promise<never> { throw new Error("unused"); },
        async sendVideo(): Promise<never> { throw new Error("unused"); },
      };
      await reply.retryDelivery(m!.id as string, anna, { tg });
      assert.deepEqual(sends, [undefined]);
    });
  } finally {
    await db.sql.end();
    await sql.end();
  }
});
