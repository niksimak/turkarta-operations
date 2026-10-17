import { useLayoutEffect, useRef } from "react";
import { TicketRow } from "./TicketRow";
import type { SlaSettings } from "../lib/sla";
import type { TicketListItem } from "../lib/tickets";

const REORDER_MS = 200;
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Props {
  items: TicketListItem[];
  /** Changes when the view or filters change; a new set of rows is a new page, not a reorder. */
  scopeKey: string;
  openId: string | undefined;
  cursorId: string | undefined;
  hrefFor: (id: string) => string;
  settings: SlaSettings;
  meId: number | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  empty: { text: string; action?: { label: string; onClick: () => void } };
}

export function TicketList(props: Props) {
  const { items, scopeKey, openId, cursorId, hrefFor, settings, meId } = props;
  const rows = useRef(new Map<string, HTMLAnchorElement>());
  const tops = useRef<{ scope: string; byId: Map<string, number> } | null>(null);
  const order = items.map((t) => t.id).join(",");

  // FLIP: rows that moved because the data changed glide to their new slot;
  // rows that arrived fade in. Keyboard navigation never changes order, so it never animates.
  useLayoutEffect(() => {
    const now = new Map<string, number>();
    for (const [id, el] of rows.current) now.set(id, el.offsetTop);
    const prev = tops.current;
    if (prev && prev.scope === scopeKey) {
      const reduced = prefersReducedMotion();
      for (const [id, top] of now) {
        const el = rows.current.get(id);
        if (!el || typeof el.animate !== "function") continue;
        const before = prev.byId.get(id);
        if (before === undefined) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REORDER_MS, easing: EASE_OUT });
        } else if (before !== top && !reduced) {
          el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
            duration: REORDER_MS,
            easing: EASE_IN_OUT,
          });
        }
      }
    }
    tops.current = { scope: scopeKey, byId: now };
  }, [order, scopeKey]);

  if (props.loading) return <ListSkeleton />;
  if (props.error && !items.length) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-4 py-4">
        <p>Список не загрузился.</p>
        <button
          type="button"
          onClick={props.onRetry}
          className="press hover-surface h-8 rounded-sm px-3 font-semibold shadow-[inset_0_0_0_1px_var(--border-strong)]"
        >
          Повторить
        </button>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="flex flex-col items-start gap-2 px-4 py-4 text-text-muted">
        <p>{props.empty.text}</p>
        {props.empty.action && (
          <button
            type="button"
            onClick={props.empty.action.onClick}
            className="press hover-surface h-8 rounded-sm px-3 font-semibold text-text shadow-[inset_0_0_0_1px_var(--border-strong)]"
          >
            {props.empty.action.label}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <ul aria-label="Обращения" className="relative divide-y divide-border border-b border-border">
        {items.map((t) => (
          <li key={t.id}>
            <TicketRow
              ref={(el) => {
                if (el) rows.current.set(t.id, el);
                else rows.current.delete(t.id);
              }}
              ticket={t}
              href={hrefFor(t.id)}
              settings={settings}
              open={t.id === openId}
              cursor={t.id === cursorId && t.id !== openId}
              meId={meId}
            />
          </li>
        ))}
      </ul>
      {props.hasMore && (
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={props.onLoadMore}
            disabled={props.loadingMore}
            className="press hover-surface h-8 w-full rounded-sm text-text-muted shadow-[inset_0_0_0_1px_var(--border)] disabled:opacity-60"
          >
            {props.loadingMore ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      )}
    </>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden="true" className="divide-y divide-border">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-14 flex-col justify-center gap-2 px-3">
          <div className="h-3 w-2/5 rounded-xs bg-hover" />
          <div className="ml-4 h-2.5 w-3/4 rounded-xs bg-hover" />
        </div>
      ))}
    </div>
  );
}
