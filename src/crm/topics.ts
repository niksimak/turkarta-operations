import type postgres from "postgres";
import { z } from "zod";
import { sql } from "../db.js";
import { publish } from "./events.js";
import { Forbidden, logEvent, NotFound, withLockedTicket } from "./tickets.js";
import { canEditTeamSettings, type Operator } from "./types.js";

export interface Topic { id: number; name: string; position: number; archived: boolean }

const Name = z.string().trim().min(1).max(60);
const TopicInput = z.object({ name: Name }).strict();
const TopicPatch = z.object({
  name: Name.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
}).strict().refine((p) => p.name !== undefined || p.position !== undefined || p.archived !== undefined, { message: "empty_patch" });

type Row = Record<string, unknown>;
type Sql = postgres.Sql | postgres.TransactionSql;

const toTopic = (r: Row): Topic => ({
  id: Number(r.id), name: r.name as string, position: Number(r.position), archived: r.archived_at != null,
});

const fieldError = (field: string, message: string) =>
  new z.ZodError([{ code: "custom", path: [field], message }]);

/** A unique-name clash surfaces as a field error, never a 500. */
async function uniqueName<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw fieldError("name", "duplicate");
    throw err;
  }
}

/** Active topics first in their order, archived ones after. */
export async function listTopics(): Promise<Topic[]> {
  const rows = await sql`select id, name, position, archived_at from crm_topics
    order by archived_at is not null, position, id`;
  return rows.map(toTopic);
}

export async function createTopic(input: unknown, me: Operator): Promise<Topic> {
  if (!canEditTeamSettings(me)) throw new Forbidden();
  const v = TopicInput.parse(input);
  const [r] = await uniqueName(() => sql`
    insert into crm_topics (name, position)
    values (${v.name}, (select coalesce(max(position), 0) + 1 from crm_topics))
    returning id, name, position, archived_at`);
  return toTopic(r!);
}

export async function updateTopic(id: number, patch: unknown, me: Operator): Promise<Topic> {
  if (!canEditTeamSettings(me)) throw new Forbidden();
  const v = TopicPatch.parse(patch);
  if (!Number.isInteger(id) || id <= 0) throw new NotFound();
  const [r] = await uniqueName(() => sql`
    update crm_topics
       set name = coalesce(${v.name ?? null}::text, name),
           position = coalesce(${v.position ?? null}::int, position),
           archived_at = case when ${v.archived ?? null}::boolean is null then archived_at
                              when ${v.archived ?? null}::boolean then coalesce(archived_at, now())
                              else null end
     where id = ${id}
    returning id, name, position, archived_at`);
  if (!r) throw new NotFound();
  return toTopic(r);
}

async function activeTopicName(tx: Sql, id: number): Promise<string | null> {
  const [r] = await tx<{ name: string }[]>`select name from crm_topics where id = ${id} and archived_at is null`;
  return r?.name ?? null;
}

async function currentTopic(tx: Sql, ticketId: string): Promise<{ id: number | null; name: string | null; source: string | null }> {
  const [r] = await tx`select r.topic_id, r.topic_source, t.name from support_requests r
    left join crm_topics t on t.id = r.topic_id where r.id = ${ticketId}`;
  return { id: r?.topic_id == null ? null : Number(r.topic_id), name: (r?.name as string | null) ?? null, source: (r?.topic_source as string | null) ?? null };
}

/** An operator's choice (or clearing it). Allowed on any ticket, resolved included. */
export async function setTicketTopic(ticketId: string, topicId: number | null, me: Operator): Promise<void> {
  const changed = await withLockedTicket(ticketId, async (tx) => {
    const cur = await currentTopic(tx, ticketId);
    const name = topicId === null ? null : await activeTopicName(tx, topicId);
    if (topicId !== null && name === null) throw fieldError("topic_id", "unknown_topic");
    if (cur.id === topicId && (topicId === null || cur.source === "operator")) return false;
    await tx`update support_requests
        set topic_id = ${topicId}, topic_source = ${topicId === null ? null : "operator"},
            topic_set_at = ${topicId === null ? null : sql`now()`}
      where id = ${ticketId}`;
    await logEvent(tx, ticketId, "topic_changed", me.id, { from: cur.name, to: name, source: "operator" });
    return true;
  });
  if (changed) await publish({ type: "ticket.updated", ticketId });
}

/** The AI suggestion: applied only while no operator has chosen. Returns whether the ticket changed. */
export async function applyAiTopic(ticketId: string, topicId: number): Promise<boolean> {
  const changed = await withLockedTicket(ticketId, async (tx) => {
    const cur = await currentTopic(tx, ticketId);
    if (cur.source === "operator") return false;
    const name = await activeTopicName(tx, topicId);
    if (name === null || cur.id === topicId) return false;
    await tx`update support_requests set topic_id = ${topicId}, topic_source = 'ai', topic_set_at = now() where id = ${ticketId}`;
    await logEvent(tx, ticketId, "topic_changed", null, { from: cur.name, to: name, source: "ai" });
    return true;
  });
  if (changed) await publish({ type: "ticket.updated", ticketId });
  return changed;
}

/** Queues the AI topic job for a just-resolved ticket unless an operator already chose. */
export async function enqueueTopicJob(tx: Sql, ticketId: string): Promise<void> {
  await tx`
    insert into support_agent_jobs (ticket_id, kind, through_seq)
    select r.id, 'topic', coalesce((select max(seq) from support_messages where ticket_id = r.id), 0)
      from support_requests r
     where r.id = ${ticketId} and r.topic_source is distinct from 'operator'
    on conflict do nothing`;
}
