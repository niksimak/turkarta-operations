import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { formatDuration, formatPercent } from "../lib/stats";
import { TopicStatsTable } from "./TopicStatsTable";

// Testing Library normalizes NBSP in the DOM to a space but not in the matcher string.
const norm = (s: string) => s.replace(/ /g, " ");

describe("TopicStatsTable", () => {
  afterEach(cleanup);

  it("lists topics with count, change vs the previous period, share and resolution time", () => {
    render(<TopicStatsTable rows={[
      { topic_id: 1, name: "Пополнение не пришло", resolved: 3, prev_resolved: 1, share_pct: 60, resolution_median_s: 600, csat_pct: 90, csat_answers: 8 },
      { topic_id: 2, name: "Карта отклонена", resolved: 1, prev_resolved: 2, share_pct: 20, resolution_median_s: null, csat_pct: null, csat_answers: 0 },
      { topic_id: null, name: "Без темы", resolved: 1, prev_resolved: 1, share_pct: 20, resolution_median_s: 600, csat_pct: 100, csat_answers: 2 },
    ]} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Пополнение не пришло")).toBeTruthy();
    expect(within(rows[0]!).getByText("+2")).toBeTruthy();
    expect(within(rows[0]!).getByText(norm(formatPercent(60)))).toBeTruthy();
    expect(within(rows[0]!).getByText(norm(formatDuration(600)))).toBeTruthy();
    expect(within(rows[1]!).getByText("−1")).toBeTruthy();
    expect(within(rows[1]!).getByText("нет")).toBeTruthy();
    expect(within(rows[2]!).getByText("0")).toBeTruthy();
    expect(within(rows[0]!).getByText(norm(formatPercent(90)))).toBeTruthy();
    expect(within(rows[1]!).getByText("нет оценок")).toBeTruthy();
    expect(within(rows[2]!).getByText("мало оценок (2)")).toBeTruthy();
  });

  it("says so when nothing was resolved", () => {
    render(<TopicStatsTable rows={[]} />);
    expect(screen.getByText("За период решённых обращений нет.")).toBeTruthy();
  });
});
