import { describe, expect, it } from "vitest";
import type { PaymentReconciliationState } from "./paymentReconciliation";
import type { WorkbenchExceptionsState } from "./workbenchExceptionsReader";
import { workbenchExceptionCounts } from "./workbenchExceptionCounts";

const propertyId = "sample-property";
const asOf = "2026-11-06T08:00:00Z";
const orders: WorkbenchExceptionsState = { loading: false, page: 1, data: {
  propertyId, asOf, businessDate: "2026-11-06", totalOrders: 5,
  groupCounts: { BUSINESS: 5, FINANCIAL: 3 }, items: [], nextCursor: null
} };
const totals = { externalMinor: "0", businessMinor: "0", unassignedMinor: "0", excessMinor: "0", unbackedMinor: "0", unknownCount: 0 };
const payments: PaymentReconciliationState = { loading: false, data: {
  propertyId, asOf, sync: { enabled: true, lastSyncedAt: asOf, hasError: false },
  summary: { collections: totals, refunds: totals }, totalOpenItems: 4, totalItems: 4, items: [], nextCursor: null
} };

describe("workbench pending-item badges", () => {
  it("counts different tasks on the same order and keeps totals stable across groups, pages and refund filters", () => {
    expect(workbenchExceptionCounts(propertyId, orders, payments)).toEqual({ business: 5, financial: 7, total: 12 });
    const financialPage = { ...orders, page: 2, data: { ...orders.data!, totalOrders: 3, items: [], nextCursor: null } };
    const refundFilter = { ...payments, data: { ...payments.data!, totalItems: 2 } };
    expect(workbenchExceptionCounts(propertyId, financialPage, refundFilter)).toEqual({ business: 5, financial: 7, total: 12 });
  });
  it("shows zero only after both complete lists have been read", () => {
    const emptyOrders = { ...orders, data: { ...orders.data!, totalOrders: 0, groupCounts: { BUSINESS: 0, FINANCIAL: 0 } } };
    const emptyPayments = { ...payments, data: { ...payments.data!, totalItems: 0, totalOpenItems: 0 } };
    expect(workbenchExceptionCounts(propertyId, emptyOrders, emptyPayments)).toEqual({ business: 0, financial: 0, total: 0 });
  });
  it.each(["loading", "error", "wrong-property"])("does not show an old or zero financial count during %s", mode => {
    const pending = mode === "loading" ? { ...payments, loading: true }
      : mode === "error" ? { ...payments, error: new Error("read failed") }
      : { ...payments, data: { ...payments.data!, propertyId: "other-property" } };
    expect(workbenchExceptionCounts(propertyId, orders, pending)).toEqual({ business: 5, financial: null, total: null });
  });
  it.each(["loading", "error", "wrong-property"])("clears order counts during %s", mode => {
    const pending = mode === "loading" ? { ...orders, loading: true }
      : mode === "error" ? { ...orders, error: new Error("read failed") }
      : { ...orders, data: { ...orders.data!, propertyId: "other-property" } };
    expect(workbenchExceptionCounts(propertyId, pending, payments)).toEqual({ business: null, financial: null, total: null });
  });
  it.each(["disabled", "never-synced", "delayed", "error"])("does not imply all payments are counted when sync is %s", mode => {
    const sync = { ...payments.data!.sync };
    if (mode === "disabled") sync.enabled = false;
    if (mode === "never-synced") sync.lastSyncedAt = null;
    if (mode === "delayed") sync.lastSyncedAt = "2026-11-06T07:54:00Z";
    if (mode === "error") sync.hasError = true;
    expect(workbenchExceptionCounts(propertyId, orders, { ...payments, data: { ...payments.data!, sync } })).toEqual({ business: 5, financial: null, total: null });
  });
});
