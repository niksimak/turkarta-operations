import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app, registerWebhooks } from "./server.js";
import * as db from "./db.js";
import { leadsBot } from "./bots/leads.js";
import { supportBot } from "./bots/support.js";
import { startAgentWorker } from "./agents/worker.js";
import { startOperationsWorker } from "./agents/operations-delivery.js";
import { telegramTransport } from "./agents/operations-telegram.js";
import { operationsStore, operationsOptions } from "./agents/operations-runtime.js";
import { ensureDeliverySchema } from "./bitrix_delivery_store.js";
import { startDeliveryConfirmations } from "./bitrix_delivery.js";

async function main() {
  await db.ensureSupportPhotoSchema();
  await db.assertSupportAgentSchema();
  await ensureDeliverySchema();
  await Promise.all([leadsBot.init(), supportBot.init()]);
  await registerWebhooks();
  const stopAgentWorker = startAgentWorker();
  const stopOperationsWorker = startOperationsWorker(operationsStore, telegramTransport(supportBot.api), operationsOptions);
  const stopDeliveryConfirmations = startDeliveryConfirmations();

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`turkarta-operations listening on :${info.port}`);
    console.log(`  leads bot:   @${leadsBot.botInfo.username}`);
    console.log(`  support bot: @${supportBot.botInfo.username}`);
  });

  // Render sends SIGTERM on deploy/scale-down: stop accepting requests, drain the PG pool.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopDeliveryConfirmations();
    console.log(`${signal} received — shutting down`);
    server.close();
    await Promise.all([stopAgentWorker(), stopOperationsWorker()]);
    await db.sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
