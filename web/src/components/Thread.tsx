import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Composer, usePhotoDraft } from "./Composer";
import { DropOverlay, useFileDrop, type DropBlock } from "./DropOverlay";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { Lightbox } from "./Lightbox";
import { Menu, type MenuItem } from "./Menu";
import { MessageBubble } from "./MessageBubble";
import { Avatar, ChannelDot, SegmentBadge } from "./TicketRow";
import { toast } from "./Toast";
import { formatDay, formatTime, sameDay } from "../lib/format";
import { messageKey, releaseKeys } from "../lib/outbox";
import { usePresence } from "../lib/presence";
import { useTopics } from "../lib/topics";
import { READ_ONLY_TEXT, type Operator } from "../lib/queries";
import {
  actionErrorText,
  displayName,
  isAssignedToOther,
  isSurfaceBitrix,
  STATUS_LABEL,
  useOperators,
  useRetryMessage,
  useTicketAction,
  type Attachment,
  type ComposeMode,
  type CrmMessage,
  type TicketAction,
  type TicketDetail,
  type TicketDetailItem,
  type TicketEventRow,
  type TicketStatus,
  type Viewer,
} from "../lib/tickets";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

// ---------- actions shared by the header buttons and the keyboard ----------

export interface ThreadActions {
  run: (a: TicketAction) => void;
  /** Acts on the given ticket even if the open one changed since (toast actions). */
  runOn: (ticketId: string, a: TicketAction) => void;
  pending: boolean;
  /** `a`: take a free ticket; on a colleague's ticket, point at «Перехватить». */
  take: () => void;
  /** `e`: resolve unless already resolved. */
  resolve: () => void;
}

export function useThreadActions(ticket: TicketDetailItem | undefined, me: Operator | undefined): ThreadActions {
  const { mutate, isPending } = useTicketAction();
  const id = ticket?.id;
  const runOn = useCallback(
    function runOn(ticketId: string, action: TicketAction) {
      mutate(
        { id: ticketId, action },
        {
          onError: (err) =>
            toast(actionErrorText(err), {
              tone: "danger",
              action: isAssignedToOther(err)
                ? { label: "Перехватить", onClick: () => runOn(ticketId, { kind: "take-over" }) }
                : undefined,
            }),
        },
      );
    },
    [mutate],
  );
  const run = useCallback((action: TicketAction) => {
    if (id) runOn(id, action);
  }, [id, runOn]);
  const readOnly = me?.surface === "bitrix";
  const take = useCallback(() => {
    if (!ticket || !me || readOnly) return;
    if (ticket.assigned_operator_id === me.id) return;
    if (ticket.assigned_operator_id !== null && ticket.status !== "new") {
      const who = ticket.assigned_operator_name ? `оператора ${ticket.assigned_operator_name}` : "другого оператора";
      const ticketId = ticket.id;
      toast(`Обращение у ${who}.`, { action: { label: "Перехватить", onClick: () => runOn(ticketId, { kind: "take-over" }) } });
      return;
    }
    run({ kind: "take" });
  }, [me, readOnly, run, runOn, ticket]);
  const resolve = useCallback(() => {
    if (ticket && !readOnly && ticket.status !== "resolved") run({ kind: "status", status: "resolved" });
  }, [readOnly, run, ticket]);
  return { run, runOn, pending: isPending, take, resolve };
}

// ---------- timeline ----------

function payloadName(e: TicketEventRow): string {
  const name = e.payload.operator_name;
  return typeof name === "string" && name ? name : "оператор";
}

/** Divider text for a ticket event; null hides it. */
export function eventText(e: TicketEventRow): string | null {
  switch (e.type) {
    case "created":
      return "Обращение создано";
    case "assigned":
      return `Назначен: ${payloadName(e)}`;
    case "auto_assigned":
      return `Назначен автоматически: ${payloadName(e)}`;
    case "taken_over":
      return `Перехвачен: ${payloadName(e)}`;
    case "unassigned":
      return "Возвращён в очередь";
    case "reopened":
      return "Открыт снова";
    case "status_changed": {
      const to = e.payload.to as TicketStatus | undefined;
      if (to === "resolved") return "Решён";
      return to && STATUS_LABEL[to] ? `Статус: ${STATUS_LABEL[to]}` : null;
    }
    case "topic_changed": {
      const to = typeof e.payload.to === "string" ? e.payload.to : null;
      if (!to) return "Тема снята";
      return e.payload.source === "ai" ? `Тема (ИИ): ${to}` : `Тема: ${to}`;
    }
    case "csat": {
      if (typeof e.payload.comment === "string" && e.payload.comment) return `Комментарий клиента: ${e.payload.comment}`;
      return e.payload.rating === "up" ? "Клиент оценил: 👍" : e.payload.rating === "down" ? "Клиент оценил: 👎" : null;
    }
    default:
      return null;
  }
}

