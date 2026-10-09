export const dashboardDefinitionVersion = "2026-10-09.1";
export type DashboardQuality = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export const dashboardSources = ["WECOM", "YOUMUDAO", "CTRIP", "MEITUAN", "MEMBER", "FREE", "UNKNOWN"] as const;
export type DashboardSource = typeof dashboardSources[number];
export const dashboardMetrics = ["PAID", "FREE", "MONEY", "REVIEW", "DEBT", "RETAINED", "IN_HOUSE", "ARRIVAL", "DEPARTURE", "OVERDUE"] as const;
export type DashboardMetric = typeof dashboardMetrics[number];
export interface DashboardQuery {
  from?: string;
  to?: string;
  futureDays?: 14 | 30;
  building?: string;
  roomType?: string;
  source?: DashboardSource;
}
export interface DashboardRange { from: string; to: string }
export interface DashboardStayTotals {
  paidUnitNights: number;
  freeUnitNights: number;
  capacityUnitNights: number | null;
  occupancyRate: number | null;
  quality: DashboardQuality;
  reviewCount: number;
  reason: string;
}
export interface DashboardMoney {
  currency: string;
  collectedMinor: string;
  refundedMinor: string;
  correctedMinor: string;
  netMinor: string | null;
  reviewCount: number;
  reviewMinor: string;
}
export interface DashboardBalance { currency: string; amountMinor: string; count: number }
export interface DashboardFutureDay {
  date: string;
  paid: number;
  free: number;
  maintenance: number;
  review: number;
  availableRooms: number | null;
  availableBeds: number | null;
  capacity: number;
  quality: DashboardQuality;
}
export interface DashboardDetail {
  id: string;
  date: string;
  metric: DashboardMetric;
  label: string;
  orderId: string | null;
  memberId: string | null;
  unitId: string | null;
  units: number | null;
  amountMinor: string | null;
  currency: string | null;
  registeredAt: string | null;
  businessDate: string | null;
  reason: string;
}
export interface DashboardResponse {
  propertyId: string;
  asOf: string;
  businessDate: string;
  timezone: string;
  currency: string;
  definitionVersion: string;
  range: DashboardRange;
  previousRange: DashboardRange;
  history: DashboardStayTotals;
  previous: DashboardStayTotals;
  occupancyChangePoints: number | null;
  stayTrend: Array<{ date: string; paid: number; free: number; capacity: number | null; quality: DashboardQuality }>;
  breakdown: Array<{ building: string; roomType: string } & DashboardStayTotals>;
  sources: Array<{ source: DashboardSource; unitNights: number }>;
  money: DashboardMoney[];
  previousMoney: DashboardMoney[];
  moneyTrend: Array<{ date: string; money: DashboardMoney[] }>;
  current: {
    paidGuests: number;
    freeGuests: number;
    guestReviewOrders: number;
    arrivals: number;
    departures: number;
    overdue: number;
    debts: DashboardBalance[];
    retained: DashboardBalance[];
  };
  future: DashboardFutureDay[];
  filters: { buildings: string[]; roomTypes: string[] };
  warnings: string[];
}
export interface DashboardDetailsResponse {
  asOf: string;
  definitionVersion: string;
  range: DashboardRange;
  changedSinceSummary: boolean;
  items: DashboardDetail[];
  total: number;
  page: number;
  pageSize: number;
}
