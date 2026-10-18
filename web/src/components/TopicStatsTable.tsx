import { formatDuration, formatPercent, type TopicStats } from "../lib/stats";

const delta = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

/** Contact reasons for the range: resolved count, change vs the previous equal period, share, median time. */
export function TopicStatsTable({ rows }: { rows: TopicStats[] }) {
  if (!rows.length) return <p className="text-text-muted">За период решённых обращений нет.</p>;
  return (
    <div className="overflow-x-auto rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-xs text-text-muted">
            <th scope="col" className="h-8 px-4 font-normal">Тема</th>
            <th scope="col" className="px-4 text-right font-normal">Решено</th>
            <th scope="col" className="px-4 text-right font-normal" title="Разница с предыдущим таким же периодом">К прошлому</th>
            <th scope="col" className="px-4 text-right font-normal">Доля</th>
            <th scope="col" className="px-4 text-right font-normal" title="Медиана: от сообщения клиента до решения">Время решения</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.topic_id ?? "none"} className="h-11">
              <th scope="row" className={r.topic_id === null ? "px-4 font-normal text-text-muted" : "px-4 font-semibold"}>{r.name}</th>
              <td className="num px-4 text-right">{r.resolved}</td>
              <td className="num px-4 text-right text-text-muted">{delta(r.resolved - r.prev_resolved)}</td>
              <td className="num px-4 text-right">{r.share_pct === null ? <span className="text-text-muted">нет</span> : formatPercent(r.share_pct)}</td>
              <td className="num px-4 text-right">
                {r.resolution_median_s === null ? <span className="text-text-muted">нет</span> : formatDuration(r.resolution_median_s)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
