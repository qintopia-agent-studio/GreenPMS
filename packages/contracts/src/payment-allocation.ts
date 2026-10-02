import type { ExternalPaymentItem, ExternalPaymentList } from './external-payments.ts';

export const retainedFundsCommandTypes = [
  'RETAIN_ORDER_FUNDS', 'APPLY_RETAINED_FUNDS', 'RELEASE_RETAINED_FUNDS', 'REFUND_RETAINED_FUNDS'
] as const;
export type RetainedFundsCommandType = typeof retainedFundsCommandTypes[number];
export interface PaymentAllocationDetail {
  id: string; orderId: string; factId: string; amountMinor: number; released: boolean; createdAt: string;
}
export interface PaymentAllocationItem extends Omit<ExternalPaymentItem, 'status'> {
  status: ExternalPaymentItem['status'] | 'PARTIALLY_MATCHED';
  allocatedMinor: number; remainingMinor: number; allocations: PaymentAllocationDetail[];
}
export interface PaymentAllocationList extends Omit<ExternalPaymentList, 'items'> { items: PaymentAllocationItem[] }
export interface RetainedFundItem {
  id: string; propertyId: string; sourceOrderId: string; sourceFactId: string; billId: string;
  ownerName: string; ownerContact: string; confirmationNote: string; amountMinor: number;
  usedMinor: number; refundedMinor: number; releasedMinor: number; remainingMinor: number; createdAt: string;
}
export interface RetainedFundList { enabled: boolean; items: RetainedFundItem[]; hasMore: boolean; nextBeforeId: string | null }
export interface RetainedFundEntry {
  id: string; kind: 'USE' | 'REFUND' | 'RELEASE'; amountMinor: number;
  targetOrderId: string | null; authorizationNote: string; createdAt: string;
}
export interface PaymentAllocationEvent {
  eventId: string; sequence: string; billVersion: string; billId: string;
  eventType: 'DISCOVERED' | 'SOURCE_CHANGED' | 'ALLOCATED' | 'ALLOCATION_RELEASED' | 'RETAINED' | 'RETENTION_CHANGED';
  occurredAt: string;
  stateReference: { path: '/api/v2/external-payments'; propertyId: string; billId: string; kind: 'COLLECTION' | 'REFUND'; status: 'ALL' };
}
export interface PaymentAllocationEventPage {
  schemaVersion: 'pms.payments.v2'; propertyId: string; events: PaymentAllocationEvent[]; nextCursor: string;
}
