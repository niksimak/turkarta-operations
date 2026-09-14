import * as db from "./db.js";
import * as store from "./bitrix_delivery_store.js";
import { supportBot } from "./bots/support.js";
import * as turkartaApi from "./turkarta_api.js";

export async function deliverOperatorReply(
  ticket: db.Ticket,
  text: string,
  receipt: Omit<store.ReceiptInput, "support_message_id">,
): Promise<"delivered" | "failed" | "duplicate"> {
  const stored = await db.addAgentMessageFromBitrix(ticket.id, text, receipt.bitrix_message_id);
  // An earlier insert might precede a failed/ambiguous send. Never infer
  // delivery from dedup, and never resend on a Bitrix webhook retry.
  if (!stored) return "duplicate";
  await store.prepareReceipt({ ...receipt, support_message_id: stored.id });

  let externalId: string;
  if (ticket.channel === "telegram" && ticket.user_tg != null) {
    try {
      const sent = await supportBot.api.sendMessage(ticket.user_tg, text);
      externalId = String(sent.message_id);
    } catch (err) {
      // Log API status without customer IDs, message contents, or bot tokens.
      const code = (err as { error_code?: number })?.error_code ?? "transport";
      console.warn(`[bitrix-ol] operator delivery failed msg=${receipt.bitrix_message_id} code=${code}`);
      return "failed";
    }
  } else if (ticket.channel === "web" && ticket.web_user_id) {
    // The persisted message is available to inbox polling; push is optional.
    externalId = stored.id;
  } else {
    console.warn(`[bitrix-ol] operator delivery failed msg=${receipt.bitrix_message_id} code=no_route`);
    return "failed";
  }

  await store.recordDelivery(receipt.bitrix_message_id, externalId);
  if (ticket.channel === "web" && ticket.web_user_id) {
    await turkartaApi.notifySupportReply({
      web_user_id: ticket.web_user_id, ticket_id: ticket.id,
      message_id: stored.id, preview: text,
    }).catch(() => console.warn("[bitrix-ol] optional reply notification failed"));
  }
  return "delivered";
}
