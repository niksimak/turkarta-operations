import type postgres from "postgres";
import { legacySurface } from "../config.js";
import { sql, type Segment, type Ticket } from "../db.js";
import { publish, type CrmEvent } from "./events.js";
import type { ReplyDeps } from "./reply.js";
import { getSettings, type Settings } from "./settings.js";
import type { DeliveryStatus, MessageKind, Operator, TicketEventType, TicketStatus } from "./types.js";

export interface TicketListItem {
  id: string; status: TicketStatus; channel: "telegram" | "web" | "payout"; source: string | null;
  user_name: string | null; user_username: string | null; user_tg: number | null; email: string | null;
  last_message_preview: string; last_message_at: string | null; waiting_since: string | null;
  first_response_at: string | null; assigned_operator_id: number | null; assigned_operator_name: string | null;
  auto_assigned: boolean; intake_pending: boolean; created_at: string;
  segment: Segment | null; org_name: string | null;
}
export type TicketDetailItem = TicketListItem & {
  device: string | null; category: string | null; web_user_id: string | null;
  topic_id: number | null; topic_name: string | null; topic_source: "ai" | "operator" | null;
  admin_url: string | null;
};
export interface ListQuery {
  view: "queue" | "mine" | "all"; status?: TicketStatus; channel?: "bot" | "miniapp" | "web" | "payout"; operatorId?: number;
  overdue?: boolean; q?: string; cursor?: string; limit?: number; segment?: Segment;
}
export interface TicketEventRow { id: number; type: TicketEventType; actor_name: string | null; payload: Record<string, unknown>; created_at: string }
export interface CrmMessage {
  id: string; sender: "user" | "agent" | "system"; kind: MessageKind; body: string; unsupported_type: string | null;
  author_name: string | null; created_at: string; delivery_status: DeliveryStatus | null; delivery_error: string | null;
  attachments: Array<{ id: string; media_type: string | null; position: number }>;
}

export class Conflict extends Error {
  readonly code: "assigned_to_other" | "resolved" | "other_open";
  readonly assignee: { id: number; name: string } | undefined;
  constructor(code: "assigned_to_other" | "resolved" | "other_open", assignee?: { id: number; name: string }) {
    super(code);
    this.name = "Conflict";
    this.code = code;
    this.assignee = assignee;
  }
}
export class Forbidden extends Error {
  constructor(message = "forbidden") { super(message); this.name = "Forbidden"; }
}
export class NotFound extends Error {
  constructor(message = "not_found") { super(message); this.name = "NotFound"; }
}
export class BadCursor extends Error {
  constructor() { super("bad_cursor"); this.name = "BadCursor"; }
}

const PREVIEW_MAX = 120;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^(-?infinity|\d{4}-\d{2}-\d{2}[ T][0-9:.]+([+-]\d{2}(:?\d{2}){0,2}|Z)?)$/;

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toItem(r: Row): TicketListItem {
  const body = (r.preview_body as string | null) ?? "";
  return {
    id: r.id as string,
    status: r.status as TicketStatus,
    channel: r.channel as "telegram" | "web" | "payout",
    source: (r.source as string | null) ?? null,
    user_name: (r.user_name as string | null) ?? null,
    user_username: (r.user_username as string | null) ?? null,
    user_tg: num(r.user_tg),
    email: (r.email as string | null) ?? null,
    last_message_preview: body === "" && r.preview_kind === "photo" ? "Фото" : body === "" && r.preview_kind === "video" ? "Видео" : body,
    last_message_at: iso(r.last_message_at),
    waiting_since: iso(r.waiting_since),
    first_response_at: iso(r.first_response_at),
    assigned_operator_id: num(r.assigned_operator_id),
    assigned_operator_name: (r.assigned_operator_name as string | null) ?? null,
    auto_assigned: r.auto_assigned === true,
    intake_pending: r.intake_pending === true,
    created_at: iso(r.created_at)!,
    segment: (r.segment as Segment | null) ?? null,
    org_name: (r.org_name as string | null) ?? null,
  };
}

