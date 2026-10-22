import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createQueryClient, routes } from "../app";
import { FakeEventSource, installFakeEventSource, jsonResponse } from "../test/fakes";
import { resetApiStateForTests } from "../lib/api";
import { resetToastsForTests } from "../components/Toast";
import { resetPresenceForTests } from "../lib/presence";
import { UNSUPPORTED_TEXT } from "../components/MessageBubble";
import type { TicketDetail, TicketListItem, UserContext } from "../lib/tickets";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const operator = {
  id: 7,
  name: "Аня Смирнова",
  email: "anya@example.com",
  role: "support",
  is_lead: false,
  auto_assign_enabled: true,
  on_shift: true,
  last_active_at: null,
  last_assigned_at: null,
  prefs: { theme: "system", sound: false, volume: 0.6, desktop: false, notify_scope: "all", send_key: "mod_enter" },
};

function item(over: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "new",
    channel: "telegram",
    source: "bot",
    user_name: "Иван Петров",
    user_username: "ivanp",
    user_tg: 5550001,
    email: null,
    last_message_preview: "Не пришёл код",
    last_message_at: ago(6),
    waiting_since: ago(6),
    first_response_at: null,
    assigned_operator_id: null,
    assigned_operator_name: null,
    auto_assigned: false,
    intake_pending: false,
    created_at: ago(6),
    segment: null,
    org_name: null,
    ...over,
  };
}

const T1 = item({ segment: "business_owner", org_name: "Travelata" });
const T2 = item({
  id: "22222222-2222-4222-8222-222222222222",
  status: "allocated",
  source: "web_pwa",
  channel: "web",
  user_name: "Мария",
  user_username: null,
  user_tg: null,
  email: "maria@example.com",
  last_message_preview: "Где моя карта?",
  waiting_since: ago(1),
  assigned_operator_id: 7,
  assigned_operator_name: "Аня Смирнова",
  auto_assigned: true,
  intake_pending: true,
});

// `user` is what GET /tickets/:id/user answers; the detail itself does not carry it.
type DetailFixture = TicketDetail & { user: UserContext | null };

function detail(over: Partial<DetailFixture> = {}): DetailFixture {
  return {
    ticket: { ...T1, device: "iPhone", category: null, web_user_id: null, topic_id: null, topic_name: null, topic_source: null },
    messages: [
      { id: "m1", sender: "user", kind: "text", body: "Не пришёл код", unsupported_type: null, author_name: null, created_at: ago(30), delivery_status: null, delivery_error: null, attachments: [] },
      { id: "m2", sender: "user", kind: "photo", body: "", unsupported_type: null, author_name: null, created_at: ago(29), delivery_status: null, delivery_error: null, attachments: [{ id: "a1", media_type: "image/jpeg", position: 0 }, { id: "a2", media_type: "image/png", position: 1 }] },
      ...Object.keys(UNSUPPORTED_TEXT).map((type, i) => ({
        id: `u${i}`, sender: "user" as const, kind: "unsupported" as const, body: "", unsupported_type: type, author_name: null, created_at: ago(28), delivery_status: null, delivery_error: null, attachments: [],
      })),
      { id: "m3", sender: "agent", kind: "text", body: "Проверяю", unsupported_type: null, author_name: "Олег", created_at: ago(20), delivery_status: "failed", delivery_error: "tg_403: Forbidden: bot was blocked by the user", attachments: [] },
      { id: "m4", sender: "agent", kind: "note", body: "Похоже на лимит СМС", unsupported_type: null, author_name: "Олег", created_at: ago(19), delivery_status: null, delivery_error: null, attachments: [] },
    ],
    events: [
      { id: 1, type: "auto_assigned", actor_name: null, payload: { operator_id: 9, operator_name: "Аня" }, created_at: ago(25) },
      { id: 2, type: "status_changed", actor_name: "Олег", payload: { from: "allocated", to: "resolved" }, created_at: ago(18) },
    ],
    user: { found: false },
    viewers: [],
    ...over,
  };
}

