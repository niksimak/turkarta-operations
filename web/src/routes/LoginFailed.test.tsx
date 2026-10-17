import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ADMIN_SUPPORT_URL, LOGIN_FAILED_COPY, LoginFailed } from "./LoginFailed";

function renderAt(search: string) {
  const router = createMemoryRouter([{ path: "/login-failed", element: <LoginFailed /> }], {
    initialEntries: [`/login-failed${search}`],
  });
  return render(<RouterProvider router={router} />);
}

afterEach(cleanup);

describe("LoginFailed", () => {
  const reasons = ["malformed", "signature", "expired", "role", "replay", "disabled", "session", "logout"];

  it.each(reasons)("explains %s and offers the admin login", (reason) => {
    renderAt(`?reason=${reason}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(LOGIN_FAILED_COPY[reason]);
    const link = screen.getByRole("link", { name: "Войти через админку" });
    expect(link.getAttribute("href")).toBe(ADMIN_SUPPORT_URL);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("has distinct copy for every reason, free of em-dashes", () => {
    const lines = reasons.map((r) => LOGIN_FAILED_COPY[r]);
    expect(new Set(lines).size).toBe(reasons.length);
    for (const line of lines) expect(line).not.toMatch(/[—–]/);
  });

  it("says what to do when SSO is not configured, and confirms a logout", () => {
    expect(LOGIN_FAILED_COPY.disabled).toBe("Вход в CRM не настроен. Напишите администратору.");
    expect(LOGIN_FAILED_COPY.logout).toBe("Вы вышли.");
  });

  it("carries the original CRM path to the admin login", () => {
    renderAt(`?reason=session&next=${encodeURIComponent("/crm/t/7c1e-ab")}`);
    expect(screen.getByRole("link", { name: "Войти через админку" }).getAttribute("href")).toBe(
      `${ADMIN_SUPPORT_URL}?next=%2Fcrm%2Ft%2F7c1e-ab`,
    );
    cleanup();
    renderAt(`?reason=session&next=${encodeURIComponent("https://evil.example/crm")}`);
    expect(screen.getByRole("link", { name: "Войти через админку" }).getAttribute("href")).toBe(ADMIN_SUPPORT_URL);
  });

  it("falls back for an unknown or missing reason", () => {
    renderAt("?reason=toString");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Не удалось войти.");
    cleanup();
    renderAt("");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Не удалось войти.");
  });

  it("points at the Turkarta admin", () => {
    expect(ADMIN_SUPPORT_URL).toBe("https://api.turkarta.me/admin/support-crm");
  });
});
