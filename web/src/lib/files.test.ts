import { describe, expect, it } from "vitest";
import { acceptFiles, ATTACH_ACCEPT, MAX_PHOTO_BYTES, MAX_PHOTOS, MAX_VIDEO_BYTES, REJECT_TEXT } from "./files";

const file = (name: string, type: string, size = 1024) => new File([new Uint8Array(size)], name, { type });
const jpg = (n: number) => file(`p${n}.jpg`, "image/jpeg");

describe("acceptFiles", () => {
  it("keeps the valid files of a mixed drop and names each rejected one", () => {
    const big = file("huge.png", "image/png", MAX_PHOTO_BYTES + 1);
    const pdf = file("doc.pdf", "application/pdf");
    const ok = [jpg(1), file("a.png", "image/png"), file("b.webp", "image/webp")];
    const res = acceptFiles([], [ok[0]!, pdf, ok[1]!, big, ok[2]!]);
    expect(res.accepted).toEqual(ok);
    expect(res.rejected).toEqual([
      { name: "doc.pdf", reason: "type" },
      { name: "huge.png", reason: "size" },
    ]);
  });

  it("rejects a .gif as type", () => {
    expect(acceptFiles([], [file("cat.gif", "image/gif")])).toEqual({ accepted: [], rejected: [{ name: "cat.gif", reason: "type" }] });
  });

  it("accepts a photo of exactly 8 MB", () => {
    const edge = file("edge.jpg", "image/jpeg", MAX_PHOTO_BYTES);
    expect(acceptFiles([], [edge]).accepted).toEqual([edge]);
  });

  it("rejects the 11th photo as limit, counting what is already attached", () => {
    const existing = Array.from({ length: 8 }, (_, i) => jpg(i));
    const incoming = [jpg(8), jpg(9), jpg(10)];
    const res = acceptFiles(existing, incoming);
    expect(MAX_PHOTOS).toBe(10);
    expect(res.accepted).toEqual([incoming[0], incoming[1]]);
    expect(res.rejected).toEqual([{ name: "p10.jpg", reason: "limit" }]);
  });

  it("reports type and size before limit, so a full strip still explains a pdf", () => {
    const full = Array.from({ length: 10 }, (_, i) => jpg(i));
    const res = acceptFiles(full, [file("doc.pdf", "application/pdf"), jpg(11)]);
    expect(res.rejected).toEqual([
      { name: "doc.pdf", reason: "type" },
      { name: "p11.jpg", reason: "limit" },
    ]);
  });
});

describe("acceptFiles with video", () => {
  const mp4 = (name = "how.mp4", size = 1024) => file(name, "video/mp4", size);

  it("takes one video of up to 20 MB on its own, mp4 / mov / webm", () => {
    expect(MAX_VIDEO_BYTES).toBe(20 * 1024 * 1024);
    for (const v of [mp4("a.mp4", MAX_VIDEO_BYTES), file("IMG.MOV", "video/quicktime"), file("r.webm", "video/webm")]) {
      expect(acceptFiles([], [v]).accepted).toEqual([v]);
    }
    expect(ATTACH_ACCEPT).toContain("video/mp4");
    expect(ATTACH_ACCEPT).toContain("image/jpeg");
  });

  it("refuses a video over 20 MB, a second video, and mixing with photos", () => {
    expect(acceptFiles([], [mp4("big.mp4", MAX_VIDEO_BYTES + 1)]).rejected).toEqual([{ name: "big.mp4", reason: "video_size" }]);
    expect(acceptFiles([mp4()], [mp4("b.mp4")]).rejected).toEqual([{ name: "b.mp4", reason: "mixed" }]);
    expect(acceptFiles([jpg(1)], [mp4()]).rejected).toEqual([{ name: "how.mp4", reason: "mixed" }]);
    expect(acceptFiles([mp4()], [jpg(1)]).rejected).toEqual([{ name: "p1.jpg", reason: "mixed" }]);
    const both = acceptFiles([], [mp4(), jpg(2)]);
    expect(both.accepted.map((f) => f.name)).toEqual(["how.mp4"]);
    expect(both.rejected).toEqual([{ name: "p2.jpg", reason: "mixed" }]);
    expect(REJECT_TEXT.mixed).toBe("одно видео без фото в сообщении");
    expect(REJECT_TEXT.video_size).toBe("видео больше 20 МБ");
  });
});
