import { beforeEach, describe, expect, it } from "vitest";
import {
  addOutgoing,
  bindServerId,
  confirmOutgoing,
  dropOutgoing,
  messageKey,
  newClientKey,
  releaseKeys,
  removeOutgoing,
  resetOutboxForTests,
  withOutbox,
} from "./outbox";
import type { CrmMessage, TicketDetail } from "./tickets";

const msg = (over: Partial<CrmMessage>): CrmMessage => ({
  id: "m1",
  sender: "user",
  kind: "text",
  body: "Привет",
  unsupported_type: null,
  author_name: null,
  created_at: "2026-10-16T12:00:00Z",
  delivery_status: null,
  delivery_error: null,
  attachments: [],
  ...over,
});

const detail = (messages: CrmMessage[]): TicketDetail => ({
  ticket: {} as TicketDetail["ticket"],
  messages,
  events: [],
  user: null,
  viewers: [],
});

describe("outbox", () => {
  beforeEach(() => resetOutboxForTests());

  const userMsg = msg({ id: "m1" });
  const key = () => newClientKey();
  const mine = (id: string, over: Partial<CrmMessage> = {}) =>
    msg({ id, sender: "agent", body: "Проверьте спам", author_name: "Аня", delivery_status: "pending", ...over });

  it("keeps the optimistic message through a refetch that does not have it yet", () => {
    const k = key();
    addOutgoing("t1", mine(k), ["m1"]);
    const d = withOutbox("t1", detail([userMsg]));
    expect(d.messages.map((m) => m.id)).toEqual(["m1", k]);
    expect(withOutbox("t2", detail([userMsg])).messages).toHaveLength(1);
  });

  it("lets a refetched server copy take the optimistic key before the POST returns", () => {
    const k = key();
    addOutgoing("t1", mine(k), ["m1"]);
    const server = mine("srv1", { delivery_status: "sent" });
    const d = withOutbox("t1", detail([userMsg, server]));
    expect(d.messages.map((m) => m.id)).toEqual(["m1", "srv1"]);
    expect(messageKey(server)).toBe(k);
  });

  it("never mistakes an older identical message for the copy", () => {
    const k = key();
    const older = mine("old", { delivery_status: "sent" });
    addOutgoing("t1", mine(k), ["m1", "old"]);
    const d = withOutbox("t1", detail([userMsg, older]));
    expect(d.messages.map((m) => m.id)).toEqual(["m1", "old", k]);
    expect(messageKey(older)).toBe("old");
  });

  it("replaces the optimistic row with the server message under the same key", () => {
    const k = key();
    addOutgoing("t1", mine(k), ["m1"]);
    const server = mine("srv1", { delivery_status: "sent" });
    bindServerId(k, server.id);
    const d = confirmOutgoing(withOutbox("t1", detail([userMsg])), k, server);
    expect(d.messages.map((m) => m.id)).toEqual(["m1", "srv1"]);
    expect(d.messages[1]!.delivery_status).toBe("sent");
    expect(messageKey(d.messages[1]!)).toBe(k);
    removeOutgoing(k);
    expect(withOutbox("t1", detail([userMsg, server])).messages).toHaveLength(2);
  });

  it("drops the optimistic row on failure", () => {
    const k = key();
    addOutgoing("t1", mine(k), []);
    expect(dropOutgoing(withOutbox("t1", detail([userMsg])), k).messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("forgets a closed thread's key mappings once nothing for it is in flight", () => {
    const k = key();
    addOutgoing("t1", mine(k), ["m1"]);
    const server = mine("srv1", { delivery_status: "sent" });
    bindServerId(k, server.id);
    removeOutgoing(k);
    expect(messageKey(server)).toBe(k);
    releaseKeys("t2");
    expect(messageKey(server)).toBe(k);
    releaseKeys("t1");
    expect(messageKey(server)).toBe("srv1");
  });

  it("keeps the mapping of a send still in flight", () => {
    const k = key();
    addOutgoing("t1", mine(k), ["m1"]);
    bindServerId(k, "srv1");
    releaseKeys("t1");
    expect(messageKey(mine("srv1"))).toBe(k);
  });
});
