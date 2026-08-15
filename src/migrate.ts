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
// In source this resolves to ../migrations; compiled in dist it does as well.
const dir = join(here, "..", "migrations");
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

try {
  for (const file of files) {
    await sql.unsafe(readFileSync(join(dir, file), "utf8"));
    console.log("migration applied:", file);
  }
} finally {
  await sql.end();
}
