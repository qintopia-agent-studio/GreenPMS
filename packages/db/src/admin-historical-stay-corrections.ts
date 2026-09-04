import { sql, type Transaction } from "kysely";
import {
  DomainError,
  type CommandReason,
  type CreateOrderPricingBasis
} from "@qintopia/contracts";
import { enumerateServiceDates, newId, parseLocalDate, stableHash } from "@qintopia/domain";
import {
  createInventoryClaims,
  inventoryFingerprint,
  loadInventoryUnit,
  loadInventoryUnitIncludingInactive,
  lockUnitDates,
  releaseInventoryClaims,
  type DbExecutor,
  type InventoryUnitRecord
} from "./inventory.ts";
import {
  getOrderViewSnapshot,
  loadOrderContext,
  orderAmountSummary,
  type OrderContext,
  type StayTimelineItem
} from "./orders.ts";
import { propertyLocalToday } from "./members.ts";
import type { Database } from "./schema.ts";

export const HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND = "CORRECT_HISTORICAL_STAY_ARRANGEMENTS";
export const HISTORICAL_STAY_ARRANGEMENT_CORRECTION_AMENDMENT = "CORRECT_HISTORICAL_STAY_ARRANGEMENT";

interface NormalizedHistoricalCorrectionItem {
  orderId: string;
  expectedVersion: number;
  target: {
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  };
}

interface NormalizedHistoricalCorrectionInput extends Record<string, unknown> {
  propertyId: string;
  correctionSet: NormalizedHistoricalCorrectionItem[];
  evidenceNote?: string;
}

interface LoadedHistoricalCorrectionItem extends NormalizedHistoricalCorrectionItem {
  stayId: string;
  context: OrderContext;
  before: {
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
    stayTimeline: StayTimelineItem[];
  };
  after: {
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
    stayTimeline: StayTimelineItem[];
  };
  beforeUnit: InventoryUnitRecord;
  targetUnit: InventoryUnitRecord;
  occupants: HistoricalCorrectionOccupant[];
  collectionFacts: Array<{
    fact_id: string;
    fact_type: "COLLECTION" | "REFUND" | "REVERSAL";
    amount_minor: number;
    net_effect_minor: number;
    currency: string;
    references_fact_id: string | null;
    reverses_fact_id: string | null;
    method: string;
    transaction_reference: string | null;
    pricing_revision_id: string | null;
    command_id: string;
    created_at: Date | string;
  }>;
  currentRevision: {
    id: string;
    revision_no: number;
    amendment_id: string;
    policy_version_id: string;
    arrival_date: string;
    departure_date: string;
    coverage_set: unknown;
    cash_lines: unknown;
    policy_base_amount_minor: number;
    pricing_basis: CreateOrderPricingBasis;
    manual_adjustment_minor: number;
    current_contract_amount_minor: number;
    currency: string;
  };
}

interface HistoricalCorrectionOccupant {
  ordinal: number;
  role: "PRIMARY" | "ADDITIONAL";
  fullName: string | null;
  nickname: string | null;
}

interface HistoricalCorrectionEffectItem {
  orderId: string;
  stayId: string;
  expectedVersion: number;
  before: {
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
    nights: number;
    stayTimeline: StayTimelineItem[];
  };
  after: {
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
    nights: number;
    stayTimeline: StayTimelineItem[];
  };
  unchanged: {
    orderStatus: "CHECKED_OUT";
    stayStatus: "COMPLETED";
    stayType: string;
    currentRevisionId: string;
    currentContractAmountMinor: number;
    currency: string;
    occupantCount: number;
    occupants: HistoricalCorrectionOccupant[];
    collectionFactCount: number;
    netRecordedCollectionMinor: number;
    collectionDifferenceMinor: number;
  };
}

function requireRecord(value: unknown, field = "input"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  }
  return value.trim();
}

function requireNullableStringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", `${field} must be a string or null`);
  return value;
}

function optionalStringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", `${field} must be a string`);
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function requireIntegerField(input: Record<string, unknown>, field: string, min = 1): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a safe integer at least ${min}`);
  }
  return value as number;
}

function requireSafeIntegerField(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (!Number.isSafeInteger(value)) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a safe integer`);
  }
  return value as number;
}

function requireLocalDateField(input: Record<string, unknown>, field: string): string {
  const value = requireStringField(input, field);
  parseLocalDate(value);
  return value;
}

