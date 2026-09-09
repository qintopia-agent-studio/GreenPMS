import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("business request session invalidation", () => {
  it("notifies once on 401 even with malformed JSON and stops further business requests", async () => {
    const { api, onSessionExpired } = await import("./api");
    const fetch = vi.fn().mockResolvedValue(new Response("broken", { status: 401, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const expired = vi.fn(); const unsubscribe = onSessionExpired(expired);
    await expect(api.orders("p")).rejects.toThrow();
    await expect(api.meta()).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it.each([403, 503])("keeps %i separate from an expired session", async (status) => {
    const { api, onSessionExpired } = await import("./api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, status)));
    const expired = vi.fn(); const unsubscribe = onSessionExpired(expired);
    await expect(api.orders("p")).rejects.toMatchObject({ status });
    expect(expired).not.toHaveBeenCalled();
    unsubscribe();
  });
  it.each([200, 401])("ignores an old session's late %i after login without treating a write as known failed", async (status) => {
    const { api, ApiError, onSessionExpired } = await import("./api");
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ subjectId: "new-account" })));
    const expired = vi.fn(); const unsubscribe = onSessionExpired(expired);
    const old = api.orders("p").catch((error: unknown) => error);
    expect(await api.login("new", "password")).toEqual({ subjectId: "new-account" });
    finish(json({}, status));
    const error = await old;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("relogin obtains fresh permissions and allows new reads", async () => {
    const { api } = await import("./api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ propertyAccess: { p: "READ" } }))
      .mockResolvedValueOnce(json({ orders: [] })));
    await expect(api.orders("p")).rejects.toMatchObject({ status: 401 });
    expect(await api.login("reader", "password")).toEqual({ propertyAccess: { p: "READ" } });
    expect(await api.orders("p")).toEqual({ orders: [] });
  });
});
