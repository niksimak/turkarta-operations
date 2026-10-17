// One-off after CRM cutover: resolves the Bitrix-era backlog (see archiveBacklog in src/crm/cutover.ts).
// `--before` is the cutover time. Prints the count only. Dry run by default; `--apply` writes.
//   DATABASE_URL=… node --import tsx scripts/crm_archive_backlog.ts --before 2026-10-17T10:29:42Z [--apply]
// Rollback: the status_changed events with payload reason=cutover_backlog carry each ticket's previous status.
import postgres from "postgres";
import { archiveBacklog } from "../src/crm/cutover.js";

const apply = process.argv.includes("--apply");
const i = process.argv.indexOf("--before");
const before = i > 0 ? new Date(process.argv[i + 1] ?? "") : null;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!before || Number.isNaN(before.getTime())) {
  console.error("--before <ISO time of the cutover> is required");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const n = await archiveBacklog(sql, before, apply);
  console.log(`${apply ? "applied" : "dry run, pass --apply to write"}: resolved ${n} open tickets silent since ${before.toISOString()}`);
} finally {
  await sql.end();
}
