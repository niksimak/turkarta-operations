-- Web support channel: tickets not tied to a Telegram user (standalone PWA users).
-- Operator replies to these route to a stored message log the web app polls,
-- instead of a Telegram DM.

alter table public.support_requests
  add column if not exists channel text not null default 'telegram';
alter table public.support_requests drop constraint if exists support_channel_check;
alter table public.support_requests add constraint support_channel_check
  check (channel in ('telegram', 'web'));

-- Web users are identified by the main app's user.id (no telegram id).
alter table public.support_requests add column if not exists web_user_id text;

-- One open ticket per web user (mirrors the per-tg index; web rows have null user_tg).
drop index if exists support_one_open_per_web_user;
create unique index if not exists support_one_open_per_web_user
  on public.support_requests (web_user_id)
  where web_user_id is not null and status in ('new', 'allocated', 'awaiting');

-- Durable conversation log. Web channel needs full history for polling/reload;
-- telegram tickets keep using the live relay and don't write here.
create table if not exists public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.support_requests(id) on delete cascade,
  sender     text not null check (sender in ('user', 'agent', 'system')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx
  on public.support_messages (ticket_id, created_at);
