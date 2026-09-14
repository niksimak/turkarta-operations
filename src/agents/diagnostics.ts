import { z } from "zod";

const Subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("telegram"), id: z.string().regex(/^[1-9][0-9]{0,15}$/)
    .refine((v) => Number.isSafeInteger(Number(v))) }).strict(),
]);
const time = z.string().datetime({ offset: true });
const provider = z.enum(["csb", "pago", "unknown"]);
const Topup = z.object({
  id: z.string().uuid(), card_id: z.string().uuid().nullable(), provider,
  state: z.enum(["created", "rail_pending", "rail_paid", "funding", "funded", "rail_failed", "funding_failed", "unknown"]),
  created_at: time, record_updated_at: time, rail_paid_at: time.nullable(), funded_at: time.nullable(),
  error_category: z.enum(["outcome_unknown", "kyc_check_required", "upstream_5xx", "unclassified_error"]).nullable(),
  prior_auto_retry_recorded: z.boolean(),
}).strict();
export const Snapshot = z.object({
  schema_version: z.literal(1), subject: Subject, observed_at: time,
  source: z.literal("internal_snapshot"), provider_verified: z.literal(false),
  status: z.enum(["available", "identity_ambiguous", "account_not_found"]),
  truncated: z.boolean(),
  cards: z.array(z.object({ id: z.string().uuid(), provider,
    state: z.enum(["pending", "active", "inactive", "frozen", "blocked", "closed", "cancelled", "unknown"]),
    record_updated_at: time }).strict()).max(20),
  topups: z.array(Topup).max(10),
  csb_kyc: z.object({ approved_cached: z.boolean(), last_checked_at: time.nullable() }).strict().nullable(),
}).strict();
export type Snapshot = z.infer<typeof Snapshot>;
export type TicketIdentity = { channel: string; web_user_id: string | null; user_tg: string | number | null };
export type DiagnosticResult = {
  status: "not_connected" | "unavailable" | "identity_missing" | Snapshot["status"];
  summary_ru: string; snapshot?: Snapshot;
};

/** Identity comes exclusively from the stored ticket, never message/model content. */
export function ticketSubject(ticket: TicketIdentity) {
  const parsed = Subject.safeParse(ticket.channel === "web"
    ? { kind: "web", id: ticket.web_user_id }
    : ticket.channel === "telegram" ? { kind: "telegram", id: String(ticket.user_tg ?? "") } : null);
  return parsed.success ? parsed.data : null;
}

export class DiagnosticClient {
  constructor(private options: { url?: string; secret?: string; fetch?: typeof fetch }) {}

  async inspect(ticket: TicketIdentity): Promise<DiagnosticResult> {
    if (!this.options.url || !this.options.secret) return {
      status: "not_connected", summary_ru: "Диагностика аккаунта не подключена.",
    };
    const subject = ticketSubject(ticket);
    if (!subject) return { status: "identity_missing", summary_ru: "Нужна подтверждённая привязка обращения к аккаунту." };
    try {
      const url = new URL(this.options.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("invalid_diagnostic_origin");
      }
      url.pathname = "/internal/support-diagnostics/snapshot";
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "X-Support-Diagnostics-Secret": this.options.secret },
        body: JSON.stringify(subject),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("diagnostic_unavailable"); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 64000) throw new Error("diagnostic_payload_limit");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const snapshot = Snapshot.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const age = Date.now() - Date.parse(snapshot.observed_at);
      if (snapshot.subject.kind !== subject.kind || snapshot.subject.id !== subject.id
        || age > 120000 || age < -30000) throw new Error("diagnostic_evidence_mismatch");
      if (snapshot.status !== "available" && (snapshot.cards.length || snapshot.topups.length || snapshot.csb_kyc)) {
        throw new Error("diagnostic_unscoped_data");
      }
      return { status: snapshot.status, summary_ru: summarizeSnapshot(snapshot), snapshot };
    } catch {
      // Keep classification and the operator handoff working; never log response bodies.
      return { status: "unavailable", summary_ru: "Данные аккаунта получить не удалось. Требуется проверка оператором." };
    }
  }
}

export function summarizeSnapshot(snapshot: Snapshot): string {
  if (snapshot.status === "identity_ambiguous") return "У Telegram несколько связанных аккаунтов. Нужна привязка обращения к конкретному аккаунту.";
  if (snapshot.status === "account_not_found") return "Аккаунт не найден в подключённой среде. Нужна проверка привязки обращения.";
  const lines = ["Прочитан внутренний снимок; провайдер сейчас не проверялся. Операция из обращения автоматически не определена."];
  const pending = snapshot.topups.filter((t) => ["rail_paid", "funding", "funding_failed"].includes(t.state));
  if (pending.length) lines.push(`Среди последних операций ${pending.length} требуют сверки зачисления.`);
  if (pending.some((t) => ["upstream_5xx", "outcome_unknown"].includes(t.error_category ?? ""))) {
    lines.push("Есть ошибка 5xx или запись о неизвестном результате. Это не доказывает отсутствие зачисления.");
  }
  if (pending.some((t) => t.prior_auto_retry_recorded)) lines.push("Зафиксирована предыдущая автоматическая попытка; её результат нужно сверить.");
  if (!snapshot.topups.length) lines.push("Записей о пополнении не найдено; это не подтверждает отсутствие платежа.");
  if (snapshot.csb_kyc) lines.push(snapshot.csb_kyc.approved_cached
    ? "В кэше KYC CSB отмечен как одобренный; дата проверки — в отчёте."
    : "В кэше нет одобрения KYC CSB; это не подтверждённый отказ.");
  if (snapshot.truncated) lines.push("Показана только часть истории.");
  lines.push("Денежные действия — только через оператора.");
  return lines.join(" ");
}

/** Diagnostics stay outside model context and never certify a financial result. */
export async function attachDiagnostics<T extends {
  classification: { categories: string[] }; policy: { money_related: boolean; off_topic_only: boolean };
  diagnostic_status: string; escalation_ru: string | null;
}>(result: T, ticket: TicketIdentity | null, client: DiagnosticClient) {
  if (result.policy.off_topic_only || (!result.policy.money_related
    && !result.classification.categories.some((c) => ["technical", "card", "kyc", "payment"].includes(c)))) return result;
  const diagnostics: DiagnosticResult = ticket ? await client.inspect(ticket)
    : { status: "identity_missing", summary_ru: "Не найдена подтверждённая привязка обращения." };
  return { ...result, diagnostic_status: diagnostics.status, diagnostics,
    escalation_ru: `${result.escalation_ru ?? "Требуется проверка."}\n${diagnostics.summary_ru}` };
}
