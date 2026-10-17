import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { backoffDelay, onCrmEvent, STREAM_URL, useCrmStream, type CrmEvent } from "./sse";
import { FakeEventSource, installFakeEventSource } from "../test/fakes";

vi.mock("./api", () => ({ api: () => Promise.resolve(undefined) }));

describe("backoffDelay", () => {
  it("doubles from 1 s and caps at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("useCrmStream", () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.useFakeTimers();
    installFakeEventSource();
    client = new QueryClient();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers parsed events to the handler and to onCrmEvent listeners", () => {
    const seen: CrmEvent[] = [];
    const off = onCrmEvent((e) => seen.push(e));
    const handler = vi.fn();
    const { result } = renderHook(() => useCrmStream(handler), { wrapper });
    const es = FakeEventSource.latest();
    expect(es.url).toBe(STREAM_URL);
    act(() => es.onopen?.());
    expect(result.current).toEqual({ connected: true, reconnecting: false });
    act(() => es.emit("ticket.created", { id: "t1" }));
    expect(handler).toHaveBeenCalledWith({ type: "ticket.created", data: { id: "t1" } });
    expect(seen).toEqual([{ type: "ticket.created", data: { id: "t1" } }]);
    off();
  });

  it("reconnects with backoff and invalidates every query after reconnecting", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result, unmount } = renderHook(() => useCrmStream(() => undefined), { wrapper });
    const first = FakeEventSource.latest();
    act(() => first.onopen?.());
    expect(invalidate).not.toHaveBeenCalled();

    act(() => first.onerror?.());
    expect(first.closed).toBe(true);
    expect(result.current).toEqual({ connected: false, reconnecting: true });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second consecutive failure waits 2 s.
    const second = FakeEventSource.latest();
    act(() => second.onerror?.());
    act(() => vi.advanceTimersByTime(1_999));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    const third = FakeEventSource.latest();
    expect(FakeEventSource.instances).toHaveLength(3);

    act(() => third.onopen?.());
    expect(result.current).toEqual({ connected: true, reconnecting: false });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith();

    // A success resets the backoff to 1 s.
    act(() => third.onerror?.());
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(4);

    unmount();
    expect(FakeEventSource.latest().closed).toBe(true);
  });

  it("stops retrying after unmount", () => {
    const { unmount } = renderHook(() => useCrmStream(() => undefined), { wrapper });
    act(() => FakeEventSource.latest().onerror?.());
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
