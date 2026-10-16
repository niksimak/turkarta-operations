import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const CRM_EVENT_TYPES = [
  "ticket.created",
  "ticket.updated",
  "message.created",
  "presence",
  "operator.updated",
  "notify",
] as const;

export type CrmEventType = (typeof CRM_EVENT_TYPES)[number];

export interface CrmEvent {
  type: CrmEventType;
  data: unknown;
}

export const STREAM_URL = "/crm/api/stream";
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** 1 s, 2 s, 4 s ... capped at 30 s. `attempt` counts consecutive failures from 0. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

type Listener = (event: CrmEvent) => void;
const listeners = new Set<Listener>();

/** Listen to the tab's single stream without opening another EventSource. */
export function onCrmEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

export interface StreamState {
  /** The stream is open right now. */
  connected: boolean;
  /** The stream dropped and is retrying: show «Переподключение…». */
  reconnecting: boolean;
}

/**
 * One EventSource per tab. On a drop it closes the source and retries with
 * exponential backoff; after a reconnect every query is invalidated, because
 * the server keeps no replay log.
 */
export function useCrmStream(onEvent: (event: CrmEvent) => void): StreamState {
  const queryClient = useQueryClient();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [state, setState] = useState<StreamState>({ connected: false, reconnecting: false });

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let droppedBefore = false;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(STREAM_URL);
      source = es;
      es.onopen = () => {
        attempt = 0;
        setState({ connected: true, reconnecting: false });
        if (droppedBefore) void queryClient.invalidateQueries();
      };
      es.onerror = () => {
        es.close();
        if (disposed) return;
        droppedBefore = true;
        setState({ connected: false, reconnecting: true });
        // EventSource hides the status code; a cheap API call surfaces a lost
        // session (401 redirects to login-failed) instead of retrying forever.
        api("/me").catch(() => undefined);
        timer = setTimeout(connect, backoffDelay(attempt));
        attempt += 1;
      };
      for (const type of CRM_EVENT_TYPES) {
        es.addEventListener(type, (msg) => {
          const event: CrmEvent = { type, data: parse((msg as MessageEvent<string>).data) };
          handler.current(event);
          for (const listener of listeners) listener(event);
        });
      }
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [queryClient]);

  return state;
}
