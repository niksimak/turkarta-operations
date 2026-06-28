import { Bot, type Context } from "grammy";
import { config, memberFor, rosterIds } from "../config.js";
import * as cards from "../cards.js";
import { escapeHtml } from "../cards.js";
import * as db from "../db.js";
import type { Ticket, TicketCategory } from "../db.js";

export const supportBot = new Bot(config.SUPPORT_BOT_TOKEN);

const GREETING =
  "👋 Это поддержка Turkarta. Опишите вопрос одним сообщением — мы подключим оператора.\n\n" +
  "👋 Turkarta support. Describe your issue in one message and an operator will join.";

const ASK_EMAIL =
  "📧 Оставьте email для связи (или отправьте /skip).\n" +
  "📧 Leave an email so we can reach you (or send /skip).";

const QUEUED = "Принято! Подключаем оператора… / Got it — connecting an operator…";

// /start (incl. deep-link from the Mini App: t.me/turkarta_support_bot?start=miniapp)
supportBot.command("start", (ctx) => ctx.reply(GREETING));

// /id — bootstrap helper: prints the caller's tg id + this chat id (for ROSTER / *_CHAT_ID).
supportBot.command("id", (ctx) =>
  ctx.reply(
    `Your Telegram id: <code>${ctx.from?.id}</code>\nThis chat id: <code>${ctx.chat.id}</code>`,
    { parse_mode: "HTML" },
  ),
);

// ---- helpers -------------------------------------------------------------

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

