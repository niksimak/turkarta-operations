import type { CrmMessage, TicketDetail } from "./tickets";

// Messages the operator sent that the server has not confirmed yet. They live
// here as well as in the query cache, so a refetch (SSE fires message.created
// before the POST returns) cannot drop them, and the server copy can take over
// the optimistic row's key: the enter motion plays once.

interface Outgoing {
  ticketId: string;
  message: CrmMessage;
  /** Message ids in the thread when this one was sent: none of them can be its server copy. */
  knownIds: Set<string>;
  serverId?: string;
}

const outgoing = new Map<string, Outgoing>();
const keyByServerId = new Map<string, { key: string; ticketId: string }>();
let seq = 0;

export function newClientKey(): string {
  seq += 1;
  return `local-${Date.now().toString(36)}-${seq}`;
}

/** Stable render key: the optimistic row and its server copy share it. */
export function messageKey(m: CrmMessage): string {
  return keyByServerId.get(m.id)?.key ?? m.id;
}

export function addOutgoing(ticketId: string, message: CrmMessage, knownIds: Iterable<string>): void {
  outgoing.set(message.id, { ticketId, message, knownIds: new Set(knownIds) });
}

export function bindServerId(clientKey: string, serverId: string): void {
  const o = outgoing.get(clientKey);
  if (!o) return;
  keyByServerId.set(serverId, { key: clientKey, ticketId: o.ticketId });
  o.serverId = serverId;
}

/**
 * Called when a thread closes: its rows unmount, so the next open keys them by
 * server id from the start. A send still in flight keeps its mapping.
 */
export function releaseKeys(ticketId: string): void {
  for (const [serverId, k] of keyByServerId) {
    if (k.ticketId === ticketId && !outgoing.has(k.key)) keyByServerId.delete(serverId);
  }
}

export function removeOutgoing(clientKey: string): void {
  outgoing.delete(clientKey);
}

export function resetOutboxForTests(): void {
  outgoing.clear();
  keyByServerId.clear();
  seq = 0;
}

function isServerCopy(s: CrmMessage, o: Outgoing): boolean {
  const m = o.message;
  return (
    s.sender === "agent" &&
    !o.knownIds.has(s.id) &&
    !keyByServerId.has(s.id) &&
    s.author_name === m.author_name &&
    (s.kind === "note") === (m.kind === "note") &&
    s.body === m.body &&
    s.attachments.length === m.attachments.length
  );
}

/** Adds the unconfirmed messages to a server snapshot, or lets their server copy stand in. */
export function withOutbox(ticketId: string, detail: TicketDetail): TicketDetail {
  let messages = detail.messages;
  for (const o of outgoing.values()) {
    if (o.ticketId !== ticketId) continue;
    if (messages.some((s) => s.id === o.message.id || (o.serverId !== undefined && s.id === o.serverId))) continue;
    const copy = messages.find((s) => isServerCopy(s, o));
    if (copy) {
      bindServerId(o.message.id, copy.id);
      continue;
    }
    messages = [...messages, o.message];
  }
  return messages === detail.messages ? detail : { ...detail, messages };
}

/** The server answered: its message replaces the optimistic one in place. */
export function confirmOutgoing(detail: TicketDetail, clientKey: string, server: CrmMessage): TicketDetail {
  const hasServer = detail.messages.some((m) => m.id === server.id);
  const rest = hasServer ? detail.messages.filter((m) => m.id !== clientKey) : detail.messages;
  let placed = false;
  const messages = rest.map((m) => {
    if (m.id !== server.id && m.id !== clientKey) return m;
    placed = true;
    return server;
  });
  return { ...detail, messages: placed ? messages : [...messages, server] };
}

export function dropOutgoing(detail: TicketDetail, clientKey: string): TicketDetail {
  return { ...detail, messages: detail.messages.filter((m) => m.id !== clientKey) };
}