function itemSelect(extra: postgres.PendingQuery<postgres.Row[]>) {
  return sql`
    select r.id, r.status, r.channel, r.source, r.user_name, r.user_username, r.user_tg::text as user_tg, r.email,
           r.last_message_at, r.waiting_since, r.first_response_at, r.assigned_operator_id::text as assigned_operator_id,
           o.name as assigned_operator_name, r.auto_assigned, r.intake_step is not null as intake_pending, r.created_at,
           r.segment, r.org_name, p.kind as preview_kind, p.body as preview_body ${extra}
      from support_requests r
      left join crm_operators o on o.id = r.assigned_operator_id
      left join lateral (
        select m.kind, left(m.body, ${PREVIEW_MAX}) as body from support_messages m
         where m.ticket_id = r.id and m.kind <> 'note'
         order by m.seq desc limit 1
      ) p on true`;
}

/** `at` lets the worker evaluate SLA against an injected clock. */
export function overdueCond(s: Settings, at: postgres.PendingQuery<postgres.Row[]> = sql`now()`) {
  return sql`(r.status <> 'resolved' and r.waiting_since < ${at} - make_interval(mins =>
    case when r.first_response_at is null then ${s.sla_first_minutes}::int else ${s.sla_followup_minutes}::int end))`;
}

const and = (parts: Array<postgres.PendingQuery<postgres.Row[]>>) =>
  parts.reduce((acc, p) => sql`${acc} and ${p}`, sql`true`);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

function encodeCursor(keys: string[], id: string): string {
  return Buffer.from(JSON.stringify({ k: keys, id })).toString("base64url");
}

function decodeCursor(cursor: string, arity: number): { keys: string[]; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k?: unknown; id?: unknown };
    if (
      Array.isArray(v.k) && v.k.length === arity && v.k.every((k) => typeof k === "string" && TS_RE.test(k))
      && typeof v.id === "string" && UUID_RE.test(v.id)
    ) return { keys: v.k as string[], id: v.id };
  } catch { /* fall through */ }
  throw new BadCursor();
}

