import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Segmented } from "../components/Segmented";
import { Switch } from "../components/Shell";
import { toast } from "../components/Toast";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { playBlip } from "../lib/notify";
import { useMe, useUpdatePrefs, type Operator, type OperatorPrefs } from "../lib/queries";
import {
  canEditTeamSettings,
  fieldErrorsOf,
  formatSettingValue,
  SETTING_GROUPS,
  settingLabel,
  UNIT,
  useSaveSettings,
  useSettingsLog,
  useTeamSettings,
  useUpdateOperator,
  type FieldMeta,
  type OperatorPatch,
  type SettingKey,
} from "../lib/settings";
import { formatDuration } from "../lib/stats";
import { useOperators, type CrmSettings, type OperatorSummary } from "../lib/tickets";
import type { ThemePref } from "../lib/theme";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

type Tab = "team" | "personal";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "team", label: "Команда" },
  { value: "personal", label: "Личные" },
];

export function Settings() {
  const me = useMe().data;
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get("tab") === "personal" ? "personal" : "team";
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    document.title = "Настройки · Поддержка";
  }, []);

  const select = (next: Tab) => setSp(next === "team" ? {} : { tab: next }, { replace: true });
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = (TABS.findIndex((t) => t.value === tab) + 1) % TABS.length;
    select(TABS[i]!.value);
    tabRefs.current[i]?.focus();
  };

  if (!me) return null;
  return (
    <div className="flex min-h-full flex-col">
      <header className="shrink-0 border-b border-border bg-surface px-4 lg:px-8">
        <h1 className="pt-5 text-xl font-semibold">Настройки</h1>
        <div role="tablist" aria-label="Разделы настроек" onKeyDown={onTabKey} className="mt-3 flex gap-5">
          {TABS.map((t, i) => {
            const active = t.value === tab;
            return (
              <button
                key={t.value}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                id={`settings-tab-${t.value}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`settings-panel-${t.value}`}
                tabIndex={active ? 0 : -1}
                onClick={() => select(t.value)}
                className={cx(
                  "relative h-9 text-base transition-colors duration-fast",
                  active ? "font-semibold text-text" : "text-text-muted hover:text-text",
                )}
              >
                {t.label}
                <span
                  aria-hidden="true"
                  className={cx("absolute inset-x-0 -bottom-px h-0.5 rounded-full", active ? "bg-accent" : "bg-transparent")}
                />
              </button>
            );
          })}
        </div>
      </header>
      <div
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        className="flex-1 px-4 py-6 lg:px-8"
      >
        {tab === "team" ? <TeamTab me={me} /> : <PersonalTab me={me} />}
      </div>
    </div>
  );
}

/* ---------- Команда ---------- */

type Draft = Record<SettingKey, string | boolean>;

function toDraft(s: CrmSettings): Draft {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(s)) out[k] = typeof v === "boolean" ? v : v === null ? "" : String(v);
  return out as Draft;
}

/**
 * The keys the operator changed since `baseline` (the server copy the draft was loaded from), as API values,
 * or per-field errors for input the server would never accept.
 */
export function draftPatch(draft: Draft, baseline: CrmSettings): { patch: Partial<CrmSettings>; errors: Record<string, string> } {
  const patch: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const group of SETTING_GROUPS) {
    for (const f of group.fields) {
      const raw = draft[f.key];
      let value: unknown = raw;
      if (f.kind !== "bool" && f.kind !== "text") {
        const s = String(raw).trim();
        if (s === "" && f.key === "auto_assign_max_open") value = null;
        else if (!/^\d+$/.test(s)) {
          errors[f.key] = "Введите целое число.";
          continue;
        } else value = Number(s);
      }
      if (value !== baseline[f.key]) patch[f.key] = value;
    }
  }
  return { patch: patch as Partial<CrmSettings>, errors };
}

const FIELD_ORDER = SETTING_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

/** Focus the first field (in page order) that carries an error. */
function focusFirstError(errors: Record<string, string>) {
  const key = FIELD_ORDER.find((k) => k in errors);
  if (!key) return;
  const el =
    document.getElementById(`setting-${key}`) ??
    document.querySelector<HTMLElement>(`[aria-labelledby="setting-${key}-label"]`);
  el?.focus();
}

interface FormState {
  /** The server copy the draft started from; a save sends only what differs from it. */
  baseline: CrmSettings;
  draft: Draft;
}

const formFrom = (s: CrmSettings): FormState => ({ baseline: s, draft: toDraft(s) });

function TeamTab({ me }: { me: Operator }) {
  const canEdit = canEditTeamSettings(me);
  const settings = useTeamSettings();
  const save = useSaveSettings();
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const saved = settings.data;
  const draft = form?.draft ?? null;
  const pending = form ? draftPatch(form.draft, form.baseline) : null;
  const dirty = Boolean(pending && (Object.keys(pending.patch).length || Object.keys(pending.errors).length));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Fresh server data (refetch on focus, another lead's save) resets the form unless the operator has unsaved edits.
  useEffect(() => {
    if (saved && !dirtyRef.current) setForm(formFrom(saved));
  }, [saved]);

  const setField = (key: SettingKey, value: string | boolean) => {
    setForm((f) => (f ? { ...f, draft: { ...f.draft, [key]: value } } : f));
    setErrors((e) => {
      if (!(key in e)) return e;
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
    setFormError(null);
  };

  const onSave = () => {
    if (!form || save.isPending) return;
    const { patch, errors: local } = draftPatch(form.draft, form.baseline);
    if (Object.keys(local).length) {
      setErrors(local);
      focusFirstError(local);
      return;
    }
    if (!Object.keys(patch).length) return;
    save.mutate(patch, {
      onSuccess: (next) => {
        setForm(formFrom(next));
        setErrors({});
        setFormError(null);
        toast("Настройки сохранены.");
      },
      onError: (err) => {
        const fields = fieldErrorsOf(err);
        if (fields) {
          const { _form, ...rest } = fields;
          setErrors(rest);
          setFormError(_form ?? null);
          focusFirstError(rest);
        } else if (err instanceof ApiError && err.status === 403) {
          setFormError("Нет прав менять настройки команды.");
        } else {
          setFormError("Не сохранилось. Повторите.");
        }
      },
    });
  };

  const onReset = () => {
    if (saved) setForm(formFrom(saved));
    setErrors({});
    setFormError(null);
  };

  return (
    <div className="flex max-w-[56rem] flex-col gap-8">
      {!canEdit && (
        <p className="rounded-md bg-surface-2 px-4 py-3 text-text-muted shadow-[inset_0_0_0_1px_var(--border)]">
          Только просмотр. Менять настройки команды могут администратор и лид.
        </p>
      )}

      {settings.isError && !saved ? (
        <LoadFailed text="Не удалось загрузить настройки." onRetry={() => void settings.refetch()} />
      ) : !draft ? (
        <FormSkeleton />
      ) : (
        <form
          aria-label="Настройки команды"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
          className="flex flex-col gap-8"
        >
          <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-8 border-0 p-0">
            {SETTING_GROUPS.map((group) => (
              <Section key={group.title} title={group.title}>
                {group.fields.map((f) => (
                  <SettingRow
                    key={f.key}
                    meta={f}
                    value={draft[f.key]}
                    error={errors[f.key]}
                    readOnly={!canEdit}
                    onChange={(v) => setField(f.key, v)}
                  />
                ))}
              </Section>
            ))}
          </fieldset>

          {canEdit && (dirty || formError) && (
            <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-md bg-surface px-4 py-3 shadow-[0_0_0_1px_var(--border),var(--shadow-pop)]">
              {formError ? (
                <p role="alert" className="flex-1 text-danger">
                  {formError}
                </p>
              ) : (
                <p className="flex-1 text-text-muted">Есть несохранённые изменения.</p>
              )}
              <button type="button" onClick={onReset} className="press hover-surface h-8 rounded-sm px-3 text-text-muted">
                Отменить
              </button>
              <button
                type="submit"
                disabled={save.isPending}
                className="press h-9 rounded-sm bg-accent px-4 font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
              >
                {save.isPending ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
          )}
        </form>
      )}

      <OperatorsSection me={me} />
      {canEdit && <SettingsHistory />}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id={id} className="text-md font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      <div className="divide-y divide-border rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">{children}</div>
    </section>
  );
}

function SettingRow({
  meta,
  value,
  error,
  readOnly,
  onChange,
}: {
  meta: FieldMeta;
  value: string | boolean;
  error: string | undefined;
  readOnly: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `setting-${meta.key}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = cx(helpId, error && errorId);
  const unit = UNIT[meta.kind];

  const label = (
    <div className="min-w-0 flex-1">
      <label id={`${id}-label`} htmlFor={meta.kind === "bool" ? undefined : id} className="block text-base">
        {meta.label}
      </label>
      <p id={helpId} className="text-sm text-text-muted">
        {meta.help}
      </p>
    </div>
  );
  const errorLine = error && (
    <p id={errorId} role="alert" className="text-sm text-danger">
      {error}
    </p>
  );

  if (meta.kind === "text") {
    const text = String(value);
    return (
      <div className="flex flex-col gap-2 px-4 py-3">
        {label}
        <textarea
          id={id}
          value={text}
          rows={3}
          maxLength={1000}
          disabled={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className={cx(
            "w-full resize-y rounded-sm bg-bg px-3 py-2 text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]",
            "disabled:cursor-not-allowed disabled:resize-none disabled:bg-transparent disabled:shadow-none",
            error && "shadow-[inset_0_0_0_1px_var(--danger)]",
          )}
        />
        <div className="flex items-start gap-3">
          <div className="flex-1">{errorLine}</div>
          {!readOnly && <span className="num text-xs text-text-muted">{text.length} / 1000</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-4">
        {label}
        {meta.kind === "bool" ? (
          <Switch labelledBy={`${id}-label`} checked={value === true} onChange={(v) => onChange(v)} disabled={readOnly} />
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              disabled={readOnly}
              value={String(value)}
              placeholder={meta.key === "auto_assign_max_open" ? "нет" : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => onChange(e.target.value)}
              className={cx(
                "num h-8 w-16 rounded-sm bg-bg px-2 text-right text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]",
                "disabled:cursor-not-allowed disabled:resize-none disabled:bg-transparent disabled:shadow-none",
                error && "shadow-[inset_0_0_0_1px_var(--danger)]",
              )}
            />
            <span className="w-7 text-sm text-text-muted">{unit}</span>
          </div>
        )}
      </div>
      {error && <div className="sm:text-right">{errorLine}</div>}
    </div>
  );
}

function FormSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <div className="h-6 w-40 rounded-xs bg-hover" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-16 rounded-md bg-hover" />
      ))}
    </div>
  );
}

function LoadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="text-danger">{text}</p>
      <button type="button" onClick={onRetry} className="press hover-surface h-8 rounded-sm px-3 font-semibold text-accent">
        Повторить
      </button>
    </div>
  );
}

/* ---------- Операторы ---------- */

function formatAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "не заходил";
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 60) return "только что";
  if (s > 7 * 86_400) return formatDateTime(iso);
  return `${formatDuration(Math.floor(s / 60) * 60)} назад`;
}

function operatorErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "Нет прав на это действие.";
  if (err instanceof ApiError && err.status === 404) return "Оператор не найден. Обновите страницу.";
  return "Не сохранилось. Повторите.";
}

function OperatorsSection({ me }: { me: Operator }) {
  const operators = useOperators();
  const update = useUpdateOperator();
  const canEdit = canEditTeamSettings(me);
  const isAdmin = me.role === "admin";
  const list = operators.data;

  const change = (o: OperatorSummary, patch: OperatorPatch) =>
    update.mutate({ id: o.id, patch }, { onError: (err) => toast(operatorErrorText(err), { tone: "danger", key: "operator-update" }) });

  const onShiftCount = list?.filter((o) => o.on_shift).length ?? 0;

  return (
    <section aria-labelledby="operators-title" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="operators-title" className="text-md font-semibold">
          Операторы
        </h2>
        {list && (
          <span className="num text-sm text-text-muted">
            на смене {onShiftCount} из {list.length}
          </span>
        )}
      </div>
      {operators.isError && !list ? (
        <LoadFailed text="Не удалось загрузить операторов." onRetry={() => void operators.refetch()} />
      ) : !list ? (
        <div aria-hidden="true" className="h-40 rounded-md bg-hover" />
      ) : list.length === 0 ? (
        <p className="text-text-muted">Операторов пока нет. Они появятся после первого входа через админку.</p>
      ) : (
        <div className="overflow-x-auto rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">
          <table className="w-full min-w-[46rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-border text-xs text-text-muted">
                <th scope="col" className="h-9 px-4 font-normal">Оператор</th>
                <th scope="col" className="px-3 font-normal">Смена</th>
                <th scope="col" className="px-3 text-right font-normal">Открытых</th>
                <th scope="col" className="px-3 font-normal">Активность</th>
                <th scope="col" id="col-lead" className="px-3 font-normal">Лид</th>
                <th scope="col" id="col-auto" className="px-3 font-normal">Автоназначение</th>
                <th scope="col" className="px-4 font-normal">
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((o) => (
                <tr key={o.id} className="h-14">
                  <th scope="row" className="px-4 text-left font-normal">
                    <p id={`op-${o.id}`} className="truncate font-semibold">
                      {o.name}
                      {o.id === me.id && <span className="font-normal text-text-muted">, вы</span>}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {o.role === "admin" ? "Администратор" : "Поддержка"}
                      {o.email ? ` · ${o.email}` : ""}
                    </p>
                  </th>
                  <td className="px-3">
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span
                        aria-hidden="true"
                        className={cx("size-2 rounded-full", o.on_shift ? "bg-sla-ok" : "bg-border-strong")}
                      />
                      {o.on_shift ? "На смене" : "Не на смене"}
                    </span>
                  </td>
                  <td className="num px-3 text-right">{o.open_tickets}</td>
                  <td className="whitespace-nowrap px-3 text-sm text-text-muted">{formatAgo(o.last_active_at)}</td>
                  <td className="px-3">
                    {isAdmin ? (
                      <Switch labelledBy={`op-${o.id} col-lead`} checked={o.is_lead} onChange={(v) => change(o, { is_lead: v })} />
                    ) : (
                      <span className={o.is_lead ? "text-text" : "text-text-muted"}>{o.is_lead ? "Да" : "Нет"}</span>
                    )}
                  </td>
                  <td className="px-3">
                    {canEdit ? (
                      <Switch
                        labelledBy={`op-${o.id} col-auto`}
                        checked={o.auto_assign_enabled}
                        onChange={(v) => change(o, { auto_assign_enabled: v })}
                      />
                    ) : (
                      <span className={o.auto_assign_enabled ? "text-text" : "text-text-muted"}>
                        {o.auto_assign_enabled ? "Участвует" : "Не участвует"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 text-right">
                    {canEdit && o.on_shift && (
                      <button
                        type="button"
                        onClick={() => change(o, { on_shift: false })}
                        aria-label={`Снять со смены: ${o.name}`}
                        className="press hover-surface h-7 whitespace-nowrap rounded-sm px-2 text-sm text-text-muted shadow-[inset_0_0_0_1px_var(--border)]"
                      >
                        Снять со смены
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------- История ---------- */

const HISTORY_PAGE = 10;

function SettingsHistory() {
  const log = useSettingsLog(true);
  const [all, setAll] = useState(false);
  const rows = log.data ?? [];
  const shown = all ? rows : rows.slice(0, HISTORY_PAGE);

  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-3">
      <h2 id="history-title" className="text-md font-semibold">
        История изменений
      </h2>
      {log.isError && !log.data ? (
        <LoadFailed text="Не удалось загрузить историю." onRetry={() => void log.refetch()} />
      ) : !log.data ? (
        <div aria-hidden="true" className="h-24 rounded-md bg-hover" />
      ) : rows.length === 0 ? (
        <p className="text-text-muted">Изменений пока не было.</p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">
            {shown.map((r, i) => (
              <li key={`${r.created_at}-${r.key}-${i}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2.5">
                <p className="min-w-0 flex-1">
                  <span className="font-semibold">{settingLabel(r.key)}</span>
                  <span className="text-text-muted">: {formatSettingValue(r.key, r.old_value)} → </span>
                  {formatSettingValue(r.key, r.new_value)}
                </p>
                <p className="num whitespace-nowrap text-sm text-text-muted">
                  {r.operator_name ?? "Система"}, {formatDateTime(r.created_at)}
                </p>
              </li>
            ))}
          </ul>
          {rows.length > HISTORY_PAGE && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="press hover-surface h-8 self-start rounded-sm px-3 text-sm font-semibold text-accent"
            >
              {all ? "Свернуть" : `Показать все (${rows.length})`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/* ---------- Личные ---------- */

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: "system", label: "Как в системе" },
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
];
const SCOPE_OPTIONS: Array<{ value: OperatorPrefs["notify_scope"]; label: string }> = [
  { value: "all", label: "Все новые в очереди" },
  { value: "mine", label: "Только мои и упоминания" },
];
const SEND_OPTIONS: Array<{ value: OperatorPrefs["send_key"]; label: string }> = [
  { value: "mod_enter", label: "Ctrl/Cmd + Enter" },
  { value: "enter", label: "Enter" },
];
const VOLUME_SAVE_MS = 400;

type Permission = NotificationPermission | "unsupported";
const readPermission = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

function PersonalTab({ me }: { me: Operator }) {
  const prefs = useUpdatePrefs();
  const set = (patch: Partial<OperatorPrefs>) => prefs.mutate(patch);
  const [volume, setVolume] = useState(Math.round(me.prefs.volume * 100));
  const [permission, setPermission] = useState<Permission>(readPermission);
  const latest = useRef(set);
  latest.current = set;

  useEffect(() => {
    setVolume(Math.round(me.prefs.volume * 100));
  }, [me.prefs.volume]);

  useEffect(() => {
    if (volume === Math.round(me.prefs.volume * 100)) return;
    const t = setTimeout(() => latest.current({ volume: volume / 100 }), VOLUME_SAVE_MS);
    return () => clearTimeout(t);
  }, [volume, me.prefs.volume]);

  const askPermission = async () => {
    if (typeof Notification === "undefined") return;
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(readPermission());
    }
  };

  const permissionLine =
    permission === "unsupported"
      ? "Этот браузер не показывает уведомления."
      : permission === "denied"
        ? "Браузер запретил уведомления. Разрешите их в настройках сайта."
        : permission === "default"
          ? "Браузер ещё не разрешил уведомления."
          : "Браузер разрешил уведомления.";

  return (
    <div className="flex max-w-[56rem] flex-col gap-8">
      <Section title="Вид">
        <PrefRow label="Тема" help="Как в системе: следует за светлой или тёмной темой ОС." labelId="pref-theme">
          <Segmented labelledBy="pref-theme" value={me.prefs.theme} options={THEME_OPTIONS} onChange={(theme) => set({ theme })} />
        </PrefRow>
      </Section>

      <Section title="Уведомления">
        <PrefRow label="Звук" help="Короткий сигнал о новых обращениях и событиях." labelId="pref-sound">
          <Switch labelledBy="pref-sound" checked={me.prefs.sound} onChange={(sound) => set({ sound })} />
        </PrefRow>
        <PrefRow label="Громкость" help="Проверьте, как звучит сигнал." labelId="pref-volume" htmlFor="pref-volume-input">
          <div className="flex items-center gap-3">
            <input
              id="pref-volume-input"
              type="range"
              min={0}
              max={100}
              step={5}
              value={volume}
              disabled={!me.prefs.sound}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-valuetext={`${volume} %`}
              className="w-32 accent-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="num w-10 text-right text-sm text-text-muted">{volume}&nbsp;%</span>
            <button
              type="button"
              disabled={!me.prefs.sound || volume === 0}
              onClick={() => playBlip(volume / 100)}
              className="press hover-surface h-8 rounded-sm px-3 text-sm shadow-[inset_0_0_0_1px_var(--border)] disabled:cursor-not-allowed disabled:text-text-muted"
            >
              Проверить
            </button>
          </div>
        </PrefRow>
        <PrefRow
          label="На рабочем столе"
          help={permissionLine}
          labelId="pref-desktop"
          extra={
            permission === "default" && (
              <button
                type="button"
                onClick={() => void askPermission()}
                className="press hover-surface h-8 self-start rounded-sm px-3 text-sm font-semibold text-accent shadow-[inset_0_0_0_1px_var(--border)]"
              >
                Разрешить в браузере
              </button>
            )
          }
        >
          <Switch labelledBy="pref-desktop" checked={me.prefs.desktop} onChange={(desktop) => set({ desktop })} />
        </PrefRow>
        <PrefRow label="Сообщать о" help="Личные события приходят всегда: назначения, упоминания, ответы клиентов." labelId="pref-scope">
          <Segmented
            labelledBy="pref-scope"
            value={me.prefs.notify_scope}
            options={SCOPE_OPTIONS}
            onChange={(notify_scope) => set({ notify_scope })}
          />
        </PrefRow>
      </Section>

      <Section title="Ответы">
        <PrefRow label="Отправка" help="Какой клавишей отправлять ответ из поля ввода." labelId="pref-send">
          <Segmented labelledBy="pref-send" value={me.prefs.send_key} options={SEND_OPTIONS} onChange={(send_key) => set({ send_key })} />
        </PrefRow>
      </Section>

      {prefs.isError && (
        <p role="alert" className="text-danger">
          Не сохранилось. Повторите.
        </p>
      )}
    </div>
  );
}

function PrefRow({
  label,
  help,
  labelId,
  htmlFor,
  extra,
  children,
}: {
  label: string;
  help: string;
  labelId: string;
  htmlFor?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className="text-base">
            {label}
          </label>
        ) : (
          <p id={labelId} className="text-base">
            {label}
          </p>
        )}
        <p className="text-sm text-text-muted">{help}</p>
        {extra}
      </div>
      {children}
    </div>
  );
}
