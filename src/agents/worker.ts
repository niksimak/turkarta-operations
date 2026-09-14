import { config } from "../config.js";
import { sql, getTicket } from "../db.js";
import { DiagnosticClient, attachDiagnostics } from "./diagnostics.js";
import { AgentStore } from "./store.js";
import { KnowledgeBase } from "./knowledge.js";
import { OpenAIModel } from "./openai.js";
import { SupportEngine } from "./engine.js";

export const agentStore = new AgentStore(sql);
const kb = new KnowledgeBase({ file: config.SUPPORT_AI_KB_FILE, api: config.SUPPORT_AI_KB_API });
const diagnostics = new DiagnosticClient({ url: config.SUPPORT_AI_DIAGNOSTICS_URL, secret: config.SUPPORT_AI_DIAGNOSTICS_SECRET });
const errorCodes = new Set(["budget_exceeded", "context_limit", "model_rate_limited", "model_unavailable",
  "model_incomplete", "model_refusal", "model_invalid_output", "non_russian_output",
  "unknown_article_reference", "unknown_message_reference", "unsupported_operator_finding", "duplicate_review_dimension"]);

export async function runAgentJob(): Promise<boolean> {
  if (config.SUPPORT_AI_MODE === "off") return false;
  const job = await agentStore.claim();
  if (!job) return false;
  try {
    const transcript = await agentStore.transcript(job);
    let articles: Awaited<ReturnType<KnowledgeBase["articles"]>> = [];
    let kbAvailable = true;
    try { articles = await kb.articles(); } catch { kbAvailable = false; }
    const model = new OpenAIModel({
      apiKey: config.OPENAI_API_KEY!, model: config.SUPPORT_AI_MODEL,
      meter: {
        reserve: (model, task, usd) => agentStore.reserve(job, model, task, usd, {
          dailyUsd: config.SUPPORT_AI_DAILY_USD, monthlyUsd: config.SUPPORT_AI_MONTHLY_USD,
          ticketDailyCalls: config.SUPPORT_AI_TICKET_DAILY_CALLS,
        }),
        settle: (...args) => agentStore.settle(...args),
      },
    });
    const engine = new SupportEngine(model);
    const result = job.kind === "triage"
      ? await attachDiagnostics(await engine.triage(transcript.messages, articles), await getTicket(job.ticket_id), diagnostics)
      : await engine.review(transcript.messages, articles, transcript.truncated);
    await agentStore.finish(job, { ...result, kb_available: kbAvailable,
      history_truncated: transcript.truncated, policy_version: "ru-support-v2" });
  } catch (error) {
    const code = error instanceof Error && errorCodes.has(error.message) ? error.message : "analysis_failed";
    await agentStore.fail(job, code);
    console.warn(`[support-ai] job=${job.id} code=${code}`); // no transcripts, secrets, or provider response bodies
  }
  return true;
}

/** One bounded job at a time per process. PostgreSQL leases coordinate instances. */
export function startAgentWorker(): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    active = runAgentJob().then(() => {}).catch(() => console.warn("[support-ai] worker_storage_failure"))
      .finally(() => { if (!stopped) timer = setTimeout(tick, 2000); });
  };
  if (config.SUPPORT_AI_MODE !== "off") timer = setTimeout(tick, 2000);
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
