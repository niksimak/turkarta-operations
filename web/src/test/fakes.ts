import { vi } from "vitest";

/** Minimal EventSource double: tests drive open/error/message by hand. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private handlers = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource opened");
    return last;
  }
}

export function installFakeEventSource() {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Replaces window.location with a stub whose assign() is a spy. */
export function stubLocationAssign() {
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign },
  });
  return {
    assign,
    restore: () => Object.defineProperty(window, "location", { configurable: true, value: original }),
  };
}
