import { describe, expect, it } from "vitest";
import { fillTemplate, searchCanned, slashQuery, type CannedReply } from "./canned";

describe("fillTemplate", () => {
  it("fills {имя} and {оператор}", () => {
    expect(fillTemplate("Здравствуйте, {имя}! Это {оператор}. {имя}, всё в порядке?", { имя: "Иван", оператор: "Аня" })).toBe(
      "Здравствуйте, Иван! Это Аня. Иван, всё в порядке?",
    );
  });

  it("turns missing values into empty strings", () => {
    expect(fillTemplate("Привет, {имя}. {оператор}", { имя: null })).toBe("Привет, . ");
    expect(fillTemplate("{имя}{оператор}", {})).toBe("");
  });

  it("leaves unknown placeholders as they are", () => {
    expect(fillTemplate("{сумма} для {имя}, {name}", { имя: "Иван" })).toBe("{сумма} для Иван, {name}");
  });
});

const reply = (id: string, title: string, body: string, use_count = 0): CannedReply => ({
  id, title, body, use_count, created_by: null,
});

describe("searchCanned", () => {
  const list = [
    reply("1", "Приветствие", "Здравствуйте, {имя}!", 50),
    reply("2", "Код не пришёл", "Проверьте папку спам и номер телефона.", 10),
    reply("3", "Возврат", "Деньги вернутся за 3 дня.", 5),
  ];

  it("returns everything by usage for an empty query", () => {
    expect(searchCanned(list, "").map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("matches title and body as a fuzzy subsequence, title first", () => {
    expect(searchCanned(list, "код").map((r) => r.id)).toEqual(["2"]);
    expect(searchCanned(list, "спам").map((r) => r.id)).toEqual(["2"]);
    expect(searchCanned(list, "вз").map((r) => r.id)[0]).toBe("3");
    expect(searchCanned(list, "xyz")).toEqual([]);
  });
});

describe("slashQuery", () => {
  it("opens on a slash at the start of the caret's line", () => {
    expect(slashQuery("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(slashQuery("Привет\n/ко", 10)).toEqual({ start: 7, end: 10, query: "ко" });
  });

  it("stays closed for a slash mid-line or on another line", () => {
    expect(slashQuery("и/или", 5)).toBeNull();
    expect(slashQuery("/код\nдальше", 11)).toBeNull();
  });
});
