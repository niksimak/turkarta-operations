export type GreetingTopic = "security" | "payment" | "kyc" | "card" | "technical" | "complaint" | "general";

const greetings: Record<GreetingTopic, string> = {
  security: "Здравствуйте! Получили ваше обращение о безопасности аккаунта или карты. Оператор ответит в этом чате. Не присылайте пароли, PIN, CVV и коды подтверждения.",
  payment: "Здравствуйте! Получили ваш вопрос по оплате или пополнению. Оператор проверит детали и ответит в этом чате.",
  kyc: "Здравствуйте! Получили ваш вопрос о проверке личности (KYC). Оператор поможет разобраться и ответит в этом чате.",
  card: "Здравствуйте! Получили ваш вопрос по карте. Оператор поможет разобраться и ответит в этом чате.",
  technical: "Здравствуйте! Получили сообщение о технической проблеме. Оператор поможет разобраться и ответит в этом чате.",
  complaint: "Здравствуйте! Получили ваше обращение и замечания. Оператор рассмотрит их и ответит в этом чате.",
  general: "Здравствуйте! Спасибо, что написали в поддержку Turkarta. Получили ваше обращение — оператор ответит в этом чате.",
};

/** Immediate, fixed acknowledgments: never interpolate customer text or model output. */
export function topicGreeting(text: string): { topic: GreetingTopic; text: string } {
  const signals: Array<[GreetingTopic, RegExp]> = [
    ["security", /мошен|взлом|укра[лд]|краж|подозрительн|чуж(?:ой|ая|ие)|не\s+я\s+(?:плат|оплач|перев)|\b(?:fraud|stolen|hacked|unauthori[sz]ed)\b/iu],
    ["payment", /оплат|плат[её]ж|пополн|зачисл|списа[нл]|деньг|перевод|возврат|баланс|комисс|\b(?:payment|top[ -]?up|refund|charged|balance|transfer)\b/iu],
    ["kyc", /kyc|верифик|проверк.*личност|подтвержд.*личност|паспорт|селфи|\bverification\b/iu],
    ["card", /карт|wallet|apple\s*pay|google\s*pay|\bcard\b/iu],
    ["technical", /ошиб|не\s+(?:работ|открыва|загружа)|приложен|войти|вход|\b(?:error|bug|login|crash)\b/iu],
    ["complaint", /жалоб|претензи|недовол|ужасн|\bcomplaint\b/iu],
  ];
  const topic = signals.find(([, pattern]) => pattern.test(text.slice(0, 12000)))?.[0] ?? "general";
  return { topic, text: greetings[topic] };
}

export interface GreetingClaim {
  ticketId: string; channel: "web" | "telegram"; userTg: number | null;
  topic: GreetingTopic; text: string;
}
export interface GreetingStore {
  prepare(ticketId: string, messageId: string): Promise<GreetingClaim | null>;
  delivered(ticketId: string, externalId: string): Promise<void>;
  failed(ticketId: string, outcome: "failed" | "unknown"): Promise<void>;
}

/** Claim before Telegram send. Ambiguous sends are never automatically replayed. */
export async function sendTopicGreeting(store: GreetingStore, ticketId: string, messageId: string,
  sendTelegram: (userId: number, text: string) => Promise<string>) {
  const claim = await store.prepare(ticketId, messageId);
  if (!claim) return "skipped";
  if (claim.channel === "web") return "sent"; // Persisted atomically for inbox polling.
  if (claim.userTg === null) { await store.failed(ticketId, "failed"); return "failed"; }
  let externalId: string;
  try { externalId = await sendTelegram(claim.userTg, claim.text); }
  catch (error) {
    const outcome = typeof (error as { error_code?: unknown })?.error_code === "number" ? "failed" : "unknown";
    await store.failed(ticketId, outcome);
    return outcome;
  }
  await store.delivered(ticketId, externalId);
  return "sent";
}
