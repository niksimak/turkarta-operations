import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../app";
import { resetApiStateForTests } from "../lib/api";
import { jsonResponse } from "../test/fakes";
import { Settings } from "./Settings";
import type { PushState } from "../lib/push";

const push = vi.hoisted(() => ({
  state: "off" as PushState,
  enablePush: vi.fn(async () => "on" as PushState),
  disablePush: vi.fn(async () => "off" as PushState),
}));
vi.mock("../lib/push", () => ({
  syncPush: async () => push.state,
  enablePush: push.enablePush,
  disablePush: push.disablePush,
}));

const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" };
const support = {
  id: 7, name: "Аня Смирнова", email: null, role: "support", is_lead: false, auto_assign_enabled: true,
  on_shift: true, last_active_at: null, last_assigned_at: null, prefs,
};
const lead = { ...support, is_lead: true };

const settings = {
  sla_first_minutes: 5, sla_followup_minutes: 15, sla_warn_percent: 50, auto_assign_enabled: true,
  auto_assign_minutes: 5, auto_assign_max_open: null, offline_after_minutes: 15, reopen_days: 7,
  tg_ping_new_ticket: true, tg_ping_overdue: true, tg_ping_no_one_on_shift: true,
  resolve_message_enabled: false, resolve_message_text: "Мы закрыли обращение.",
};
const operators = [
  { id: 7, name: "Аня Смирнова", email: null, role: "support", is_lead: false, auto_assign_enabled: true,
    on_shift: true, last_active_at: null, last_assigned_at: null, open_tickets: 2 },
  { id: 9, name: "Олег Петров", email: null, role: "admin", is_lead: false, auto_assign_enabled: false,
    on_shift: false, last_active_at: null, last_assigned_at: null, open_tickets: 0 },
];

type Handler = (init: RequestInit) => Response;

