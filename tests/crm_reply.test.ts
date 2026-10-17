import assert from "node:assert/strict";
import test from "node:test";

// Never load .env or contact Telegram; the pool below is never connected.
Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret",
  ROSTER: "[]",
});

const reply = await import("../dist/crm/reply.js");
const { InputFile } = await import("grammy");
type TgTransport = import("../dist/crm/reply.js").TgTransport;

type Call = { method: string; chatId: number; text?: string; caption?: string; count?: number };

function fakeTransport(fail?: { method: string; error: unknown }) {
  const calls: Call[] = [];
  let n = 0;
  const file = () => ({ message_id: ++n, fileId: `file-${n}`, fileUniqueId: `uniq-${n}` });
  const maybeFail = (method: string) => { if (fail?.method === method) throw fail.error; };
  const tg: TgTransport = {
    async sendMessage(chatId, text) { calls.push({ method: "sendMessage", chatId, text }); maybeFail("sendMessage"); return { message_id: ++n }; },
    async sendPhoto(chatId, _photo, caption) { calls.push({ method: "sendPhoto", chatId, caption }); maybeFail("sendPhoto"); return file(); },
    async sendVideo(chatId, _video, caption) { calls.push({ method: "sendVideo", chatId, caption }); maybeFail("sendVideo"); return file(); },
    async sendMediaGroup(chatId, photos, caption) {
      calls.push({ method: "sendMediaGroup", chatId, caption, count: photos.length });
      maybeFail("sendMediaGroup");
      return photos.map(file);
    },
  };
  return { tg, calls };
}

const photo = (i: number) => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, i]), filename: `p${i}.jpg` });

test("text only goes out as one sendMessage", async () => {
  const { tg, calls } = fakeTransport();
  const files = await reply.sendTelegram(tg, 42, "Здравствуйте", []);
  assert.deepEqual(calls, [{ method: "sendMessage", chatId: 42, text: "Здравствуйте" }]);
  assert.deepEqual(files, []);
});

test("one photo goes out as sendPhoto with the body as caption", async () => {
  const { tg, calls } = fakeTransport();
  const files = await reply.sendTelegram(tg, 42, "Вот скриншот", [photo(1)]);
  assert.deepEqual(calls, [{ method: "sendPhoto", chatId: 42, caption: "Вот скриншот" }]);
  assert.deepEqual(files, [{ message_id: 1, fileId: "file-1", fileUniqueId: "uniq-1" }]);
});

test("a photo without text has no caption", async () => {
  const { tg, calls } = fakeTransport();
  await reply.sendTelegram(tg, 42, "", [photo(1)]);
  assert.deepEqual(calls, [{ method: "sendPhoto", chatId: 42, caption: undefined }]);
});

test("three photos go out as one sendMediaGroup", async () => {
  const { tg, calls } = fakeTransport();
  const files = await reply.sendTelegram(tg, 42, "Три фото", [photo(1), photo(2), photo(3)]);
  assert.deepEqual(calls, [{ method: "sendMediaGroup", chatId: 42, caption: "Три фото", count: 3 }]);
  assert.equal(files.length, 3);
});

test("photos plus a 1500-char body: media group without caption, then the text", async () => {
  const { tg, calls } = fakeTransport();
  const body = "а".repeat(1500);
  await reply.sendTelegram(tg, 42, body, [photo(1), photo(2)]);
  assert.deepEqual(calls, [
    { method: "sendMediaGroup", chatId: 42, caption: undefined, count: 2 },
    { method: "sendMessage", chatId: 42, text: body },
  ]);
});

test("one photo plus a long body: photo without caption, then the text", async () => {
  const { tg, calls } = fakeTransport();
  const body = "b".repeat(1025);
  await reply.sendTelegram(tg, 42, body, [photo(1)]);
  assert.deepEqual(calls.map((c) => [c.method, c.caption]), [["sendPhoto", undefined], ["sendMessage", undefined]]);
});

test("a body of exactly 1024 chars still rides as the caption", async () => {
  const { tg, calls } = fakeTransport();
  await reply.sendTelegram(tg, 42, "c".repeat(1024), [photo(1), photo(2)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.caption!.length, 1024);
});

test("photos are reported before the trailing text is sent", async () => {
  const { tg } = fakeTransport({ method: "sendMessage", error: { error_code: 403, description: "Forbidden: bot was blocked by the user" } });
  const reported: unknown[] = [];
  await assert.rejects(reply.sendTelegram(tg, 42, "d".repeat(1500), [photo(1), photo(2)], async (f) => { reported.push(...f); }));
  assert.equal(reported.length, 2, "file ids are stored even when the trailing text fails");
});

test("a transport error propagates so the caller can mark the message failed", async () => {
  const blocked = { error_code: 403, description: "Forbidden: bot was blocked by the user" };
  const { tg } = fakeTransport({ method: "sendMessage", error: blocked });
  await assert.rejects(reply.sendTelegram(tg, 42, "hi", []), (e) => e === blocked);
});

test("deliveryError formats Telegram errors and caps the length at 200", () => {
  assert.equal(reply.deliveryError({ error_code: 403, description: "Forbidden: bot was blocked by the user" }),
    "tg_403: Forbidden: bot was blocked by the user");
  assert.ok(reply.deliveryError({ error_code: 403, description: "Forbidden" }).startsWith("tg_403"));
  assert.equal(reply.deliveryError({ error_code: 400, description: "x".repeat(500) }).length, 200);
  assert.equal(reply.deliveryError(new Error("socket hang up")), "tg_network: request failed");
});

test("validateReply enforces the body, note and photo limits", () => {
  const p = { content: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" as const, filename: "a.jpg" };
  const code = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code; } };
  assert.equal(code(() => reply.validateReply({ kind: "reply", body: "  ", photos: [] })), "empty");
  assert.equal(code(() => reply.validateReply({ kind: "reply", body: "", photos: [p] })), null);
  assert.equal(code(() => reply.validateReply({ kind: "note", body: "", photos: [p] })), "note_needs_body");
  assert.equal(code(() => reply.validateReply({ kind: "reply", body: "x", photos: Array(11).fill(p) })), "too_many_photos");
  assert.equal(code(() => reply.validateReply({ kind: "reply", body: "x", photos: Array(10).fill(p) })), null);
  assert.equal(code(() => reply.validateReply({ kind: "reply", body: "x".repeat(4001), photos: [] })), "too_long");
  assert.equal(code(() => reply.validateReply({ kind: "reply", body: "x".repeat(4000), photos: [] })), null);
});

