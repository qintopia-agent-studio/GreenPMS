import { describe, expect, it } from "vitest";
import { summarizeUnclaimedPayments, unclaimedPaymentDetails, type DashboardUnclaimedBill } from "./dashboard-unclaimed-payments";
import { summarizeDashboardToday } from "./dashboard-today";

const bill = (patch: Partial<DashboardUnclaimedBill> = {}): DashboardUnclaimedBill => ({ id: "bill", date: "2026-10-21", kind: "COLLECTION", reference: "receipt",
  originalTransactionReference: null, amountMinor: "10000", allocatedMinor: "0", legacyClaimedMinor: "0", memberClaimed: false,
  state: "SUCCESS", needsReview: false, duplicate: false, matchingEligible: true,
  occurredAt: "2026-10-20T15:55:00Z", discoveredAt: "2026-10-20T16:05:00Z", updatedAt: "2026-10-21T08:00:00Z", ...patch });

describe("未认领的企微收退款", () => {
  it("首次同步日显示待认领，既不回填交易日也不加入已确认合计", () => {
    const details = unclaimedPaymentDetails([bill()]);
    expect(details[0]).toMatchObject({ date: "2026-10-21", amountMinor: "10000", claimStatus: "UNCLAIMED", sourceType: "WECOM", externalBillId: "bill",
      businessDate: null, registeredAt: "2026-10-20T16:05:00.000Z", sourceOccurredAt: "2026-10-20T15:55:00.000Z" });
    const result = summarizeDashboardToday("2026-10-21", "CNY", [], [], details);
    expect(result.todayCollections).toEqual([{ currency: "CNY", amountMinor: "0", count: 0 }]);
    expect(result.todayUnclaimed).toEqual([{ currency: "CNY", amountMinor: "10000", count: 1 }]);
    expect(result.details).toMatchObject([{ metric: "TODAY_COLLECTIONS", claimStatus: "UNCLAIMED" }]);
    expect(summarizeDashboardToday("2026-10-20", "CNY", [], [], details).todayUnclaimed[0]?.count).toBe(0);
  });
  it("多单分配只展示剩余份额，退款按负项显示且不重复原收款", () => {
    const details = unclaimedPaymentDetails([bill({ allocatedMinor: "6500" }), bill({ id: "refund", kind: "REFUND", reference: "refund", originalTransactionReference: "receipt", amountMinor: "2000", allocatedMinor: "500" })]);
    expect(details.map(row => row.amountMinor)).toEqual(["3500", "-1500"]);
    expect(details[1]).toMatchObject({ refundReference: "refund", originalTransactionReference: "receipt", transactionReference: "receipt" });
    expect(summarizeUnclaimedPayments(details, "CNY")).toEqual([{ currency: "CNY", amountMinor: "2000", count: 2 }]);
  });
  it("释放分配后仅剩余份额重新待认领，旧匹配和会员整笔归属不重复展示", () => {
    expect(unclaimedPaymentDetails([bill({ allocatedMinor: "10000" })])).toEqual([]);
    expect(unclaimedPaymentDetails([bill({ legacyClaimedMinor: "10000" })])).toEqual([]);
    expect(unclaimedPaymentDetails([bill({ memberClaimed: true })])).toEqual([]);
    expect(unclaimedPaymentDetails([bill({ allocatedMinor: "3000" })])[0]?.amountMinor).toBe("7000");
  });
  it.each([{ needsReview: true }, { duplicate: true }, { matchingEligible: false }, { state: "PENDING" }, { amountMinor: null }, { allocatedMinor: "11000" }])("未核实来源仅供核对 %o", patch => {
    const details = unclaimedPaymentDetails([bill(patch)]);
    expect(details).toHaveLength(1);
    expect(details[0]?.claimStatus).toBe("PENDING_REVIEW");
    const result = summarizeDashboardToday("2026-10-21", "CNY", [], [], details);
    expect(result.todayUnclaimed).toEqual([{ currency: "CNY", amountMinor: "0", count: 0 }]);
    expect(result.todayCollectionReviewCount).toBe(1);
  });
  it("重复返回只计一次，已关闭来源不形成待认领", () => {
    expect(unclaimedPaymentDetails([bill(), bill()])).toHaveLength(1);
    expect(unclaimedPaymentDetails([bill({ state: "CLOSED" })])).toEqual([]);
  });
});
