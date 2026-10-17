import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent, mskIso, rangeQuery } from "./stats";
import { sortOperators } from "../routes/Stats";
import { niceTicks } from "../components/StatsChart";

describe("formatDuration", () => {
  it("formats seconds the way operators read them", () => {
    expect(formatDuration(0)).toBe("0 с");
    expect(formatDuration(42)).toBe("42 с");
    expect(formatDuration(252)).toBe("4 мин 12 с");
    expect(formatDuration(240)).toBe("4 мин");
    expect(formatDuration(59.6)).toBe("1 мин");
    expect(formatDuration(3900)).toBe("1 ч 5 мин");
    expect(formatDuration(7200)).toBe("2 ч");
    expect(formatDuration(2 * 86_400 + 3 * 3600 + 59)).toBe("2 д 3 ч");
  });

  it("formats percents with a non-breaking space and a comma", () => {
    expect(formatPercent(87.5)).toBe("87,5 %");
  });
});

describe("rangeQuery", () => {
  // 2026-10-16 01:30 in Moscow is still 2026-10-15 in UTC.
  const now = Date.parse("2026-10-15T22:30:00Z");

  it("anchors presets to Moscow midnight and lets the server count to now", () => {
    expect(rangeQuery({ preset: "today" }, now)).toEqual({ ok: true, from: "2026-10-16T00:00:00+03:00" });
    expect(rangeQuery({ preset: "7d" }, now)).toEqual({ ok: true, from: "2026-10-10T00:00:00+03:00" });
    expect(rangeQuery({ preset: "30d" }, now)).toEqual({ ok: true, from: "2026-09-17T00:00:00+03:00" });
  });

  it("covers whole Moscow days for a custom range and rejects bad ones", () => {
    expect(rangeQuery({ preset: "custom", from: "2026-10-01", to: "2026-10-03" }, now)).toEqual({
      ok: true,
      from: "2026-10-01T00:00:00+03:00",
      to: "2026-10-04T00:00:00+03:00",
    });
    expect(rangeQuery({ preset: "custom", from: "2026-10-05", to: "2026-10-03" }, now).ok).toBe(false);
    expect(rangeQuery({ preset: "custom", from: "2024-01-01", to: "2026-10-03" }, now).ok).toBe(false);
  });

  it("writes ISO with the Moscow offset", () => {
    expect(mskIso(Date.parse("2026-10-15T21:00:00Z"))).toBe("2026-10-16T00:00:00+03:00");
  });
});

describe("operator table sort", () => {
  const row = (name: string, med: number | null) => ({
    operator_id: name.length, name, taken: 0, auto_assigned: 0, resolved: 0, replies: 0,
    response_median_s: med, response_p90_s: null, first_response_median_s: null, first_response_p90_s: null,
    within_sla_pct: null, reopen_rate_pct: null,
  });
  const rows = [row("Борис", 90), row("Аня", null), row("Вера", 30)];

  it("keeps nulls last in both directions", () => {
    const key = "response_median_s" as const;
    expect(sortOperators(rows, { key, dir: "asc" }).map((r) => r.name)).toEqual(["Вера", "Борис", "Аня"]);
    expect(sortOperators(rows, { key, dir: "desc" }).map((r) => r.name)).toEqual(["Борис", "Вера", "Аня"]);
    expect(sortOperators(rows, { key: "name", dir: "asc" }).map((r) => r.name)).toEqual(["Аня", "Борис", "Вера"]);
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 and covers the max", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(2)).toEqual([0, 1, 2]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
  });
});
