import type { HeatCell } from "../lib/stats";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 7 × 24 grid of new tickets in Moscow time; darker means more. */
export function StatsHeatmap({ cells }: { cells: HeatCell[] }) {
  if (!cells.length) return <p className="text-text-muted">За период новых обращений нет.</p>;
  const count = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.n]));
  const max = Math.max(...cells.map((c) => c.n));
  return (
    <div className="overflow-x-auto rounded-md bg-surface p-3 shadow-[0_0_0_1px_var(--border)]">
      <table aria-label="Новые обращения по дням недели и часам" className="border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">День</span>
            </th>
            {HOURS.map((h) => (
              <th key={h} scope="col" aria-label={`${h}:00`} className="num w-6 font-normal text-text-muted">
                {h % 3 === 0 ? h : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAYS.map((day, i) => (
            <tr key={day}>
              <th scope="row" className="pr-2 text-left font-normal text-text-muted">
                {day}
              </th>
              {HOURS.map((h) => {
                const n = count.get(`${i + 1}:${h}`) ?? 0;
                return (
                  <td key={h} title={`${day}, ${h}:00–${h}:59: ${n}`} className="h-6 w-6 rounded-xs bg-hover p-0">
                    {n > 0 && (
                      <span data-fill className="block h-full w-full rounded-xs bg-accent" style={{ opacity: 0.2 + 0.8 * (n / max) }} />
                    )}
                    <span className="sr-only">{n}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