export function normalizeHistoricalStayArrangementCorrectionInput(rawInput: unknown): NormalizedHistoricalCorrectionInput {
  const input = requireRecord(rawInput);
  const propertyId = requireStringField(input, "propertyId");
  const correctionSet = input.correctionSet;
  if (!Array.isArray(correctionSet) || correctionSet.length === 0) {
    throw new DomainError("VALIDATION_ERROR", "correctionSet must contain at least one correction");
  }
  if (correctionSet.length > 100) {
    throw new DomainError("VALIDATION_ERROR", "correctionSet cannot contain more than 100 corrections");
  }

  const seenOrderIds = new Set<string>();
  const normalized = correctionSet.map((rawItem, index): NormalizedHistoricalCorrectionItem => {
    const item = requireRecord(rawItem, `correctionSet[${index}]`);
    const orderId = requireStringField(item, "orderId");
    if (seenOrderIds.has(orderId)) {
      throw new DomainError("VALIDATION_ERROR", "correctionSet must not contain duplicate orderId values", 409, false, { orderId });
    }
    seenOrderIds.add(orderId);
    const target = requireRecord(item.target, `correctionSet[${index}].target`);
    const arrivalDate = requireLocalDateField(target, "arrivalDate");
    const departureDate = requireLocalDateField(target, "departureDate");
    enumerateServiceDates(arrivalDate, departureDate);
    return {
      orderId,
      expectedVersion: requireIntegerField(item, "expectedVersion"),
      target: {
        inventoryUnitId: requireStringField(target, "inventoryUnitId"),
        arrivalDate,
        departureDate
      }
    };
  }).sort((left, right) => left.orderId.localeCompare(right.orderId));

  const evidenceNote = optionalStringField(input, "evidenceNote");
  return { propertyId, correctionSet: normalized, ...(evidenceNote ? { evidenceNote } : {}) };
}

function targetTimeline(item: NormalizedHistoricalCorrectionItem): StayTimelineItem[] {
  return enumerateServiceDates(item.target.arrivalDate, item.target.departureDate)
    .map((serviceDate) => ({ serviceDate, inventoryUnitId: item.target.inventoryUnitId }));
}

function unitConflicts(left: InventoryUnitRecord, right: InventoryUnitRecord): boolean {
  if (left.roomId !== right.roomId) return false;
  return left.kind === "ROOM" || right.kind === "ROOM" || left.id === right.id;
}

function conflictDetails(left: { orderId: string; unit: InventoryUnitRecord; serviceDate: string }, right: { orderId: string; unit: InventoryUnitRecord; serviceDate: string }) {
  return {
    orderId: right.orderId,
    inventoryUnitId: right.unit.id,
    conflictingOrderId: left.orderId,
    conflictingInventoryUnitId: left.unit.id,
    serviceDate: left.serviceDate
  };
}

function assertFinalSetHasNoInternalConflicts(items: readonly LoadedHistoricalCorrectionItem[]): void {
  const seen: Array<{ orderId: string; unit: InventoryUnitRecord; serviceDate: string }> = [];
  for (const item of items) {
    for (const serviceDate of enumerateServiceDates(item.after.arrivalDate, item.after.departureDate)) {
      const conflicting = seen.find((candidate) => candidate.serviceDate === serviceDate && unitConflicts(candidate.unit, item.targetUnit));
      if (conflicting) {
        throw new DomainError(
          "INVENTORY_CONFLICT",
          "修改清单内存在最终房态重叠，请把互换或联动记录作为完整的最终安排重新核对",
          409,
          false,
          conflictDetails(conflicting, { orderId: item.orderId, unit: item.targetUnit, serviceDate })
        );
      }
      seen.push({ orderId: item.orderId, unit: item.targetUnit, serviceDate });
    }
  }
}

async function assertNoActiveInventoryConflicts(db: DbExecutor, propertyId: string, items: readonly LoadedHistoricalCorrectionItem[]): Promise<string[]> {
  const excludedSegmentIds = [...new Set(items.flatMap((item) => item.context.segmentIds))];
  const fingerprint: string[] = [];
  for (const item of items) {
    const entries = await inventoryFingerprint(
      db,
      propertyId,
      item.targetUnit.id,
      item.after.arrivalDate,
      item.after.departureDate,
      excludedSegmentIds
    );
    fingerprint.push(...entries.map((entry) => `${item.orderId}:${entry}`));
  }
  if (fingerprint.length > 0) {
    throw new DomainError("INVENTORY_CONFLICT", "目标房源在修改后的历史日期内存在活动占用或不可售记录", 409, false, {
      fingerprint
    });
  }
  return fingerprint;
}

