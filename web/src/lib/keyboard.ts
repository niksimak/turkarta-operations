import { useEffect, useRef } from "react";

export type KeyAction = "next" | "prev" | "open" | "take" | "resolve" | "goQueue" | "goMine" | "goAll";

// Matched on `code`, so the shortcuts work on the Russian layout too (J is «О» there).
const SINGLE: Record<string, KeyAction> = {
  KeyJ: "next",
  KeyK: "prev",
  Enter: "open",
  NumpadEnter: "open",
  KeyA: "take",
  KeyE: "resolve",
};

const AFTER_G: Record<string, KeyAction> = {
  KeyQ: "goQueue",
  KeyM: "goMine",
  KeyA: "goAll",
};

export const SEQUENCE_MS = 1_000;

/** Typing, choosing in a menu or a dialog owns the keyboard; shortcuts stay out of the way. */
export function isShortcutBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest('[role="menu"], [role="dialog"], [role="listbox"]')) return true;
  return false;
}

interface KeyLike {
  code: string;
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  timeStamp: number;
}

/** A stateful matcher for one key stream: returns the action or null. Handles the `g` prefix. */
export function createKeyMatcher(sequenceMs = SEQUENCE_MS) {
  let gAt: number | null = null;
  return (e: KeyLike): KeyAction | null => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
    if (isShortcutBlocked(e.target)) return null;
    const code = e.code || keyToCode(e.key);
    if (gAt !== null) {
      const fresh = e.timeStamp - gAt <= sequenceMs;
      gAt = null;
      if (fresh && AFTER_G[code]) return AFTER_G[code]!;
    }
    if (code === "KeyG") {
      gAt = e.timeStamp;
      return null;
    }
    if (e.repeat && code !== "KeyJ" && code !== "KeyK") return null;
    return SINGLE[code] ?? null;
  };
}

// Some test environments and old browsers leave `code` empty.
function keyToCode(key: string): string {
  if (key === "Enter") return "Enter";
  return key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
}

/** Window-level shortcuts for the inbox. The handler ref stays fresh without rebinding. */
export function useShortcuts(onAction: (action: KeyAction, e: KeyboardEvent) => void, enabled = true): void {
  const handler = useRef(onAction);
  handler.current = onAction;
  useEffect(() => {
    if (!enabled) return;
    const match = createKeyMatcher();
    const listener = (e: KeyboardEvent) => {
      const action = match(e);
      if (!action) return;
      // Enter on a focused link or button already does its own thing.
      if (action === "open" && e.target instanceof Element && e.target.closest("a, button")) return;
      e.preventDefault();
      handler.current(action, e);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled]);
}
