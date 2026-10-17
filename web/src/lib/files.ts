// Mirrors src/support_media.ts and the reply route: what the server will take.
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS = 10;
export const PHOTO_ACCEPT = PHOTO_TYPES.join(",");

export type RejectReason = "type" | "size" | "limit";

export interface AcceptResult {
  accepted: File[];
  rejected: Array<{ name: string; reason: RejectReason }>;
}

export const REJECT_TEXT: Record<RejectReason, string> = {
  type: "только фото: JPG, PNG, WEBP",
  size: "больше 8 МБ",
  limit: "не больше 10 фото",
};

const isPhotoType = (type: string) => (PHOTO_TYPES as readonly string[]).includes(type.toLowerCase());

/** Splits incoming files into what fits next to `existing` and what does not, with a reason per file. */
export function acceptFiles(existing: File[], incoming: File[]): AcceptResult {
  const accepted: File[] = [];
  const rejected: AcceptResult["rejected"] = [];
  for (const f of incoming) {
    if (!isPhotoType(f.type)) rejected.push({ name: f.name, reason: "type" });
    else if (f.size > MAX_PHOTO_BYTES) rejected.push({ name: f.name, reason: "size" });
    else if (existing.length + accepted.length >= MAX_PHOTOS) rejected.push({ name: f.name, reason: "limit" });
    else accepted.push(f);
  }
  return { accepted, rejected };
}

/** Rejections grouped by reason, in a fixed order: one toast each. */
export function groupRejections(rejected: AcceptResult["rejected"]): Array<{ reason: RejectReason; names: string[] }> {
  return (["type", "size", "limit"] as const)
    .map((reason) => ({ reason, names: rejected.filter((r) => r.reason === reason).map((r) => r.name) }))
    .filter((g) => g.names.length > 0);
}

/** «a.pdf, b.gif и ещё 3» */
export function nameList(names: string[], max = 3): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} и ещё ${names.length - max}` : shown;
}

/** A drag that carries files from the OS, not text or a link dragged inside the page. */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes("Files"));
}
