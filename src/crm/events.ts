import { sql } from "../db.js";

export type PresenceState = "viewing" | "typing";
export type Viewer = { operatorId: number; name: string; state: PresenceState };

export type CrmEvent =
  | { type: "ticket.created" | "ticket.updated"; ticketId: string }
  | { type: "message.created"; ticketId: string; messageId?: string }
  | { type: "operator.updated"; operatorId: number }
  | { type: "presence"; ticketId: string; viewers: Viewer[] }
  | { type: "notify"; operatorId: number | null; kind: "new_ticket" | "assigned" | "mention" | "user_replied"; ticketId: string; title: string; body: string };

const CHANNEL = "crm_events";
const PRESENCE_TTL_MS = 10_000;
const NOTIFY_BODY_MAX = 140;
const NOTIFY_PAYLOAD_MAX = 7500; // Postgres NOTIFY limit is 8000 bytes

const subscribers = new Set<(e: CrmEvent) => void>();

export function subscribe(fn: (e: CrmEvent) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function dispatch(e: CrmEvent): void {
  for (const fn of [...subscribers]) {
    try { fn(e); } catch (err) { console.error("crm event subscriber failed", (err as { code?: string }).code ?? "error"); }
  }
}

/** Never throws: a failed NOTIFY must not fail the user's support message. */
export async function publish(event: CrmEvent): Promise<void> {
  try {
    const e = event.type === "notify" ? { ...event, body: event.body.slice(0, NOTIFY_BODY_MAX) } : event;
    const payload = JSON.stringify(e);
    if (Buffer.byteLength(payload) > NOTIFY_PAYLOAD_MAX) throw Object.assign(new Error("payload too large"), { code: "payload_too_large" });
    await sql.notify(CHANNEL, payload);
  } catch (err) {
    console.error("crm publish failed", event.type, (err as { code?: string }).code ?? "error");
  }
}

export async function startEventHub(): Promise<() => Promise<void>> {
  const sub = await sql.listen(CHANNEL, (payload) => {
    try { dispatch(JSON.parse(payload) as CrmEvent); } catch { console.error("crm event parse failed"); }
  });
  return async () => { await sub.unlisten(); };
}

const viewersByTicket = new Map<string, Map<number, Viewer & { at: number }>>();

function live(ticketId: string, now: number): Viewer[] {
  const m = viewersByTicket.get(ticketId);
  if (!m) return [];
  for (const [id, v] of m) if (now - v.at > PRESENCE_TTL_MS) m.delete(id);
  if (m.size === 0) viewersByTicket.delete(ticketId);
  return [...m.values()].map(({ operatorId, name, state }) => ({ operatorId, name, state }))
    .sort((a, b) => a.operatorId - b.operatorId);
}

export const presence = {
  set(ticketId: string, operator: { id: number; name: string }, state: PresenceState, now = Date.now()): void {
    let m = viewersByTicket.get(ticketId);
    if (!m) viewersByTicket.set(ticketId, (m = new Map()));
    m.set(operator.id, { operatorId: operator.id, name: operator.name, state, at: now });
    dispatch({ type: "presence", ticketId, viewers: live(ticketId, now) });
  },
  list(ticketId: string, now = Date.now()): Viewer[] {
    return live(ticketId, now);
  },
};
