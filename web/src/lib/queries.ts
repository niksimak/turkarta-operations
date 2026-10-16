import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, json } from "./api";
import type { ThemePref } from "./theme";

// Mirrors src/crm/types.ts (Operator, OperatorPrefs).
export interface OperatorPrefs {
  theme: ThemePref;
  sound: boolean;
  volume: number;
  desktop: boolean;
  notify_scope: "all" | "mine";
  send_key: "enter" | "mod_enter";
}

export interface Operator {
  id: number;
  name: string;
  email: string | null;
  role: "admin" | "support";
  is_lead: boolean;
  auto_assign_enabled: boolean;
  on_shift: boolean;
  last_active_at: string | null;
  last_assigned_at: string | null;
  prefs: OperatorPrefs;
}

export interface TicketCounts {
  queue: number;
  mine: number;
  overdue: number;
}

export const keys = {
  me: ["me"] as const,
  tickets: ["tickets"] as const,
  counts: ["tickets", "counts"] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Operator>("/me") });
}

export function useCounts(enabled: boolean) {
  return useQuery({
    queryKey: keys.counts,
    queryFn: async () =>
      (await api<{ counts: TicketCounts }>("/tickets?view=queue&limit=1")).counts,
    enabled,
    // SSE invalidates on every ticket event; this only covers a quiet stream.
    refetchInterval: 60_000,
  });
}

/** Optimistic write to the cached operator; rolls back if the server refuses. */
function useOptimisticMe<V>(request: (vars: V) => Promise<unknown>, patch: (me: Operator, vars: V) => Operator) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onMutate: async (vars: V) => {
      await qc.cancelQueries({ queryKey: keys.me });
      const prev = qc.getQueryData<Operator>(keys.me);
      if (prev) qc.setQueryData(keys.me, patch(prev, vars));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.me, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useSetShift() {
  return useOptimisticMe<boolean>(
    (on) => api("/me/shift", json("POST", { on })),
    (me, on) => ({ ...me, on_shift: on }),
  );
}

export function useUpdatePrefs() {
  return useOptimisticMe<Partial<OperatorPrefs>>(
    (patch) => api("/me/prefs", json("PUT", patch)),
    (me, patch) => ({ ...me, prefs: { ...me.prefs, ...patch } }),
  );
}

export const HEARTBEAT_MS = 60_000;

/** Keeps «На смене» alive: a heartbeat every minute while the tab is open, visible or not. */
export function useHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const beat = () => {
      api("/me/heartbeat", json("POST")).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [enabled]);
}
