import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app, registerWebhooks } from "./server.js";
import { sql } from "./db.js";
import { leadsBot } from "./bots/leads.js";
import { supportBot } from "./bots/support.js";

async function main() {
  // init() lets grammy learn each bot's identity before handling updates.
  await Promise.all([leadsBot.init(), supportBot.init()]);
  await registerWebhooks();

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
    console.log(`${signal} received — shutting down`);
    server.close();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
