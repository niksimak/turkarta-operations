import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Thread, useThreadActions } from "../components/Thread";
import { TicketList } from "../components/TicketList";
import { UserPanel } from "../components/UserPanel";
import { useShortcuts, type KeyAction } from "../lib/keyboard";
import { useModal } from "../lib/modal";
import { setPresence, usePresenceFeed, useViewingPresence } from "../lib/presence";
import { useMe } from "../lib/queries";
import {
  CHANNEL_LABEL,
  displayName,
  SEGMENT_FILTER_LABEL,
  STATUS_LABEL,
  useOperators,
  useSlaSettings,
  useTicket,
  useTicketList,
  type ChannelFilter,
  type ListFilters,
  type Segment,
  type TicketDetail,
  type TicketStatus,
  type View,
} from "../lib/tickets";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const VIEW_PATH: Record<View, string> = { queue: "/", mine: "/mine", all: "/all" };
const VIEW_TITLE: Record<View, string> = { queue: "Очередь", mine: "Мои", all: "Все" };
const FILTER_PARAMS = ["status", "channel", "operator", "overdue", "segment", "q"] as const;
const SEARCH_DEBOUNCE_MS = 300;

function isView(v: string | null): v is View {
  return v === "queue" || v === "mine" || v === "all";
}

/** View from the path; on /t/:id the list keeps the view it was opened from (`v`). */
export function viewFor(pathname: string, v: string | null): View {
  if (pathname === "/mine" || pathname.startsWith("/mine/")) return "mine";
  if (pathname === "/all" || pathname.startsWith("/all/")) return "all";
  if (pathname.startsWith("/t/") && isView(v)) return v;
  return "queue";
}

function filtersFrom(view: View, sp: URLSearchParams): ListFilters {
  const status = sp.get("status");
  const channel = sp.get("channel");
  const segment = sp.get("segment");
  const operator = Number(sp.get("operator"));
  return {
    view,
    status: status && status in STATUS_LABEL && view !== "queue" ? (status as TicketStatus) : undefined,
    channel: channel && channel in CHANNEL_LABEL ? (channel as ChannelFilter) : undefined,
    operator: view === "all" && Number.isInteger(operator) && operator > 0 ? operator : undefined,
    overdue: sp.get("overdue") === "1" || undefined,
    segment: segment && segment in SEGMENT_FILTER_LABEL ? (segment as Segment) : undefined,
    q: sp.get("q")?.trim() || undefined,
  };
}

function filterQuery(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of FILTER_PARAMS) {
    const v = sp.get(k);
    if (v) out.set(k, v);
  }
  return out;
}

const withQuery = (path: string, q: URLSearchParams) => (q.toString() ? `${path}?${q.toString()}` : path);

