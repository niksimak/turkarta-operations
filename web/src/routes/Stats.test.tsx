import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../app";
import { resetApiStateForTests } from "../lib/api";
import { formatNumber } from "../lib/format";
import { formatDuration, formatPercent } from "../lib/stats";
import { jsonResponse } from "../test/fakes";
import { Stats } from "./Stats";

// Testing Library collapses NBSP in DOM text but not in matcher strings.
const norm = (s: string) => s.replace(/\u00a0/g, " ");

const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" };
const admin = {
  id: 1, name: "Аня", email: null, role: "admin", is_lead: false, auto_assign_enabled: true,
  on_shift: true, last_active_at: null, last_assigned_at: null, prefs,
};
const op = {
  operator_id: 1, name: "Аня", taken: 1, auto_assigned: 0, resolved: 2, replies: 2,
  response_median_s: 60, response_p90_s: 60, first_response_median_s: 60, first_response_p90_s: 60,
  within_sla_pct: 100, reopen_rate_pct: 0, resolution_median_s: 1800, one_reply_pct: 50, csat_pct: 75, csat_answers: 4,
};
const team = {
  new_per_day: [{ day: "2026-10-01", bot: 1, miniapp: 0, web: 0 }],
  backlog: 0, oldest_waiting_minutes: null, within_sla_pct: 100,
  resolution_median_s: 1800, one_reply_pct: 33.3, messages_per_ticket: 2.3,
  csat_pct: 80, csat_answers: 10, csat_asked: 12,
  heatmap: [{ dow: 4, hour: 10, n: 1 }],
};

function renderStats(stats: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${url}`;
      if (key === "GET /crm/api/me") return jsonResponse(200, admin);
      if (key.startsWith("GET /crm/api/stats?")) return jsonResponse(200, stats);
      throw new Error(`unexpected ${key}`);
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/stats"]}>
        <Stats />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Stats page", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows resolution tiles, the heatmap and the two new operator columns", async () => {
    renderStats({ team, operators: [op], topics: [] });
    expect(await screen.findByText("Время решения")).toBeTruthy();
    // Expected strings come from the app formatters (they may use non-breaking spaces).
    expect(screen.getAllByText(norm(formatDuration(1800))).length).toBe(2); // team tile + Аня's «Решение»
    expect(screen.getByText(norm(formatPercent(33.3)))).toBeTruthy();
    expect(screen.getByText(norm(formatNumber(2.3)))).toBeTruthy();
    expect(screen.getByRole("table", { name: "Новые обращения по дням недели и часам" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Решение" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Одним ответом" })).toBeTruthy();
    expect(screen.getByText(norm(formatPercent(50)))).toBeTruthy();
  });

  it("shows CSAT in the team tile and the operator column", async () => {
    renderStats({ team, operators: [op], topics: [] });
    const label = await screen.findByText("Клиенты довольны", { exact: false });
    expect(within(label.closest("div")!).getByText(norm(formatPercent(80)))).toBeTruthy();
    expect(screen.getByText("мало оценок (4)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Довольны" })).toBeTruthy();
  });

  it("says «нет решённых» when nothing was resolved", async () => {
    renderStats({
      team: { ...team, resolution_median_s: null, one_reply_pct: null, messages_per_ticket: null, heatmap: [] },
      operators: [{ ...op, resolution_median_s: null, one_reply_pct: null }],
      topics: [],
    });
    expect(await screen.findByText("Время решения")).toBeTruthy();
    expect(screen.getAllByText("нет решённых")).toHaveLength(5); // 3 tiles + 2 operator cells
    expect(screen.getByText("За период новых обращений нет.")).toBeTruthy();
  });
});
