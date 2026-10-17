export type SlaLevel = "none" | "ok" | "warn" | "late";

export interface SlaSettings {
  sla_first_minutes: number;
  sla_followup_minutes: number;
  sla_warn_percent: number;
}

export const DEFAULT_SLA: SlaSettings = { sla_first_minutes: 5, sla_followup_minutes: 15, sla_warn_percent: 50 };

export function slaTarget(firstResponseAt: string | null, settings: SlaSettings): number {
  return firstResponseAt ? settings.sla_followup_minutes : settings.sla_first_minutes;
}

/** Mirrors the server's overdue filter: late strictly past the target, warn from the warn share. */
export function slaState(
  waitingSince: string | null,
  firstResponseAt: string | null,
  settings: SlaSettings,
  now: number | Date,
): { minutes: number; level: SlaLevel } {
  if (!waitingSince) return { minutes: 0, level: "none" };
  const since = Date.parse(waitingSince);
  if (Number.isNaN(since)) return { minutes: 0, level: "none" };
  const elapsedMs = Math.max(0, (typeof now === "number" ? now : now.getTime()) - since);
  const targetMs = slaTarget(firstResponseAt, settings) * 60_000;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMs > targetMs) return { minutes, level: "late" };
  if (elapsedMs >= (targetMs * settings.sla_warn_percent) / 100) return { minutes, level: "warn" };
  return { minutes, level: "ok" };
}

/** «12 мин», «2 ч», «3 д» for the badge; `exact` adds the minutes for tooltips. */
export function formatWait(minutes: number, exact = false): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (exact) {
    const rest = minutes % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} д`;
}
