import { useEffect, useRef, type ReactNode } from "react";
import { Avatar } from "./TicketRow";
import type { CannedReply } from "../lib/canned";
import type { OperatorSummary } from "../lib/tickets";

export const optionId = (listId: string, i: number) => `${listId}-opt-${i}`;

interface ListProps<T> {
  id: string;
  label: string;
  items: T[];
  active: number;
  onActive: (i: number) => void;
  onPick: (item: T) => void;
  render: (item: T) => ReactNode;
  itemKey: (item: T) => string;
  /** Shown instead of options: loading rows or a one-line empty state. */
  placeholder?: ReactNode;
}

/**
 * Suggestions above the composer. Focus stays in the textarea (it owns the
 * arrow keys and points at the active option with aria-activedescendant), so
 * options take mouse input without stealing focus. Opened from the keyboard,
 * it appears without motion.
 */
function SuggestionList<T>({ id, label, items, active, onActive, onPick, render, itemKey, placeholder }: ListProps<T>) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.ownerDocument.getElementById(optionId(id, active))?.scrollIntoView?.({ block: "nearest" });
  }, [id, active]);
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-md bg-surface shadow-[0_0_0_1px_var(--border),var(--shadow-pop)]">
      {placeholder ?? (
        <ul ref={list} id={id} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
          {items.map((item, i) => (
            <li
              key={itemKey(item)}
              id={optionId(id, i)}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== active && onActive(i)}
              onClick={() => onPick(item)}
              className={
                "flex cursor-pointer items-center gap-2 px-3 py-1.5 " + (i === active ? "bg-accent-soft" : "")
              }
            >
              {render(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CannedProps {
  id: string;
  items: CannedReply[];
  loading: boolean;
  /** Nothing saved at all, as opposed to nothing matching the query. */
  empty: boolean;
  active: number;
  onActive: (i: number) => void;
  onPick: (r: CannedReply) => void;
}

export function CannedPicker({ id, items, loading, empty, active, onActive, onPick }: CannedProps) {
  const placeholder = loading ? (
    <div aria-hidden="true" className="flex flex-col gap-2 px-3 py-2.5">
      <div className="h-4 w-1/3 rounded-xs bg-hover" />
      <div className="h-4 w-2/3 rounded-xs bg-hover" />
      <div className="h-4 w-1/2 rounded-xs bg-hover" />
    </div>
  ) : !items.length ? (
    <p role="status" className="px-3 py-2.5 text-text-muted">
      {empty ? "Шаблонов пока нет. Добавьте их в разделе «Шаблоны»." : "Ничего не нашлось. Esc закроет поиск."}
    </p>
  ) : undefined;
  return (
    <SuggestionList
      id={id}
      label="Шаблоны"
      items={items}
      active={active}
      onActive={onActive}
      onPick={onPick}
      itemKey={(r) => r.id}
      placeholder={placeholder}
      render={(r) => (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{r.title}</span>
          <span className="truncate text-sm text-text-muted">{r.body.split("\n")[0]}</span>
        </span>
      )}
    />
  );
}

interface MentionProps {
  id: string;
  items: OperatorSummary[];
  active: number;
  onActive: (i: number) => void;
  onPick: (o: OperatorSummary) => void;
}

export function MentionPicker({ id, items, active, onActive, onPick }: MentionProps) {
  return (
    <SuggestionList
      id={id}
      label="Упомянуть коллегу"
      items={items}
      active={active}
      onActive={onActive}
      onPick={onPick}
      itemKey={(o) => String(o.id)}
      render={(o) => (
        <>
          <span aria-hidden="true">
            <Avatar name={o.name} />
          </span>
          <span className="min-w-0 flex-1 truncate">{o.name}</span>
          <span className="shrink-0 text-xs text-text-muted">{o.on_shift ? "на смене" : "не на смене"}</span>
        </>
      )}
    />
  );
}
