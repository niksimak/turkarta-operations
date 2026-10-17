import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useModal } from "../lib/modal";
import { attachmentUrl, type Attachment } from "../lib/tickets";

const OPEN_MS = 260;
const CLOSE_MS = 200;
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Transform that puts `to` exactly over `from`: uniform scale, centres aligned. */
function flipFrom(from: DOMRect, to: DOMRect): string {
  const scale = Math.max(from.width / to.width, from.height / to.height);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

function visible(el: HTMLElement | null): DOMRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return null;
  return r;
}

interface Props {
  photos: Attachment[];
  index: number;
  onIndex: (index: number) => void;
  /** The thumbnail the photo zooms out of and back into. */
  thumbFor: (index: number) => HTMLElement | null;
  onClose: () => void;
}

export function Lightbox({ photos, index, onIndex, thumbFor, onClose }: Props) {
  const img = useRef<HTMLImageElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const [closing, setClosing] = useState(false);
  const photo = photos[index];
  const many = photos.length > 1;

  const zoomIn = useCallback(() => {
    if (opened.current || !img.current) return;
    opened.current = true;
    const el = img.current;
    if (typeof el.animate !== "function") return;
    scrim.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE_OUT });
    const from = visible(thumbFor(index));
    if (!from || reducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE_OUT });
      return;
    }
    el.animate([{ transform: flipFrom(from, el.getBoundingClientRect()) }, { transform: "none" }], {
      duration: OPEN_MS,
      easing: EASE_OUT,
    });
  }, [index, thumbFor]);

  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth) zoomIn();
  }, [zoomIn]);

  const close = useCallback(() => {
    if (closing) return;
    const el = img.current;
    if (!el || typeof el.animate !== "function") {
      onClose();
      return;
    }
    setClosing(true);
    const to = visible(thumbFor(index));
    scrim.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE_OUT, fill: "forwards" });
    const anim =
      to && !reducedMotion()
        ? el.animate([{ transform: "none" }, { transform: flipFrom(to, el.getBoundingClientRect()) }], {
            duration: CLOSE_MS,
            easing: EASE_OUT,
            fill: "forwards",
          })
        : el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE_OUT, fill: "forwards" });
    anim.onfinish = onClose;
  }, [closing, index, onClose, thumbFor]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const step = (delta: number) => onIndex((index + delta + photos.length) % photos.length);

  useModal(dialog, {
    onClose: close,
    initialFocus: closeBtn,
    onKey: (e) => {
      if (!many) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
    },
  });

  if (!photo) return null;

  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={many ? `Фото ${index + 1} из ${photos.length}` : "Фото"}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-center focus-visible:outline-none"
    >
      <div ref={scrim} className="absolute inset-0 bg-scrim" onClick={close} aria-hidden="true" />
      <img
        ref={img}
        key={photo.id}
        src={photo.preview ?? attachmentUrl(photo.id)}
        alt=""
        onLoad={zoomIn}
        onClick={close}
        className="relative max-h-[88vh] max-w-[92vw] origin-center cursor-zoom-out rounded-md object-contain shadow-pop"
      />
      <div className="absolute right-3 top-3 flex items-center gap-2">
        {many && (
          <span className="num rounded-sm bg-surface px-2 py-1 text-sm text-text shadow-[0_0_0_1px_var(--border)]">
            {index + 1} / {photos.length}
          </span>
        )}
        <button
          ref={closeBtn}
          type="button"
          aria-label="Закрыть"
          onClick={close}
          className="press grid size-9 place-items-center rounded-sm bg-surface text-text shadow-[0_0_0_1px_var(--border)]"
        >
          <Icon name="close" />
        </button>
      </div>
      {many && (
        <div className="pointer-events-none absolute inset-x-3 top-1/2 flex -translate-y-1/2 justify-between">
          <button
            type="button"
            aria-label="Предыдущее фото"
            onClick={() => step(-1)}
            className="press pointer-events-auto grid size-9 place-items-center rounded-sm bg-surface text-text shadow-[0_0_0_1px_var(--border)]"
          >
            <Icon name="chevronLeft" />
          </button>
          <button
            type="button"
            aria-label="Следующее фото"
            onClick={() => step(1)}
            className="press pointer-events-auto grid size-9 place-items-center rounded-sm bg-surface text-text shadow-[0_0_0_1px_var(--border)]"
          >
            <Icon name="chevronRight" />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
