import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api, json } from "./api";
import { onCrmEvent } from "./sse";
import type { Viewer } from "./tickets";

// The server keeps presence for 10 s and publishes on every ping, so stale
// entries are dropped here on the same horizon (plus slack for the 5 s ping).
const STALE_MS = 12_000;
export const VIEWING_PING_MS = 5_000;
export const TYPING_THROTTLE_MS = 3_000;

type Entry = { viewers: Viewer[]; at: number };
const entries = new Map<string, Entry>();
const subscribers = new Set<() => void>();
let pruneTimer: ReturnType<typeof setInterval> | undefined;
const EMPTY: Viewer[] = [];

function emit() {
  for (const fn of subscribers) fn();
}

function sameViewers(a: Viewer[], b: Viewer[]): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => v.operatorId === b[i]!.operatorId && v.state === b[i]!.state && v.name === b[i]!.name)
  );
}

/** Repeated pings with the same viewers only refresh the timestamp; subscribers wake on real changes. */
export function setPresence(ticketId: string, viewers: Viewer[], at = Date.now()): void {
  const current = entries.get(ticketId);
  if (current && sameViewers(current.viewers, viewers)) {
    current.at = at;
    return;
  }
  if (!current && !viewers.length) return;
  if (viewers.length) entries.set(ticketId, { viewers, at });
  else entries.delete(ticketId);
  emit();
}

export function prunePresence(now = Date.now()): void {
  let changed = false;
  for (const [id, e] of entries) {
    if (now - e.at > STALE_MS) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

export function resetPresenceForTests(): void {
  entries.clear();
  emit();
}

function isPresenceEvent(data: unknown): data is { ticketId: string; viewers: Viewer[] } {
  const d = data as { ticketId?: unknown; viewers?: unknown } | null;
  return Boolean(d && typeof d.ticketId === "string" && Array.isArray(d.viewers));
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) pruneTimer = setInterval(() => prunePresence(), 2_000);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) clearInterval(pruneTimer);
  };
}

/** Feeds SSE presence events into the store while the inbox is mounted. */
export function usePresenceFeed(): void {
  useEffect(
    () =>
      onCrmEvent((event) => {
        if (event.type === "presence" && isPresenceEvent(event.data)) {
          setPresence(event.data.ticketId, event.data.viewers);
        }
      }),
    [],
  );
}

/**
 * Everyone on one ticket except me. Subscribes to that ticket only: the
 * snapshot is the stored array, so other tickets' updates do not re-render.
 */
export function usePresence(ticketId: string, meId: number | undefined): Viewer[] {
  const getSnapshot = useCallback(() => entries.get(ticketId)?.viewers ?? EMPTY, [ticketId]);
  const viewers = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => (meId === undefined ? viewers : viewers.filter((v) => v.operatorId !== meId)), [viewers, meId]);
}

function ping(ticketId: string, state: Viewer["state"]) {
  api(`/tickets/${encodeURIComponent(ticketId)}/presence`, json("POST", { state })).catch(() => undefined);
}

/** «Смотрит» every 5 s while the ticket is open. */
export function useViewingPresence(ticketId: string | undefined): void {
  useEffect(() => {
    if (!ticketId) return;
    ping(ticketId, "viewing");
    const timer = setInterval(() => ping(ticketId, "viewing"), VIEWING_PING_MS);
    return () => clearInterval(timer);
  }, [ticketId]);
}

/** Returns a function the composer calls on every input; it pings «печатает» at most every 3 s. */
export function useTypingPresence(ticketId: string): () => void {
  const last = useRef(0);
  useEffect(() => {
    last.current = 0;
  }, [ticketId]);
  return useCallback(() => {
    const now = Date.now();
    if (now - last.current < TYPING_THROTTLE_MS) return;
    last.current = now;
    ping(ticketId, "typing");
  }, [ticketId]);
}
