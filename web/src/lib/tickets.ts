import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, json } from "./api";
import { addOutgoing, bindServerId, confirmOutgoing, dropOutgoing, removeOutgoing, withOutbox } from "./outbox";
import { keys, READ_ONLY_TEXT, useMe, type Operator, type TicketCounts } from "./queries";
import { DEFAULT_SLA, type SlaSettings } from "./sla";

// Mirrors src/crm/tickets.ts (TicketListItem, TicketDetailItem, CrmMessage, TicketEventRow).
export type TicketStatus = "new" | "allocated" | "awaiting" | "resolved";
export type View = "queue" | "mine" | "all";
export type ChannelFilter = "bot" | "miniapp" | "web";

export interface TicketListItem {
  id: string;
  status: TicketStatus;
  channel: "telegram" | "web";
  source: string | null;
  user_name: string | null;
  user_username: string | null;
  user_tg: number | null;
  email: string | null;
  last_message_preview: string;
  last_message_at: string | null;
  waiting_since: string | null;
  first_response_at: string | null;
  assigned_operator_id: number | null;
  assigned_operator_name: string | null;
  auto_assigned: boolean;
  intake_pending: boolean;
  created_at: string;
}

export type TicketDetailItem = TicketListItem & {
  device: string | null;
  category: string | null;
  web_user_id: string | null;
};

export interface Attachment {
  id: string;
  media_type: string | null;
  position: number;
  /** Client only: object URL of a photo that is still uploading. */
  preview?: string;
}

export interface CrmMessage {
  id: string;
  sender: "user" | "agent" | "system";
  kind: "text" | "photo" | "note" | "unsupported";
  body: string;
  unsupported_type: string | null;
  author_name: string | null;
  created_at: string;
  delivery_status: "pending" | "sent" | "failed" | null;
  delivery_error: string | null;
  attachments: Attachment[];
  /** Client only: optimistic, the server has not confirmed it yet. */
  local?: boolean;
}

export type TicketEventType =
  | "created"
  | "assigned"
  | "auto_assigned"
  | "unassigned"
  | "taken_over"
  | "status_changed"
  | "reopened";

export interface TicketEventRow {
  id: number;
  type: TicketEventType;
  actor_name: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// Mirrors src/crm/user_context.ts; money arrives as decimal strings.
export interface UserContext {
  found: boolean;
  user_id?: string;
  tg_id?: number | null;
  tg_username?: string | null;
  name?: string | null;
  email?: string | null;
  email_verified?: boolean;
  /** The CSB client alias (our domain), which CSB knows the client by. */
  csb_email?: string | null;
  registered_at?: string | null;
  kyc_level?: number | null;
  /** The id Antarctic knows the user by, when they ever used that rail. */
  antarctic_user_id?: string | null;
  cards?: Array<{ last4: string; status: string; plan: string | null; product_id?: string | null; balance_usd: string | null }>;
  recent_topups?: Array<{
    amount_rub: string | null;
    amount_usd: string | null;
    status: string;
    created_at: string;
    rail?: string | null;
    /** Antarctic's order id and payment uuid, for an Antarctic top-up. */
    antarctic?: { order_id: string; payment_uuid: string | null } | null;
  }>;
  admin_url?: string | null;
}

export interface Viewer {
  operatorId: number;
  name: string;
  state: "viewing" | "typing";
}

export interface TicketDetail {
  ticket: TicketDetailItem;
  messages: CrmMessage[];
  events: TicketEventRow[];
  user: UserContext | null;
  viewers: Viewer[];
}

export interface TicketPage {
  items: TicketListItem[];
  nextCursor: string | null;
  counts: TicketCounts;
}

export interface ListFilters {
  view: View;
  status?: TicketStatus;
  channel?: ChannelFilter;
  operator?: number;
  overdue?: boolean;
  q?: string;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: "Новый",
  allocated: "В работе",
  awaiting: "Ждём клиента",
  resolved: "Решён",
};

export const CHANNEL_LABEL: Record<ChannelFilter, string> = {
  bot: "Telegram бот",
  miniapp: "Mini App",
  web: "Web",
};

/** The list filter's channel for a ticket; `source` is "bot", "miniapp" or "web…". */
export function channelOf(t: Pick<TicketListItem, "channel" | "source">): ChannelFilter {
  if (t.source === "miniapp") return "miniapp";
  if (t.source?.startsWith("web") || t.channel === "web") return "web";
  return "bot";
}

/** Best human handle: name, then @username, email, TG id. */
export function displayName(t: Pick<TicketListItem, "user_name" | "user_username" | "email" | "user_tg">): string {
  return (
    t.user_name?.trim() ||
    (t.user_username ? `@${t.user_username}` : "") ||
    t.email ||
    (t.user_tg != null ? `TG ${t.user_tg}` : "Без имени")
  );
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]!.toUpperCase());
  return letters.join("") || "?";
}

