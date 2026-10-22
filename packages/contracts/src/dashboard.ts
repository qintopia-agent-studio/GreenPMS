import type { OperatingSalesSummary } from "./operating-sales.ts";
export const dashboardDefinitionVersion = "2026-10-22.3";
export type DashboardQuality = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export const dashboardSources = ["WECOM", "YOUMUDAO", "CTRIP", "MEITUAN", "MEMBER", "FREE", "UNKNOWN"] as const;
export type DashboardSource = typeof dashboardSources[number];
export const dashboardMetrics = ["PAID", "FREE", "MONEY", "REVIEW", "DEBT", "RETAINED", "IN_HOUSE", "ARRIVAL", "DEPARTURE", "OVERDUE", "TODAY_ORDERS", "TODAY_COLLECTIONS", "SALES", "TODAY_SALES"] as const;
export type DashboardMetric = typeof dashboardMetrics[number];
/** 明细事实的来源类别；用于给外部财务智能体保留可追溯的来源边界。 */
export const dashboardDetailSources = ["LODGING", "MEMBERSHIP", "CHANNEL", "WECOM", "BASELINE", "INVENTORY", "ORDER", "UNKNOWN"] as const;
export type DashboardDetailSource = typeof dashboardDetailSources[number];
/** 事实是否已经被业务对象认领，INTERNAL 表示内部归属转换，不是新增收退款。 */
export const dashboardDetailClaimStatuses = ["CONFIRMED", "PENDING_REVIEW", "UNCLAIMED", "INTERNAL"] as const;
export type DashboardDetailClaimStatus = typeof dashboardDetailClaimStatuses[number];
/** 登记事实的写入来源；worker 同步状态与业务认领状态分开表达。 */
export const dashboardDetailSyncStatuses = ["WORKER_SYNCED", "MANUAL_ENTRY", "NOT_APPLICABLE", "UNKNOWN"] as const;
export type DashboardDetailSyncStatus = typeof dashboardDetailSyncStatuses[number];
/** 凭据或关联链的完整程度，避免外部智能体把缺证据的金额当作完整事实。 */
export const dashboardDetailEvidenceStatuses = ["COMPLETE", "PARTIAL", "MISSING"] as const;
export type DashboardDetailEvidenceStatus = typeof dashboardDetailEvidenceStatuses[number];
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
  /** 以下字段为可选扩展，旧明细和非资金事实无需回填即可继续通过契约。 */
  sourceType?: DashboardDetailSource;
  claimStatus?: DashboardDetailClaimStatus;
  sourceFactId?: string | null;
  referencesFactId?: string | null;
  reversesFactId?: string | null;
  correctsFactId?: string | null;
  syncStatus?: DashboardDetailSyncStatus;
  evidenceStatus?: DashboardDetailEvidenceStatus;
  externalBillId?: string | null;
  transactionReference?: string | null;
  refundReference?: string | null;
  originalTransactionReference?: string | null;
  sourceOccurredAt?: string | null;
  sourceDiscoveredAt?: string | null;
  sourceUpdatedAt?: string | null;
  membershipOrderId?: string | null;
  channelCode?: string | null;
  channelOrderReference?: string | null;
  paymentMethod?: string | null;
  financialKind?: string | null;
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
  sales?: OperatingSalesSummary;
  money: DashboardMoney[];
  previousMoney: DashboardMoney[];
  moneyTrend: Array<{ date: string; money: DashboardMoney[] }>;
  current: {
    todaySales?: OperatingSalesSummary;
    todayOrders: number;
    todayCollections: DashboardBalance[];
    todayCollectionBreakdown?: Array<{ currency: string; source: "STAY" | "MEMBER" | "CHANNEL"; amountMinor: string; count: number }>;
    todayCollectionReviewCount: number;
    todayUnclaimed?: DashboardBalance[];
    paymentSync?: { enabled: boolean; lastSyncedAt: string | null; hasError: boolean };
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
  futureReviewCount: number;
  community: DashboardCommunity;
  filters: { buildings: string[]; roomTypes: string[]; roomTypeLabels?: Record<string, string> };
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

export interface CommunityDay {
  date: string; total: number | null; paid: number; volunteer: number; reception: number; otherFree: number; unlinked: number;
  unclassified?: number;
  registered?: { total: number | null; paid: number; volunteer: number; reception: number; otherFree: number };
}
export interface CommunityResidentPerson {
  orderId: string;
  memberId: string | null;
  occupantId?: string | null;
  occupantName?: string;
  memberName?: string;
  roomCode?: string;
  arrivalDate?: string;
  departureDate?: string;
}
export interface CommunityResidentReviewItem extends CommunityResidentPerson {
  reason: string;
  reasonLabel?: string;
}
export interface CommunityResidentMemberItem extends CommunityResidentPerson {
  basis?: "MEMBER_ENTITLEMENT";
}
export interface CommunityResidentDay {
  date: string;
  total: number | null;
  longStay: number;
  member: number | null;
  memberReview: number;
  /** 已确认集合大小；完整总数缺项时仍可展示，不能当作完整总数。 */
  knownTotal?: number;
  knownMember?: number;
  residentReview?: number;
  reviewItems?: CommunityResidentReviewItem[];
  /** 会员权益住宿的主要住客登记名单；会员ID只表示权益来源，不作为人员身份。 */
  memberItems?: CommunityResidentMemberItem[];
}
export interface CommunityRecord {
  orderId: string; date: string; nights: number; reason: string;
  people?: number | null;
  kind: "NEW" | "RETURN" | "RENEWAL" | "DUE" | "EARLY";
}
/** Known registration timelines are counted automatically; missing dates/rosters stay explicit. */
export interface CommunityDurationCoverage {
  /** Registrations counted without a cross-order identity link; not an unresolved work queue. */
  registrationBased?: number;
  pendingRegistrations: number;
  pendingOrders: number;
  issues: Array<{ orderId: string; reason: string }>;
}
export interface DashboardCommunity {
  /** Nickname/name matching is an operating estimate, not a verified person ID. */
  identityApproximate?: boolean;
  current: CommunityDay;
  trend: CommunityDay[];
  visitors: number | null;
  dailyAverage: number | null;
  duration: Array<{ nights: number; current: number; all: number }>;
  durationCoverage?: { current: CommunityDurationCoverage; all: CommunityDurationCoverage };
  records: CommunityRecord[];
  counts: Record<CommunityRecord["kind"], number>;
  reasons: string[];
  residentCurrent?: CommunityResidentDay;
  residentTrend?: CommunityResidentDay[];
}
