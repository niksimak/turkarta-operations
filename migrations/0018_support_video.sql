-- Operator video replies (one per message, at most 20 MB; photos keep 8 MB).
-- Upgrades three checks in place under their existing names. Each block runs once: it compares the
-- current definition first, and 0016 (re-applied on every boot) only adds these names when missing,
-- so the boot run never puts the photo-only versions back.
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'support_messages_kind_check' and pg_get_constraintdef(oid) like '%video%') then
    alter table public.support_messages drop constraint if exists support_messages_kind_check;
    alter table public.support_messages add constraint support_messages_kind_check
      check (kind in ('text','photo','video','note','unsupported'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'support_attachments_media_type_check' and pg_get_constraintdef(oid) like '%video%') then
    alter table public.support_attachments drop constraint if exists support_attachments_media_type_check;
    alter table public.support_attachments add constraint support_attachments_media_type_check
      check (media_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'support_attachments_size_check' and pg_get_constraintdef(oid) like '%20971520%') then
    alter table public.support_attachments drop constraint if exists support_attachments_size_check;
    alter table public.support_attachments add constraint support_attachments_size_check
      check (size_bytes is null or (size_bytes > 0 and size_bytes <=
        case when media_type like 'video/%' then 20971520 else 8388608 end));
  end if;
end $$;
