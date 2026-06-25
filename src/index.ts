import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app, registerWebhooks } from "./server.js";
import { leadsBot } from "./bots/leads.js";
import { supportBot } from "./bots/support.js";

async function main() {
  // init() lets grammy learn each bot's identity before handling updates.
  await Promise.all([leadsBot.init(), supportBot.init()]);
  await registerWebhooks();

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`turkarta-operations listening on :${info.port}`);
    console.log(`  leads bot:   @${leadsBot.botInfo.username}`);
    console.log(`  support bot: @${supportBot.botInfo.username}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
