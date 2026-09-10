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
