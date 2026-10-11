import { sql, type Transaction } from "kysely";
import type { DashboardBalance, DashboardDetail, DashboardFutureDay, DashboardResponse } from "@qintopia/contracts";
import { enumerateServiceDates } from "@qintopia/domain";
import { listAvailability } from "./inventory.ts";
import type { loadDashboardStays } from "./dashboard-stays.ts";
import type { Database } from "./schema.ts";

type Lodging = Awaited<ReturnType<typeof loadDashboardStays>>;
export function newDashboardDetail(id: string, date: string): DashboardDetail { return { id, date, metric: "REVIEW", label: "", orderId: null, memberId: null, unitId: null, units: null, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "" }; }
function balances(items: DashboardDetail[], currency: string): DashboardBalance[] {
  const grouped = new Map<string, { amount: bigint; count: number }>([[currency, { amount: 0n, count: 0 }]]);
  for (const item of items) { const code = item.currency!; const value = grouped.get(code) ?? { amount: 0n, count: 0 }; value.amount += BigInt(item.amountMinor!); value.count++; grouped.set(code, value); }
  return [...grouped].map(([code, value]) => ({ currency: code, amountMinor: String(value.amount), count: value.count }));
}
export async function loadDashboardCurrent(trx: Transaction<Database>, propertyId: string, businessDate: string, currency: string) {
  const debtRows = (await sql<{ id: string; currency: string; amount: string }>`SELECT o.id, p.currency,
    (p.current_contract_amount_minor - COALESCE((SELECT SUM(f.net_effect_minor) FROM collection_facts f WHERE f.order_id=o.id),0))::text AS amount
    FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id
    WHERE o.property_id=${propertyId} AND o.status IN ('RESERVED','CHECKED_IN','CHECKED_OUT') AND o.stay_type<>'FREE'
    AND (o.booking_channel_code IS NULL OR o.booking_channel_code='WECOM') AND p.pricing_basis<>'CHANNEL_CONTRACT'
    AND p.current_contract_amount_minor > COALESCE((SELECT SUM(f.net_effect_minor) FROM collection_facts f WHERE f.order_id=o.id),0)`.execute(trx)).rows;
  const retainedRows = (await sql<{ id: string; source_order_id: string; currency: string; amount: string }>`SELECT l.id,l.source_order_id,f.currency,
    (l.amount_minor-COALESCE((SELECT SUM(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0))::text AS amount
    FROM retained_funds l JOIN collection_facts f ON f.fact_id=l.source_fact_id WHERE l.property_id=${propertyId}
    AND l.amount_minor>COALESCE((SELECT SUM(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0)`.execute(trx)).rows;
  const debts = debtRows.map(row => ({ ...newDashboardDetail(`debt:${row.id}`, businessDate), metric: "DEBT" as const, label: "住宿欠款", orderId: row.id, currency: row.currency, amountMinor: row.amount, reason: "当前合同金额减本订单净登记资金的正差额；含内部归属转入转出" }));
  const retained = retainedRows.map(row => ({ ...newDashboardDetail(`retained:${row.id}`, businessDate), metric: "RETAINED" as const, label: "留存待用", orderId: row.source_order_id, currency: row.currency, amountMinor: row.amount, reason: "原留存减使用、退款和解除；关闭新写功能不会清零历史余额" }));
  const rows = (await sql<{ id: string; status: string; stay_status: string; stay_type: string; arrival_date: string; departure_date: string; guests: string }>`SELECT o.id,o.status,s.status AS stay_status,o.stay_type,o.arrival_date::text,o.departure_date::text,
    (SELECT count(DISTINCT guest.id)::text FROM active_order_occupants guest WHERE guest.order_id=o.id) AS guests
    FROM orders o JOIN stays s ON s.order_id=o.id WHERE o.property_id=${propertyId}
      AND ((o.status='CHECKED_IN' AND s.status='IN_HOUSE') OR (o.status='RESERVED' AND s.status='PLANNED' AND o.arrival_date<=${businessDate}::date))`.execute(trx)).rows;
  const current: DashboardResponse["current"] = { paidGuests: 0, freeGuests: 0, guestReviewOrders: 0, arrivals: 0, departures: 0, overdue: 0, debts: balances(debts, currency), retained: balances(retained, currency) };
  const details: DashboardDetail[] = [...debts, ...retained];
  for (const row of rows) {
    const base = { ...newDashboardDetail(`current:${row.id}`, businessDate), orderId: row.id };
    if (row.status === "CHECKED_IN") {
      const guests = Number(row.guests);
      if (!guests) current.guestReviewOrders++;
      if (row.stay_type === "FREE") current.freeGuests += guests; else current.paidGuests += guests;
      details.push({ ...base, metric: "IN_HOUSE", label: row.stay_type === "FREE" ? "免费在住" : "付费在住", units: guests || null, reason: guests ? "按订单内有效住宿人关系去重，不代表跨订单独立访客数" : "缺少登记住宿人，不以默认1人代替" });
    }
    if (row.status === "RESERVED" && row.arrival_date === businessDate) { current.arrivals++; details.push({ ...base, id: `arrival:${row.id}`, metric: "ARRIVAL", label: "今日待到", units: 1, reason: "有效预订，尚未办理入住" }); }
    if (row.status === "CHECKED_IN" && row.departure_date === businessDate) { current.departures++; details.push({ ...base, id: `departure:${row.id}`, metric: "DEPARTURE", label: "今日待离", units: 1, reason: "计划今日离店，不自动视为已退房" }); }
    if ((row.status === "RESERVED" && row.arrival_date < businessDate) || (row.status === "CHECKED_IN" && row.departure_date < businessDate)) { current.overdue++; details.push({ ...base, id: `overdue:${row.id}`, metric: "OVERDUE", label: row.status === "RESERVED" ? "逾期到店" : "逾期在住", units: 1, reason: "需到原订单核对履约，不自动延长库存或办理退房" }); }
  }
  return { current, details };
}
export async function loadDashboardFuture(trx: Transaction<Database>, propertyId: string, from: string, until: string, lodging: Lodging): Promise<DashboardFutureDay[]> {
  const available = new Map((await listAvailability(trx, propertyId, from, until)).map(unit => [unit.id, unit]));
  const claims = await trx.selectFrom("inventory_claims as claim")
    .leftJoin("stay_segments as segment", join => join.onRef("segment.id", "=", "claim.source_id").on("claim.source_type", "=", "ORDER_SEGMENT"))
    .leftJoin("stays as stay", "stay.id", "segment.stay_id").leftJoin("orders as o", "o.id", "stay.order_id")
    .leftJoin("maintenance_locks as lock", join => join.onRef("lock.id", "=", "claim.source_id").on("claim.source_type", "=", "MAINTENANCE"))
    .select(["claim.id", "claim.source_type", "o.id as order_id", "o.status", "o.stay_type", "o.property_id as order_property_id", "stay.status as stay_status", "lock.status as maintenance_status"])
    .where("claim.property_id", "=", propertyId).where("claim.active", "=", true).where("claim.service_date", ">=", from).where("claim.service_date", "<", until).execute();
  const byId = new Map(claims.map(claim => [claim.id, claim]));
  return enumerateServiceDates(from, until).map(date => {
    const day: DashboardFutureDay = { date, paid: 0, free: 0, maintenance: 0, review: 0, availableRooms: 0, availableBeds: 0, capacity: lodging.atomicUnits.length, quality: "COMPLETE" };
    for (const unit of lodging.atomicUnits) {
      const night = available.get(unit.id)?.nights.find(item => item.serviceDate === date);
      if (!night) { day.review++; continue; }
      if (night.available) { if (unit.kind === "ROOM") day.availableRooms!++; else day.availableBeds!++; continue; }
      const claim = night.blockingClaimIds.length === 1 ? byId.get(night.blockingClaimIds[0]!) : undefined;
      if (claim?.source_type === "MAINTENANCE" && claim.maintenance_status === "ACTIVE") day.maintenance++;
      else if (claim?.order_id && claim.order_property_id === propertyId && lodging.validOrderIds.has(claim.order_id) && ((claim.status === "RESERVED" && claim.stay_status === "PLANNED") || (claim.status === "CHECKED_IN" && claim.stay_status === "IN_HOUSE"))) { if (claim.stay_type === "FREE") day.free++; else day.paid++; }
      else day.review++;
    }
    if (lodging.invalidFutureDates.has(date)) { day.quality = "PARTIAL"; day.availableRooms = null; day.availableBeds = null; day.review = Math.max(day.review, 1); }
    else if (day.review) day.quality = "PARTIAL";
    return day;
  });
}
