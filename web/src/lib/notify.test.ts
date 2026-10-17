import { describe, expect, it, vi } from "vitest";
import { handleNotify, shouldNotify, type NotifyEvent } from "./notify";
import type { OperatorPrefs } from "./queries";

const prefs: OperatorPrefs = { theme: "system", sound: true, volume: 0.6, desktop: true, notify_scope: "all", send_key: "mod_enter" };
const me = (p: Partial<OperatorPrefs> = {}) => ({ id: 7, prefs: { ...prefs, ...p } });
const event = (e: Partial<NotifyEvent> = {}): NotifyEvent => ({
  operatorId: null,
  kind: "new_ticket",
  ticketId: "t-1",
  title: "Новое обращение",
  body: "Иван: не пришёл код",
  ...e,
});

function deps(hidden: boolean, permission = "granted") {
  return {
    toast: vi.fn(),
    open: vi.fn(),
    blip: vi.fn(),
    showDesktop: vi.fn(),
    hidden: () => hidden,
    permission: () => permission,
  };
}

describe("shouldNotify", () => {
  it("takes broadcasts and my own events, drops a colleague's", () => {
    expect(shouldNotify(event(), me())).toBe(true);
    expect(shouldNotify(event({ operatorId: 7, kind: "assigned" }), me())).toBe(true);
    expect(shouldNotify(event({ operatorId: 8, kind: "assigned" }), me())).toBe(false);
  });

  it("drops new tickets when the scope is mine", () => {
    expect(shouldNotify(event(), me({ notify_scope: "mine" }))).toBe(false);
    expect(shouldNotify(event({ operatorId: 7, kind: "mention" }), me({ notify_scope: "mine" }))).toBe(true);
  });

  it("a reply reminder reaches the assignee; an unassigned one only those watching «Все» (same rule as push)", () => {
    expect(shouldNotify(event({ operatorId: 7, kind: "reminder" }), me({ notify_scope: "mine" }))).toBe(true);
    expect(shouldNotify(event({ operatorId: 8, kind: "reminder" }), me())).toBe(false);
    expect(shouldNotify(event({ operatorId: null, kind: "reminder" }), me())).toBe(true);
    expect(shouldNotify(event({ operatorId: null, kind: "reminder" }), me({ notify_scope: "mine" }))).toBe(false);
  });
});

describe("handleNotify", () => {
  it("plays the blip at the operator's volume", () => {
    const d = deps(false);
    handleNotify(event(), me({ volume: 0.3 }), d);
    expect(d.blip).toHaveBeenCalledWith(0.3);
  });

  it("stays silent with sound off", () => {
    const d = deps(false);
    handleNotify(event(), me({ sound: false }), d);
    expect(d.blip).not.toHaveBeenCalled();
  });

  it("shows a browser notification only when hidden, granted and wanted", () => {
    const hidden = deps(true);
    handleNotify(event(), me(), hidden);
    expect(hidden.showDesktop).toHaveBeenCalledWith("Новое обращение", "Иван: не пришёл код", "crm-new_ticket-t-1", expect.any(Function));

    const visible = deps(false);
    handleNotify(event(), me(), visible);
    expect(visible.showDesktop).not.toHaveBeenCalled();

    const denied = deps(true, "denied");
    handleNotify(event(), me(), denied);
    expect(denied.showDesktop).not.toHaveBeenCalled();

    const off = deps(true);
    handleNotify(event(), me({ desktop: false }), off);
    expect(off.showDesktop).not.toHaveBeenCalled();
  });

  it("toasts personal events in a visible tab, not new tickets", () => {
    const d = deps(false);
    handleNotify(event({ operatorId: 7, kind: "assigned", title: "Вам назначено: Иван" }), me(), d);
    expect(d.toast).toHaveBeenCalledWith("Вам назначено: Иван", "Иван: не пришёл код", "notify-t-1", expect.any(Function));
    const q = deps(false);
    handleNotify(event(), me(), q);
    expect(q.toast).not.toHaveBeenCalled();
  });

  it("does nothing for a scope-filtered new ticket", () => {
    const d = deps(true);
    handleNotify(event(), me({ notify_scope: "mine" }), d);
    expect(d.blip).not.toHaveBeenCalled();
    expect(d.showDesktop).not.toHaveBeenCalled();
  });

  it("opens the ticket from the notification", () => {
    const d = deps(true);
    handleNotify(event({ ticketId: "t-9" }), me(), d);
    const onClick = d.showDesktop.mock.calls[0]![3] as () => void;
    onClick();
    expect(d.open).toHaveBeenCalledWith("t-9");
  });
});
