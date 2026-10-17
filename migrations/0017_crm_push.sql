-- Web Push subscriptions of CRM operators (PWA). One row per browser/device; the
-- endpoint is the push service URL that browser handed out. Boot applies it (db.ts).
create table if not exists public.crm_push_subscriptions (
  id bigserial primary key,
  operator_id bigint not null references public.crm_operators(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0
);
create index if not exists crm_push_subscriptions_operator_idx on public.crm_push_subscriptions (operator_id);