async function assertNoOutsideCompletedConflicts(db: DbExecutor, propertyId: string, items: readonly LoadedHistoricalCorrectionItem[]): Promise<string[]> {
  const correctedOrderIds = new Set(items.map((item) => item.orderId));
  const evidence: string[] = [];
  const unitCache = new Map<string, InventoryUnitRecord>();
  for (const item of items) {
    const candidates = await db.selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", (join) => join
        .onRef("segment.id", "=", "claim.source_id")
        .on("claim.source_type", "=", "ORDER_SEGMENT"))
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .innerJoin("orders as order", "order.id", "stay.order_id")
      .select(["order.id as order_id"])
      .distinct()
      .where("claim.property_id", "=", propertyId)
      .where("claim.room_id", "=", item.targetUnit.roomId)
      .where("claim.service_date", ">=", item.after.arrivalDate)
      .where("claim.service_date", "<", item.after.departureDate)
      .where("order.status", "=", "CHECKED_OUT")
      .where("stay.status", "=", "COMPLETED")
      .orderBy("order.id")
      .execute();
    for (const candidate of candidates) {
      if (correctedOrderIds.has(candidate.order_id)) continue;
      const snapshot = await getOrderViewSnapshot(db, candidate.order_id);
      for (const interval of snapshot.effectiveArrangement.intervals) {
        if (interval.arrivalDate >= item.after.departureDate || interval.departureDate <= item.after.arrivalDate) continue;
        let intervalUnit = unitCache.get(interval.inventoryUnitId);
        if (!intervalUnit) {
          intervalUnit = await loadInventoryUnitIncludingInactive(db, propertyId, interval.inventoryUnitId);
          unitCache.set(interval.inventoryUnitId, intervalUnit);
        }
        evidence.push(`${candidate.order_id}:${interval.inventoryUnitId}:${interval.arrivalDate}:${interval.departureDate}`);
        if (unitConflicts(item.targetUnit, intervalUnit)) {
          throw new DomainError(
            "INVENTORY_CONFLICT",
            "所选历史房源与集合外已完成住宿记录重叠，请先核对原订单",
            409,
            false,
            {
              orderId: candidate.order_id,
              inventoryUnitId: interval.inventoryUnitId,
              requestedOrderId: item.orderId,
              requestedInventoryUnitId: item.targetUnit.id
            }
          );
        }
      }
    }
  }
  return evidence.sort();
}

async function loadCurrentRevision(db: DbExecutor, context: OrderContext): Promise<LoadedHistoricalCorrectionItem["currentRevision"]> {
  const currentRevisionId = context.order.current_revision_id;
  if (!currentRevisionId) throw new DomainError("INTERNAL_ERROR", "Order has no current pricing revision", 500);
  return db.selectFrom("pricing_revisions")
    .select([
      "id",
      "revision_no",
      "amendment_id",
      "policy_version_id",
      "arrival_date",
      "departure_date",
      "coverage_set",
      "cash_lines",
      "policy_base_amount_minor",
      "pricing_basis",
      "manual_adjustment_minor",
      "current_contract_amount_minor",
      "currency"
    ])
    .where("id", "=", currentRevisionId)
    .executeTakeFirstOrThrow();
}

