// One-off at CRM cutover, after SUPPORT_SURFACE=crm and before scripts/forum_farewell.ts.
// Resets SLA timers carried over from Bitrix (see src/crm/cutover.ts). Prints counts only.
// Dry run by default; `--apply` writes.
//   DATABASE_URL=… node --import tsx scripts/crm_cutover.ts [--apply]
import postgres from "postgres";
import { crmCutover } from "../src/crm/cutover.js";

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const c = await crmCutover(sql, apply);
  console.log(`${apply ? "applied" : "dry run, pass --apply to write"}:`);
  console.log(`  waiting cleared (agent spoke last): ${c.waitingCleared}`);
  console.log(`  overdue pings stamped (open tickets): ${c.pingsStamped}`);
  console.log(`  requeued (claimed outside the CRM, no assignee): ${c.requeued}`);
} finally {
  await sql.end();
}
