import { projectCatalogUnitNames } from "./room-catalog-labels.ts";
import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type InventoryUnitKind } from "@qintopia/contracts";
import { enumerateServiceDates, newId } from "@qintopia/domain";
import { loadDepartureDayStayBlockers, departureDayBlockerAffectsUnit, type DepartureDayStayBlocker } from "./departure-day-stays.ts";
export { previousStayAwaitingCheckout } from "./departure-day-stays.ts";
import { getOrderViewSnapshot } from "./orders.ts";
import { roomStatusSourceMetadataDamageReason, ordinaryStayMoneyAttention } from "./lodging-integrity.ts";
import type { Database } from "./schema.ts";

export type InventoryPurpose = "LODGING_NIGHTS" | "PHYSICAL_USE";

export type DbExecutor = Kysely<Database> | Transaction<Database>;

export interface InventoryUnitRecord {
  id: string;
  propertyId: string;
  kind: InventoryUnitKind;
  roomId: string;
  code: string;
  name: string;
  catalogVersion: string | null;
  buildingCode: string | null;
  roomTypeCode: string | null;
  pricingProductCode: string | null;
  inventoryBasis: "INDEPENDENT" | "WHOLE_ROOM_COMBINATION" | null;
  codeProvenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED" | null;
  physicalBedCount: number | null;
  occupancyCapacity: number;
}

export interface AvailabilityNight {
  serviceDate: string;
  available: boolean;
  blockingClaimIds: string[];
}

export interface UnitAvailability extends InventoryUnitRecord {
  nights: AvailabilityNight[];
  available: boolean;
}

interface DeferredUnavailableBlocker {
  id: string;
  inventoryUnitId: string;
  roomId: string;
  arrivalDate: string;
  departureDate: string;
}

async function loadDeferredUnavailableBlockers(
  db: DbExecutor,
  propertyId: string,
  dates: readonly string[]
): Promise<DeferredUnavailableBlocker[]> {
  if (dates.length === 0) return [];
  const firstDate = [...dates].sort()[0]!;
  const lastDate = [...dates].sort().at(-1)!;
  const rows = await db.selectFrom("internal_use_blocks")
    .select(["id", "inventory_unit_id", "room_id", "arrival_date", "departure_date"])
    .where("property_id", "=", propertyId)
    .where("status", "=", "ACTIVE")
    .where("arrival_date", "<=", lastDate)
    .where("departure_date", ">", firstDate)
    .orderBy("id")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    inventoryUnitId: row.inventory_unit_id,
    roomId: row.room_id,
    arrivalDate: row.arrival_date,
    departureDate: row.departure_date
  }));
}

function deferredUnavailableBlockerAffectsUnit(
  blocker: DeferredUnavailableBlocker,
  unit: Pick<InventoryUnitRecord, "id" | "kind" | "roomId">
): boolean {
  return blocker.roomId === unit.roomId
    && (unit.kind === "ROOM" || blocker.inventoryUnitId === blocker.roomId || blocker.inventoryUnitId === unit.id);
}

async function loadInventoryUnitRecord(db: DbExecutor, propertyId: string, unitId: string, requireActive: boolean): Promise<InventoryUnitRecord> {
  let query = db.selectFrom("inventory_units")
    .select(["active", "id", "property_id", "kind", "parent_room_id", "code", "name", "catalog_version", "building_code", "room_type_code", "pricing_product_code", "inventory_basis", "code_provenance", "physical_bed_count", "occupancy_capacity"])
    .where("id", "=", unitId)
    .where("property_id", "=", propertyId);
  if (requireActive) query = query.where("active", "=", true);
  const row = await query.executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Inventory unit not found", 404);
  if (requireActive && row.kind === "BED") {
    const parent = await db.selectFrom("inventory_units").select("id").where("id", "=", row.parent_room_id!).where("property_id", "=", propertyId).where("active", "=", true).executeTakeFirst();
    if (!parent) throw new DomainError("NOT_FOUND", "父房间已停用，床位不可售", 404);
  }
  // Command snapshots must match canonical database inventory facts.
  // Catalog labels are projected only by read/presentation endpoints.
  return {
    id: row.id,
    propertyId: row.property_id,
    kind: row.kind,
    roomId: row.kind === "ROOM" ? row.id : row.parent_room_id!,
    code: row.code,
    name: row.name,
    catalogVersion: row.catalog_version,
    buildingCode: row.building_code,
    roomTypeCode: row.room_type_code,
    pricingProductCode: row.pricing_product_code,
    inventoryBasis: row.inventory_basis,
    codeProvenance: row.code_provenance,
    physicalBedCount: row.physical_bed_count,
    occupancyCapacity: row.occupancy_capacity
  };
}

