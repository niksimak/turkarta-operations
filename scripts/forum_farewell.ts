// One-off at CRM cutover: tell every open forum topic where its ticket lives now.
// Dry run by default (lists ticket and topic ids); `--send` posts.
//   DATABASE_URL=… SUPPORT_BOT_TOKEN=… SUPPORT_CHAT_ID=… PUBLIC_BASE_URL=… node --import tsx scripts/forum_farewell.ts [--send]
import { Api, GrammyError } from "grammy";
import postgres from "postgres";

const send = process.argv.includes("--send");
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
};
const url = env("DATABASE_URL");
const base = env("PUBLIC_BASE_URL").replace(/\/$/, "");
const chatId = send ? Number(env("SUPPORT_CHAT_ID")) : 0;
const api = send ? new Api(env("SUPPORT_BOT_TOKEN")) : null;

// Telegram allows about 20 messages a minute into one group.
const GAP_MS = 3100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sql = postgres(url, { max: 1 });
let failed = 0;
try {
  const rows = await sql<{ id: string; thread_id: number }[]>`
    select id, thread_id from support_requests
     where status in ('new','allocated','awaiting') and thread_id is not null
     order by created_at`;
  console.log(`${rows.length} open forum topic(s)${send ? "" : " (dry run, pass --send to post)"}`);
  for (const [i, row] of rows.entries()) {
    const text = `Поддержка переехала в CRM: ${base}/crm/t/${row.id}`;
    if (!api) {
      console.log(`would post ticket=${row.id} thread=${row.thread_id}`);
      continue;
    }
    if (i > 0) await sleep(GAP_MS);
    const post = () =>
      api.sendMessage(chatId, text, { message_thread_id: row.thread_id, link_preview_options: { is_disabled: true } });
    try {
      await post().catch(async (err: unknown) => {
        const wait = err instanceof GrammyError ? err.parameters.retry_after : undefined;
        if (!wait) throw err;
        await sleep(wait * 1000);
        return post();
      });
      console.log(`posted ticket=${row.id} thread=${row.thread_id}`);
    } catch (err) {
      failed++;
      const code = err instanceof GrammyError ? err.error_code : "network";
      console.error(`failed ticket=${row.id} thread=${row.thread_id} code=${code}`);
    }
  }
} finally {
  await sql.end();
}
if (failed) {
  console.error(`${failed} topic(s) not posted; a rerun posts to every open topic again`);
  process.exit(1);
}