export function Inbox() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const openId = useMatch("/t/:id")?.params.id;
  const view = viewFor(location.pathname, sp.get("v"));
  const filters = useMemo(() => filtersFrom(view, sp), [view, sp]);
  const scopeKey = JSON.stringify(filters);
  const me = useMe().data;
  const settings = useSlaSettings();

  const list = useTicketList(filters);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const counts = list.data?.pages[0]?.counts;
  const detail = useTicket(openId);
  const ticket = detail.data?.ticket;
  const actions = useThreadActions(ticket, me);
  const [panelOpen, setPanelOpen] = useState(false);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);

  usePresenceFeed();
  useViewingPresence(openId);
  useEffect(() => {
    if (openId && detail.data) setPresence(openId, detail.data.viewers);
  }, [openId, detail.data]);

  const filterQs = filterQuery(sp);
  const backHref = withQuery(VIEW_PATH[view], filterQs);
  const hrefFor = useCallback(
    (id: string) => {
      const q = filterQuery(sp);
      q.set("v", view);
      return `/t/${encodeURIComponent(id)}?${q.toString()}`;
    },
    [sp, view],
  );

  useEffect(() => {
    setCursorId(openId);
  }, [openId]);

  useEffect(() => {
    document.title = `${ticket ? displayName(ticket) : VIEW_TITLE[view]} · Поддержка`;
  }, [ticket, view]);

  const moveCursor = (delta: number) => {
    if (!items.length) return;
    const from = items.findIndex((t) => t.id === (cursorId ?? openId));
    const next = from === -1 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, from + delta));
    const id = items[next]!.id;
    setCursorId(id);
    document.querySelector(`[data-ticket-id="${id}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  useShortcuts((action: KeyAction) => {
    switch (action) {
      case "next":
        return moveCursor(1);
      case "prev":
        return moveCursor(-1);
      case "open":
        if (cursorId && cursorId !== openId) navigate(hrefFor(cursorId));
        return;
      case "take":
        return actions.take();
      case "resolve":
        return actions.resolve();
      case "goQueue":
        return navigate("/");
      case "goMine":
        return navigate("/mine");
      case "goAll":
        return navigate("/all");
    }
  });

  const setParam = (key: (typeof FILTER_PARAMS)[number], value: string | undefined) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    setSp(next, { replace: true });
  };

  const hasFilters = FILTER_PARAMS.some((k) => sp.get(k));
  const resetFilters = () => {
    const next = new URLSearchParams();
    const v = sp.get("v");
    if (v) next.set("v", v);
    setSp(next, { replace: true });
  };

  const empty = filters.overdue && !filters.q && !filters.status && !filters.channel && !filters.segment
    ? { text: "Просроченных обращений нет." }
    : hasFilters
      ? { text: "Ничего не найдено.", action: { label: "Сбросить фильтры", onClick: resetFilters } }
      : view === "queue"
        ? { text: "Очередь пуста. Новые обращения появятся здесь сами." }
        : view === "mine"
          ? { text: "У вас нет открытых обращений. Возьмите из очереди: G, затем Q.", action: { label: "Открыть очередь", onClick: () => navigate("/") } }
          : { text: "Обращений пока нет." };

  const count = view === "queue" ? counts?.queue : view === "mine" ? counts?.mine : undefined;

  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="Список обращений"
        className={cx(
          "flex min-h-0 w-full shrink-0 flex-col border-r border-border bg-surface lg:w-[22rem]",
          openId && "max-lg:hidden",
        )}
      >
        <ListHeader
          title={filters.overdue ? "Просрочено" : VIEW_TITLE[view]}
          count={count}
          view={view}
          filters={filters}
          setParam={setParam}
          hasFilters={hasFilters}
          onReset={resetFilters}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TicketList
            items={items}
            scopeKey={scopeKey}
            openId={openId}
            cursorId={cursorId}
            hrefFor={hrefFor}
            settings={settings}
            meId={me?.id}
            loading={list.isLoading}
            error={list.isError}
            onRetry={() => void list.refetch()}
            hasMore={Boolean(list.hasNextPage)}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            empty={empty}
          />
        </div>
      </section>

      <section
        aria-label="Переписка"
        className={cx("flex min-h-0 min-w-0 flex-1 flex-col bg-surface", !openId && "max-lg:hidden")}
      >
        {openId && me ? (
          <Thread
            detail={detail.data}
            loading={detail.isLoading}
            error={detail.error}
            onRetryLoad={() => void detail.refetch()}
            me={me}
            actions={actions}
            backHref={backHref}
            panelOpen={panelOpen}
            onTogglePanel={togglePanel}
          />
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-text-muted">
            <p>
              Выберите обращение слева.
              <br />
              <kbd className="font-sans">J</kbd> и <kbd className="font-sans">K</kbd> двигают по списку, <kbd className="font-sans">Enter</kbd> открывает.
            </p>
          </div>
        )}
      </section>

      {detail.data && (
        <>
          <aside
            aria-label="Клиент"
            className="hidden w-[19rem] shrink-0 border-l border-border bg-surface-2 xl:block"
          >
            <UserPanel detail={detail.data} view={view} />
          </aside>
          {panelOpen && <PanelSheet detail={detail.data} view={view} onClose={closePanel} />}
        </>
      )}
    </div>
  );
}

function PanelSheet({ detail, view, onClose }: { detail: TicketDetail; view: View; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, { onClose });
  return createPortal(
    <div className="fixed inset-0 z-40 xl:hidden">
      <div className="scrim-in absolute inset-0 bg-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Клиент"
        tabIndex={-1}
        className="sheet-in absolute inset-y-0 right-0 w-[min(20rem,100vw)] border-l border-border bg-surface-2 shadow-pop focus-visible:outline-none"
      >
        <UserPanel detail={detail} view={view} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

const STATUS_FILTERS: TicketStatus[] = ["allocated", "awaiting", "resolved", "new"];

function ListHeader({
  title,
  count,
  view,
  filters,
  setParam,
  hasFilters,
  onReset,
}: {
  title: string;
  count: number | undefined;
  view: View;
  filters: ListFilters;
  setParam: (key: (typeof FILTER_PARAMS)[number], value: string | undefined) => void;
  hasFilters: boolean;
  onReset: () => void;
}) {
  const operators = useOperators(view === "all");
  const [q, setQ] = useState(filters.q ?? "");
  const latest = useRef(setParam);
  latest.current = setParam;

  useEffect(() => {
    setQ(filters.q ?? "");
  }, [filters.q]);

  useEffect(() => {
    if ((filters.q ?? "") === q.trim()) return;
    const t = setTimeout(() => latest.current("q", q.trim() || undefined), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, filters.q]);

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-14 items-center gap-2 px-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        {count !== undefined && <span className="num text-lg text-text-muted">{count}</span>}
        {hasFilters && (
          <button
            type="button"
            onClick={onReset}
            className="press hover-surface ml-auto h-7 rounded-sm px-2 text-sm text-text-muted"
          >
            Сбросить
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <label className="relative block">
          <span className="sr-only">Поиск</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Имя, @username, email, TG id"
            className="h-8 w-full rounded-sm bg-bg pl-8 pr-2 text-base shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--border-strong)]"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {view !== "queue" && (
            <Select
              label="Статус"
              value={filters.status ?? ""}
              onChange={(v) => setParam("status", v || undefined)}
              options={[{ value: "", label: view === "mine" ? "Открытые" : "Все статусы" }, ...STATUS_FILTERS.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
            />
          )}
          <Select
            label="Канал"
            value={filters.channel ?? ""}
            onChange={(v) => setParam("channel", v || undefined)}
            options={[
              { value: "", label: "Все каналы" },
              ...(Object.keys(CHANNEL_LABEL) as ChannelFilter[]).map((c) => ({ value: c, label: CHANNEL_LABEL[c] })),
            ]}
          />
          <Select
            label="Клиент"
            value={filters.segment ?? ""}
            onChange={(v) => setParam("segment", v || undefined)}
            options={[
              { value: "", label: "Все клиенты" },
              ...(Object.keys(SEGMENT_FILTER_LABEL) as Segment[]).map((s) => ({ value: s, label: SEGMENT_FILTER_LABEL[s] })),
            ]}
          />
          {view === "all" && (
            <Select
              label="Оператор"
              value={filters.operator ? String(filters.operator) : ""}
              onChange={(v) => setParam("operator", v || undefined)}
              options={[
                { value: "", label: "Все операторы" },
                ...(operators.data ?? []).map((o) => ({ value: String(o.id), label: o.name })),
              ]}
            />
          )}
          {filters.overdue && (
            <button
              type="button"
              onClick={() => setParam("overdue", undefined)}
              aria-label="Убрать фильтр «Просрочено»"
              className="press inline-flex h-7 items-center gap-1 rounded-sm bg-sla-late-soft px-2 text-sm font-semibold text-sla-late"
            >
              Просрочено
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="relative inline-flex">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-7 max-w-[11rem] cursor-pointer appearance-none truncate rounded-sm bg-surface pl-2 pr-6 text-sm shadow-[inset_0_0_0_1px_var(--border)]",
          value ? "font-semibold text-text shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-text-muted",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-muted" />
    </label>
  );
}
