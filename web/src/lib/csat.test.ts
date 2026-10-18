import { describe, expect, it } from "vitest";
import { csatText } from "./csat";
import { formatPercent } from "./stats";

describe("csatText", () => {
  it("says there are no ratings yet", () => {
    expect(csatText(null, 0)).toBe("нет оценок");
  });
  it("hides the percent while there are too few answers", () => {
    expect(csatText(100, 3)).toBe("мало оценок (3)");
  });
  it("shows the percent from five answers", () => {
    expect(csatText(80, 5)).toBe(formatPercent(80));
  });
});
