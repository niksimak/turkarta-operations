import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api, json } from "./api";
import { onCrmEvent } from "./sse";
import type { Viewer } from "./tickets";

// The server keeps presence for 10 s and only publishes on change, so stale
// entries are dropped here on the same horizon (plus slack for the 5 s ping).
const STALE_MS = 12_000;
export const VIEWING_PING_MS = 5_000;
export const TYPING_THROTTLE_MS = 3_000;

type Entry = { viewers: Viewer[]; at: number };
let entries = new Map<string, Entry>();
const subscribers = new Set<() => void>();
let pruneTimer: ReturnType<typeof setInterval> | undefined;

function emit() {
  for (const fn of subscribers) fn();
}

export function setPresence(ticketId: string, viewers: Viewer[], at = Date.now()): void {
  const next = new Map(entries);
  if (viewers.length) next.set(ticketId, { viewers, at });
  else next.delete(ticketId);
  entries = next;
  emit();
}

export function prunePresence(now = Date.now()): void {
  let changed = false;
  const next = new Map(entries);
  for (const [id, e] of next) {
    if (now - e.at > STALE_MS) {
      next.delete(id);
      changed = true;
    }
  }
  if (changed) {
    entries = next;
    emit();
  }
}

export function resetPresenceForTests(): void {
  entries = new Map();
  emit();
}

function isPresenceEvent(data: unknown): data is { ticketId: string; viewers: Viewer[] } {
  const d = data as { ticketId?: unknown; viewers?: unknown } | null;
  return Boolean(d && typeof d.ticketId === "string" && Array.isArray(d.viewers));
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    pruneTimer = setInterval(() => prunePresence(), 2_000);
  }
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

/** Everyone looking at a ticket except me. */
export function usePresence(ticketId: string, meId: number | undefined): Viewer[] {
  const all = useSyncExternalStore(subscribe, () => entries);
  const viewers = all.get(ticketId)?.viewers ?? EMPTY;
  return meId === undefined ? viewers : viewers.filter((v) => v.operatorId !== meId);
}

const EMPTY: Viewer[] = [];

/** Every ticket's viewers except me, for the list. */
export function usePresenceMap(meId: number | undefined): Map<string, Viewer[]> {
  const all = useSyncExternalStore(subscribe, () => entries);
  return useMemo(() => {
    const out = new Map<string, Viewer[]>();
    for (const [id, e] of all) {
      const others = e.viewers.filter((v) => v.operatorId !== meId);
      if (others.length) out.set(id, others);
    }
    return out;
  }, [all, meId]);
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
  return () => {
    const now = Date.now();
    if (now - last.current < TYPING_THROTTLE_MS) return;
    last.current = now;
    ping(ticketId, "typing");
  };
}
