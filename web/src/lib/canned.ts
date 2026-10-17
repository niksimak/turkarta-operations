import { useQuery } from "@tanstack/react-query";
import { api, json } from "./api";

// Mirrors src/crm/canned.ts (CannedReply); only the fields the composer reads.
export interface CannedReply {
  id: string;
  title: string;
  body: string;
  use_count: number;
  created_by: number | null;
}

export interface TemplateVars {
  имя?: string | null;
  оператор?: string | null;
}

/** Fills `{имя}` and `{оператор}`; a missing value becomes "", any other `{…}` stays as typed. */
export function fillTemplate(body: string, vars: TemplateVars): string {
  return body.replace(/\{(имя|оператор)\}/g, (_m, key: keyof TemplateVars) => vars[key] ?? "");
}

/**
 * Subsequence match: every query character in order. Lower is better; null is no match.
 * Gaps cost, so «код» ranks a contiguous «Код не пришёл» above a scattered hit.
 */
function fuzzyScore(query: string, text: string): number | null {
  const t = text.toLowerCase();
  const direct = t.indexOf(query);
  if (direct !== -1) return direct === 0 || /[\s.,!?«(]/.test(t[direct - 1]!) ? 0 : 1;
  let at = -1;
  let gaps = 0;
  for (const ch of query) {
    const next = t.indexOf(ch, at + 1);
    if (next === -1) return null;
    if (at !== -1) gaps += next - at - 1;
    at = next;
  }
  return 2 + gaps;
}

/** Title hits beat body hits; ties keep the server's order (most used first). */
export function searchCanned(list: CannedReply[], query: string): CannedReply[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const BODY_PENALTY = 1_000;
  return list
    .map((r, i) => {
      const title = fuzzyScore(q, r.title);
      const body = fuzzyScore(q, r.body);
      const score = title !== null ? title : body !== null ? BODY_PENALTY + body : null;
      return { r, i, score };
    })
    .filter((x): x is { r: CannedReply; i: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.r);
}

export interface TokenRange {
  /** Index of the trigger character. */
  start: number;
  /** Caret position: the token runs from `start` to here. */
  end: number;
  query: string;
}

/** `/` as the first character of the caret's line opens the canned search. */
export function slashQuery(text: string, caret: number): TokenRange | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  if (text[lineStart] !== "/" || caret <= lineStart) return null;
  const query = text.slice(lineStart + 1, caret);
  if (query.includes("\n")) return null;
  return { start: lineStart, end: caret, query };
}

export const cannedKey = ["canned"] as const;

export function useCanned(enabled: boolean) {
  return useQuery({
    queryKey: cannedKey,
    queryFn: () => api<CannedReply[]>("/canned"),
    enabled,
    staleTime: 60_000,
  });
}

/** Counts a use so the most used replies rise to the top; failure does not matter to the operator. */
export function markCannedUsed(id: string): void {
  api(`/canned/${encodeURIComponent(id)}/use`, json("POST")).catch(() => undefined);
}
