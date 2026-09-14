import { z } from "zod";
import { schemas, type Model, type Task } from "./contracts.js";

export const MODELS = {
  "gpt-5-nano": { input: 0.05, output: 0.40, effort: "minimal" },
  "gpt-5.4-nano": { input: 0.20, output: 1.25, effort: "none" },
} as const;
export type ModelName = keyof typeof MODELS;
export interface Meter {
  reserve(model: string, task: Task, usd: number): Promise<string>;
  settle(id: string, usd: number, input: number, output: number, latency: number): Promise<void>;
}
const ResponseSchema = z.object({
  status: z.string(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({
    type: z.string(), text: z.string().optional(),
  })).optional() })),
});

export class OpenAIModel implements Model {
  constructor(private options: { apiKey: string; model: ModelName; meter: Meter; fetch?: typeof fetch }) {}
  async complete(task: Task, instructions: string, evidence: unknown): Promise<unknown> {
    const rates = MODELS[this.options.model];
    const maxOutput = task === "classify" ? 1000 : task === "answer" ? 1600 : 3600;
    const payload = {
      model: this.options.model, store: false, max_output_tokens: maxOutput,
      reasoning: { effort: rates.effort },
      input: [{ role: "developer", content: instructions }, { role: "user", content: JSON.stringify(evidence) }],
      text: { format: { type: "json_schema", name: task, strict: true, schema: schemas[task] } },
      // No tools, previous responses, external URLs, or delegated permissions.
    };
    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body);
    if (bytes > 180000) throw new Error("context_limit");
    // Conservative UTF-8 byte upper estimate plus protocol overhead. Reserve
    // maximum output including reasoning. Failed/ambiguous calls retain reserve.
    const reserved = ((bytes + 2048) * rates.input + maxOutput * rates.output) / 1_000_000;
    const reservation = await this.options.meter.reserve(this.options.model, task, reserved);
    const start = Date.now();
    const response = await (this.options.fetch ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body, signal: AbortSignal.timeout(45000), redirect: "error",
    });
    if (!response.ok) throw new Error(response.status === 429 ? "model_rate_limited" : "model_unavailable");
    const raw = ResponseSchema.parse(await response.json());
    const { input_tokens: input, output_tokens: output } = raw.usage;
    await this.options.meter.settle(reservation, (input * rates.input + output * rates.output) / 1_000_000,
      input, output, Date.now() - start);
    if (raw.status !== "completed") throw new Error("model_incomplete");
    const content = raw.output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
    if (content.some((c) => c.type === "refusal")) throw new Error("model_refusal");
    const text = content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    if (!text || text.length > 30000) throw new Error("model_invalid_output");
    return JSON.parse(text);
  }
}
