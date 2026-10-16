import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createQueryClient, routes } from "../app";
import { installFakeEventSource, jsonResponse } from "../test/fakes";
import { resetApiStateForTests } from "../lib/api";
import { resetToastsForTests } from "./Toast";
import { resetPresenceForTests } from "../lib/presence";
import { resetOutboxForTests } from "../lib/outbox";
import { MAX_PHOTO_BYTES } from "../lib/files";
import type { CrmMessage, TicketDetail, TicketListItem } from "../lib/tickets";

const TID = "11111111-1111-4111-8111-111111111111";
const now = new Date().toISOString();

function operator(sendKey: "enter" | "mod_enter" = "mod_enter") {
  return {
    id: 7,
    name: "Аня Смирнова",
    email: null,
    role: "support",
    is_lead: false,
    auto_assign_enabled: true,
    on_shift: true,
    last_active_at: null,
    last_assigned_at: null,
    prefs: { theme: "system", sound: false, volume: 0.6, desktop: false, notify_scope: "all", send_key: sendKey },
  };
}

const ticket = (over: Partial<TicketListItem> = {}): TicketDetail["ticket"] => ({
  id: TID,
  status: "allocated",
  channel: "telegram",
  source: "bot",
  user_name: "Иван Петров",
  user_username: "ivanp",
  user_tg: 5550001,
  email: null,
  last_message_preview: "Не пришёл код",
  last_message_at: now,
  waiting_since: now,
  first_response_at: null,
  assigned_operator_id: 7,
  assigned_operator_name: "Аня Смирнова",
  auto_assigned: false,
  intake_pending: false,
  created_at: now,
  device: null,
  category: null,
  web_user_id: null,
  ...over,
});

const userMessage: CrmMessage = {
  id: "m1", sender: "user", kind: "text", body: "Не пришёл код", unsupported_type: null, author_name: null,
  created_at: new Date(Date.now() - 60_000).toISOString(), delivery_status: null, delivery_error: null, attachments: [],
};

const detail = (over: Partial<TicketListItem> = {}): TicketDetail => ({
  ticket: ticket(over),
  messages: [userMessage],
  events: [],
  user: { found: false },
  viewers: [],
});

const operators = [
  { ...operator(), open_tickets: 1 },
  { ...operator(), id: 9, name: "Олег", open_tickets: 2 },
  { ...operator(), id: 10, name: "Мария Олейник", on_shift: false, open_tickets: 0 },
].map(({ prefs: _p, ...o }) => o);

const canned = [
  { id: "c1", title: "Приветствие", body: "Здравствуйте, {имя}! Меня зовут {оператор}.", use_count: 9, created_by: null },
  { id: "c2", title: "Код не пришёл", body: "Проверьте папку спам.", use_count: 3, created_by: null },
];

type Handler = (init: RequestInit, url: URL) => Response | Promise<Response>;