export function attachmentUrl(id: string): string {
  return `/crm/api/attachments/${encodeURIComponent(id)}`;
}

export function listPath(f: ListFilters, cursor?: string, limit = 50): string {
  const p = new URLSearchParams({ view: f.view });
  if (f.status) p.set("status", f.status);
  if (f.channel) p.set("channel", f.channel);
  if (f.operator != null) p.set("operator", String(f.operator));
  if (f.overdue) p.set("overdue", "1");
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(limit));
  return `/tickets?${p.toString()}`;
}

export const ticketKeys = {
  list: (f: ListFilters) => ["tickets", "list", f] as const,
  detail: (id: string) => ["tickets", "detail", id] as const,
  past: (who: string) => ["tickets", "past", who] as const,
  operators: ["operators"] as const,
  settings: ["settings"] as const,
};

export function useTicketList(f: ListFilters) {
  return useInfiniteQuery({
    queryKey: ticketKeys.list(f),
    queryFn: ({ pageParam }) => api<TicketPage>(listPath(f, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // SSE invalidates on ticket events; this covers SLA drift on a quiet stream.
    refetchInterval: 60_000,
  });
}

export function useTicket(id: string | undefined) {
  return useQuery({
    queryKey: ticketKeys.detail(id ?? ""),
    // Unconfirmed sends survive a refetch that lands before their POST returns.
    queryFn: async () => withOutbox(id!, await api<TicketDetail>(`/tickets/${encodeURIComponent(id!)}`)),
    enabled: Boolean(id),
  });
}

/** Past tickets of the same customer. The server's `q` is a substring match, so filter exactly here. */
export function usePastTickets(t: TicketDetailItem | undefined) {
  const who = t ? (t.user_tg != null ? String(t.user_tg) : t.email ?? "") : "";
  return useQuery({
    queryKey: ticketKeys.past(who),
    queryFn: () => api<TicketPage>(listPath({ view: "all", q: who }, undefined, 20)),
    enabled: Boolean(who),
    staleTime: 60_000,
    select: (page) =>
      page.items.filter((i) =>
        t!.user_tg != null ? i.user_tg === t!.user_tg : i.email?.toLowerCase() === t!.email?.toLowerCase(),
      ),
  });
}

// Mirrors src/crm/operators.ts (OperatorSummary) and src/crm/settings.ts (Settings).
export type OperatorSummary = Omit<Operator, "prefs"> & { open_tickets: number };

export interface CrmSettings extends SlaSettings {
  auto_assign_enabled: boolean;
  auto_assign_minutes: number;
  auto_assign_max_open: number | null;
  offline_after_minutes: number;
  reopen_days: number;
  tg_ping_new_ticket: boolean;
  tg_ping_overdue: boolean;
  tg_ping_no_one_on_shift: boolean;
  resolve_message_enabled: boolean;
  resolve_message_text: string;
}

export function useOperators(enabled = true) {
  return useQuery({
    queryKey: ticketKeys.operators,
    queryFn: () => api<OperatorSummary[]>("/operators"),
    enabled,
    staleTime: 60_000,
  });
}

export function useSlaSettings(): SlaSettings {
  const q = useQuery({
    queryKey: ticketKeys.settings,
    queryFn: () => api<CrmSettings>("/settings"),
    staleTime: 5 * 60_000,
  });
  return q.data ?? DEFAULT_SLA;
}

export type TicketAction =
  | { kind: "take" }
  | { kind: "take-over" }
  | { kind: "assign"; operator: Pick<OperatorSummary, "id" | "name"> | null }
  | { kind: "status"; status: TicketStatus };

function requestFor(id: string, a: TicketAction): Promise<{ ok: true; ticket: TicketListItem }> {
  const base = `/tickets/${encodeURIComponent(id)}`;
  switch (a.kind) {
    case "take":
      return api(`${base}/take`, json("POST"));
    case "take-over":
      return api(`${base}/take-over`, json("POST"));
    case "assign":
      return api(`${base}/assign`, json("POST", { operator_id: a.operator?.id ?? null }));
    case "status":
      return api(`${base}/status`, json("POST", { status: a.status }));
  }
}

function applyAction(t: TicketDetailItem, a: TicketAction, me: Operator | undefined): TicketDetailItem {
  switch (a.kind) {
    case "take":
    case "take-over":
      return me
        ? { ...t, assigned_operator_id: me.id, assigned_operator_name: me.name, auto_assigned: false, status: "allocated" }
        : t;
    case "assign":
      return a.operator
        ? {
            ...t,
            assigned_operator_id: a.operator.id,
            assigned_operator_name: a.operator.name,
            auto_assigned: false,
            status: t.status === "new" ? "allocated" : t.status,
          }
        : { ...t, assigned_operator_id: null, assigned_operator_name: null, auto_assigned: false, status: "new" };
    case "status":
      return { ...t, status: a.status };
  }
}

export interface TicketActionVars {
  id: string;
  action: TicketAction;
}

export function isSurfaceBitrix(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.body as ConflictBody | undefined)?.error === "surface_bitrix";
}

/** The server switched back to Bitrix under us: flip the cached operator so the thread goes read-only. */
function followSurface(qc: ReturnType<typeof useQueryClient>, err: unknown): void {
  if (!isSurfaceBitrix(err)) return;
  qc.setQueryData<Operator>(keys.me, (me) => (me ? { ...me, surface: "bitrix" } : me));
  void qc.invalidateQueries({ queryKey: keys.me });
}

/**
 * Header actions: optimistic on the ticket's detail cache, rolled back when the server refuses.
 * The ticket id travels with each call, so a late retry from a toast hits the ticket it was about.
 */
export function useTicketAction() {
  const qc = useQueryClient();
  const me = useMe().data;
  return useMutation({
    mutationFn: ({ id, action }: TicketActionVars) => requestFor(id, action),
    onMutate: async ({ id, action }) => {
      const key = ticketKeys.detail(id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TicketDetail>(key);
      if (prev) qc.setQueryData<TicketDetail>(key, { ...prev, ticket: applyAction(prev.ticket, action, me) });
      return { prev };
    },
    onError: (e, { id }, ctx) => {
      if (ctx?.prev) qc.setQueryData(ticketKeys.detail(id), ctx.prev);
      followSurface(qc, e);
    },
    onSuccess: (res: { ok: true; ticket: TicketListItem }, { id }) => {
      // The server's row replaces the optimistic guess before the refetch lands.
      qc.setQueryData<TicketDetail>(ticketKeys.detail(id), (d) => (d ? { ...d, ticket: { ...d.ticket, ...res.ticket } } : d));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.tickets }),
  });
}

export function useRetryMessage(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api(`/messages/${encodeURIComponent(messageId)}/retry`, json("POST")),
    onMutate: async (messageId) => {
      const key = ticketKeys.detail(ticketId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TicketDetail>(key);
      if (prev) {
        qc.setQueryData<TicketDetail>(key, {
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === messageId ? { ...m, delivery_status: "pending", delivery_error: null } : m,
          ),
        });
      }
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(ticketKeys.detail(ticketId), ctx.prev);
      followSurface(qc, e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) }),
  });
}