async function loadHistoricalCorrectionItems(db: DbExecutor, input: NormalizedHistoricalCorrectionInput): Promise<LoadedHistoricalCorrectionItem[]> {
  const loaded: LoadedHistoricalCorrectionItem[] = [];
  for (const item of input.correctionSet) {
    const context = await loadOrderContext(db, item.orderId);
    if (context.order.property_id !== input.propertyId) {
      throw new DomainError("NOT_FOUND", "Order not found", 404);
    }
    if (context.order.status !== "CHECKED_OUT" || context.stay.status !== "COMPLETED") {
      throw new DomainError("INVALID_ORDER_STATE", "只能修改已退房且已完成的历史住宿安排", 409, false, {
        orderId: item.orderId,
        orderStatus: context.order.status,
        stayStatus: context.stay.status
      });
    }
    if (context.order.version !== item.expectedVersion) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "订单版本已变化，请重新预览后确认", 409, false, {
        orderId: item.orderId,
        expectedVersion: item.expectedVersion,
        actualVersion: context.order.version
      });
    }
    const [snapshot, targetUnit, currentRevision, collectionFacts, coverageCountRow, entitlementCountRow] = await Promise.all([
      getOrderViewSnapshot(db, item.orderId),
      loadInventoryUnit(db, input.propertyId, item.target.inventoryUnitId),
      loadCurrentRevision(db, context),
      db.selectFrom("collection_facts")
        .select([
          "fact_id",
          "fact_type",
          "amount_minor",
          "net_effect_minor",
          "currency",
          "references_fact_id",
          "reverses_fact_id",
          "method",
          "transaction_reference",
          "pricing_revision_id",
          "command_id",
          "created_at"
        ])
        .where("order_id", "=", item.orderId)
        .orderBy("created_at")
        .orderBy("fact_id")
        .execute(),
      db.selectFrom("coverage_items")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("order_id", "=", item.orderId)
        .executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_ledger")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("order_id", "=", item.orderId)
        .executeTakeFirstOrThrow()
    ]);
    const intervals = snapshot.effectiveArrangement.intervals;
    if (intervals.length !== 1) {
      throw new DomainError("VALIDATION_ERROR", "目前只支持修改最终安排为单一房源区间的已完成历史住宿", 409, false, {
        orderId: item.orderId,
        intervalCount: intervals.length
      });
    }
    const beforeInterval = intervals[0]!;
    const beforeUnit = await loadInventoryUnitIncludingInactive(db, input.propertyId, beforeInterval.inventoryUnitId);
    if (targetUnit.kind !== beforeUnit.kind || targetUnit.pricingProductCode !== beforeUnit.pricingProductCode) {
      throw new DomainError("VALIDATION_ERROR", "目标房源必须与原订单销售 kind 和计价产品一致", 409, false, {
        orderId: item.orderId,
        beforeInventoryUnitId: beforeUnit.id,
        targetInventoryUnitId: targetUnit.id
      });
    }
    const occupants: HistoricalCorrectionOccupant[] = snapshot.occupants.map((occupant) => ({
      ordinal: occupant.ordinal,
      role: occupant.role,
      fullName: occupant.fullName,
      nickname: occupant.nickname
    }));
    if (occupants.length < 1
      || occupants.some((occupant, index) => occupant.ordinal !== index + 1
        || occupant.role !== (index === 0 ? "PRIMARY" : "ADDITIONAL"))) {
      throw new DomainError("INTERNAL_ERROR", "Order has no valid frozen occupant list", 500, false, { orderId: item.orderId });
    }
    if (occupants.length > targetUnit.occupancyCapacity) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `${targetUnit.code} 最多登记 ${targetUnit.occupancyCapacity} 位住宿人，当前订单有 ${occupants.length} 位`,
        409,
        false,
        { orderId: item.orderId, occupantCount: occupants.length, occupancyCapacity: targetUnit.occupancyCapacity }
      );
    }
    const coverageCount = Number(coverageCountRow.count);
    const entitlementCount = Number(entitlementCountRow.count);
    if (coverageCount > 0 || entitlementCount > 0) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "该历史住宿已有会员权益核销或覆盖事实，9.3 v1 不改写权益链", 409, false, {
        orderId: item.orderId,
        coverageCount,
        entitlementLedgerCount: entitlementCount
      });
    }
    const afterTimeline = targetTimeline(item);
    const beforeTimeline = enumerateServiceDates(beforeInterval.arrivalDate, beforeInterval.departureDate)
      .map((serviceDate) => ({ serviceDate, inventoryUnitId: beforeInterval.inventoryUnitId }));
    if (beforeInterval.inventoryUnitId === item.target.inventoryUnitId
      && beforeInterval.arrivalDate === item.target.arrivalDate
      && beforeInterval.departureDate === item.target.departureDate) {
      throw new DomainError("VALIDATION_ERROR", "修改后的日期或房源必须至少有一项变化", 409, false, { orderId: item.orderId });
    }
    loaded.push({
      ...item,
      stayId: context.stay.id,
      context,
      before: {
        inventoryUnitId: beforeInterval.inventoryUnitId,
        arrivalDate: beforeInterval.arrivalDate,
        departureDate: beforeInterval.departureDate,
        stayTimeline: beforeTimeline
      },
      after: {
        inventoryUnitId: item.target.inventoryUnitId,
        arrivalDate: item.target.arrivalDate,
        departureDate: item.target.departureDate,
        stayTimeline: afterTimeline
      },
      beforeUnit,
      targetUnit,
      occupants,
      collectionFacts,
      currentRevision
    });
  }
  return loaded;
}

function money(currency: string, minorUnits: number) {
  return { currency, minorUnits };
}

function normalizeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function correctionSetHash(corrections: readonly HistoricalCorrectionEffectItem[]): string {
  return stableHash(corrections.map((correction) => ({
    orderId: correction.orderId,
    expectedVersion: correction.expectedVersion,
    after: correction.after
  })));
}

