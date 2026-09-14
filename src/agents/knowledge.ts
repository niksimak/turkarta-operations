import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export interface Article { id: string; title: string; text: string; version: string; }
const ArticleInput = z.object({
  slug: z.string().max(300), title: z.string().max(500), content: z.unknown(),
  is_published: z.boolean().optional(), updated_at: z.string().optional(),
});

// Extract visible editor text only, excluding links/attributes/embedded HTML.
export function visibleText(node: unknown, depth = 0): string {
  if (depth > 30 || !node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.slice(0, 2000).map((n) => visibleText(n, depth + 1)).join(" ");
  const n = node as Record<string, unknown>;
  if (n.type === "text" && typeof n.text === "string") return n.text.slice(0, 12000);
  return visibleText(n.content, depth + 1);
}

export function parseArticles(raw: unknown): Article[] {
  const rows = z.array(ArticleInput).max(500).parse(raw);
  const ids = new Set<string>();
  return rows.filter((r) => r.is_published !== false).map((r) => {
    const id = r.slug || "index";
    if (ids.has(id)) throw new Error("kb_duplicate_slug");
    ids.add(id);
    const text = visibleText(r.content).replace(/\s+/g, " ").trim().slice(0, 50000);
    return { id, title: r.title, text, version: r.updated_at ?? createHash("sha256").update(text).digest("hex") };
  });
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok) throw new Error("kb_unavailable");
  // Bound actual streamed data, not merely Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("kb_empty_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error("kb_response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class KnowledgeBase {
  private cached: Article[] = [];
  private expires = 0;
  constructor(private source: { file?: string; api?: string }) {}
  async articles(): Promise<Article[]> {
    if (Date.now() < this.expires) return this.cached;
    let articles: Article[] = [];
    if (this.source.file) {
      const content = await readFile(this.source.file, "utf8");
      if (Buffer.byteLength(content) > 10_000_000) throw new Error("kb_file_too_large");
      articles = parseArticles(JSON.parse(content));
    } else if (this.source.api) {
      const base = new URL(this.source.api);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("kb_invalid_url");
      const summaries = z.array(z.object({ slug: z.string().max(300) })).max(100).parse(await fetchJson(base));
      const details = [];
      const slugs = summaries.filter((s) => s.slug);
      // At most four fixed-origin requests at once and 100 articles per refresh.
      // Even the worst timeout path stays within the worker lease.
      for (let offset = 0; offset < slugs.length; offset += 4) {
        const batch = await Promise.all(slugs.slice(offset, offset + 4).map((summary) => {
          const url = new URL(base);
          url.pathname = `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(summary.slug)}`;
          return fetchJson(url);
        }));
        details.push(...batch);
      }
      articles = parseArticles(details);
    }
    this.cached = articles;
    this.expires = Date.now() + 300_000;
    return articles;
  }
}

const STOP = new Set(["как", "что", "это", "для", "или", "мне", "меня", "мой", "моя", "the", "and", "with"]);
function tokens(text: string): string[] {
  return [...new Set((text.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((s) => !STOP.has(s)).map((s) => s.length > 5 ? s.slice(0, -2) : s))];
}

/** Cheap lexical retrieval; no external embedding bill. Scores are not confidence. */
export function retrieve(query: string, articles: Article[], limit = 4): Article[] {
  const terms = tokens(query);
  if (!terms.length) return [];
  return articles.map((a) => {
    const title = a.title.toLowerCase().replace(/ё/g, "е");
    const text = a.text.toLowerCase().replace(/ё/g, "е");
    const score = terms.reduce((n, t) => n + (title.includes(t) ? 3 : 0) + (text.includes(t) ? 1 : 0), 0);
    const first = terms.map((t) => text.indexOf(t)).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
    return { article: { ...a, text: a.text.slice(Math.max(0, first - 300), Math.max(0, first - 300) + 3500) }, score };
  }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((a) => a.article);
}
