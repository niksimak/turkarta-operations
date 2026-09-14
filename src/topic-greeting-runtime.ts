import { config } from "./config.js";
import { sql } from "./db.js";
import { TopicGreetingStore } from "./topic-greeting-store.js";
import { sendTopicGreeting } from "./topic-greeting.js";

const store = new TopicGreetingStore(sql);
export async function greetCustomer(ticketId: string, messageId: string,
  sendTelegram: (userId: number, text: string) => Promise<string>) {
  if (!config.SUPPORT_TOPIC_GREETINGS_ENABLED) return;
  try {
    const outcome = await sendTopicGreeting(store, ticketId, messageId, sendTelegram);
    if (outcome === "failed" || outcome === "unknown") console.warn(`[support-greeting] delivery_${outcome}`);
  } catch { console.warn("[support-greeting] storage_failure"); }
}
