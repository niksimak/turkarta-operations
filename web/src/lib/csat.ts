import { formatPercent } from "./stats";

/** Below this many answers the percent says nothing, so the UI shows the count instead. */
export const MIN_CSAT_ANSWERS = 5;

/** «нет оценок», «мало оценок (3)» or the share of 👍. */
export function csatText(pct: number | null, answers: number): string {
  if (answers === 0) return "нет оценок";
  if (answers < MIN_CSAT_ANSWERS || pct === null) return `мало оценок (${answers})`;
  return formatPercent(pct);
}
