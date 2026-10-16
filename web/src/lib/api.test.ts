import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, json, LOGIN_FAILED_SESSION, resetApiStateForTests, shouldRetry } from "./api";
import { jsonResponse, stubLocationAssign } from "../test/fakes";

describe("api", () => {
  let location: ReturnType<typeof stubLocationAssign>;
  beforeEach(() => {
    resetApiStateForTests();
    location = stubLocationAssign();
  });
  afterEach(() => {
    location.restore();
    vi.unstubAllGlobals();
  });

  it("calls /crm/api with the CSRF header and same-origin cookies", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api<{ id: number }>("/me")).resolves.toEqual({ id: 1 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/crm/api/me");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("X-CRM")).toBe("1");
  });

  it("sends JSON bodies with a content type", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    await api("/me/shift", json("POST", { on: true }));
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"on":true}');
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("redirects to login-failed once, however many calls get 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => jsonResponse(401, { error: "unauthorized" })));
    const results = await Promise.allSettled([api("/me"), api("/tickets"), api("/me/heartbeat")]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      const err = (r as PromiseRejectedResult).reason as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(401);
      expect(err.body).toEqual({ error: "unauthorized" });
    }
    expect(location.assign).toHaveBeenCalledTimes(1);
    expect(location.assign).toHaveBeenCalledWith(LOGIN_FAILED_SESSION);
    expect(LOGIN_FAILED_SESSION).toBe("/crm/login-failed?reason=session");
  });

  it("throws ApiError with the parsed body on other failures, without redirecting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, { error: "taken", assignee: { id: 2 } })));
    const err = (await api("/tickets/1/take", json("POST")).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: "taken", assignee: { id: 2 } });
    expect(location.assign).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(api("/me/heartbeat", json("POST"))).resolves.toBeUndefined();
  });
});

describe("shouldRetry", () => {
  it("never retries client errors", () => {
    expect(shouldRetry(0, new ApiError(401, null))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, null))).toBe(false);
  });
  it("retries server and network errors twice", () => {
    expect(shouldRetry(0, new ApiError(502, null))).toBe(true);
    expect(shouldRetry(1, new TypeError("fetch failed"))).toBe(true);
    expect(shouldRetry(2, new TypeError("fetch failed"))).toBe(false);
  });
});
