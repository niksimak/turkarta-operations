import { createHash } from "node:crypto";
import { Bot, type Context } from "grammy";
import { config, legacySurface, supportMemberFor, supportRosterIds } from "../config.js";
import * as cards from "../cards.js";
import { escapeHtml } from "../cards.js";
import * as db from "../db.js";
import type { Ticket, TicketCategory } from "../db.js";
import * as openlines from "../bitrix_openlines.js";
import * as turkartaApi from "../turkarta_api.js";
import { telegramPhotoUrl } from "../telegram_media.js";
import { operationsOptions, operationsStore } from "../agents/operations-runtime.js";
import { registerOperationsHandlers } from "../agents/operations-telegram.js";

import { supportPhotoUrl, type ValidPhoto } from "../support_media.js";
import { classifyTelegram, recordUserMessage, type InboundPart, type RecordedMessage } from "../crm/inbound.js";
import { publish } from "../crm/events.js";
import {
  commentCsat, csatByCommentPrompt, openSurveyForTg, rateCsat, setCommentPrompt, shortAnswer,
  CSAT_ASK_COMMENT, CSAT_CLOSED, CSAT_COMMENT_THANKS, CSAT_THANKS,
} from "../crm/csat.js";
import { getSettings } from "../crm/settings.js";
import { sequencePrivateMessages } from "../telegram_sequence.js";
import { greetCustomer } from "../topic-greeting-runtime.js";

export const supportBot = new Bot(config.SUPPORT_BOT_TOKEN);
supportBot.use(sequencePrivateMessages());
registerOperationsHandlers(supportBot, operationsStore, operationsOptions);

const GREETING =
  "👋 Это поддержка Turkarta. Опишите вопрос одним сообщением — мы подключим оператора.";

const ASK_EMAIL = "📧 Оставьте email для связи (или отправьте /skip).";

const QUEUED = "Принято! Подключаем оператора…";

const MOVED_TO_CRM = "Поддержка переехала в CRM. Откройте обращение там.";

async function acknowledgeTopic(ticketId: string, messageId: string) {
  await greetCustomer(ticketId, messageId, async (userId, text) => {
    // grammY's Node typings name the older abort-controller shim; native signals
    // implement the same runtime cancellation interface used by its HTTP client.
    const signal = AbortSignal.timeout(5000) as unknown as Parameters<typeof supportBot.api.sendMessage>[3];
    const sent = await supportBot.api.sendMessage(userId, text, {}, signal);
    return String(sent.message_id);
  });
}

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

