import { Bot, type Context } from "grammy";
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

// /id — bootstrap helper: prints the caller's tg id + this chat id (for ROSTER / *_CHAT_ID).
supportBot.command("id", (ctx) =>
  ctx.reply(
    `Your Telegram id: <code>${ctx.from?.id}</code>\nThis chat id: <code>${ctx.chat.id}</code>`,
    { parse_mode: "HTML" },
  ),
);

/** A human-readable label for the content of a message we're about to relay. */
function contentLabel(ctx: Context): string {
  const m = ctx.message;
  if (!m) return "[вложение]";
  if (m.text) return m.text;
  if (m.caption) return m.caption;
  if (m.photo) return "📷 [фото]";
  if (m.document) return "📎 [файл]";
  if (m.voice) return "🎤 [голосовое]";
  if (m.video || m.video_note) return "🎬 [видео]";
  if (m.audio) return "🎵 [аудио]";
  if (m.sticker) return `${m.sticker.emoji ?? ""} [стикер]`;
  return "[вложение]";
}

/** True if the message carries content worth relaying (text or any media). */
function isRelayable(ctx: Context): boolean {
  const m = ctx.message;
  return Boolean(
    m &&
      (m.text ||
        m.photo ||
        m.document ||
        m.voice ||
        m.video ||
        m.video_note ||
        m.audio ||
        m.sticker),
  );
}

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

  // Tidy the support group: close the relay topic so it drops out of the active list.
  if (config.SUPPORT_FORUM && closed.thread_id != null) {
    try {
      await ctx.api.closeForumTopic(config.SUPPORT_CHAT_ID, closed.thread_id);
    } catch {
      /* topic may already be closed / not a forum — ignore */
    }
  }
});

// End-user DM -> open a ticket or relay (text + media) into its thread.
supportBot.on("message", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  if (!isRelayable(ctx)) return;
  const user = ctx.from;
  let ticket = await db.ticketByUser(user.id);

  if (!ticket) {
    ticket = await db.openTicket({
      user_tg: user.id,
      user_username: user.username ?? null,
      user_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      source: "bot",
      first_message: contentLabel(ctx),
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
    if (ctx.message.text) {
      await ctx.api.sendMessage(
        config.SUPPORT_CHAT_ID,
        `💬 <b>${escapeHtml(user.first_name)}:</b> ${escapeHtml(ctx.message.text)}`,
        { message_thread_id: ticket.thread_id, parse_mode: "HTML" },
      );
    } else {
      // Media: attribute, then copy the original so the agent sees the real attachment.
      await ctx.api.sendMessage(
        config.SUPPORT_CHAT_ID,
        `💬 <b>${escapeHtml(user.first_name)}:</b>`,
        { message_thread_id: ticket.thread_id, parse_mode: "HTML" },
      );
      await ctx.api.copyMessage(config.SUPPORT_CHAT_ID, ctx.chat.id, ctx.message.message_id, {
        message_thread_id: ticket.thread_id,
      });
    }
  }
});

// Agent message inside a ticket thread -> relay (text + media) to the end user.
supportBot.on("message", async (ctx, next) => {
  const msg = ctx.message;
  if (ctx.chat.id !== config.SUPPORT_CHAT_ID || msg.message_thread_id == null) return next();
  if (ctx.from?.is_bot) return;
  if (!isRelayable(ctx)) return;
  const ticket = await db.ticketByThread(msg.message_thread_id);
  if (!ticket) return;

  if (msg.text) {
    await ctx.api.sendMessage(ticket.user_tg, `🛟 <b>Поддержка:</b> ${escapeHtml(msg.text)}`, {
      parse_mode: "HTML",
    });
  } else {
    await ctx.api.sendMessage(ticket.user_tg, "🛟 <b>Поддержка:</b>", { parse_mode: "HTML" });
    await ctx.api.copyMessage(ticket.user_tg, ctx.chat.id, msg.message_id);
  }
});
