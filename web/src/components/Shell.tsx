import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, type IconName } from "./Icon";
import { useCrmStream, type CrmEvent } from "../lib/sse";
import { useTheme, storedThemePref, type ThemePref } from "../lib/theme";
import {
  keys,
  useCounts,
  useHeartbeat,
  useMe,
  useSetShift,
  useUpdatePrefs,
  type Operator,
} from "../lib/queries";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function Shell() {
  const me = useMe();
  const ready = me.isSuccess;
  const counts = useCounts(ready);
  const qc = useQueryClient();

  useTheme(me.data?.prefs.theme ?? storedThemePref());
  useHeartbeat(ready);

  const onEvent = useCallback(
    (event: CrmEvent) => {
      if (event.type === "operator.updated") void qc.invalidateQueries({ queryKey: keys.me });
      if (event.type.startsWith("ticket.") || event.type === "message.created") {
        void qc.invalidateQueries({ queryKey: keys.tickets });
      }
    },
    [qc],
  );
  const stream = useCrmStream(onEvent);

  useEffect(() => {
    document.title = "Поддержка";
  }, []);

  if (me.isError && !me.isFetching) return <LoadError onRetry={() => void me.refetch()} />;

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-text">
      <nav
        aria-label="Разделы"
        className="flex w-rail-compact shrink-0 flex-col border-r border-border bg-surface-2 lg:w-rail"
      >
        <Brand />
        {me.data ? (
          <>
            <div className="flex flex-col gap-0.5 px-2 pt-2">
              <NavItem to="/" icon="queue" label="Очередь" count={counts.data?.queue} />
              <NavItem to="/mine" icon="mine" label="Мои" count={counts.data?.mine} />
              <NavItem to="/all" icon="all" label="Все" />
              <NavItem
                to="/all?overdue=1"
                icon="overdue"
                label="Просрочено"
                count={counts.data?.overdue}
                tone="late"
              />
            </div>
            <div className="mx-4 my-3 h-px bg-border" />
            <div className="flex flex-col gap-0.5 px-2">
              <NavItem to="/stats" icon="stats" label="Статистика" />
              <NavItem to="/canned" icon="canned" label="Шаблоны" />
              <NavItem to="/settings" icon="settings" label="Настройки" />
            </div>
            <div className="flex-1" />
            {stream.reconnecting && <Reconnecting />}
            <OperatorControls me={me.data} />
          </>
        ) : (
          <RailSkeleton />
        )}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">{ready && <Outlet />}</main>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 px-3 lg:px-4">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-sm bg-accent text-sm font-semibold text-accent-fg lg:hidden"
      >
        П
      </span>
      <span className="sr-only text-md font-semibold lg:not-sr-only">Поддержка</span>
    </div>
  );
}

interface NavItemProps {
  to: string;
  icon: IconName;
  label: string;
  count?: number;
  tone?: "neutral" | "late";
}

// «Все» and «Просрочено» share /all, so activeness looks at the overdue param too.
export function navIsActive(to: string, pathname: string, search: string): boolean {
  const [path = "/", query] = to.split("?");
  const pathMatch = path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
  const overdue = new URLSearchParams(search).get("overdue") === "1";
  return pathMatch && overdue === Boolean(query?.includes("overdue=1"));
}

function NavItem({ to, icon, label, count, tone = "neutral" }: NavItemProps) {
  const location = useLocation();
  const active = navIsActive(to, location.pathname, location.search);
  const value = count ?? 0;
  const showCount = typeof count === "number" && (tone === "neutral" || value > 0);
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      aria-label={showCount ? `${label}: ${value}` : label}
      title={label}
      className={cx(
        "press relative flex h-9 items-center justify-center gap-2.5 rounded-sm px-2 lg:h-8 lg:justify-start",
        active
          ? "bg-surface font-semibold text-text shadow-[0_0_0_1px_var(--border)]"
          : "hover-surface text-text-muted",
      )}
    >
      <Icon name={icon} className={cx("shrink-0", active && "text-accent")} />
      <span className="hidden flex-1 truncate lg:block">{label}</span>
      {showCount && (
        <span
          aria-hidden="true"
          className={cx(
            "num grid place-items-center rounded-xs text-xs font-semibold",
            // Compact rail: a small corner tab ringed in the rail colour; wide rail: inline.
            "absolute right-0 top-0 h-4 min-w-4 px-0.5 shadow-[0_0_0_2px_var(--surface-2)]",
            "lg:static lg:h-5 lg:min-w-5 lg:px-1 lg:shadow-none",
            tone === "late"
              ? "bg-sla-late-soft text-sla-late"
              : value === 0
                ? "text-text-muted max-lg:hidden"
                : "bg-surface text-text lg:shadow-[0_0_0_1px_var(--border)]",
          )}
        >
          {value > 999 ? "999+" : value}
        </span>
      )}
    </Link>
  );
}

function Reconnecting() {
  return (
    <p
      role="status"
      className="mx-2 mb-2 flex items-center justify-center gap-2 rounded-sm bg-sla-warn-soft px-2 py-1.5 text-xs text-sla-warn lg:justify-start"
      title="Связь с сервером потеряна. Переподключаемся."
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-sla-warn" />
      <span className="sr-only lg:not-sr-only">Переподключение…</span>
    </p>
  );
}

