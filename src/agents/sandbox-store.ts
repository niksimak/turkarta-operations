import { sql } from "../db.js";

// This source cannot be chosen by a caller, and no real account ID is accepted.
const SOURCE = "support-ai-dev";

export const sandboxStore = {
  async create(text: string): Promise<string> {
    return sql.begin(async tx => {
      const [ticket] = await tx`insert into support_requests
        (channel, web_user_id, user_name, source, first_message)
        values ('web', gen_random_uuid(), 'Dev sandbox', ${SOURCE}, ${text}) returning id`;
      await tx`insert into support_messages (ticket_id, sender, body, actor_type, author_id)
        values (${ticket!.id}, 'user', ${text}, 'customer', 'sandbox:customer')`;
      return String(ticket!.id);
    });
  },
  async append(id: string, actor: "customer" | "human", text: string): Promise<boolean> {
    return sql.begin(async tx => {
      const [ticket] = await tx`select id from support_requests where id=${id} and source=${SOURCE} for update`;
      if (!ticket) return false;
      await tx`insert into support_messages (ticket_id, sender, body, actor_type, author_id)
        values (${id}, ${actor === "customer" ? "user" : "agent"}, ${text}, ${actor}, ${`sandbox:${actor}`})`;
      return true;
    });
  },
};
