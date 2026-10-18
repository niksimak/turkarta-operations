import { formatPercent } from "./stats";

/** Below this many answers the percent says nothing, so the UI shows the count instead. */
export const MIN_CSAT_ANSWERS = 5;

/** True while the percent is hidden for lack of answers. */
export const csatMuted = (answers: number): boolean => answers < MIN_CSAT_ANSWERS;

/** «нет оценок», «мало оценок (3)» or the share of 👍. */
export function csatText(pct: number | null, answers: number): string {
  if (answers === 0) return "нет оценок";
  if (csatMuted(answers) || pct === null) return `мало оценок (${answers})`;
  return formatPercent(pct);
}
