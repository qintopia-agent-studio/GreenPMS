import { describe, expect, it } from "vitest";
import { aggregateDashboardMoney, aggregateDashboardStays, classifyDashboardMoney, dashboardRange, dashboardSource, type DashboardMoneyFact } from "./dashboard-metrics.ts";
const fact = (id: string, netMinor: string, extra: Partial<DashboardMoneyFact> = {}): DashboardMoneyFact => ({ id, date: "2026-10-01", currency: "CNY", netMinor, kind: "COLLECTION", commandType: "RECORD_COLLECTION", family: "STAY", linkedTransfer: false, transferSource: false, reclassifiedReversal: false, replacementCollection: false, correctsFact: false, deletionCorrection: false, ...extra });
describe("dashboard definitions", () => {
  it("uses complete days across month/leap boundaries with equally long comparison", () => {
    expect(dashboardRange({ from: "2024-02-28", to: "2024-03-01" }, "2024-03-02")).toEqual({ range: { from: "2024-02-28", to: "2024-03-01" }, previousRange: { from: "2024-02-25", to: "2024-02-27" }, nights: 3 });
    expect(dashboardRange({}, "2026-10-01").range).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
  it.each([{ from: "2026-10-01" }, { from: "2026-09-30", to: "2026-10-01" }, { from: "2025-01-01", to: "2026-09-30" }, { from: "2026-02-30", to: "2026-03-01" }])("rejects invalid or incomplete historical ranges %j", query => expect(() => dashboardRange(query, "2026-10-01")).toThrow());
  it("separates free/member/channel sources", () => {
    const order = { stay_type: "TRANSIENT", member_id: null, member_contract_id: null, booking_channel_code: "CTRIP" };
    expect(dashboardSource(order)).toBe("CTRIP"); expect(dashboardSource({ ...order, member_id: "m" })).toBe("MEMBER"); expect(dashboardSource({ ...order, member_id: "m", stay_type: "FREE" })).toBe("FREE"); expect(dashboardSource({ ...order, booking_channel_code: null })).toBe("UNKNOWN");
  });
  it("counts split receipts once, excludes retained transfers and counts actual refund", () => {
    const rows = [fact("a", "40000"), fact("b", "60000"), fact("out", "-40000", { kind: "REALLOCATION_OUT" }), fact("in", "40000", { kind: "REALLOCATION_IN" }), fact("refund", "-20000", { kind: "REFUND", commandType: "REFUND_RETAINED_FUNDS" })];
    expect(aggregateDashboardMoney([...rows, rows[0]!], "CNY")[0]).toMatchObject({ collectedMinor: "100000", refundedMinor: "20000", correctedMinor: "0", netMinor: "80000" });
  });
  it("excludes linked stay-to-member pairs, keeping only true additional collection", () => {
    expect(aggregateDashboardMoney([fact("original", "50000"), fact("reverse", "-50000", { kind: "REVERSAL", linkedTransfer: true }), fact("member", "50000", { family: "MEMBER", linkedTransfer: true, transferSource: true }), fact("extra", "10000", { family: "MEMBER", commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" })], "CNY")[0]?.netMinor).toBe("60000");
  });
  it("keeps reconversion corrections separate from refunds and does not reuse wrong old receipts", () => {
    expect(aggregateDashboardMoney([fact("old-reverse", "-80000", { family: "MEMBER", kind: "REVERSAL", reclassifiedReversal: true }), fact("new", "10000", { family: "MEMBER", replacementCollection: true })], "CNY")[0]).toMatchObject({ collectedMinor: "10000", correctedMinor: "-80000", refundedMinor: "0", netMinor: "-70000" });
  });
  it("hides net for unidentified legacy facts and orphan transfers", () => {
    expect(classifyDashboardMoney(fact("orphan", "100", { transferSource: true }))).toBe("REVIEW");
    expect(aggregateDashboardMoney([fact("known", "100"), fact("unknown", "400", { commandType: null })], "CNY")[0]).toMatchObject({ collectedMinor: "100", netMinor: null, reviewCount: 1, reviewMinor: "400" });
  });
  it("uses unbounded integer money and isolates currencies", () => {
    expect(aggregateDashboardMoney([fact("a", "9007199254740993"), fact("b", "9007199254740993"), fact("c", "200", { currency: "USD" })], "CNY").map(row => row.netMinor)).toEqual(["18014398509481986", "200"]);
  });
  it("deduplicates order nights, separates free, preserves above-100 anomalies and null denominator", () => {
    const night = { orderId: "a", date: "2026-09-01", unitId: "room", building: "A", roomType: "shared", source: "MEMBER" as const, units: 4 };
    expect(aggregateDashboardStays([night, night, { ...night, orderId: "b", source: "FREE" }], 2, 0, "current")).toMatchObject({ paidUnitNights: 4, freeUnitNights: 4, occupancyRate: 200 });
    expect(aggregateDashboardStays([night], 0, 0, "").occupancyRate).toBeNull(); expect(aggregateDashboardStays([night], 5, 1, "").occupancyRate).toBeNull(); expect(aggregateDashboardStays([night], null, 0, "").occupancyRate).toBeNull();
  });
});
