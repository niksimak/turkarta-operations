import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../app";
import { resetApiStateForTests } from "../lib/api";
import { jsonResponse } from "../test/fakes";
import { Toaster } from "./Toast";
import { TopicsSection } from "./TopicsSection";

const prefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" } as const;
const base = { email: null, auto_assign_enabled: true, on_shift: true, last_active_at: null, last_assigned_at: null, prefs };
const lead = { ...base, id: 10, name: "Лена", role: "support", is_lead: true } as const;
const support = { ...base, id: 7, name: "Аня", role: "support", is_lead: false } as const;
const list = [
  { id: 1, name: "Пополнение не пришло", position: 1, archived: false },
  { id: 2, name: "Карта отклонена", position: 2, archived: false },
  { id: 3, name: "Старая", position: 3, archived: true },
];

function setup(me: typeof lead | typeof support, onWrite?: (key: string, body: unknown) => Response) {
  const calls: Array<[string, unknown]> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    if (key === "GET /crm/api/topics") return jsonResponse(200, list);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push([key, body]);
    return onWrite ? onWrite(key, body) : jsonResponse(200, { ...list[0], ...body });
  }));
  render(<QueryClientProvider client={createQueryClient()}><TopicsSection me={me as never} /><Toaster /></QueryClientProvider>);
  return calls;
}

describe("TopicsSection", () => {
  beforeEach(() => resetApiStateForTests());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("lets a lead add, reorder and archive", async () => {
    const calls = setup(lead);
    await screen.findByText("Пополнение не пришло");
    fireEvent.change(screen.getByPlaceholderText("Новая тема"), { target: { value: "Комиссия" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Ниже" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "В архив" })[1]!);
    await waitFor(() => expect(calls).toEqual([
      ["POST /crm/api/topics", { name: "Комиссия" }],
      ["PUT /crm/api/topics/1", { position: 2 }],
      ["PUT /crm/api/topics/2", { position: 1 }],
      ["PUT /crm/api/topics/2", { archived: true }],
    ]));
    expect(screen.getByText("Старая")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeTruthy();
  });

  it("shows a duplicate name as a toast", async () => {
    setup(lead, () => jsonResponse(422, { error: "validation", fields: { name: "duplicate" } }));
    await screen.findByText("Пополнение не пришло");
    fireEvent.change(screen.getByPlaceholderText("Новая тема"), { target: { value: "карта отклонена" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Такая тема уже есть.")).toBeTruthy();
  });

  it("is read-only for a plain operator", async () => {
    setup(support);
    await screen.findByText("Пополнение не пришло");
    expect(screen.queryByPlaceholderText("Новая тема")).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
  });
});
