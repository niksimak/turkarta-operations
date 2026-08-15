-- Preserve a photo sent as the first support message while the bot collects
-- the user's email. The photo is relayed to Bitrix after intake completes.
alter table public.support_requests
  add column if not exists first_photo_file_id text;
