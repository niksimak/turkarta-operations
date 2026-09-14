import type postgres from "postgres";
import { topicGreeting, type GreetingClaim, type GreetingStore } from "./topic-greeting.js";

export class TopicGreetingStore implements GreetingStore {
  constructor(private sql: postgres.Sql) {}

  async prepare(ticketId: string, messageId: string): Promise<GreetingClaim | null> {
    return this.sql.begin(async tx => {
      // Routing and text come from persisted, authenticated intake, not caller input.
      const [row] = await tx`select r.channel,r.user_tg,m.body,m.seq from support_requests r
        join support_messages m on m.ticket_id=r.id and m.id=${messageId}
        where r.id=${ticketId} and r.status <> 'resolved' and m.sender='user'
        and m.created_at >= now() - interval '5 minutes'
        and (r.channel='web' and r.web_user_id is not null or r.channel='telegram' and r.user_tg is not null)
        for update of r`;
      if (!row) return null;
      const [history] = await tx`select exists(select 1 from support_messages
        where ticket_id=${ticketId} and ((sender='user' and seq<${row.seq})
          or (sender='agent' and actor_type in ('human','unknown')))) as skip`;
      if (history?.skip) return null;
      const greeting = topicGreeting(String(row.body));
      const [claimed] = await tx`insert into support_topic_greetings
        (ticket_id,customer_message_id,topic,body,status)
        values(${ticketId},${messageId},${greeting.topic},${greeting.text},'sending')
        on conflict(ticket_id) do nothing returning ticket_id`;
      if (!claimed) return null;
      if (row.channel === 'web') {
        const [message] = await tx`insert into support_messages
          (ticket_id,sender,body,actor_type,author_id,source_message_id)
          values(${ticketId},'agent',${greeting.text},'automation','support:topic-greeting',${`topic-greeting:${ticketId}`}) returning id`;
        await tx`update support_topic_greetings set status='sent',external_message_id=${String(message!.id)},finished_at=now()
          where ticket_id=${ticketId}`;
      }
      return { ticketId, channel: row.channel, userTg: row.user_tg == null ? null : Number(row.user_tg), ...greeting } as GreetingClaim;
    }) as Promise<GreetingClaim | null>;
  }

  async delivered(ticketId: string, externalId: string) {
    await this.sql.begin(async tx => {
      const [row] = await tx`update support_topic_greetings set status='sent',external_message_id=${externalId},finished_at=now()
        where ticket_id=${ticketId} and status='sending' returning body`;
      if (!row) return;
      await tx`insert into support_messages(ticket_id,sender,body,actor_type,author_id,source_message_id)
        values(${ticketId},'agent',${row.body},'automation','support:topic-greeting',${`topic-greeting:${ticketId}`})
        on conflict(source_message_id) where source_message_id is not null do nothing`;
    });
  }

  async failed(ticketId: string, outcome: "failed" | "unknown") {
    await this.sql`update support_topic_greetings set status=${outcome},finished_at=now()
      where ticket_id=${ticketId} and status='sending'`;
  }
}