export async function buildHistoricalStayArrangementCorrectionEffect(
  db: DbExecutor,
  rawInput: unknown
): Promise<{
  propertyId: string;
  effect: Record<string, unknown>;
  basisVersions: Record<string, unknown>;
  effectHash: string;
}> {
  const input = normalizeHistoricalStayArrangementCorrectionInput(rawInput);
  const propertyToday = await propertyLocalToday(db, input.propertyId);
  const futureCorrection = input.correctionSet.find((item) => item.target.departureDate > propertyToday);
  if (futureCorrection) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "历史住宿修改后的离店日不得晚于物业营业日",
      409,
      false,
      {
        orderId: futureCorrection.orderId,
        correctedDepartureDate: futureCorrection.target.departureDate,
        propertyToday
      }
    );
  }
  const items = await loadHistoricalCorrectionItems(db, input);
  assertFinalSetHasNoInternalConflicts(items);
  const [activeInventoryFingerprint, outsideCompletedEvidence] = await Promise.all([
    assertNoActiveInventoryConflicts(db, input.propertyId, items),
    assertNoOutsideCompletedConflicts(db, input.propertyId, items)
  ]);

  const corrections: HistoricalCorrectionEffectItem[] = [];
  for (const item of items) {
    const amounts = await orderAmountSummary(db, item.context);
    corrections.push({
      orderId: item.orderId,
      stayId: item.stayId,
      expectedVersion: item.expectedVersion,
      before: {
        inventoryUnitId: item.before.inventoryUnitId,
        arrivalDate: item.before.arrivalDate,
        departureDate: item.before.departureDate,
        nights: item.before.stayTimeline.length,
        stayTimeline: item.before.stayTimeline
      },
      after: {
        inventoryUnitId: item.after.inventoryUnitId,
        arrivalDate: item.after.arrivalDate,
        departureDate: item.after.departureDate,
        nights: item.after.stayTimeline.length,
        stayTimeline: item.after.stayTimeline
      },
      unchanged: {
        orderStatus: "CHECKED_OUT",
        stayStatus: "COMPLETED",
        stayType: item.context.order.stay_type,
        currentRevisionId: item.currentRevision.id,
        currentContractAmountMinor: item.currentRevision.current_contract_amount_minor,
        currency: item.currentRevision.currency,
        occupantCount: item.occupants.length,
        occupants: item.occupants,
        collectionFactCount: item.collectionFacts.length,
        netRecordedCollectionMinor: amounts.netRecordedCollection.minorUnits,
        collectionDifferenceMinor: amounts.collectionDifference.minorUnits
      }
    });
  }

  const effect: Record<string, unknown> = {
    operation: HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND,
    corrections
  };
  const basisVersions: Record<string, unknown> = {
    propertyId: input.propertyId,
    correctionSetHash: correctionSetHash(corrections),
    corrections: items.map((item) => ({
      orderId: item.orderId,
      stayId: item.stayId,
      orderVersion: item.context.order.version,
      orderStatus: item.context.order.status,
      stayStatus: item.context.stay.status,
      currentSegmentId: item.context.currentSegment.id,
      currentSegmentSequence: item.context.currentSegment.sequence,
      currentRevision: {
        id: item.currentRevision.id,
        revisionNo: item.currentRevision.revision_no,
        amendmentId: item.currentRevision.amendment_id,
        arrivalDate: item.currentRevision.arrival_date,
        departureDate: item.currentRevision.departure_date,
        policyVersionId: item.currentRevision.policy_version_id,
        policyBaseAmountMinor: item.currentRevision.policy_base_amount_minor,
        pricingBasis: item.currentRevision.pricing_basis,
        manualAdjustmentMinor: item.currentRevision.manual_adjustment_minor,
        currentContractAmountMinor: item.currentRevision.current_contract_amount_minor,
        currency: item.currentRevision.currency,
        coverageSet: normalizeJson(item.currentRevision.coverage_set),
        cashLines: normalizeJson(item.currentRevision.cash_lines)
      },
      before: item.before,
      after: item.after,
      occupantCount: item.occupants.length,
      occupants: item.occupants,
      collectionFactsHash: stableHash(item.collectionFacts.map((fact) => ({
        factId: fact.fact_id,
        type: fact.fact_type,
        netEffectMinor: fact.net_effect_minor,
        currency: fact.currency,
        pricingRevisionId: fact.pricing_revision_id,
        commandId: fact.command_id
      })))
    })),
    activeInventoryFingerprint,
    outsideCompletedEvidence
  };
  return {
    propertyId: input.propertyId,
    effect,
    basisVersions,
    effectHash: stableHash({ effect, basisVersions })
  };
}

export async function lockHistoricalStayArrangementCorrectionResources(
  trx: Transaction<Database>,
  rawInput: unknown
): Promise<void> {
  const input = normalizeHistoricalStayArrangementCorrectionInput(rawInput);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:historical-stay-corrections:${input.propertyId}`}, 0::bigint))`.execute(trx);
  const orderIds = input.correctionSet.map((item) => item.orderId).sort();
  if (orderIds.length > 0) {
    await trx.selectFrom("orders")
      .select(["id", "arrival_date", "departure_date"])
      .where("property_id", "=", input.propertyId)
      .where("id", "in", orderIds)
      .orderBy("id")
      .forUpdate()
      .execute();
    const stayRows = await trx.selectFrom("stays")
      .select(["id", "order_id"])
      .where("order_id", "in", orderIds)
      .orderBy("order_id")
      .forUpdate()
      .execute();
    const stayIds = stayRows.map((row) => row.id);
    if (stayIds.length > 0) {
      await trx.selectFrom("stay_segments")
        .select(["id"])
        .where("stay_id", "in", stayIds)
        .orderBy("stay_id")
        .orderBy("sequence")
        .forUpdate()
        .execute();
    }
    await trx.selectFrom("pricing_revisions")
      .select(["id"])
      .where("order_id", "in", orderIds)
      .orderBy("order_id")
      .orderBy("revision_no")
      .forUpdate()
      .execute();
    await trx.selectFrom("collection_facts")
      .select(["fact_id"])
      .where("order_id", "in", orderIds)
      .orderBy("order_id")
      .orderBy("created_at")
      .orderBy("fact_id")
      .forUpdate()
      .execute();
    await trx.selectFrom("coverage_items")
      .select(["id"])
      .where("order_id", "in", orderIds)
      .orderBy("order_id")
      .orderBy("service_date")
      .orderBy("id")
      .forUpdate()
      .execute();
    await trx.selectFrom("entitlement_ledger")
      .select(["fact_id"])
      .where("order_id", "in", orderIds)
      .orderBy("created_at")
      .orderBy("fact_id")
      .forUpdate()
      .execute();
  }

  for (const item of input.correctionSet) {
    await lockUnitDates(trx, input.propertyId, item.target.inventoryUnitId, item.target.arrivalDate, item.target.departureDate);
  }

  const targetUnits = await Promise.all(input.correctionSet.map((item) => loadInventoryUnit(trx, input.propertyId, item.target.inventoryUnitId)));
  for (const [index, item] of input.correctionSet.entries()) {
    const unit = targetUnits[index]!;
    await trx.selectFrom("inventory_claims")
      .select(["id"])
      .where("property_id", "=", input.propertyId)
      .where("room_id", "=", unit.roomId)
      .where("service_date", ">=", item.target.arrivalDate)
      .where("service_date", "<", item.target.departureDate)
      .orderBy("service_date")
      .orderBy("id")
      .forUpdate()
      .execute();
  }
}

