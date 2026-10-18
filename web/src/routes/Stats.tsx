import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Segmented } from "../components/Segmented";
import { StatsChart } from "../components/StatsChart";
import { StatsHeatmap } from "../components/StatsHeatmap";
import { TopicStatsTable } from "../components/TopicStatsTable";
import { formatNumber } from "../lib/format";
import { useMe } from "../lib/queries";
import { canEditTeamSettings } from "../lib/settings";
import {
  formatDuration,
  formatPercent,
  mskDate,
  PRESETS,
  rangeQuery,
  useStats,
  type OperatorStats,
  type Preset,
  type StatsResponse,
} from "../lib/stats";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const isPreset = (v: string | null): v is Preset => PRESETS.some((p) => p.value === v);

const DAY_CHECK_MS = 60_000;

/** The current Moscow date, re-read every minute and when the tab regains focus. */
export function useMskToday(): string {
  const [today, setToday] = useState(() => mskDate(Date.now()));
  useEffect(() => {
    const check = () => setToday(mskDate(Date.now()));
    const timer = setInterval(check, DAY_CHECK_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return today;
}

export function Stats() {
  const me = useMe().data;
  const [sp, setSp] = useSearchParams();
  const preset: Preset = isPreset(sp.get("range")) ? (sp.get("range") as Preset) : "7d";
  const today = useMskToday();
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  // `today` is in the deps so presets move to the new Moscow day at midnight.
  const range = useMemo(() => rangeQuery({ preset, from, to }, Date.now()), [preset, from, to, today]);
  const stats = useStats(range.ok ? { from: range.from, to: range.to } : null);

  useEffect(() => {
    document.title = "Статистика · Поддержка";
  }, []);

  const setPreset = (next: Preset) => {
    if (next === "7d") return setSp({}, { replace: true });
    if (next !== "custom") return setSp({ range: next }, { replace: true });
    // Start the custom range from the last 7 days so the page never goes blank.
    const weekAgo = mskDate(Date.now() - 6 * 86_400_000);
    setSp({ range: "custom", from: from || weekAgo, to: to || today }, { replace: true });
  };
  const setDate = (key: "from" | "to", value: string) => {
    const next = new URLSearchParams(sp);
    next.set(key, value);
    setSp(next, { replace: true });
  };

  if (!me) return null;
  const seeAll = canEditTeamSettings(me);

  return (
    <div className="flex min-h-full flex-col">
      <header className="shrink-0 border-b border-border bg-surface px-4 py-4 lg:px-8">
        <h1 className="text-xl font-semibold">Статистика</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented label="Период" value={preset} options={PRESETS} onChange={setPreset} />
          {preset === "custom" && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <DateField label="с" value={from} max={today} onChange={(v) => setDate("from", v)} />
              <DateField label="по" value={to} max={today} onChange={(v) => setDate("to", v)} />
            </div>
          )}
          <p className="text-xs text-text-muted">Дни по московскому времени.</p>
        </div>
        {!range.ok && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {range.error}
          </p>
        )}
      </header>

      <div className="flex-1 px-4 py-6 lg:px-8">
        {stats.isError && !stats.data ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-danger">Не удалось загрузить статистику.</p>
            <button
              type="button"
              onClick={() => void stats.refetch()}
              className="press hover-surface h-8 rounded-sm px-3 font-semibold text-accent"
            >
              Повторить
            </button>
          </div>
        ) : !stats.data ? (
          range.ok && <StatsSkeleton />
        ) : (
          <div
            aria-busy={stats.isFetching || undefined}
            className={cx("flex max-w-[80rem] flex-col gap-8 transition-opacity duration-fast", stats.isPlaceholderData && "opacity-60")}
          >
            <div className="flex flex-col gap-3">
              <TeamTiles data={stats.data} />
              <ResolutionTiles data={stats.data} />
            </div>
            <Block title="Новые обращения по дням">
              <StatsChart days={stats.data.team.new_per_day} />
            </Block>
            <Block title="Когда пишут клиенты" aside={<span className="text-sm text-text-muted">По первому сообщению клиента, МСК.</span>}>
              <StatsHeatmap cells={stats.data.team.heatmap} />
            </Block>
            <Block title="Причины обращений" aside={<span className="text-sm text-text-muted">По темам решённых обращений.</span>}>
              <TopicStatsTable rows={stats.data.topics} />
            </Block>
            <Block
              title="Операторы"
              aside={!seeAll && <span className="text-sm text-text-muted">Вы видите свою строку. Всю команду видят администратор и лид.</span>}
            >
              <OperatorTable rows={stats.data.operators} meId={me.id} />
            </Block>
          </div>
        )}
      </div>
    </div>
  );
}

