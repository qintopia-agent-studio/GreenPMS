import type { Transaction } from "kysely";
import { dashboardOrderStatuses, type DashboardDetail, type RoomCatalogSnapshot } from "@qintopia/contracts";
import { projectCurrentOrderOccupants } from "./current-order-guests.ts";
import { groupDashboardRows, type loadDashboardStays } from "./dashboard-stays.ts";
import { historicalProtocolEpochMigration, legacyEffectProtocol } from "./historical-command-protocol.ts";
import { projectOrderLifecycle } from "./orders.ts";
import type { Database } from "./schema.ts";

type Lodging = Pick<Awaited<ReturnType<typeof loadDashboardStays>>, "arrangements" | "units">;
const followUpMetrics = new Set(["TODAY_ORDERS", "DEBT", "RETAINED"]);

/** Enrich only the requested page. Existing amounts, row membership and summary counts stay untouched. */
export async function enrichDashboardOrderDetails(trx: Transaction<Database>, propertyId: string, businessDate: string, items: DashboardDetail[], lodging: Lodging): Promise<DashboardDetail[]> {
  const requested = items.filter(item => followUpMetrics.has(item.metric));
  const orderIds = [...new Set(requested.flatMap(item => item.orderId ? [item.orderId] : []))];
  if (!orderIds.length) return items;
  const retainedIds = requested.filter(item => item.metric === "RETAINED" && item.id.startsWith("retained:")).map(item => item.id.slice("retained:".length));
  const [orders, occupants, corrections, catalog, retained] = await Promise.all([
    trx.selectFrom("orders as o").leftJoin("stays as s", "s.order_id", "o.id")
      .select(["o.id", "o.status", "o.stay_type", "o.arrival_date", "o.departure_date", "o.current_revision_id", "o.version", "o.member_id", "o.member_contract_id", "o.booking_channel_code", "s.id as stay_id", "s.status as stay_status"])
      .where("o.property_id", "=", propertyId).where("o.id", "in", orderIds).execute(),
    trx.selectFrom("active_order_occupants").selectAll().where("order_id", "in", orderIds).orderBy("ordinal").execute(),
    trx.selectFrom("order_occupant_corrections").selectAll().where("order_id", "in", orderIds).execute(),
    trx.selectFrom("room_catalog_state").select("snapshot").where("property_id", "=", propertyId).executeTakeFirst(),
    retainedIds.length ? trx.selectFrom("retained_funds").select(["id", "source_order_id", "owner_name"]).where("property_id", "=", propertyId).where("id", "in", retainedIds).execute() : []
  ]);
  const arrangements = new Map(lodging.arrangements);
  // Future, historical and terminal orders can be absent from the dashboard's lodging window.
  // Project those orders with the same lifecycle checks instead of guessing from the last segment.
  const missing = orders.filter(order => !arrangements.has(order.id) && order.stay_id && order.stay_status);
  if (missing.length) {
    const ids = missing.map(order => order.id);
    const [segments, amendments, revisions, facts, active, epochRows] = await Promise.all([
      trx.selectFrom("stay_segments as segment").innerJoin("stays as stay", "stay.id", "segment.stay_id").selectAll("segment").where("stay.order_id", "in", ids).orderBy("segment.sequence").execute(),
      trx.selectFrom("amendments as a").leftJoin("command_executions as c", "c.id", "a.command_id").leftJoin("subjects as subject", "subject.id", "c.subject_id")
        .selectAll("a").select(["c.subject_id as actor_subject_id", "subject.display_name as actor_display_name"]).where("a.order_id", "in", ids).orderBy("a.sequence").execute(),
      trx.selectFrom("pricing_revisions").select(["id", "order_id", "revision_no", "amendment_id", "arrival_date", "departure_date", "policy_base_amount_minor", "current_contract_amount_minor", "currency"]).where("order_id", "in", ids).orderBy("revision_no").execute(),
      trx.selectFrom("collection_facts").select(["order_id", "net_effect_minor", "currency", "created_at"]).where("order_id", "in", ids).execute(),
      trx.selectFrom("inventory_claims as claim").innerJoin("stay_segments as segment", "segment.id", "claim.source_id").innerJoin("stays as stay", "stay.id", "segment.stay_id")
        .select(["stay.order_id", "claim.service_date", "claim.inventory_unit_id"]).where("claim.source_type", "=", "ORDER_SEGMENT").where("claim.active", "=", true).where("claim.property_id", "=", propertyId).where("stay.order_id", "in", ids).orderBy("claim.service_date").execute(),
      trx.selectFrom("schema_migrations").select(["name", "applied_at"]).where("name", "in", ["028_stage11_move_unit_guards.sql", "044_inhouse_membership_fulfillment_guards.sql"]).execute()
    ]);
    const epochs = new Map(epochRows.map(row => [row.name, row.applied_at]));
    const byStay = groupDashboardRows(segments, row => row.stay_id), byAmendment = groupDashboardRows(amendments, row => row.order_id), byRevision = groupDashboardRows(revisions, row => row.order_id), byFact = groupDashboardRows(facts, row => row.order_id), byActive = groupDashboardRows(active, row => row.order_id);
    for (const order of missing) {
      try {
        const normalized = (byAmendment.get(order.id) ?? []).map(amendment => {
          const protocolVersion = legacyEffectProtocol(amendment.amendment_type, amendment.payload);
          if (!protocolVersion) return amendment;
          const epoch = epochs.get(historicalProtocolEpochMigration(protocolVersion));
          if (!epoch || new Date(amendment.created_at) >= new Date(epoch)) throw new Error("历史协议证据不可核对");
          return { ...amendment, protocolVersion };
        });
        const lifecycle = projectOrderLifecycle({ order, stay: { id: order.stay_id!, status: order.stay_status! }, businessDate,
          segments: byStay.get(order.stay_id!) ?? [], amendments: normalized, revisions: byRevision.get(order.id) ?? [], facts: byFact.get(order.id) ?? [],
          activeTimeline: (byActive.get(order.id) ?? []).map(row => ({ serviceDate: row.service_date, inventoryUnitId: row.inventory_unit_id })) });
        arrangements.set(order.id, lifecycle.effectiveArrangement.intervals);
      } catch {
        // Keep the existing fact visible even when its accommodation evidence needs review.
      }
    }
  }
  const people = groupDashboardRows(projectCurrentOrderOccupants(occupants, corrections), person => person.orderId);
  const unitCodes = (catalog?.snapshot as unknown as RoomCatalogSnapshot | undefined)?.unitCodes ?? {};
  const units = new Map(lodging.units.map(unit => [unit.id, unit]));
  const summaries = new Map<string, NonNullable<DashboardDetail["orderSummary"]>>();
  for (const order of orders) {
    if (!(dashboardOrderStatuses as readonly string[]).includes(order.status)) continue;
    const roomIds = [...new Set((arrangements.get(order.id) ?? []).map(interval => interval.inventoryUnitId))];
    const rooms = roomIds.every(id => units.has(id)) ? roomIds.map(id => {
      const unit = units.get(id)!;
      const room = unit.kind === "BED" ? units.get(unit.parent_room_id!) : unit;
      const currentLabel = unit.active && (order.status === "RESERVED" || order.status === "CHECKED_IN");
      return { roomCode: currentLabel ? unitCodes[id] ?? unit.code : unit.code, buildingCode: room?.building_code ?? null };
    }) : [];
    summaries.set(order.id, {
      occupants: (people.get(order.id) ?? []).map(person => {
        const nickname = person.nickname?.trim(), fullName = person.fullName?.trim();
        return { name: nickname && fullName && nickname !== fullName ? `${nickname}（${fullName}）` : nickname || fullName || `第 ${person.ordinal} 位住客`, isPrimary: person.role === "PRIMARY" };
      }), rooms, arrivalDate: order.arrival_date, departureDate: order.departure_date, status: order.status as NonNullable<DashboardDetail["orderSummary"]>["status"]
    });
  }
  const retainedById = new Map(retained.map(row => [`retained:${row.id}`, row]));
  return items.map(item => {
    if (!followUpMetrics.has(item.metric)) return item;
    const summary = item.orderId ? summaries.get(item.orderId) : undefined;
    const lot = retainedById.get(item.id);
    return { ...item, ...(summary ? { orderSummary: summary } : {}),
      ...(item.metric === "RETAINED" ? { retainedOwnerName: lot?.source_order_id === item.orderId ? lot.owner_name : null } : {}) };
  });
}