export async function loadInventoryUnit(db: DbExecutor, propertyId: string, unitId: string): Promise<InventoryUnitRecord> {
  return loadInventoryUnitRecord(db, propertyId, unitId, true);
}

export async function loadInventoryUnitIncludingInactive(db: DbExecutor, propertyId: string, unitId: string): Promise<InventoryUnitRecord> {
  return loadInventoryUnitRecord(db, propertyId, unitId, false);
}

export async function listAvailability(
  db: DbExecutor,
  propertyId: string,
  arrivalDate: string,
  departureDate: string,
  kind?: InventoryUnitKind,
  excludeOrderId?: string,
  purpose: InventoryPurpose = "LODGING_NIGHTS"
): Promise<UnitAvailability[]> {
  const dates = enumerateServiceDates(arrivalDate, departureDate);
  let excludedSegmentIds = new Set<string>();
  if (excludeOrderId) {
    const order = await db.selectFrom("orders")
      .select(["id", "status"])
      .where("id", "=", excludeOrderId)
      .where("property_id", "=", propertyId)
      .executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "Order not found", 404);
    if (order.status === "CHECKED_IN") purpose = "PHYSICAL_USE";
    const rows = await db.selectFrom("stays as stay")
      .innerJoin("stay_segments as segment", "segment.stay_id", "stay.id")
      .select("segment.id")
      .where("stay.order_id", "=", excludeOrderId)
      .execute();
    excludedSegmentIds = new Set(rows.map((row) => row.id));
  }
  let query = db.selectFrom("inventory_units")
    .select(["active", "id", "property_id", "kind", "parent_room_id", "code", "name", "catalog_version", "building_code", "room_type_code", "pricing_product_code", "inventory_basis", "code_provenance", "physical_bed_count", "occupancy_capacity"])
    .where("property_id", "=", propertyId)
    .where("active", "=", true);
  if (kind) query = query.where("kind", "=", kind);
  const candidates = await projectCatalogUnitNames(db, await query.orderBy("code").execute());
  const activeRooms = new Set((await db.selectFrom("inventory_units").select("id").where("property_id", "=", propertyId).where("kind", "=", "ROOM").where("active", "=", true).execute()).map((row) => row.id));
  const units = candidates.filter((unit) => unit.kind === "ROOM" || activeRooms.has(unit.parent_room_id!));
  const claims = await db.selectFrom("inventory_claims")
    .select(["id", "room_id", "inventory_unit_id", "service_date", "source_type", "source_id"])
    .where("property_id", "=", propertyId)
    .where("active", "=", true)
    .where("service_date", ">=", arrivalDate)
    .where("service_date", "<", departureDate)
    .execute();
  const departureDayStayBlockers = await loadInventoryDepartureBlockers(db, propertyId, dates, purpose, { excludeSourceIds: [...excludedSegmentIds] });
  const deferredUnavailableBlockers = await loadDeferredUnavailableBlockers(db, propertyId, dates);

  return units.map((unit) => {
    const roomId = unit.kind === "ROOM" ? unit.id : unit.parent_room_id!;
    const nights = dates.map((serviceDate) => {
      const blocking = claims.filter((claim) => (
        claim.source_type !== "ORDER_SEGMENT" || !excludedSegmentIds.has(claim.source_id)
      ) && claim.service_date === serviceDate && claim.room_id === roomId && (
        unit.kind === "ROOM" || claim.inventory_unit_id === roomId || claim.inventory_unit_id === unit.id
      ));
      const blockingStays = departureDayStayBlockers.filter((blocker) => blocker.orderId !== excludeOrderId && blocker.serviceDate === serviceDate && departureDayBlockerAffectsUnit(blocker, {
        id: unit.id,
        kind: unit.kind,
        roomId
      }));
      const blockingDeferredUnavailable = deferredUnavailableBlockers.filter((blocker) => (
        blocker.arrivalDate <= serviceDate
        && serviceDate < blocker.departureDate
        && deferredUnavailableBlockerAffectsUnit(blocker, { id: unit.id, kind: unit.kind, roomId })
      ));
      return {
        serviceDate,
        available: blocking.length === 0 && blockingStays.length === 0 && blockingDeferredUnavailable.length === 0,
        blockingClaimIds: blocking.map((claim) => claim.id)
      };
    });
    return {
      id: unit.id,
      propertyId: unit.property_id,
      kind: unit.kind,
      roomId,
      code: unit.code,
      name: unit.name,
      catalogVersion: unit.catalog_version,
      buildingCode: unit.building_code,
      roomTypeCode: unit.room_type_code,
      pricingProductCode: unit.pricing_product_code,
      inventoryBasis: unit.inventory_basis,
      codeProvenance: unit.code_provenance,
      physicalBedCount: unit.physical_bed_count,
      occupancyCapacity: unit.occupancy_capacity,
      nights,
      available: nights.every((night) => night.available)
    };
  });
}

