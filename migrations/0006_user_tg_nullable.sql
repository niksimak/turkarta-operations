-- Web-channel tickets are keyed by web_user_id and have no telegram id.
alter table public.support_requests alter column user_tg drop not null;
