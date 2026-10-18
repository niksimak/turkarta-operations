-- Contact reasons (spec 2026-10-18 §1). Applied on every boot: every statement is idempotent.
create table if not exists public.crm_topics (
  id serial primary key,
  name text not null,
  position integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists crm_topics_name_key on public.crm_topics (lower(name));

-- Seed once: only into an empty table, so renames and archives survive every boot.
insert into public.crm_topics (name, position)
select v.name, v.position from (values
  ('Пополнение не пришло', 1), ('Карта отклонена', 2), ('Выпуск карты', 3), ('KYC/верификация', 4),
  ('Antarctic', 5), ('Вывод/возврат', 6), ('Тарифы и цены', 7), ('Как пользоваться', 8),
  ('Жалоба', 9), ('Другое', 10)) as v(name, position)
where not exists (select 1 from public.crm_topics);

alter table public.support_requests add column if not exists topic_id integer references public.crm_topics(id);
alter table public.support_requests add column if not exists topic_source text;
alter table public.support_requests add column if not exists topic_set_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'support_requests_topic_source_check') then
    alter table public.support_requests add constraint support_requests_topic_source_check
      check (topic_source is null or topic_source in ('ai','operator'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'crm_ticket_events_type_check' and pg_get_constraintdef(oid) like '%topic_changed%') then
    alter table public.crm_ticket_events drop constraint if exists crm_ticket_events_type_check;
    alter table public.crm_ticket_events add constraint crm_ticket_events_type_check
      check (type in ('created','assigned','auto_assigned','unassigned','taken_over','status_changed','reopened','topic_changed'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'support_agent_jobs_kind_check' and pg_get_constraintdef(oid) like '%topic%') then
    alter table public.support_agent_jobs drop constraint if exists support_agent_jobs_kind_check;
    alter table public.support_agent_jobs add constraint support_agent_jobs_kind_check
      check (kind in ('triage','review','topic'));
  end if;
end $$;
create index if not exists support_requests_topic_idx on public.support_requests (topic_id) where topic_id is not null;
