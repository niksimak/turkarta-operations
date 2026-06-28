import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(url);
const dir = join(here, "..", "migrations");

// Run every *.sql in lexical order. Migrations are written idempotently
// (create … if not exists / add column if not exists) so re-running is safe.
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

try {
  for (const file of files) {
    await sql.unsafe(readFileSync(join(dir, file), "utf8"));
    console.log("migration applied:", file);
  }
} finally {
  await sql.end();
}
