import { readFileSync } from "node:fs";
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
const file = join(here, "..", "migrations", "0001_init.sql");

try {
  await sql.unsafe(readFileSync(file, "utf8"));
  console.log("migration applied:", file);
} finally {
  await sql.end();
}
