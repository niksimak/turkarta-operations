import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, paintTheme, resolveTheme, storedThemePref, storeThemePref } from "./theme";

function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    listeners,
    setDark(value: boolean) {
      query.matches = value;
      for (const fn of listeners) fn();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  window.localStorage.clear();
});

describe("resolveTheme", () => {
  it("uses the explicit choice, or the OS for system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("follows OS changes for system until cleaned up", () => {
    const media = stubMatchMedia(false);
    const stop = applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    media.setDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
    expect(media.listeners.size).toBe(0);
    media.setDark(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores the OS for an explicit choice", () => {
    const media = stubMatchMedia(true);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(media.listeners.size).toBe(0);
  });

  it("paintTheme sets the attribute without subscribing", () => {
    const media = stubMatchMedia(true);
    paintTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(media.listeners.size).toBe(0);
  });
});

describe("stored preference", () => {
  it("round-trips a valid value and falls back to system", () => {
    expect(storedThemePref()).toBe("system");
    storeThemePref("dark");
    expect(storedThemePref()).toBe("dark");
    window.localStorage.setItem("crm.theme", "neon");
    expect(storedThemePref()).toBe("system");
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => storeThemePref("dark")).not.toThrow();
    expect(storedThemePref()).toBe("system");
  });
});
