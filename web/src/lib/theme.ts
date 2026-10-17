import { useEffect } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const STORAGE_KEY = "crm.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePref(value: unknown): value is ThemePref {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

function systemQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
}

/** The last choice on this device, so the right theme paints before /me loads. */
export function storedThemePref(): ThemePref {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemePref(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function storeThemePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Private mode or blocked storage: the server copy in prefs still holds.
  }
}

/** One-shot: sets data-theme on <html> without following OS changes. */
export function paintTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref, systemQuery()?.matches ?? false);
}

/** Like paintTheme, but for "system" keeps following the OS until the cleanup runs. */
export function applyTheme(pref: ThemePref): () => void {
  const query = systemQuery();
  const set = () => paintTheme(pref);
  set();
  if (pref !== "system" || !query) return () => undefined;
  query.addEventListener("change", set);
  return () => query.removeEventListener("change", set);
}

export function useTheme(pref: ThemePref): void {
  useEffect(() => {
    storeThemePref(pref);
    return applyTheme(pref);
  }, [pref]);
}
