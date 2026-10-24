import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("requests the shared workbench API with encoded cursor, limit, credentials and cancellation signal", async () => {
  const { api } = await import("./api");
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ totalOrders: 17 }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  expect(await api.workbenchExceptions({ propertyId: "sample & property", afterId: "order / 5", limit: 50 }, controller.signal)).toEqual({ totalOrders: 17 });
  expect(fetch).toHaveBeenCalledWith("/api/v1/workbench/exceptions?propertyId=sample+%26+property&afterId=order+%2F+5&limit=50", expect.objectContaining({ credentials: "include", signal: controller.signal }));
});
