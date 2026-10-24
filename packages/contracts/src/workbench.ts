import type { MoneyDto } from './index.ts';

export const workbenchExceptionCodes = [
  'OVERDUE_ARRIVAL', 'OVERDUE_DEPARTURE', 'BALANCE_DUE', 'OVERPAYMENT', 'REFUND_DUE',
  'CHANNEL_REFUND_DUE', 'CHANNEL_AMOUNT_MISMATCH', 'CHANNEL_DATA_REVIEW',
  'FUNDS_INCONSISTENT', 'LIFECYCLE_INCONSISTENT', 'INVENTORY_NOT_RELEASED', 'COVERAGE_NOT_RELEASED'
] as const;
export type WorkbenchExceptionCode = (typeof workbenchExceptionCodes)[number];
export interface WorkbenchExceptionReason {
  code: WorkbenchExceptionCode;
  category: 'FULFILLMENT' | 'FUNDS' | 'INVENTORY' | 'DATA';
  message: string;
  amount: MoneyDto | null;
}
export interface WorkbenchExceptionItem {
  orderId: string;
  orderStatus: string;
  stayStatus: string | null;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  unitLabel: string | null;
  orderHref: string;
  reasons: WorkbenchExceptionReason[];
}
export interface WorkbenchExceptionsResponse {
  propertyId: string;
  businessDate: string;
  asOf: string;
  totalOrders: number;
  items: WorkbenchExceptionItem[];
  nextCursor: string | null;
}
export interface WorkbenchExceptionsQuery {
  propertyId: string;
  afterId?: string;
  limit?: number;
}