const settings = {
  sla_first_minutes: 5,
  sla_followup_minutes: 15,
  sla_warn_percent: 50,
  auto_assign_enabled: true,
  auto_assign_minutes: 5,
  auto_assign_max_open: null,
  offline_after_minutes: 15,
  reopen_days: 7,
  tg_ping_new_ticket: true,
  tg_ping_overdue: true,
  tg_ping_no_one_on_shift: true,
  resolve_message_enabled: false,
  resolve_message_text: "Мы закрыли обращение.",
  csat_enabled: true, csat_text: "Мы смогли вам помочь?", csat_web_enabled: false,
};

function summary(id: number, name: string, onShift: boolean) {
  const { prefs: _prefs, ...rest } = operator;
  return { ...rest, id, name, role: id === 9 ? "admin" : "support", on_shift: onShift, open_tickets: 2 };
}

type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;

function mockApi(routes: Array<[string, Handler]>) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, body: init.body as string | undefined });
    for (const [pattern, handler] of routes) {
      const [m, p] = pattern.split(" ");
      if (m === method && (p === url.pathname || (p!.endsWith("*") && url.pathname.startsWith(p!.slice(0, -1))))) {
        return handler(init, url);
      }
    }
    if (method === "POST" && url.pathname.endsWith("/presence")) return jsonResponse(200, { ok: true });
    if (url.pathname === "/crm/api/me/heartbeat") return jsonResponse(200, { ok: true });
    return jsonResponse(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

const ok = (body: unknown) => () => jsonResponse(200, body);
const page = (items: TicketListItem[]) => ok({ items, nextCursor: null, counts: { queue: 1, mine: 1, overdue: 1 } });

const baseRoutes = (d: DetailFixture = detail()): Array<[string, Handler]> => [
  ["GET /crm/api/me", ok(operator)],
  ["GET /crm/api/tickets", page([T1, T2])],
  ["GET /crm/api/tickets/*", (_init, url) => jsonResponse(200, url.pathname.endsWith("/user") ? d.user : d)],
  ["GET /crm/api/settings", ok(settings)],
  ["GET /crm/api/operators", ok([summary(7, "Аня Смирнова", true), summary(9, "Олег", false)])],
];

function renderAt(path: string) {
  const client = createQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

describe("Inbox", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    resetApiStateForTests();
    resetToastsForTests();
    resetPresenceForTests();
    installFakeEventSource();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists tickets with SLA, channel, chips and assignee", async () => {
    mockApi(baseRoutes());
    renderAt("/");
    const list = await screen.findByRole("list", { name: "Обращения" });
    const rows = within(list).getAllByRole("link");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Иван Петров");
    expect(rows[0]!.textContent).toContain("@ivanp");
    expect(within(rows[0]!).getByRole("img", { name: "Telegram бот" })).toBeTruthy();
    const late = rows[0]!.querySelector("[data-level]")!;
    expect(late.getAttribute("data-level")).toBe("late");
    expect(late.textContent).toBe("6 мин");
    expect(within(rows[1]!).getByRole("img", { name: "Web" })).toBeTruthy();
    expect(rows[1]!.textContent).toContain("авто");
    expect(rows[1]!.textContent).toContain("ждём email");
    expect(within(rows[1]!).getByRole("img", { name: "Аня Смирнова" }).textContent).toBe("АС");
    expect(screen.getByRole("heading", { name: "Очередь" })).toBeTruthy();
  });

  it("re-renders the SLA badge as time passes", async () => {
    mockApi(baseRoutes());
    renderAt("/");
    const list = await screen.findByRole("list", { name: "Обращения" });
    const badge = () => within(list).getAllByRole("link")[1]!.querySelector("[data-level]")!;
    expect(badge().getAttribute("data-level")).toBe("ok");
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(badge().getAttribute("data-level")).toBe("warn");
  });

  it("shows the thread: sides, notes, events, photos, unsupported chips and delivery", async () => {
    mockApi(baseRoutes());
    renderAt(`/t/${T1.id}?v=queue`);
    const thread = await screen.findByRole("list", { name: "Переписка" });
    expect(within(thread).getByText("Не пришёл код")).toBeTruthy();
    expect(within(thread).getAllByText("Олег").length).toBeGreaterThan(0);
    expect(within(thread).getByText("Заметка")).toBeTruthy();
    expect(within(thread).getByText("Назначен автоматически: Аня")).toBeTruthy();
    expect(within(thread).getByText("Решён")).toBeTruthy();
    for (const text of [
      "🎥 Видео не поддерживается",
      "🎞 GIF не поддерживается",
      "🎤 Голосовое не поддерживается",
      "📎 Файл не поддерживается",
      "Стикер",
      "🎥 Кружок не поддерживается",
      "🎵 Аудио не поддерживается",
    ]) {
      expect(within(thread).getByText(text)).toBeTruthy();
    }
    const imgs = thread.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toBe("/crm/api/attachments/a1");
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
    expect(within(thread).getByText(/Не доставлено\. Клиент заблокировал бота\./)).toBeTruthy();
  });

  it("retries a failed delivery", async () => {
    const { calls } = mockApi([["POST /crm/api/messages/m3/retry", ok({ ok: true })], ...baseRoutes()]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/crm/api/messages/m3/retry")).toBe(true));
  });

  it("opens a photo in the lightbox and closes it with Escape", async () => {
    mockApi(baseRoutes());
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть фото 2 из 2" }));
    const dialog = screen.getByRole("dialog", { name: "Фото 2 из 2" });
    expect(dialog.querySelector("img")!.getAttribute("src")).toBe("/crm/api/attachments/a2");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Фото 1 из 2" })).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps Tab inside the lightbox and keeps j from reaching the list behind it", async () => {
    mockApi(baseRoutes());
    const { router } = renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть фото 1 из 2" }));
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    buttons.at(-1)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });
    expect(router.state.location.pathname).toBe(`/t/${T1.id}`);
  });

  it("takes a queued ticket from the header and shows the server's row", async () => {
    let taken = false;
    const takenRow = { ...T1, status: "allocated" as const, assigned_operator_id: 7, assigned_operator_name: "Аня Смирнова" };
    const { calls } = mockApi([
      ["POST /crm/api/tickets/*", (_i, url) => {
        if (!url.pathname.endsWith("/take")) return jsonResponse(200, { ok: true });
        taken = true;
        return jsonResponse(200, { ok: true, ticket: takenRow });
      }],
      ["GET /crm/api/tickets/*", () => {
        const d = detail();
        return jsonResponse(200, taken ? { ...d, ticket: { ...d.ticket, ...takenRow } } : d);
      }],
      ...baseRoutes(),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Взять" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/crm/api/tickets/${T1.id}/take`)).toBe(true));
    expect(await screen.findByRole("button", { name: "Назначен: Аня Смирнова" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Взять" })).toBeNull();
  });

  it("explains a 409 and offers «Перехватить»", async () => {
    const { calls } = mockApi([
      ["POST /crm/api/tickets/*", (_i, url) =>
        url.pathname.endsWith("/take")
          ? jsonResponse(409, { error: "assigned_to_other", assignee: { id: 9, name: "Олег" } })
          : jsonResponse(200, { ok: true })],
      ...baseRoutes(),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Взять" }));
    expect(await screen.findByText("Обращение уже у оператора Олег.")).toBeTruthy();
    const toastRegion = screen.getByLabelText("Уведомления");
    fireEvent.click(within(toastRegion).getByRole("button", { name: "Перехватить" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/crm/api/tickets/${T1.id}/take-over`)).toBe(true));
  });

  it("reports a failed take-over started from the 409 toast", async () => {
    mockApi([
      ["POST /crm/api/tickets/*", (_i, url) =>
        url.pathname.endsWith("/take")
          ? jsonResponse(409, { error: "assigned_to_other", assignee: { id: 9, name: "Олег" } })
          : url.pathname.endsWith("/take-over")
            ? jsonResponse(403, { error: "forbidden" })
            : jsonResponse(200, { ok: true })],
      ...baseRoutes(),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Взять" }));
    await screen.findByText("Обращение уже у оператора Олег.");
    fireEvent.click(within(screen.getByLabelText("Уведомления")).getByRole("button", { name: "Перехватить" }));
    expect(await screen.findByText("Нет прав на это действие.")).toBeTruthy();
  });

  it("answers a on a colleague's ticket with a «Перехватить» toast", async () => {
    const theirs = { ...T1, status: "allocated" as const, assigned_operator_id: 9, assigned_operator_name: "Олег" };
    const { calls } = mockApi([
      ["POST /crm/api/tickets/*", ok({ ok: true, ticket: theirs })],
      ["GET /crm/api/tickets/*", ok(detail({ ticket: { ...theirs, device: null, category: null, web_user_id: null, topic_id: null, topic_name: null, topic_source: null } }))],
      ...baseRoutes(),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    // The header and the locked composer both offer it.
    await screen.findAllByRole("button", { name: "Перехватить" });
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });
    expect(await within(screen.getByLabelText("Уведомления")).findByText("Обращение у оператора Олег.")).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("/take"))).toBe(false);
    fireEvent.click(within(screen.getByLabelText("Уведомления")).getByRole("button", { name: "Перехватить" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/crm/api/tickets/${T1.id}/take-over`)).toBe(true));
  });

  it("changes status from the menu and resolves with e", async () => {
    const { calls } = mockApi([["POST /crm/api/tickets/*", ok({ ok: true })], ...baseRoutes()]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Статус: Новый" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Ждём клиента" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/status"))?.body).toBe('{"status":"awaiting"}'),
    );
    fireEvent.keyDown(document.body, { key: "e", code: "KeyE" });
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/status")).at(-1)?.body).toBe('{"status":"resolved"}'));
  });

  it("is read-only before cutover: one line, no composer, no write actions", async () => {
    const { calls } = mockApi([["GET /crm/api/me", ok({ ...operator, surface: "bitrix" })], ...baseRoutes()]);
    renderAt(`/t/${T1.id}?v=queue`);
    await screen.findByRole("list", { name: "Переписка" });
    expect(screen.getAllByRole("status").filter((el) => el.tagName === "P" && el.textContent === "CRM в режиме просмотра до переключения.")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "Ответ клиенту" })).toBeNull();
    for (const name of ["Взять", "Перехватить", "Решить", "Повторить", "Статус: Новый", "Назначить"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByText("Не назначен")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });
    fireEvent.keyDown(document.body, { key: "e", code: "KeyE" });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/crm/api/tickets/") && !c.path.endsWith("/presence"))).toBe(false);
  });

  it("a 409 surface_bitrix explains itself and turns the thread read-only", async () => {
    let surface = "crm";
    mockApi([
      ["GET /crm/api/me", () => jsonResponse(200, { ...operator, surface })],
      ["POST /crm/api/tickets/*", (_i, url) => {
        if (!url.pathname.endsWith("/take")) return jsonResponse(200, { ok: true });
        surface = "bitrix";
        return jsonResponse(409, { error: "surface_bitrix" });
      }],
      ...baseRoutes(),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    expect(await screen.findByRole("textbox", { name: "Ответ клиенту" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Взять" }));
    expect(await within(screen.getByLabelText("Уведомления")).findByText("CRM в режиме просмотра до переключения.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Ответ клиенту" })).toBeNull());
    expect(screen.getAllByRole("status").filter((el) => el.tagName === "P" && el.textContent === "CRM в режиме просмотра до переключения.")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Взять" })).toBeNull();
  });

  it("assigns to a colleague from the operators menu", async () => {
    const { calls } = mockApi([["POST /crm/api/tickets/*", ok({ ok: true })], ...baseRoutes()]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Назначить" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Олег" }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/assign"))?.body).toBe('{"operator_id":9}'));
  });

  it("shows «Нет аккаунта» and copies the TG id with a toast", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockApi(baseRoutes());
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    // The account is its own query, fired when the panel mounts: wait for it, don't assume one tick.
    expect(await within(panel).findByText("Нет аккаунта")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "5550001. Скопировать TG id" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("5550001"));
    expect(await screen.findByText("Скопировано: TG id")).toBeTruthy();
  });

  it("plays an operator video in the thread", async () => {
    const d = detail();
    d.messages.push({
      id: "mv", sender: "agent", kind: "video", body: "Инструкция", unsupported_type: null, author_name: "Олег",
      created_at: ago(10), delivery_status: "sent", delivery_error: null,
      attachments: [{ id: "av1", media_type: "video/mp4", position: 0 }],
    });
    mockApi(baseRoutes(d));
    renderAt(`/t/${T1.id}?v=queue`);
    const thread = await screen.findByRole("list", { name: "Переписка" });
    const video = await waitFor(() => {
      const v = thread.querySelector("video");
      expect(v).toBeTruthy();
      return v!;
    });
    expect(video.getAttribute("src")).toBe("/crm/api/attachments/av1");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("aria-label")).toBe("Видео");
  });

  it("prefetches a ticket on hover, so opening it is instant", async () => {
    const { calls } = mockApi(baseRoutes());
    renderAt("/");
    const row = await screen.findByRole("link", { name: new RegExp(T2.user_name!) });
    expect(calls.some((c) => c.path === `/crm/api/tickets/${T2.id}`)).toBe(false);
    fireEvent.mouseEnter(row);
    await waitFor(() => expect(calls.some((c) => c.path === `/crm/api/tickets/${T2.id}`)).toBe(true));
  });

  it("opens the thread without waiting for the Turkarta account", async () => {
    const d = detail();
    mockApi([
      ["GET /crm/api/tickets/*", (_init, url) => (url.pathname.endsWith("/user") ? new Promise<Response>(() => {}) : jsonResponse(200, d))],
      ...baseRoutes(d),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    const thread = await screen.findByRole("list", { name: "Переписка" });
    expect(await within(thread).findByText("Не пришёл код")).toBeTruthy();
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(within(panel).getByText("Загружаем аккаунт…")).toBeTruthy();
  });

  it("shows the Turkarta account when found", async () => {
    mockApi(
      baseRoutes(
        detail({
          user: {
            found: true,
            user_id: "u-1",
            name: "Иван Петров",
            email: "ivan@example.com",
            email_verified: true,
            kyc_level: 2.5,
            csb_email: "u1@cards.turkarta.me",
            cards: [{ last4: "4242", status: "active", plan: "Travel", product_id: "20170310100493724", balance_usd: "120.5" }],
            antarctic_user_id: "ant-user-77",
            recent_topups: [
              { amount_rub: "10000", amount_usd: "110", status: "paid", rail: "xhub", antarctic: null, created_at: ago(60) },
              {
                amount_rub: "3000", amount_usd: "31.19", status: "rail_failed", rail: "antarctic",
                antarctic: { order_id: "ant-order-1", payment_uuid: "aw-uuid-1" }, created_at: ago(120),
              },
            ],
            admin_url: "https://admin.example/users/u-1",
          },
        }),
      ),
    );
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(await within(panel).findByText("уровень 2,5")).toBeTruthy();
    expect(within(panel).getByText("•• 4242")).toBeTruthy();
    expect(within(panel).getByText("CSB email")).toBeTruthy();
    expect(within(panel).getByText("u1@cards.turkarta.me")).toBeTruthy();
    expect(within(panel).getByText("product 20170310100493724")).toBeTruthy();
    expect(within(panel).getByText("Antarctic ID")).toBeTruthy();
    expect(within(panel).getByText("ant-user-77")).toBeTruthy();
    expect(within(panel).getByText("x-hub")).toBeTruthy();
    expect(within(panel).getByText("Antarctic")).toBeTruthy();
    expect(within(panel).getByText("ant-order-1")).toBeTruthy();
    expect(within(panel).getByText("aw-uuid-1")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: /Открыть в админке/ }).getAttribute("href")).toBe("https://admin.example/users/u-1");
  });

  it("shows the company block for a cabinet ticket and no app account", async () => {
    mockApi(
      baseRoutes(
        detail({
          user: {
            found: true,
            user_id: "biz:cu1",
            name: "Ольга",
            email: "o@t.ru",
            company: {
              name: "Travelata", role: "owner", member_status: "active", company_status: "active",
              active_members: 12, cards: 30, card_details_visible_to_admins: false,
              admin_url: "https://api/admin/companies/c1",
            },
          },
        }),
      ),
    );
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(await within(panel).findByText("Компания")).toBeTruthy();
    expect(within(panel).getByText("Travelata")).toBeTruthy();
    expect(within(panel).getByText("Владелец")).toBeTruthy();
    expect(within(panel).getByText("Статус участника").nextElementSibling?.textContent).toBe("Активен");
    expect(within(panel).getByText("Статус компании").nextElementSibling?.textContent).toBe("Активна");
    expect(within(panel).getByText("Сотрудников").nextElementSibling?.textContent).toBe("12");
    expect(within(panel).getByText("Карт").nextElementSibling?.textContent).toBe("30");
    expect(within(panel).getByText("Реквизиты карт админам").nextElementSibling?.textContent).toBe("Нет");
    expect(within(panel).getByRole("link", { name: /Открыть в админке/ }).getAttribute("href")).toBe("https://api/admin/companies/c1");
    expect(within(panel).queryByText("Аккаунт Turkarta")).toBeNull();
    expect(within(panel).queryByText("Карт нет.")).toBeNull();
  });

  it("shows the partner block for a partner ticket", async () => {
    mockApi(
      baseRoutes(
        detail({ user: { found: true, user_id: "biz:cu2", partner: { name: "Агентство Север", code: "agn", role: "owner", admin_url: null } } }),
      ),
    );
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(await within(panel).findByText("Партнер")).toBeTruthy();
    expect(within(panel).getByText("Агентство Север")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /agn.*Скопировать код партнера/ })).toBeTruthy();
    expect(within(panel).getByText("Владелец")).toBeTruthy();
    expect(within(panel).queryByText("Аккаунт Turkarta")).toBeNull();
  });

  it("an app corporate employee shows both the account and the company", async () => {
    mockApi(
      baseRoutes(
        detail({
          user: {
            found: true,
            user_id: "u-9",
            cards: [],
            company: { name: "Travelata", role: "employee", member_status: "active" },
          },
        }),
      ),
    );
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(await within(panel).findByText("Аккаунт Turkarta")).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: "Компания" })).toBeTruthy();
    expect(within(panel).getByText("Сотрудник")).toBeTruthy();
    expect(within(panel).getByText("Travelata")).toBeTruthy();
    expect(within(panel).getByText("Статус участника").nextElementSibling?.textContent).toBe("Активен");
    expect(within(panel).queryByText("Статус компании")).toBeNull();
  });

  it("shows a disabled company member as «Отключен»", async () => {
    mockApi(
      baseRoutes(
        detail({ user: { found: true, user_id: "biz:cu3", company: { name: "Travelata", role: "admin", member_status: "disabled" } } }),
      ),
    );
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(await within(panel).findByText("Отключен")).toBeTruthy();
    expect(within(panel).getByText("Администратор")).toBeTruthy();
  });

  it("moves with j and opens with Enter, switches views with g m", async () => {
    mockApi(baseRoutes());
    const { router } = renderAt("/");
    await screen.findByRole("list", { name: "Обращения" });
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/t/${T2.id}`));
    expect(router.state.location.search).toContain("v=queue");
    fireEvent.keyDown(document.body, { key: "g", code: "KeyG" });
    fireEvent.keyDown(document.body, { key: "m", code: "KeyM" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/mine"));
  });

  it("refetches the open thread on message.created, even before ticket.created", async () => {
    const { calls } = mockApi(baseRoutes());
    renderAt(`/t/${T1.id}?v=queue`);
    await screen.findByRole("list", { name: "Переписка" });
    const detailCalls = () => calls.filter((c) => c.method === "GET" && c.path === `/crm/api/tickets/${T1.id}`).length;
    const before = detailCalls();
    act(() => FakeEventSource.latest().emit("message.created", { ticketId: T1.id, messageId: "m9" }));
    act(() => FakeEventSource.latest().emit("message.created", { ticketId: T1.id, messageId: "m9" }));
    await waitFor(() => expect(detailCalls()).toBeGreaterThan(before));
  });

  it("leaves the open thread alone on another ticket's message", async () => {
    const { calls } = mockApi(baseRoutes());
    renderAt(`/t/${T1.id}?v=queue`);
    await screen.findByRole("list", { name: "Переписка" });
    const listCalls = () => calls.filter((c) => c.path.startsWith("/crm/api/tickets?view=queue")).length;
    const detailCalls = () => calls.filter((c) => c.method === "GET" && c.path === `/crm/api/tickets/${T1.id}`).length;
    const [lists, details] = [listCalls(), detailCalls()];
    act(() => FakeEventSource.latest().emit("message.created", { ticketId: T2.id, messageId: "m9" }));
    await waitFor(() => expect(listCalls()).toBeGreaterThan(lists));
    expect(detailCalls()).toBe(details);
  });

  it("keeps focus inside the client sheet across re-renders and traps Tab", async () => {
    let listVersion = 0;
    mockApi([
      ["GET /crm/api/tickets", () => {
        listVersion += 1;
        const preview = listVersion > 1 ? "Новое сообщение" : T2.last_message_preview;
        return jsonResponse(200, { items: [T1, { ...T2, last_message_preview: preview }], nextCursor: null, counts: { queue: 1, mine: 1, overdue: 1 } });
      }],
      ...baseRoutes(),
    ]);
    renderAt(`/t/${T1.id}?v=queue`);
    fireEvent.click(await screen.findByRole("button", { name: "Клиент" }));
    const sheet = screen.getByRole("dialog", { name: "Клиент" });
    expect(document.activeElement).toBe(sheet);
    const close = within(sheet).getByRole("button", { name: "Закрыть панель" });
    close.focus();
    // New list data re-renders the whole inbox behind the sheet.
    act(() => FakeEventSource.latest().emit("ticket.updated", { ticketId: T2.id }));
    await screen.findByText("Новое сообщение");
    expect(document.activeElement).toBe(close);
    const focusables = within(sheet).getAllByRole("button");
    focusables.at(-1)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Клиент" })).toBeNull();
  });

  it("says «Нет данных аккаунта» when the account lookup returned nothing", async () => {
    mockApi(baseRoutes(detail({ user: null })));
    renderAt(`/t/${T1.id}?v=queue`);
    const panel = await screen.findByRole("complementary", { name: "Клиент" });
    expect(await within(panel).findByText("Нет данных аккаунта")).toBeTruthy();
  });

  it("pings presence while open and shows who else is here", async () => {
    const { calls } = mockApi(baseRoutes());
    renderAt(`/t/${T1.id}?v=queue`);
    await screen.findByRole("list", { name: "Переписка" });
    await waitFor(() =>
      expect(calls.find((c) => c.path === `/crm/api/tickets/${T1.id}/presence`)?.body).toBe('{"state":"viewing"}'),
    );
    act(() =>
      FakeEventSource.latest().emit("presence", {
        ticketId: T1.id,
        viewers: [{ operatorId: 9, name: "Олег", state: "typing" }, { operatorId: 7, name: "Аня Смирнова", state: "viewing" }],
      }),
    );
    expect(await screen.findByText("Олег печатает…")).toBeTruthy();
  });

  it("filters the all view by the overdue param from the nav", async () => {
    const { calls } = mockApi(baseRoutes());
    renderAt("/all?overdue=1");
    await screen.findByRole("list", { name: "Обращения" });
    expect(calls.some((c) => c.path.startsWith("/crm/api/tickets?view=all&overdue=1"))).toBe(true);
    expect(screen.getByRole("heading", { name: "Просрочено" })).toBeTruthy();
  });

  it("teaches the next step on an empty mine view", async () => {
    mockApi([["GET /crm/api/tickets", page([])], ...baseRoutes()]);
    renderAt("/mine");
    expect(await screen.findByText("У вас нет открытых обращений. Возьмите из очереди: G, затем Q.")).toBeTruthy();
  });

  it("shows the mark in the row and the header; tickets without one show nothing", async () => {
    mockApi(baseRoutes());
    renderAt("/");
    const list = await screen.findByRole("list", { name: "Обращения" });
    const rows = within(list).getAllByRole("link");
    expect(within(rows[0]!).getByText("Владелец · Travelata")).toBeTruthy();
    expect(rows[1]!.textContent).not.toMatch(/Владелец|Администратор|Корпоративная|Партнер|Клиент приложения/);
    await act(async () => {
      fireEvent.click(rows[0]!);
    });
    await waitFor(() => expect(screen.getAllByText("Владелец · Travelata")).toHaveLength(2));
  });

  it("filters by segment through the «Клиент» select", async () => {
    const { calls } = mockApi(baseRoutes());
    const { router } = renderAt("/all");
    await screen.findByRole("list", { name: "Обращения" });
    fireEvent.change(screen.getByLabelText("Клиент"), { target: { value: "partner" } });
    await waitFor(() => expect(calls.filter((c) => c.path.startsWith("/crm/api/tickets?")).at(-1)?.path).toContain("segment=partner"));
    expect(router.state.location.search).toContain("segment=partner");
  });
});