export async function inventoryFingerprint(db: DbExecutor, propertyId: string, unitId: string, arrivalDate: string, departureDate: string, excludeSourceIds: string[] = [], purpose: InventoryPurpose = "PHYSICAL_USE"): Promise<string[]> {
  const unit = await loadInventoryUnit(db, propertyId, unitId);
  const dates = enumerateServiceDates(arrivalDate, departureDate);
  let query = db.selectFrom("inventory_claims")
    .select(["id", "inventory_unit_id", "service_date", "source_id"])
    .where("property_id", "=", propertyId)
    .where("room_id", "=", unit.roomId)
    .where("active", "=", true)
    .where("service_date", ">=", arrivalDate)
    .where("service_date", "<", departureDate);
  if (excludeSourceIds.length > 0) query = query.where("source_id", "not in", excludeSourceIds);
  const claims = await query.orderBy("service_date").orderBy("id").execute();
  const claimFingerprint = claims
    .filter((claim) => unit.kind === "ROOM" || claim.inventory_unit_id === unit.roomId || claim.inventory_unit_id === unit.id)
    .map((claim) => `${claim.service_date}:${claim.inventory_unit_id}:${claim.id}`);
  const stayFingerprint = (await loadInventoryDepartureBlockers(db, propertyId, dates, purpose, { unit, excludeSourceIds }))
    .map((blocker) => `${blocker.serviceDate}:DEPARTURE_DAY_STAY:${blocker.inventoryUnitId}:${blocker.stayId}`);
  const deferredUnavailableFingerprint = (await loadDeferredUnavailableBlockers(db, propertyId, dates))
    .filter((blocker) => deferredUnavailableBlockerAffectsUnit(blocker, unit))
    .flatMap((blocker) => dates
      .filter((serviceDate) => blocker.arrivalDate <= serviceDate && serviceDate < blocker.departureDate)
      .map((serviceDate) => `${serviceDate}:LEGACY_UNAVAILABLE:${blocker.inventoryUnitId}:${blocker.id}`));
  return [...claimFingerprint, ...stayFingerprint, ...deferredUnavailableFingerprint];
}

export async function lockRoomDays(trx: Transaction<Database>, roomDates: Array<{ roomId: string; serviceDate: string }>): Promise<void> {
  const unique = [...new Map(roomDates.map((item) => [`${item.roomId}:${item.serviceDate}`, item])).values()]
    .sort((left, right) => `${left.roomId}:${left.serviceDate}`.localeCompare(`${right.roomId}:${right.serviceDate}`));
  for (const item of unique) {
    await trx.insertInto("inventory_room_days")
      .values({ room_id: item.roomId, service_date: item.serviceDate, whole_claim_id: null, version: 0 })
      .onConflict((oc) => oc.columns(["room_id", "service_date"]).doNothing())
      .execute();
    await trx.selectFrom("inventory_room_days")
      .select("room_id")
      .where("room_id", "=", item.roomId)
      .where("service_date", "=", item.serviceDate)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }
}

export async function lockUnitDates(trx: Transaction<Database>, propertyId: string, unitId: string, arrivalDate: string, departureDate: string, allowInactive = false): Promise<InventoryUnitRecord> {
  const unit = allowInactive
    ? await loadInventoryUnitIncludingInactive(trx, propertyId, unitId)
    : await loadInventoryUnit(trx, propertyId, unitId);
  await lockRoomDays(trx, enumerateServiceDates(arrivalDate, departureDate).map((serviceDate) => ({ roomId: unit.roomId, serviceDate })));
  return unit;
}

