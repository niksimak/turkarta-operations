-- Landing form also submits an email address.
alter table public.leads add column if not exists email text;
