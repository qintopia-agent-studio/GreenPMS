import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("funds exception read API", () => {
  it("passes cursor/query/signal without lodging date or beforeId and preserves disabled history and authoritative total", async () => {
    const { api } = await import("./api");
    const history = { enabled: false, items: [{ id: "historical" }], total: 102, nextCursor: "next/+=" };
    const fetch = vi.fn().mockResolvedValue(response(history)); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await api.workbenchFundsExceptions({ propertyId: "p", query: "原单 & 123", cursor: "opaque/+=", limit: "25" }, controller.signal)).toEqual(history);
    const [path, init] = fetch.mock.calls[0]!;
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/api/v2/workbench-funds-exceptions");
    expect(Object.fromEntries(url.searchParams)).toEqual({ propertyId: "p", query: "原单 & 123", cursor: "opaque/+=", limit: "25" });
    expect(init.signal).toBe(controller.signal);
    expect(init.credentials).toBe("include");
  });
  it("propagates a read failure rather than synthesizing zero pending money", async () => {
    const { api } = await import("./api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "unavailable" }, 503)));
    await expect(api.workbenchFundsExceptions({ propertyId: "p" })).rejects.toMatchObject({ status: 503 });
  });
});