function effectCorrections(effect: Record<string, unknown>): HistoricalCorrectionEffectItem[] {
  if (effect.operation !== HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND) {
    throw new DomainError("INTERNAL_ERROR", "Historical stay correction effect has an invalid operation", 500);
  }
  const value = effect.corrections;
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError("INTERNAL_ERROR", "Historical stay correction effect has no corrections", 500);
  }
  return value.map((raw, index): HistoricalCorrectionEffectItem => {
    const item = requireRecord(raw, `effect.corrections[${index}]`);
    const before = requireRecord(item.before, `effect.corrections[${index}].before`);
    const after = requireRecord(item.after, `effect.corrections[${index}].after`);
    const unchanged = requireRecord(item.unchanged, `effect.corrections[${index}].unchanged`);
    return {
      orderId: requireStringField(item, "orderId"),
      stayId: requireStringField(item, "stayId"),
      expectedVersion: requireIntegerField(item, "expectedVersion"),
      before: {
        inventoryUnitId: requireStringField(before, "inventoryUnitId"),
        arrivalDate: requireLocalDateField(before, "arrivalDate"),
        departureDate: requireLocalDateField(before, "departureDate"),
        nights: requireIntegerField(before, "nights"),
        stayTimeline: Array.isArray(before.stayTimeline)
          ? before.stayTimeline.map((timelineItem, timelineIndex) => {
              const row = requireRecord(timelineItem, `effect.corrections[${index}].before.stayTimeline[${timelineIndex}]`);
              return {
                serviceDate: requireLocalDateField(row, "serviceDate"),
                inventoryUnitId: requireStringField(row, "inventoryUnitId")
              };
            })
          : (() => {
              throw new DomainError("INTERNAL_ERROR", "Historical stay correction before timeline is invalid", 500);
            })()
      },
      after: {
        inventoryUnitId: requireStringField(after, "inventoryUnitId"),
        arrivalDate: requireLocalDateField(after, "arrivalDate"),
        departureDate: requireLocalDateField(after, "departureDate"),
        nights: requireIntegerField(after, "nights"),
        stayTimeline: Array.isArray(after.stayTimeline)
          ? after.stayTimeline.map((timelineItem, timelineIndex) => {
              const row = requireRecord(timelineItem, `effect.corrections[${index}].after.stayTimeline[${timelineIndex}]`);
              return {
                serviceDate: requireLocalDateField(row, "serviceDate"),
                inventoryUnitId: requireStringField(row, "inventoryUnitId")
              };
            })
          : (() => {
              throw new DomainError("INTERNAL_ERROR", "Historical stay correction after timeline is invalid", 500);
            })()
      },
      unchanged: {
        orderStatus: requireStringField(unchanged, "orderStatus") as "CHECKED_OUT",
        stayStatus: requireStringField(unchanged, "stayStatus") as "COMPLETED",
        stayType: requireStringField(unchanged, "stayType"),
        currentRevisionId: requireStringField(unchanged, "currentRevisionId"),
        currentContractAmountMinor: requireIntegerField(unchanged, "currentContractAmountMinor", 0),
        currency: requireStringField(unchanged, "currency"),
        occupantCount: requireIntegerField(unchanged, "occupantCount"),
        occupants: (() => {
          if (!Array.isArray(unchanged.occupants) || unchanged.occupants.length === 0) {
            throw new DomainError("VALIDATION_ERROR", "unchanged.occupants must be a non-empty array");
          }
          const occupants = unchanged.occupants.map((rawOccupant, occupantIndex) => {
            const occupant = requireRecord(rawOccupant, `unchanged.occupants[${occupantIndex}]`);
            const role = requireStringField(occupant, "role");
            if (role !== "PRIMARY" && role !== "ADDITIONAL") {
              throw new DomainError("VALIDATION_ERROR", `unchanged.occupants[${occupantIndex}].role is invalid`);
            }
            return {
              ordinal: requireIntegerField(occupant, "ordinal", 1),
              role: role as "PRIMARY" | "ADDITIONAL",
              fullName: requireNullableStringField(occupant, "fullName"),
              nickname: requireNullableStringField(occupant, "nickname")
            };
          });
          if (occupants.length !== requireIntegerField(unchanged, "occupantCount")
            || occupants.some((occupant, index) => occupant.ordinal !== index + 1
              || occupant.role !== (index === 0 ? "PRIMARY" : "ADDITIONAL"))) {
            throw new DomainError("VALIDATION_ERROR", "unchanged.occupants does not match occupantCount or occupant order");
          }
          return occupants;
        })(),
        collectionFactCount: requireIntegerField(unchanged, "collectionFactCount", 0),
        netRecordedCollectionMinor: requireSafeIntegerField(unchanged, "netRecordedCollectionMinor"),
        collectionDifferenceMinor: requireSafeIntegerField(unchanged, "collectionDifferenceMinor")
      }
    };
  }).sort((left, right) => left.orderId.localeCompare(right.orderId));
}

