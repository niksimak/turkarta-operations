import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createQueryClient, routes } from "../app";
import { navIsActive } from "./Shell";
import { FakeEventSource, installFakeEventSource, jsonResponse, stubLocationAssign } from "../test/fakes";
import { resetApiStateForTests } from "../lib/api";

const operator = {
  id: 7,
  name: "Аня Смирнова",
  email: "anya@example.com",
  role: "support",
  is_lead: true,
  auto_assign_enabled: true,
  on_shift: false,
  last_active_at: null,
  last_assigned_at: null,
  prefs: { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" },
};

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

function renderShell(path = "/") {
  const client = createQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

const ok = (body: unknown) => () => jsonResponse(200, body);

describe("Shell", () => {
  beforeEach(() => {
    resetApiStateForTests();
    installFakeEventSource();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows views with counts, the operator and a heartbeat", async () => {
    const fetch = mockFetch({
      "GET /crm/api/me": ok(operator),
      "GET /crm/api/tickets?view=queue&limit=1": ok({ items: [], nextCursor: null, counts: { queue: 4, mine: 2, overdue: 1 } }),
      "POST /crm/api/me/heartbeat": ok({ ok: true }),
    });
    renderShell();
    expect(await screen.findByRole("link", { name: "Очередь: 4" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Мои: 2" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Просрочено: 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Очередь: 4" }).getAttribute("aria-current")).toBe("page");
    for (const name of ["Все", "Статистика", "Шаблоны", "Настройки"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    expect(screen.getByText("Аня Смирнова")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/crm/api/me/heartbeat", expect.anything()));
  });

  it("toggles the shift with an optimistic switch", async () => {
    let shiftBody = "";
    let server = { ...operator };
    mockFetch({
      "GET /crm/api/me": () => jsonResponse(200, server),
      "GET /crm/api/tickets?view=queue&limit=1": ok({ items: [], nextCursor: null, counts: { queue: 0, mine: 0, overdue: 0 } }),
      "POST /crm/api/me/heartbeat": ok({ ok: true }),
      "POST /crm/api/me/shift": (init) => {
        shiftBody = String(init.body);
        server = { ...server, on_shift: true };
        return jsonResponse(200, { ok: true });
      },
    });
    renderShell();
    const toggle = await screen.findByRole("switch", { name: "На смене" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(shiftBody).toBe('{"on":true}');
  });

  it("rolls the switch back and says so when the server refuses", async () => {
    mockFetch({
      "GET /crm/api/me": ok(operator),
      "GET /crm/api/tickets?view=queue&limit=1": ok({ items: [], nextCursor: null, counts: { queue: 0, mine: 0, overdue: 0 } }),
      "POST /crm/api/me/heartbeat": ok({ ok: true }),
      "POST /crm/api/me/shift": () => jsonResponse(500, { error: "internal" }),
    });
    renderShell();
    const toggle = await screen.findByRole("switch", { name: "На смене" });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("saves the theme choice to prefs and applies it", async () => {
    let prefsBody = "";
    let server = { ...operator };
    mockFetch({
      "GET /crm/api/me": () => jsonResponse(200, server),
      "GET /crm/api/tickets?view=queue&limit=1": ok({ items: [], nextCursor: null, counts: { queue: 0, mine: 0, overdue: 0 } }),
      "POST /crm/api/me/heartbeat": ok({ ok: true }),
      "PUT /crm/api/me/prefs": (init) => {
        prefsBody = String(init.body);
        server = { ...server, prefs: { ...server.prefs, theme: "dark" } };
        return jsonResponse(200, { ok: true });
      },
    });
    renderShell();
    fireEvent.click(await screen.findByRole("radio", { name: "Тёмная" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(prefsBody).toBe('{"theme":"dark"}');
  });

  it("shows the reconnect marker while the stream is down", async () => {
    mockFetch({
      "GET /crm/api/me": ok(operator),
      "GET /crm/api/tickets?view=queue&limit=1": ok({ items: [], nextCursor: null, counts: { queue: 0, mine: 0, overdue: 0 } }),
      "POST /crm/api/me/heartbeat": ok({ ok: true }),
    });
    renderShell();
    await screen.findByRole("switch", { name: "На смене" });
    act(() => FakeEventSource.latest().onerror?.());
    expect(screen.getByRole("status").textContent).toContain("Переподключение…");
  });

  it("sends a visitor without a session to login-failed", async () => {
    const location = stubLocationAssign();
    try {
      mockFetch({ "GET /crm/api/me": () => jsonResponse(401, { error: "unauthorized" }) });
      renderShell();
      await waitFor(() => expect(location.assign).toHaveBeenCalledWith("/crm/login-failed?reason=session"));
    } finally {
      location.restore();
    }
  });
});

describe("navIsActive", () => {
  it("keeps «Все» and «Просрочено» apart on /all", () => {
    expect(navIsActive("/all", "/all", "")).toBe(true);
    expect(navIsActive("/all", "/all", "?overdue=1")).toBe(false);
    expect(navIsActive("/all?overdue=1", "/all", "?overdue=1")).toBe(true);
    expect(navIsActive("/all?overdue=1", "/all", "")).toBe(false);
  });
  it("matches the queue only at the root and nested ticket paths under a view", () => {
    expect(navIsActive("/", "/", "")).toBe(true);
    expect(navIsActive("/", "/mine", "")).toBe(false);
    expect(navIsActive("/mine", "/mine/t/42", "")).toBe(true);
  });
});
