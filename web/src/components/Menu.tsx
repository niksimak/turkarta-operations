import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** Text for type-ahead and the accessible name when label is rich. */
  text: string;
  onSelect: () => void;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface Props {
  /** Visible trigger content. */
  trigger: ReactNode;
  /** Accessible name of the trigger. */
  label: string;
  title?: string;
  items: MenuItem[];
  disabled?: boolean;
  /** Radio semantics (one checked item) or plain actions. */
  kind?: "radio" | "action";
  triggerClassName?: string;
  footer?: ReactNode;
  /** Which trigger edge the popover lines up with; it scales from that corner. */
  align?: "start" | "end";
}

/** A small menu button: arrow keys, Home/End, Escape returns focus; scales in from its trigger corner. */
export function Menu({ trigger, label, title, items, disabled, kind = "radio", triggerClassName, footer, align = "start" }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const start = Math.max(0, items.findIndex((i) => i.checked && !i.disabled));
    const first = items[start]?.disabled ? items.findIndex((i) => !i.disabled) : start;
    itemRefs.current[first]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // Focus only when the menu opens, not when items refresh behind it.
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    const pos = enabled.indexOf(current);
    let next: number | undefined;
    if (e.key === "ArrowDown") next = enabled[(pos + 1) % enabled.length];
    else if (e.key === "ArrowUp") next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled.at(-1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    } else if (e.key === "Tab") {
      close(false);
      return;
    }
    if (next !== undefined) {
      e.preventDefault();
      itemRefs.current[next]?.focus();
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          "press hover-surface flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 shadow-[inset_0_0_0_1px_var(--border-strong)] disabled:opacity-50",
          open && "bg-pressed",
          triggerClassName,
        )}
      >
        {trigger}
        <Icon name="chevronDown" size={14} className="text-text-muted" />
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          style={{ ["--origin" as string]: align === "start" ? "top left" : "top right" }}
          className={cx(align === "start" ? "left-0" : "right-0", "pop-in absolute top-full z-30 mt-1 flex max-h-80 min-w-64 flex-col overflow-auto rounded-md bg-surface p-1 shadow-[0_0_0_1px_var(--border),var(--shadow-pop)]")}
        >
          {items.map((it, i) => (
            <div key={it.key}>
              {it.separatorBefore && <div role="separator" className="mx-1 my-1 h-px bg-border" />}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={kind === "radio" ? "menuitemradio" : "menuitem"}
                aria-checked={kind === "radio" ? Boolean(it.checked) : undefined}
                aria-label={it.text}
                disabled={it.disabled}
                tabIndex={-1}
                onClick={() => {
                  it.onSelect();
                  close();
                }}
                className="press hover-surface flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left focus-visible:bg-hover disabled:opacity-50"
              >
                <span className="grid w-4 shrink-0 place-items-center text-accent">
                  {it.checked && <Icon name="check" size={14} />}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">{it.label}</span>
              </button>
            </div>
          ))}
          {footer}
        </div>
      )}
    </div>
  );
}
