import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, json } from "./api";

// Mirrors src/crm/topics.ts.
export interface Topic {
  id: number;
  name: string;
  position: number;
  archived: boolean;
}

export const topicKeys = { all: ["topics"] as const };

export function useTopics() {
  return useQuery({ queryKey: topicKeys.all, queryFn: () => api<Topic[]>("/topics"), staleTime: 5 * 60_000 });
}

export function useCreateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string }) => api<Topic>("/topics", json("POST", v)),
    onSettled: () => qc.invalidateQueries({ queryKey: topicKeys.all }),
  });
}

export function useUpdateTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<Topic, "name" | "position" | "archived">> }) =>
      api<Topic>(`/topics/${id}`, json("PUT", patch)),
    onSettled: () => qc.invalidateQueries({ queryKey: topicKeys.all }),
  });
}
