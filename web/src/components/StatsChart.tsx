import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHANNEL_LABEL, type ChannelFilter } from "../lib/tickets";
import { formatDayLong, formatDayShort, type DayCount } from "../lib/stats";

// Stack order bottom to top, the same order as every channel list in the app.
export const SERIES: ChannelFilter[] = ["bot", "miniapp", "web"];
const COLOR: Record<ChannelFilter, string> = { bot: "var(--ch-bot)", miniapp: "var(--ch-miniapp)", web: "var(--ch-web)" };

const HEIGHT = 200;
const PAD = { top: 8, right: 8, bottom: 24, left: 36 };
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;
const FALLBACK_WIDTH = 640;
const LABEL_SPACE = 56;

const total = (d: DayCount) => d.bot + d.miniapp + d.web;

/** Ticks on a 1/2/5 step, at most five intervals, top tick at or above `max`. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw && Number.isInteger(s)) ?? Math.ceil(raw);
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

/** A column segment whose top corners are rounded and bottom corners square. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function StatsChart({ days }: { days: DayCount[] }) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const sums = Object.fromEntries(SERIES.map((s) => [s, days.reduce((n, d) => n + d[s], 0)])) as Record<ChannelFilter, number>;
  const grand = SERIES.reduce((n, s) => n + sums[s], 0);
  const ticks = niceTicks(Math.max(0, ...days.map(total)));
  const yMax = ticks.at(-1)!;
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(BAR_MAX, band * 0.6));
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / LABEL_SPACE))));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const base = PAD.top + plotH;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!days.length) return;
    const last = days.length - 1;
    const next =
      e.key === "ArrowRight" ? Math.min(last, (active ?? -1) + 1)
      : e.key === "ArrowLeft" ? Math.max(0, (active ?? last + 1) - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  const day = active !== null ? days[active] : undefined;
  const tipLeft = active !== null ? PAD.left + band * (active + 0.5) : 0;
  const tipOnLeft = tipLeft > width * 0.6;

  // One day is a one-bar chart: the legend totals already say everything.
  const showPlot = days.length > 1 && grand > 0;

  return (
    <div ref={ref} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <ul aria-label="Каналы" className="flex flex-wrap gap-x-5 gap-y-1">
          {SERIES.map((s) => (
            <li key={s} className="inline-flex items-center gap-2 text-sm">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: COLOR[s] }} />
              <span className="text-text-muted">{CHANNEL_LABEL[s]}</span>
              <span className="num font-semibold">{sums[s]}</span>
            </li>
          ))}
        </ul>
        {days.length > 1 && (
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
            className="press hover-surface ml-auto h-7 rounded-sm px-2 text-sm text-text-muted"
          >
            {asTable ? "Показать график" : "Показать таблицей"}
          </button>
        )}
      </div>

      {asTable ? (
        <DayTable days={days} />
      ) : !showPlot ? (
        days.length > 1 && <p className="text-text-muted">Новых обращений за период нет.</p>
      ) : (
        <div
          role="group"
          tabIndex={0}
          aria-label="Новые обращения по дням. Стрелки влево и вправо переключают день."
          onKeyDown={onKeyDown}
          onFocus={() => setActive((a) => a ?? days.length - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="relative rounded-sm"
        >
          <svg width={width} height={HEIGHT} aria-hidden="true" className="block overflow-visible">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-[var(--text-muted)] text-xs">
                  {t}
                </text>
              </g>
            ))}
            {active !== null && (
              <rect x={PAD.left + band * active} y={PAD.top} width={band} height={plotH} fill="var(--hover)" rx={4} />
            )}
            {days.map((d, i) => {
              const x = PAD.left + band * i + (band - barW) / 2;
              const nonZero = SERIES.filter((s) => d[s] > 0);
              let cum = 0;
              return (
                <g key={d.day}>
                  {nonZero.map((s, k) => {
                    const bottomPx = base - (cum / yMax) * plotH - (k > 0 ? GAP : 0);
                    cum += d[s];
                    const topPx = base - (cum / yMax) * plotH;
                    const h = Math.max(1, bottomPx - topPx);
                    const isTop = k === nonZero.length - 1;
                    return isTop ? (
                      <path key={s} d={topRounded(x, bottomPx - h, barW, h, RADIUS)} fill={COLOR[s]} />
                    ) : (
                      <rect key={s} x={x} y={bottomPx - h} width={barW} height={h} fill={COLOR[s]} />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text x={PAD.left + band * (i + 0.5)} y={HEIGHT - 6} textAnchor="middle" className="num fill-[var(--text-muted)] text-xs">
                      {formatDayShort(d.day)}
                    </text>
                  )}
                  <rect
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={plotH + PAD.bottom}
                    fill="transparent"
                    onPointerEnter={() => setActive(i)}
                    onPointerMove={() => setActive(i)}
                  />
                </g>
              );
            })}
          </svg>
          {day && (
            <div
              role="status"
              className="pointer-events-none absolute top-0 z-10 min-w-[11rem] rounded-md bg-surface px-3 py-2 shadow-[0_0_0_1px_var(--border),var(--shadow-pop)]"
              style={tipOnLeft ? { right: width - tipLeft + band / 2 + 4 } : { left: tipLeft + band / 2 + 4 }}
            >
              <p className="mb-1 text-xs text-text-muted">{formatDayLong(day.day)}</p>
              {[...SERIES].reverse().map((s) => (
                <p key={s} className="flex items-center gap-2 text-sm">
                  <span aria-hidden="true" className="h-0.5 w-2.5 rounded-full" style={{ background: COLOR[s] }} />
                  <span className="num w-6 font-semibold">{day[s]}</span>
                  <span className="text-text-muted">{CHANNEL_LABEL[s]}</span>
                </p>
              ))}
              <p className="mt-1 flex items-center gap-2 border-t border-border pt-1 text-sm">
                <span aria-hidden="true" className="w-2.5" />
                <span className="num w-6 font-semibold">{total(day)}</span>
                <span className="text-text-muted">всего</span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DayTable({ days }: { days: DayCount[] }) {
  return (
    <div className="max-h-[20rem] overflow-auto rounded-md shadow-[0_0_0_1px_var(--border)]">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-border text-xs text-text-muted">
            <th scope="col" className="h-8 px-3 font-normal">День</th>
            {SERIES.map((s) => (
              <th key={s} scope="col" className="px-3 text-right font-normal">
                {CHANNEL_LABEL[s]}
              </th>
            ))}
            <th scope="col" className="px-3 text-right font-normal">Всего</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {days.map((d) => (
            <tr key={d.day} className="h-8">
              <th scope="row" className="px-3 font-normal">{formatDayLong(d.day)}</th>
              {SERIES.map((s) => (
                <td key={s} className="num px-3 text-right">{d[s]}</td>
              ))}
              <td className="num px-3 text-right font-semibold">{total(d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