export type ComposeMode = "reply" | "note";

export interface SendVars {
  clientKey: string;
  kind: ComposeMode;
  body: string;
  photos: File[];
}

function sendForm({ kind, body, photos }: SendVars): FormData {
  const form = new FormData();
  form.append("kind", kind);
  form.append("body", body);
  for (const p of photos) form.append("photos", p, p.name);
  return form;
}

function optimisticMessage(vars: SendVars, me: Operator | undefined, after: string | undefined, previews: string[]): CrmMessage {
  // Never sort above the last message on a client clock that runs behind the server.
  const at = Math.max(Date.now(), after ? Date.parse(after) + 1 : 0);
  return {
    id: vars.clientKey,
    sender: "agent",
    kind: vars.kind === "note" ? "note" : vars.photos.length ? "photo" : "text",
    body: vars.body,
    unsupported_type: null,
    author_name: me?.name ?? null,
    created_at: new Date(at).toISOString(),
    delivery_status: vars.kind === "reply" ? "pending" : null,
    delivery_error: null,
    attachments: vars.photos.map((p, i) => ({ id: `${vars.clientKey}-${i}`, media_type: p.type, position: i, preview: previews[i] })),
    local: true,
  };
}

/** Reply or note with photos: shows at once as pending, replaced in place by the server's message. */
export function useSendMessage(ticketId: string) {
  const qc = useQueryClient();
  const me = useMe().data;
  const key = ticketKeys.detail(ticketId);
  return useMutation({
    mutationFn: (vars: SendVars) =>
      api<CrmMessage>(`/tickets/${encodeURIComponent(ticketId)}/messages`, { method: "POST", body: sendForm(vars) }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TicketDetail>(key);
      const previews = vars.photos.map((p) => URL.createObjectURL(p));
      const last = prev?.messages.at(-1)?.created_at;
      addOutgoing(ticketId, optimisticMessage(vars, me, last, previews), prev?.messages.map((m) => m.id) ?? []);
      if (prev) qc.setQueryData<TicketDetail>(key, withOutbox(ticketId, prev));
      return { previews };
    },
    onSuccess: (server, vars) => {
      bindServerId(vars.clientKey, server.id);
      qc.setQueryData<TicketDetail>(key, (d) => (d ? confirmOutgoing(d, vars.clientKey, server) : d));
    },
    onError: (e, vars) => {
      qc.setQueryData<TicketDetail>(key, (d) => (d ? dropOutgoing(d, vars.clientKey) : d));
      followSurface(qc, e);
    },
    onSettled: (_d, _e, vars, ctx) => {
      removeOutgoing(vars.clientKey);
      for (const url of ctx?.previews ?? []) URL.revokeObjectURL(url);
      // A reply on a queued ticket assigns it; the list, counts and header follow.
      void qc.invalidateQueries({ queryKey: keys.tickets });
    },
  });
}

