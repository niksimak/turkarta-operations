-- Support CRM (spec docs/superpowers/specs/2026-10-16-support-crm-design.md §4). Additive only.
create table if not exists public.crm_operators (
  id bigint primary key,                       -- turkarta admin_users.id
  name text not null,
  email text,
  role text not null check (role in ('admin','support')),
  is_lead boolean not null default false,
  auto_assign_enabled boolean not null default true,
  on_shift boolean not null default false,
  last_active_at timestamptz,
  last_assigned_at timestamptz,
  prefs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_requests
  add column if not exists assigned_operator_id bigint references public.crm_operators(id),
  add column if not exists auto_assigned boolean not null default false,
  add column if not exists queued_at timestamptz,
  add column if not exists waiting_since timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists last_message_at timestamptz,
  add column if not exists overdue_pinged_at timestamptz;
create index if not exists support_requests_queue_idx on public.support_requests (queued_at) where status = 'new';
create index if not exists support_requests_assignee_idx on public.support_requests (assigned_operator_id) where status in ('allocated','awaiting');
create index if not exists support_requests_last_message_idx on public.support_requests (last_message_at desc);

alter table public.support_messages
  add column if not exists kind text not null default 'text',
  add column if not exists unsupported_type text,
  add column if not exists author_name text,
  add column if not exists response_seconds integer,
  add column if not exists delivery_status text,
  add column if not exists delivery_error text,
  add column if not exists tg_media_group_id text;
do $$ begin
  alter table public.support_messages add constraint support_messages_kind_check
    check (kind in ('text','photo','note','unsupported'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.support_messages add constraint support_messages_delivery_check
    check (delivery_status is null or delivery_status in ('pending','sent','failed'));
exception when duplicate_object then null; end $$;
create index if not exists support_messages_agent_created_idx on public.support_messages (created_at) where sender = 'agent';

alter table public.support_attachments drop constraint if exists support_attachments_message_id_key;
alter table public.support_attachments
  add column if not exists position smallint not null default 0,
  add column if not exists tg_file_id text,
  add column if not exists tg_file_unique_id text;
alter table public.support_attachments alter column content drop not null;
alter table public.support_attachments alter column size_bytes drop not null;
alter table public.support_attachments drop constraint if exists support_attachments_size_bytes_check;
do $$ begin
  alter table public.support_attachments add constraint support_attachments_size_check
    check (size_bytes is null or (size_bytes > 0 and size_bytes <= 8388608));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.support_attachments add constraint support_attachments_source_check
    check (content is not null or tg_file_id is not null);
exception when duplicate_object then null; end $$;

create table if not exists public.crm_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  operator_id bigint not null references public.crm_operators(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.crm_sso_nonces (
  jti text primary key,
  expires_at timestamptz not null
);
create table if not exists public.crm_ticket_events (
  id bigserial primary key,
  ticket_id uuid not null references public.support_requests(id) on delete cascade,
  type text not null check (type in ('created','assigned','auto_assigned','unassigned','taken_over','status_changed','reopened')),
  actor_operator_id bigint references public.crm_operators(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists crm_ticket_events_ticket_idx on public.crm_ticket_events (ticket_id, id);
create index if not exists crm_ticket_events_created_idx on public.crm_ticket_events (created_at);
create table if not exists public.crm_canned_replies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  use_count integer not null default 0,
  created_by bigint references public.crm_operators(id),
  updated_by bigint references public.crm_operators(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.crm_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.crm_settings_log (
  id bigserial primary key,
  key text not null,
  old_value jsonb,
  new_value jsonb not null,
  operator_id bigint references public.crm_operators(id),
  created_at timestamptz not null default now()
);

-- Backfill timers for tickets that are open at deploy time.
update public.support_requests set queued_at = coalesce(queued_at, created_at)
  where status = 'new' and queued_at is null;
update public.support_requests r set last_message_at = m.last_at
  from (select ticket_id, max(created_at) as last_at from public.support_messages group by ticket_id) m
  where m.ticket_id = r.id and r.last_message_at is null;
