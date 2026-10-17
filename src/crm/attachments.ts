import { config } from "../config.js";
import { sql } from "../db.js";

type Row = { media_type: string; content: Buffer | null; tg_file_id: string | null };

export type AttachmentDeps = {
  getFile?: (fileId: string) => Promise<{ file_path?: string }>;
  fetch?: typeof fetch;
  load?: (id: string) => Promise<Row | null>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE = "private, max-age=86400";

async function loadRow(id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const [row] = await sql<Row[]>`
    select media_type, content, tg_file_id
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

  if (row.content) {
    return new Response(new Uint8Array(row.content), {
      headers: { "content-type": row.media_type, "cache-control": CACHE },
    });
  }
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

  let upstream: Response;
  try {
    upstream = await doFetch(
      `https://api.telegram.org/file/bot${config.SUPPORT_BOT_TOKEN}/${file.file_path}`,
      { signal: AbortSignal.timeout(20_000) },
    );
  } catch {
    return unavailable(id, "fetch");
  }
  if (!upstream.ok || !upstream.body) return unavailable(id, upstream.status);

  return new Response(upstream.body, {
    headers: { "content-type": "image/jpeg", "cache-control": CACHE },
  });
}