async function insertCopiedPricingRevision(trx: Transaction<Database>, options: {
  orderId: string;
  amendmentId: string;
  priorRevisionId: string;
  arrivalDate: string;
  departureDate: string;
}): Promise<string> {
  const prior = await trx.selectFrom("pricing_revisions")
    .selectAll()
    .where("id", "=", options.priorRevisionId)
    .where("order_id", "=", options.orderId)
    .executeTakeFirstOrThrow();
  const id = newId("revision");
  await trx.insertInto("pricing_revisions").values({
    id,
    order_id: options.orderId,
    revision_no: prior.revision_no + 1,
    amendment_id: options.amendmentId,
    policy_version_id: prior.policy_version_id,
    arrival_date: options.arrivalDate,
    departure_date: options.departureDate,
    coverage_set: JSON.stringify(prior.coverage_set),
    cash_lines: JSON.stringify(prior.cash_lines),
    policy_base_amount_minor: prior.policy_base_amount_minor,
    pricing_basis: prior.pricing_basis,
    manual_adjustment_minor: prior.manual_adjustment_minor,
    current_contract_amount_minor: prior.current_contract_amount_minor,
    currency: prior.currency
  }).execute();
  return id;
}

export async function applyHistoricalStayArrangementCorrection(
  trx: Transaction<Database>,
  options: {
    input: unknown;
    effect: Record<string, unknown>;
    reason: CommandReason;
    commandId: string;
  }
): Promise<{
  persistedResult: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
}> {
  const input = normalizeHistoricalStayArrangementCorrectionInput(options.input);
  const corrections = effectCorrections(options.effect);
  if (corrections.length !== input.correctionSet.length
    || corrections.some((correction, index) => correction.orderId !== input.correctionSet[index]?.orderId)) {
    throw new DomainError("INTERNAL_ERROR", "Historical stay correction effect does not match normalized input", 500);
  }
  const command = await trx.selectFrom("command_executions")
    .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
    .select([
      "command_executions.subject_id as subject_id",
      "subjects.display_name as actor_display_name"
    ])
    .select(sql<Date>`transaction_timestamp()`.as("recorded_at"))
    .where("command_executions.id", "=", options.commandId)
    .executeTakeFirstOrThrow();
  const persistedCorrections: Array<Record<string, unknown>> = [];
  const resourceRefs: string[] = [];
  const factRefs: string[] = [];

  for (const correction of corrections) {
    const context = await loadOrderContext(trx, correction.orderId);
    if (context.order.property_id !== input.propertyId) {
      throw new DomainError("NOT_FOUND", "Order not found", 404);
    }
    if (context.order.version !== correction.expectedVersion
      || context.order.status !== "CHECKED_OUT"
      || context.stay.status !== "COMPLETED"
      || context.revision.id !== correction.unchanged.currentRevisionId) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "订单版本或终态已变化，请重新预览后确认", 409, false, {
        orderId: correction.orderId
      });
    }
    const priorPricing = await trx.selectFrom("pricing_revisions")
      .select(["coverage_set", "cash_lines"])
      .where("id", "=", correction.unchanged.currentRevisionId)
      .where("order_id", "=", correction.orderId)
      .executeTakeFirstOrThrow();
    const targetUnit = await loadInventoryUnit(trx, input.propertyId, correction.after.inventoryUnitId);
    const amendmentPayload = {
      operation: HISTORICAL_STAY_ARRANGEMENT_CORRECTION_AMENDMENT,
      commandType: HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND,
      orderId: correction.orderId,
      stayId: correction.stayId,
      expectedVersion: correction.expectedVersion,
      correctionSetHash: correctionSetHash(corrections),
      before: correction.before,
      after: {
        ...correction.after,
        pricing: {
          coverageSet: priorPricing.coverage_set,
          cashLines: priorPricing.cash_lines,
          currentContractAmount: money(correction.unchanged.currency, correction.unchanged.currentContractAmountMinor)
        }
      },
      unchanged: correction.unchanged
    };
    const amendmentId = newId("amend");
    await trx.insertInto("amendments").values({
      id: amendmentId,
      order_id: correction.orderId,
      sequence: context.order.version + 1,
      amendment_type: HISTORICAL_STAY_ARRANGEMENT_CORRECTION_AMENDMENT,
      reason_code: options.reason.code,
      reason_note: options.reason.note,
      prior_version: context.order.version,
      new_version: context.order.version + 1,
      payload: amendmentPayload,
      command_id: options.commandId,
      created_at: sql<Date>`greatest(
        transaction_timestamp(),
        coalesce(
          (select max(created_at) from amendments where order_id = ${correction.orderId}),
          '-infinity'::timestamptz
        )
      )`
    }).execute();

    const segmentId = newId("segment");
    await trx.insertInto("stay_segments").values({
      id: segmentId,
      stay_id: context.stay.id,
      sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: correction.after.inventoryUnitId,
      arrival_date: correction.after.arrivalDate,
      departure_date: correction.after.departureDate,
      segment_type: HISTORICAL_STAY_ARRANGEMENT_CORRECTION_AMENDMENT,
      supersedes_segment_id: context.currentSegment.id,
      amendment_id: amendmentId
    }).execute();

    const revisionId = await insertCopiedPricingRevision(trx, {
      orderId: correction.orderId,
      amendmentId,
      priorRevisionId: correction.unchanged.currentRevisionId,
      arrivalDate: correction.after.arrivalDate,
      departureDate: correction.after.departureDate
    });

    const claimIds = await createInventoryClaims(trx, {
      propertyId: input.propertyId,
      unit: targetUnit,
      dates: enumerateServiceDates(correction.after.arrivalDate, correction.after.departureDate),
      sourceType: "ORDER_SEGMENT",
      sourceId: segmentId,
      excludeSourceIds: [...context.segmentIds, segmentId]
    });
    const releasedClaimIds = await releaseInventoryClaims(trx, "ORDER_SEGMENT", [segmentId]);
    if (releasedClaimIds.length !== claimIds.length || releasedClaimIds.some((claimId, index) => claimId !== claimIds[index])) {
      throw new DomainError("INTERNAL_ERROR", "Historical stay correction did not create and release exact historical Claims", 500, false, {
        orderId: correction.orderId,
        claimIds,
        releasedClaimIds
      });
    }

    const priorCorrection = await trx.selectFrom("historical_stay_arrangement_corrections")
      .select("sequence")
      .where("order_id", "=", correction.orderId)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const correctionId = newId("fact");
    await trx.insertInto("historical_stay_arrangement_corrections").values({
      id: correctionId,
      property_id: input.propertyId,
      order_id: correction.orderId,
      stay_id: context.stay.id,
      sequence: (priorCorrection?.sequence ?? 0) + 1,
      expected_version: correction.expectedVersion,
      prior_inventory_unit_id: correction.before.inventoryUnitId,
      prior_arrival_date: correction.before.arrivalDate,
      prior_departure_date: correction.before.departureDate,
      corrected_inventory_unit_id: correction.after.inventoryUnitId,
      corrected_arrival_date: correction.after.arrivalDate,
      corrected_departure_date: correction.after.departureDate,
      reason_code: options.reason.code,
      reason_note: options.reason.note,
      actor_subject_id: command.subject_id,
      amendment_id: amendmentId,
      stay_segment_id: segmentId,
      pricing_revision_id: revisionId,
      created_by_command_id: options.commandId
    }).execute();

    await trx.updateTable("orders").set({
      arrival_date: correction.after.arrivalDate,
      departure_date: correction.after.departureDate,
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", correction.orderId).execute();

    persistedCorrections.push({
      orderId: correction.orderId,
      stayId: correction.stayId,
      correctionId,
      amendmentId,
      staySegmentId: segmentId,
      pricingRevisionId: revisionId,
      claimIds,
      before: correction.before,
      after: correction.after,
      unchanged: correction.unchanged
    });
    resourceRefs.push(correction.orderId, correction.stayId, amendmentId, segmentId, revisionId, ...claimIds);
    factRefs.push(correctionId);
  }

  return {
    persistedResult: {
      operation: HISTORICAL_STAY_ARRANGEMENT_CORRECTION_COMMAND,
      correctionSetHash: correctionSetHash(corrections),
      corrections: persistedCorrections,
      reason: options.reason,
      ...(input.evidenceNote ? { evidenceNote: input.evidenceNote } : {}),
      actor: {
        subjectId: command.subject_id,
        displayName: command.actor_display_name
      },
      recordedAt: command.recorded_at.toISOString()
    },
    resourceRefs: [...new Set(resourceRefs)],
    factRefs: [...new Set(factRefs)]
  };
}
