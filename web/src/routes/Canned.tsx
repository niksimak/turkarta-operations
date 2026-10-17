import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { toast } from "../components/Toast";
import {
  BODY_MAX,
  canDeleteCanned,
  cannedErrorText,
  TITLE_MAX,
  useCannedPage,
  useDeleteCanned,
  useSaveCanned,
  validateCanned,
  type CannedDraft,
  type CannedReplyFull,
} from "../lib/cannedReplies";
import { formatDateTime } from "../lib/format";
import { useMe, type Operator } from "../lib/queries";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const SEARCH_DEBOUNCE_MS = 300;

type Editing = { kind: "new" } | { kind: "edit"; reply: CannedReplyFull } | null;

/** «1 раз», «3 раза», «12 раз». */
export function timesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "раза" : "раз";
}

export function Canned() {
  const me = useMe().data;
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const list = useCannedPage(query);
  const items = list.data ?? [];

  useEffect(() => {
    document.title = "Шаблоны · Поддержка";
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  if (!me) return null;
  const selectedId = editing?.kind === "edit" ? editing.reply.id : null;

  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="Список шаблонов"
        className={cx(
          "flex min-h-0 w-full shrink-0 flex-col border-r border-border bg-surface lg:w-[22rem]",
          editing && "max-lg:hidden",
        )}
      >
        <div className="shrink-0 border-b border-border">
          <div className="flex h-14 items-center gap-2 px-4">
            <h1 className="text-xl font-semibold">Шаблоны</h1>
            {list.data && !query && <span className="num text-lg text-text-muted">{items.length}</span>}
            <button
              type="button"
              onClick={() => setEditing({ kind: "new" })}
              className="press ml-auto h-8 rounded-sm bg-accent px-3 font-semibold text-accent-fg hover:bg-accent-hover"
            >
              Новый шаблон
            </button>
          </div>
          <div className="px-3 pb-3">
            <label className="relative block">
              <span className="sr-only">Поиск по шаблонам</span>
              <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQ("");
                }}
                placeholder="Название или текст"
                className="h-8 w-full rounded-sm bg-bg pl-8 pr-2 text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]"
              />
            </label>
          </div>
        </div>
        <div className={cx("min-h-0 flex-1 overflow-y-auto transition-opacity duration-fast", list.isPlaceholderData && "opacity-60")}>
          {list.isError && !list.data ? (
            <div role="alert" className="flex flex-col items-start gap-2 px-4 py-4">
              <p className="text-danger">Не удалось загрузить шаблоны.</p>
              <button
                type="button"
                onClick={() => void list.refetch()}
                className="press hover-surface h-8 rounded-sm px-3 font-semibold text-accent"
              >
                Повторить
              </button>
            </div>
          ) : !list.data ? (
            <div aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex h-[4.5rem] flex-col justify-center gap-2 border-b border-border px-4">
                  <div className="h-3.5 w-1/2 rounded-xs bg-hover" />
                  <div className="h-3 w-5/6 rounded-xs bg-hover" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-4 text-text-muted">
              {query ? "Ничего не найдено." : "Шаблонов пока нет. Создайте первый, он сразу появится в ответах по /."}
            </p>
          ) : (
            <ul>
              {items.map((r) => (
                <li key={r.id} className="border-b border-border">
                  <button
                    type="button"
                    aria-current={r.id === selectedId ? "true" : undefined}
                    onClick={() => setEditing({ kind: "edit", reply: r })}
                    className={cx(
                      "flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors duration-fast",
                      r.id === selectedId ? "bg-accent-soft" : "hover-surface",
                    )}
                  >
                    <span className="truncate font-semibold">{r.title}</span>
                    <span className="line-clamp-2 text-sm text-text-muted">{r.body}</span>
                    <span className="num text-xs text-text-muted">
                      {r.created_by_name ?? "Автор неизвестен"}, использован {r.use_count} {timesWord(r.use_count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Шаблон" className={cx("flex min-h-0 min-w-0 flex-1 flex-col bg-surface", !editing && "max-lg:hidden")}>
        {editing ? (
          <Editor
            key={editing.kind === "edit" ? editing.reply.id : "new"}
            reply={editing.kind === "edit" ? editing.reply : null}
            me={me}
            onClose={() => setEditing(null)}
            onSaved={(reply) => setEditing({ kind: "edit", reply })}
          />
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-text-muted">
            <p>
              Выберите шаблон слева или создайте новый.
              <br />
              В ответе клиенту наберите <kbd className="font-sans">/</kbd>, чтобы вставить шаблон.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Editor({
  reply,
  me,
  onClose,
  onSaved,
}: {
  reply: CannedReplyFull | null;
  me: Operator;
  onClose: () => void;
  onSaved: (reply: CannedReplyFull) => void;
}) {
  const save = useSaveCanned();
  const remove = useDeleteCanned();
  const [draft, setDraft] = useState<CannedDraft>({ title: reply?.title ?? "", body: reply?.body ?? "" });
  const [errors, setErrors] = useState<Partial<Record<keyof CannedDraft, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const dirty = draft.title !== (reply?.title ?? "") || draft.body !== (reply?.body ?? "");
  const canDelete = reply !== null && canDeleteCanned(reply, me);

  useEffect(() => {
    if (!reply) titleRef.current?.focus();
  }, [reply]);

  const setField = (key: keyof CannedDraft, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setFormError(null);
  };

  // The same guards as the «Сохранить» button, so Ctrl/Cmd+Enter cannot double-submit or save nothing.
  const canSubmit = !save.isPending && (reply === null || dirty);

  const onSave = () => {
    if (!canSubmit) return;
    const local = validateCanned(draft);
    if (local.title || local.body) {
      setErrors(local);
      return;
    }
    save.mutate(
      { id: reply?.id ?? null, draft: { title: draft.title.trim(), body: draft.body.trim() } },
      {
        onSuccess: (saved) => {
          toast(reply ? "Шаблон сохранён." : "Шаблон создан.");
          onSaved(saved);
        },
        onError: (err) => setFormError(cannedErrorText(err)),
      },
    );
  };

  const onDelete = () => {
    if (!reply) return;
    remove.mutate(reply.id, {
      onSuccess: () => {
        toast("Шаблон удалён.");
        onClose();
      },
      onError: (err) => {
        setConfirming(false);
        setFormError(cannedErrorText(err));
      },
    });
  };

  const fieldClass = (error: string | undefined) =>
    cx(
      "w-full rounded-sm bg-bg px-3 text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]",
      error && "shadow-[inset_0_0_0_1px_var(--danger)]",
    );

  return (
    <form
      aria-label={reply ? `Шаблон «${reply.title}»` : "Новый шаблон"}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="К списку шаблонов"
          className="press hover-surface grid size-8 place-items-center rounded-sm text-text-muted lg:hidden"
        >
          <Icon name="back" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{reply ? reply.title : "Новый шаблон"}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="press hover-surface hidden size-8 place-items-center rounded-sm text-text-muted lg:grid"
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6">
        <div className="flex max-w-[44rem] flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="canned-title" className="font-semibold">
                Название
              </label>
              <span className="num text-xs text-text-muted">
                {draft.title.length} / {TITLE_MAX}
              </span>
            </div>
            <input
              ref={titleRef}
              id="canned-title"
              value={draft.title}
              maxLength={TITLE_MAX}
              onChange={(e) => setField("title", e.target.value)}
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={errors.title ? "canned-title-error" : undefined}
              placeholder="Например, Код не пришёл"
              className={cx(fieldClass(errors.title), "h-8")}
            />
            {errors.title && (
              <p id="canned-title-error" role="alert" className="text-sm text-danger">
                {errors.title}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="canned-body" className="font-semibold">
                Текст
              </label>
              <span className="num text-xs text-text-muted">
                {draft.body.length} / {BODY_MAX}
              </span>
            </div>
            <textarea
              id="canned-body"
              value={draft.body}
              maxLength={BODY_MAX}
              rows={12}
              onChange={(e) => setField("body", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onSave();
                }
              }}
              aria-invalid={errors.body ? true : undefined}
              aria-describedby={cx("canned-body-help", errors.body && "canned-body-error")}
              className={cx(fieldClass(errors.body), "resize-y py-2 text-md")}
            />
            {errors.body && (
              <p id="canned-body-error" role="alert" className="text-sm text-danger">
                {errors.body}
              </p>
            )}
            <p id="canned-body-help" className="text-sm text-text-muted">
              <code className="font-mono text-xs text-text">{"{имя}"}</code> подставит имя клиента,{" "}
              <code className="font-mono text-xs text-text">{"{оператор}"}</code> ваше имя.
            </p>
          </div>

          {reply && (
            <p className="num text-sm text-text-muted">
              Автор: {reply.created_by_name ?? "неизвестен"}. Изменён {formatDateTime(reply.updated_at).toLowerCase()}. Использован{" "}
              {reply.use_count} {timesWord(reply.use_count)}.
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface-2 px-4 py-3 lg:px-6">
        {confirming ? (
          <>
            <p className="min-w-0 flex-1">Удалить шаблон? Его нельзя будет вернуть.</p>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="press hover-surface h-8 rounded-sm px-3 text-text-muted"
            >
              Оставить
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={remove.isPending}
              className="press h-8 rounded-sm bg-danger px-3 font-semibold text-accent-fg disabled:opacity-60"
            >
              {remove.isPending ? "Удаляем…" : "Удалить"}
            </button>
          </>
        ) : (
          <>
            <button
              type="submit"
              disabled={!canSubmit}
              className="press h-9 rounded-sm bg-accent px-4 font-semibold text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {save.isPending ? "Сохраняем…" : reply ? "Сохранить" : "Создать"}
            </button>
            {dirty && reply && (
              <button
                type="button"
                onClick={() => {
                  setDraft({ title: reply.title, body: reply.body });
                  setErrors({});
                  setFormError(null);
                }}
                className="press hover-surface h-8 rounded-sm px-3 text-text-muted"
              >
                Отменить
              </button>
            )}
            {formError ? (
              <p role="alert" className="min-w-0 flex-1 text-danger">
                {formError}
              </p>
            ) : (
              <span className="flex-1" />
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="press hover-surface h-8 rounded-sm px-3 text-danger"
              >
                Удалить
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}
