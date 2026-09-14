import { serve } from "@hono/node-server";
import { config } from "../config.js";
import { sql, assertSupportAgentSchema } from "../db.js";
import { applyMigrations } from "../migrations.js";
import { agentStore, startAgentWorker } from "./worker.js";
import { operationsStore } from "./operations-runtime.js";
import { readiness } from "./readiness.js";
import { createAgentRoutes } from "./routes.js";
import { createSandboxApp } from "./sandbox.js";
import { sandboxStore } from "./sandbox-store.js";

async function main() {
  if (config.SUPPORT_RUNTIME !== "sandbox" || !config.SUPPORT_AI_ADMIN_SECRET) {
    throw new Error("Sandbox runtime and a dedicated admin secret are required");
  }
  await applyMigrations();
  await assertSupportAgentSchema();
  const app = createSandboxApp(createAgentRoutes(agentStore, config.SUPPORT_AI_ADMIN_SECRET,
    operationsStore, config.SUPPORT_AI_MODE, () => readiness(config)), sandboxStore);
  const stopWorker = startAgentWorker();
  const server = serve({ fetch: app.fetch, port: config.PORT }, () => {
    console.log(`[support-ai] sandbox listening mode=${config.SUPPORT_AI_MODE}`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await stopWorker();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
void main().catch(() => { console.error("[support-ai] sandbox startup failed"); process.exit(1); });
