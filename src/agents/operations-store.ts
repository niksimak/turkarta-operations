import type postgres from "postgres";
import { TaskSnapshot, taskSummary, canAct, routeFor, type InternalTask, type Notification, type OperationsOptions } from "./operations-contracts.js";
import { redact } from "./policy.js";

export class OperationsStore {
  constructor(private sql: postgres.Sql) {}

  /** Consume a completed analysis exactly once and atomically enqueue internal work. */
  async materialize(options: OperationsOptions): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [job] = await tx`select j.* from support_agent_jobs j
        where status in ('completed','failed') and operations_processed_at is null
        order by finished_at for update skip locked limit 1`;
      if (!job) return false;
      // Lock the ticket against concurrent closure while creating internal tasks.
      const [ticket] = await tx`select status from support_requests where id=${job.ticket_id} for update`;
      const [newer] = await tx`select id from support_messages where ticket_id=${job.ticket_id} and seq>${job.through_seq} limit 1`;
      if (job.kind === "triage" && !newer && ticket?.status !== "resolved") {
        const parsed = TaskSnapshot.safeParse(job.status === "failed" ? {
          classification: { summary_ru: "Автоматический анализ недоступен. Проверьте обращение вручную." },
          policy: { teams: ["support"], money_related: true, off_topic_only: false },
        } : job.result);
        if (parsed.success && !parsed.data.policy.off_topic_only) {
          const snapshot = parsed.data;
          // All legitimate cases need a person in assist mode, including KB drafts.
          for (const team of new Set(snapshot.policy.teams)) {
            const route = routeFor(team, options.routes);
            if (!route) throw new Error("owner_route_missing");
            const [task] = await tx<InternalTask[]>`insert into support_agent_tasks
              (ticket_id,job_id,team,through_seq,primary_tg,backup_tg,owner_tg,summary_ru,money_related,due_at)
              values(${job.ticket_id},${job.id},${team},${job.through_seq},${route.primary_tg},${route.backup_tg},
                ${route.primary_tg},${redact(taskSummary(snapshot))},${snapshot.policy.money_related},
                now()+${options.acknowledgeMinutes}*interval '1 minute')
              on conflict(ticket_id,team) where status in ('assigned','accepted','waiting') do update set
                job_id=excluded.job_id, through_seq=excluded.through_seq, revision=support_agent_tasks.revision+1,
                summary_ru=excluded.summary_ru, money_related=support_agent_tasks.money_related or excluded.money_related,
                updated_at=now()
              where support_agent_tasks.through_seq < excluded.through_seq returning *`;
            if (!task) continue;
            await tx`insert into support_agent_task_events(task_id,event) values(${task.id},'inquiry_updated')`;
            await tx`insert into support_agent_notifications(dedup_key,task_id,kind,chat_id,payload)
              values(${`task:${task.id}:${task.revision}`},${task.id},'task',${options.chatId},${tx.json({ revision: task.revision })})
              on conflict do nothing`;
          }
        }
      } else if (job.kind === "review" && options.qaChatId && !newer && job.feedback?.verdict !== "rejected") {
        const assessments = Array.isArray(job.result?.assessments) ? job.result.assessments : [];
        if (assessments.some((a: { verdict?: string }) => a.verdict === "critical")) {
          await tx`insert into support_agent_notifications(dedup_key,kind,chat_id,payload)
            values(${`critical:${job.id}`},'critical',${options.qaChatId},${tx.json({
              job_id: String(job.id), ticket_id: String(job.ticket_id),
              summary_ru: redact(String(job.result.summary_ru ?? "Нужна проверка руководителя")).slice(0, 900),
            })}) on conflict do nothing`;
        }
      }
      await tx`update support_agent_jobs set operations_processed_at=now() where id=${job.id}`;
      return true;
    });
  }

  async task(id: string): Promise<InternalTask | null> {
    const rows = await this.sql<InternalTask[]>`select * from support_agent_tasks where id=${id}`;
    return rows[0] ?? null;
  }

  async act(id: string, actor: number, action: "accept" | "update" | "wait" | "done", note: string,
    sourceId: string, updateMinutes: number): Promise<"ok" | "duplicate" | "denied"> {
    return this.sql.begin(async (tx) => {
      const [task] = await tx<InternalTask[]>`select * from support_agent_tasks where id=${id} for update`;
      if (!task) return "denied";
      const [previous] = await tx`select id from support_agent_task_events where source_id=${sourceId}`;
      if (previous) return "duplicate";
      if (!canAct(task, actor, action) || (action !== "accept" && note.trim().length < 5)) return "denied";
      const [ticket] = await tx`select status from support_requests where id=${task.ticket_id}`;
      if (ticket?.status === "resolved") return "denied";
      const status = action === "done" ? "resolved" : action === "wait" ? "waiting" : "accepted";
      await tx`update support_agent_tasks set status=${status},owner_tg=${actor},updated_at=now(),revision=revision+1,
        accepted_at=coalesce(accepted_at,now()),resolved_at=case when ${action}='done' then now() else resolved_at end,
        due_at=now()+${updateMinutes}*interval '1 minute',reminder_count=0,needs_attention=false,next_reminder_at=null where id=${id}`;
      await tx`insert into support_agent_task_events(task_id,event,actor_tg,note_ru,source_id)
        values(${id},${action},${actor},${redact(note.trim()).slice(0,2000)},${sourceId})`;
      return "ok";
    });
  }

  async callbackBelongs(taskId: string, chatId: number, messageId: number): Promise<boolean> {
    const rows = await this.sql`select id from support_agent_notifications where task_id=${taskId}
      and chat_id=${chatId} and telegram_message_id=${messageId} and status='sent' limit 1`;
    return rows.length > 0;
  }

  async scheduleReminders(options: OperationsOptions): Promise<void> {
    // A resolved customer ticket cancels outstanding internal work, not vice versa.
    await this.sql`update support_agent_tasks t set status='cancelled',updated_at=now()
      where status in ('assigned','accepted','waiting') and exists
      (select 1 from support_requests r where r.id=t.ticket_id and r.status='resolved')`;
    await this.sql.begin(async (tx) => {
      const tasks = await tx<InternalTask[]>`select * from support_agent_tasks
        where status in ('assigned','accepted','waiting') and due_at<=now() and reminder_count<${options.maxReminders}
          and (next_reminder_at is null or next_reminder_at<=now())
        order by due_at for update skip locked limit 20`;
      for (const task of tasks) {
        const count = task.reminder_count + 1;
        await tx`update support_agent_tasks set reminder_count=${count},needs_attention=true,
          next_reminder_at=now()+${options.updateMinutes}*interval '1 minute' where id=${task.id}`;
        await tx`insert into support_agent_task_events(task_id,event,note_ru)
          values(${task.id},'reminder',${`Напоминание ${count}; уведомляется резервный ответственный.`})`;
        await tx`insert into support_agent_notifications(dedup_key,task_id,kind,chat_id,payload)
          values(${`reminder:${task.id}:${task.revision}:${count}`},${task.id},'reminder',
            ${options.chatId},${tx.json({ reminder_count: count, revision: task.revision })}) on conflict do nothing`;
      }
    });
  }

  async claimNotification(): Promise<Notification | null> {
    // Telegram sendMessage has no client idempotency key: never blindly repeat an ambiguous send.
    await this.sql`update support_agent_notifications set status='unknown',error_code='send_lease_expired'
      where status='sending' and lease_until<now()`;
    await this.sql`update support_agent_notifications n set status='cancelled',error_code='task_closed'
      where status='pending' and task_id is not null and exists
      (select 1 from support_agent_tasks t where t.id=n.task_id and t.status in ('resolved','cancelled'))`;
    await this.sql`update support_agent_notifications n set status='cancelled',error_code='review_changed'
      where status='pending' and kind='critical' and not exists (
        select 1 from support_agent_jobs j where j.id::text=n.payload->>'job_id'
          and j.status='completed' and coalesce(j.feedback->>'verdict','')<>'rejected'
          and not exists(select 1 from support_messages m where m.ticket_id=j.ticket_id and m.seq>j.through_seq))`;
    const rows = await this.sql<Notification[]>`update support_agent_notifications set status='sending',
      attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute'
      where id=(select id from support_agent_notifications where status='pending' and available_at<=now()
        order by available_at for update skip locked limit 1)
      returning id,task_id,kind,chat_id,payload,lease_token,attempts`;
    return rows[0] ?? null;
  }

  async notificationSent(n: Notification, messageId: number) {
    await this.sql`update support_agent_notifications set status='sent',telegram_message_id=${messageId},sent_at=now(),lease_until=null
      where id=${n.id} and lease_token=${n.lease_token} and status='sending'`;
  }
  async notificationFailed(n: Notification, status: "failed" | "unknown" | "cancelled" | "pending", code: string, retrySeconds = 0) {
    await this.sql`update support_agent_notifications set status=${status},error_code=${code},lease_until=null,
      available_at=now()+${retrySeconds}*interval '1 second' where id=${n.id} and lease_token=${n.lease_token} and status='sending'`;
  }

  async dailyReport(day: string) {
    const start = `${day}T00:00:00Z`;
    const [report] = await this.sql`with reviews as (
      select distinct on(j.ticket_id) j.*,exists(select 1 from support_messages m
        where m.ticket_id=j.ticket_id and m.seq>j.through_seq and m.created_at<${start}::timestamptz+interval '1 day') as stale
      from support_agent_jobs j
      where j.kind='review' and j.status='completed' and j.result is not null
        and j.finished_at>=${start}::timestamptz and j.finished_at<${start}::timestamptz+interval '1 day'
      order by j.ticket_id,j.through_seq desc
    ) select count(*)::int as reviewed_conversations,
      count(*) filter(where not stale and coalesce(feedback->>'verdict','')<>'rejected' and
        jsonb_path_exists(result,'$.assessments[*] ? (@.verdict == "critical")'))::int as critical_candidates,
      count(*) filter(where feedback is null and not stale)::int as awaiting_lead_review,
      count(*) filter(where stale)::int as stale_reviews,
      count(*) filter(where feedback->>'verdict'='rejected')::int as rejected_reviews,
      count(*) filter(where jsonb_path_exists(result,'$.assessments[*] ? (@.attribution_incomplete == true)'))::int as unknown_authorship
      from reviews`;
    const [operations] = await this.sql`select
      count(*) filter(where status='assigned')::int as unaccepted_tasks,
      count(*) filter(where status in ('assigned','accepted','waiting') and (due_at<=now() or needs_attention))::int as attention_tasks
      from support_agent_tasks`;
    const [delivery] = await this.sql`select count(*)::int as delivery_issues from support_agent_notifications where status in ('failed','unknown')`;
    const [usage] = await this.sql`select coalesce(sum(coalesce(actual_usd,reserved_usd)),0)::float8 as estimated_usd
      from support_agent_calls where created_at>=${start}::timestamptz and created_at<${start}::timestamptz+interval '1 day'`;
    const [failures] = await this.sql`select count(*)::int as analysis_failures from support_agent_jobs
      where status='failed' and finished_at>=${start}::timestamptz and finished_at<${start}::timestamptz+interval '1 day'`;
    return { day_utc: day, ...report, ...operations, ...delivery, ...usage, ...failures,
      operations_snapshot_at: new Date().toISOString(),
      caveat_ru: "Замечания ИИ требуют проверки. Статусы задач и доставки показаны на момент формирования сводки." };
  }

  async scheduleDigest(options: OperationsOptions, now = new Date()) {
    if (!options.qaChatId || now.getUTCHours() < options.digestHourUtc) return;
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000).toISOString().slice(0,10);
    const key = `digest:${options.qaChatId}:${day}`;
    const [exists] = await this.sql`select id from support_agent_notifications where dedup_key=${key}`;
    if (exists) return;
    const report = await this.dailyReport(day);
    await this.sql`insert into support_agent_notifications(dedup_key,kind,chat_id,payload)
      values(${key},'digest',${options.qaChatId},${this.sql.json(report)}) on conflict do nothing`;
  }

  async reviewItems(day: string) {
    const start = `${day}T00:00:00Z`;
    return this.sql`select * from (
      select distinct on(j.ticket_id) j.id,j.ticket_id,j.through_seq,j.result,j.feedback,j.finished_at,
        exists(select 1 from support_messages m where m.ticket_id=j.ticket_id and m.seq>j.through_seq) as stale
      from support_agent_jobs j where j.kind='review' and j.status='completed' and j.result is not null
        and j.finished_at>=${start}::timestamptz and j.finished_at<${start}::timestamptz+interval '1 day'
      order by j.ticket_id,j.through_seq desc
    ) selected order by finished_at desc limit 100`;
  }

  async overview(ticketId?: string) {
    const tasks = await this.sql`select * from support_agent_tasks
      where ${ticketId ? this.sql`ticket_id=${ticketId}` : this.sql`status in ('assigned','accepted','waiting')`}
      order by due_at limit 100`;
    const notifications = await this.sql`select id,task_id,kind,status,error_code,created_at,telegram_message_id
      from support_agent_notifications where status in ('failed','unknown') order by created_at desc limit 100`;
    const events = ticketId ? await this.sql`select e.* from support_agent_task_events e
      join support_agent_tasks t on t.id=e.task_id where t.ticket_id=${ticketId} order by e.id desc limit 100` : [];
    return { tasks, events, notification_issues: notifications };
  }
}
