import { describe, expect, it } from "vitest";
import { matchOperators, mentionQuery } from "./mentions";

describe("mentionQuery", () => {
  it("opens after an @ at a word start", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionQuery("Позови @Ол", 10)).toEqual({ start: 7, end: 10, query: "Ол" });
    expect(mentionQuery("Позови @Аня См", 14)).toEqual({ start: 7, end: 14, query: "Аня См" });
  });

  it("ignores emails, other lines and long runs", () => {
    expect(mentionQuery("mail@example", 12)).toBeNull();
    expect(mentionQuery("@Оля\nдальше", 11)).toBeNull();
    expect(mentionQuery(`@${"а".repeat(41)}`, 42)).toBeNull();
  });
});

describe("matchOperators", () => {
  const ops = [
    { id: 1, name: "Аня Смирнова" },
    { id: 2, name: "Олег" },
    { id: 3, name: "Мария Олейник" },
  ];
  it("matches the name or any word of it from the start, case-insensitive", () => {
    expect(matchOperators(ops, "ол").map((o) => o.id)).toEqual([2, 3]);
    expect(matchOperators(ops, "аня см").map((o) => o.id)).toEqual([1]);
    expect(matchOperators(ops, "").map((o) => o.id)).toEqual([1, 2, 3]);
    expect(matchOperators(ops, "z")).toEqual([]);
  });
});