export async function assertUnitAvailable(trx: Transaction<Database>, unit: InventoryUnitRecord, dates: string[], excludeSourceIds: string[] = [], purpose: InventoryPurpose = "PHYSICAL_USE"): Promise<void> {
  const departureDayStayBlockers = await loadInventoryDepartureBlockers(trx, unit.propertyId, dates, purpose, { unit, excludeSourceIds });
  const deferredUnavailableBlockers = (await loadDeferredUnavailableBlockers(trx, unit.propertyId, dates))
    .filter((blocker) => !excludeSourceIds.includes(blocker.id) && deferredUnavailableBlockerAffectsUnit(blocker, unit));
  for (const serviceDate of dates) {
    const blockingStay = departureDayStayBlockers.find((blocker) => blocker.serviceDate === serviceDate);
    if (blockingStay) {
      throw new DomainError("INVENTORY_CONFLICT", `An in-house Stay is awaiting departure on ${serviceDate}`, 409);
    }
    const blockingDeferredUnavailable = deferredUnavailableBlockers.find((blocker) => (
      blocker.arrivalDate <= serviceDate && serviceDate < blocker.departureDate
    ));
    if (blockingDeferredUnavailable) {
      throw new DomainError("INVENTORY_CONFLICT", `Inventory is unavailable on ${serviceDate}`, 409);
    }
    const roomDay = await trx.selectFrom("inventory_room_days")
      .select("whole_claim_id")
      .where("room_id", "=", unit.roomId)
      .where("service_date", "=", serviceDate)
      .executeTakeFirstOrThrow();
    if (roomDay.whole_claim_id) {
      const claim = await trx.selectFrom("inventory_claims").select(["id", "source_id"]).where("id", "=", roomDay.whole_claim_id).executeTakeFirst();
      if (claim && !excludeSourceIds.includes(claim.source_id)) {
        throw new DomainError("INVENTORY_CONFLICT", `Inventory is unavailable on ${serviceDate}`, 409, false, { serviceDate, claimId: claim.id });
      }
    }
    if (unit.kind === "ROOM") {
      let bedQuery = trx.selectFrom("inventory_bed_days")
        .innerJoin("inventory_claims", "inventory_claims.id", "inventory_bed_days.bed_claim_id")
        .select(["inventory_claims.id", "inventory_claims.source_id"])
        .where("inventory_bed_days.room_id", "=", unit.roomId)
        .where("inventory_bed_days.service_date", "=", serviceDate)
        .where("inventory_claims.active", "=", true);
      if (excludeSourceIds.length > 0) bedQuery = bedQuery.where("inventory_claims.source_id", "not in", excludeSourceIds);
      const bedClaim = await bedQuery.executeTakeFirst();
      if (bedClaim) throw new DomainError("INVENTORY_CONFLICT", `A bed is occupied on ${serviceDate}`, 409, false, { serviceDate, claimId: bedClaim.id });
    } else {
      const bedDay = await trx.selectFrom("inventory_bed_days")
        .leftJoin("inventory_claims", "inventory_claims.id", "inventory_bed_days.bed_claim_id")
        .select(["inventory_bed_days.bed_claim_id", "inventory_claims.source_id"])
        .where("inventory_bed_days.bed_id", "=", unit.id)
        .where("inventory_bed_days.service_date", "=", serviceDate)
        .executeTakeFirst();
      if (bedDay?.bed_claim_id && (!bedDay.source_id || !excludeSourceIds.includes(bedDay.source_id))) {
        throw new DomainError("INVENTORY_CONFLICT", `Bed is unavailable on ${serviceDate}`, 409, false, { serviceDate, claimId: bedDay.bed_claim_id });
      }
    }
  }
}

