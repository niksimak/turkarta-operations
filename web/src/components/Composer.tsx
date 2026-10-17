import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CannedPicker, MentionPicker, optionId } from "./CannedPicker";
import { Icon } from "./Icon";
import { PhotoStrip } from "./PhotoStrip";
import { toast } from "./Toast";
import { fillTemplate, markCannedUsed, searchCanned, slashQuery, useCanned, type CannedReply, type TokenRange } from "../lib/canned";
import { acceptFiles, ATTACH_ACCEPT, groupRejections, nameList, REJECT_TEXT } from "../lib/files";
import { isShortcutBlocked } from "../lib/keyboard";
import { matchOperators, mentionQuery } from "../lib/mentions";
import { newClientKey } from "../lib/outbox";
import { useTypingPresence } from "../lib/presence";
import type { Operator } from "../lib/queries";
import {
  isAssignedToOther,
  refusedPhotoIndex,
  sendErrorText,
  useOperators,
  useSendMessage,
  type ComposeMode,
  type OperatorSummary,
  type TicketAction,
  type TicketDetailItem,
} from "../lib/tickets";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** Server limit on the trimmed body (src/crm/reply.ts). */
export const MAX_BODY = 4000;
const COUNTER_FROM = 3500;
const MAX_INPUT_PX = 240;

// ---------- photos waiting to be sent ----------

export interface PhotoDraft {
  files: File[];
  /** Validates and appends; rejected files get one toast per reason. */
  add: (incoming: File[]) => void;
  remove: (file: File) => void;
  set: (files: File[]) => void;
  /** Current list for async callbacks, where `files` would be stale. */
  peek: () => File[];
}

export function usePhotoDraft(): PhotoDraft {
  const [files, setFiles] = useState<File[]>([]);
  const ref = useRef(files);
  const set = useCallback((next: File[]) => {
    ref.current = next;
    setFiles(next);
  }, []);
  const add = useCallback(
    (incoming: File[]) => {
      const { accepted, rejected } = acceptFiles(ref.current, incoming);
      if (accepted.length) set([...ref.current, ...accepted]);
      for (const g of groupRejections(rejected)) {
        toast(`Не прикреплено: ${nameList(g.names)}`, { detail: REJECT_TEXT[g.reason], key: `reject:${g.reason}` });
      }
    },
    [set],
  );
  const remove = useCallback((file: File) => set(ref.current.filter((f) => f !== file)), [set]);
  const peek = useCallback(() => ref.current, []);
  return useMemo(() => ({ files, add, remove, set, peek }), [files, add, remove, set, peek]);
}

// ---------- the composer ----------

const MODE_LABEL: Record<ComposeMode, string> = { reply: "Ответ", note: "Заметка" };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl";

function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

type Picker = { kind: "canned" | "mention"; range: TokenRange };

export interface ComposerProps {
  ticket: TicketDetailItem;
  me: Operator;
  /** Assigned to a colleague: replies wait behind «Перехватить», notes stay open. */
  locked: boolean;
  mode: ComposeMode;
  onMode: (mode: ComposeMode) => void;
  photos: PhotoDraft;
  inputRef: RefObject<HTMLTextAreaElement>;
  /** Ticket-scoped, so a toast clicked after switching tickets still acts on this one. */
  runOn: (ticketId: string, action: TicketAction) => void;
  actionPending: boolean;
}

