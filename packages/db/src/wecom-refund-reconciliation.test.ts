import { describe, expect, it } from "vitest";
import { parseRefundReconciliation, refundReconciliationReserveSafe } from "./wecom-refund-reconciliation.ts";

describe("成组补登记的剩余退款资金保护", () => {
  it("允许全额退款按 A400/B600 逐单补齐，不新增可用净款", () => {
    expect(refundReconciliationReserveSafe(100000n, 100000n, 40000n, 40000n)).toBe(true);
    expect(refundReconciliationReserveSafe(60000n, 60000n, 60000n, 60000n)).toBe(true);
  });
  it("部分退款后的新净款不能挤占其他未归属退款", () => {
    expect(refundReconciliationReserveSafe(100000n, 80000n, 60000n, 40000n)).toBe(true);
    expect(refundReconciliationReserveSafe(100000n, 80000n, 60000n, 30000n)).toBe(false);
    expect(refundReconciliationReserveSafe(10000n, 30000n, 10000n, 10000n)).toBe(true);
    expect(refundReconciliationReserveSafe(10000n, 30000n, 10000n, 9000n)).toBe(false);
  });
  it("拒绝超分配、超退及无真实退款的绕过", () => {
    expect(refundReconciliationReserveSafe(100n, 100n, 101n, 101n)).toBe(false);
    expect(refundReconciliationReserveSafe(100n, 100n, 100n, 101n)).toBe(false);
    expect(refundReconciliationReserveSafe(100n, 0n, 100n, 0n)).toBe(false);
  });
  it("拒绝重复退款和单笔旧参数混入成组结构", () => {
    const source = { externalPaymentBillId: "c", amountMinor: 100 };
    const refund = { externalPaymentBillId: "r", amountMinor: 50 };
    expect(() => parseRefundReconciliation({ source, refunds: [refund, refund], note: "核对" })).toThrow(/重复/);
    expect(() => parseRefundReconciliation({ source, refunds: [refund], note: "核对", amountMinor: 50 })).toThrow(/字段/);
  });
});
