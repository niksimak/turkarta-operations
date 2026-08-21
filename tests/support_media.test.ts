import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PHOTO_BYTES,
  supportPhotoUrl,
  validSupportPhotoRequest,
  validatePhoto,
} from "../src/support_media.js";

const SECRET = "support-photo-test-secret";
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);

test("validates image contents instead of trusting the browser MIME", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
  assert.deepEqual(validatePhoto(jpeg, "image/jpeg", "my photo.jpeg"), {
    content: jpeg,
    mediaType: "image/jpeg",
    filename: "my-photo.jpg",
  });
  assert.equal(validatePhoto(jpeg, "image/png", "fake.png"), null);
  assert.equal(validatePhoto(new Uint8Array(MAX_PHOTO_BYTES + 1), "image/jpeg", "huge.jpg"), null);
});

test("signed support photo URL validates, rejects tampering, and expires", () => {
  const url = new URL(supportPhotoUrl("photo-id", "receipt.jpg", "https://ops.example", SECRET, NOW));
  assert.equal(url.pathname, "/media/support/photo-id/receipt.jpg");
  const expires = url.searchParams.get("expires")!;
  const signature = url.searchParams.get("signature")!;
  assert.equal(validSupportPhotoRequest("photo-id", expires, signature, SECRET, NOW), true);
  assert.equal(validSupportPhotoRequest("other-id", expires, signature, SECRET, NOW), false);
  assert.equal(validSupportPhotoRequest("photo-id", expires, signature, SECRET, NOW + 3_601_000), false);
});
