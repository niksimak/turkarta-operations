import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, json } from "./api";
import { keys, type Operator } from "./queries";
import { ticketKeys, type CrmSettings, type OperatorSummary } from "./tickets";

export type SettingKey = keyof CrmSettings;

// Mirrors src/crm/types.ts canEditTeamSettings.
export const canEditTeamSettings = (o: Pick<Operator, "role" | "is_lead">) => o.role === "admin" || o.is_lead;

type FieldKind = "minutes" | "percent" | "days" | "count" | "bool" | "text";

export interface FieldMeta {
  key: SettingKey;
  label: string;
  help: string;
  kind: FieldKind;
}

export interface FieldGroup {
  title: string;
  fields: FieldMeta[];
}

// Labels and help follow spec §13a, one short line each.
export const SETTING_GROUPS: FieldGroup[] = [
  {
    title: "Сроки ответа",
    fields: [
      { key: "sla_first_minutes", label: "Первый ответ", help: "Цель для первого ответа оператора.", kind: "minutes" },
      { key: "sla_followup_minutes", label: "Следующие ответы", help: "Цель для каждого следующего ответа.", kind: "minutes" },
      { key: "sla_warn_percent", label: "Предупреждение", help: "Таймер желтеет на этой доле цели.", kind: "percent" },
    ],
  },
  {
    title: "Автоназначение",
    fields: [
      { key: "auto_assign_enabled", label: "Автоназначение", help: "Раздавать обращения из очереди операторам на смене.", kind: "bool" },
      { key: "auto_assign_minutes", label: "Ждать в очереди", help: "Через столько минут без оператора обращение назначается.", kind: "minutes" },
      { key: "auto_assign_max_open", label: "Лимит открытых", help: "Пропускать оператора, у которого уже столько открытых. Пусто: без лимита.", kind: "count" },
      { key: "offline_after_minutes", label: "Снимать со смены", help: "Без активности столько минут «На смене» выключается.", kind: "minutes" },
    ],
  },
  {
    title: "Обращения",
    fields: [
      { key: "reopen_days", label: "Переоткрывать", help: "Сообщение клиента в этот срок после решения открывает обращение снова.", kind: "days" },
      { key: "resolve_message_enabled", label: "Сообщение при решении", help: "Отправлять клиенту текст, когда обращение решено.", kind: "bool" },
      { key: "resolve_message_text", label: "Текст сообщения", help: "До 1000 символов.", kind: "text" },
    ],
  },
  {
    title: "Пинги в Telegram-группу",
    fields: [
      { key: "tg_ping_new_ticket", label: "Новое обращение", help: "Сообщать о каждом новом обращении.", kind: "bool" },
      { key: "tg_ping_overdue", label: "Просрочка", help: "Сообщать, когда обращение просрочено.", kind: "bool" },
      { key: "tg_ping_no_one_on_shift", label: "Никого нет на смене", help: "Сообщать, когда автоназначению некому отдать обращение.", kind: "bool" },
    ],
  },
];

export const FIELD_META: Record<SettingKey, FieldMeta> = Object.fromEntries(
  SETTING_GROUPS.flatMap((g) => g.fields).map((f) => [f.key, f]),
) as Record<SettingKey, FieldMeta>;

export const UNIT: Partial<Record<FieldKind, string>> = { minutes: "мин", percent: "%", days: "дн.", count: "шт." };

/** A logged value in words: «5 мин», «вкл», «без лимита». */
export function formatSettingValue(key: string, value: unknown): string {
  const meta = FIELD_META[key as SettingKey];
  if (value === null || value === undefined) return key === "auto_assign_max_open" ? "без лимита" : "пусто";
  if (typeof value === "boolean") return value ? "вкл" : "выкл";
  if (typeof value === "number") {
    const unit = meta ? UNIT[meta.kind] : undefined;
    return unit ? `${value} ${unit}` : String(value);
  }
  const text = String(value);
  return text.length > 60 ? `«${text.slice(0, 59)}…»` : `«${text}»`;
}

export function settingLabel(key: string): string {
  return FIELD_META[key as SettingKey]?.label ?? key;
}

export interface SettingsLogEntry {
  key: string;
  old_value: unknown;
  new_value: unknown;
  operator_name: string | null;
  created_at: string;
}

export const settingsLogKey = ["settings", "log"] as const;

export function useTeamSettings() {
  return useQuery({ queryKey: ticketKeys.settings, queryFn: () => api<CrmSettings>("/settings") });
}

export function useSettingsLog(enabled: boolean) {
  return useQuery({ queryKey: settingsLogKey, queryFn: () => api<SettingsLogEntry[]>("/settings/log"), enabled });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CrmSettings>) => api<CrmSettings>("/settings", json("PUT", patch)),
    onSuccess: (settings) => {
      qc.setQueryData(ticketKeys.settings, settings);
      void qc.invalidateQueries({ queryKey: settingsLogKey });
    },
  });
}

/** Per-field Russian messages from a 422 {error:"validation", fields}. */
export function fieldErrorsOf(err: unknown): Record<string, string> | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const body = err.body as { error?: string; fields?: Record<string, string> } | undefined;
  return body?.error === "validation" && body.fields ? body.fields : null;
}

export type OperatorPatch = Partial<Pick<OperatorSummary, "is_lead" | "auto_assign_enabled" | "on_shift">>;

/** Optimistic on the operators list; rolls back when the server refuses. */
export function useUpdateOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: OperatorPatch }) =>
      api<OperatorSummary>(`/operators/${id}`, json("PUT", patch)),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ticketKeys.operators });
      const prev = qc.getQueryData<OperatorSummary[]>(ticketKeys.operators);
      if (prev) qc.setQueryData(ticketKeys.operators, prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ticketKeys.operators, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.operators });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}
