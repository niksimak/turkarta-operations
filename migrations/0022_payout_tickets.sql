-- «Выплата» tickets: the main API opens one per referral or partner payout
-- request, so the operator on shift sees it and settles it, and closes it when
-- the payout is paid or rejected. They have no customer behind them (user_tg and
-- web_user_id stay null), so they never merge into anyone's support chat.
-- Idempotent: applied on every boot.

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'support_channel_check' and pg_get_constraintdef(oid) like '%payout%') then
    alter table public.support_requests drop constraint if exists support_channel_check;
    alter table public.support_requests add constraint support_channel_check
      check (channel in ('telegram', 'web', 'payout'));
  end if;
end $$;

-- One ticket per payout (the API's `referral:<id>` / `partner:<id>`), and the
-- admin-panel page that settles it.
alter table public.support_requests add column if not exists payout_key text;
alter table public.support_requests add column if not exists admin_url text;
create unique index if not exists support_requests_payout_key
  on public.support_requests (payout_key) where payout_key is not null;

-- A settled payout has no conversation for the AI reviewer: same function as
-- 0012, minus payout tickets.
create or replace function enqueue_support_agent_resolution() returns trigger language plpgsql as $$
begin
  if new.status = 'resolved' and old.status <> 'resolved' and new.channel <> 'payout' then
    insert into support_agent_jobs(ticket_id, kind, through_seq)
    select new.id, 'review', coalesce(max(seq),0) from support_messages where ticket_id = new.id
    on conflict do nothing;
  end if;
  return new;
end $$;