/** Post a fresh ticket card to the support channel and record its message id. */
async function postTicketCard(ticket: Ticket): Promise<void> {
  const card = await supportBot.api.sendMessage(
    config.SUPPORT_CHAT_ID,
    cards.supportCard(ticket),
    {
      reply_markup: cards.supportClaimKb(ticket.id),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  );
  await db.setCard("support_requests", ticket.id, card.chat.id, card.message_id);
}

/**
 * Create (or dedupe) a ticket from the in-app webhook and post its card.
 * The app supplies structured fields, so there's no intake Q&A.
 */
export async function createAppTicket(input: {
  user_tg: number;
  user_username: string | null;
  user_name: string | null;
  email: string | null;
  device: string | null;
  request: string;
}): Promise<Ticket> {
  const ticket = await db.openTicket({
    user_tg: input.user_tg,
    user_username: input.user_username,
    user_name: input.user_name,
    source: "miniapp",
    request: input.request,
    email: input.email,
    device: input.device,
    intake_step: null,
  });
  // Only post a card if this is genuinely new (no card yet) — dedupes re-submits.
  if (!ticket.tg_message_id) await postTicketCard(ticket);
  return ticket;
}

/** Deliver something to a Telegram user; on failure, flag it in the ops thread. */
async function deliverToUser(
  ctx: Context,
  ticket: Ticket,
  send: () => Promise<unknown>,
): Promise<void> {
  try {
    await send();
  } catch {
    if (ticket.thread_id != null) {
      await ctx.api
        .sendMessage(
          config.SUPPORT_CHAT_ID,
          "⚠️ Не доставлено пользователю (возможно, не открыл бота). / Couldn't deliver — user may not have started the bot.",
          { message_thread_id: ticket.thread_id },
        )
        .catch(() => {});
    }
  }
}

/**
 * Channel-aware notice to the user. Telegram → bot DM; web → append to the
 * conversation log as a 'system' message the app will poll.
 */
async function notifyUser(ctx: Context, ticket: Ticket, text: string): Promise<void> {
  if (ticket.channel === "web") {
    await db.addMessage(ticket.id, "system", text);
    return;
  }
  if (ticket.user_tg == null) return;
  await deliverToUser(ctx, ticket, () => ctx.api.sendMessage(ticket.user_tg!, text));
}

// ---- web channel (called by the in-app webhook proxy) --------------------

/** Open (or dedupe) a web-channel ticket and post its card. */
export async function createWebTicket(input: {
  web_user_id: string;
  user_name: string | null;
  email: string | null;
  device: string | null;
  request: string;
}): Promise<Ticket> {
  const ticket = await db.openWebTicket({
    web_user_id: input.web_user_id,
    user_name: input.user_name,
    source: "web",
    request: input.request,
    email: input.email,
    device: input.device,
  });
  // New ticket (no card yet): post the ops card and seed the chat log with the request.
  if (!ticket.tg_message_id) {
    await db.addMessage(ticket.id, "user", input.request);
    await postTicketCard(ticket);
  }
  return ticket;
}

const WELCOME_REQUEST = "🆕 Новый пользователь — нужна помощь с онбордингом";
const WELCOME_MESSAGE =
  "Привет! 👋 Я из поддержки Turkarta — на связи, если что-то понадобится. " +
  "Помогу пройти онбординг и пополнить карту.";

/**
 * Proactive onboarding welcome: open a web ticket seeded with a greeting from
 * support, so a new signup sees an agent message and an operator gets a card.
 * Deduped — a user who already has an open ticket isn't re-welcomed.
 */
export async function createWelcomeTicket(input: {
  web_user_id: string;
  user_name: string | null;
  email: string | null;
  device: string | null;
}): Promise<Ticket> {
  const ticket = await db.openWebTicket({
    web_user_id: input.web_user_id,
    user_name: input.user_name,
    source: "web-onboarding",
    request: WELCOME_REQUEST,
    email: input.email,
    device: input.device,
  });
  if (!ticket.tg_message_id) {
    await db.addMessage(ticket.id, "agent", WELCOME_MESSAGE);
    await postTicketCard(ticket);
  }
  return ticket;
}

/** A web user sent a message: log it and relay into the ops thread if claimed. */
export async function pushWebUserMessage(ticket: Ticket, body: string): Promise<void> {
  await db.addMessage(ticket.id, "user", body);
  if (ticket.thread_id != null) {
    const who = ticket.user_name || "Web user";
    await supportBot.api
      .sendMessage(
        config.SUPPORT_CHAT_ID,
        `💬 <b>${escapeHtml(who)}:</b> ${escapeHtml(body)}`,
        { message_thread_id: ticket.thread_id, parse_mode: "HTML" },
      )
      .catch(() => {});
  }
}

/** Edit a card, swallowing Telegram's "message is not modified" noise. */
async function safeEditCard(ctx: Context, ticket: Ticket): Promise<void> {
  const byName = ticket.claimed_by ?? "—";
  await ctx
    .editMessageText(cards.supportClaimedCard(ticket, byName), {
      parse_mode: "HTML",
      reply_markup: cards.supportManageKb(ticket),
      link_preview_options: { is_disabled: true },
    })
    .catch(() => {});
}

function rosterGuardFailed(ctx: Context): boolean {
  const id = ctx.from?.id;
  return rosterIds.size > 0 && (id == null || !rosterIds.has(id));
}

// ---- operator: take ------------------------------------------------------

supportBot.callbackQuery(/^claim:support_requests:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const user = ctx.from;
  if (rosterGuardFailed(ctx)) {
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
  if (threadId != null) {
    await db.setThread(won.id, threadId);
    won.thread_id = threadId;
  }

  await safeEditCard(ctx, won);
  await ctx.answerCallbackQuery({ text: "Ticket is yours 👍" });

  await notifyUser(
    ctx,
    won,
    "✅ Оператор подключился. Пишите здесь — ответим в этом чате.\n✅ An operator has joined. Just write here.",
  );
});

// ---- operator: classify --------------------------------------------------

supportBot.callbackQuery(/^cat:([^:]+):(tech_issue|bug_report|feature_request)$/, async (ctx) => {
  if (rosterGuardFailed(ctx)) {
    return ctx.answerCallbackQuery({ text: "You're not on the ops roster.", show_alert: true });
  }
  const id = ctx.match![1]!;
  const category = ctx.match![2] as TicketCategory;
  const updated = await db.setCategory(id, category);
  if (!updated) {
    return ctx.answerCallbackQuery({ text: "Ticket is closed.", show_alert: true });
  }
  await safeEditCard(ctx, updated);
  await ctx.answerCallbackQuery({ text: `Tagged: ${category.replace("_", " ")}` });
});

// ---- operator: park as awaiting -----------------------------------------

supportBot.callbackQuery(/^await:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const updated = await db.awaitTicket(id, ctx.from.id);
  if (!updated) {
    return ctx.answerCallbackQuery({
      text: "Only the assigned agent can park this.",
      show_alert: true,
    });
  }
  await safeEditCard(ctx, updated);
  await ctx.answerCallbackQuery({ text: "Parked — awaiting resolution ⏳" });
});

