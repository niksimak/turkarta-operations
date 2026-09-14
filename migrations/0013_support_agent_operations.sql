alter table support_agent_jobs add column if not exists operations_processed_at timestamptz;

create table if not exists support_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_requests(id) on delete cascade,
  job_id uuid not null references support_agent_jobs(id) on delete cascade,
  team text not null,
  through_seq bigint not null,
  revision int not null default 1,
  primary_tg bigint not null check (primary_tg>0),
  backup_tg bigint not null check (backup_tg>0),
  owner_tg bigint not null check (owner_tg>0),
  status text not null default 'assigned' check (status in ('assigned','accepted','waiting','resolved','cancelled')),
  summary_ru text not null,
  money_related boolean not null,
  due_at timestamptz not null,
  next_reminder_at timestamptz,
  reminder_count int not null default 0,
  needs_attention boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  resolved_at timestamptz
);
create unique index if not exists support_agent_tasks_open on support_agent_tasks(ticket_id,team)
  where status in ('assigned','accepted','waiting');
create index if not exists support_agent_tasks_due on support_agent_tasks(due_at)
  where status in ('assigned','accepted','waiting');

create table if not exists support_agent_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references support_agent_tasks(id) on delete cascade,
  event text not null,
  actor_tg bigint,
  note_ru text,
  source_id text unique,
  created_at timestamptz not null default now()
);

create table if not exists support_agent_notifications (
  id uuid primary key default gen_random_uuid(),
  dedup_key text not null unique,
  task_id uuid references support_agent_tasks(id) on delete cascade,
  kind text not null check (kind in ('task','reminder','critical','digest')),
  chat_id bigint not null check(chat_id<0),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','unknown','cancelled')),
  attempts int not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  telegram_message_id bigint,
  error_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists support_agent_notifications_queue on support_agent_notifications(status,available_at);

create table if not exists support_agent_review_feedback_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references support_agent_jobs(id) on delete cascade,
  feedback jsonb not null,
  created_at timestamptz not null default now()
);
create or replace function audit_support_agent_feedback() returns trigger language plpgsql as $$
begin
  if new.feedback is not null and new.feedback is distinct from old.feedback then
    insert into support_agent_review_feedback_events(job_id,feedback) values(new.id,new.feedback);
  end if;
  return new;
end $$;
drop trigger if exists support_agent_feedback_audit on support_agent_jobs;
create trigger support_agent_feedback_audit after update of feedback on support_agent_jobs
  for each row execute function audit_support_agent_feedback();
