-- Support tickets v2: structured intake (email/device), operator-set category,
-- and an 'awaiting' status (taken but parked, still open).

alter table public.support_requests add column if not exists email       text;
alter table public.support_requests add column if not exists device      text;
alter table public.support_requests add column if not exists category    text;
-- intake_step gates the bot's guided intake (e.g. 'email'); null = intake done.
alter table public.support_requests add column if not exists intake_step text;

-- Category is null until an operator classifies the ticket.
alter table public.support_requests drop constraint if exists support_category_check;
alter table public.support_requests add constraint support_category_check
  check (category is null or category in ('tech_issue','bug_report','feature_request'));

-- Allow the new 'awaiting' status.
alter table public.support_requests drop constraint if exists support_requests_status_check;
alter table public.support_requests add constraint support_requests_status_check
  check (status in ('new','allocated','awaiting','resolved'));

-- 'Open' tickets now include 'awaiting' (parked but unresolved) — for both the
-- one-open-per-user guarantee and relay routing.
drop index if exists support_one_open_per_user;
create unique index if not exists support_one_open_per_user
  on public.support_requests (user_tg)
  where status in ('new','allocated','awaiting');
