import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { PaymentReconciliationResponse } from "@qintopia/contracts";
import { PaymentReconciliationQueue, reconciliationMoney, type PaymentReconciliationState } from "./paymentReconciliation";
const totals = { externalMinor: "100000", businessMinor: "0", unassignedMinor: "100000", excessMinor: "0", unbackedMinor: "0", unknownCount: 0 };
function response(): PaymentReconciliationResponse {
  return { propertyId: "property-1", asOf: "2026-11-06T08:00:00Z", sync: { enabled: true, lastSyncedAt: "2026-11-06T08:00:00Z", hasError: false }, summary: { collections: totals, refunds: totals }, totalItems: 2, nextCursor: null,
    items: ["COLLECTION", "REFUND"].map((kind, index) => ({ id: String(index), kind: kind as "COLLECTION" | "REFUND", billId: String(index), factId: null, orderId: null, orderIds: [], membershipOrderId: null, reference: `ref-${index}`, originalTransactionReference: "original", nickname: "测试付款人", currency: "CNY", amountMinor: 100000, allocatedMinor: "0", businessMinor: "0", unassignedMinor: "100000", excessMinor: "0", occurredAt: "2026-10-01T08:00:00Z", discoveredAt: "2026-11-05T08:00:00Z", issues: [{ code: "UNASSIGNED", message: "尚未关联业务" }] })) };
}
function render(state: PaymentReconciliationState) {
  return renderToStaticMarkup(<MemoryRouter><PaymentReconciliationQueue state={state} kind="ALL" setKind={() => {}} retry={() => {}} firstPage={() => {}} nextPage={() => {}} hasPrevious={false} /></MemoryRouter>);
}
describe("persistent reconciliation queue", () => {
  it("keeps zero-net missed collections and refunds separate across business dates", () => {
    const html = render({ loading: false, data: response() });
    expect(html).toContain('aria-label="收款核对汇总"'); expect(html).toContain('aria-label="退款核对汇总"');
    expect(html).toContain("ref-0"); expect(html).toContain("ref-1"); expect(html).toContain("共 2 笔需要处理");
    expect(html).toContain('href="/orders"'); expect(html).not.toContain("没有需要处理的记录");
  });
  it.each(["disabled", "never-synced", "delayed", "error"])("does not declare all payments reconciled when sync is %s", mode => {
    const data = response(); data.items = []; data.totalItems = 0;
    if (mode === "disabled") data.sync.enabled = false;
    if (mode === "never-synced") data.sync.lastSyncedAt = null;
    if (mode === "delayed") data.sync.lastSyncedAt = "2026-11-05T08:00:00Z";
    if (mode === "error") data.sync.hasError = true;
    const html = render({ loading: false, data });
    expect(html).toContain("暂时不能确认账目都已对上"); expect(html).toContain("已经读到的记录里，暂未发现需要处理的事项");
    expect(html.indexOf("暂时不能确认账目都已对上")).toBeLessThan(html.indexOf("<details"));
  });
  it("does not confuse a failed read with an empty queue", () => {
    const html = render({ loading: false, error: new Error("SQL_MOCK_INTERNAL_MESSAGE") });
    expect(html).toContain("还不能确认是否有漏记"); expect(html).toContain("重新读取"); expect(html).not.toContain("没有需要处理的记录");
    expect(html).not.toContain("SQL_MOCK_INTERNAL_MESSAGE");
  });
  it("links a known order to its refund entry instead of guessing ownership", () => {
    const data = response(); data.items[1]!.orderIds = ["order-1"];
    expect(render({ loading: false, data })).toContain('/orders/order-1?action=RECORD_REFUND');
  });
  it("labels orphan business facts in their own currency without changing CNY gross totals", () => {
    const data = response(); data.items[0]!.currency = "USD"; data.items[0]!.amountMinor = null; data.items[0]!.businessMinor = "12345";
    const html = render({ loading: false, data });
    expect(html).toContain("订单已记 USD 123.45"); expect(html).toContain("¥1,000.00");
  });
  it("formats integer-cent totals beyond safe Number range without rounding", () => {
    expect(reconciliationMoney("9007199254740993")).toBe("¥90,071,992,547,409.93");
    expect(reconciliationMoney("-1")).toBe("−¥0.01"); expect(reconciliationMoney("unknown")).toBe("待核对");
  });
});
