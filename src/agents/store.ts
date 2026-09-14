import type postgres from "postgres";
import type { TranscriptMessage } from "./contracts.js";

export interface Job { id: string; ticket_id: string; kind: "triage" | "review"; through_seq: number; lease_token: string; }
export interface Budget { dailyUsd: number; monthlyUsd: number; ticketDailyCalls: number; }
export class AgentStore {
  constructor(private sql: postgres.Sql) {}

  async claim(): Promise<Job | null> {
    // A later message supersedes queued analyses before any model spend.
    await this.sql`update support_agent_jobs j set status='superseded', finished_at=now()
      where j.status='pending' and exists (
        select 1 from support_agent_jobs n where n.ticket_id=j.ticket_id
          and n.kind=j.kind and n.through_seq>j.through_seq)`;
    await this.sql`update support_agent_jobs set status='failed', error_code='lease_exhausted', finished_at=now()
      where status='running' and lease_until < now() and attempts >= 2`;
    const rows = await this.sql<Job[]>`
      update support_agent_jobs set status='running', attempts=attempts+1,
        lease_until=now()+interval '10 minutes', lease_token=gen_random_uuid()
      where id=(select id from support_agent_jobs
        where (status='pending' and available_at<=now())
           or (status='running' and lease_until<now() and attempts<2)
        order by available_at for update skip locked limit 1)
      returning id,ticket_id,kind,through_seq,lease_token`;
    return rows[0] ?? null;
  }

  async transcript(job: Job): Promise<{ messages: TranscriptMessage[]; truncated: boolean }> {
    const rows = await this.sql<Array<TranscriptMessage & { full_length: number }>>`
      select id::text, actor_type as actor, author_id, left(body,12000) as body,
        created_at::text as at, length(body) as full_length
      from support_messages where ticket_id=${job.ticket_id} and seq<=${job.through_seq}
      order by seq desc limit 81`;
    const selected: TranscriptMessage[] = [];
    let chars = 0;
    let truncated = rows.length > 80;
    for (const row of rows.slice(0, 80)) {
      if (chars + row.body.length > 24000) { truncated = true; break; }
      chars += row.body.length;
      if (row.full_length > 12000) truncated = true;
      selected.push({ id: row.id, actor: row.actor, author_id: row.author_id, body: row.body, at: row.at });
    }
    return { messages: selected.reverse(), truncated };
  }

  async finish(job: Job, result: object): Promise<void> {
    // Lease fencing prevents a worker returning after timeout from overwriting a new result.
    await this.sql`update support_agent_jobs set
      status=case when exists(select 1 from support_messages
        where ticket_id=${job.ticket_id} and seq>${job.through_seq}) then 'superseded' else 'completed' end,
      result=${this.sql.json(result as postgres.JSONValue)}, finished_at=now(), lease_until=null
      where id=${job.id} and status='running' and lease_token=${job.lease_token}`;
  }

  async fail(job: Job, code: string): Promise<void> {
    await this.sql`update support_agent_jobs set status='failed', error_code=${code},
      finished_at=now(), lease_until=null where id=${job.id} and lease_token=${job.lease_token} and status='running'`;
  }

  async reserve(job: Job, model: string, task: string, usd: number, budget: Budget): Promise<string> {
    const result = await this.sql.begin(async (tx) => {
      // Serialize all reservations, across processes, before checking both caps.
      await tx`select pg_advisory_xact_lock(728493120)`;
      const [usage] = await tx`
        select coalesce(sum(coalesce(actual_usd,reserved_usd)) filter
          (where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)::float8 as day,
          coalesce(sum(coalesce(actual_usd,reserved_usd)),0)::float8 as month,
          count(*) filter (where ticket_id=${job.ticket_id} and
            created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')::int as calls
        from support_agent_calls
        where created_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'`;
      if (!usage || usage.day + usd > budget.dailyUsd || usage.month + usd > budget.monthlyUsd
        || usage.calls >= budget.ticketDailyCalls) throw new Error("budget_exceeded");
      const [row] = await tx`insert into support_agent_calls(job_id,ticket_id,model,task,reserved_usd)
        values(${job.id},${job.ticket_id},${model},${task},${usd}) returning id`;
      return String(row!.id);
    });
    return result;
  }

  async settle(id: string, usd: number, input: number, output: number, latency: number) {
    await this.sql`update support_agent_calls set actual_usd=${usd},input_tokens=${input},
      output_tokens=${output},latency_ms=${latency} where id=${id}`;
  }

  async results(ticketId: string) {
    return this.sql`select id,kind,through_seq,status,result,error_code,feedback,created_at,finished_at,
      exists(select 1 from support_messages m where m.ticket_id=j.ticket_id and m.seq>j.through_seq) as stale
      from support_agent_jobs j where ticket_id=${ticketId} order by created_at desc limit 30`;
  }

  async feedback(id: string, feedback: object): Promise<boolean> {
    const rows = await this.sql`update support_agent_jobs set feedback=${this.sql.json(feedback as postgres.JSONValue)}
      where id=${id} and kind='review' and result is not null returning id`;
    return rows.length > 0;
  }
}
