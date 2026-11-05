export const paymentReconciliationIssueCodes = [
  'UNVERIFIED', 'UNASSIGNED', 'OVERCLAIMED', 'BUSINESS_WITHOUT_BILL',
  'BUSINESS_MISMATCH', 'MISSING_ORIGINAL', 'SOURCE_REVIEW'
] as const;
export type PaymentReconciliationIssueCode = typeof paymentReconciliationIssueCodes[number];
export interface PaymentReconciliationItem {
  id: string;
  kind: 'COLLECTION' | 'REFUND';
  billId: string | null;
  factId: string | null;
  orderId: string | null;
  membershipOrderId: string | null;
  orderIds: string[];
  reference: string | null;
  originalTransactionReference: string | null;
  nickname: string | null;
  currency: string;
  amountMinor: number | null;
  /** Source reservation is separate from the effective business cash facts. */
  allocatedMinor: string;
  businessMinor: string;
  unassignedMinor: string | null;
  excessMinor: string;
  occurredAt: string;
  discoveredAt: string | null;
  issues: { code: PaymentReconciliationIssueCode; message: string }[];
}
export interface PaymentReconciliationTotals {
  externalMinor: string;
  businessMinor: string;
  unassignedMinor: string;
  excessMinor: string;
  unbackedMinor: string;
  unknownCount: number;
}
export interface PaymentReconciliationResponse {
  propertyId: string;
  asOf: string;
  sync: { enabled: boolean; lastSyncedAt: string | null; hasError: boolean };
  summary: { collections: PaymentReconciliationTotals; refunds: PaymentReconciliationTotals };
  totalItems: number;
  nextCursor: string | null;
  items: PaymentReconciliationItem[];
}
export interface PaymentReconciliationQuery {
  propertyId: string;
  kind?: 'ALL' | 'COLLECTION' | 'REFUND';
  status?: 'OPEN' | 'ALL';
  afterId?: string;
  orderId?: string;
  limit?: number;
}
