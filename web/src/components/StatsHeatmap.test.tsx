import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatsHeatmap } from "./StatsHeatmap";

describe("StatsHeatmap", () => {
  afterEach(cleanup);

  it("says so when the range has no new tickets", () => {
    render(<StatsHeatmap cells={[]} />);
    expect(screen.getByText("За период новых обращений нет.")).toBeTruthy();
  });

  it("puts each count in its weekday row and hour column, busiest cell darkest", () => {
    render(<StatsHeatmap cells={[{ dow: 4, hour: 10, n: 4 }, { dow: 7, hour: 23, n: 1 }]} />);
    const busy = screen.getByTitle("Чт, 10:00–10:59: 4");
    const quiet = screen.getByTitle("Вс, 23:00–23:59: 1");
    expect(screen.getByTitle("Пн, 0:00–0:59: 0")).toBeTruthy();
    const opacity = (cell: HTMLElement) => Number((cell.querySelector("[data-fill]") as HTMLElement).style.opacity);
    expect(opacity(busy)).toBe(1);
    expect(opacity(quiet)).toBeCloseTo(0.4);
    expect(screen.getByRole("table", { name: "Новые обращения по дням недели и часам" })).toBeTruthy();
  });
});
