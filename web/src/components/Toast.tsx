import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "./Icon";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  tone: "default" | "danger";
  action?: ToastAction;
}

const DURATION_MS = 4_000;
const MAX_VISIBLE = 3;

let items: ToastItem[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

function set(next: ToastItem[]) {
  items = next;
  for (const fn of subscribers) fn();
}

/** Call from anywhere; the one <Toaster /> in the shell renders it. */
export function toast(text: string, opts: { tone?: ToastItem["tone"]; action?: ToastAction } = {}): number {
  const id = nextId++;
  set([...items.filter((t) => t.text !== text), { id, text, tone: opts.tone ?? "default", action: opts.action }].slice(-MAX_VISIBLE));
  return id;
}

export function dismissToast(id: number): void {
  set(items.filter((t) => t.id !== id));
}

export function resetToastsForTests(): void {
  set([]);
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items);
  return (
    <div
      aria-live="polite"
      aria-label="Уведомления"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {list.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    // Hold the toast while the tab is hidden, so it is still there when the operator comes back.
    let left = DURATION_MS;
    let started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      started = Date.now();
      timer = setTimeout(() => dismissToast(item.id), left);
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        left -= Date.now() - started;
      } else run();
    };
    if (!document.hidden) run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [item.id]);

  return (
    <div
      className={
        "enter-rise pointer-events-auto flex items-center gap-3 rounded-md bg-surface px-3 py-2.5 text-base shadow-pop " +
        "shadow-[0_0_0_1px_var(--border),var(--shadow-pop)] " +
        (item.tone === "danger" ? "text-danger" : "text-text")
      }
    >
      <p className="min-w-0 flex-1">{item.text}</p>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action!.onClick();
            dismissToast(item.id);
          }}
          className="press hover-surface h-7 shrink-0 rounded-sm px-2 text-sm font-semibold text-accent"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Закрыть"
        onClick={() => dismissToast(item.id)}
        className="press hover-surface grid size-7 shrink-0 place-items-center rounded-sm text-text-muted"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
