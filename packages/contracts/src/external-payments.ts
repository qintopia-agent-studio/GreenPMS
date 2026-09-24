export interface ExternalPaymentItem {
  id: string; kind: "COLLECTION" | "REFUND"; reference: string; originalTransactionReference: string | null;
  amountMinor: number | null; occurredAt: string; nickname: string | null;
  status: "AVAILABLE" | "MATCHED" | "HISTORICAL" | "REVIEW" | "PENDING" | "UNVERIFIED";
  orderId: string | null; membershipOrderId: string | null; recommendationReasons: string[];
}
export interface ExternalPaymentList {
  enabled: boolean; lastSyncedAt: string | null; synchronizationError: boolean;
  items: ExternalPaymentItem[]; hasMore: boolean; nextBeforeId: string | null;
}
export interface ExternalPaymentEventHead {
  schemaVersion: "pms.payments.v1";
  propertyId: string;
  headCursor: string;
}
/** Push and pull compare these event fields, not their different outer JSON bytes. */
export interface ExternalPaymentEvent {
  eventId: string;
  sequence: string;
  billId: string;
  kind: "COLLECTION" | "REFUND";
  eventType: "DISCOVERED" | "MATCHED";
  occurredAt: string;
}
export interface ExternalPaymentEventEnvelope extends ExternalPaymentEvent {
  schemaVersion: "pms.payments.v1";
  sourceInstance: string;
  propertyId: string;
}
export interface ExternalPaymentEventPage {
  schemaVersion: "pms.payments.v1";
  propertyId: string;
  events: ExternalPaymentEvent[];
  nextCursor: string;
}
