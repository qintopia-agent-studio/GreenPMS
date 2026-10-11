import { DomainError, type DashboardMoney, type DashboardQuery, type DashboardRange, type DashboardSource, type DashboardStayTotals } from "@qintopia/contracts";
import { parseLocalDate } from "./dates.ts";

export function dashboardDate(value: string, offset: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function dashboardRange(query: DashboardQuery, businessDate: string) {
  if (Boolean(query.from) !== Boolean(query.to)) throw new DomainError("VALIDATION_ERROR", "开始和结束日期须同时提供", 400);
  const from = query.from ?? dashboardDate(businessDate, -30);
  const to = query.to ?? dashboardDate(businessDate, -1);
  const nights = (parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86_400_000 + 1;
  if (nights < 1 || nights > 366 || to >= businessDate) throw new DomainError("VALIDATION_ERROR", "历史范围须为截至昨日的1至366个完整营业日", 400);
  if (query.futureDays !== undefined && ![14, 30].includes(query.futureDays)) throw new DomainError("VALIDATION_ERROR", "未来范围仅支持14或30天", 400);
  return { range: { from, to }, previousRange: { from: dashboardDate(from, -nights), to: dashboardDate(from, -1) }, nights };
}
export function inDashboardRange(date: string, range: DashboardRange) { return date >= range.from && date <= range.to; }
export function dashboardSource(order: { stay_type: string; member_id: string | null; member_contract_id: string | null; booking_channel_code: string | null }): DashboardSource {
  if (order.stay_type === "FREE") return "FREE";
  if (order.member_id || order.member_contract_id) return "MEMBER";
  return ["WECOM", "YOUMUDAO", "CTRIP", "MEITUAN"].includes(order.booking_channel_code ?? "") ? order.booking_channel_code as DashboardSource : "UNKNOWN";
}
export interface DashboardMoneyFact {
  id: string;
  date: string;
  currency: string;
  netMinor: string;
  kind: string;
  commandType: string | null;
  family: "STAY" | "MEMBER";
  linkedTransfer: boolean;
  transferSource: boolean;
  reclassifiedReversal: boolean;
  replacementCollection: boolean;
  correctsFact: boolean;
  deletionCorrection: boolean;
}
export type DashboardMoneyClass = "COLLECTION" | "REFUND" | "CORRECTION" | "INTERNAL" | "REVIEW";
export function classifyDashboardMoney(fact: DashboardMoneyFact): DashboardMoneyClass {
  if (fact.linkedTransfer) return "INTERNAL";
  if (fact.kind === "REALLOCATION_IN" || fact.kind === "REALLOCATION_OUT") return "INTERNAL";
  if (fact.transferSource) return "REVIEW";
  if (fact.reclassifiedReversal && fact.kind === "REVERSAL") return "CORRECTION";
  if (fact.replacementCollection && fact.kind === "COLLECTION") return "COLLECTION";
  if (fact.deletionCorrection && fact.kind === "REVERSAL") return "CORRECTION";
  if (fact.kind === "REVERSAL" && ["REVERSE_FACT", "CORRECT_MEMBERSHIP_PAYMENT"].includes(fact.commandType ?? "")) return "CORRECTION";
  if (fact.correctsFact && fact.commandType === "CORRECT_MEMBERSHIP_PAYMENT") return "CORRECTION";
  if (fact.kind === "REFUND" && ["RECORD_REFUND", "REFUND_RETAINED_FUNDS"].includes(fact.commandType ?? "") && BigInt(fact.netMinor) < 0n) return "REFUND";
  const ordinary = fact.family === "STAY" ? ["RECORD_COLLECTION", "CREATE_ORDER", "BACKFILL_COMPLETED_STAY"] : ["RECORD_MEMBERSHIP_PAYMENT", "BACKFILL_HISTORICAL_MEMBERSHIP", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"];
  if (fact.kind === "COLLECTION" && ordinary.includes(fact.commandType ?? "") && BigInt(fact.netMinor) > 0n) return "COLLECTION";
  return "REVIEW";
}
export function aggregateDashboardMoney(facts: readonly DashboardMoneyFact[], currency: string): DashboardMoney[] {
  const buckets = new Map<string, { collected: bigint; refunded: bigint; corrected: bigint; review: bigint; count: number }>();
  const bucket = (code: string) => { let value = buckets.get(code); if (!value) { value = { collected: 0n, refunded: 0n, corrected: 0n, review: 0n, count: 0 }; buckets.set(code, value); } return value; };
  bucket(currency);
  const seen = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.family}:${fact.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classifyDashboardMoney(fact);
    if (kind === "INTERNAL") continue;
    const row = bucket(fact.currency); const amount = BigInt(fact.netMinor);
    if (kind === "COLLECTION") row.collected += amount;
    else if (kind === "REFUND") row.refunded -= amount;
    else if (kind === "CORRECTION") row.corrected += amount;
    else { row.count += 1; row.review += amount < 0n ? -amount : amount; }
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([code, row]) => ({ currency: code,
    collectedMinor: String(row.collected), refundedMinor: String(row.refunded), correctedMinor: String(row.corrected),
    netMinor: row.count ? null : String(row.collected - row.refunded + row.corrected), reviewCount: row.count, reviewMinor: String(row.review) }));
}
export interface DashboardStayNight { orderId: string; date: string; unitId: string; building: string; roomType: string; source: DashboardSource; units: number }
export function aggregateDashboardStays(nights: readonly DashboardStayNight[], capacity: number | null, reviewCount: number, reason: string): DashboardStayTotals {
  const unique = new Map(nights.map(night => [`${night.orderId}:${night.date}`, night]));
  let paid = 0, free = 0;
  for (const night of unique.values()) { if (night.source === "FREE") free += night.units; else paid += night.units; }
  const rate = !reviewCount && capacity !== null && capacity > 0 ? paid / capacity * 100 : null;
  return { paidUnitNights: paid, freeUnitNights: free, capacityUnitNights: capacity, occupancyRate: rate,
    quality: reviewCount ? "PARTIAL" : "COMPLETE", reviewCount, reason };
}
