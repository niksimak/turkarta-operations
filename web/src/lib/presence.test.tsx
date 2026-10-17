import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { prunePresence, resetPresenceForTests, setPresence, usePresence } from "./presence";

const oleg = { operatorId: 9, name: "Олег", state: "viewing" as const };
const me = { operatorId: 7, name: "Аня", state: "viewing" as const };

describe("presence store", () => {
  afterEach(() => {
    cleanup();
    resetPresenceForTests();
  });

  it("re-renders a ticket's subscriber only when that ticket's viewers change", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePresence("t-1", 7);
    });
    const base = renders;
    act(() => setPresence("t-2", [oleg]));
    expect(renders).toBe(base);
    act(() => setPresence("t-1", [oleg, me]));
    expect(renders).toBe(base + 1);
    expect(result.current).toEqual([oleg]);
    act(() => setPresence("t-1", [{ ...oleg }, { ...me }]));
    expect(renders).toBe(base + 1);
    act(() => setPresence("t-1", [{ ...oleg, state: "typing" }, me]));
    expect(renders).toBe(base + 2);
    expect(result.current[0]!.state).toBe("typing");
  });

  it("keeps a repeated ping alive and drops a silent ticket after the TTL", () => {
    const { result } = renderHook(() => usePresence("t-1", undefined));
    act(() => setPresence("t-1", [oleg], 0));
    act(() => setPresence("t-1", [oleg], 10_000));
    act(() => prunePresence(15_000));
    expect(result.current).toEqual([oleg]);
    act(() => prunePresence(23_000));
    expect(result.current).toEqual([]);
  });
});
