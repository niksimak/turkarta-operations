-- Expand leads with structured contact fields from the landing form.
-- 'contact' stays as a generic fallback for legacy/freeform submissions.
alter table public.leads add column if not exists company     text;
alter table public.leads add column if not exists phone       text;
alter table public.leads add column if not exists tg_username text;
