import { describe, expect, it } from "vitest";
import { optimisticMessage, sendErrorText, sendForm } from "./tickets";
import { ApiError } from "./api";

const file = (name: string, type: string) => new File([new Uint8Array(4)], name, { type });

describe("sending a video", () => {
  it("goes in the `video` field, photos stay in `photos`", () => {
    const v = sendForm({ clientKey: "k", kind: "reply", body: "смотрите", photos: [file("how.mp4", "video/mp4")] });
    expect(v.getAll("video").map((f) => (f as File).name)).toEqual(["how.mp4"]);
    expect(v.getAll("photos")).toEqual([]);
    const p = sendForm({ clientKey: "k", kind: "reply", body: "", photos: [file("a.jpg", "image/jpeg")] });
    expect(p.getAll("photos").length).toBe(1);
    expect(p.getAll("video")).toEqual([]);
  });

  it("shows as a video in the thread before the server confirms it", () => {
    const m = optimisticMessage({ clientKey: "k", kind: "reply", body: "", photos: [file("how.mp4", "video/mp4")] }, undefined, undefined, ["blob:1"]);
    expect(m.kind).toBe("video");
    expect(m.attachments[0]).toMatchObject({ media_type: "video/mp4", preview: "blob:1" });
  });

  it("explains a refused video", () => {
    expect(sendErrorText(new ApiError(422, { error: "video_invalid" }), []).text).toBe(
      "Видео не принято: нужен MP4, MOV или WEBM до 20 МБ.",
    );
  });
});