function looksLikeEmail(text: string): boolean {
  return text.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** Telegram orders photo sizes from smallest to largest. */
function photoFileId(ctx: Context): string | null {
  return ctx.message?.photo?.at(-1)?.file_id ?? null;
}

function bitrixPhoto(fileId: string | null): Array<{ url: string; name: string }> {
  if (!fileId) return [];
  return [
    {
      url: telegramPhotoUrl(
        fileId,
        config.PUBLIC_BASE_URL,
        config.TELEGRAM_WEBHOOK_SECRET,
      ),
      name: "photo.jpg",
    },
  ];
}

/** Make a user's photo visible to Telegram operators before anyone claims it. */
async function sendPhotoToSupport(ticket: Ticket, fileId: string): Promise<void> {
  await supportBot.api
    .sendPhoto(config.SUPPORT_CHAT_ID, fileId, {
      caption: `📷 Фото к обращению ${ticket.id}`,
      ...(ticket.tg_message_id
        ? { reply_parameters: { message_id: ticket.tg_message_id } }
        : {}),
    })
    .catch((err: unknown) => {
      console.warn(
        `[support] photo copy ticket=${ticket.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    });
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
 * CRM mode only: a user with no open ticket who writes again within reopen_days
 * continues their last resolved ticket instead of starting a new intake.
 */
export async function reopenableTicket(
  who: { userTg: number } | { webUserId: string },
): Promise<Ticket | null> {
  if (legacySurface()) return null;
  const { reopen_days } = await getSettings();
  return reopen_days > 0 ? db.resolvedTicketWithin(who, reopen_days) : null;
}

/**
 * Record a message on a ticket that may reopen. If another open ticket won the
 * one-open-per-user index meanwhile (23505), the message goes to that ticket.
 */
async function recordReopening(
  ticket: Ticket,
  part: InboundPart,
  meta: { authorId: string; sourceId?: string },
): Promise<{ ticket: Ticket; message: RecordedMessage }> {
  try {
    return { ticket, message: await recordUserMessage(ticket, part, meta) };
  } catch (err) {
    if (ticket.status !== "resolved" || (err as { code?: string }).code !== "23505") throw err;
    const open = ticket.web_user_id != null
      ? await db.ticketByWebUser(ticket.web_user_id)
      : ticket.user_tg != null ? await db.ticketByUser(ticket.user_tg) : null;
    if (!open) throw err;
    return { ticket: open, message: await recordUserMessage(open, part, meta) };
  }
}

/** CRM mode: the open ticket that already has this message's owner, else a reopenable one. */
async function crmExistingTicket(
  who: { userTg: number } | { webUserId: string },
): Promise<{ open: Ticket | null; reopen: Ticket | null }> {
  const open = "userTg" in who ? await db.ticketByUser(who.userTg) : await db.ticketByWebUser(who.webUserId);
  return { open, reopen: open ? null : await reopenableTicket(who) };
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
  // Bitrix mode dedupes on the posted card; CRM mode has no card, so it looks first.
  let fresh: boolean | null = null;
  // The webhook carries no id of its own; on an existing ticket the text hash makes
  // a retry a duplicate, also when the first attempt reopened it.
  const digest = createHash("sha256").update(input.request).digest("hex").slice(0, 16);
  const existingSource = (id: string) => `miniapp:${id}:${digest}`;
  if (!legacySurface()) {
    const { open, reopen } = await crmExistingTicket({ userTg: input.user_tg });
    if (reopen) {
      const { ticket } = await recordReopening(reopen, { kind: "text", body: input.request }, {
        authorId: `tg:${input.user_tg}`, sourceId: existingSource(reopen.id),
      });
      return (await db.getTicket(ticket.id)) ?? ticket;
    }
    fresh = open === null;
  }
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
  const first = await recordUserMessage(ticket, { kind: "text", body: input.request }, {
    authorId: `tg:${input.user_tg}`,
    sourceId: fresh === false ? existingSource(ticket.id) : `miniapp-first:${ticket.id}`,
  });
  await acknowledgeTopic(ticket.id, first.messageId);
  if (fresh === true) {
    await publish({ type: "ticket.created", ticketId: ticket.id });
  } else if (fresh === null && !ticket.tg_message_id) {
    await publish({ type: "ticket.created", ticketId: ticket.id });
    await postTicketCard(ticket);
    // Mirror into Bitrix Открытые линии (channel-agnostic connector chat).
    await openlines.sendUserMessage(ticket, input.request, `tg-first-${ticket.id}`);
  }
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
          "⚠️ Не доставлено пользователю (возможно, не открыл бота).",
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
  photo?: ValidPhoto | null;
}): Promise<Ticket> {
  if (!legacySurface()) {
    const { open, reopen } = await crmExistingTicket({ webUserId: input.web_user_id });
    if (open) return open;
    if (reopen) {
      const ticket = await pushWebUserMessage(reopen, input.request, input.photo);
      return (await db.getTicket(ticket.id)) ?? ticket;
    }
  }
  const ticket = await db.openWebTicket({
    web_user_id: input.web_user_id,
    user_name: input.user_name,
    source: "web",
    request: input.request,
    email: input.email,
    device: input.device,
  });
  // New ticket (no card yet): post the ops card and seed the chat log with the request.
  // CRM mode reached here only without an open ticket, so this one is new.
  if (!legacySurface() || !ticket.tg_message_id) {
    const first = await recordUserMessage(ticket, webPart(input.request, input.photo), {
      authorId: `web:${input.web_user_id}`, sourceId: `web-first:${ticket.id}`,
    });
    await acknowledgeTopic(ticket.id, first.messageId);
    await publish({ type: "ticket.created", ticketId: ticket.id });
    if (legacySurface()) {
      await postTicketCard(ticket);
      // Mirror into Bitrix Открытые линии. Best-effort by contract — never
      // throws, so a Bitrix outage cannot fail the user's support request.
      await openlines.sendUserMessage(ticket, input.request, first.messageId, bitrixStoredPhoto(first.attachment));
    }
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
  // Bitrix mode dedupes on the posted card; CRM mode has none, so it looks first.
  if (!legacySurface()) {
    const open = await db.ticketByWebUser(input.web_user_id);
    if (open) return open;
  }
  const ticket = await db.openWebTicket({
    web_user_id: input.web_user_id,
    user_name: input.user_name,
    source: "web-onboarding",
    request: WELCOME_REQUEST,
    email: input.email,
    device: input.device,
  });
  if (!legacySurface() || !ticket.tg_message_id) {
    await db.addMessage(ticket.id, "agent", WELCOME_MESSAGE, undefined, {
      actor: "automation", sourceId: `welcome:${ticket.id}`,
    });
    if (legacySurface()) await postTicketCard(ticket);
    else await publish({ type: "ticket.created", ticketId: ticket.id });
  }
  return ticket;
}

function webPart(body: string, photo?: ValidPhoto | null): InboundPart {
  return photo ? { kind: "photo", body, webPhoto: photo } : { kind: "text", body };
}

function bitrixStoredPhoto(attachment: RecordedMessage["attachment"]): Array<{ url: string; name: string }> {
  if (!attachment) return [];
  return [
    {
      url: supportPhotoUrl(
        attachment.id,
        attachment.filename,
        config.PUBLIC_BASE_URL,
        config.TELEGRAM_WEBHOOK_SECRET,
      ),
      name: attachment.filename,
    },
  ];
}

/**
 * A web user sent a message: log it and relay into the ops thread if claimed.
 * Returns the ticket that took it (another open one if a reopen lost a race).
 */
export async function pushWebUserMessage(
  target: Ticket,
  body: string,
  photo?: ValidPhoto | null,
): Promise<Ticket> {
  const { ticket, message } = await recordReopening(target, webPart(body, photo), { authorId: `web:${target.web_user_id}` });
  await acknowledgeTopic(ticket.id, message.messageId);
  if (!legacySurface()) return ticket;
  const files = bitrixStoredPhoto(message.attachment);
  await openlines.sendUserMessage(ticket, body, message.messageId, files);
  if (ticket.thread_id != null) {
    const who = ticket.user_name || "Web user";
    if (files[0]) {
      await supportBot.api
        .sendPhoto(config.SUPPORT_CHAT_ID, files[0].url, {
          message_thread_id: ticket.thread_id,
          caption: `💬 ${who}: ${body}`.slice(0, 1024),
        })
        .catch(() => {});
    } else {
      await supportBot.api
        .sendMessage(
          config.SUPPORT_CHAT_ID,
          `💬 <b>${escapeHtml(who)}:</b> ${escapeHtml(body)}`,
          { message_thread_id: ticket.thread_id, parse_mode: "HTML" },
        )
        .catch(() => {});
    }
  }
  return ticket;
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
  return supportRosterIds.size > 0 && (id == null || !supportRosterIds.has(id));
}

// Forum cards posted before the CRM cutover stay clickable; in CRM mode they
// must not claim, close or relay, or the CRM would miss those changes.
supportBot.callbackQuery(/^(claim:support_requests|cat|await|resolve|resolve_cancel|resolve_do):/, (ctx, next) =>
  legacySurface() ? next() : ctx.answerCallbackQuery({ text: MOVED_TO_CRM, show_alert: true }),
);

// ---- operator: take ------------------------------------------------------

supportBot.callbackQuery(/^claim:support_requests:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const user = ctx.from;
  if (rosterGuardFailed(ctx)) {
    return ctx.answerCallbackQuery({ text: "Вас нет в списке операторов.", show_alert: true });
  }

  const member = supportMemberFor(user.id);
  const byName = member?.name ?? (user.first_name || user.username || String(user.id));

  const won = await db.claim<Ticket>("support_requests", id, byName, user.id);
  if (!won) {
    const existing = await db.getRow<Ticket>("support_requests", id);
    await ctx.answerCallbackQuery({
      text: `Уже взято: ${existing?.claimed_by ?? "кто-то"}.`,
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
    // Seed the fresh topic with the request so the operator has context AND an
    // unmistakable place to reply. Without this, a user who wrote before the
    // claim leaves the new topic empty, and operators reply in the wrong place
    // (so the message never reaches the user).
    if (won.first_message) {
      const who = won.user_username ? `@${won.user_username}` : (won.user_name ?? "Пользователь");
      await ctx.api
        .sendMessage(
          config.SUPPORT_CHAT_ID,
          `💬 <b>${escapeHtml(who)}:</b> ${escapeHtml(won.first_message)}\n\n` +
            "<i>Отвечайте в этой теме — сообщение уйдёт пользователю.</i>",
          { message_thread_id: threadId, parse_mode: "HTML" },
        )
        .catch(() => {});
    }
  }

  await safeEditCard(ctx, won);
  await ctx.answerCallbackQuery({ text: "Тикет ваш 👍" });

  await notifyUser(
    ctx,
    won,
    "✅ Оператор подключился. Пишите здесь — ответим в этом чате.",
  );
});

// ---- operator: classify --------------------------------------------------

supportBot.callbackQuery(/^cat:([^:]+):(tech_issue|bug_report|feature_request)$/, async (ctx) => {
  if (rosterGuardFailed(ctx)) {
    return ctx.answerCallbackQuery({ text: "Вас нет в списке операторов.", show_alert: true });
  }
  const id = ctx.match![1]!;
  const category = ctx.match![2] as TicketCategory;
  const updated = await db.setCategory(id, category);
  if (!updated) {
    return ctx.answerCallbackQuery({ text: "Тикет закрыт.", show_alert: true });
  }
  await safeEditCard(ctx, updated);
  await ctx.answerCallbackQuery({ text: "Категория сохранена" });
});

// ---- operator: park as awaiting -----------------------------------------

supportBot.callbackQuery(/^await:(.+)$/, async (ctx) => {
  if (rosterGuardFailed(ctx)) {
    return ctx.answerCallbackQuery({ text: "Вас нет в списке операторов.", show_alert: true });
  }
  const id = ctx.match![1]!;
  const updated = await db.awaitTicket(id);
  if (!updated) {
    return ctx.answerCallbackQuery({ text: "Тикет закрыт.", show_alert: true });
  }
  await safeEditCard(ctx, updated);
  await ctx.answerCallbackQuery({ text: "Отложено ⏳" });
});

// ---- operator: resolve (two-step confirm so a stray tap can't close) ------

// First tap on "Закрыть": don't close — swap in a confirm/cancel row. Any
// roster operator may; a non-operator's tap doesn't disturb the keyboard.
supportBot.callbackQuery(/^resolve:(.+)$/, async (ctx) => {
  if (rosterGuardFailed(ctx)) {
    return ctx.answerCallbackQuery({ text: "Вас нет в списке операторов.", show_alert: true });
  }
  const id = ctx.match![1]!;
  const ticket = await db.getTicket(id);
  if (!ticket || ticket.status === "resolved") {
    return ctx.answerCallbackQuery({ text: "Тикет уже закрыт." });
  }
  await ctx
    .editMessageReplyMarkup({ reply_markup: cards.supportConfirmResolveKb(id) })
    .catch(() => {});
  await ctx.answerCallbackQuery({ text: "Точно закрыть? Подтвердите ниже." });
});

// Cancel: restore the normal management keyboard.
supportBot.callbackQuery(/^resolve_cancel:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const ticket = await db.getTicket(id);
  if (ticket) {
    await ctx.editMessageReplyMarkup({ reply_markup: cards.supportManageKb(ticket) }).catch(() => {});
  }
  await ctx.answerCallbackQuery({ text: "Отменено" });
});

// Confirmed: actually close the ticket.
supportBot.callbackQuery(/^resolve_do:(.+)$/, async (ctx) => {
  if (rosterGuardFailed(ctx)) {
    return ctx.answerCallbackQuery({ text: "Вас нет в списке операторов.", show_alert: true });
  }
  const id = ctx.match![1]!;
  const closed = await db.resolveTicket(id);
  if (!closed) {
    return ctx.answerCallbackQuery({ text: "Тикет уже закрыт." });
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "Закрыто ✅" });
  await notifyUser(ctx, closed, "Обращение закрыто. Спасибо!");

  // Tidy the support group: close the relay topic so it drops out of the active list.
  if (config.SUPPORT_FORUM && closed.thread_id != null) {
    await ctx.api.closeForumTopic(config.SUPPORT_CHAT_ID, closed.thread_id).catch(() => {});
  }
});

// ---- customer: CSAT after a CRM resolve -----------------------------------

supportBot.callbackQuery(/^csat:([0-9a-f-]{36}):(up|down)$/, async (ctx) => {
  const [, id, rating] = ctx.match!;
  const res = await rateCsat(id!, { userTg: ctx.from.id }, rating as "up" | "down");
  // The rating is committed; a Telegram failure from here on must not fail the
  // update, or the redelivery would fail the same way and never ask for a comment.
  if (!res.ok) return void (await ctx.answerCallbackQuery({ text: CSAT_CLOSED }).catch(() => {}));
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(CSAT_THANKS).catch(() => {});
  if (res.askComment) await askForComment(ctx, id!);
});

/** The optional comment prompt after a 👎; the rating is already saved, so a failure is only logged. */
async function askForComment(ctx: Context, csatId: string): Promise<void> {
  try {
    const m = await ctx.reply(CSAT_ASK_COMMENT, { reply_markup: { force_reply: true } });
    await setCommentPrompt(csatId, m.message_id);
  } catch (err) {
    const e = err as { error_code?: number; code?: string };
    console.error(`[crm-csat] comment prompt failed csat=${csatId} code=${e.error_code ?? e.code ?? "error"}`);
  }
}

/**
 * A typed «да»/«нет» right after a resolve answers the open survey instead of
 * reopening the ticket. Returns true when it was taken as the rating.
 */
async function typedRating(ctx: Context, userTg: number, text: string): Promise<boolean> {
  const rating = shortAnswer(text);
  if (!rating) return false;
  const csatId = await openSurveyForTg(userTg);
  if (!csatId) return false;
  const res = await rateCsat(csatId, { userTg }, rating);
  if (!res.ok) return false;
  await ctx.reply(CSAT_THANKS).catch(() => {});
  if (res.askComment) await askForComment(ctx, csatId);
  return true;
}

// ---- end-user DM: guided intake + relay ----------------------------------

supportBot.on("message", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  if (!isRelayable(ctx)) return;
  const user = ctx.from;
  const text = ctx.message.text?.trim();

  // A reply to the CSAT comment prompt is feedback, not a new question.
  const replyTo = ctx.message.reply_to_message?.message_id;
  if (replyTo && text) {
    const csatId = await csatByCommentPrompt(user.id, replyTo);
    if (csatId && (await commentCsat(csatId, { userTg: user.id }, text)).ok) {
      await ctx.reply(CSAT_COMMENT_THANKS).catch(() => {});
      return;
    }
  }

  const ticket = await db.ticketByUser(user.id);
  const part: InboundPart = classifyTelegram(ctx.message) ?? { kind: "text", body: contentLabel(ctx) };
  const tgMeta = { authorId: `tg:${user.id}`, sourceId: `tg:${ctx.chat.id}:${ctx.message.message_id}` };

  // CRM mode: a short yes/no to the open survey is the rating, not a new question.
  if (!ticket && !legacySurface() && text && (await typedRating(ctx, user.id, text))) return;

  // CRM mode: writing again soon after a resolve continues that ticket silently.
  if (!ticket && !legacySurface()) {
    const prior = await reopenableTicket({ userTg: user.id });
    if (prior) {
      await recordReopening(prior, part, tgMeta);
      return;
    }
  }

  // First contact → capture the request, then ask for an email.
  if (!ticket) {
    const opened = await db.openTicket({
      user_tg: user.id,
      user_username: user.username ?? null,
      user_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      source: "bot",
      request: contentLabel(ctx),
      intake_step: "email",
      first_photo_file_id: photoFileId(ctx),
    });
    const first = await recordUserMessage(opened, part, tgMeta);
    await publish({ type: "ticket.created", ticketId: opened.id });
    await acknowledgeTopic(opened.id, first.messageId);
    await ctx.reply(ASK_EMAIL);
    return;
  }

  // CRM mode: an operator may already be talking to the user, so a reply that is
  // not an email ends intake and stays a message instead of being taken as one.
  if (ticket.intake_step === "email" && text && !legacySurface() && text !== "/skip" && !looksLikeEmail(text)) {
    await db.finishIntake(ticket.id, null);
    await recordUserMessage(ticket, part, tgMeta);
    return;
  }

  // Only an actual text message can answer the email prompt. Album items
  // arrive as separate photo updates (captions are not email answers): relay
  // them below without finishing intake or discarding the current photo.
  if (ticket.intake_step === "email" && text) {
    const email = text === "/skip" ? null : text;
    const finalized = await db.finishIntake(ticket.id, email);
    if (finalized && legacySurface()) {
      await postTicketCard(finalized);
      const refreshed = (await db.getTicket(finalized.id)) ?? finalized;
      if (finalized.first_photo_file_id) {
        await sendPhotoToSupport(refreshed, finalized.first_photo_file_id);
      }
      // Do not keep Telegram's webhook open while Bitrix downloads the file.
      // Telegram retries unacknowledged updates, which previously duplicated
      // both the photo and the queue message every 10 seconds.
      void openlines.sendUserMessage(
        finalized,
        finalized.first_message ?? "(без текста)",
        `tg-first-${finalized.id}`,
        bitrixPhoto(finalized.first_photo_file_id),
      );
    }
    await ctx.reply(QUEUED);
    return;
  }

  // Mirror every post-intake user message into Bitrix — including on a NEW
  // (unclaimed) ticket, whose messages previously reached no operator surface
  // at all. Photos received while awaiting email use this same path, with a
  // distinct Telegram message id and signed file URL for every album item.
  const fileId = photoFileId(ctx);
  await recordUserMessage(ticket, part, tgMeta);
  // CRM mode: the message is in the CRM; no Bitrix mirror, no forum relay.
  if (!legacySurface()) return;
  if (fileId) await sendPhotoToSupport(ticket, fileId);
  void openlines.sendUserMessage(
    ticket,
    contentLabel(ctx),
    `tg-${ctx.chat.id}-${ctx.message.message_id}`,
    bitrixPhoto(fileId),
  );

  // Intake done, not yet taken by an operator.
  if (ticket.status === "new") {
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
  if (ctx.chat.id !== config.SUPPORT_CHAT_ID || !legacySurface()) return next();
  if (ctx.from?.is_bot) return;
  if (!isRelayable(ctx)) return;
  // Locate the ticket two ways, so an operator reply lands either way:
  //  1) typed inside the ticket's relay topic, or
  //  2) sent as a reply to the ticket card (e.g. in the General area).
  let ticket =
    msg.message_thread_id != null ? await db.ticketByThread(msg.message_thread_id) : null;
  if (!ticket && msg.reply_to_message) {
    ticket = await db.ticketByCardMessage(msg.reply_to_message.message_id);
  }
  if (!ticket) return next();

  // Persist all operator channels for QA; Telegram identity comes from the
  // authenticated bot update, never from message text or a model suggestion.
  const body = msg.text ?? "[Оператор отправил вложение; содержимое не анализировалось]";
  const stored = await db.addMessage(ticket.id, "agent", body, undefined, {
    actor: "human", authorId: `tg:${ctx.from.id}`,
    sourceId: `tg:${ctx.chat.id}:${msg.message_id}`,
  });
  // Best-effort: a stale CRM timer must never block the relay to the customer.
  await db.markAgentReplied(ticket.id).catch((err: { code?: string }) => {
    console.error(`[support] mark replied failed ticket=${ticket.id} code=${err?.code ?? "error"}`);
  });

  // Web channel: store the reply for the app to poll (media isn't relayable to web).
  if (ticket.channel === "web") {
    // Bell + Web Push in the app; best-effort — never blocks the reply.
    if (ticket.web_user_id) {
      await turkartaApi.notifySupportReply({
        web_user_id: ticket.web_user_id,
        ticket_id: ticket.id,
        message_id: stored.id,
        preview: body,
      });
    }
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
