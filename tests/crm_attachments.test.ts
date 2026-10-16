import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:secret-token",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret",
  ROSTER: "[]",
});

const { attachmentResponse } = await import("../dist/crm/attachments.js");

const stored = { media_type: "image/png", content: Buffer.from([1, 2, 3]), tg_file_id: null };
const tg = { media_type: "image/jpeg", content: null, tg_file_id: "FILE1" };

test("stored bytes are served with row media type and cache header", async () => {
  const res = await attachmentResponse("a1", { load: async () => stored });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "private, max-age=86400");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from([1, 2, 3]));
});

test("telegram photo is streamed as image/jpeg", async () => {
  let fetched = "";
  const res = await attachmentResponse("a2", {
    load: async () => tg,
    getFile: async (id: string) => ({ file_path: `photos/${id}.jpg` }),
    fetch: (async (url: string) => {
      fetched = url;
      return new Response("jpegbytes", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(await res.text(), "jpegbytes");
  assert.equal(fetched, "https://api.telegram.org/file/bot456:secret-token/photos/FILE1.jpg");
});

test("getFile failure gives 502 without leaking the token", async () => {
  const res = await attachmentResponse("a3", {
    load: async () => tg,
    getFile: async () => { throw new Error("boom 456:secret-token"); },
  });
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { error: "photo_unavailable" });
  assert.ok(!body.includes("secret-token"));
});

test("upstream non-ok gives 502", async () => {
  const res = await attachmentResponse("a4", {
    load: async () => tg,
    getFile: async () => ({ file_path: "p.jpg" }),
    fetch: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(res.status, 502);
});

test("unknown id gives 404", async () => {
  const res = await attachmentResponse("nope", { load: async () => null });
  assert.equal(res.status, 404);
});
