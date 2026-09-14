import { Hono } from "hono";
import { z } from "zod";
import { createAgentRoutes } from "./routes.js";
import type { sandboxStore } from "./sandbox-store.js";

export function createSandboxApp(
  agentRoutes: ReturnType<typeof createAgentRoutes>,
  store: typeof sandboxStore,
) {
  // These handlers inherit the internal API's authentication and body limit.
  agentRoutes.post("/sandbox/tickets", async c => {
    const body = z.object({ text_ru: z.string().trim().min(1).max(6000) }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Нужен текст тестового обращения" }, 422);
    return c.json({ ticket_id: await store.create(body.data.text_ru) }, 201);
  });
  agentRoutes.post("/sandbox/tickets/:id/messages", async c => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    const body = z.object({ actor: z.enum(["customer", "human"]), text_ru: z.string().trim().min(1).max(6000) })
      .strict().safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: "Некорректное тестовое сообщение" }, 422);
    return await store.append(id.data, body.data.actor, body.data.text_ru)
      ? c.json({ ok: true }) : c.json({ error: "Тестовое обращение не найдено" }, 404);
  });
  const app = new Hono();
  app.get("/health", c => c.json({ status: "ok", runtime: "sandbox" }));
  app.route("/api/internal/support-ai", agentRoutes);
  return app;
}
