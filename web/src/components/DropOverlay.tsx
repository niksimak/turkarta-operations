import { useEffect, useRef, useState, type DragEvent } from "react";
import { Icon } from "./Icon";
import { dragHasFiles } from "../lib/files";

/** Why a drop would be ignored right now; null accepts it. */
export type DropBlock = "locked" | "resolved" | null;

const BLOCK_TEXT: Record<Exclude<DropBlock, null>, string> = {
  locked: "Сначала нажмите «Перехватить»",
  resolved: "Обращение решено. Чтобы написать, смените статус.",
};

interface DropOptions {
  block: DropBlock;
  onFiles: (files: File[]) => void;
}

// Browsers repeat dragover at least every ~550 ms while a drag hovers; silence
// longer than this means the drag ended somewhere we got no event for.
const STALE_DRAG_MS = 1_000;

/**
 * Drag-and-drop of OS files onto an element. Entering and leaving child
 * elements fires dragenter/dragleave in pairs, so a depth counter (not the
 * event target) decides when the drag really left; that keeps the overlay
 * from flickering as the pointer crosses messages.
 */
export function useFileDrop({ block, onFiles }: DropOptions) {
  const depth = useRef(0);
  const stale = useRef<ReturnType<typeof setTimeout>>();
  const [active, setActive] = useState(false);
  const latest = useRef({ block, onFiles });
  latest.current = { block, onFiles };

  const reset = useRef(() => {
    clearTimeout(stale.current);
    depth.current = 0;
    setActive(false);
  }).current;
  const touch = () => {
    clearTimeout(stale.current);
    stale.current = setTimeout(reset, STALE_DRAG_MS);
  };

  useEffect(() => {
    // A photo dropped just outside the pane would replace the CRM tab with the image.
    const guard = (e: globalThis.DragEvent) => {
      if (dragHasFiles(e.dataTransfer)) e.preventDefault();
    };
    const onWindowDrop = (e: globalThis.DragEvent) => {
      guard(e);
      reset();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", onWindowDrop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", onWindowDrop);
      window.removeEventListener("dragend", reset);
      clearTimeout(stale.current);
    };
  }, [reset]);

  const handlers = {
    onDragEnter(e: DragEvent) {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      touch();
      depth.current += 1;
      if (depth.current === 1) setActive(true);
    },
    onDragOver(e: DragEvent) {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      touch();
      // The staleness reset can fire during a long hover; a live drag turns the overlay back on.
      if (depth.current === 0) {
        depth.current = 1;
        setActive(true);
      }
      e.dataTransfer.dropEffect = latest.current.block ? "none" : "copy";
    },
    onDragLeave(e: DragEvent) {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) reset();
    },
    onDrop(e: DragEvent) {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      reset();
      if (latest.current.block) return;
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) latest.current.onFiles(files);
    },
  };

  return { active, handlers };
}

/** Stays mounted so leaving is a short fade, not a cut; never takes pointer events. */
export function DropOverlay({ active, block }: { active: boolean; block: DropBlock }) {
  return (
    <div
      aria-hidden={!active}
      data-active={active ? "" : undefined}
      data-blocked={block ? "" : undefined}
      className="drop-overlay pointer-events-none absolute inset-0 z-20 p-2"
    >
      <div className="drop-plate flex size-full flex-col items-center justify-center gap-2 rounded-lg px-6 text-center">
        <Icon name={block ? "alert" : "image"} size={28} className={block ? "text-text-muted" : "text-accent"} />
        <p className="text-lg font-semibold">{block ? BLOCK_TEXT[block] : "Отпустите, чтобы прикрепить"}</p>
        {!block && <p className="text-sm text-text-muted">JPG, PNG, WEBP до 8 МБ, до 10 фото</p>}
      </div>
    </div>
  );
}
