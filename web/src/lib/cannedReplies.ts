import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, json } from "./api";
import type { Operator } from "./queries";
import { canEditTeamSettings } from "./settings";

// Mirrors src/crm/canned.ts (CannedReply), every field the «Шаблоны» page shows.
export interface CannedReplyFull {
  id: string;
  title: string;
  body: string;
  use_count: number;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export const TITLE_MAX = 80;
export const BODY_MAX = 4000;

// Same root as the composer's picker cache, so an edit here refreshes the picker too.
const CANNED_ROOT = ["canned"] as const;

export function useCannedPage(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: [...CANNED_ROOT, "page", query] as const,
    queryFn: () => api<CannedReplyFull[]>(query ? `/canned?q=${encodeURIComponent(query)}` : "/canned"),
    placeholderData: keepPreviousData,
  });
}

export interface CannedDraft {
  title: string;
  body: string;
}

export function useSaveCanned() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: CannedDraft }) =>
      id
        ? api<CannedReplyFull>(`/canned/${encodeURIComponent(id)}`, json("PUT", draft))
        : api<CannedReplyFull>("/canned", json("POST", draft)),
    onSettled: () => qc.invalidateQueries({ queryKey: CANNED_ROOT }),
  });
}

export function useDeleteCanned() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/canned/${encodeURIComponent(id)}`, json("DELETE")),
    onSettled: () => qc.invalidateQueries({ queryKey: CANNED_ROOT }),
  });
}

/** Everyone edits; deleting someone else's reply needs admin or lead. */
export function canDeleteCanned(reply: Pick<CannedReplyFull, "created_by">, me: Pick<Operator, "id" | "role" | "is_lead">): boolean {
  return reply.created_by === me.id || canEditTeamSettings(me);
}

/** Client check before the request, same limits as the server. */
export function validateCanned(d: CannedDraft): Partial<Record<keyof CannedDraft, string>> {
  const errors: Partial<Record<keyof CannedDraft, string>> = {};
  const title = d.title.trim();
  const body = d.body.trim();
  if (!title) errors.title = "Введите название.";
  else if (title.length > TITLE_MAX) errors.title = `Не длиннее ${TITLE_MAX} символов.`;
  if (!body) errors.body = "Введите текст.";
  else if (body.length > BODY_MAX) errors.body = `Не длиннее ${BODY_MAX} символов.`;
  return errors;
}

export function cannedErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Удалить чужой шаблон может только администратор или лид.";
    if (err.status === 404) return "Шаблон уже удалён. Обновите список.";
    if (err.status === 422) return "Проверьте название и текст.";
  }
  return "Не сохранилось. Повторите.";
}
