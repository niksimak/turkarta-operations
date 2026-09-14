-- Additive foundation. Does not send messages or execute financial operations.
alter table support_messages add column if not exists actor_type text not null default 'unknown'
  check (actor_type in ('customer','human','automation','system','unknown'));
alter table support_messages add column if not exists author_id text;
alter table support_messages add column if not exists source_message_id text;
create unique index if not exists support_messages_source_idx
  on support_messages(source_message_id) where source_message_id is not null;

-- Do not guess whether legacy 'agent' replies came from a human or automation.
update support_messages set actor_type = 'customer' where sender = 'user' and actor_type = 'unknown';
update support_messages set actor_type = 'system' where sender = 'system' and actor_type = 'unknown';

create table if not exists support_agent_jobs (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_requests(id) on delete cascade,
  kind text not null check (kind in ('triage','review')),
  through_seq bigint not null,
  status text not null default 'pending' check (status in ('pending','running','completed','failed','superseded')),
  attempts int not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  result jsonb,
  error_code text,
  feedback jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(ticket_id, kind, through_seq)
);
create index if not exists support_agent_jobs_queue on support_agent_jobs(status, available_at);

create table if not exists support_agent_calls (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references support_agent_jobs(id) on delete cascade,
  ticket_id uuid not null references support_requests(id) on delete cascade,
  model text not null,
  task text not null,
  reserved_usd numeric(14,8) not null check (reserved_usd >= 0),
  actual_usd numeric(14,8) check (actual_usd >= 0),
  input_tokens int,
  output_tokens int,
  latency_ms int,
  created_at timestamptz not null default now()
);
create index if not exists support_agent_calls_created on support_agent_calls(created_at);

create or replace function enqueue_support_agent_message() returns trigger language plpgsql as $$
declare job_kind text;
begin
  if new.actor_type = 'customer' then job_kind := 'triage';
  elsif new.actor_type in ('human','unknown') and new.sender = 'agent' then job_kind := 'review';
  else return new;
  end if;
  insert into support_agent_jobs(ticket_id, kind, through_seq, available_at)
  values(new.ticket_id, job_kind, new.seq,
    now() + case when job_kind = 'triage' then interval '2 seconds' else interval '30 seconds' end)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists support_agent_message_insert on support_messages;
create trigger support_agent_message_insert after insert on support_messages
  for each row execute function enqueue_support_agent_message();

create or replace function enqueue_support_agent_resolution() returns trigger language plpgsql as $$
begin
  if new.status = 'resolved' and old.status <> 'resolved' then
    insert into support_agent_jobs(ticket_id, kind, through_seq)
    select new.id, 'review', coalesce(max(seq),0) from support_messages where ticket_id = new.id
    on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists support_agent_ticket_resolved on support_requests;
create trigger support_agent_ticket_resolved after update of status on support_requests
  for each row execute function enqueue_support_agent_resolution();
