import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { formatNumber } from "./format";

// Mirrors src/crm/stats.ts (TeamStats, OperatorStats).
export interface DayCount {
  day: string;
  bot: number;
  miniapp: number;
  web: number;
}

export interface TeamStats {
  new_per_day: DayCount[];
  backlog: number;
  oldest_waiting_minutes: number | null;
  within_sla_pct: number | null;
}

export interface OperatorStats {
  operator_id: number;
  name: string;
  taken: number;
  auto_assigned: number;
  resolved: number;
  replies: number;
  response_median_s: number | null;
  response_p90_s: number | null;
  first_response_median_s: number | null;
  first_response_p90_s: number | null;
  within_sla_pct: number | null;
  reopen_rate_pct: number | null;
}

export interface StatsResponse {
  team: TeamStats;
  operators: OperatorStats[];
}

export type Preset = "today" | "7d" | "30d" | "custom";

export const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: "today", label: "Сегодня" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "custom", label: "Период" },
];

const DAY_MS = 86_400_000;
const MSK_OFFSET_MS = 3 * 3_600_000;
export const MAX_RANGE_DAYS = 400;

/** «2026-10-12» of the Moscow calendar day that contains `ms`. */
export function mskDate(ms: number): string {
  return new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO with the Moscow offset, the shape GET /stats expects. */
export function mskIso(ms: number): string {
  return `${new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 19)}+03:00`;
}

const mskMidnight = (date: string) => Date.parse(`${date}T00:00:00+03:00`);

export interface RangeChoice {
  preset: Preset;
  /** Custom range only: Moscow dates, both inclusive. */
  from?: string;
  to?: string;
}

export type RangeQuery = { ok: true; from: string; to?: string } | { ok: false; error: string };

/**
 * Presets send only `from` (a Moscow midnight) so the server counts up to now and the
 * query key stays stable. A custom range covers whole days, `to` exclusive.
 */
export function rangeQuery(choice: RangeChoice, now: number): RangeQuery {
  const today = mskMidnight(mskDate(now));
  if (choice.preset === "today") return { ok: true, from: mskIso(today) };
  if (choice.preset === "7d") return { ok: true, from: mskIso(today - 6 * DAY_MS) };
  if (choice.preset === "30d") return { ok: true, from: mskIso(today - 29 * DAY_MS) };
  const from = choice.from ? mskMidnight(choice.from) : NaN;
  const to = choice.to ? mskMidnight(choice.to) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: "Укажите начало и конец периода." };
  if (from > to) return { ok: false, error: "Начало периода позже конца." };
  if ((to - from) / DAY_MS + 1 > MAX_RANGE_DAYS) return { ok: false, error: `Период больше ${MAX_RANGE_DAYS} дней. Сократите его.` };
  return { ok: true, from: mskIso(from), to: mskIso(to + DAY_MS) };
}

export function statsPath(q: { from: string; to?: string }): string {
  const p = new URLSearchParams({ from: q.from });
  if (q.to) p.set("to", q.to);
  return `/stats?${p.toString()}`;
}

export function useStats(q: { from: string; to?: string } | null) {
  return useQuery({
    queryKey: ["stats", q] as const,
    queryFn: () => api<StatsResponse>(statsPath(q!)),
    enabled: q !== null,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

/** «42 с», «4 мин 12 с», «1 ч 5 мин», «2 д 3 ч». */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} мин ${r} с` : `${m} мин`;
  }
  if (s < DAY_MS / 1000) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h ? `${d} д ${h} ч` : `${d} д`;
}

export function formatPercent(pct: number): string {
  return `${formatNumber(pct)} %`;
}

const dayShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLong = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "short", timeZone: "UTC" });

/** «12 окт» for an API day string. */
export function formatDayShort(day: string): string {
  return dayShort.format(Date.parse(`${day}T00:00:00Z`)).replace(".", "");
}

/** «пн, 12 октября». */
export function formatDayLong(day: string): string {
  return dayLong.format(Date.parse(`${day}T00:00:00Z`));
}
