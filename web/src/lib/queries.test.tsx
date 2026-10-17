import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { HEARTBEAT_MS, useHeartbeat } from "./queries";
import { jsonResponse } from "../test/fakes";

describe("useHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("beats every 60 s while the tab is open, hidden or not", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetch = vi.fn(async (_url: string) => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = renderHook(() => useHeartbeat(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/crm/api/me/heartbeat");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    unmount();
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does nothing until the operator is loaded", () => {
    const fetch = vi.fn(async (_url: string) => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    renderHook(() => useHeartbeat(false));
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
