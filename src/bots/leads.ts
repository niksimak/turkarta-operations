import { Bot } from "grammy";
import { config, memberFor, rosterIds } from "../config.js";
import * as cards from "../cards.js";
import * as db from "../db.js";
import type { Lead } from "../db.js";

export const leadsBot = new Bot(config.LEADS_BOT_TOKEN);

/** Persist + post a fresh lead card to the ops group. */
export async function postLead(
  input: Pick<Lead, "name" | "contact" | "message" | "source">,
): Promise<Lead> {
  const lead = await db.insertLead(input);
  const msg = await leadsBot.api.sendMessage(config.LEADS_CHAT_ID, cards.leadCard(lead), {
    reply_markup: cards.claimKb("leads", lead.id),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  await db.setCard("leads", lead.id, msg.chat.id, msg.message_id);
  return lead;
}

leadsBot.callbackQuery(/^claim:leads:(.+)$/, async (ctx) => {
  const id = ctx.match![1]!;
  const user = ctx.from;

  if (rosterIds.size > 0 && !rosterIds.has(user.id)) {
    return ctx.answerCallbackQuery({ text: "You're not on the ops roster.", show_alert: true });
  }

  const member = memberFor(user.id);
  const byName = member?.name ?? (user.first_name || user.username || String(user.id));

  const won = await db.claim<Lead>("leads", id, byName, user.id);
  if (!won) {
    const existing = await db.getRow<Lead>("leads", id);
    await ctx.answerCallbackQuery({
      text: `Already taken by ${existing?.claimed_by ?? "someone"}.`,
      show_alert: true,
    });
    return;
  }

  await ctx.editMessageText(cards.leadClaimedCard(won, byName), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  await ctx.answerCallbackQuery({ text: "It's yours 👍" });
});
