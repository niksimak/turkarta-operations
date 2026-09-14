# Bitrix delivery confirmations

Operator replies now distinguish persisted messages, transport delivery, and
Bitrix's acknowledgement. Telegram acceptance records its message ID; web
delivery records the inbox message ID (push notification is best effort).
Only proven deliveries call `imconnector.send.status.delivery`, with the
original internal IM identifiers and external chat/message identifiers.

Confirmed sends persist in `bitrix_delivery_receipts`. Unconfirmed receipts
retry with backoff, up to hourly, while the process is running. Startup and
operator webhooks also trigger the worker. A two-minute database lease prevents
concurrent workers from claiming the same receipt and expires after a crash.
Confirmation retries never send customer messages. Telegram failures are logged
and counted as failures. Duplicate webhooks do not imply delivery.

Old replies have no reliable transport receipts and are not backfilled or
resent. A crash between Telegram accepting a message and persisting its receipt
remains ambiguous; it is not automatically acknowledged or resent.

## Validation

`pnpm test` builds and tests the real webhook route with mocked external
boundaries: successful Telegram delivery, genuine rejection, duplicate and
legacy events, Bitrix timeout/rejection, concurrent flushes, web delivery with
failed push, and invalid routing/IM identifiers.

For the database test, create a disposable local database named
`bitrix_delivery_test`, then run:

```sh
BITRIX_DELIVERY_TEST_DATABASE_URL=postgres://localhost:55439/bitrix_delivery_test pnpm test
```

The test refuses nonlocal hosts or another database name. It recreates the
receipt table in that test database and exercises the real migration, leases,
backoff, persistence, and confirmation exclusion.

## Production deployment and rollback

Target: Render `turkarta-operations`, `srv-d90g7t4m0tmc73dpi000`.
Baseline: `9c20231e3f13512e343ffe7b7ae721de2b9f7cfe` (September 12, 2026).
Startup applies the additive `0014_bitrix_delivery_receipts.sql` migration
before accepting traffic. No environment changes or changes to card/payment
services are required.

After deploying, verify `/health`, startup logs, and the first organic
`delivery confirmed msg=...` entries. `delivery confirmation pending` indicates
a persisted retry; its `code` identifies a Bitrix API error where available.
`operator delivery failed` records real transport/routing failures.

Rollback, if necessary:

```sh
render deploys create srv-d90g7t4m0tmc73dpi000 --commit 9c20231e3f13512e343ffe7b7ae721de2b9f7cfe --confirm --output json
```

Leave the additive table in place on rollback. The previous service ignores it;
pending receipts can resume when the fix is redeployed. No historical customer
messages need to be replayed.

Reference: https://apidocs.bitrix24.com/api-reference/imopenlines/imconnector/imconnector-send-status-delivery.html
