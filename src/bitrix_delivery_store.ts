import { readFile } from "node:fs/promises";
import { sql } from "./db.js";

export interface ReceiptInput {
  bitrix_message_id: string;
  support_message_id: string;
  connector: string;
  line: number;
  im_chat_id: string;
  im_message_id: string;
  chat_id: string;
}

export interface DeliveryReceipt extends ReceiptInput {
  external_message_id: string;
  delivered_at: Date;
  attempts: number;
}

export async function ensureDeliverySchema(): Promise<void> {
  await sql.unsafe(await readFile(new URL("../migrations/0014_bitrix_delivery_receipts.sql", import.meta.url), "utf8"));
}

// Save routing before sending. A row alone is NOT evidence of delivery.
export async function prepareReceipt(input: ReceiptInput): Promise<void> {
  await sql`insert into bitrix_delivery_receipts ${sql(input)}
    on conflict (bitrix_message_id) do nothing`;
}

export async function recordDelivery(id: string, externalId: string): Promise<void> {
  await sql`update bitrix_delivery_receipts
    set external_message_id = ${externalId}, delivered_at = now(), next_attempt_at = now()
    where bitrix_message_id = ${id} and delivered_at is null`;
}

// A short lease permits recovery after a restart and prevents two workers
// claiming the same receipt during a rolling deployment.
export async function claimReceipt(): Promise<DeliveryReceipt | null> {
  const [row] = await sql<DeliveryReceipt[]>`
    with candidate as (
      select bitrix_message_id from bitrix_delivery_receipts
      where delivered_at is not null and confirmed_at is null and next_attempt_at <= now()
      order by next_attempt_at limit 1 for update skip locked
    )
    update bitrix_delivery_receipts r
    set next_attempt_at = now() + interval '2 minutes', attempts = attempts + 1
    from candidate c where r.bitrix_message_id = c.bitrix_message_id returning r.*`;
  return row ?? null;
}

export async function confirmReceipt(id: string): Promise<void> {
  await sql`update bitrix_delivery_receipts set confirmed_at = now()
    where bitrix_message_id = ${id}`;
}

export async function retryReceipt(id: string, attempts: number): Promise<void> {
  const seconds = Math.min(3600, 15 * 2 ** Math.min(attempts, 8));
  await sql`update bitrix_delivery_receipts
    set next_attempt_at = now() + ${seconds} * interval '1 second'
    where bitrix_message_id = ${id} and confirmed_at is null`;
}
