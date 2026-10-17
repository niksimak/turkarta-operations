import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { isVideoFile, MAX_PHOTOS } from "../lib/files";

/**
 * One object URL per File while it is in the list: revoked when the file is
 * removed or sent (it leaves the list) and on unmount. Created in an effect,
 * so a StrictMode remount recreates what its cleanup revoked.
 */
function useObjectUrls(files: File[]): Map<File, string> {
  const cache = useRef(new Map<File, string>());
  const [, rerender] = useState(0);
  useEffect(() => {
    const urls = cache.current;
    let changed = false;
    for (const f of files) {
      if (!urls.has(f)) {
        urls.set(f, URL.createObjectURL(f));
        changed = true;
      }
    }
    for (const [f, url] of urls) {
      if (!files.includes(f)) {
        URL.revokeObjectURL(url);
        urls.delete(f);
      }
    }
    if (changed) rerender((n) => n + 1);
  }, [files]);
  useEffect(() => {
    const urls = cache.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
  return cache.current;
}

// Stable keys: removing one photo must not remount (and re-animate) the ones after it.
const fileIds = new WeakMap<File, number>();
let nextFileId = 1;
function fileKey(f: File): number {
  let id = fileIds.get(f);
  if (id === undefined) {
    id = nextFileId++;
    fileIds.set(f, id);
  }
  return id;
}

interface Props {
  files: File[];
  onRemove: (file: File) => void;
  /** The photo the server refused on the last send, marked until removed. */
  refused?: File | null;
}

export function PhotoStrip({ files, onRemove, refused }: Props) {
  const urls = useObjectUrls(files);
  if (!files.length) return null;
  return (
    <div className="flex items-end gap-2 px-2 pt-2">
      <ul aria-label={files.some(isVideoFile) ? "Видео к отправке" : "Фото к отправке"} className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5 pt-1.5 pr-1.5">
        {files.map((f) => {
          const url = urls.get(f);
          const bad = f === refused;
          return (
            <li key={fileKey(f)} data-refused={bad ? "" : undefined} className="thumb-in relative size-14 shrink-0">
              <div title={bad ? "Фото не принято" : undefined} className="relative size-full overflow-hidden rounded-sm bg-hover">
                {url && isVideoFile(f) && (
                  <>
                    <video src={url} muted playsInline preload="metadata" aria-label={f.name} className="block size-full object-cover" />
                    <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-white">▶</span>
                  </>
                )}
                {url && !isVideoFile(f) && (
                  <img
                    src={url}
                    alt={bad ? `${f.name}, не принято` : f.name}
                    className={"block size-full object-cover " + (bad ? "opacity-60" : "")}
                    draggable={false}
                  />
                )}
                {/* The outline sits over the photo; an inset shadow on the box would be painted under it. */}
                <span
                  aria-hidden="true"
                  className={
                    "pointer-events-none absolute inset-0 rounded-sm " +
                    (bad ? "shadow-[inset_0_0_0_2px_var(--danger)]" : "shadow-[inset_0_0_0_1px_var(--border)]")
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => onRemove(f)}
                aria-label={`Убрать ${isVideoFile(f) ? "видео" : "фото"} ${f.name}`}
                title="Убрать"
                className="press absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-surface text-text-muted shadow-[0_0_0_1px_var(--border-strong)] hover:text-text"
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <span className="num shrink-0 pb-1 text-xs text-text-muted">
        {files.some(isVideoFile) ? "видео" : `${files.length} из ${MAX_PHOTOS}`}
      </span>
    </div>
  );
}