function mockFetch(handlers: Record<string, Handler>) {
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const ok = (body: unknown) => () => jsonResponse(200, body);

function renderSettings(path = "/settings") {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe("Settings, Команда", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is read-only for a support operator who is not a lead", async () => {
    const fetch = mockFetch({
      "GET /crm/api/me": ok(support),
      "GET /crm/api/settings": ok(settings),
      "GET /crm/api/operators": ok(operators),
    });
    renderSettings();

    expect(await screen.findByText(/Только просмотр/)).toBeTruthy();
    const first = (await screen.findByLabelText("Первый ответ")) as HTMLInputElement;
    expect(first.value).toBe("5");
    expect(first.disabled).toBe(true);
    expect((screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Автоназначение" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(first, { target: { value: "9" } });
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();

    // Operators: states as text, no toggles or «Снять со смены».
    const table = await screen.findByRole("table");
    expect(within(table).queryAllByRole("switch")).toHaveLength(0);
    expect(within(table).queryByRole("button", { name: /Снять со смены/ })).toBeNull();
    expect(within(table).getByText("Не участвует")).toBeTruthy();

    // The change log is admin/lead only, so it is never requested.
    expect(screen.queryByText("История изменений")).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/settings/log"))).toBe(false);
  });

  it("shows 422 field errors under the field that caused them", async () => {
    let putBody = "";
    mockFetch({
      "GET /crm/api/me": ok(lead),
      "GET /crm/api/settings": ok(settings),
      "GET /crm/api/settings/log": ok([]),
      "GET /crm/api/operators": ok(operators),
      "PUT /crm/api/settings": (init) => {
        putBody = String(init.body);
        return jsonResponse(422, { error: "validation", fields: { sla_first_minutes: "От 1 до 240 минут" } });
      },
    });
    renderSettings();

    const first = (await screen.findByLabelText("Первый ответ")) as HTMLInputElement;
    expect(first.disabled).toBe(false);
    expect(screen.queryByText(/Только просмотр/)).toBeNull();
    fireEvent.change(first, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    const error = await screen.findByText("От 1 до 240 минут");
    expect(JSON.parse(putBody)).toEqual({ sla_first_minutes: 500 });
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(first.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(first);
    // Other fields stay clean and the draft survives the failed save.
    expect(screen.getByLabelText("Следующие ответы").getAttribute("aria-invalid")).toBeNull();
    expect(first.value).toBe("500");

    // Editing the field clears its error.
    fireEvent.change(first, { target: { value: "10" } });
    await waitFor(() => expect(screen.queryByText("От 1 до 240 минут")).toBeNull());
  });

  it("labels a change made outside the UI as «Система»", async () => {
    mockFetch({
      "GET /crm/api/me": ok(lead),
      "GET /crm/api/settings": ok(settings),
      "GET /crm/api/settings/log": ok([
        { key: "tg_ping_overdue", old_value: true, new_value: false, operator_name: null, created_at: "2026-10-17T10:28:00Z" },
      ]),
      "GET /crm/api/operators": ok(operators),
    });
    renderSettings();
    const row = (await screen.findByText("Просрочка")).closest("li")!;
    expect(row.textContent).toContain("вкл → выкл");
    expect(row.textContent).toContain("Система,");
    expect(row.textContent).not.toContain("Неизвестный оператор");
  });

  it("rejects a non-number before calling the server", async () => {
    const fetch = mockFetch({
      "GET /crm/api/me": ok(lead),
      "GET /crm/api/settings": ok(settings),
      "GET /crm/api/settings/log": ok([]),
      "GET /crm/api/operators": ok(operators),
    });
    renderSettings();
    const reopen = await screen.findByLabelText("Переоткрывать");
    fireEvent.change(reopen, { target: { value: "семь" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Введите целое число.")).toBeTruthy();
    expect(fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("saves only the keys this operator changed when the server moved on meanwhile", async () => {
    let server = { ...settings };
    let putBody = "";
    mockFetch({
      "GET /crm/api/me": ok(lead),
      "GET /crm/api/settings": () => jsonResponse(200, server),
      "GET /crm/api/settings/log": ok([]),
      "GET /crm/api/operators": ok(operators),
      "PUT /crm/api/settings": (init) => {
        putBody = String(init.body);
        server = { ...server, ...(JSON.parse(putBody) as object) };
        return jsonResponse(200, server);
      },
    });
    const client = renderSettings();

    const first = (await screen.findByLabelText("Первый ответ")) as HTMLInputElement;
    fireEvent.change(first, { target: { value: "9" } });

    // Another lead changes a different key; the refetch lands while this form is dirty.
    server = { ...server, reopen_days: 3 };
    await act(() => client.invalidateQueries({ queryKey: ["settings"] }));
    await waitFor(() => expect(client.getQueryData<typeof settings>(["settings"])?.reopen_days).toBe(3));

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(putBody).not.toBe(""));
    expect(JSON.parse(putBody)).toEqual({ sla_first_minutes: 9 });
    expect(server.reopen_days).toBe(3);
    // After the save the form shows the server copy, including the other lead's change.
    await waitFor(() => expect((screen.getByLabelText("Переоткрывать") as HTMLInputElement).value).toBe("3"));
  });

  it("gives a lead who is not an admin the shift and auto-assign controls but not the lead toggle", async () => {
    mockFetch({
      "GET /crm/api/me": ok(lead),
      "GET /crm/api/settings": ok(settings),
      "GET /crm/api/settings/log": ok([]),
      "GET /crm/api/operators": ok(operators),
    });
    renderSettings();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    const anya = rows.find((r) => r.textContent?.includes("Аня Смирнова"))!;
    const oleg = rows.find((r) => r.textContent?.includes("Олег Петров"))!;

    // «Лид» stays text: only an admin toggles it.
    expect(within(anya).getByText("Нет")).toBeTruthy();
    expect(within(table).queryByRole("switch", { name: /Лид/ })).toBeNull();
    // Auto-assign is a switch on every row; «Снять со смены» only for operators on shift.
    expect(within(anya).getByRole("switch", { name: /Аня Смирнова.*Автоназначение/ })).toBeTruthy();
    expect(within(oleg).getByRole("switch")).toBeTruthy();
    expect(within(anya).getByRole("button", { name: "Снять со смены: Аня Смирнова" })).toBeTruthy();
    expect(within(oleg).queryByRole("button", { name: /Снять со смены/ })).toBeNull();
  });
});

describe("Settings, Личные: push on this device", () => {
  beforeEach(() => {
    resetApiStateForTests();
    push.state = "off";
    push.enablePush.mockClear();
    push.disablePush.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const routes = { "GET /crm/api/me": ok(support) };

  it("turns push on and off from the switch", async () => {
    mockFetch(routes);
    renderSettings("/settings?tab=personal");
    const sw = await screen.findByRole("switch", { name: "Push-уведомления на этом устройстве" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(push.enablePush).toHaveBeenCalledTimes(1);
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(push.disablePush).toHaveBeenCalledTimes(1);
  });

  it("explains the iPhone Home Screen step and disables the switch", async () => {
    push.state = "ios_install";
    mockFetch(routes);
    renderSettings("/settings?tab=personal");
    expect(await screen.findByText(/добавьте Поддержку на экран Домой/)).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Push-уведомления на этом устройстве" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the row while push is not configured on the server", async () => {
    push.state = "disabled_server";
    mockFetch(routes);
    renderSettings("/settings?tab=personal");
    await screen.findByRole("switch", { name: "Звук" });
    await act(async () => {});
    expect(screen.queryByRole("switch", { name: "Push-уведомления на этом устройстве" })).toBeNull();
  });
});
