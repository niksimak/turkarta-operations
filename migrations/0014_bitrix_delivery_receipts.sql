-- Additive; no historical replies are assumed delivered or resent.
create table if not exists public.bitrix_delivery_receipts (
  bitrix_message_id text primary key,
  support_message_id uuid not null references public.support_messages(id),
  connector text not null,
  line integer not null,
  im_chat_id text not null,
  im_message_id text not null,
  chat_id text not null,
  external_message_id text,
  delivered_at timestamptz,
  confirmed_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now()
);
create index if not exists bitrix_delivery_receipts_pending_idx
  on public.bitrix_delivery_receipts(next_attempt_at)
  where delivered_at is not null and confirmed_at is null;
