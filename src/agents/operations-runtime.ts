import { config } from "../config.js";
import { sql } from "../db.js";
import { OperationsStore } from "./operations-store.js";
import type { OperationsOptions } from "./operations-contracts.js";

export const operationsStore = new OperationsStore(sql);
export const operationsOptions: OperationsOptions | undefined = config.SUPPORT_AI_MODE === "assist" ? {
  chatId: config.SUPPORT_AI_INTERNAL_CHAT_ID!, qaChatId: config.SUPPORT_AI_QA_CHAT_ID,
  routes: config.SUPPORT_AI_OWNER_ROUTES,
  acknowledgeMinutes: config.SUPPORT_AI_ACK_MINUTES, updateMinutes: config.SUPPORT_AI_UPDATE_MINUTES,
  maxReminders: config.SUPPORT_AI_MAX_REMINDERS, digestHourUtc: config.SUPPORT_AI_DIGEST_HOUR_UTC,
} : undefined;
