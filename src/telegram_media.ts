import { createHmac, timingSafeEqual } from "node:crypto";

const LINK_TTL_SECONDS = 10 * 60;

function signature(fileId: string, expires: number, secret: string): string {
  return createHmac("sha256", secret).update(`${fileId}.${expires}`).digest("base64url");
}

/** Build a short-lived public URL Bitrix can fetch without seeing the bot token. */
export function telegramPhotoUrl(
  fileId: string,
  baseUrl: string,
  secret: string,
  now = Date.now(),
): string {
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const url = new URL("/media/telegram/photo.jpg", baseUrl);
  url.searchParams.set("file_id", fileId);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature(fileId, expires, secret));
  return url.toString();
}

/** Validate the proxy URL before using its Telegram file id. */
export function validTelegramPhotoRequest(
  fileId: string,
  expiresRaw: string,
  supplied: string,
  secret: string,
  now = Date.now(),
): boolean {
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(now / 1000)) return false;

  const expected = signature(fileId, expires, secret);
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
