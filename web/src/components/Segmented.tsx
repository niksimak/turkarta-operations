import { useRef, type KeyboardEvent } from "react";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** A radiogroup drawn as one plate of segments; arrow keys move and select, like native radios. */
export function Segmented<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled,
}: {
  label?: string;
  labelledBy?: string;
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className="inline-flex max-w-full flex-wrap rounded-sm bg-bg p-0.5 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              "press h-7 whitespace-nowrap rounded-xs px-2.5 text-sm disabled:cursor-not-allowed",
              active
                ? "bg-surface font-semibold text-text shadow-[0_0_0_1px_var(--border)]"
                : "hover-surface text-text-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