export async function createInventoryClaims(trx: Transaction<Database>, options: {
  propertyId: string;
  unit: InventoryUnitRecord;
  dates: string[];
  sourceType: "ORDER_SEGMENT" | "MAINTENANCE" | "INTERNAL_USE";
  sourceId: string;
  excludeSourceIds?: string[];
  purpose?: InventoryPurpose;
}): Promise<string[]> {
  await assertUnitAvailable(trx, options.unit, options.dates, options.excludeSourceIds, options.purpose);
  const claimIds: string[] = [];
  for (const serviceDate of options.dates) {
    const claimId = newId("claim");
    await trx.insertInto("inventory_claims").values({
      id: claimId,
      property_id: options.propertyId,
      room_id: options.unit.roomId,
      inventory_unit_id: options.unit.id,
      service_date: serviceDate,
      source_type: options.sourceType,
      source_id: options.sourceId,
      active: true,
      released_at: null
    }).execute();
    if (options.unit.kind === "ROOM") {
      await trx.updateTable("inventory_room_days")
        .set({ whole_claim_id: claimId, version: sql`version + 1`, updated_at: new Date() })
        .where("room_id", "=", options.unit.roomId)
        .where("service_date", "=", serviceDate)
        .executeTakeFirstOrThrow();
    } else {
      await trx.insertInto("inventory_bed_days")
        .values({ room_id: options.unit.roomId, bed_id: options.unit.id, service_date: serviceDate, bed_claim_id: null, version: 0 })
        .onConflict((oc) => oc.columns(["bed_id", "service_date"]).doNothing())
        .execute();
      await trx.updateTable("inventory_bed_days")
        .set({ bed_claim_id: claimId, version: sql`version + 1`, updated_at: new Date() })
        .where("bed_id", "=", options.unit.id)
        .where("service_date", "=", serviceDate)
        .executeTakeFirstOrThrow();
    }
    claimIds.push(claimId);
  }
  return claimIds;
}

export async function releaseInventoryClaims(trx: Transaction<Database>, sourceType: "ORDER_SEGMENT" | "MAINTENANCE" | "INTERNAL_USE", sourceIds: string[], fromDate?: string): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  let query = trx.selectFrom("inventory_claims")
    .selectAll()
    .where("source_type", "=", sourceType)
    .where("source_id", "in", sourceIds)
    .where("active", "=", true);
  if (fromDate) query = query.where("service_date", ">=", fromDate);
  const claims = await query.orderBy("room_id").orderBy("service_date").execute();
  for (const claim of claims) {
    const unit = await trx.selectFrom("inventory_units").select("kind").where("id", "=", claim.inventory_unit_id).executeTakeFirstOrThrow();
    let pointerUpdate;
    if (unit.kind === "ROOM") {
      pointerUpdate = await trx.updateTable("inventory_room_days")
        .set({ whole_claim_id: null, version: sql`version + 1`, updated_at: new Date() })
        .where("room_id", "=", claim.room_id)
        .where("service_date", "=", claim.service_date)
        .where("whole_claim_id", "=", claim.id)
        .executeTakeFirst();
    } else {
      pointerUpdate = await trx.updateTable("inventory_bed_days")
        .set({ bed_claim_id: null, version: sql`version + 1`, updated_at: new Date() })
        .where("bed_id", "=", claim.inventory_unit_id)
        .where("service_date", "=", claim.service_date)
        .where("bed_claim_id", "=", claim.id)
        .executeTakeFirst();
    }
    if (pointerUpdate.numUpdatedRows !== 1n) {
      throw new DomainError("INTERNAL_ERROR", "库存占用指针损坏，不能释放库存", 500, false, {
        claimId: claim.id,
        inventoryUnitId: claim.inventory_unit_id,
        serviceDate: claim.service_date
      });
    }
    const claimUpdate = await trx.updateTable("inventory_claims")
      .set({ active: false, released_at: new Date() })
      .where("id", "=", claim.id)
      .where("active", "=", true)
      .executeTakeFirst();
    if (claimUpdate.numUpdatedRows !== 1n) {
      throw new DomainError("INTERNAL_ERROR", "库存占用记录损坏，不能释放库存", 500, false, { claimId: claim.id });
    }
  }
  return claims.map((claim) => claim.id);
}

