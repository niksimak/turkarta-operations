import { useSyncExternalStore } from "react";

export const TICK_MS = 15_000;

// One shared clock for every timer on screen: rows re-render together every
// 15 s instead of each row owning an interval.
let now = Date.now();
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const s of subscribers) s();
    }, TICK_MS);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) clearInterval(timer);
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