function DateField({ label, value, max, onChange }: { label: string; value: string; max: string; onChange: (v: string) => void }) {
  return (
    <label className="inline-flex items-center gap-2">
      <span className="text-text-muted">{label}</span>
      <input
        type="date"
        value={value}
        max={max}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="num h-8 rounded-sm bg-bg px-2 text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]"
      />
    </label>
  );
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="text-md font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TeamTiles({ data }: { data: StatsResponse }) {
  const t = data.team;
  const created = t.new_per_day.reduce((n, d) => n + d.bot + d.miniapp + d.web, 0);
  const tiles: Array<{ label: string; value: string; note: string; muted?: boolean }> = [
    { label: "Новых обращений", value: String(created), note: "за период" },
    { label: "Ответов в срок", value: t.within_sla_pct === null ? "нет ответов" : formatPercent(t.within_sla_pct), note: "за период", muted: t.within_sla_pct === null },
    { label: "Открыто", value: String(t.backlog), note: "сейчас" },
    {
      label: "Дольше всех ждёт",
      value: t.oldest_waiting_minutes === null ? "никто" : formatDuration(t.oldest_waiting_minutes * 60),
      note: "сейчас",
      muted: t.oldest_waiting_minutes === null,
    },
  ];
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-md bg-surface shadow-[0_0_0_1px_var(--border)] md:grid-cols-4">
      {tiles.map((tile, i) => (
        <div
          key={tile.label}
          className={cx(
            "flex flex-col gap-1 px-4 py-3",
            "border-border",
            i % 2 === 1 && "border-l",
            i >= 2 && "max-md:border-t md:border-l",
          )}
        >
          <dt className="text-sm text-text-muted">
            {tile.label} <span className="text-xs">· {tile.note}</span>
          </dt>
          <dd className={cx("text-xl font-semibold", tile.muted && "text-text-muted")}>{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResolutionTiles({ data }: { data: StatsResponse }) {
  const t = data.team;
  const none = "нет решённых";
  const tiles: Array<{ label: string; value: string; note: string; muted: boolean }> = [
    {
      label: "Время решения",
      note: "медиана",
      value: t.resolution_median_s === null ? none : formatDuration(t.resolution_median_s),
      muted: t.resolution_median_s === null,
    },
    {
      label: "Решено одним ответом",
      note: "без переоткрытия",
      value: t.one_reply_pct === null ? none : formatPercent(t.one_reply_pct),
      muted: t.one_reply_pct === null,
    },
    {
      label: "Сообщений на обращение",
      note: "в среднем",
      value: t.messages_per_ticket === null ? none : formatNumber(t.messages_per_ticket),
      muted: t.messages_per_ticket === null,
    },
  ];
  return (
    <dl className="grid grid-cols-1 overflow-hidden rounded-md bg-surface shadow-[0_0_0_1px_var(--border)] md:grid-cols-3">
      {tiles.map((tile, i) => (
        <div key={tile.label} className={cx("flex flex-col gap-1 border-border px-4 py-3", i > 0 && "max-md:border-t md:border-l")}>
          <dt className="text-sm text-text-muted">
            {tile.label} <span className="text-xs">· {tile.note}</span>
          </dt>
          <dd className={cx("text-xl font-semibold", tile.muted && "text-text-muted")}>{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type SortKey = keyof Omit<OperatorStats, "operator_id">;
type ColKind = "text" | "count" | "duration" | "percent";

interface Column {
  key: SortKey;
  label: string;
  /** Two columns under one heading: «Ответ» over «медиана» and «p90». */
  group?: string;
  title?: string;
  kind: ColKind;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Оператор", kind: "text" },
  { key: "taken", label: "Взял", title: "Взял сам из очереди или перехватил", kind: "count" },
  { key: "auto_assigned", label: "Авто", title: "Назначено автоматически", kind: "count" },
  { key: "resolved", label: "Решил", kind: "count" },
  { key: "replies", label: "Ответов", kind: "count" },
  { key: "response_median_s", group: "Ответ", label: "медиана", title: "Половина ответов быстрее", kind: "duration" },
  { key: "response_p90_s", group: "Ответ", label: "p90", title: "9 из 10 ответов быстрее", kind: "duration" },
  { key: "first_response_median_s", group: "Первый ответ", label: "медиана", title: "Половина первых ответов быстрее", kind: "duration" },
  { key: "first_response_p90_s", group: "Первый ответ", label: "p90", title: "9 из 10 первых ответов быстрее", kind: "duration" },
  { key: "within_sla_pct", label: "В срок", title: "Доля ответов в пределах SLA", kind: "percent" },
  { key: "reopen_rate_pct", label: "Переоткрыто", title: "Доля решённых, которые клиент открыл снова", kind: "percent" },
  { key: "resolution_median_s", label: "Решение", title: "Медиана: от сообщения клиента до решения", kind: "duration" },
  { key: "one_reply_pct", label: "Одним ответом", title: "Доля решённых одним ответом без переоткрытия", kind: "percent" },
];

export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** Nulls always sink to the bottom, whichever way the column sorts. */
export function sortOperators(rows: OperatorStats[], sort: Sort): OperatorStats[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "string" && typeof y === "string") return sign * x.localeCompare(y, "ru");
    return sign * ((x as number) - (y as number));
  });
}

const NO_RESOLVES: ReadonlySet<SortKey> = new Set(["resolution_median_s", "one_reply_pct"]);

function cell(col: Column, v: string | number | null): ReactNode {
  if (v === null) return <span className="text-text-muted">{NO_RESOLVES.has(col.key) ? "нет решённых" : "нет"}</span>;
  if (col.kind === "duration") return formatDuration(v as number);
  if (col.kind === "percent") return formatPercent(v as number);
  return v;
}

function OperatorTable({ rows, meId }: { rows: OperatorStats[]; meId: number }) {
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const sorted = useMemo(() => sortOperators(rows, sort), [rows, sort]);

  if (!rows.length) return <p className="text-text-muted">Операторов пока нет.</p>;

  const onSort = (key: SortKey, kind: ColKind) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: kind === "text" || kind === "duration" ? "asc" : "desc" },
    );

  return (
    <div className="overflow-x-auto rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">
      <table className="w-full min-w-[64rem] border-collapse text-left">
        <thead>
          <tr>
            {COLUMNS.map((c, i) => {
              if (!c.group) return <SortHeader key={c.key} col={c} sort={sort} onSort={onSort} rowSpan={2} />;
              if (COLUMNS[i - 1]?.group === c.group) return null;
              return (
                <th key={c.group} scope="colgroup" colSpan={2} className="h-6 px-3 pt-2 text-center align-bottom text-xs font-normal text-text-muted">
                  {c.group}
                </th>
              );
            })}
          </tr>
          <tr className="border-b border-border">
            {COLUMNS.filter((c) => c.group).map((c) => (
              <SortHeader key={c.key} col={c} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r) => (
            <tr key={r.operator_id} className="h-11">
              {COLUMNS.map((c) =>
                c.key === "name" ? (
                  <th key={c.key} scope="row" className="whitespace-nowrap px-4 text-left font-semibold">
                    {r.name}
                    {r.operator_id === meId && <span className="font-normal text-text-muted">, вы</span>}
                  </th>
                ) : (
                  <td key={c.key} className="num whitespace-nowrap px-4 text-right">
                    {cell(c, r[c.key])}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  col,
  sort,
  onSort,
  rowSpan,
}: {
  col: Column;
  sort: Sort;
  onSort: (key: SortKey, kind: ColKind) => void;
  rowSpan?: number;
}) {
  const active = sort.key === col.key;
  return (
    <th
      scope="col"
      rowSpan={rowSpan}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={cx(
        "h-8 px-1 pb-1 align-bottom font-normal",
        rowSpan !== undefined && "border-b border-border",
        col.kind !== "text" && "text-right",
        col.key === "name" && "pl-3",
      )}
    >
      <button
        type="button"
        title={col.title}
        aria-label={col.group ? `${col.group}, ${col.label}` : undefined}
        onClick={() => onSort(col.key, col.kind)}
        className={cx(
          "press hover-surface inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-xs",
          col.kind !== "text" && "flex-row-reverse",
          active ? "font-semibold text-text" : "text-text-muted",
        )}
      >
        {col.label}
        <Icon
          name="chevronDown"
          size={12}
          className={cx("shrink-0", !active && "invisible", active && sort.dir === "asc" && "rotate-180")}
        />
      </button>
    </th>
  );
}

function StatsSkeleton() {
  return (
    <div aria-hidden="true" className="flex max-w-[80rem] flex-col gap-8">
      <div className="h-[4.5rem] rounded-md bg-hover" />
      <div className="h-[15rem] rounded-md bg-hover" />
      <div className="h-32 rounded-md bg-hover" />
    </div>
  );
}
