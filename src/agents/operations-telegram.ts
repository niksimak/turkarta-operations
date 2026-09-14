import { GrammyError, InlineKeyboard, type Api, type Bot } from "grammy";
import { z } from "zod";
import { DeliveryError, type InternalTransport } from "./operations-delivery.js";
import type { OperationsStore } from "./operations-store.js";
import type { OperationsOptions } from "./operations-contracts.js";

export function telegramTransport(api: Api): InternalTransport {
  return { async send(chatId, message) {
    const keyboard = new InlineKeyboard();
    for (const button of message.buttons ?? []) keyboard.text(button.text, button.data);
    try {
      const result = await api.sendMessage(chatId, message.html, {
        parse_mode: "HTML", link_preview_options: { is_disabled: true },
        reply_markup: message.buttons?.length ? keyboard : undefined,
      // grammY's older declaration uses abort-controller's structurally narrower
      // Event types; Node's native signal supports the runtime abort contract.
      }, AbortSignal.timeout(20000) as unknown as Parameters<Api["sendMessage"]>[3]);
      return result.message_id;
    } catch (error) {
      if (error instanceof GrammyError) {
        if (error.error_code === 429) throw new DeliveryError("rate_limited", error.parameters.retry_after ?? 30);
        if (error.error_code >= 400 && error.error_code < 500) throw new DeliveryError("failed");
      }
      throw new DeliveryError("unknown");
    }
  } };
}

/** Registered before relay handlers. Every operation is bound to a private team group and actor ID. */
export function registerOperationsHandlers(bot: Bot, store: OperationsStore, options?: OperationsOptions) {
  bot.command("ai_accept", async (ctx) => {
    if (!options || ctx.chat.id !== options.chatId || !ctx.from || !ctx.message) return;
    const id = z.string().uuid().safeParse(ctx.match.trim());
    if (!id.success) return ctx.reply("Формат: /ai_accept <ID задачи>");
    const result = await store.act(id.data, ctx.from.id, "accept", "",
      `tg:${ctx.chat.id}:${ctx.message.message_id}`, options.updateMinutes);
    return ctx.reply(result === "denied" ? "Задача уже принята, закрыта или назначена другому сотруднику."
      : "Задача принята. Срок следующей внутренней проверки сохранён.");
  });
  bot.callbackQuery(/^ai:(accept|update|done):(.+)$/, async (ctx) => {
    const id = z.string().uuid().safeParse(ctx.match[2]);
    const message = ctx.callbackQuery.message;
    if (!options || !id.success || message?.chat.id !== options.chatId
      || !await store.callbackBelongs(id.data, options.chatId, message.message_id)) {
      return ctx.answerCallbackQuery({ text: "Эта внутренняя задача недоступна.", show_alert: true });
    }
    const task = await store.task(id.data);
    if (!task || ![task.owner_tg, task.primary_tg, task.backup_tg].some((id) => Number(id) === ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Задача назначена другому сотруднику.", show_alert: true });
    }
    if (ctx.match[1] !== "accept") return ctx.answerCallbackQuery({
      text: `Напишите в этой группе: /ai_${ctx.match[1]} ${id.data} описание результата`, show_alert: true,
    });
    const result = await store.act(id.data, ctx.from.id, "accept", "", `callback:${ctx.callbackQuery.id}`, options.updateMinutes);
    return ctx.answerCallbackQuery({ text: result === "denied" ? "Задача уже принята или закрыта." : "Принято. Срок следующей проверки сохранён." });
  });

  for (const action of ["update", "wait", "done"] as const) {
    bot.command(`ai_${action}`, async (ctx) => {
      if (!options || ctx.chat.id !== options.chatId || !ctx.from || !ctx.message) return;
      const match = ctx.match.trim().match(/^(\S+)\s+([\s\S]+)$/);
      const id = z.string().uuid().safeParse(match?.[1]);
      const note = match?.[2]?.trim() ?? "";
      if (!id.success || note.length < 5 || note.length > 2000) {
        return ctx.reply(`Формат: /ai_${action} <ID задачи> <комментарий от 5 до 2000 символов>`);
      }
      const result = await store.act(id.data, ctx.from.id, action, note,
        `tg:${ctx.chat.id}:${ctx.message.message_id}`, options.updateMinutes);
      return ctx.reply(result === "denied" ? "Сначала примите задачу. Изменить её может только текущий ответственный."
        : action === "done" ? "Результат внутренней проверки сохранён. Клиентское обращение остаётся в обычном процессе поддержки."
          : "Комментарий сохранён. Срок следующей внутренней проверки обновлён.");
    });
  }
}
