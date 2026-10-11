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
  const capacityChanges = changes.filter(change => {
    const effect = change.effect as Record<string, unknown> | null;
    return !effect || (Array.isArray(effect.insertUnits) && effect.insertUnits.length > 0) || (Array.isArray(effect.retireUnitIds) && effect.retireUnitIds.length > 0) || ["SET_ROOM_ACTIVE", "SAVE_ROOM"].includes(String(effect.action));
  });
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
  const validOrderIds = new Set<string>();
  for (const order of orders) {
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
      if (order.status === "RESERVED") continue;
      const orderNights: DashboardStayNight[] = [];
      for (const interval of lifecycle.effectiveArrangement.intervals) {
        const unit = unitsById.get(interval.inventoryUnitId);
        if (!unit) throw new Error("历史房源不可核对");
        const room = unit.kind === "ROOM" ? unit : unitsById.get(unit.parent_room_id!);
        if (!room) throw new Error("父房不可核对");
        const from = interval.arrivalDate > range.from ? interval.arrivalDate : range.from;
        const until = interval.departureDate < businessDate ? interval.departureDate : businessDate;
        if (from >= until) continue;
        const beds = children.get(unit.id) ?? [];
        if (unit.kind === "ROOM" && beds.length && (beds.some(bed => !bed.active || localDate(bed.created_at) > from) || capacityChanges.some(change => localDate(change.created_at) >= from))) throw new Error("拆床容量的历史有效期不可核对");
        const weight = unit.kind === "ROOM" && beds.length ? beds.length : 1;
        for (const date of enumerateServiceDates(from, until)) orderNights.push({ orderId: order.id, date, unitId: unit.id, building: room.building_code ?? "未分配", roomType: unit.room_type_code ?? room.room_type_code ?? "未分配", source: dashboardSource(order), units: weight });
      }
      nights.push(...orderNights);
    } catch {
      if (order.status !== "RESERVED" && order.arrival_date <= range.to) reviews.push({ id: `stay-review:${order.id}`, date: order.arrival_date > range.from ? order.arrival_date : range.from, metric: "REVIEW", label: "住宿时间线待核对", orderId: order.id, memberId: null, unitId: null, units: null, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "有效住宿、履约或历史拆床容量证据不完整，未纳入已知单元夜" });
      const from = order.arrival_date > businessDate ? order.arrival_date : businessDate;
      const until = order.departure_date < futureUntil ? order.departure_date : futureUntil;
      if (order.status !== "CHECKED_OUT" && from < until) for (const date of enumerateServiceDates(from, until)) invalidFutureDates.add(date);
    }
  }
  const atomicUnits = units.filter(unit => unit.active && (unit.kind === "BED" ? unitsById.get(unit.parent_room_id!)?.active : !(children.get(unit.id) ?? []).some(bed => bed.active)));
  function matchingUnit(unit: typeof units[number], query: DashboardQuery) {
    const room = unit.kind === "ROOM" ? unit : unitsById.get(unit.parent_room_id!);
    return (!query.building || (room?.building_code ?? "未分配") === query.building) && (!query.roomType || (unit.room_type_code ?? room?.room_type_code ?? "未分配") === query.roomType);
  }
  function capacityFor(from: string, days: number, query: DashboardQuery): { value: number | null; reason: string } {
    const hasChanges = capacityChanges.some(change => localDate(change.created_at) >= from);
    const incomplete = units.some(unit => !unit.active || localDate(unit.created_at) > from);
    if (hasChanges || incomplete) return { value: null, reason: "目录增减、停用或拆床的历史容量尚不可完整还原，暂不展示比率" };
    return { value: atomicUnits.filter(unit => matchingUnit(unit, query)).length * days, reason: "按当前目录口径；查询期间至今未发现容量变更，不等同于完整历史容量模型" };
  }
  return { units, atomicUnits, matchingUnit, capacityFor, nights, reviews, orders, validOrderIds, invalidFutureDates };
}