// ---- operator: resolve ---------------------------------------------------

supportBot.callbackQuery(/^resolve:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const closed = await db.resolveTicket(id, ctx.from.id);
  if (!closed) {
    return ctx.answerCallbackQuery({
      text: "Only the assigned agent can resolve this.",
      show_alert: true,
    });
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "Resolved ✅" });
  await notifyUser(ctx, closed, "Обращение закрыто. Спасибо! / Ticket closed. Thank you!");

  // Tidy the support group: close the relay topic so it drops out of the active list.
  if (config.SUPPORT_FORUM && closed.thread_id != null) {
    await ctx.api.closeForumTopic(config.SUPPORT_CHAT_ID, closed.thread_id).catch(() => {});
  }
});

// ---- end-user DM: guided intake + relay ----------------------------------

supportBot.on("message", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  if (!isRelayable(ctx)) return;
  const user = ctx.from;
  const text = ctx.message.text?.trim();
  const ticket = await db.ticketByUser(user.id);

  // First contact → capture the request, then ask for an email.
  if (!ticket) {
    await db.openTicket({
      user_tg: user.id,
      user_username: user.username ?? null,
      user_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      source: "bot",
      request: contentLabel(ctx),
      intake_step: "email",
    });
    await ctx.reply(ASK_EMAIL);
    return;
  }

  // Mid-intake: this message is the email (or /skip).
  if (ticket.intake_step === "email") {
    const email = !text || text === "/skip" ? null : text;
    const finalized = await db.finishIntake(ticket.id, email);
    if (finalized) await postTicketCard(finalized);
    await ctx.reply(QUEUED);
    return;
  }

  // Intake done, not yet taken by an operator.
  if (ticket.status === "new") {
    await ctx.reply("Ваше обращение в очереди. / Your request is queued.");
    return;
  }

  // Taken (allocated/awaiting) → relay into the ops thread.
  if (ticket.thread_id != null) {
    if (ctx.message.text) {
      await ctx.api.sendMessage(
        config.SUPPORT_CHAT_ID,
        `💬 <b>${escapeHtml(user.first_name)}:</b> ${escapeHtml(ctx.message.text)}`,
        { message_thread_id: ticket.thread_id, parse_mode: "HTML" },
      );
    } else {
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

// ---- operator message inside a ticket thread → relay to the end user ------

supportBot.on("message", async (ctx, next) => {
  const msg = ctx.message;
  if (ctx.chat.id !== config.SUPPORT_CHAT_ID || msg.message_thread_id == null) return next();
  if (ctx.from?.is_bot) return;
  if (!isRelayable(ctx)) return;
  const ticket = await db.ticketByThread(msg.message_thread_id);
  if (!ticket) return;

  // Web channel: store the reply for the app to poll (media isn't relayable to web).
  if (ticket.channel === "web") {
    const body = msg.text ?? "[оператор отправил вложение — доступно только в Telegram]";
    await db.addMessage(ticket.id, "agent", body);
    return;
  }

  // Telegram channel: live relay (text + media) to the user's DM.
  if (ticket.user_tg == null) return;
  const userTg = ticket.user_tg;
  if (msg.text) {
    await deliverToUser(ctx, ticket, () =>
      ctx.api.sendMessage(userTg, `🛟 <b>Поддержка:</b> ${escapeHtml(msg.text!)}`, {
        parse_mode: "HTML",
      }),
    );
  } else {
    await deliverToUser(ctx, ticket, async () => {
      await ctx.api.sendMessage(userTg, "🛟 <b>Поддержка:</b>", { parse_mode: "HTML" });
      await ctx.api.copyMessage(userTg, ctx.chat.id, msg.message_id);
    });
  }
});
