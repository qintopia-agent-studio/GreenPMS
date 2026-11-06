import type { PaymentReconciliationState } from "./paymentReconciliation";
import type { WorkbenchExceptionsState } from "./workbenchExceptionsReader";

/** Badges count pending list entries, not unique orders across different tasks. */
export function workbenchExceptionCounts(propertyId: string, orders: WorkbenchExceptionsState, payments: PaymentReconciliationState) {
  const groups = !orders.loading && !orders.error && orders.data?.propertyId === propertyId ? orders.data.groupCounts : undefined;
  const payment = !payments.loading && !payments.error && payments.data?.propertyId === propertyId ? payments.data : undefined;
  const complete = payment?.sync.enabled && payment.sync.lastSyncedAt && !payment.sync.hasError
    && Date.parse(payment.asOf) - Date.parse(payment.sync.lastSyncedAt) <= 5 * 60_000;
  const business = groups?.BUSINESS ?? null;
  const financial = groups && complete && payment?.totalOpenItems !== undefined ? groups.FINANCIAL + payment.totalOpenItems : null;
  return { business, financial, total: business !== null && financial !== null ? business + financial : null };
}
