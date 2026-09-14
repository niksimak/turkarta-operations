import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";

// Explicit opt-in, disposable local DB only. Never load production .env.
const url = process.env.BITRIX_DELIVERY_TEST_DATABASE_URL;
test("receipt SQL: additive schema, concurrent claims, durable retries, and no false deliveries", { skip: !url }, async () => {
  const parsed = new URL(url!);
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/bitrix_delivery_test");
  Object.assign(process.env, {
    DATABASE_URL: url, LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
    LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002", ROSTER: "[]",
    PUBLIC_BASE_URL: "https://ops.example", LEADS_WEBHOOK_SECRET: "test", TELEGRAM_WEBHOOK_SECRET: "test",
  });
  const setup = postgres(url!, { max: 1 });
  const db = await import("../dist/db.js");
  const store = await import("../dist/bitrix_delivery_store.js");
  try {
    await setup`drop table if exists bitrix_delivery_receipts`;
    await setup`create table if not exists support_messages (id uuid primary key)`;
    const messageId = "00000000-0000-0000-0000-000000000001";
    await setup`insert into support_messages values (${messageId}) on conflict do nothing`;
    await store.ensureDeliverySchema();
    await store.ensureDeliverySchema();
    const input = {
      bitrix_message_id: "ol-101", support_message_id: messageId,
      connector: "turkarta_support", line: 5, im_chat_id: "99", im_message_id: "101", chat_id: "tk-ticket-1",
    };
    await store.prepareReceipt(input);
    await store.prepareReceipt(input);
    assert.equal(await store.claimReceipt(), null, "prepared/failed sends must not be confirmed");
    await store.recordDelivery("ol-101", "777");
    const claims = await Promise.all([store.claimReceipt(), store.claimReceipt()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const receipt = claims.find(Boolean)!;
    assert.equal(receipt.external_message_id, "777");
    assert.equal(receipt.attempts, 1);
    assert.equal(await store.claimReceipt(), null, "lease excludes concurrent retry");
    await store.retryReceipt("ol-101", receipt.attempts);
    assert.equal(await store.claimReceipt(), null, "backoff is persisted");
    // A new connection sees the delivery after the worker restarts.
    const [persisted] = await setup`select * from bitrix_delivery_receipts`;
    assert.ok(persisted!.delivered_at);
    await setup`update bitrix_delivery_receipts set next_attempt_at = now() - interval '1 second'`;
    assert.equal((await store.claimReceipt())!.attempts, 2);
    await store.confirmReceipt("ol-101");
    assert.equal(await store.claimReceipt(), null);
    await setup`delete from support_messages where id = ${messageId}`;
    const [{ count }] = await setup`select count(*)::int as count from bitrix_delivery_receipts`;
    assert.equal(count, 0, "receipts must not block existing message deletion");
  } finally {
    await db.sql.end();
    await setup.end();
  }
});
