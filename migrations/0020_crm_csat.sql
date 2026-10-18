-- CSAT after a CRM resolve (spec 2026-10-18 §2). Applied on every boot: idempotent.
create table if not exists public.crm_csat (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_requests(id) on delete cascade,
  resolved_at timestamptz not null,
  operator_id bigint references public.crm_operators(id),
  channel text not null check (channel in ('telegram','web')),
  prompt_message_id uuid references public.support_messages(id) on delete set null,
  comment_prompt_tg_id bigint,
  rating text check (rating in ('up','down')),
  comment text check (comment is null or char_length(comment) <= 1000),
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  commented_at timestamptz,
  unique (ticket_id, resolved_at)
);
create index if not exists crm_csat_resolved_idx on public.crm_csat (resolved_at);
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'crm_ticket_events_type_check' and pg_get_constraintdef(oid) like '%csat%') then
    alter table public.crm_ticket_events drop constraint if exists crm_ticket_events_type_check;
    alter table public.crm_ticket_events add constraint crm_ticket_events_type_check
      check (type in ('created','assigned','auto_assigned','unassigned','taken_over','status_changed','reopened','topic_changed','csat'));
  end if;
end $$;
