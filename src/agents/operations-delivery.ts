import type { InternalTask, Notification, OperationsOptions } from "./operations-contracts.js";
import type { OperationsStore } from "./operations-store.js";
import { redact } from "./policy.js";

export interface InternalMessage { html: string; buttons?: Array<{ text: string; data: string }>; }
export interface InternalTransport { send(chatId: number, message: InternalMessage): Promise<number>; }
export class DeliveryError extends Error {
  constructor(public outcome: "unknown" | "failed" | "rate_limited", public retryAfter = 0) { super(outcome); }
}
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const person = (id: string | number) => `<a href="tg://user?id=${Number(id)}">Ответственный</a>`;
const labels: Record<string, string> = { support: "Поддержка", payments: "Платежи", cards: "Карты", kyc: "KYC",
  engineering: "Техническая проверка", security: "Безопасность", support_lead: "Руководитель поддержки" };

export function renderTask(task: InternalTask, reminder: boolean): InternalMessage {
  const deadline = new Date(task.due_at).toISOString().replace("T", " ").slice(0,16) + " UTC";
  const buttons = task.status === "assigned" ? [{ text: "✋ Принять", data: `ai:accept:${task.id}` }] : [];
  buttons.push({ text: "Обновить", data: `ai:update:${task.id}` }, { text: "Завершить", data: `ai:done:${task.id}` });
  return {
    html: `${reminder ? "⏰ Нужна проверка срока" : "📋 Внутренняя задача"} · ${esc(labels[task.team] ?? "Поддержка")}\n` +
      `Обращение: <code>${task.ticket_id}</code>\nЗадача: <code>${task.id}</code>\n\n` +
      `${esc(redact(task.summary_ru).slice(0,900))}\n\n` +
      `${person(task.owner_tg)}${reminder ? ` · резерв: ${person(task.backup_tg)}` : ""}\n` +
      `Срок ${task.status === "assigned" ? "принятия" : "следующей проверки"}: ${deadline}\n` +
      (task.money_related ? "Денежные действия — только вручную оператором. Агент ничего не переводил и не повторял.\n" : "") +
      "Это внутреннее обсуждение. Сообщения из этой группы клиенту не отправляются.",
    buttons,
  };
}

export function renderDigest(report: Record<string, unknown>): InternalMessage {
  const number = (key: string) => Number(report[key] ?? 0) || 0;
  return { html: `<b>Качество поддержки · ${esc(String(report.day_utc))} UTC</b>\n\n` +
    `Проверено диалогов: ${number("reviewed_conversations")}\n` +
    `Кандидаты на критичные замечания: ${number("critical_candidates")}\n` +
    `Ожидают проверки руководителя: ${number("awaiting_lead_review")}\n` +
    `Есть более новые сообщения без оценки: ${number("stale_reviews")}\n` +
    `Отклонено оценок: ${number("rejected_reviews")}\nНеизвестное авторство: ${number("unknown_authorship")}\n\n` +
    `Не приняты внутренние задачи: ${number("unaccepted_tasks")}\nТребуют внимания: ${number("attention_tasks")}\n` +
    `Проблемы доставки: ${number("delivery_issues")}\nОшибки анализа за день: ${number("analysis_failures")}\n` +
    `Оценка затрат модели: $${number("estimated_usd").toFixed(4)}\n\n` +
    "Замечания ИИ требуют проверки. Статусы задач — на момент составления сводки; это не рейтинг сотрудников." };
}

type DeliveryStore = Pick<OperationsStore, "claimNotification" | "task" | "notificationFailed" | "notificationSent">;
export async function deliverOne(store: DeliveryStore, transport: InternalTransport, options: OperationsOptions) {
  const notification = await store.claimNotification();
  if (!notification) return false;
  const expected = notification.kind === "task" || notification.kind === "reminder" ? options.chatId : options.qaChatId;
  if (!expected || Number(notification.chat_id) !== expected) {
    await store.notificationFailed(notification, "cancelled", "destination_changed"); return true;
  }
  let message: InternalMessage;
  if (notification.task_id) {
    const task = await store.task(notification.task_id);
    if (!task || ["resolved", "cancelled"].includes(task.status)
      || Number(notification.payload.revision) !== task.revision
      || (notification.kind === "reminder" && Number(notification.payload.reminder_count) !== task.reminder_count)) {
      await store.notificationFailed(notification, "cancelled", "task_changed"); return true;
    }
    message = renderTask(task, notification.kind === "reminder");
  } else if (notification.kind === "digest") message = renderDigest(notification.payload);
  else message = { html: "🔎 <b>Нужна проверка руководителя</b>\n" +
    `Обращение: <code>${esc(String(notification.payload.ticket_id))}</code>\n` +
    `Отчёт: <code>${esc(String(notification.payload.job_id))}</code>\n\n` +
    `${esc(redact(String(notification.payload.summary_ru)).slice(0,900))}\n\n` +
    "Это предварительное замечание ИИ. Проверьте доказательства в отчёте перед выводами об операторе." };
  try {
    const messageId = await transport.send(expected, message);
    await store.notificationSent(notification, messageId);
  } catch (error) {
    if (error instanceof DeliveryError && error.outcome === "rate_limited" && notification.attempts < 3) {
      await store.notificationFailed(notification, "pending", "telegram_rate_limited", Math.min(3600, Math.max(1, error.retryAfter)));
    } else {
      const status = error instanceof DeliveryError && error.outcome !== "unknown" ? "failed" : "unknown";
      await store.notificationFailed(notification, status, status === "unknown" ? "delivery_unknown" : "telegram_rejected");
    }
  }
  return true;
}

export function startOperationsWorker(store: OperationsStore, transport: InternalTransport, options?: OperationsOptions): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    active = (async () => {
      for (let i = 0; i < 10 && !stopped; i++) if (!await store.materialize(options!)) break;
      await store.scheduleReminders(options!);
      await store.scheduleDigest(options!);
      await deliverOne(store, transport, options!);
    })().catch(() => console.warn("[support-ai-operations] processing_failed"))
      .finally(() => { if (!stopped) timer = setTimeout(tick, 5000); });
  };
  if (options) timer = setTimeout(tick, 5000);
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