export async function listTickets(
  me: Operator, q: ListQuery, s: Settings,
): Promise<{ items: TicketListItem[]; nextCursor: string | null; counts: { queue: number; mine: number; overdue: number } }> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const conds: Array<postgres.PendingQuery<postgres.Row[]>> = [];
  if (q.view === "queue") conds.push(sql`r.status = 'new'`);
  if (q.view === "mine") {
    conds.push(sql`r.assigned_operator_id = ${me.id}`);
    // "Mine" means open work unless a status is asked for explicitly.
    if (!q.status) conds.push(sql`r.status in ('allocated','awaiting')`);
  }
  if (q.status) conds.push(sql`r.status = ${q.status}`);
  if (q.operatorId != null) conds.push(sql`r.assigned_operator_id = ${q.operatorId}`);
  if (q.channel === "web") conds.push(sql`r.source like 'web%'`);
  else if (q.channel) conds.push(sql`r.source = ${q.channel}`);
  if (q.segment) conds.push(sql`r.segment = ${q.segment}`);
  if (q.overdue) conds.push(overdueCond(s));
  const text = (q.q ?? "").trim().replace(/^@+/, "");
  if (text) {
    const sub = `%${escapeLike(text)}%`;
    conds.push(sql`(r.user_name ilike ${sub} or r.user_username ilike ${sub} or r.email ilike ${sub}
      or r.user_tg::text ilike ${sub} or r.id::text ilike ${`${escapeLike(text)}%`})`);
  }

  // Keyset over text-encoded keys: JS Dates drop the microseconds Postgres compares on.
  const queue = q.view === "queue";
  const k1 = queue ? sql`coalesce(r.queued_at, r.created_at)` : sql`coalesce(r.waiting_since, 'infinity'::timestamptz)`;
  const k2 = sql`coalesce(r.last_message_at, '-infinity'::timestamptz)`;
  if (q.cursor) {
    const c = decodeCursor(q.cursor, queue ? 1 : 2);
    conds.push(queue
      ? sql`(${k1}, r.id) > (${c.keys[0]!}::text::timestamptz, ${c.id}::text::uuid)`
      : sql`(${k1} > ${c.keys[0]!}::text::timestamptz or (${k1} = ${c.keys[0]!}::text::timestamptz and (${k2} < ${c.keys[1]!}::text::timestamptz
          or (${k2} = ${c.keys[1]!}::text::timestamptz and r.id > ${c.id}::text::uuid))))`);
  }
  const keys = queue ? sql`, ${k1}::text as k1` : sql`, ${k1}::text as k1, ${k2}::text as k2`;
  const order = queue ? sql`order by ${k1} asc, r.id asc` : sql`order by ${k1} asc, ${k2} desc, r.id asc`;

  const rows = await sql`${itemSelect(keys)} where ${and(conds)} ${order} limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last
    ? encodeCursor(queue ? [last.k1 as string] : [last.k1 as string, last.k2 as string], last.id as string)
    : null;

  const [c] = await sql<{ queue: number; mine: number; overdue: number }[]>`
    select count(*) filter (where r.status = 'new')::int as queue,
           count(*) filter (where r.assigned_operator_id = ${me.id} and r.status in ('allocated','awaiting'))::int as mine,
           count(*) filter (where ${overdueCond(s)})::int as overdue
      from support_requests r
     where r.status <> 'resolved'`;
  return { items: page.map(toItem), nextCursor, counts: { queue: c!.queue, mine: c!.mine, overdue: c!.overdue } };
}

/** Just who the ticket belongs to: the key for the Turkarta account lookup. */
export async function ticketCustomer(id: string): Promise<{ user_tg: number | null; web_user_id: string | null } | null> {
  if (!UUID_RE.test(id)) return null;
  const [r] = await sql`select user_tg::text as user_tg, web_user_id from support_requests where id = ${id}`;
  return r ? { user_tg: num(r.user_tg), web_user_id: (r.web_user_id as string | null) ?? null } : null;
}

export async function ticketItem(id: string): Promise<TicketListItem | null> {
  if (!UUID_RE.test(id)) return null;
  const [r] = await sql`${itemSelect(sql``)} where r.id = ${id}`;
  return r ? toItem(r) : null;
}

const messageSelect = () => sql`
  select m.id, m.sender, m.kind, m.body, m.unsupported_type, m.author_name, m.created_at, m.delivery_status, m.delivery_error,
         coalesce((select json_agg(json_build_object('id', a.id, 'media_type', a.media_type, 'position', a.position)
                            order by a.position, a.created_at)
                     from support_attachments a where a.message_id = m.id), '[]'::json) as attachments
    from support_messages m`;

function toMessage(m: Row): CrmMessage {
  return {
    id: m.id as string,
    sender: m.sender as CrmMessage["sender"],
    kind: m.kind as MessageKind,
    body: m.body as string,
    unsupported_type: (m.unsupported_type as string | null) ?? null,
    author_name: (m.author_name as string | null) ?? null,
    created_at: iso(m.created_at)!,
    delivery_status: (m.delivery_status as DeliveryStatus | null) ?? null,
    delivery_error: (m.delivery_error as string | null) ?? null,
    attachments: m.attachments as CrmMessage["attachments"],
  };
}

export async function crmMessage(id: string): Promise<CrmMessage | null> {
  if (!UUID_RE.test(id)) return null;
  const [m] = await sql`${messageSelect()} where m.id = ${id}`;
  return m ? toMessage(m) : null;
}

export async function ticketDetail(id: string): Promise<{ ticket: TicketDetailItem; messages: CrmMessage[]; events: TicketEventRow[] } | null> {
  if (!UUID_RE.test(id)) return null;
  const [r] = await sql`${itemSelect(sql`, r.device, r.category, r.web_user_id, r.topic_id, r.topic_source, r.admin_url,
    (select name from crm_topics where id = r.topic_id) as topic_name`)} where r.id = ${id}`;
  if (!r) return null;
  const msgs = await sql`${messageSelect()} where m.ticket_id = ${id} order by m.seq`;
  const evs = await sql`
    select e.id, e.type, o.name as actor_name, e.payload, e.created_at
      from crm_ticket_events e
      left join crm_operators o on o.id = e.actor_operator_id
     where e.ticket_id = ${id}
     order by e.id`;
  return {
    ticket: {
      ...toItem(r),
      device: (r.device as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      web_user_id: (r.web_user_id as string | null) ?? null,
      topic_id: num(r.topic_id),
      topic_name: (r.topic_name as string | null) ?? null,
      topic_source: (r.topic_source as "ai" | "operator" | null) ?? null,
      admin_url: (r.admin_url as string | null) ?? null,
    },
    messages: msgs.map(toMessage),
    events: evs.map((e) => ({
      id: Number(e.id),
      type: e.type as TicketEventType,
      actor_name: (e.actor_name as string | null) ?? null,
      payload: e.payload as Record<string, unknown>,
      created_at: iso(e.created_at)!,
    })),
  };
}

export interface LockedTicket {
  id: string;
  status: TicketStatus;
  assigned_operator_id: number | null;
  user_name: string | null;
  user_username: string | null;
}

interface Effects {
  notify?: { operatorId: number };
  resolved?: Ticket;
}

async function operatorRef(tx: Sql, id: number): Promise<{ id: number; name: string } | undefined> {
  const [o] = await tx<{ name: string }[]>`select name from crm_operators where id = ${id}`;
  return o ? { id, name: o.name } : undefined;
}

export async function logEvent(tx: Sql, ticketId: string, type: TicketEventType, actor: number | null, payload: Record<string, unknown>) {
  await tx`insert into crm_ticket_events (ticket_id, type, actor_operator_id, payload)
    values (${ticketId}, ${type}, ${actor}, ${JSON.stringify(payload)}::text::jsonb)`;
}

/** Writes the assignment and its event; `actor` is null for the auto-assign worker. */
export async function assignTo(
  tx: Sql, t: Pick<LockedTicket, "id">, to: { id: number; name: string }, type: TicketEventType, actor: number | null,
) {
  await tx`update support_requests
      set assigned_operator_id = ${to.id}, auto_assigned = ${type === "auto_assigned"},
          status = case when status = 'new' then 'allocated' else status end
    where id = ${t.id}`;
  await tx`update crm_operators set last_assigned_at = now() where id = ${to.id}`;
  await logEvent(tx, t.id, type, actor, { operator_id: to.id, operator_name: to.name });
}

async function toQueue(tx: Sql, t: LockedTicket, actor: number) {
  await tx`update support_requests
      set status = 'new', assigned_operator_id = null, auto_assigned = false, queued_at = now()
    where id = ${t.id}`;
  if (t.assigned_operator_id !== null) await logEvent(tx, t.id, "unassigned", actor, { operator_id: null, operator_name: null });
}

/** Runs `fn` in a transaction holding the ticket's row lock. */
export async function withLockedTicket<T>(ticketId: string, fn: (tx: postgres.TransactionSql, t: LockedTicket) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(ticketId)) throw new NotFound();
  try {
    return await sql.begin(async (tx) => {
      const [r] = await tx<{ id: string; status: TicketStatus; assigned_operator_id: string | null; user_name: string | null; user_username: string | null }[]>`
        select id, status, assigned_operator_id::text as assigned_operator_id, user_name, user_username
          from support_requests where id = ${ticketId} for update`;
      if (!r) throw new NotFound();
      return fn(tx, { ...r, assigned_operator_id: num(r.assigned_operator_id) });
    }) as T;
  } catch (err) {
    // Reopening a ticket while the same user has another open one hits the one-open-per-user index.
    if ((err as { code?: string }).code === "23505") throw new Conflict("other_open");
    throw err;
  }
}

/** Claims an open ticket for `me` (take / first reply). Returns false when it is already mine. */
export async function claim(tx: Sql, t: LockedTicket, me: Operator): Promise<boolean> {
  if (t.status === "resolved") throw new Conflict("resolved");
  if (t.assigned_operator_id === me.id) return false;
  if (t.assigned_operator_id !== null) throw new Conflict("assigned_to_other", await operatorRef(tx, t.assigned_operator_id));
  await assignTo(tx, t, me, "assigned", me.id);
  return true;
}

/** Row-locks the ticket, applies `fn`, then publishes after commit. `fn` returns null for a no-op. */
async function mutate(ticketId: string, fn: (tx: postgres.TransactionSql, t: LockedTicket) => Promise<Effects | null>): Promise<Effects | null> {
  let who = "";
  const effects = await withLockedTicket(ticketId, (tx, t) => {
    who = ticketWho(t);
    return fn(tx, t);
  });
  if (!effects) return null;
  await publish({ type: "ticket.updated", ticketId });
  if (effects.notify) await notifyAssigned(ticketId, effects.notify.operatorId, who);
  return effects;
}

export function ticketWho(t: { user_name: string | null; user_username: string | null }): string {
  return t.user_name || (t.user_username ? `@${t.user_username}` : "Без имени");
}

export async function notifyAssigned(ticketId: string, operatorId: number, who: string): Promise<void> {
  const e: CrmEvent = { type: "notify", operatorId, kind: "assigned", ticketId, title: "Вам назначено обращение", body: who };
  await publish(e);
}

export async function take(ticketId: string, me: Operator): Promise<void> {
  await mutate(ticketId, async (tx, t) => ((await claim(tx, t, me)) ? {} : null));
}

export async function takeOver(ticketId: string, me: Operator): Promise<void> {
  await mutate(ticketId, async (tx, t) => {
    if (t.status === "resolved") throw new Conflict("resolved");
    if (t.assigned_operator_id === me.id) return null;
    await assignTo(tx, t, me, t.assigned_operator_id === null ? "assigned" : "taken_over", me.id);
    return {};
  });
}

export async function assign(ticketId: string, to: number | null, me: Operator): Promise<void> {
  await mutate(ticketId, async (tx, t) => {
    if (me.role !== "admin" && t.assigned_operator_id !== me.id) throw new Forbidden();
    if (t.status === "resolved") throw new Conflict("resolved");
    if (to === null) {
      if (t.assigned_operator_id === null && t.status === "new") return null;
      await toQueue(tx, t, me.id);
      return {};
    }
    if (to === t.assigned_operator_id) return null;
    const target = await operatorRef(tx, to);
    if (!target) throw new NotFound("operator_not_found");
    await assignTo(tx, t, target, "assigned", me.id);
    return to === me.id ? {} : { notify: { operatorId: to } };
  });
}

export async function setStatus(
  ticketId: string, status: TicketStatus, me: Operator,
  deps: {
    onResolved?: (ticket: Ticket, text: string) => Promise<void>;
    onCsat?: (ticket: Ticket, text: string) => Promise<void>;
    csatDeps?: ReplyDeps;
  } = {},
): Promise<void> {
  const effects = await mutate(ticketId, async (tx, t) => {
    if (t.status === status) return null;
    if (status === "new") {
      if (me.role !== "admin" && t.assigned_operator_id !== null && t.assigned_operator_id !== me.id) throw new Forbidden();
      await toQueue(tx, t, me.id);
    } else {
      if (status !== "resolved" && t.assigned_operator_id === null) await assignTo(tx, t, me, "assigned", me.id);
      if (status === "resolved") {
        await tx`update support_requests set status = 'resolved', resolved_at = now(), waiting_since = null where id = ${t.id}`;
        // Lazy: topics.ts imports this module, so a static import would be a cycle.
        const { enqueueTopicJob } = await import("./topics.js");
        try {
          // A savepoint keeps a failed side job from aborting, and so undoing, the resolve.
          await tx.savepoint(async (sp) => enqueueTopicJob(sp, t.id));
        } catch (err) {
          console.error(`[crm-tickets] topic enqueue failed ticket=${t.id} code=${(err as { code?: string }).code ?? "error"}`);
        }
      } else {
        await tx`update support_requests set status = ${status} where id = ${t.id}`;
      }
    }
    await logEvent(tx, t.id, "status_changed", me.id, { from: t.status, to: status });
    if (status !== "resolved") return {};
    const [row] = await tx<Ticket[]>`select * from support_requests where id = ${t.id}`;
    return { resolved: row! };
  });
  // A payout ticket has no customer: no courtesy message, no survey.
  if (!effects?.resolved || effects.resolved.channel === "payout") return;
  const s = await getSettings();
  if (s.resolve_message_enabled) {
    try {
      await (deps.onResolved ?? sendResolveMessage)(effects.resolved, s.resolve_message_text);
    } catch (err) {
      // The ticket is already resolved; a failed courtesy message must not undo or fail that.
      console.error(`[crm-tickets] resolve message failed ticket=${ticketId} code=${(err as { code?: string }).code ?? "error"}`);
    }
  }
  if (!s.csat_enabled || legacySurface()) return;
  try {
    await (deps.onCsat ?? ((t, text) => askCsatLazy(t, text, deps.csatDeps)))(effects.resolved, s.csat_text);
  } catch (err) {
    console.error(`[crm-tickets] csat failed ticket=${ticketId} code=${(err as { code?: string }).code ?? "error"}`);
  }
}

// Lazy: csat.ts imports this module, so a static import would be a cycle.
async function askCsatLazy(ticket: Ticket, text: string, deps?: ReplyDeps): Promise<void> {
  const { askCsat } = await import("./csat.js");
  await askCsat(ticket, text, deps);
}

// Lazy: reply.ts imports this module, so a static import would be a cycle.
async function sendResolveMessage(ticket: Ticket, text: string): Promise<void> {
  const { sendSystemText } = await import("./reply.js");
  await sendSystemText(ticket, text);
}
