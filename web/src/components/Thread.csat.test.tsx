import { describe, expect, it } from "vitest";
import { eventText } from "./Thread";
import type { TicketEventRow } from "../lib/tickets";

const ev = (payload: Record<string, unknown>): TicketEventRow =>
  ({ id: 1, type: "csat", actor_name: null, payload, created_at: "2026-10-18T10:00:00Z" }) as TicketEventRow;

describe("csat in the timeline", () => {
  it("shows the rating and the comment", () => {
    expect(eventText(ev({ rating: "up" }))).toBe("Клиент оценил: 👍");
    expect(eventText(ev({ rating: "down" }))).toBe("Клиент оценил: 👎");
    expect(eventText(ev({ rating: "down", comment: "Долго ждал" }))).toBe("Комментарий клиента: Долго ждал");
  });
});
