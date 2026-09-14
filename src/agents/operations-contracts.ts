import { z } from "zod";

export const teams = ["support", "payments", "cards", "kyc", "engineering", "security", "support_lead"] as const;
export const OwnerRoute = z.object({ primary_tg: z.number().int().positive().safe(), backup_tg: z.number().int().positive().safe() }).strict();
export const OwnerRoutes = z.record(z.enum(teams), OwnerRoute);
export type OwnerRoutes = z.infer<typeof OwnerRoutes>;
export interface OperationsOptions {
  chatId: number;
  qaChatId?: number;
  routes: OwnerRoutes;
  acknowledgeMinutes: number;
  updateMinutes: number;
  maxReminders: number;
  digestHourUtc: number;
}
export interface InternalTask {
  id: string; ticket_id: string; job_id: string; team: string;
  through_seq: string | number; revision: number;
  primary_tg: string | number; backup_tg: string | number; owner_tg: string | number;
  status: "assigned" | "accepted" | "waiting" | "resolved" | "cancelled";
  summary_ru: string; money_related: boolean;
  due_at: string | Date; reminder_count: number; needs_attention: boolean;
}
export interface Notification {
  id: string; task_id: string | null; kind: "task" | "reminder" | "critical" | "digest";
  chat_id: string | number; payload: Record<string, unknown>; lease_token: string; attempts: number;
}
export const TaskSnapshot = z.object({
  classification: z.object({ summary_ru: z.string().max(1200) }),
  diagnostics: z.object({ summary_ru: z.string().max(2000) }).optional(),
  policy: z.object({ teams: z.array(z.enum(teams)).min(1).max(8),
    money_related: z.boolean(), off_topic_only: z.boolean() }),
});
export function taskSummary(snapshot: z.infer<typeof TaskSnapshot>) {
  return snapshot.diagnostics
    ? `${snapshot.classification.summary_ru.slice(0,250)}\n${snapshot.diagnostics.summary_ru.slice(0,640)}`
    : snapshot.classification.summary_ru;
}
export function routeFor(team: string, routes: OwnerRoutes) {
  return routes[team as keyof OwnerRoutes] ?? routes.support;
}
export function canAct(task: InternalTask, actor: number, action: "accept" | "update" | "wait" | "done") {
  if (task.status === "resolved" || task.status === "cancelled") return false;
  if (action === "accept") return task.status === "assigned"
    && [task.primary_tg, task.backup_tg, task.owner_tg].some((id) => Number(id) === actor);
  return task.status !== "assigned" && Number(task.owner_tg) === actor;
}
