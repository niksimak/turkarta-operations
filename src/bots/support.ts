import { Bot } from "grammy";
import { config, memberFor, rosterIds } from "../config.js";
import * as cards from "../cards.js";
import { escapeHtml } from "../cards.js";
import * as db from "../db.js";
import type { Ticket } from "../db.js";

export const supportBot = new Bot(config.SUPPORT_BOT_TOKEN);

const GREETING =
  "👋 Это поддержка Turkarta. Опишите вопрос одним сообщением — мы подключим оператора.\n\n" +
  "👋 Turkarta support. Describe your issue in one message and an operator will join.";

// /start (incl. deep-link from the Mini App: t.me/turkarta_support?start=miniapp)
supportBot.command("start", (ctx) => ctx.reply(GREETING));

// Agent taps "Take" on a ticket card.
supportBot.callbackQuery(/^claim:support_requests:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const user = ctx.from;
  if (rosterIds.size > 0 && !rosterIds.has(user.id)) {
    return ctx.answerCallbackQuery({ text: "You're not on the ops roster.", show_alert: true });
  }

  const member = memberFor(user.id);
  const byName = member?.name ?? (user.first_name || user.username || String(user.id));

  const won = await db.claim<Ticket>("support_requests", id, byName, user.id);
  if (!won) {
    const existing = await db.getRow<Ticket>("support_requests", id);
    await ctx.answerCallbackQuery({
      text: `Already taken by ${existing?.claimed_by ?? "someone"}.`,
      show_alert: true,
    });
    return;
  }

  // Open a relay channel: a forum topic if possible, else the card's own thread.
  let threadId = ctx.callbackQuery.message?.message_thread_id;
  if (config.SUPPORT_FORUM) {
    try {
      const topic = await ctx.api.createForumTopic(
        config.SUPPORT_CHAT_ID,
        `#${won.id.slice(0, 8)} · ${won.user_name ?? won.user_tg}`,
      );
      threadId = topic.message_thread_id;
    } catch {
      /* fall back to in-place thread */
    }
  }
  if (threadId != null) await db.setThread(won.id, threadId);

  await ctx.editMessageText(cards.supportClaimedCard(won, byName), {
    parse_mode: "HTML",
    reply_markup: cards.supportKb(won.id, true),
    link_preview_options: { is_disabled: true },
  });
  await ctx.answerCallbackQuery({ text: "Ticket is yours 👍" });

  await ctx.api.sendMessage(
    won.user_tg,
    "✅ Оператор подключился. Пишите здесь — ответим в этом чате.\n✅ An operator has joined. Just write here.",
  );
});

// Agent taps "Resolve".
supportBot.callbackQuery(/^resolve:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const closed = await db.resolveTicket(id, ctx.from.id);
  if (!closed) {
    return ctx.answerCallbackQuery({
      text: "Only the assigned agent can resolve this.",
      show_alert: true,
    });
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  await ctx.answerCallbackQuery({ text: "Resolved ✅" });
  await ctx.api.sendMessage(closed.user_tg, "Обращение закрыто. Спасибо! / Ticket closed. Thank you!");
});

// End-user DM -> open a ticket or relay into its thread.
supportBot.on("message:text", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  const user = ctx.from;
  let ticket = await db.ticketByUser(user.id);

  if (!ticket) {
    ticket = await db.openTicket({
      user_tg: user.id,
      user_username: user.username ?? null,
      user_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      source: "bot",
      first_message: ctx.message.text,
    });
    const card = await ctx.api.sendMessage(config.SUPPORT_CHAT_ID, cards.supportCard(ticket), {
      reply_markup: cards.supportKb(ticket.id),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    await db.setCard("support_requests", ticket.id, card.chat.id, card.message_id);
    await ctx.reply("Принято! Подключаем оператора… / Got it — connecting an operator…");
    return;
  }

  if (ticket.status === "new") {
    await ctx.reply("Ваше обращение в очереди. / Your request is queued.");
    return;
  }

  if (ticket.thread_id != null) {
    await ctx.api.sendMessage(
      config.SUPPORT_CHAT_ID,
      `💬 <b>${escapeHtml(ctx.from.first_name)}:</b> ${escapeHtml(ctx.message.text)}`,
      { message_thread_id: ticket.thread_id, parse_mode: "HTML" },
    );
  }
});

// Agent message inside a ticket thread -> relay to the end user.
supportBot.on("message:text", async (ctx, next) => {
  const msg = ctx.message;
  if (ctx.chat.id !== config.SUPPORT_CHAT_ID || msg.message_thread_id == null) return next();
  if (ctx.from?.is_bot) return;
  const ticket = await db.ticketByThread(msg.message_thread_id);
  if (!ticket) return;
  await ctx.api.sendMessage(ticket.user_tg, `🛟 <b>Поддержка:</b> ${escapeHtml(msg.text)}`, {
    parse_mode: "HTML",
  });
});
