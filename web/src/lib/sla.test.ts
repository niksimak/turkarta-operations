import { describe, expect, it } from "vitest";
import { formatWait, slaState, slaTarget } from "./sla";

const settings = { sla_first_minutes: 5, sla_followup_minutes: 15, sla_warn_percent: 50 };
const now = Date.parse("2026-10-16T12:00:00Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

describe("slaState", () => {
  it("is none when nobody is waiting", () => {
    expect(slaState(null, null, settings, now)).toEqual({ minutes: 0, level: "none" });
    expect(slaState(null, ago(30), settings, now)).toEqual({ minutes: 0, level: "none" });
  });

  it("is ok at 2 min before the first response", () => {
    expect(slaState(ago(2), null, settings, now)).toEqual({ minutes: 2, level: "ok" });
  });

  it("warns at 3 min with a 5-min target and 50%", () => {
    expect(slaState(ago(3), null, settings, now)).toEqual({ minutes: 3, level: "warn" });
  });

  it("warns from the exact warn share, not before", () => {
    expect(slaState(ago(2.49), null, settings, now).level).toBe("ok");
    expect(slaState(ago(2.5), null, settings, now).level).toBe("warn");
  });

  it("is late at 6 min with a 5-min target", () => {
    expect(slaState(ago(6), null, settings, now)).toEqual({ minutes: 6, level: "late" });
  });

  it("turns late only past the target, like the server's overdue filter", () => {
    expect(slaState(ago(5), null, settings, now).level).toBe("warn");
    expect(slaState(ago(5.01), null, settings, now).level).toBe("late");
  });

  it("uses the follow-up target once the first response is set", () => {
    const answered = ago(60);
    expect(slaState(ago(6), answered, settings, now)).toEqual({ minutes: 6, level: "ok" });
    expect(slaState(ago(8), answered, settings, now)).toEqual({ minutes: 8, level: "warn" });
    expect(slaState(ago(16), answered, settings, now)).toEqual({ minutes: 16, level: "late" });
  });

  it("accepts a Date for now and clamps clock skew to zero", () => {
    expect(slaState(new Date(now + 30_000).toISOString(), null, settings, new Date(now))).toEqual({
      minutes: 0,
      level: "ok",
    });
  });

  it("treats an unparseable timestamp as nobody waiting", () => {
    expect(slaState("garbage", null, settings, now)).toEqual({ minutes: 0, level: "none" });
  });
});

describe("slaTarget", () => {
  it("picks first or follow-up minutes", () => {
    expect(slaTarget(null, settings)).toBe(5);
    expect(slaTarget(ago(1), settings)).toBe(15);
  });
});

describe("formatWait", () => {
  it("is compact for the list badge", () => {
    expect(formatWait(0)).toBe("0 мин");
    expect(formatWait(59)).toBe("59 мин");
    expect(formatWait(60)).toBe("1 ч");
    expect(formatWait(135)).toBe("2 ч");
    expect(formatWait(60 * 24 * 3 + 5)).toBe("3 д");
  });
  it("is exact for tooltips", () => {
    expect(formatWait(135, true)).toBe("2 ч 15 мин");
    expect(formatWait(60, true)).toBe("1 ч");
    expect(formatWait(7, true)).toBe("7 мин");
  });
});
