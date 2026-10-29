import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LINK_TTL_SECONDS = 60 * 60;

export interface ValidPhoto {
  content: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  filename: string;
}

function detectedType(bytes: Uint8Array): ValidPhoto["mediaType"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function validatePhoto(
  content: Uint8Array,
  declaredType: string,
  filename: string,
): ValidPhoto | null {
  if (!content.length || content.length > MAX_PHOTO_BYTES || !PHOTO_TYPES.has(declaredType)) {
    return null;
  }
  const actual = detectedType(content);
  if (actual !== declaredType) return null;
  const extension = actual === "image/jpeg" ? "jpg" : actual.split("/")[1];
  return {
    content,
    mediaType: actual,
    filename: `${safeBase(filename) || "photo"}.${extension}`,
  };
}

/** ASCII-only stem of an uploaded filename (Telegram and download headers stay safe). */
function safeBase(filename: string): string {
  return filename
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// One cap for every video: operator replies (kept in Postgres), web chat uploads (kept in the bucket)
// and Telegram client videos (a bot cannot download more than 20 MB from Telegram).
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export interface ValidVideo {
  content: Uint8Array;
  mediaType: "video/mp4" | "video/quicktime" | "video/webm";
  filename: string;
}

const VIDEO_EXTENSION: Record<ValidVideo["mediaType"], string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function detectedVideoType(bytes: Uint8Array): ValidVideo["mediaType"] | null {
  // ISO base media (mp4, mov): a `ftyp` box first; the `qt  ` brand is QuickTime (iPhone recordings).
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    return String.fromCharCode(...bytes.slice(8, 12)) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  // Matroska/WebM EBML header.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return null;
}

export function validateVideo(content: Uint8Array, declaredType: string, filename: string): ValidVideo | null {
  if (!content.length || content.length > MAX_VIDEO_BYTES || !VIDEO_TYPES.has(declaredType)) return null;
  const actual = detectedVideoType(content);
  if (actual !== declaredType) return null;
  return { content, mediaType: actual, filename: `${safeBase(filename) || "video"}.${VIDEO_EXTENSION[actual]}` };
}

function signature(id: string, expires: number, secret: string): string {
  return createHmac("sha256", secret).update(`${id}.${expires}`).digest("base64url");
}

export function supportPhotoUrl(
  id: string,
  filename: string,
  baseUrl: string,
  secret: string,
  now = Date.now(),
): string {
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const url = new URL(`/media/support/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`, baseUrl);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature(id, expires, secret));
  return url.toString();
}

export function validSupportPhotoRequest(
  id: string,
  expiresRaw: string,
  supplied: string,
  secret: string,
  now = Date.now(),
): boolean {
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(now / 1000)) return false;
  const expected = Buffer.from(signature(id, expires, secret));
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
