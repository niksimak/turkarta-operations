-- Durable support-chat photos. The byte payload lives beside the message so
-- Bitrix never depends on a Telegram CDN URL and web users can reopen history.
create table if not exists public.support_attachments (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null unique references public.support_messages(id) on delete cascade,
  media_type  text not null check (media_type in ('image/jpeg', 'image/png', 'image/webp')),
  filename    text not null,
  size_bytes  integer not null check (size_bytes > 0 and size_bytes <= 8388608),
  content     bytea not null,
  created_at  timestamptz not null default now()
);

create index if not exists support_attachments_message_idx
  on public.support_attachments (message_id);