function OperatorControls({ me }: { me: Operator }) {
  const shift = useSetShift();
  const prefs = useUpdatePrefs();
  const failed = shift.isError || prefs.isError;

  return (
    <div className="flex flex-col gap-2 border-t border-border px-2 py-3 lg:px-3">
      <div className="flex items-center justify-center gap-2 lg:justify-between">
        <span id="shift-label" className="sr-only text-base lg:not-sr-only">
          На смене
        </span>
        <Switch
          labelledBy="shift-label"
          checked={me.on_shift}
          onChange={(on) => shift.mutate(on)}
          title={me.on_shift ? "Вы на смене. Новые обращения назначаются вам" : "Вы не на смене"}
        />
      </div>
      <div className="flex flex-col items-center gap-2 lg:flex-row lg:justify-between">
        <IconToggle
          label="Звук"
          pressed={me.prefs.sound}
          icon={me.prefs.sound ? "soundOn" : "soundOff"}
          onClick={() => prefs.mutate({ sound: !me.prefs.sound })}
          title={me.prefs.sound ? "Звук включён" : "Звук выключен"}
        />
        <ThemeSwitch value={me.prefs.theme} onChange={(theme) => prefs.mutate({ theme })} />
      </div>
      {failed && (
        <p role="alert" className="text-xs text-danger">
          <span className="lg:hidden" title="Не сохранилось. Повторите">
            <Icon name="alert" />
          </span>
          <span className="hidden lg:inline">Не сохранилось. Повторите.</span>
        </p>
      )}
      <div className="hidden min-w-0 lg:block">
        <p className="truncate text-sm font-semibold">{me.name}</p>
        <p className="truncate text-xs text-text-muted">
          {me.role === "admin" ? "Администратор" : "Поддержка"}
          {me.is_lead ? ", лид" : ""}
        </p>
      </div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  labelledBy,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      title={title}
      onClick={() => onChange(!checked)}
      className={cx(
        "press relative h-5 w-9 shrink-0 rounded-full transition-colors duration-fast",
        checked ? "bg-accent" : "bg-border-strong",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "absolute left-0.5 top-0.5 size-4 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.2)]",
          "transition-transform duration-base ease-out",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

function IconToggle({
  label,
  pressed,
  icon,
  onClick,
  title,
}: {
  label: string;
  pressed: boolean;
  icon: IconName;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cx(
        "press hover-surface grid size-8 place-items-center rounded-sm",
        pressed ? "text-text" : "text-text-muted",
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

const THEMES: Array<{ value: ThemePref; icon: IconName; label: string }> = [
  { value: "system", icon: "system", label: "Как в системе" },
  { value: "light", icon: "light", label: "Светлая" },
  { value: "dark", icon: "dark", label: "Тёмная" },
];

function ThemeSwitch({ value, onChange }: { value: ThemePref; onChange: (next: ThemePref) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, THEMES.findIndex((t) => t.value === value));
  const current = THEMES[index] ?? THEMES[0]!;
  const next = THEMES[(index + 1) % THEMES.length]!;

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const target = THEMES[(index + step + THEMES.length) % THEMES.length]!;
    onChange(target.value);
    refs.current[THEMES.indexOf(target)]?.focus();
  };

  return (
    <>
      {/* Compact rail: one button cycles the three options. */}
      <button
        type="button"
        onClick={() => onChange(next.value)}
        aria-label={`Тема: ${current.label}. Переключить на «${next.label}»`}
        title={`Тема: ${current.label}`}
        className="press hover-surface grid size-8 place-items-center rounded-sm text-text-muted lg:hidden"
      >
        <Icon name={current.icon} />
      </button>
      <div
        role="radiogroup"
        aria-label="Тема"
        onKeyDown={onKeyDown}
        className="hidden rounded-sm bg-bg p-0.5 shadow-[inset_0_0_0_1px_var(--border)] lg:flex"
      >
        {THEMES.map((t, i) => {
          const active = t.value === value;
          return (
            <button
              key={t.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={t.label}
              title={t.label}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.value)}
              className={cx(
                "press grid h-7 w-8 place-items-center rounded-xs",
                active ? "bg-surface text-text shadow-[0_0_0_1px_var(--border)]" : "hover-surface text-text-muted",
              )}
            >
              <Icon name={t.icon} size={15} />
            </button>
          );
        })}
      </div>
    </>
  );
}

function RailSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2 px-2 pt-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 rounded-sm bg-hover" />
      ))}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="grid h-dvh place-items-center bg-bg px-4 text-text">
      <div role="alert" className="flex max-w-sm flex-col items-start gap-3">
        <p className="text-lg font-semibold">Не удалось загрузить профиль</p>
        <p className="text-text-muted">Проверьте соединение и попробуйте ещё раз.</p>
        <button
          type="button"
          onClick={onRetry}
          className="press h-8 rounded-sm bg-accent px-3 font-semibold text-accent-fg hover:bg-accent-hover"
        >
          Повторить
        </button>
      </div>
    </div>
  );
}
