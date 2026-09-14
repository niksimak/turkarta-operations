create table if not exists support_topic_greetings (
  ticket_id uuid primary key references support_requests(id) on delete cascade,
  customer_message_id uuid not null references support_messages(id) on delete cascade,
  topic text not null,
  body text not null,
  status text not null check (status in ('sending','sent','failed','unknown')),
  external_message_id text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