/** Index of the photo a 422 `photo_invalid` refused, if that is what happened. */
export function refusedPhotoIndex(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const body = (err.body ?? {}) as { error?: string; index?: unknown };
  return body.error === "photo_invalid" && typeof body.index === "number" ? body.index : null;
}

/** What happened to a send and what to do; `detail` names the photo the server refused. */
export function sendErrorText(err: unknown, photoNames: string[]): { text: string; detail?: string } {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { error?: string; index?: number };
    if (err.status === 422) {
      switch (body.error) {
        case "empty":
          return { text: "Нечего отправить. Напишите текст или прикрепите фото." };
        case "note_needs_body":
          return { text: "Заметке нужен текст." };
        case "too_many_photos":
          return { text: "Не больше 10 фото в сообщении." };
        case "too_long":
          return { text: "Текст длиннее 4000 символов. Сократите его." };
        case "photo_invalid":
          return {
            text: "Фото не принято. Уберите его и отправьте снова.",
            detail: typeof body.index === "number" ? photoNames[body.index] : undefined,
          };
      }
      return { text: "Сообщение не прошло проверку. Обновите страницу." };
    }
    if (err.status === 413) return { text: "Фото слишком тяжёлые. Уберите часть и отправьте снова." };
    if (err.status === 409 || err.status === 403 || err.status === 404) return { text: actionErrorText(err) };
  }
  return { text: "Не отправилось. Повторите." };
}

export interface ConflictBody {
  error?: string;
  assignee?: { id: number; name: string };
}

/** One line in Russian: what happened and what to do. */
export function actionErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as ConflictBody;
    if (err.status === 409) {
      if (body.error === "assigned_to_other") {
        return body.assignee ? `Обращение уже у оператора ${body.assignee.name}.` : "Обращение уже у другого оператора.";
      }
      if (body.error === "resolved") return "Обращение уже решено. Откройте его снова через статус.";
      if (body.error === "other_open") return "У клиента есть другое открытое обращение. Работайте в нём.";
      if (body.error === "surface_bitrix") return READ_ONLY_TEXT;
    }
    if (err.status === 403) return "Нет прав на это действие.";
    if (err.status === 404) return "Обращение не найдено. Обновите список.";
  }
  return "Не сохранилось. Повторите.";
}

export function isAssignedToOther(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.body as ConflictBody | undefined)?.error === "assigned_to_other";
}
