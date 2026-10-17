import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "grammy/types";

Object.assign(process.env, {
  LEADS_BOT_TOKEN: "123:test", SUPPORT_BOT_TOKEN: "456:test",
  LEADS_CHAT_ID: "-1001", SUPPORT_CHAT_ID: "-1002",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/not-used",
  PUBLIC_BASE_URL: "https://ops.example",
  LEADS_WEBHOOK_SECRET: "test-secret", TELEGRAM_WEBHOOK_SECRET: "test-secret", ROSTER: "[]",
});

const { classifyTelegram, legacyLabel } = await import("../dist/crm/inbound.js");

function msg(fields: Record<string, unknown>): Message {
  return {
    message_id: 1, date: 1, chat: { id: 5, type: "private", first_name: "T" },
    from: { id: 5, is_bot: false, first_name: "T" }, ...fields,
  } as unknown as Message;
}
const size = (id: string, w: number) => ({ file_id: id, file_unique_id: `u-${id}`, width: w, height: w });
const doc = { file_id: "doc", file_unique_id: "u-doc" };

test("text message → text part, label is the text", () => {
  const part = classifyTelegram(msg({ text: "Не проходит оплата" }));
  assert.deepEqual(part, { kind: "text", body: "Не проходит оплата" });
  assert.equal(legacyLabel(part!), "Не проходит оплата");
});

test("photo with 3 sizes picks the largest (last) size", () => {
  const part = classifyTelegram(msg({ photo: [size("s", 90), size("m", 320), size("l", 1280)] }));
  assert.equal(part!.kind, "photo");
  assert.deepEqual(part!.tgPhoto, { fileId: "l", fileUniqueId: "u-l" });
  assert.equal(part!.body, "");
  assert.equal(part!.mediaGroupId, undefined);
  assert.equal(legacyLabel(part!), "📷 [фото]");
});

test("photo with caption and media_group_id keeps both", () => {
  const part = classifyTelegram(msg({ photo: [size("a", 90), size("b", 800)], caption: "Скрин", media_group_id: "g1" }));
  assert.equal(part!.kind, "photo");
  assert.equal(part!.body, "Скрин");
  assert.equal(part!.mediaGroupId, "g1");
  assert.deepEqual(part!.tgPhoto, { fileId: "b", fileUniqueId: "u-b" });
  assert.equal(legacyLabel(part!), "Скрин");
});

test("GIF (animation + document) → unsupported/animation", () => {
  const part = classifyTelegram(msg({ animation: { ...doc, width: 1, height: 1, duration: 1 }, document: doc }));
  assert.equal(part!.kind, "unsupported");
  assert.equal(part!.unsupportedType, "animation");
  assert.equal(legacyLabel(part!), "🎞 [GIF]");
});

test("voice → unsupported/voice with legacy label", () => {
  const part = classifyTelegram(msg({ voice: { file_id: "v", file_unique_id: "u-v", duration: 3 } }));
  assert.deepEqual(part, { kind: "unsupported", body: "", unsupportedType: "voice" });
  assert.equal(legacyLabel(part!), "🎤 [голосовое]");
});

test("sticker keeps its emoji in the label", () => {
  const part = classifyTelegram(msg({ sticker: { file_id: "st", file_unique_id: "u-st", type: "regular", width: 1, height: 1, is_animated: false, is_video: false, emoji: "😀" } }));
  assert.equal(part!.unsupportedType, "sticker");
  assert.equal(legacyLabel(part!), "😀 [стикер]");
});

test("other unsupported kinds keep caption and legacy labels", () => {
  const video = classifyTelegram(msg({ video: { file_id: "vd", file_unique_id: "u", width: 1, height: 1, duration: 1 }, caption: "смотрите" }));
  assert.deepEqual(video, { kind: "unsupported", body: "смотрите", unsupportedType: "video" });
  assert.equal(legacyLabel(video!), "смотрите");
  const note = classifyTelegram(msg({ video_note: { file_id: "vn", file_unique_id: "u", length: 1, duration: 1 } }));
  assert.equal(note!.unsupportedType, "video_note");
  assert.equal(legacyLabel(note!), "🎬 [видео]");
  const file = classifyTelegram(msg({ document: doc }));
  assert.equal(file!.unsupportedType, "document");
  assert.equal(legacyLabel(file!), "📎 [файл]");
  const audio = classifyTelegram(msg({ audio: { file_id: "au", file_unique_id: "u", duration: 1 } }));
  assert.equal(audio!.unsupportedType, "audio");
  assert.equal(legacyLabel(audio!), "🎵 [аудио]");
});

test("empty service message → null", () => {
  assert.equal(classifyTelegram(msg({ new_chat_members: [] })), null);
  assert.equal(classifyTelegram(msg({})), null);
});
