import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** Throws unless the URL points at a local scratch database named crm_test. */
export function assertScratchDb(url: string): void {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.pathname !== "/crm_test") {
    throw new Error("CRM_TEST_DATABASE_URL must point at localhost /crm_test");
  }
}

/** Reset the scratch DB and apply every migration in lexical order. */
export async function freshCrmDb(url: string): Promise<postgres.Sql> {
  assertScratchDb(url);
  const sql = postgres(url, { max: 5, onnotice: () => {} });
  await sql.unsafe("drop schema public cascade; create schema public; create extension if not exists pgcrypto;");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return sql;
}
