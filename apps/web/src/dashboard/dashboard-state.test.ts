import { describe, expect, it } from "vitest";
import { createDashboardRequestScope, dashboardPresetRange, money } from "./dashboard-state.ts";
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

describe("dashboard presets", () => {
  it("does not construct a reversed month range on the first day", () => {
    expect(dashboardPresetRange("month", "2026-11-01")).toBeNull();
    expect(dashboardPresetRange("month", "2026-01-01")).toBeNull();
  });
  it("keeps month-to-yesterday and rolling windows exact including leap days", () => {
    expect(dashboardPresetRange("month", "2026-10-11")).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    expect(dashboardPresetRange("month", "2028-03-02")).toEqual({ from: "2028-03-01", to: "2028-03-01" });
    expect(dashboardPresetRange("7", "2028-03-01")).toEqual({ from: "2028-02-23", to: "2028-02-29" });
  });
});
