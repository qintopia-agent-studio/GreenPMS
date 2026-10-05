/** Read-only workbench hints; existing commands remain the only write authority. */
export interface WorkbenchFundsExceptionItem {
  id: string;
  kind: "UNALLOCATED_COLLECTION" | "ORDER_EXCESS" | "UNASSIGNED_REFUND";
  orderId: string | null;
  billId: string | null;
  reference: string | null;
  customerLabel: string | null;
  roomLabel: string | null;
  amountMinor: number | null;
  occurredAt: string;
  reason: string;
}
export interface WorkbenchFundsExceptionList {
  enabled: boolean;
  items: WorkbenchFundsExceptionItem[];
  total: number;
  nextCursor: string | null;
}
