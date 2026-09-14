import { readFile, readdir } from "node:fs/promises";
import { sql } from "./db.js";

/** Used by the isolated sandbox boot; relay deployments retain their rollout. */
export async function applyMigrations(): Promise<void> {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await sql.unsafe(await readFile(new URL(name, directory), "utf8"));
    console.log(`[support-ai] migration=${name}`);
  }
}
