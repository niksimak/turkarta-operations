-- Bitrix24 Открытые линии relay (docs/TZ-BITRIX-SUPPORT.md §4.1).
--
-- The connector chat id is OURS to choose, so it is derived from the ticket id
-- ("tk-<uuid>") rather than stored — an inbound event hands the same string
-- back and we parse the ticket out of it. No mapping table needed.
--
-- What DOES need storing is the id of each mirrored message, for idempotency in
-- both directions (TZ §4.4 — Bitrix retries, duplicates unacceptable):
--   * outbound: the id we sent, so our own text never returns as an "agent" reply;
--   * inbound: the operator message id already ingested.
alter table support_messages
  add column if not exists bitrix_message_id text;

create unique index if not exists support_messages_bitrix_msg_idx
  on support_messages (bitrix_message_id)
  where bitrix_message_id is not null;
