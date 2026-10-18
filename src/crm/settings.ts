import { z } from "zod";
import { sql } from "../db.js";

export const SettingsSchema = z.object({
  sla_first_minutes: z.number().int().min(1).max(240),
  sla_followup_minutes: z.number().int().min(1).max(240),
  sla_warn_percent: z.number().int().min(10).max(90),
  auto_assign_enabled: z.boolean(),
  auto_assign_minutes: z.number().int().min(1).max(240),
  auto_assign_max_open: z.number().int().min(1).max(500).nullable(),
  offline_after_minutes: z.number().int().min(1).max(240),
  reopen_days: z.number().int().min(0).max(30),
  tg_ping_new_ticket: z.boolean(),
  tg_ping_overdue: z.boolean(),
  tg_ping_no_one_on_shift: z.boolean(),
  resolve_message_enabled: z.boolean(),
  resolve_message_text: z.string().trim().min(1).max(1000),
  csat_enabled: z.boolean(),
  csat_text: z.string().trim().min(1).max(200),
});
export type Settings = z.infer<typeof SettingsSchema>;
type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  sla_first_minutes: 5,
  sla_followup_minutes: 15,
  sla_warn_percent: 50,
  auto_assign_enabled: true,
  auto_assign_minutes: 5,
  auto_assign_max_open: null,
  offline_after_minutes: 15,
  reopen_days: 7,
  tg_ping_new_ticket: true,
  tg_ping_overdue: true,
  tg_ping_no_one_on_shift: true,
  resolve_message_enabled: false,
  resolve_message_text: "Мы закрыли обращение. Если вопрос остался, просто напишите сюда.",
  csat_enabled: true,
  csat_text: "Мы смогли вам помочь?",
};

const KEYS = Object.keys(SettingsSchema.shape) as SettingKey[];

const FIELD_ERRORS: Record<SettingKey, string> = {
  sla_first_minutes: "От 1 до 240 минут",
  sla_followup_minutes: "От 1 до 240 минут",
  sla_warn_percent: "От 10 до 90 процентов",
  auto_assign_enabled: "Выберите да или нет",
  auto_assign_minutes: "От 1 до 240 минут",
  auto_assign_max_open: "От 1 до 500 или пусто, если лимита нет",
  offline_after_minutes: "От 1 до 240 минут",
  reopen_days: "От 0 до 30 дней",
  tg_ping_new_ticket: "Выберите да или нет",
  tg_ping_overdue: "Выберите да или нет",
  tg_ping_no_one_on_shift: "Выберите да или нет",
  resolve_message_enabled: "Выберите да или нет",
  resolve_message_text: "От 1 до 1000 символов",
  csat_enabled: "Выберите да или нет",
  csat_text: "От 1 до 200 символов",
};

const PatchSchema = SettingsSchema.partial().strict();

export type SettingsValidation =
  | { ok: true; value: Partial<Settings> }
  | { ok: false; errors: Record<string, string> };

export function validateSettingsPatch(patch: unknown): SettingsValidation {
  const parsed = PatchSchema.safeParse(patch);
  if (parsed.success) {
    // zod keeps explicit undefined; drop it so "key present" means "key changes".
    const value = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    return { ok: true, value: value as Partial<Settings> };
  }
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) errors[k] = "Неизвестная настройка";
      continue;
    }
    const key = issue.path[0];
    if (typeof key === "string" && key in FIELD_ERRORS) errors[key] = FIELD_ERRORS[key as SettingKey];
    else errors._form = "Неверный формат данных";
  }
  return { ok: false, errors };
}

/** Defaults merged with stored rows; a stored value that fails validation falls back to its default. */
function merge(rows: ReadonlyArray<{ key: string; value: unknown }>): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!(row.key in SettingsSchema.shape)) continue;
    const r = SettingsSchema.shape[row.key as SettingKey].safeParse(row.value);
    if (r.success) out[row.key] = r.data;
  }
  return out as Settings;
}

// No cache on purpose: workers call this each tick so edits apply within 30 s.
export async function getSettings(): Promise<Settings> {
  const rows = await sql`select key, value from public.crm_settings`;
  return merge(rows as unknown as Array<{ key: string; value: unknown }>);
}

const LOCK_KEY = 160016;

export async function updateSettings(
  patch: unknown,
  operatorId: number,
): Promise<{ ok: true; settings: Settings } | { ok: false; errors: Record<string, string> }> {
  const v = validateSettingsPatch(patch);
  if (!v.ok) return v;
  const settings = await sql.begin(async (tx) => {
    // Serializes writers so old_value in the log matches what was really replaced.
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    const rows = await tx`select key, value from public.crm_settings`;
    const current = merge(rows as unknown as Array<{ key: string; value: unknown }>);
    for (const key of KEYS) {
      if (!(key in v.value)) continue;
      const next = v.value[key];
      if (JSON.stringify(next) === JSON.stringify(current[key])) continue;
      await tx`insert into public.crm_settings (key, value, updated_at)
        values (${key}, ${JSON.stringify(next)}::text::jsonb, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
      await tx`insert into public.crm_settings_log (key, old_value, new_value, operator_id)
        values (${key}, ${JSON.stringify(current[key])}::text::jsonb, ${JSON.stringify(next)}::text::jsonb, ${operatorId})`;
      (current as Record<string, unknown>)[key] = next;
    }
    return current;
  });
  return { ok: true, settings };
}

export async function settingsLog(limit = 50): Promise<Array<{
  key: string; old_value: unknown; new_value: unknown; operator_name: string | null; created_at: string;
}>> {
  const rows = await sql`select l.key, l.old_value, l.new_value, o.name as operator_name, l.created_at
    from public.crm_settings_log l
    left join public.crm_operators o on o.id = l.operator_id
    order by l.created_at desc, l.id desc
    limit ${limit}`;
  return rows.map((r) => ({
    key: String(r.key),
    // A write from outside the UI may log no old value: the default was in effect then.
    old_value: r.old_value ?? DEFAULT_SETTINGS[r.key as SettingKey] ?? null,
    new_value: r.new_value,
    operator_name: r.operator_name === null ? null : String(r.operator_name),
    created_at: new Date(r.created_at as string | Date).toISOString(),
  }));
}
