import { describe, expect, it } from "vitest";
import { createDashboardRequestScope, money } from "./dashboard-state.ts";
describe("dashboard requests", () => {
  it("does not abort the deduplicated request on StrictMode effect remount", async () => {
    const scope = createDashboardRequestScope();
    const signal = scope.begin("a"); const unmount = scope.activate("a");
    unmount(); const finalUnmount = scope.activate("a");
    await Promise.resolve(); expect(signal.aborted).toBe(false);
    finalUnmount(); await Promise.resolve(); expect(signal.aborted).toBe(true);
  });
  it("cancels the old property/filter without aborting a new request created before cleanup", async () => {
    const scope = createDashboardRequestScope();
    const oldSignal = scope.begin("a"), cleanup = scope.activate("a");
    const nextSignal = scope.begin("b"); cleanup(); scope.activate("b");
    await Promise.resolve(); expect(oldSignal.aborted).toBe(true); expect(nextSignal.aborted).toBe(false);
  });
  it("replaces only a request for the same key", () => {
    const scope = createDashboardRequestScope(); const a = scope.begin("a"), b = scope.begin("b"); scope.begin("a");
    expect(a.aborted).toBe(true); expect(b.aborted).toBe(false);
  });
  it("formats integer money without floating point loss and preserves unavailable values", () => {
    expect(money("9007199254740993")).toBe("¥90,071,992,547,409.93"); expect(money(null)).toBe("—"); expect(money("-1")).toBe("¥−0.01");
  });
});
