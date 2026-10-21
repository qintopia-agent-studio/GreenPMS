import { describe, expect, it } from "vitest";
import { aggregateDashboardMoney, classifyDashboardMoney } from "@qintopia/domain";
import { dashboardMoneyDetail, type LoadedDashboardMoney } from "./dashboard-money";
import { paymentEvidenceTrace, type DashboardPaymentProof } from "./dashboard-payment-evidence";
import { operatingSaleDetail } from "./operating-sales";
import { summarizeDashboardToday } from "./dashboard-today";

const proof = (patch: Partial<DashboardPaymentProof> = {}): DashboardPaymentProof => ({ count: 1, verified: true,
  bill: { id: "bill", kind: "COLLECTION", reference: "wecom-receipt", transactionId: null,
    occurredAt: "2026-10-20T15:55:00Z", discoveredAt: "2026-10-20T16:05:00Z", updatedAt: "2026-10-21T10:00:00Z" }, ...patch });
const fact = (patch: Partial<LoadedDashboardMoney> = {}): LoadedDashboardMoney => ({ id: "receipt", date: "2026-10-21", currency: "CNY", netMinor: "5000",
  kind: "COLLECTION", commandType: "RECORD_COLLECTION", family: "STAY", linkedTransfer: false, transferSource: false,
  reclassifiedReversal: false, replacementCollection: false, correctsFact: false, deletionCorrection: false,
  orderId: "order", memberId: null, registeredAt: "2026-10-21T03:00:00Z", businessDate: null, paymentMethod: "WECOM", ...patch });

