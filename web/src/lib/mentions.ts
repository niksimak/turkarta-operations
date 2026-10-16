import type { TokenRange } from "./canned";

const MAX_QUERY = 40;

/** The `@name` being typed at the caret; names have spaces, so the token runs to the caret. */
export function mentionQuery(text: string, caret: number): TokenRange | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const at = text.lastIndexOf("@", caret - 1);
  if (at < lineStart) return null;
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null;
  const query = text.slice(at + 1, caret);
  if (query.length > MAX_QUERY) return null;
  return { start: at, end: caret, query };
}

/** The server matches `@<full name>`, so the list offers whole names. */
export function matchOperators<T extends { name: string }>(ops: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return ops;
  return ops.filter((o) => {
    const name = o.name.toLowerCase();
    return name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q));
  });
}
