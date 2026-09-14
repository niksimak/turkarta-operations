import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AgentStore } from "./store.js";
import type { OperationsStore } from "./operations-store.js";

/** Dedicated internal credential: customer/app webhook secrets cannot read QA. */
export function createAgentRoutes(store: Pick<AgentStore, "results" | "feedback">, secret?: string,
  operations?: Pick<OperationsStore, "overview" | "dailyReport" | "reviewItems">, mode = "shadow",
  inspectReadiness?: () => object) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const supplied = c.req.header("x-support-ai-secret") ?? "";
    if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(secret)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) return c.json({ error: "Доступ запрещён" }, 403);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 10000, onError: (c) => c.json({ error: "Слишком большой запрос" }, 413) }));
  app.get("/readiness", (c) => inspectReadiness
    ? c.json(inspectReadiness()) : c.json({ error: "Проверка конфигурации не подключена" }, 503));
  app.get("/tickets/:id", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Некорректный идентификатор" }, 422);
    return c.json({ mode, language: "ru", results: await store.results(id.data) });
  });
  app.get("/operations", async (c) => {
    if (!operations) return c.json({ error: "Модуль задач не подключён" }, 503);
    const ticket = c.req.query("ticket_id");
    if (ticket && !z.string().uuid().safeParse(ticket).success) return c.json({ error: "Некорректный идентификатор" }, 422);
    return c.json(await operations.overview(ticket));
  });
  app.get("/quality/:day", async (c) => {
    if (!operations) return c.json({ error: "Модуль отчётов не подключён" }, 503);
    const day = z.string().date().safeParse(c.req.param("day"));
    if (!day.success) return c.json({ error: "Нужна дата в формате ГГГГ-ММ-ДД" }, 422);
    const [summary, reviews] = await Promise.all([operations.dailyReport(day.data), operations.reviewItems(day.data)]);
    return c.json({ summary, reviews, review_limit: 100 });
  });
  app.post("/reviews/:id/feedback", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > 10000) return c.json({ error: "Слишком большой запрос" }, 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 10000) return c.json({ error: "Слишком большой запрос" }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return c.json({ error: "Некорректный JSON" }, 422); }
    const input = z.object({ verdict: z.enum(["accepted", "rejected", "needs_revision"]),
      comment_ru: z.string().min(1).max(3000) }).strict().safeParse(body);
    if (!id.success || !input.success) return c.json({ error: "Некорректные данные" }, 422);
    const saved = await store.feedback(id.data, { ...input.data, at: new Date().toISOString(), actor: "support_lead_api" });
    return saved ? c.json({ ok: true }) : c.json({ error: "Отчёт не найден" }, 404);
  });
  return app;
}