describe("经营登记原始支付证据", () => {
  it("真实分配来源保持同步时间、支付日期和业务登记日期分离", () => {
    const row = fact({ ...paymentEvidenceTrace({ paymentMethod: "WECOM" }, proof()) });
    expect(classifyDashboardMoney(row)).toBe("COLLECTION");
    expect(dashboardMoneyDetail(row)).toMatchObject({ claimStatus: "CONFIRMED", externalBillId: "bill", syncStatus: "WORKER_SYNCED", evidenceStatus: "COMPLETE",
      transactionReference: "wecom-receipt", registeredAt: "2026-10-21T03:00:00Z", sourceOccurredAt: "2026-10-20T15:55:00.000Z",
      sourceDiscoveredAt: "2026-10-20T16:05:00.000Z", sourceUpdatedAt: "2026-10-21T10:00:00.000Z" });
  });
  it("不能仅凭填了流水号就把企微来源当作完整凭据", () => {
    const row = fact({ transactionReference: "typed-reference", ...paymentEvidenceTrace({ paymentMethod: "WECOM", transactionReference: "typed-reference" }, proof({ count: 0, bill: null, verified: null })) });
    expect(dashboardMoneyDetail(row)).toMatchObject({ claimStatus: "PENDING_REVIEW", evidenceStatus: "MISSING", syncStatus: "UNKNOWN", transactionReference: "typed-reference" });
    expect(aggregateDashboardMoney([row], "CNY")).toEqual([{ currency: "CNY", collectedMinor: "0", refundedMinor: "0", correctedMinor: "0", netMinor: null, reviewCount: 1, reviewMinor: "5000" }]);
  });
  it("未核实企微原款及冲销共同待核对，不把冲销单独计成负金额", () => {
    const trace = paymentEvidenceTrace({ paymentMethod: "WECOM" }, proof({ count: 0, bill: null, verified: null }));
    const rows = [fact({ netMinor: "10000", ...trace }),
      fact({ id: "reversal", kind: "REVERSAL", commandType: "REVERSE_FACT", netMinor: "-10000", reversesFactId: "receipt", ...trace })];
    expect(rows.map(row => dashboardMoneyDetail(row).claimStatus)).toEqual(["PENDING_REVIEW", "PENDING_REVIEW"]);
    expect(aggregateDashboardMoney(rows, "CNY")[0]).toMatchObject({ collectedMinor: "0", correctedMinor: "0", netMinor: null, reviewCount: 2 });
    const today = summarizeDashboardToday("2026-10-21", "CNY", [], rows);
    expect(today.todayCollections).toEqual([{ currency: "CNY", amountMinor: "0", count: 0 }]);
    expect(today.todayCollectionReviewCount).toBe(2);
    expect(today.details.filter(row => row.claimStatus === "PENDING_REVIEW")).toHaveLength(2);
  });
  it.each([null, "REVERSAL"])("冲销原支付方式缺失（%s）不能默认凭据完整", paymentMethod => {
    const trace = paymentEvidenceTrace({ paymentMethod }, proof({ count: 0, bill: null, verified: null }));
    const row = fact({ id: "orphan-reversal", kind: "REVERSAL", commandType: "REVERSE_FACT", netMinor: "-10000", paymentMethod, ...trace });
    expect(dashboardMoneyDetail(row)).toMatchObject({ claimStatus: "PENDING_REVIEW", evidenceStatus: "MISSING", syncStatus: "UNKNOWN" });
    expect(summarizeDashboardToday("2026-10-21", "CNY", [], [row]).todayCollections).toEqual([{ currency: "CNY", amountMinor: "0", count: 0 }]);
  });
  it.each(["WECOM", "CASH"])("已核实 %s 原款与有效冲销仍按正负方向抵消", paymentMethod => {
    const trace = paymentEvidenceTrace({ paymentMethod }, paymentMethod === "WECOM" ? proof() : proof({ count: 0, bill: null, verified: null }));
    const rows = [fact({ paymentMethod, ...trace }), fact({ id: "reversal", kind: "REVERSAL", commandType: "REVERSE_FACT", netMinor: "-5000", paymentMethod, ...trace })];
    expect(aggregateDashboardMoney(rows, "CNY")[0]).toMatchObject({ collectedMinor: "5000", correctedMinor: "-5000", netMinor: "0", reviewCount: 0 });
    expect(summarizeDashboardToday("2026-10-21", "CNY", [], rows).todayCollections).toEqual([{ currency: "CNY", amountMinor: "0", count: 2 }]);
  });
  it.each([{ count: 2, verified: true }, { count: 1, verified: false }])("同步成功不代表凭据已核实 %o", patch => {
    const trace = paymentEvidenceTrace({ paymentMethod: "WECOM" }, proof(patch));
    expect(trace).toMatchObject({ syncStatus: "WORKER_SYNCED", evidenceStatus: "PARTIAL", registrationReview: true });
    if (patch.count === 2) expect(trace.externalBillId).toBeNull();
  });
  it.each(["CASH", "BANK_TRANSFER", "OTHER"])("人工 %s 正式事实不要求企微凭据", paymentMethod => {
    const row = fact({ paymentMethod, ...paymentEvidenceTrace({ paymentMethod }, proof({ count: 0, verified: null, bill: null })) });
    expect(dashboardMoneyDetail(row)).toMatchObject({ claimStatus: "CONFIRMED", evidenceStatus: "COMPLETE", syncStatus: "NOT_APPLICABLE" });
  });
  it("退款保留退款单号、原收款号和负项，内部划转不因没有直接账单变成待核对", () => {
    const receipt = proof().bill!;
    const row = fact({ kind: "REFUND", commandType: "RECORD_REFUND", netMinor: "-5000",
      ...paymentEvidenceTrace({ paymentMethod: "WECOM" }, proof({ bill: { ...receipt, kind: "REFUND", reference: "refund-reference", transactionId: "original-receipt" } })) });
    expect(dashboardMoneyDetail(row)).toMatchObject({ amountMinor: "-5000", refundReference: "refund-reference", originalTransactionReference: "original-receipt" });
    expect(classifyDashboardMoney(fact({ linkedTransfer: true, registrationReview: true }))).toBe("INTERNAL");
    expect(classifyDashboardMoney(fact({ kind: "REALLOCATION_IN", registrationReview: true }))).toBe("INTERNAL");
  });
  it("销售明细保留会员订单和原流水，封账不冒充住宿销售", () => {
    const row = fact({ family: "MEMBER", commandType: "RECORD_MEMBERSHIP_PAYMENT", memberId: "member", orderId: null, membershipOrderId: "membership-order",
      financialKind: "COLLECTION", ...paymentEvidenceTrace({ paymentMethod: "WECOM" }, proof()) });
    const event = { id: "MEMBER:receipt", source: "MEMBERSHIP" as const, date: "2026-10-21", currency: "CNY", kind: "SALE" as const, amountMinor: "5000", orderId: null, memberId: "member", registeredAt: row.registeredAt, reason: "confirmed" };
    expect(operatingSaleDetail(event, "TODAY_SALES", "sales", row)).toMatchObject({ sourceType: "MEMBERSHIP", membershipOrderId: "membership-order", externalBillId: "bill", sourceOccurredAt: "2026-10-20T15:55:00.000Z", businessDate: "2026-10-21" });
    expect(operatingSaleDetail({ ...event, source: "BASELINE", kind: "BASELINE", registeredAt: null }, "SALES", "sales")).toMatchObject({ sourceType: "BASELINE", sourceFactId: null, financialKind: "BASELINE", syncStatus: "NOT_APPLICABLE" });
  });
});