/** «Перехвачен: Аня» by Аня needs no second «Аня». */
function actorUnlessSelf(e: TicketEventRow): string | null {
  return e.actor_name && e.actor_name !== e.payload.operator_name ? e.actor_name : null;
}

type TimelineItem =
  | { kind: "message"; key: string; at: string; message: CrmMessage }
  | { kind: "event"; key: string; at: string; event: TicketEventRow; text: string };

export function buildTimeline(messages: CrmMessage[], events: TicketEventRow[]): TimelineItem[] {
  const items: TimelineItem[] = [
    // An optimistic message and its server copy share one key, so the enter motion plays once.
    ...messages.map((m) => ({ kind: "message" as const, key: `m:${messageKey(m)}`, at: m.created_at, message: m })),
    ...events.flatMap((e) => {
      const text = eventText(e);
      return text ? [{ kind: "event" as const, key: `e:${e.id}`, at: e.created_at, event: e, text }] : [];
    }),
  ];
  // Stable sort keeps server order for equal timestamps.
  return items
    .map((it, i) => ({ it, i, t: Date.parse(it.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.it);
}

function Divider({ children, meta }: { children: ReactNode; meta?: string }) {
  return (
    <div className="flex items-center gap-3 px-2 text-xs text-text-muted" role="note">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span className="text-center">
        <span className="font-semibold">{children}</span>
        {meta && <span className="num ml-1.5">{meta}</span>}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---------- the thread ----------

interface Props {
  detail: TicketDetail | undefined;
  loading: boolean;
  error: unknown;
  onRetryLoad: () => void;
  me: Operator;
  actions: ThreadActions;
  backHref: string;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function Thread({ detail, loading, error, onRetryLoad, me, actions, backHref, panelOpen, onTogglePanel }: Props) {
  if (!detail) {
    if (loading) return <ThreadSkeleton backHref={backHref} />;
    const notFound = (error as { status?: number } | null)?.status === 404;
    return (
      <div className="flex flex-1 flex-col">
        <BackBar backHref={backHref} />
        <div role="alert" className="flex flex-col items-start gap-2 px-6 py-6">
          <p>{notFound ? "Обращение не найдено. Возможно, ссылка устарела." : "Обращение не загрузилось."}</p>
          {!notFound && (
            <button
              type="button"
              onClick={onRetryLoad}
              className="press hover-surface h-8 rounded-sm px-3 font-semibold shadow-[inset_0_0_0_1px_var(--border-strong)]"
            >
              Повторить
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <ThreadView
      key={detail.ticket.id}
      detail={detail}
      me={me}
      actions={actions}
      backHref={backHref}
      panelOpen={panelOpen}
      onTogglePanel={onTogglePanel}
    />
  );
}

function BackBar({ backHref }: { backHref: string }) {
  return (
    <div className="flex h-14 shrink-0 items-center border-b border-border px-2 lg:hidden">
      <BackLink backHref={backHref} />
    </div>
  );
}

function BackLink({ backHref }: { backHref: string }) {
  return (
    <Link
      to={backHref}
      aria-label="К списку"
      title="К списку"
      className="press hover-surface grid size-8 shrink-0 place-items-center rounded-sm text-text-muted lg:hidden"
    >
      <Icon name="back" />
    </Link>
  );
}

function ThreadView({
  detail,
  me,
  actions,
  backHref,
  panelOpen,
  onTogglePanel,
}: Omit<Props, "loading" | "error" | "onRetryLoad"> & { detail: TicketDetail }) {
  const { ticket, messages, events } = detail;
  const timeline = buildTimeline(messages, events);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const seen = useRef<Set<string> | null>(null);
  const [lightbox, setLightbox] = useState<{ photos: Attachment[]; index: number; thumbs: Array<HTMLElement | null> } | null>(null);
  const retry = useRetryMessage(ticket.id);
  useEffect(() => () => releaseKeys(ticket.id), [ticket.id]);
  const [mode, setMode] = useState<ComposeMode>("reply");
  const photos = usePhotoDraft();
  const input = useRef<HTMLTextAreaElement>(null);
  const readOnly = me.surface === "bitrix";
  const locked = ticket.assigned_operator_id !== null && ticket.assigned_operator_id !== me.id && ticket.status !== "new";
  const dropBlock: DropBlock = ticket.status === "resolved" ? "resolved" : locked && mode === "reply" ? "locked" : null;
  // The whole pane takes dropped photos, not just the composer.
  const drop = useFileDrop({
    block: dropBlock,
    onFiles: (files) => {
      photos.add(files);
      input.current?.focus();
    },
  });

  // Everything present on first paint is history; only later arrivals play the enter motion.
  if (seen.current === null) seen.current = new Set(timeline.map((t) => t.key));
  const isNew = (key: string) => !seen.current!.has(key);

  const lastKey = timeline.at(-1)?.key;
  const last = timeline.at(-1);
  // Messages carry the author's name, not id; my own reply is the one case that scrolls without being at the bottom.
  const lastIsMine = last?.kind === "message" && last.message.sender === "agent" && last.message.author_name === me.name;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (nearBottom.current || lastIsMine) el.scrollTop = el.scrollHeight;
  }, [lastKey, lastIsMine]);

  const onRetry = (id: string) =>
    retry.mutate(id, {
      onError: (err) =>
        toast(isSurfaceBitrix(err) ? READ_ONLY_TEXT : "Не удалось повторить. Попробуйте ещё раз.", { tone: "danger" }),
    });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...(readOnly ? {} : drop.handlers)}>
      <ThreadHeader
        ticket={ticket}
        me={me}
        actions={actions}
        backHref={backHref}
        panelOpen={panelOpen}
        onTogglePanel={onTogglePanel}
        readOnly={readOnly}
      />
      {readOnly && (
        <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-sm text-text-muted lg:px-6">
          {READ_ONLY_TEXT}
        </p>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <ol aria-label="Переписка" className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-4 lg:px-6">
          {timeline.length === 0 && <li className="py-6 text-center text-text-muted">Сообщений пока нет.</li>}
          {timeline.map((item, i) => {
            const prev = timeline[i - 1];
            const newDay = !prev || !sameDay(prev.at, item.at);
            return (
              <Fragment key={item.key}>
                {newDay && (
                  <li>
                    <p className="pt-1 text-center text-xs font-semibold text-text-muted">{formatDay(item.at)}</p>
                  </li>
                )}
                <li className={cx(item.kind === "event" && "py-1")}>
                  {item.kind === "message" ? (
                    <MessageBubble
                      message={item.message}
                      entering={isNew(item.key)}
                      onOpenPhoto={(photos, index, thumbs) => setLightbox({ photos, index, thumbs })}
                      onRetry={readOnly ? undefined : onRetry}
                      retrying={retry.isPending && retry.variables === item.message.id}
                    />
                  ) : (
                    <div className={cx(isNew(item.key) && "enter-rise")}>
                      <Divider meta={[actorUnlessSelf(item.event), formatTime(item.at)].filter(Boolean).join(", ")}>{item.text}</Divider>
                    </div>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </div>
      {!readOnly && (
        <Composer
          ticket={ticket}
          me={me}
          locked={locked}
          mode={mode}
          onMode={setMode}
          photos={photos}
          inputRef={input}
          runOn={actions.runOn}
          actionPending={actions.pending}
        />
      )}
      <DropOverlay active={drop.active} block={dropBlock} />
      {lightbox && (
        <Lightbox
          photos={lightbox.photos}
          index={lightbox.index}
          onIndex={(index) => setLightbox((lb) => (lb ? { ...lb, index } : lb))}
          thumbFor={(i) => lightbox.thumbs[i] ?? null}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function presenceLine(viewers: Viewer[]): string | null {
  if (!viewers.length) return null;
  const typing = viewers.filter((v) => v.state === "typing").map((v) => v.name);
  if (typing.length) return `${typing.join(", ")} ${typing.length > 1 ? "печатают" : "печатает"}…`;
  const names = viewers.map((v) => v.name);
  return `${names.join(", ")} ${names.length > 1 ? "смотрят" : "смотрит"}`;
}

const STATUS_ORDER: TicketStatus[] = ["new", "allocated", "awaiting", "resolved"];

function ThreadHeader({
  ticket,
  me,
  actions,
  backHref,
  panelOpen,
  onTogglePanel,
  readOnly,
}: {
  ticket: TicketDetailItem;
  me: Operator;
  actions: ThreadActions;
  backHref: string;
  panelOpen: boolean;
  onTogglePanel: () => void;
  readOnly: boolean;
}) {
  const operators = useOperators();
  const free = ticket.assigned_operator_id === null || ticket.status === "new";
  const mine = ticket.assigned_operator_id === me.id && !free;
  const resolved = ticket.status === "resolved";
  const presence = presenceLine(usePresence(ticket.id, me.id));

  const topics = useTopics();
  const activeTopics = (topics.data ?? []).filter((x) => !x.archived);
  const topicItems: MenuItem[] = [
    ...activeTopics.map((x) => ({
      key: String(x.id),
      text: x.name,
      label: <span className="min-w-0 flex-1 truncate">{x.name}</span>,
      checked: ticket.topic_id === x.id,
      onSelect: () => {
        if (ticket.topic_id !== x.id || ticket.topic_source !== "operator") actions.run({ kind: "topic", topic: { id: x.id, name: x.name } });
      },
    })),
    {
      key: "none",
      text: "Без темы",
      label: <span>Без темы</span>,
      checked: false,
      disabled: ticket.topic_id === null,
      separatorBefore: activeTopics.length > 0,
      onSelect: () => actions.run({ kind: "topic", topic: null }),
    },
  ];
  const topicTrigger = ticket.topic_name ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{ticket.topic_name}</span>
      {ticket.topic_source === "ai" && <span className="text-xs text-text-muted">ИИ</span>}
    </span>
  ) : (
    <span className="text-text-muted">Без темы</span>
  );

  const statusItems: MenuItem[] = STATUS_ORDER.filter((s) => s !== "new" || ticket.status === "new").map((s) => ({
    key: s,
    text: STATUS_LABEL[s],
    label: <span>{STATUS_LABEL[s]}</span>,
    checked: ticket.status === s,
    onSelect: () => {
      if (s !== ticket.status) actions.run({ kind: "status", status: s });
    },
  }));

  const ops = [...(operators.data ?? [])].sort(
    (a, b) => Number(b.id === me.id) - Number(a.id === me.id) || Number(b.on_shift) - Number(a.on_shift) || a.name.localeCompare(b.name, "ru"),
  );
  const assignItems: MenuItem[] = [
    ...ops.map((o) => ({
      key: String(o.id),
      text: o.id === me.id ? `${o.name} (вы)` : o.name,
      label: (
        <>
          <span className="min-w-0 flex-1 truncate">
            {o.name}
            {o.id === me.id && <span className="text-text-muted"> (вы)</span>}
          </span>
          <span className={cx("shrink-0 text-xs", o.on_shift ? "text-text" : "text-text-muted")}>
            {o.on_shift ? "на смене" : "не на смене"}
          </span>
        </>
      ),
      checked: !free && ticket.assigned_operator_id === o.id,
      onSelect: () => {
        if (o.id !== ticket.assigned_operator_id || free) actions.run({ kind: "assign", operator: { id: o.id, name: o.name } });
      },
    })),
    {
      key: "queue",
      text: "Вернуть в очередь",
      label: <span>Вернуть в очередь</span>,
      checked: false,
      disabled: free,
      separatorBefore: ops.length > 0,
      onSelect: () => actions.run({ kind: "assign", operator: null }),
    },
  ];

  const handle = [ticket.user_username && `@${ticket.user_username}`, ticket.email].filter(Boolean)[0];
  const name = displayName(ticket);

  return (
    <header className="shrink-0 border-b border-border bg-surface">
      <div className="flex h-14 items-center gap-2 px-2 lg:px-4">
        <BackLink backHref={backHref} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ChannelDot ticket={ticket} />
          <h1 className="min-w-0 truncate text-md font-semibold sm:text-lg">{name}</h1>
          <SegmentBadge ticket={ticket} />
          {handle && handle !== name && <span className="hidden min-w-0 truncate text-sm text-text-muted sm:inline">{handle}</span>}
        </div>
        {!readOnly && free && !resolved && (
          <button
            type="button"
            onClick={actions.take}
            disabled={actions.pending}
            title="Взять (A)"
            className="press h-9 shrink-0 rounded-sm bg-accent px-3 font-semibold sm:px-4 text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            Взять
          </button>
        )}
        {!readOnly && !free && !mine && !resolved && (
          <button
            type="button"
            onClick={() => actions.run({ kind: "take-over" })}
            disabled={actions.pending}
            title={`Забрать у оператора ${ticket.assigned_operator_name ?? ""}`.trim()}
            className="press hover-surface h-8 shrink-0 rounded-sm px-3 font-semibold shadow-[inset_0_0_0_1px_var(--border-strong)] disabled:opacity-60"
          >
            Перехватить
          </button>
        )}
        {!readOnly && !resolved && (
          <button
            type="button"
            onClick={actions.resolve}
            disabled={actions.pending}
            title="Решить (E)"
            aria-label="Решить"
            className={cx(
              "press flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 font-semibold disabled:opacity-60 sm:px-3",
              mine
                ? "bg-accent text-accent-fg hover:bg-accent-hover"
                : "hover-surface shadow-[inset_0_0_0_1px_var(--border-strong)]",
            )}
          >
            <Icon name="check" className="sm:hidden" />
            <span className="max-sm:sr-only">Решить</span>
          </button>
        )}
        <button
          type="button"
          onClick={onTogglePanel}
          aria-label="Клиент"
          aria-expanded={panelOpen}
          title="Клиент"
          className={cx("press hover-surface grid size-8 shrink-0 place-items-center rounded-sm text-text-muted xl:hidden", panelOpen && "bg-pressed text-text")}
        >
          <Icon name="panel" />
        </button>
      </div>
      <div className="flex h-10 items-center gap-2 px-2 lg:px-4">
        {readOnly ? (
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span>{STATUS_LABEL[ticket.status]}</span>
            <span className="truncate text-text-muted">{free ? "Не назначен" : ticket.assigned_operator_name}</span>
            <span className="truncate text-text-muted">{ticket.topic_name ?? "Без темы"}</span>
          </span>
        ) : (
          <>
            <Menu
              label={`Статус: ${STATUS_LABEL[ticket.status]}`}
              title="Статус"
              items={statusItems}
              disabled={actions.pending}
              triggerClassName="h-7 px-2 text-sm"
              trigger={<span>{STATUS_LABEL[ticket.status]}</span>}
            />
            <Menu
              label={free ? "Назначить" : `Назначен: ${ticket.assigned_operator_name ?? ""}`}
              title="Назначить"
              items={assignItems}
              disabled={actions.pending}
              triggerClassName="h-7 px-2 text-sm max-w-[14rem]"
              trigger={
                free ? (
                  <span className="text-text-muted">Не назначен</span>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Avatar name={ticket.assigned_operator_name ?? "?"} />
                    <span className="truncate">{ticket.assigned_operator_name}</span>
                    {ticket.auto_assigned && <span className="text-xs text-text-muted">авто</span>}
                  </span>
                )
              }
            />
            <Menu
              label={`Тема: ${ticket.topic_name ?? "Без темы"}`}
              title="Тема"
              items={topicItems}
              disabled={actions.pending}
              triggerClassName="h-7 px-2 text-sm max-w-[14rem]"
              trigger={topicTrigger}
            />
          </>
        )}
        <p aria-live="polite" className="ml-auto min-w-0 truncate text-xs text-text-muted">
          {presence}
        </p>
      </div>
    </header>
  );
}

function ThreadSkeleton({ backHref }: { backHref: string }) {
  return (
    <div aria-hidden="true" className="flex flex-1 flex-col">
      <div className="flex h-14 items-center gap-3 border-b border-border px-2 lg:px-4">
        <BackLink backHref={backHref} />
        <div className="h-4 w-48 rounded-xs bg-hover" />
      </div>
      <div className="flex flex-col gap-4 px-6 py-6">
        <div className="h-12 w-2/3 rounded-md bg-hover" />
        <div className="h-16 w-1/2 self-end rounded-md bg-hover" />
        <div className="h-10 w-3/5 rounded-md bg-hover" />
      </div>
    </div>
  );
}
