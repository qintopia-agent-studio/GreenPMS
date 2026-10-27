import { describe, expect, it } from "vitest";
import {
  HISTORICAL_RECONCILIATION_PLAN_ID,
  calculatePlanSha256,
  validateFixedPlan,
  type HistoricalPaymentPlan
} from "./historical-payment-reconciliation.ts";

function plan(): HistoricalPaymentPlan {
  const base = {
    planId: HISTORICAL_RECONCILIATION_PLAN_ID as typeof HISTORICAL_RECONCILIATION_PLAN_ID,
    propertyId: "property-1",
    orders: [
      { key: "303" as const, orderId: "order-303", expectedVersion: 3, expectedCurrentContractAmountMinor: 18000, targetCurrentContractAmountMinor: 18000 as const, originalFactId: "fact-303", originalAmountMinor: 36000 as const, billKey: "xiaonian" as const },
      { key: "306" as const, orderId: "order-306", expectedVersion: 2, expectedCurrentContractAmountMinor: 18000, targetCurrentContractAmountMinor: 18000 as const, originalFactId: null, originalAmountMinor: 0 as const, billKey: "xiaonian" as const },
      { key: "D03" as const, orderId: "order-d03", expectedVersion: 4, expectedCurrentContractAmountMinor: 18000, targetCurrentContractAmountMinor: 18000 as const, originalFactId: "fact-d03", originalAmountMinor: 31000 as const, billKey: "liuguang" as const },
      { key: "D04" as const, orderId: "order-d04", expectedVersion: 1, expectedCurrentContractAmountMinor: 0, targetCurrentContractAmountMinor: 13000 as const, originalFactId: null, originalAmountMinor: 0 as const, billKey: "liuguang" as const }
    ],
    bills: [
      { key: "xiaonian" as const, billId: "bill-xiaonian", reference: "WX-360", amountMinor: 36000 as const, allocations: [{ orderKey: "303" as const, amountMinor: 18000 }, { orderKey: "306" as const, amountMinor: 18000 }] },
      { key: "liuguang" as const, billId: "bill-liuguang", reference: "WX-310", amountMinor: 31000 as const, allocations: [{ orderKey: "D03" as const, amountMinor: 18000 }, { orderKey: "D04" as const, amountMinor: 13000 }] }
    ]
  };
  return { ...base, planSha256: calculatePlanSha256(base) };
}

describe("fixed historical payment reconciliation plan", () => {
  it("accepts the four fixed targets and conserves both bills", () => {
    expect(() => validateFixedPlan(plan())).not.toThrow();
  });

  it("fails closed when the plan SHA or fixed split changes", () => {
    const altered = plan();
    altered.planSha256 = "0".repeat(64);
    expect(() => validateFixedPlan(altered)).toThrow(/SHA/);
    const split = plan();
    split.bills[1]!.allocations[1]!.amountMinor = 12000;
    expect(() => validateFixedPlan(split)).toThrow(/分配/);
  });

  it("requires an explicit historical fact for every old attribution", () => {
    const altered = plan();
    altered.orders[0]!.originalFactId = null;
    expect(() => validateFixedPlan(altered)).toThrow(/原收款事实/);
  });
});
