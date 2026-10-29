-- Client videos. Telegram ones stay on Telegram (tg_file_id); web chat ones live in the Tigris bucket
-- (storage_key) so Postgres keeps no client video bytes. Both are capped at 20 MB by 0018's size check.
-- Runs on every boot like 0018: the check is replaced only while its definition lacks storage_key.
alter table public.support_attachments add column if not exists storage_key text;
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'support_attachments_source_check' and pg_get_constraintdef(oid) like '%storage_key%') then
    alter table public.support_attachments drop constraint if exists support_attachments_source_check;
    alter table public.support_attachments add constraint support_attachments_source_check
      check (content is not null or tg_file_id is not null or storage_key is not null);
  end if;
end $$;