export function Composer({ ticket, me, locked, mode, onMode, photos, inputRef, runOn, actionPending }: ComposerProps) {
  const resolved = ticket.status === "resolved";
  const replyLocked = locked && mode === "reply";
  const note = mode === "note";
  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [refused, setRefused] = useState<File | null>(null);
  const [announce, setAnnounce] = useState("");
  const firstMode = useRef(true);
  const nextCaret = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const typing = useTypingPresence(ticket.id);
  const send = useSendMessage(ticket.id);
  const sendKey = me.prefs.send_key;

  // ---- suggestions: `/` canned replies, `@` colleagues in notes ----
  const slash = slashQuery(text, caret);
  const mention = note && !slash ? mentionQuery(text, caret) : null;
  const token: Picker | null = slash ? { kind: "canned", range: slash } : mention ? { kind: "mention", range: mention } : null;
  const tokenId = token ? `${token.kind}:${token.range.start}` : null;
  const picker = token && tokenId !== dismissed ? token : null;

  const canned = useCanned(picker?.kind === "canned");
  const operators = useOperators(note);
  const cannedItems = picker?.kind === "canned" ? searchCanned(canned.data ?? [], picker.range.query) : [];
  const mentionItems =
    picker?.kind === "mention"
      ? matchOperators((operators.data ?? []).filter((o) => o.id !== me.id), picker.range.query)
      : [];
  const showCanned = picker?.kind === "canned";
  // An @ with no matching colleague is plain text (an email, a handle), not a question.
  const showMention = picker?.kind === "mention" && mentionItems.length > 0;
  const count = showCanned ? cannedItems.length : showMention ? mentionItems.length : 0;
  // A canned search that found nothing leaves Enter and Tab to the composer.
  const pickerKeys = showMention || (showCanned && (canned.isPending || cannedItems.length > 0));
  const activeIndex = Math.min(active, Math.max(0, count - 1));

  useEffect(() => setActive(0), [picker?.kind, picker?.range.query]);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setAnnounce(mode === "note" ? "Режим: заметка" : "Режим: ответ");
  }, [mode]);
  useEffect(() => {
    if (!tokenId) setDismissed(null);
  }, [tokenId]);

  // Grow with the text up to a cap, and land the caret after programmatic inserts.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
    if (nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  }, [text, inputRef, replyLocked]);

  // `/` anywhere outside a field jumps into the composer and opens the canned search.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const slashKey = e.key === "/" || (e.code === "Slash" && !e.shiftKey);
      if (!slashKey || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isShortcutBlocked(e.target)) return;
      const el = inputRef.current;
      if (!el) return;
      e.preventDefault();
      el.focus();
      if (!textRef.current) {
        nextCaret.current = 1;
        setText("/");
        setCaret(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef]);

  const replaceRange = (range: TokenRange, insert: string) => {
    const value = text.slice(0, range.start) + insert + text.slice(range.end);
    const at = range.start + insert.length;
    nextCaret.current = at;
    setText(value);
    setCaret(at);
    typing();
  };
  const pickCanned = (r: CannedReply) => {
    if (picker?.kind !== "canned") return;
    replaceRange(picker.range, fillTemplate(r.body, { имя: firstName(ticket.user_name), оператор: me.name }));
    markCannedUsed(r.id);
  };
  const pickMention = (o: OperatorSummary) => {
    if (picker?.kind !== "mention") return;
    replaceRange(picker.range, `@${o.name} `);
    // The inserted name still reads as an `@query`; close it so Enter goes back to sending.
    setDismissed(`mention:${picker.range.start}`);
  };

  // ---- sending ----
  const body = text.trim();
  const overLimit = body.length > MAX_BODY;
  const hasContent = note ? body.length > 0 : body.length > 0 || photos.files.length > 0;
  const noteNeedsText = note && !body && photos.files.length > 0;
  const canSend = !resolved && !replyLocked && !send.isPending && hasContent && !overLimit;

  const submit = () => {
    if (!canSend) return;
    const files = photos.files;
    const draft = text;
    const vars = { clientKey: newClientKey(), kind: mode, body, photos: files };
    setText("");
    setCaret(0);
    setRefused(null);
    photos.set([]);
    send.mutateAsync(vars).catch((err: unknown) => {
      // Give the draft back unless the operator already started a new one, in
      // the mode it was sent in: a note must never come back as a reply.
      if (mounted.current && !textRef.current && !photos.peek().length) {
        onMode(vars.kind);
        setText(draft);
        photos.set(files);
        const bad = refusedPhotoIndex(err);
        setRefused(bad === null ? null : files[bad] ?? null);
      }
      const { text: msg, detail } = sendErrorText(err, files.map((f) => f.name));
      const ticketId = ticket.id;
      toast(msg, {
        tone: "danger",
        detail,
        key: `send:${ticketId}`,
        action: isAssignedToOther(err)
          ? { label: "Перехватить", onClick: () => runOn(ticketId, { kind: "take-over" }) }
          : undefined,
      });
    });
  };

  const toggleMode = () => onMode(note ? "reply" : "note");

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (pickerKeys) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (count) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + count) % count);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && plain) {
        e.preventDefault();
        if (showCanned && cannedItems[activeIndex]) pickCanned(cannedItems[activeIndex]!);
        if (showMention && mentionItems[activeIndex]) pickMention(mentionItems[activeIndex]!);
        return;
      }
    }
    if (showCanned || showMention) {
      if (e.key === "Escape" && picker) {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(tokenId);
        return;
      }
    }
    if (e.key === "." && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === "Tab" && plain && text === "") {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      if (e.ctrlKey || e.metaKey || sendKey === "enter") {
        e.preventDefault();
        submit();
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    // Copies from a page or a document carry text too; the browser pastes it.
    if (!Array.from(e.clipboardData.types ?? []).includes("text/plain")) e.preventDefault();
    photos.add(files);
  };

  if (resolved) {
    return (
      <div className="shrink-0 border-t border-border bg-surface">
        <p className="mx-auto max-w-4xl px-4 py-4 text-text-muted lg:px-6">Обращение решено. Чтобы написать, смените статус.</p>
      </div>
    );
  }

  const sendHint = sendKey === "enter" ? "Enter" : `${MOD}+Enter`;
  const activeOption = showCanned || showMention ? optionId(listId, activeIndex) : undefined;

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 pb-3 pt-2 lg:px-6">
        <div className="flex items-center gap-3">
          <ModeSwitch mode={mode} onMode={onMode} />
          <p data-mode-announcer="" aria-live="polite" className="sr-only">
            {announce}
          </p>
          {note ? (
            <p className="min-w-0 truncate text-xs text-note-text">Клиент заметку не увидит</p>
          ) : (
            <p className="hidden min-w-0 truncate text-xs text-text-muted sm:block">
              <Kbd>Tab</Kbd> в пустом поле или <Kbd>{`${MOD}+.`}</Kbd> переключает
            </p>
          )}
        </div>

        {replyLocked ? (
          <div className="flex items-center gap-3 rounded-md bg-surface-2 px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
            <p className="min-w-0 flex-1">
              {ticket.assigned_operator_name
                ? `Обращение у оператора ${ticket.assigned_operator_name}.`
                : "Обращение у другого оператора."}{" "}
              <span className="text-text-muted">Чтобы ответить, перехватите его.</span>
            </p>
            <button
              type="button"
              onClick={() => runOn(ticket.id, { kind: "take-over" })}
              disabled={actionPending}
              className="press h-8 shrink-0 rounded-sm bg-accent px-3 font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
            >
              Перехватить
            </button>
          </div>
        ) : (
          <div className="relative">
            {showCanned && (
              <CannedPicker
                id={listId}
                items={cannedItems}
                loading={canned.isPending}
                empty={(canned.data ?? []).length === 0}
                active={activeIndex}
                onActive={setActive}
                onPick={pickCanned}
              />
            )}
            {showMention && (
              <MentionPicker id={listId} items={mentionItems} active={activeIndex} onActive={setActive} onPick={pickMention} />
            )}
            <div
              data-mode={mode}
              className={cx(
                "flex flex-col rounded-md",
                note
                  ? "bg-note-bg shadow-[inset_0_0_0_1px_var(--note-border)]"
                  : "bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)]",
                // The textarea's own outline is replaced by this ring around the whole box.
                "has-[textarea:focus-visible]:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_1px_var(--focus)]",
              )}
            >
              <PhotoStrip files={photos.files} onRemove={photos.remove} refused={refused} />
              <textarea
                ref={inputRef}
                rows={1}
                value={text}
                aria-label={note ? "Заметка" : "Ответ клиенту"}
                placeholder={note ? "Заметка для команды" : "Ответ клиенту"}
                aria-autocomplete="list"
                aria-controls={activeOption ? listId : undefined}
                aria-activedescendant={activeOption}
                onChange={(e) => {
                  setText(e.target.value);
                  setCaret(e.target.selectionStart ?? e.target.value.length);
                  if (e.target.value.trim()) typing();
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                className="block max-h-60 w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-md focus-visible:outline-none"
              />
              <div className="flex items-center gap-2 px-1.5 pb-1.5">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  aria-label="Прикрепить фото"
                  title="Прикрепить фото. Можно перетащить или вставить"
                  className="press hover-surface grid size-8 shrink-0 place-items-center rounded-sm text-text-muted"
                >
                  <Icon name="attach" />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ATTACH_ACCEPT}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="hidden"
                  onChange={(e) => {
                    photos.add(Array.from(e.target.files ?? []));
                    e.target.value = "";
                    inputRef.current?.focus();
                  }}
                />
                {noteNeedsText && <p className="min-w-0 flex-1 truncate text-xs text-note-text">Заметке нужен текст</p>}
                <p className={cx("hidden min-w-0 flex-1 truncate text-xs text-text-muted", !noteNeedsText && "sm:block")}>
                  {note ? (
                    <>
                      <Kbd>@</Kbd> упомянуть коллегу
                    </>
                  ) : (
                    <>
                      <Kbd>/</Kbd> шаблоны
                    </>
                  )}
                </p>
                {!noteNeedsText && <span className="flex-1 sm:hidden" />}
                {body.length > COUNTER_FROM && (
                  <span className={cx("num shrink-0 text-xs", overLimit ? "text-danger" : "text-text-muted")}>
                    {body.length} / {MAX_BODY}
                  </span>
                )}
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  aria-busy={send.isPending || undefined}
                  title={`${note ? "Добавить заметку" : "Отправить"} (${sendHint})`}
                  className="press h-8 shrink-0 rounded-sm bg-accent px-3 font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
                >
                  {note ? "Добавить заметку" : "Отправить"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded-xs bg-hover px-1 font-sans text-xs text-text">{children}</kbd>;
}

function ModeSwitch({ mode, onMode }: { mode: ComposeMode; onMode: (m: ComposeMode) => void }) {
  const refs = useRef<Partial<Record<ComposeMode, HTMLButtonElement | null>>>({});
  const modes: ComposeMode[] = ["reply", "note"];
  return (
    <div
      role="radiogroup"
      aria-label="Тип сообщения"
      className="flex shrink-0 gap-0.5 rounded-sm bg-surface-2 p-0.5"
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const next = mode === "reply" ? "note" : "reply";
        onMode(next);
        refs.current[next]?.focus();
      }}
    >
      {modes.map((m) => {
        const on = mode === m;
        return (
          <button
            key={m}
            ref={(el) => {
              refs.current[m] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onMode(m)}
            className={cx(
              "press h-7 rounded-xs px-3 text-sm font-semibold",
              on && m === "note" && "bg-note-bg text-note-text shadow-[inset_0_0_0_1px_var(--note-border)]",
              on && m === "reply" && "bg-surface text-text shadow-[inset_0_0_0_1px_var(--border)]",
              !on && "hover-surface text-text-muted",
            )}
          >
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
