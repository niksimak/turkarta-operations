import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PHOTO_BYTES,
  MAX_VIDEO_BYTES,
  supportPhotoUrl,
  validSupportPhotoRequest,
  validatePhoto,
  validateVideo,
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

const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftyp" + brand), 0, 0, 0, 0]);

test("validates video contents: mp4, iPhone mov and webm, at most 20 MB", () => {
  assert.equal(MAX_VIDEO_BYTES, 20 * 1024 * 1024);
  const mp4 = ftyp("isom");
  assert.deepEqual(validateVideo(mp4, "video/mp4", "Как пополнить карту.MP4"), {
    content: mp4, mediaType: "video/mp4", filename: "video.mp4",
  });
  assert.equal(validateVideo(ftyp("mp42"), "video/mp4", "screen-1.mp4")?.filename, "screen-1.mp4");
  assert.equal(validateVideo(ftyp("qt  "), "video/quicktime", "IMG_0001.MOV")?.filename, "IMG_0001.mov");
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
  assert.equal(validateVideo(webm, "video/webm", "rec.webm")?.mediaType, "video/webm");

  assert.equal(validateVideo(ftyp("qt  "), "video/mp4", "x.mp4"), null, "declared type must match the bytes");
  assert.equal(validateVideo(mp4, "image/jpeg", "x.jpg"), null);
  assert.equal(validateVideo(new Uint8Array([0xff, 0xd8, 0xff, 0]), "video/mp4", "x.mp4"), null);
  assert.equal(validateVideo(new Uint8Array(0), "video/mp4", "x.mp4"), null);
  const huge = new Uint8Array(MAX_VIDEO_BYTES + 1);
  huge.set(mp4);
  assert.equal(validateVideo(huge, "video/mp4", "big.mp4"), null);
});
