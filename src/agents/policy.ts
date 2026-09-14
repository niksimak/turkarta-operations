import type { Classification, TranscriptMessage } from "./contracts.js";

export const MONEY_REPLY = "Вопрос по платежу должен проверить оператор. Пока не повторяйте оплату — сначала нужно выяснить результат предыдущей операции.";
export const FALLBACK_REPLY = "Здесь нужна проверка оператора: по имеющимся данным я не могу дать точный ответ.";
export const PLAYFUL_REPLY = "Хитро 😏 Но кухонный модуль мне не установили.";

// Supplementary recall-oriented signals, never the authorization boundary.
// This service exposes NO money tools and all results remain drafts.
const moneyPattern = /плат[её]ж|оплат|пополн|зачисл|списа[нл]|деньг|перевод|возврат|баланс|квитанц|чек\b|комисс|тариф|\b(?:csb|top[ -]?up|payment|paid|refund|transfer|balance|receipt|fee)\b/iu;
const servicePattern = /карт|kyc|верифик|поддерж|прилож|ошиб|не\s+работ|вход|\b(?:card|support|error|login)\b/iu;
export function policyFor(classification: Classification, messages: TranscriptMessage[]) {
  const text = messages.filter((m) => m.actor === "customer").map((m) => m.body).join("\n");
  const money = classification.money_related || classification.categories.includes("payment") || moneyPattern.test(text);
  const offTopic = classification.off_topic_only && !money && !servicePattern.test(text)
    && classification.categories.every((c) => c === "other");
  const teams = money ? ["payments"] : classification.categories.map((c) => ({
    general: "support", kyc: "kyc", card: "cards", payment: "payments", technical: "engineering",
    security: "security", complaint: "support_lead", other: "support",
  })[c]);
  // Financial + technical/security cases retain both owners.
  if (classification.categories.includes("technical") && money) teams.push("engineering");
  if (classification.categories.includes("security") && money) teams.push("security");
  return {
    money_related: money, off_topic_only: offTopic,
    teams: [...new Set(teams)], requires_operator: !offTopic,
    financial_actions_allowed: false as const, automatic_send_allowed: false as const,
  };
}

export function redact(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[НОМЕР СКРЫТ]")
    .replace(/((?:cvv|cvc|otp|3ds|код(?:\s+подтверждения)?|пароль)\s*[:=—-]?\s*)\d{3,8}\b/giu, "$1[СКРЫТО]")
    .replace(/(?:Bearer\s+)[a-z0-9._-]+/gi, "Bearer [СКРЫТО]");
}

export function isRussian(text: string): boolean {
  const russian = text.match(/[а-яё]/giu)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  return russian > 0 && russian >= latin;
}

export function technicalChecklist(moneyRelated: boolean): string[] {
  return [
    "Сопоставить обращение с идентификатором операции и временем ошибки.",
    "Проверить обезличенные логи, код ответа и подтверждённые события провайдера.",
    "Отделить подтверждённые факты от гипотез; HTTP 500 сам по себе не подтверждает отсутствие зачисления.",
    "Проверить связанные обращения и недавние изменения приложения.",
    ...(moneyRelated ? ["Оператору проверить денежную цепочку. Не запускать повторное пополнение, возврат или восстановление финансовой операции."] : []),
    "Если подтверждён дефект нашего кода — подготовить воспроизводящий тест и исправление для ревью.",
  ];
}
