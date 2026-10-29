import { config } from "../config.js";
import { sql } from "../db.js";
import { storedVideoResponse } from "../video_storage.js";

type Row = { media_type: string; content: Buffer | null; tg_file_id: string | null; storage_key?: string | null };

export type AttachmentDeps = {
  getFile?: (fileId: string) => Promise<{ file_path?: string }>;
  fetch?: typeof fetch;
  load?: (id: string) => Promise<Row | null>;
  /** The request's Range header; videos need it to stream and seek (Safari will not play without it). */
  range?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE = "private, max-age=86400";

async function loadRow(id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const [row] = await sql<Row[]>`
    select media_type, content, tg_file_id, storage_key
    from public.support_attachments where id = ${id}`;
  return row ?? null;
}

// Called over fetch so this module does not pull in the whole bot.
async function defaultGetFile(fileId: string): Promise<{ file_path?: string }> {
  const url = `https://api.telegram.org/bot${config.SUPPORT_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`getFile status ${res.status}`);
  const body = (await res.json()) as { result?: { file_path?: string } };
  return body.result ?? {};
}

/** A single `bytes=a-b` / `bytes=a-` / `bytes=-n` range over `size` bytes, or "invalid". */
export function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "invalid" : { start, end };
}

function storedResponse(row: Row & { content: Buffer }, rangeHeader: string | undefined): Response {
  const bytes = new Uint8Array(row.content);
  const headers = { "content-type": row.media_type, "cache-control": CACHE, "accept-ranges": "bytes" };
  const range = rangeHeader ? parseRange(rangeHeader, bytes.length) : null;
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${bytes.length}` } });
  }
  if (!range) return new Response(bytes, { headers: { ...headers, "content-length": String(bytes.length) } });
  const part = bytes.subarray(range.start, range.end + 1);
  return new Response(part, {
    status: 206,
    headers: { ...headers, "content-length": String(part.length), "content-range": `bytes ${range.start}-${range.end}/${bytes.length}` },
  });
}

function unavailable(id: string, code: number | string): Response {
  console.error(`[crm-attachments] tg fetch failed id=${id} code=${code}`);
  return Response.json({ error: "photo_unavailable" }, { status: 502 });
}

export async function attachmentResponse(
  id: string,
  deps: AttachmentDeps = {},
): Promise<Response> {
  const row = await (deps.load ?? loadRow)(id);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  if (row.content) return storedResponse({ ...row, content: row.content }, deps.range);
  if (row.storage_key) return storedVideoResponse(row.storage_key, row.media_type, deps.range, { "cache-control": CACHE });
  if (!row.tg_file_id) return Response.json({ error: "not_found" }, { status: 404 });

  const getFile = deps.getFile ?? defaultGetFile;
  const doFetch = deps.fetch ?? fetch;
  let file: { file_path?: string };
  try {
    file = await getFile(row.tg_file_id);
  } catch {
    return unavailable(id, "getfile");
  }
  if (!file.file_path) return unavailable(id, "nopath");

  const video = row.media_type.startsWith("video/");
  let upstream: Response;
  try {
    upstream = await doFetch(
      `https://api.telegram.org/file/bot${config.SUPPORT_BOT_TOKEN}/${file.file_path}`,
      {
        // A 20 MB video needs longer than a photo; Range lets the browser seek without the whole file.
        signal: AbortSignal.timeout(video ? 60_000 : 20_000),
        ...(video && deps.range ? { headers: { range: deps.range } } : {}),
      },
    );
  } catch {
    return unavailable(id, "fetch");
  }
  if (!upstream.ok || !upstream.body) return unavailable(id, upstream.status);
  if (!video) {
    return new Response(upstream.body, {
      headers: { "content-type": "image/jpeg", "cache-control": CACHE },
    });
  }
  if (upstream.status === 206) {
    const headers: Record<string, string> = { "content-type": row.media_type, "cache-control": CACHE, "accept-ranges": "bytes" };
    for (const h of ["content-range", "content-length"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    return new Response(upstream.body, { status: 206, headers });
  }
  // Telegram answered with the whole file (at most 20 MB): slice it here so ranges still work.
  return storedResponse({ ...row, content: Buffer.from(await upstream.arrayBuffer()) }, deps.range);
}
