import { describe, expect, it } from "vitest";
import { eventText } from "./Thread";
import type { TicketEventRow } from "../lib/tickets";

const ev = (payload: Record<string, unknown>): TicketEventRow =>
  ({ id: 1, type: "topic_changed", actor_name: null, payload, created_at: "2026-10-18T10:00:00Z" }) as TicketEventRow;

describe("topic_changed in the timeline", () => {
  it("names the topic and who chose it", () => {
    expect(eventText(ev({ from: null, to: "Карта отклонена", source: "ai" }))).toBe("Тема (ИИ): Карта отклонена");
    expect(eventText(ev({ from: "Карта отклонена", to: "KYC/верификация", source: "operator" }))).toBe("Тема: KYC/верификация");
    expect(eventText(ev({ from: "KYC/верификация", to: null, source: "operator" }))).toBe("Тема снята");
  });
});
