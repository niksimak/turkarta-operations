-- Who a web ticket's user is: a segment mark and the organization name, sent by
-- the main app when it opens the ticket. Null for legacy and telegram tickets.

alter table public.support_requests add column if not exists segment text;
alter table public.support_requests add column if not exists org_name text;
alter table public.support_requests drop constraint if exists support_segment_check;
alter table public.support_requests add constraint support_segment_check
  check (segment is null or segment in ('business_owner','business_admin','corporate_employee','partner','retail'));
create index if not exists support_requests_segment_idx
  on public.support_requests (segment) where segment is not null;
