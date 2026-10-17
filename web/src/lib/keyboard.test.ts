import { describe, expect, it } from "vitest";
import { createKeyMatcher, isShortcutBlocked } from "./keyboard";

function key(code: string, extra: Partial<{ key: string; target: EventTarget | null; timeStamp: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  return {
    code,
    key: extra.key ?? code.replace(/^Key/, "").toLowerCase(),
    target: extra.target ?? document.body,
    metaKey: extra.metaKey ?? false,
    ctrlKey: extra.ctrlKey ?? false,
    altKey: extra.altKey ?? false,
    shiftKey: extra.shiftKey ?? false,
    timeStamp: extra.timeStamp ?? 0,
  };
}

describe("createKeyMatcher", () => {
  it("maps j, k, Enter, a, e", () => {
    const m = createKeyMatcher();
    expect(m(key("KeyJ"))).toBe("next");
    expect(m(key("KeyK"))).toBe("prev");
    expect(m(key("Enter", { key: "Enter" }))).toBe("open");
    expect(m(key("KeyA"))).toBe("take");
    expect(m(key("KeyE"))).toBe("resolve");
  });

  it("works on the Russian layout by physical key", () => {
    const m = createKeyMatcher();
    expect(m(key("KeyJ", { key: "о" }))).toBe("next");
    expect(m(key("KeyE", { key: "у" }))).toBe("resolve");
  });

  it("switches views with g then q / m / a", () => {
    const m = createKeyMatcher();
    expect(m(key("KeyG", { timeStamp: 0 }))).toBeNull();
    expect(m(key("KeyQ", { timeStamp: 300 }))).toBe("goQueue");
    m(key("KeyG", { timeStamp: 1000 }));
    expect(m(key("KeyM", { timeStamp: 1200 }))).toBe("goMine");
    m(key("KeyG", { timeStamp: 2000 }));
    expect(m(key("KeyA", { timeStamp: 2100 }))).toBe("goAll");
  });

  it("forgets a stale g prefix, so a plain a takes", () => {
    const m = createKeyMatcher(1000);
    m(key("KeyG", { timeStamp: 0 }));
    expect(m(key("KeyA", { timeStamp: 1500 }))).toBe("take");
  });

  it("ignores modified keys", () => {
    const m = createKeyMatcher();
    expect(m(key("KeyJ", { metaKey: true }))).toBeNull();
    expect(m(key("KeyE", { ctrlKey: true }))).toBeNull();
    expect(m(key("KeyA", { shiftKey: true }))).toBeNull();
  });

  it("ignores keys typed into an editable region, nested or not", () => {
    const editor = document.createElement("div");
    const inner = document.createElement("span");
    editor.append(inner);
    // jsdom has no isContentEditable; browsers inherit it down the tree, so stub both.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    Object.defineProperty(inner, "isContentEditable", { value: true });
    const m = createKeyMatcher();
    expect(m(key("KeyJ", { target: editor }))).toBeNull();
    expect(m(key("KeyE", { target: inner }))).toBeNull();
  });

  it("ignores keys typed into inputs, menus and dialogs", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(input, textarea, menu);
    const m = createKeyMatcher();
    expect(m(key("KeyJ", { target: input }))).toBeNull();
    expect(m(key("KeyE", { target: textarea }))).toBeNull();
    expect(m(key("KeyJ", { target: item }))).toBeNull();
    expect(isShortcutBlocked(document.body)).toBe(false);
    input.remove();
    textarea.remove();
    menu.remove();
  });
});
