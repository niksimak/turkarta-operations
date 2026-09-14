import type { config } from "../config.js";

/** Configuration inspection only: no sends, provider/model requests, or secret values. */
export function readiness(env: typeof config) {
  return {
    mode: env.SUPPORT_AI_MODE, language: "ru", model: env.SUPPORT_AI_MODEL,
    model_key_configured: !!env.OPENAI_API_KEY,
    knowledge_source: env.SUPPORT_AI_KB_FILE ? "file" : env.SUPPORT_AI_KB_API ? "api" : "missing",
    internal_group_configured: !!env.SUPPORT_AI_INTERNAL_CHAT_ID,
    qa_group_configured: !!env.SUPPORT_AI_QA_CHAT_ID,
    owner_teams: Object.keys(env.SUPPORT_AI_OWNER_ROUTES),
    diagnostics_configured: !!env.SUPPORT_AI_DIAGNOSTICS_URL && !!env.SUPPORT_AI_DIAGNOSTICS_SECRET,
    daily_budget_usd: env.SUPPORT_AI_DAILY_USD, monthly_budget_usd: env.SUPPORT_AI_MONTHLY_USD,
    connectivity: "not_checked", automatic_customer_replies: false, financial_actions: false,
    note_ru: "Показана только конфигурация. Доступность модели, базы знаний, диагностики и Telegram ещё нужно проверить на тестовом обращении.",
  };
}
