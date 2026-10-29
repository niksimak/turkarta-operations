import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import type { ValidVideo } from "./support_media.js";

/** A web chat video already written to the bucket; the row keeps only its key. */
export interface StoredVideo {
  storageKey: string;
  mediaType: ValidVideo["mediaType"];
  filename: string;
  sizeBytes: number;
}

export interface VideoStore {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  /** The object, or a byte range of it when `range` is a `bytes=…` header. */
  get(key: string, range?: string): Promise<{ status: 200 | 206; body: ReadableStream; length: number; contentRange?: string }>;
}

let client: S3Client | null = null;

function s3(): S3Client {
  client ??= new S3Client({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL_S3,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID!, secretAccessKey: config.AWS_SECRET_ACCESS_KEY! },
  });
  return client;
}

export function videoStorageConfigured(): boolean {
  return Boolean(config.BUCKET_NAME && config.AWS_ENDPOINT_URL_S3 && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY);
}

const tigris: VideoStore = {
  async put(key, bytes, mediaType) {
    await s3().send(new PutObjectCommand({ Bucket: config.BUCKET_NAME, Key: key, Body: bytes, ContentType: mediaType }));
  },
  async get(key, range) {
    const out = await s3().send(new GetObjectCommand({ Bucket: config.BUCKET_NAME, Key: key, Range: range }));
    if (!out.Body) throw new Error("empty object body");
    return {
      status: out.ContentRange ? 206 : 200,
      body: out.Body.transformToWebStream(),
      length: out.ContentLength ?? 0,
      ...(out.ContentRange ? { contentRange: out.ContentRange } : {}),
    };
  },
};

let active: VideoStore = tigris;

/** Tests swap the bucket for an in-memory one. */
export function setVideoStore(store: VideoStore): void {
  active = store;
}

export function videoStore(): VideoStore {
  return active;
}

/** Write a validated web chat video under a fresh key. */
export async function storeVideo(video: ValidVideo): Promise<StoredVideo> {
  const storageKey = `support/video/${randomUUID()}/${video.filename}`;
  await active.put(storageKey, video.content, video.mediaType);
  return { storageKey, mediaType: video.mediaType, filename: video.filename, sizeBytes: video.content.length };
}

/** Stream a stored video to a browser; Range is passed to the bucket so Safari can seek. */
export async function storedVideoResponse(
  key: string,
  mediaType: string,
  range: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  let obj: Awaited<ReturnType<VideoStore["get"]>>;
  try {
    obj = await active.get(key, range);
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 416) return new Response(null, { status: 416, headers: { ...extraHeaders, "accept-ranges": "bytes" } });
    console.error(`[video-storage] get failed key=${key} status=${status ?? "error"}`);
    return Response.json({ error: "video_unavailable" }, { status: 502 });
  }
  return new Response(obj.body, {
    status: obj.status,
    headers: {
      ...extraHeaders,
      "content-type": mediaType,
      "accept-ranges": "bytes",
      "content-length": String(obj.length),
      ...(obj.contentRange ? { "content-range": obj.contentRange } : {}),
    },
  });
}
