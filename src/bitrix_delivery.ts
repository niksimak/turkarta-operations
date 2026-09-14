import * as bitrixApp from "./bitrix_app.js";
import * as store from "./bitrix_delivery_store.js";

/** Confirm transport delivery, not customer readership. Bitrix controls how
 * this is displayed. Its delivery endpoint requires BOTH internal IM ids. */
export async function sendDeliveryConfirmation(receipt: store.DeliveryReceipt): Promise<void> {
  const result = await bitrixApp.call<{ SUCCESS?: boolean }>("imconnector.send.status.delivery", {
    CONNECTOR: receipt.connector,
    LINE: receipt.line,
    MESSAGES: [{
      im: { chat_id: receipt.im_chat_id, message_id: receipt.im_message_id },
      message: {
        id: [receipt.external_message_id],
        date: Math.floor(new Date(receipt.delivered_at).getTime() / 1000),
      },
      chat: { id: receipt.chat_id },
    }],
  });
  if (result?.SUCCESS !== true) throw new Error("Bitrix rejected delivery confirmation");
}

let running: Promise<void> | null = null;

/** Only receipts for proven deliveries are retried; this never sends a DM. */
export function flushDeliveryConfirmations(): Promise<void> {
  running ??= (async () => {
    for (let i = 0; i < 10; i++) {
      const receipt = await store.claimReceipt();
      if (!receipt) break;
      try {
        await sendDeliveryConfirmation(receipt);
        await store.confirmReceipt(receipt.bitrix_message_id);
        console.log(`[bitrix-ol] delivery confirmed msg=${receipt.bitrix_message_id}`);
      } catch (err) {
        await store.retryReceipt(receipt.bitrix_message_id, receipt.attempts);
        const code = err instanceof bitrixApp.BitrixAppError ? err.code : "transport_or_rejected";
        console.warn(`[bitrix-ol] delivery confirmation pending msg=${receipt.bitrix_message_id} attempt=${receipt.attempts} code=${code}`);
      }
    }
  })().catch(() => {
    console.warn("[bitrix-ol] delivery confirmation worker failed; persisted receipts will retry");
  }).finally(() => { running = null; });
  return running;
}

export function startDeliveryConfirmations(): () => void {
  void flushDeliveryConfirmations();
  const timer = setInterval(() => void flushDeliveryConfirmations(), 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