function mockApi(opts: { detail?: TicketDetail; sendKey?: "enter" | "mod_enter"; send?: Handler } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const d = opts.detail ?? detail();
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    const method = init.method ?? "GET";
    const path = url.pathname;
    calls.push({ method, path: path + url.search, body: init.body });
    if (method === "GET" && path === "/crm/api/me") return jsonResponse(200, operator(opts.sendKey));
    if (method === "GET" && path === "/crm/api/tickets") return jsonResponse(200, { items: [d.ticket], nextCursor: null, counts: { queue: 0, mine: 1, overdue: 0 } });
    if (method === "GET" && path === `/crm/api/tickets/${TID}`) return jsonResponse(200, d);
    if (method === "GET" && path === "/crm/api/operators") return jsonResponse(200, operators);
    if (method === "GET" && path === "/crm/api/settings") return jsonResponse(404, {});
    if (method === "GET" && path === "/crm/api/canned") return jsonResponse(200, canned);
    if (method === "POST" && path === `/crm/api/tickets/${TID}/messages` && opts.send) return opts.send(init, url);
    return jsonResponse(200, { ok: true });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

function renderThread() {
  const client = createQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [`/t/${TID}?v=mine`] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

const photo = (name: string, type = "image/jpeg", size = 2048) => new File([new Uint8Array(size)], name, { type });
const filesDrag = (files: File[]) => ({ dataTransfer: { types: ["Files"], files, dropEffect: "none" } });
const pane = () => screen.getByRole("list", { name: "Переписка" }).closest(".relative") as HTMLElement;
const overlay = () => document.querySelector(".drop-overlay") as HTMLElement;
const textbox = (name = "Ответ клиенту") => screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
const toasts = () => screen.getByLabelText("Уведомления");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Composer", () => {
  beforeEach(() => {
    resetApiStateForTests();
    resetToastsForTests();
    resetPresenceForTests();
    resetOutboxForTests();
    installFakeEventSource();
    let n = 0;
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("drops 3 photos and a pdf onto the thread: 3 previews and one rejection toast", async () => {
    mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    const files = [photo("a.jpg"), photo("b.png", "image/png"), photo("doc.pdf", "application/pdf"), photo("c.webp", "image/webp")];

    fireEvent.dragEnter(pane(), filesDrag(files));
    expect(overlay().hasAttribute("data-active")).toBe(true);
    expect(within(overlay()).getByText("Отпустите, чтобы прикрепить")).toBeTruthy();
    expect(within(overlay()).getByText("JPG, PNG, WEBP до 8 МБ, до 10 фото")).toBeTruthy();
    fireEvent.drop(pane(), filesDrag(files));

    expect(overlay().hasAttribute("data-active")).toBe(false);
    const strip = screen.getByRole("list", { name: "Фото к отправке" });
    expect(within(strip).getAllByRole("listitem")).toHaveLength(3);
    expect(within(toasts()).getByText("Не прикреплено: doc.pdf")).toBeTruthy();
    expect(within(toasts()).getByText("только фото: JPG, PNG, WEBP")).toBeTruthy();
    expect(within(toasts()).getAllByText(/^Не прикреплено/)).toHaveLength(1);
    expect(document.activeElement).toBe(textbox());
  });

  it("keeps the overlay while the drag crosses children and ignores non-file drags", async () => {
    mockApi();
    renderThread();
    const list = await screen.findByRole("list", { name: "Переписка" });
    const drag = filesDrag([photo("a.jpg")]);
    fireEvent.dragEnter(pane(), drag);
    fireEvent.dragEnter(list, drag);
    fireEvent.dragLeave(pane(), drag);
    expect(overlay().hasAttribute("data-active")).toBe(true);
    fireEvent.dragLeave(list, drag);
    expect(overlay().hasAttribute("data-active")).toBe(false);

    fireEvent.dragEnter(pane(), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(overlay().hasAttribute("data-active")).toBe(false);
  });

  it("rejects per reason: type, size and the 11th photo, keeping the valid ones", async () => {
    mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    const many = Array.from({ length: 11 }, (_, i) => photo(`p${i}.jpg`));
    const files = [...many, photo("cat.gif", "image/gif"), photo("big.jpg", "image/jpeg", MAX_PHOTO_BYTES + 1)];
    fireEvent.drop(pane(), filesDrag(files));
    expect(within(screen.getByRole("list", { name: "Фото к отправке" })).getAllByRole("listitem")).toHaveLength(10);
    expect(within(toasts()).getByText("не больше 10 фото")).toBeTruthy();
    expect(within(toasts()).getByText("Не прикреплено: p10.jpg")).toBeTruthy();
    expect(within(toasts()).getByText("только фото: JPG, PNG, WEBP")).toBeTruthy();
    expect(within(toasts()).getByText("больше 8 МБ")).toBeTruthy();
  });

  it("locks replies on a colleague's ticket: the overlay says so and the drop is ignored; notes stay open", async () => {
    const { calls } = mockApi({ detail: detail({ assigned_operator_id: 9, assigned_operator_name: "Олег" }) });
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    expect(screen.getByText("Обращение у оператора Олег.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Ответ клиенту" })).toBeNull();

    fireEvent.dragEnter(pane(), filesDrag([photo("a.jpg")]));
    expect(within(overlay()).getByText("Сначала нажмите «Перехватить»")).toBeTruthy();
    fireEvent.drop(pane(), filesDrag([photo("a.jpg")]));
    expect(screen.queryByRole("list", { name: "Фото к отправке" })).toBeNull();

    const composer = screen.getByRole("radiogroup", { name: "Тип сообщения" }).parentElement!.parentElement!;
    fireEvent.click(within(composer).getByRole("button", { name: "Перехватить" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/crm/api/tickets/${TID}/take-over`)).toBe(true));

    fireEvent.click(screen.getByRole("radio", { name: "Заметка" }));
    expect(textbox("Заметка")).toBeTruthy();
    fireEvent.drop(pane(), filesDrag([photo("a.jpg")]));
    expect(within(screen.getByRole("list", { name: "Фото к отправке" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("takes pasted images and files from the 📎 picker, and removes a preview", async () => {
    mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.paste(textbox(), { clipboardData: { files: [photo("image.png", "image/png")] } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");
    expect(input.multiple).toBe(true);
    fireEvent.change(input, { target: { files: [photo("x.jpg"), photo("y.jpg")] } });
    const strip = () => screen.getByRole("list", { name: "Фото к отправке" });
    expect(within(strip()).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Убрать фото x.jpg" }));
    expect(within(strip()).getAllByRole("listitem")).toHaveLength(2);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
  });

  it("sends optimistically: pending at once, replaced in place by the server message, one POST", async () => {
    const reply = deferred<Response>();
    const d = detail();
    const { calls } = mockApi({ detail: d, send: () => reply.promise });
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.paste(textbox(), { clipboardData: { files: [photo("shot.png", "image/png")] } });
    fireEvent.change(textbox(), { target: { value: "  Проверьте спам  " } });
    fireEvent.keyDown(textbox(), { key: "Enter", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });

    const thread = screen.getByRole("list", { name: "Переписка" });
    const bubble = await within(thread).findByText("Проверьте спам");
    const row = bubble.closest("[data-message-id]") as HTMLElement;
    expect(row.querySelector("[data-pending]")).toBeTruthy();
    expect(within(row).getByText("Отправляется…")).toBeTruthy();
    expect(textbox().value).toBe("");
    expect(screen.queryByRole("list", { name: "Фото к отправке" })).toBeNull();

    const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    expect(posts).toHaveLength(1);
    const form = posts[0]!.body as FormData;
    expect(form.get("kind")).toBe("reply");
    expect(form.get("body")).toBe("Проверьте спам");
    expect((form.getAll("photos") as File[]).map((f) => f.name)).toEqual(["shot.png"]);

    const server: CrmMessage = {
      id: "srv1", sender: "agent", kind: "photo", body: "Проверьте спам", unsupported_type: null, author_name: "Аня Смирнова",
      created_at: new Date().toISOString(), delivery_status: "sent", delivery_error: null,
      attachments: [{ id: "att1", media_type: "image/png", position: 0 }],
    };
    d.messages = [...d.messages, server];
    await act(async () => {
      reply.resolve(jsonResponse(200, server));
    });
    await waitFor(() => expect(within(row).getByText("Отправлено")).toBeTruthy());
    expect(row.isConnected).toBe(true);
    expect(row.getAttribute("data-message-id")).toBe("srv1");
    expect(row.querySelector("[data-pending]")).toBeNull();
    expect(within(thread).getAllByText("Проверьте спам")).toHaveLength(1);
  });

  it("on 409 rolls back, gives the draft back and offers «Перехватить»", async () => {
    const { calls } = mockApi({
      send: () => jsonResponse(409, { error: "assigned_to_other", assignee: { id: 9, name: "Олег" } }),
    });
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.change(textbox(), { target: { value: "Ответ" } });
    fireEvent.keyDown(textbox(), { key: "Enter", ctrlKey: true });
    expect(await within(toasts()).findByText("Обращение уже у оператора Олег.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Переписка" })).queryByText("Ответ")).toBeNull();
    expect(textbox().value).toBe("Ответ");
    fireEvent.click(within(toasts()).getByRole("button", { name: "Перехватить" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/crm/api/tickets/${TID}/take-over`)).toBe(true));
  });

  it("follows the send key preference; Shift+Enter never sends", async () => {
    const { calls } = mockApi({ sendKey: "enter", send: () => jsonResponse(200, { ...userMessage, id: "s", sender: "agent", body: "Да", author_name: "Аня Смирнова", delivery_status: "sent" }) });
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.change(textbox(), { target: { value: "Да" } });
    fireEvent.keyDown(textbox(), { key: "Enter", shiftKey: true });
    expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false);
    fireEvent.keyDown(textbox(), { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(1));
  });

  it("with mod_enter a plain Enter is a newline, not a send", async () => {
    const { calls } = mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.change(textbox(), { target: { value: "Да" } });
    fireEvent.keyDown(textbox(), { key: "Enter" });
    expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false);
  });

  it("toggles Ответ / Заметка with Tab on an empty field and with Ctrl+.", async () => {
    mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.keyDown(textbox(), { key: "Tab" });
    expect(screen.getByRole("radio", { name: "Заметка" }).getAttribute("aria-checked")).toBe("true");
    expect(textbox("Заметка").closest("[data-mode]")!.getAttribute("data-mode")).toBe("note");
    expect(screen.getByRole("button", { name: "Добавить заметку" })).toBeTruthy();
    fireEvent.change(textbox("Заметка"), { target: { value: "x" } });
    fireEvent.keyDown(textbox("Заметка"), { key: "Tab" });
    expect(screen.getByRole("radio", { name: "Заметка" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(textbox("Заметка"), { key: ".", ctrlKey: true });
    expect(screen.getByRole("radio", { name: "Ответ" }).getAttribute("aria-checked")).toBe("true");
  });

  it("opens canned replies with / at line start and inserts the filled template", async () => {
    const { calls } = mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    const box = textbox();
    fireEvent.change(box, { target: { value: "/", selectionStart: 1 } });
    const list = await screen.findByRole("listbox", { name: "Шаблоны" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(box, { target: { value: "/код", selectionStart: 4 } });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1));
    fireEvent.change(box, { target: { value: "/", selectionStart: 1 } });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(within(list).getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("Здравствуйте, Иван! Меня зовут Аня Смирнова.");
    expect(screen.queryByRole("listbox", { name: "Шаблоны" })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/crm/api/canned/c1/use")).toBe(true));
    expect(calls.some((c) => c.path.endsWith("/messages"))).toBe(false);
  });

  it("offers colleagues after @ in a note and inserts the full name", async () => {
    mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.click(screen.getByRole("radio", { name: "Заметка" }));
    const box = textbox("Заметка");
    fireEvent.change(box, { target: { value: "Глянь @Ол", selectionStart: 9 } });
    const list = await screen.findByRole("listbox", { name: "Упомянуть коллегу" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["ООлегна смене", "МОМария Олейникне на смене"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("Глянь @Мария Олейник ");
  });

  it("does not offer mentions in reply mode", async () => {
    mockApi();
    renderThread();
    await screen.findByRole("list", { name: "Переписка" });
    fireEvent.change(textbox(), { target: { value: "@Ол", selectionStart: 3 } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
