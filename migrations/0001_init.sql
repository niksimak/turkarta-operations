-- turkarta-operations schema
-- Apply: psql "$DATABASE_URL" -f migrations/0001_init.sql
--    or paste into the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Leads: inbound from the Lovable landing page.
-- The Lovable form writes a row here; a Supabase DB Webhook on INSERT notifies
-- the service, which posts a claimable card to the ops group.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
    id            uuid primary key default gen_random_uuid(),
    name          text,
    contact       text,                       -- phone / email / @username
    message       text,
    source        text,                       -- e.g. 'lovable-landing'

    status        text not null default 'new'
                    check (status in ('new', 'allocated')),
    claimed_by    text,                        -- roster display name
    claimed_by_tg bigint,                       -- claiming teammate's tg id
    claimed_at    timestamptz,

    tg_chat_id    bigint,                       -- where the card was posted
    tg_message_id bigint,                       -- the card message (to edit on claim)

    created_at    timestamptz not null default now()
);

create index if not exists leads_status_idx on public.leads (status);

-- ---------------------------------------------------------------------------
-- Support requests: from the support bot button or the Mini App settings.
-- Drives a two-way relay between the end user and the assigned agent.
-- ---------------------------------------------------------------------------
create table if not exists public.support_requests (
    id            uuid primary key default gen_random_uuid(),
    user_tg       bigint not null,             -- end user's telegram id (relay target)
    user_username text,
    user_name     text,
    source        text,                        -- 'bot' | 'miniapp'
    first_message text,

    status        text not null default 'new'
                    check (status in ('new', 'allocated', 'resolved')),
    claimed_by    text,
    claimed_by_tg bigint,
    claimed_at    timestamptz,
    resolved_at   timestamptz,

    tg_chat_id    bigint,                       -- ops support group
    tg_message_id bigint,                       -- the ticket card
    thread_id     bigint,                       -- forum topic / message thread for the relay

    created_at    timestamptz not null default now()
);

-- One open ticket per user at a time (relay routing relies on this).
create unique index if not exists support_one_open_per_user
    on public.support_requests (user_tg)
    where status in ('new', 'allocated');

create index if not exists support_thread_idx on public.support_requests (thread_id);
create index if not exists support_status_idx on public.support_requests (status);
