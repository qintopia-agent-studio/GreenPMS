import { dailySalesCapacity } from "./daily-sales-capacity.ts";
import { sql, type Transaction } from "kysely";
import type { DashboardDetail, DashboardQuery, DashboardRange } from "@qintopia/contracts";
import { dashboardSource, dashboardDate, enumerateServiceDates, type DashboardStayNight } from "@qintopia/domain";
import { projectOrderLifecycle } from "./orders.ts";
import { propertyLocalClockAt } from "./members.ts";
import { historicalProtocolEpochMigration, legacyEffectProtocol } from "./historical-command-protocol.ts";
import type { Database } from "./schema.ts";

export function groupDashboardRows<T>(rows: readonly T[], key: (row: T) => string) {
  const result = new Map<string, T[]>();
  for (const row of rows) { const id = key(row); const items = result.get(id) ?? []; items.push(row); result.set(id, items); }
  return result;
}
export async function loadDashboardStays(trx: Transaction<Database>, propertyId: string, businessDate: string, range: DashboardRange, futureUntil: string, timezone: string) {
  const localDate = (value: Date) => propertyLocalClockAt(timezone, value).date;
  const units = await trx.selectFrom("inventory_units").select(["id", "kind", "parent_room_id", "code", "active", "building_code", "room_type_code", "created_at"]).where("property_id", "=", propertyId).execute();
  const unitsById = new Map(units.map(unit => [unit.id, unit]));
  const children = groupDashboardRows(units.filter(unit => unit.parent_room_id), unit => unit.parent_room_id!);
  const changes = await trx.selectFrom("room_catalog_changes").select(["created_at", "effect"]).where("property_id", "=", propertyId).execute();
  const capacity = dailySalesCapacity(units, changes, localDate);
  const orders = await trx.selectFrom("orders as o").innerJoin("stays as s", "s.order_id", "o.id")
    .select(["o.id", "o.status", "o.stay_type", "o.arrival_date", "o.departure_date", "o.current_revision_id", "o.version", "o.member_id", "o.member_contract_id", "o.booking_channel_code", "s.id as stay_id", "s.status as stay_status"])
    .where("o.property_id", "=", propertyId).where("o.status", "in", ["CHECKED_IN", "CHECKED_OUT", "RESERVED"])
    .where("o.arrival_date", "<", futureUntil).where("o.departure_date", ">", range.from).execute();
  const ids = orders.map(order => order.id);
  const segments = ids.length ? await trx.selectFrom("stay_segments as segment").innerJoin("stays as stay", "stay.id", "segment.stay_id").selectAll("segment").where("stay.order_id", "in", ids).orderBy("segment.sequence").execute() : [];
  const amendments = ids.length ? await trx.selectFrom("amendments as a").leftJoin("command_executions as c", "c.id", "a.command_id").leftJoin("subjects as subject", "subject.id", "c.subject_id")
    .selectAll("a").select(["c.subject_id as actor_subject_id", "subject.display_name as actor_display_name"]).where("a.order_id", "in", ids).orderBy("a.sequence").execute() : [];
  const revisions = ids.length ? await trx.selectFrom("pricing_revisions").select(["id", "order_id", "revision_no", "amendment_id", "arrival_date", "departure_date", "policy_base_amount_minor", "current_contract_amount_minor", "currency"]).where("order_id", "in", ids).orderBy("revision_no").execute() : [];
  const facts = ids.length ? await trx.selectFrom("collection_facts").select(["order_id", "net_effect_minor", "currency", "created_at"]).where("order_id", "in", ids).execute() : [];
  const active = ids.length ? await trx.selectFrom("inventory_claims as claim").innerJoin("stay_segments as segment", "segment.id", "claim.source_id").innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .select(["stay.order_id", "claim.service_date", "claim.inventory_unit_id"]).where("claim.source_type", "=", "ORDER_SEGMENT").where("claim.active", "=", true).where("claim.property_id", "=", propertyId).where("stay.order_id", "in", ids).orderBy("claim.service_date").execute() : [];
  const epochs = new Map((await trx.selectFrom("schema_migrations").select(["name", "applied_at"]).where("name", "in", ["028_stage11_move_unit_guards.sql", "044_inhouse_membership_fulfillment_guards.sql"]).execute()).map(row => [row.name, row.applied_at]));
  const byStay = groupDashboardRows(segments, row => row.stay_id), byOrderAmendment = groupDashboardRows(amendments, row => row.order_id), byOrderRevision = groupDashboardRows(revisions, row => row.order_id), byOrderFact = groupDashboardRows(facts, row => row.order_id), byOrderActive = groupDashboardRows(active, row => row.order_id);
  const nights: DashboardStayNight[] = [];
  const reviews: DashboardDetail[] = [];
  const invalidFutureDates = new Set<string>();
  const futureReviews: DashboardDetail[] = [];
  const validOrderIds = new Set<string>();
  const arrangements = new Map<string, Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }>>();
  for (const order of orders) {
    let reviewReason = "订单住宿时间线或履约证据不完整";
    try {
      const normalized = (byOrderAmendment.get(order.id) ?? []).map(amendment => {
        const protocolVersion = legacyEffectProtocol(amendment.amendment_type, amendment.payload);
        if (!protocolVersion) return amendment;
        const epoch = epochs.get(historicalProtocolEpochMigration(protocolVersion));
        if (!epoch || new Date(amendment.created_at) >= new Date(epoch)) throw new Error("历史协议证据不可核对");
        return { ...amendment, protocolVersion };
      });
      const lifecycle = projectOrderLifecycle({ order, stay: { id: order.stay_id, status: order.stay_status }, businessDate,
        segments: byStay.get(order.stay_id) ?? [], amendments: normalized, revisions: byOrderRevision.get(order.id) ?? [], facts: byOrderFact.get(order.id) ?? [],
        activeTimeline: (byOrderActive.get(order.id) ?? []).map(row => ({ serviceDate: row.service_date, inventoryUnitId: row.inventory_unit_id })) });
      validOrderIds.add(order.id);
      arrangements.set(order.id, lifecycle.effectiveArrangement.intervals);
      if (order.status === "RESERVED") continue;
      reviewReason = "历史房源或拆床容量证据不完整";
      for (const interval of lifecycle.effectiveArrangement.intervals) {
        const unit = unitsById.get(interval.inventoryUnitId);
        if (!unit) throw new Error("历史房源不可核对");
        const room = unit.kind === "ROOM" ? unit : unitsById.get(unit.parent_room_id!);
        if (!room) throw new Error("父房不可核对");
        const from = interval.arrivalDate > range.from ? interval.arrivalDate : range.from;
        const until = interval.departureDate < businessDate ? interval.departureDate : businessDate;
        if (from >= until) continue;
        for (const date of enumerateServiceDates(from, until)) {
          const weight = capacity.weight(unit.id, date);
          if (weight === null) {
            reviews.push({ id: `stay-review:${order.id}:${unit.id}:${date}`, date, metric: "REVIEW", label: "当日住宿量待核对", orderId: order.id, memberId: null, unitId: unit.id, units: null, amountMinor: null, currency: null, registeredAt: null, businessDate: date, reason: `${date} 的 ${room.building_code ?? "未分配楼栋"} / ${unit.code} 缺少有效销售结构依据；只排除这一天的住宿量，同单其他已知日期保留。` });
            continue;
          }
          nights.push({ orderId: order.id, date, unitId: unit.id, building: room.building_code ?? "未分配", roomType: unit.room_type_code ?? room.room_type_code ?? "未分配", source: dashboardSource(order), units: weight });
        }
      }
    } catch {
      if (order.status !== "RESERVED" && order.arrival_date <= range.to) reviews.push({ id: `stay-review:${order.id}`, date: order.arrival_date > range.from ? order.arrival_date : range.from, metric: "REVIEW", label: "住宿时间线待核对", orderId: order.id, memberId: null, unitId: null, units: null, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "有效住宿、履约或历史拆床容量证据不完整，未纳入已知单元夜" });
      const from = order.arrival_date > businessDate ? order.arrival_date : businessDate;
      const until = order.departure_date < futureUntil ? order.departure_date : futureUntil;
      if (!validOrderIds.has(order.id) && order.status !== "CHECKED_OUT" && from < until) {
        for (const date of enumerateServiceDates(from, until)) invalidFutureDates.add(date);
        futureReviews.push({ id: `future-review:${order.id}`, date: from, metric: "REVIEW", label: "未来库存待核对", orderId: order.id, memberId: null, unitId: null, units: null, amountMinor: null, currency: null, registeredAt: null, businessDate: null,
          reason: `${reviewReason}；影响 ${from} 至 ${dashboardDate(until, -1)}（含首尾日期）。请核对原订单，未将未知占用视为空房。` });
      }
    }
  }
  const atomicUnits = units.filter(unit => unit.active && (unit.kind === "BED" ? unitsById.get(unit.parent_room_id!)?.active : !(children.get(unit.id) ?? []).some(bed => bed.active)));
  function matchingUnit(unit: typeof units[number], query: DashboardQuery) {
    const room = unit.kind === "ROOM" ? unit : unitsById.get(unit.parent_room_id!);
    return (!query.building || (room?.building_code ?? "未分配") === query.building) && (!query.roomType || (unit.room_type_code ?? room?.room_type_code ?? "未分配") === query.roomType);
  }
  function capacityFor(from: string, days: number, query: DashboardQuery): { value: number | null; reason: string } {
    return capacity.period(from, dashboardDate(from, days), query);
  }
  return { units, atomicUnits, matchingUnit, capacityFor, nights, reviews, orders, validOrderIds, invalidFutureDates, futureReviews, arrangements };
}
