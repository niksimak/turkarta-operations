import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../app";
import { resetApiStateForTests } from "../lib/api";
import { canDeleteCanned } from "../lib/cannedReplies";
import { jsonResponse } from "../test/fakes";
import { Canned, timesWord } from "./Canned";

const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" };
const support = {
  id: 7, name: "Аня Смирнова", email: null, role: "support", is_lead: false, auto_assign_enabled: true,
  on_shift: true, last_active_at: null, last_assigned_at: null, prefs,
};
const stamp = "2026-10-15T09:00:00.000Z";
const replies = [
  { id: "a1", title: "Мой шаблон", body: "Здравствуйте, {имя}!", use_count: 3, created_by: 7, created_by_name: "Аня Смирнова", created_at: stamp, updated_at: stamp },
  { id: "b2", title: "Чужой шаблон", body: "Проверьте папку «Спам».", use_count: 12, created_by: 9, created_by_name: "Олег Петров", created_at: stamp, updated_at: stamp },
];

function renderCanned(me: typeof support) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${url}`;
      if (key === "GET /crm/api/me") return jsonResponse(200, me);
      if (key === "GET /crm/api/canned") return jsonResponse(200, replies);
      throw new Error(`unexpected ${key}`);
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/canned"]}>
        <Canned />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Canned replies page", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides «Удалить» on someone else's reply for a support operator", async () => {
    renderCanned(support);
    fireEvent.click(await screen.findByRole("button", { name: /Чужой шаблон/ }));
    expect(await screen.findByLabelText("Текст")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    // Editing stays open to everyone.
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Мой шаблон/ }));
    expect(await screen.findByRole("button", { name: "Удалить" })).toBeTruthy();
  });

  it("shows «Удалить» on any reply for a lead", async () => {
    renderCanned({ ...support, is_lead: true });
    fireEvent.click(await screen.findByRole("button", { name: /Чужой шаблон/ }));
    expect(await screen.findByRole("button", { name: "Удалить" })).toBeTruthy();
  });

  it("canDeleteCanned: author, admin or lead", () => {
    const other = { created_by: 9 };
    expect(canDeleteCanned(other, { id: 7, role: "support", is_lead: false })).toBe(false);
    expect(canDeleteCanned({ created_by: 7 }, { id: 7, role: "support", is_lead: false })).toBe(true);
    expect(canDeleteCanned(other, { id: 7, role: "admin", is_lead: false })).toBe(true);
    expect(canDeleteCanned({ created_by: null }, { id: 7, role: "support", is_lead: true })).toBe(true);
  });

  it("pluralises the use count", () => {
    expect([1, 2, 5, 11, 12, 22, 25, 104].map((n) => `${n} ${timesWord(n)}`)).toEqual([
      "1 раз", "2 раза", "5 раз", "11 раз", "12 раз", "22 раза", "25 раз", "104 раза",
    ]);
  });

  it("Ctrl/Cmd+Enter does not save an unchanged reply", async () => {
    renderCanned(support);
    fireEvent.click(await screen.findByRole("button", { name: /Мой шаблон/ }));
    const body = await screen.findByLabelText("Текст");
    fireEvent.keyDown(body, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    // Let a mutation, if one started, reach fetch.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("alert")).toBeNull();
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls;
    expect(calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});
