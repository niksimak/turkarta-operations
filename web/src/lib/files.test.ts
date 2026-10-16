import { describe, expect, it } from "vitest";
import { acceptFiles, MAX_PHOTO_BYTES, MAX_PHOTOS } from "./files";

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
