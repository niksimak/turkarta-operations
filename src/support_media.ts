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
  const safeBase = filename
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return {
    content,
    mediaType: actual,
    filename: `${safeBase || "photo"}.${extension}`,
  };
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
