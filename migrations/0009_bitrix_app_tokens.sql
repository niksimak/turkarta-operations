-- Bitrix24 LOCAL APPLICATION credentials (docs/TZ-BITRIX-SUPPORT.md §4.1).
--
-- Why a table at all: unlike an inbound webhook (a static URL that never
-- expires), an OAuth app's access token lives ~1 hour and must be refreshed
-- with a rotating refresh token. Losing the refresh token means re-installing
-- the app by hand, so it is persisted rather than held in process memory —
-- Render restarts/redeploys the service freely.
--
-- One row per portal (`member_id`). We only ever install on one portal, but
-- keying by member_id is what Bitrix's install payload gives us and it keeps a
-- second portal (a sandbox) from silently overwriting production's tokens.

create table if not exists bitrix_app_tokens (
  member_id          text primary key,
  domain             text        not null,
  access_token       text        not null,
  refresh_token      text        not null,
  -- Absolute expiry, not a duration: a stored TTL is meaningless after a restart.
  expires_at         timestamptz not null,
  -- Sent by Bitrix on every event callback; the only proof a POST to our
  -- handler really came from Bitrix. Captured at install time.
  application_token  text,
  updated_at         timestamptz not null default now()
);

-- The registered Open Lines connector, once bootstrapped. Nullable because the
-- app installs BEFORE the connector is registered — install and register are
-- separate steps and the row exists between them.
alter table bitrix_app_tokens
  add column if not exists connector_registered_at timestamptz;
