import type postgres from "postgres";
import { z } from "zod";
import { sql } from "../db.js";
import { Forbidden, NotFound } from "./tickets.js";
import { canEditTeamSettings, type Operator } from "./types.js";

export interface CannedReply {
  id: string; title: string; body: string; use_count: number;
  created_by: number | null; created_by_name: string | null; created_at: string; updated_at: string;
}

const CannedInput = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
}).strict();
const CannedPatch = CannedInput.partial().strict()
  .refine((p) => p.title !== undefined || p.body !== undefined, { message: "empty_patch" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 200;

type Row = Record<string, unknown>;

function toCanned(r: Row): CannedReply {
  return {
    id: r.id as string,
    title: r.title as string,
    body: r.body as string,
    use_count: Number(r.use_count),
    created_by: r.created_by == null ? null : Number(r.created_by),
    created_by_name: (r.created_by_name as string | null) ?? null,
    created_at: new Date(r.created_at as string | Date).toISOString(),
    updated_at: new Date(r.updated_at as string | Date).toISOString(),
  };
}

const withAuthor = (rows: postgres.PendingQuery<postgres.Row[]>) => sql`
  select c.id, c.title, c.body, c.use_count, c.created_by::text as created_by, o.name as created_by_name,
         c.created_at, c.updated_at
    from ${rows} c left join crm_operators o on o.id = c.created_by`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export async function listCanned(q?: string): Promise<CannedReply[]> {
  const text = (q ?? "").trim().slice(0, SEARCH_MAX);
  const where = text
    ? sql`where c.title ilike ${`%${escapeLike(text)}%`} or c.body ilike ${`%${escapeLike(text)}%`}`
    : sql``;
  const rows = await sql`${withAuthor(sql`crm_canned_replies`)} ${where} order by c.use_count desc, c.title, c.id`;
  return rows.map(toCanned);
}

export async function createCanned(input: unknown, me: Operator): Promise<CannedReply> {
  const v = CannedInput.parse(input);
  const [r] = await sql`
    with c as (
      insert into crm_canned_replies (title, body, created_by, updated_by)
      values (${v.title}, ${v.body}, ${me.id}, ${me.id})
      returning *
    ) ${withAuthor(sql`c`)}`;
  return toCanned(r!);
}

export async function updateCanned(id: string, patch: unknown, me: Operator): Promise<CannedReply> {
  const v = CannedPatch.parse(patch);
  if (!UUID_RE.test(id)) throw new NotFound();
  const [r] = await sql`
    with c as (
      update crm_canned_replies
         set title = coalesce(${v.title ?? null}::text, title),
             body = coalesce(${v.body ?? null}::text, body),
             updated_by = ${me.id}, updated_at = now()
       where id = ${id}
      returning *
    ) ${withAuthor(sql`c`)}`;
  if (!r) throw new NotFound();
  return toCanned(r);
}

/** Anyone edits; removing someone else's reply needs admin or lead. */
export async function deleteCanned(id: string, me: Operator): Promise<void> {
  if (!UUID_RE.test(id)) throw new NotFound();
  const [r] = await sql<{ created_by: string | null }[]>`
    select created_by::text as created_by from crm_canned_replies where id = ${id}`;
  if (!r) throw new NotFound();
  if (Number(r.created_by) !== me.id && !canEditTeamSettings(me)) throw new Forbidden();
  await sql`delete from crm_canned_replies where id = ${id}`;
}

export async function useCanned(id: string): Promise<{ use_count: number }> {
  if (!UUID_RE.test(id)) throw new NotFound();
  const [r] = await sql<{ use_count: number }[]>`
    update crm_canned_replies set use_count = use_count + 1 where id = ${id} returning use_count`;
  if (!r) throw new NotFound();
  return { use_count: Number(r.use_count) };
}
