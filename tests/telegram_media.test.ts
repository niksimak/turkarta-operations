import assert from "node:assert/strict";
import test from "node:test";
import { telegramPhotoUrl, validTelegramPhotoRequest } from "../src/telegram_media.js";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const SECRET = "test-secret";

test("signed Telegram photo URL validates before expiry", () => {
  const url = new URL(telegramPhotoUrl("telegram-file-id", "https://ops.example", SECRET, NOW));
  assert.equal(url.pathname, "/media/telegram/photo.jpg");
  assert.equal(url.searchParams.get("file_id"), "telegram-file-id");
  assert.equal(
    validTelegramPhotoRequest(
      url.searchParams.get("file_id")!,
      url.searchParams.get("expires")!,
      url.searchParams.get("signature")!,
      SECRET,
      NOW,
    ),
    true,
  );
});

test("signed Telegram photo URL rejects tampering and expiry", () => {
  const url = new URL(telegramPhotoUrl("telegram-file-id", "https://ops.example", SECRET, NOW));
  const expires = url.searchParams.get("expires")!;
  const signature = url.searchParams.get("signature")!;

  assert.equal(validTelegramPhotoRequest("other-file", expires, signature, SECRET, NOW), false);
  assert.equal(validTelegramPhotoRequest("telegram-file-id", expires, signature, SECRET, NOW + 601_000), false);
});
