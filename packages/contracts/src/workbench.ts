import type { MoneyDto } from './index.ts';

export const workbenchExceptionCodes = [
  'OVERDUE_ARRIVAL', 'OVERDUE_DEPARTURE', 'BALANCE_DUE', 'OVERPAYMENT', 'REFUND_DUE',
  'CHANNEL_REFUND_DUE', 'CHANNEL_AMOUNT_MISMATCH', 'CHANNEL_DATA_REVIEW',
  'FUNDS_INCONSISTENT', 'LIFECYCLE_INCONSISTENT', 'INVENTORY_NOT_RELEASED', 'COVERAGE_NOT_RELEASED'
] as const;
export type WorkbenchExceptionCode = (typeof workbenchExceptionCodes)[number];
export type WorkbenchExceptionGroup = 'BUSINESS' | 'FINANCIAL';
const workbenchExceptionGroups = {
  OVERDUE_ARRIVAL: 'BUSINESS', OVERDUE_DEPARTURE: 'BUSINESS',
  LIFECYCLE_INCONSISTENT: 'BUSINESS', INVENTORY_NOT_RELEASED: 'BUSINESS', COVERAGE_NOT_RELEASED: 'BUSINESS',
  BALANCE_DUE: 'FINANCIAL', OVERPAYMENT: 'FINANCIAL', REFUND_DUE: 'FINANCIAL',
  CHANNEL_REFUND_DUE: 'FINANCIAL', CHANNEL_AMOUNT_MISMATCH: 'FINANCIAL', CHANNEL_DATA_REVIEW: 'FINANCIAL',
  FUNDS_INCONSISTENT: 'FINANCIAL'
} as const satisfies Record<WorkbenchExceptionCode, WorkbenchExceptionGroup>;

/** Group by the employee's task, not the underlying technical reason category. */
export function workbenchExceptionGroupFor(code: WorkbenchExceptionCode): WorkbenchExceptionGroup {
  return workbenchExceptionGroups[code];
}
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
  /** Property-wide counts before group filtering and pagination; one order per group. */
  groupCounts: Record<WorkbenchExceptionGroup, number>;
  items: WorkbenchExceptionItem[];
  nextCursor: string | null;
}
export interface WorkbenchExceptionsQuery {
  propertyId: string;
  group?: WorkbenchExceptionGroup;
  afterId?: string;
  limit?: number;
}
