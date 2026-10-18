import { useState } from "react";
import { ApiError } from "../lib/api";
import type { Operator } from "../lib/queries";
import { canEditTeamSettings } from "../lib/settings";
import { useCreateTopic, useTopics, useUpdateTopic, type Topic } from "../lib/topics";
import { toast } from "./Toast";

function topicErrorText(err: unknown): string {
  const fields = err instanceof ApiError ? (err.body as { fields?: Record<string, string> } | undefined)?.fields : undefined;
  return fields?.name === "duplicate" ? "Такая тема уже есть." : "Не сохранилось. Повторите.";
}

const inputClass =
  "h-8 min-w-0 flex-1 rounded-sm bg-bg px-2 text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]";
const secondary = "press hover-surface h-8 rounded-sm px-3";

export function TopicsSection({ me }: { me: Operator }) {
  const topics = useTopics();
  const create = useCreateTopic();
  const update = useUpdateTopic();
  const canEdit = canEditTeamSettings(me);
  const [draft, setDraft] = useState("");

  const [busy, setBusy] = useState(false);
  const pending = busy || update.isPending;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(topicErrorText(err), { tone: "danger", key: "topic-update" });
    } finally {
      setBusy(false);
    }
  };
  const patch = (id: number, p: Partial<Pick<Topic, "name" | "position" | "archived">>) =>
    run(() => update.mutateAsync({ id, patch: p }));

  const all = topics.data ?? [];
  const active = all.filter((t) => !t.archived).sort((a, b) => a.position - b.position);
  const archived = all.filter((t) => t.archived);

  const swap = (a: Topic, b: Topic) =>
    run(async () => {
      await update.mutateAsync({ id: a.id, patch: { position: b.position } });
      await update.mutateAsync({ id: b.id, patch: { position: a.position } });
    });

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    void run(async () => {
      await create.mutateAsync({ name });
      setDraft("");
    });
  };

  return (
    <section aria-labelledby="topics-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="topics-title" className="text-md font-semibold">
          Темы обращений
        </h2>
        <span className="text-sm text-text-muted">ИИ выбирает тему после решения, оператор может поменять</span>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md bg-surface shadow-[0_0_0_1px_var(--border)]">
        {active.map((t, i) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
            {canEdit ? (
              <>
                <TopicName topic={t} disabled={pending} onSave={(name) => patch(t.id, { name })} />
                <button type="button" className={secondary} disabled={pending || i === 0} onClick={() => void swap(t, active[i - 1]!)}>
                  Выше
                </button>
                <button type="button" className={secondary} disabled={pending || i === active.length - 1} onClick={() => void swap(t, active[i + 1]!)}>
                  Ниже
                </button>
                <button type="button" className={secondary} disabled={pending} onClick={() => void patch(t.id, { archived: true })}>
                  В архив
                </button>
              </>
            ) : (
              <span>{t.name}</span>
            )}
          </li>
        ))}
        {canEdit && (
          <li className="flex items-center gap-2 px-4 py-2">
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <input
                aria-label="Новая тема"
                placeholder="Новая тема"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className={inputClass}
              />
              <button
                type="submit"
                disabled={!draft.trim() || create.isPending}
                className="press h-9 rounded-sm bg-accent px-4 font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
              >
                Добавить
              </button>
            </form>
          </li>
        )}
      </ul>
      {archived.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm text-text-muted">Архив</h3>
          <ul className="flex flex-col divide-y divide-border rounded-md bg-surface text-text-muted shadow-[0_0_0_1px_var(--border)]">
            {archived.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1">{t.name}</span>
                {canEdit && (
                  <button type="button" className={secondary} disabled={pending} onClick={() => void patch(t.id, { archived: false })}>
                    Вернуть
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function TopicName({ topic, disabled, onSave }: { topic: Topic; disabled: boolean; onSave: (name: string) => unknown }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(topic.name);
  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        className="min-w-0 flex-1 truncate text-left hover:underline"
        onClick={() => {
          setValue(topic.name);
          setEditing(true);
        }}
      >
        {topic.name}
      </button>
    );
  }
  const changed = value.trim() !== "" && value.trim() !== topic.name;
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(value.trim());
        setEditing(false);
      }}
    >
      <input
        aria-label="Название темы"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        className={inputClass}
      />
      {changed && (
        <button type="submit" disabled={disabled} className={secondary}>
          Сохранить
        </button>
      )}
    </form>
  );
}
