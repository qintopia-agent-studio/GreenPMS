import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("business request session invalidation", () => {
  it.each(["CHECK_OUT", undefined, "", null, "PREVIEW:CHECK_OUT"])("preserves recovery command identity %s without inventing or sanitizing it", async (commandType) => {
    const { api } = await import("./api");
    const receipt = { receiptId: "receipt_test", commandId: "command_test",
      ...(commandType !== undefined ? { commandType } : {}), executionStatus: "EXECUTED", businessCommitted: true,
      correlationId: "test", result: { orderId: "order_test", status: "CHECKED_OUT" }, resourceRefs: ["order_test"], factRefs: [] };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json(receipt))));
    expect(await api.commandResult("p", "CHECK_OUT", "original-confirm-key")).toEqual(receipt);
    expect(await api.resolveCommandResult("p", "CHECK_OUT", "original-confirm-key")).toEqual(receipt);
  });
  it.each([
    { protocolVersion: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT", recoveryMode: "HISTORICAL_READ_ONLY" },
    { protocolVersion: "UNKNOWN_PROTOCOL", recoveryMode: "HISTORICAL_READ_ONLY" },
    { protocolVersion: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT" },
    { recoveryMode: "HISTORICAL_READ_ONLY" },
    { protocolVersion: null, recoveryMode: "" },
    { unexpected: "must reach the strict receipt validator" }
  ])("preserves protocol metadata and unknown fields for downstream validation: %j", async (metadata) => {
    const { api } = await import("./api");
    const receipt = { receiptId: "receipt_test", commandId: "command_test",
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", executionStatus: "EXECUTED", businessCommitted: true,
      correlationId: "test", result: { orderId: "order_test" }, resourceRefs: ["order_test"], factRefs: [],
      committedAt: "2026-11-08T08:00:00.000Z", ...metadata };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json(receipt))));
    expect(await api.commandResult("p", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", "original-confirm-key")).toEqual(receipt);
    expect(await api.resolveCommandResult("p", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", "original-confirm-key")).toEqual(receipt);
  });
  it("still normalizes a minimal unknown result without inventing command identity", async () => {
    const { api } = await import("./api");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json({ executionStatus: "UNKNOWN", businessCommitted: false }))));
    const expected = { receiptId: "", commandId: "", executionStatus: "UNKNOWN", businessCommitted: false,
      correlationId: "", resourceRefs: [], factRefs: [] };
    expect(await api.commandResult("p", "EXTEND_STAY", "original-confirm-key")).toEqual(expected);
    expect(await api.resolveCommandResult("p", "EXTEND_STAY", "original-confirm-key")).toEqual(expected);
  });
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
