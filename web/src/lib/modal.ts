import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside `container`, and pulls focus back in when it sits on a non-focusable spot. */
export function trapTab(e: KeyboardEvent, container: HTMLElement): void {
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items.at(-1);
  const active = document.activeElement;
  e.preventDefault();
  if (!first || !last) {
    container.focus();
    return;
  }
  if (!(active instanceof Node) || !container.contains(active) || active === container) {
    (e.shiftKey ? last : first).focus();
    return;
  }
  const i = items.indexOf(active as HTMLElement);
  const next = e.shiftKey ? (i <= 0 ? last : items[i - 1]!) : i === items.length - 1 ? first : items[i + 1]!;
  next.focus();
}

interface ModalOptions {
  onClose: () => void;
  /** Keys other than Escape and Tab while the layer is open. */
  onKey?: (e: KeyboardEvent) => void;
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Modal behaviour for a layer portalled to <body>: focus moves in once on open,
 * Tab is trapped, Escape closes, the app behind is inert, focus returns on close.
 * Keys are handled on the document, so they work wherever focus landed, and they
 * never reach the inbox shortcuts behind the layer.
 */
export function useModal(ref: RefObject<HTMLElement | null>, options: ModalOptions): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (latest.current.initialFocus?.current ?? container).focus();
    const app = document.getElementById("root");
    const wasInert = app?.inert ?? false;
    if (app && !app.contains(container)) app.inert = true;

    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        latest.current.onClose();
      } else if (e.key === "Tab") {
        trapTab(e, container);
      } else {
        latest.current.onKey?.(e);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (app) app.inert = wasInert;
      previous?.focus();
    };
  }, [ref]);
}