export async function releaseInventoryClaimsOnDates(
  trx: Transaction<Database>,
  sourceType: "ORDER_SEGMENT" | "MAINTENANCE" | "INTERNAL_USE",
  sourceIds: string[],
  serviceDates: string[]
): Promise<string[]> {
  if (sourceIds.length === 0 || serviceDates.length === 0) return [];
  const claims = await trx.selectFrom("inventory_claims")
    .selectAll()
    .where("source_type", "=", sourceType)
    .where("source_id", "in", sourceIds)
    .where("service_date", "in", [...new Set(serviceDates)].sort())
    .where("active", "=", true)
    .orderBy("room_id")
    .orderBy("service_date")
    .orderBy("id")
    .execute();
  for (const claim of claims) {
    const unit = await trx.selectFrom("inventory_units").select("kind").where("id", "=", claim.inventory_unit_id).executeTakeFirstOrThrow();
    let pointerUpdate;
    if (unit.kind === "ROOM") {
      pointerUpdate = await trx.updateTable("inventory_room_days")
        .set({ whole_claim_id: null, version: sql`version + 1`, updated_at: new Date() })
        .where("room_id", "=", claim.room_id)
        .where("service_date", "=", claim.service_date)
        .where("whole_claim_id", "=", claim.id)
        .executeTakeFirst();
    } else {
      pointerUpdate = await trx.updateTable("inventory_bed_days")
        .set({ bed_claim_id: null, version: sql`version + 1`, updated_at: new Date() })
        .where("bed_id", "=", claim.inventory_unit_id)
        .where("service_date", "=", claim.service_date)
        .where("bed_claim_id", "=", claim.id)
        .executeTakeFirst();
    }
    if (pointerUpdate.numUpdatedRows !== 1n) {
      throw new DomainError("INTERNAL_ERROR", "库存占用指针损坏，不能调整住宿日期", 500, false, {
        claimId: claim.id,
        inventoryUnitId: claim.inventory_unit_id,
        serviceDate: claim.service_date
      });
    }
    const claimUpdate = await trx.updateTable("inventory_claims")
      .set({ active: false, released_at: new Date() })
      .where("id", "=", claim.id)
      .where("active", "=", true)
      .executeTakeFirst();
    if (claimUpdate.numUpdatedRows !== 1n) {
      throw new DomainError("INTERNAL_ERROR", "库存占用记录损坏，不能调整住宿日期", 500, false, { claimId: claim.id });
    }
  }
  return claims.map((claim) => claim.id);
}

async function loadInventoryDepartureBlockers(
  db: DbExecutor, propertyId: string, dates: readonly string[], purpose: InventoryPurpose,
  scope: { unit?: Pick<InventoryUnitRecord, "id" | "kind" | "roomId">; excludeSourceIds?: readonly string[] } = {}
): Promise<DepartureDayStayBlocker[]> {
  // Filter before reading order integrity: an unrelated bed must not trigger a
  // full order read, and the caller's own excluded segments need no validation.
  const blockers = (await loadDepartureDayStayBlockers(db, propertyId, dates)).filter((blocker) =>
    !scope.excludeSourceIds?.includes(blocker.segmentId)
    && (!scope.unit || departureDayBlockerAffectsUnit(blocker, scope.unit)));
  if (purpose !== "LODGING_NIGHTS") return blockers;
  const damaged: DepartureDayStayBlocker[] = [];
  for (const blocker of blockers) {
    try {
      // Reuse the authoritative order reader's lifecycle, immutable amendment,
      // revision and active-Claim timeline checks; never lock another order here.
      const view = await getOrderViewSnapshot(db, blocker.orderId, "READ");
      if (view.order.status !== "CHECKED_IN" || view.stay.status !== "IN_HOUSE"
        || roomStatusSourceMetadataDamageReason(view.order.stay_type === "FREE" ? "FREE_STAY" : "ORDER", view.order)) {
        damaged.push(blocker);
        continue;
      }
      if (view.order.stay_type !== "FREE" && !view.order.member_id && !view.order.member_contract_id
        && (view.order.booking_channel_code === null || view.order.booking_channel_code === "WECOM")) {
        if (view.coverageSet.length > 0) throw new DomainError("INTERNAL_ERROR", "当前住宿的会员覆盖关系无法核对", 500);
        ordinaryStayMoneyAttention({ order: view.order, revisions: view.pricingRevisions, facts: view.collectionFacts,
          currentTimeline: view.effectiveArrangement.intervals.flatMap((interval) =>
            enumerateServiceDates(interval.arrivalDate, interval.departureDate).map((serviceDate) => ({ serviceDate, inventoryUnitId: interval.inventoryUnitId }))) });
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      damaged.push(blocker);
    }
  }
  return damaged;
}
