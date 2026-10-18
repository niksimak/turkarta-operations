import { sql } from "../db.js";
import type { Settings } from "./settings.js";
import { canEditTeamSettings, type Operator } from "./types.js";

/** Half-open [from, to). */
export interface StatsRange { from: Date; to: Date }
/** New tickets by Moscow ISO weekday (1 = Monday) and hour of the customer's first message. */
export interface HeatCell { dow: number; hour: number; n: number }
export interface TeamStats {
  new_per_day: Array<{ day: string; bot: number; miniapp: number; web: number }>;
  backlog: number;
  oldest_waiting_minutes: number | null;
  within_sla_pct: number | null;
  resolution_median_s: number | null;
  one_reply_pct: number | null;
  messages_per_ticket: number | null;
  heatmap: HeatCell[];
}
export interface OperatorStats {
  operator_id: number; name: string; taken: number; auto_assigned: number; resolved: number; replies: number;
  response_median_s: number | null; response_p90_s: number | null;
  first_response_median_s: number | null; first_response_p90_s: number | null;
  within_sla_pct: number | null; reopen_rate_pct: number | null;
  resolution_median_s: number | null; one_reply_pct: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function stats(range: StatsRange, me: Operator, s: Settings): Promise<{ team: TeamStats; operators: OperatorStats[] }> {
  const { from, to } = range;
  const firstTarget = s.sla_first_minutes * 60;
  const followupTarget = s.sla_followup_minutes * 60;
  const seeAll = canEditTeamSettings(me);

  // CRM replies in range. The ticket's first reply is the one stamped as first_response_at and gets the first-response target.
  // First-response time is that reply's response_seconds (from when the customer wrote), never
  // first_response_at - created_at: welcome tickets are created at signup, long before anyone writes.
  const replies = sql`
    select m.author_id, m.response_seconds,
           (m.created_at = r.first_response_at) as is_first
      from public.support_messages m
      join public.support_requests r on r.id = m.ticket_id
     where m.sender = 'agent' and m.kind in ('text','photo','video') and m.author_id like 'crm:%'
       and m.created_at >= ${from} and m.created_at < ${to}`;
  const inSla = sql`response_seconds <= case when is_first then ${firstTarget}::int else ${followupTarget}::int end`;

  // Operator resolves in range (cutover/bulk closes have no actor), each with the ticket's previous
  // resolve and whether a reopen followed before the ticket's next resolve.
  const resolveRows = sql`
    select e.ticket_id, e.actor_operator_id as op, e.created_at as resolved_at,
           (select max(p.created_at) from public.crm_ticket_events p
             where p.ticket_id = e.ticket_id and p.type = 'status_changed' and p.payload->>'to' = 'resolved'
               and (p.created_at, p.id) < (e.created_at, e.id)) as prev_resolved_at,
           exists (select 1 from public.crm_ticket_events o
                    where o.ticket_id = e.ticket_id and o.type = 'reopened' and o.created_at > e.created_at
                      and (nx.created_at is null or o.created_at < nx.created_at)) as reopened
      from public.crm_ticket_events e
      left join lateral (
        select x.created_at from public.crm_ticket_events x
         where x.ticket_id = e.ticket_id and x.type = 'status_changed' and x.payload->>'to' = 'resolved'
           and (x.created_at, x.id) > (e.created_at, e.id)
         order by x.created_at, x.id limit 1
      ) nx on true
     where e.type = 'status_changed' and e.payload->>'to' = 'resolved'
       and e.created_at >= ${from} and e.created_at < ${to} and e.actor_operator_id is not null`;

  // One row per resolve whose cycle (after the previous resolve, up to this one) has a customer message.
  // Resolution time runs from the cycle's first customer message, never from created_at (welcome tickets).
  const cycles = sql`
    select r.op, r.reopened, m.replies, m.messages,
           extract(epoch from r.resolved_at - m.first_user_at) as resolution_s
      from (${resolveRows}) r
      cross join lateral (
        select min(created_at) filter (where sender = 'user') as first_user_at,
               count(*) filter (where sender = 'agent' and actor_type = 'human' and author_id like 'crm:%'
                                  and kind in ('text','photo','video'))::int as replies,
               count(*) filter (where kind <> 'note' and (sender = 'user'
                                  or (sender = 'agent' and actor_type not in ('automation','system'))))::int as messages
          from public.support_messages
         where ticket_id = r.ticket_id and created_at <= r.resolved_at
           and (r.prev_resolved_at is null or created_at > r.prev_resolved_at)
      ) m
     where m.first_user_at is not null`;

  const days = await sql`
    select to_char(d, 'YYYY-MM-DD') as day,
           count(r.id) filter (where r.source = 'bot')::int as bot,
           count(r.id) filter (where r.source = 'miniapp')::int as miniapp,
           count(r.id) filter (where r.source like 'web%')::int as web
      from generate_series((${from}::timestamptz at time zone 'Europe/Moscow')::date,
                           ((${to}::timestamptz - interval '1 microsecond') at time zone 'Europe/Moscow')::date,
                           interval '1 day') d
      left join public.support_requests r
        on r.created_at >= ${from} and r.created_at < ${to}
       and (r.created_at at time zone 'Europe/Moscow')::date = d::date
     group by d order by d`;

  const [now] = await sql`
    select count(*)::int as backlog,
           floor(extract(epoch from now() - min(waiting_since)) / 60)::int as oldest
      from public.support_requests
     where status in ('new','allocated','awaiting')`;

  const [teamSla] = await sql`
    select round(100.0 * count(*) filter (where ${inSla})
                 / nullif(count(*) filter (where response_seconds is not null), 0), 1) as pct
      from (${replies}) x`;

  const [teamCycles] = await sql`
    select round((percentile_cont(0.5) within group (order by resolution_s))::numeric) as res_med,
           round(100.0 * count(*) filter (where replies = 1 and not reopened)
                 / nullif(count(*) filter (where replies >= 1), 0), 1) as one_reply,
           round(avg(messages)::numeric, 1) as msgs
      from (${cycles}) c`;

  // New tickets by when the customer first wrote (Moscow weekday and hour), not by created_at.
  const heat = await sql`
    select extract(isodow from f.at at time zone 'Europe/Moscow')::int as dow,
           extract(hour from f.at at time zone 'Europe/Moscow')::int as hour,
           count(*)::int as n
      from (select min(m.created_at) as at from public.support_messages m
             where m.sender = 'user'
               and m.ticket_id in (select ticket_id from public.support_messages
                                    where sender = 'user' and created_at >= ${from} and created_at < ${to})
             group by m.ticket_id) f
     where f.at >= ${from} and f.at < ${to}
     group by 1, 2 order by 1, 2`;

  const rows = await sql`
    with ops as (
      select id, name from public.crm_operators where ${seeAll} or id = ${me.id}
    ), ev as (
      select type, actor_operator_id, (payload->>'operator_id')::bigint as target
        from public.crm_ticket_events
       where created_at >= ${from} and created_at < ${to}
         and type in ('assigned','taken_over','auto_assigned')
    ), taken as (
      select actor_operator_id as op, count(*)::int as n from ev
       where type in ('assigned','taken_over') and actor_operator_id = target group by 1
    ), auto as (
      select target as op, count(*)::int as n from ev where type = 'auto_assigned' and target is not null group by 1
    ), resolves as (
      -- A resolve counts as reopened when a reopen follows it before the ticket's next resolve.
      ${resolveRows}
    ), res as (
      select op, count(*)::int as n, count(*) filter (where reopened)::int as reopened from resolves group by 1
    ), rep as (
      select author_id, count(*)::int as n,
             round((percentile_cont(0.5) within group (order by response_seconds))::numeric) as med,
             round((percentile_cont(0.9) within group (order by response_seconds))::numeric) as p90,
             round((percentile_cont(0.5) within group (order by response_seconds) filter (where is_first))::numeric) as first_med,
             round((percentile_cont(0.9) within group (order by response_seconds) filter (where is_first))::numeric) as first_p90,
             round(100.0 * count(*) filter (where ${inSla})
                   / nullif(count(*) filter (where response_seconds is not null), 0), 1) as sla
        from (${replies}) x group by 1
    ), cyc as (
      select op, round((percentile_cont(0.5) within group (order by resolution_s))::numeric) as res_med,
             round(100.0 * count(*) filter (where replies = 1 and not reopened)
                   / nullif(count(*) filter (where replies >= 1), 0), 1) as one_reply
        from (${cycles}) c group by 1
    )
    select o.id, o.name, coalesce(t.n, 0) as taken, coalesce(a.n, 0) as auto_assigned,
           coalesce(rs.n, 0) as resolved, coalesce(rp.n, 0) as replies,
           rp.med, rp.p90, rp.first_med, rp.first_p90, rp.sla,
           round(100.0 * rs.reopened / nullif(rs.n, 0), 1) as reopen,
           cy.res_med, cy.one_reply
      from ops o
      left join taken t on t.op = o.id
      left join auto a on a.op = o.id
      left join res rs on rs.op = o.id
      left join rep rp on rp.author_id = 'crm:' || o.id
      left join cyc cy on cy.op = o.id
     order by o.name, o.id`;

  return {
    team: {
      new_per_day: days.map((d) => ({ day: String(d.day), bot: Number(d.bot), miniapp: Number(d.miniapp), web: Number(d.web) })),
      backlog: Number(now!.backlog),
      oldest_waiting_minutes: num(now!.oldest),
      within_sla_pct: num(teamSla!.pct),
      resolution_median_s: num(teamCycles!.res_med),
      one_reply_pct: num(teamCycles!.one_reply),
      messages_per_ticket: num(teamCycles!.msgs),
      heatmap: heat.map((h) => ({ dow: Number(h.dow), hour: Number(h.hour), n: Number(h.n) })),
    },
    operators: rows.map((r) => ({
      operator_id: Number(r.id),
      name: String(r.name),
      taken: Number(r.taken),
      auto_assigned: Number(r.auto_assigned),
      resolved: Number(r.resolved),
      replies: Number(r.replies),
      response_median_s: num(r.med),
      response_p90_s: num(r.p90),
      first_response_median_s: num(r.first_med),
      first_response_p90_s: num(r.first_p90),
      within_sla_pct: num(r.sla),
      reopen_rate_pct: num(r.reopen),
      resolution_median_s: num(r.res_med),
      one_reply_pct: num(r.one_reply),
    })),
  };
}
