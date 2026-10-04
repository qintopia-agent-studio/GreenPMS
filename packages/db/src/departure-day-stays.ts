import { sql } from "kysely";
import { DomainError } from "@qintopia/contracts";
import { propertyLocalClockAt } from "./members.ts";
import type { DbExecutor, InventoryUnitRecord } from "./inventory.ts";

export interface DepartureDayStayBlocker {
  orderId: string;
  stayId: string;
  segmentId: string;
  inventoryUnitId: string;
  roomId: string;
  serviceDate: string;
}

export async function loadDepartureDayStayBlockers(
  db: DbExecutor,
  propertyId: string,
  dates: readonly string[]
): Promise<DepartureDayStayBlocker[]> {
  if (dates.length === 0) return [];
  const property = await db.selectFrom("properties").select("timezone").where("id", "=", propertyId).executeTakeFirst();
  if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
  const clock = await sql<{ as_of: Date }>`select transaction_timestamp() as as_of`.execute(db);
  const businessDate = propertyLocalClockAt(property.timezone, clock.rows[0]!.as_of).date;
  if (!dates.includes(businessDate)) return [];

  const orderRows = await db.selectFrom("orders")
    .select(["id", "status"])
    .where("property_id", "=", propertyId)
    .where("departure_date", "=", businessDate)
    .where("status", "=", "CHECKED_IN")
    .orderBy("id")
    .execute();
  const orderIds = orderRows.map((row) => row.id);
  if (orderIds.length === 0) return [];

  const segmentRows = await db.selectFrom("stays as stay")
    .innerJoin("stay_segments as segment", "segment.stay_id", "stay.id")
    .innerJoin("inventory_units as unit", "unit.id", "segment.inventory_unit_id")
    .select([
      "stay.order_id", "stay.id as stay_id", "segment.id as segment_id", "segment.inventory_unit_id",
      "segment.sequence", "unit.kind", "unit.parent_room_id"
    ])
    .where("stay.order_id", "in", orderIds)
    .orderBy("stay.order_id")
    .orderBy("segment.sequence", "desc")
    .execute();
  const latestByOrder = new Map<string, typeof segmentRows[number]>();
  for (const row of segmentRows) {
    if (!latestByOrder.has(row.order_id)) latestByOrder.set(row.order_id, row);
  }
  return [...latestByOrder.values()].map((row) => ({
    orderId: row.order_id,
    stayId: row.stay_id,
    segmentId: row.segment_id,
    inventoryUnitId: row.inventory_unit_id,
    roomId: row.kind === "ROOM" ? row.inventory_unit_id : row.parent_room_id!,
    serviceDate: businessDate
  }));
}

export function departureDayBlockerAffectsUnit(blocker: DepartureDayStayBlocker, unit: Pick<InventoryUnitRecord, "id" | "kind" | "roomId">): boolean {
  return blocker.roomId === unit.roomId
    && (unit.kind === "ROOM" || blocker.inventoryUnitId === blocker.roomId || blocker.inventoryUnitId === unit.id);
}

// Read under the same room-day lock as checkout at confirmation; never lock a foreign order.
export async function previousStayAwaitingCheckout(db: DbExecutor, propertyId: string, unitId: string, businessDate: string, orderId: string): Promise<boolean> {
  const row = await db.selectFrom("inventory_units").select(["id", "kind", "parent_room_id"])
    .where("property_id", "=", propertyId).where("id", "=", unitId).executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Inventory unit not found", 404);
  const unit = { id: row.id, kind: row.kind, roomId: row.kind === "ROOM" ? row.id : row.parent_room_id! };
  const blockers = await loadDepartureDayStayBlockers(db, propertyId, [businessDate]);
  return blockers.some((blocker) => blocker.orderId !== orderId && departureDayBlockerAffectsUnit(blocker, unit));
}