test("mentionedOperators matches @Name case-insensitively as a whole word", () => {
  const ops = [{ id: 7, name: "Anna" }, { id: 8, name: "Борис" }, { id: 9, name: "Anna Petrova" }, { id: 10, name: "Ann" }];
  const ids = (text: string) => reply.mentionedOperators(text, ops).map((o) => o.id).sort();
  assert.deepEqual(ids("@anna глянь"), [7]);
  assert.deepEqual(ids("@БОРИС, посмотри"), [8]);
  assert.deepEqual(ids("@Annabel тут"), []);
  assert.deepEqual(ids("cc @Anna Petrova"), [7, 9]);
  assert.deepEqual(ids("mail anna@example.com"), []);
  assert.deepEqual(ids("без упоминаний"), []);
});

test("grammyTransport sends bytes as InputFile and returns the largest photo size", async () => {
  const seen: Array<{ method: string; args: unknown[] }> = [];
  const sizes = (n: number) => [
    { file_id: `small-${n}`, file_unique_id: `us-${n}`, width: 90, height: 90 },
    { file_id: `big-${n}`, file_unique_id: `ub-${n}`, width: 1280, height: 1280 },
  ];
  const api = {
    sendMessage: async (...args: unknown[]) => { seen.push({ method: "sendMessage", args }); return { message_id: 1 }; },
    sendPhoto: async (...args: unknown[]) => { seen.push({ method: "sendPhoto", args }); return { message_id: 2, photo: sizes(1) }; },
    sendMediaGroup: async (...args: unknown[]) => {
      seen.push({ method: "sendMediaGroup", args });
      return [{ message_id: 3, photo: sizes(2) }, { message_id: 4, photo: sizes(3) }];
    },
  };
  const tg = reply.grammyTransport(api as never);

  assert.deepEqual(await tg.sendMessage(5, "hi"), { message_id: 1 });
  assert.deepEqual(seen[0]!.args.slice(0, 3), [5, "hi", {}]);

  assert.deepEqual(await tg.sendPhoto(5, photo(1), "cap"), { message_id: 2, fileId: "big-1", fileUniqueId: "ub-1" });
  const [chat, file, other] = seen[1]!.args as [number, InstanceType<typeof InputFile>, Record<string, unknown>];
  assert.equal(chat, 5);
  assert.ok(file instanceof InputFile);
  assert.equal(file.filename, "p1.jpg");
  assert.deepEqual(other, { caption: "cap" });

  const group = await tg.sendMediaGroup(5, [photo(1), photo(2)], "first");
  assert.deepEqual(group.map((g) => g.fileId), ["big-2", "big-3"]);
  const media = seen[2]!.args[1] as Array<Record<string, unknown>>;
  assert.deepEqual(media.map((m) => [m.type, m.caption]), [["photo", "first"], ["photo", undefined]]);
  assert.ok(media.every((m) => m.media instanceof InputFile));
});

const video = { bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), filename: "how-to.mp4" };

test("a video goes out as sendVideo with the body as caption", async () => {
  const { tg, calls } = fakeTransport();
  const files = await reply.sendTelegram(tg, 42, "Видеоинструкция", [video], async () => {}, true);
  assert.deepEqual(calls, [{ method: "sendVideo", chatId: 42, caption: "Видеоинструкция" }]);
  assert.equal(files.length, 1);
});

test("a video with a body over the caption limit is followed by the text", async () => {
  const { tg, calls } = fakeTransport();
  await reply.sendTelegram(tg, 42, "я".repeat(1025), [video], async () => {}, true);
  assert.deepEqual(calls.map((c) => c.method), ["sendVideo", "sendMessage"]);
});

test("a reply carries one video and no photos; a video alone needs no text", () => {
  const v = { content: video.bytes, mediaType: "video/mp4" as const, filename: "how-to.mp4" };
  assert.equal(reply.validateReply({ kind: "reply", body: "  ", photos: [], video: v }), "");
  assert.throws(
    () => reply.validateReply({ kind: "reply", body: "", photos: [{ content: new Uint8Array([1]), mediaType: "image/jpeg", filename: "p.jpg" }], video: v }),
    (e: { code?: string }) => e.code === "video_with_photos",
  );
  assert.equal(reply.validateReply({ kind: "note", body: "для команды", photos: [], video: v }), "для команды", "a note may carry a video like it carries photos");
});
