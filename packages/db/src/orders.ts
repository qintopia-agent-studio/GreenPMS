import { sql, type Kysely, type Transaction } from "kysely";
import {
  currentReleaseFeatures,
  DomainError,
  orderActionCodes,
  type AccessLevel,
  type CoverageItemDto,
  type OrderFulfillmentProjectionDto,
  type OrderFulfillmentRecordDto,
  type OrderAllowedActionDto,
  type OrderActionCode
} from "@qintopia/contracts";
import { amountSummary, enumerateServiceDates, newId, parseLocalDate, type CoverageCandidate } from "@qintopia/domain";
import type { DbExecutor } from "./inventory.ts";
import { propertyLocalToday } from "./members.ts";
import type { Database } from "./schema.ts";

export interface OrderContext {
  order: Awaited<ReturnType<typeof selectOrder>>;
  stay: { id: string; status: string };
  currentSegment: {
    id: string;
    sequence: number;
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  };
  revision: {
    id: string;
    revisionNo: number;
    currentContractAmountMinor: number;
    currency: string;
  };
  segmentIds: string[];
}

export interface StayTimelineItem {
  serviceDate: string;
  inventoryUnitId: string;
}

async function selectOrder(db: DbExecutor, orderId: string) {
  const row = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Order not found", 404);
  return row;
}

export async function loadOrderContext(db: DbExecutor, orderId: string): Promise<OrderContext> {
  const order = await selectOrder(db, orderId);
  const stay = await db.selectFrom("stays").select(["id", "status"]).where("order_id", "=", orderId).executeTakeFirstOrThrow();
  const currentSegment = await db.selectFrom("stay_segments")
    .select(["id", "sequence", "inventory_unit_id", "arrival_date", "departure_date"])
    .where("stay_id", "=", stay.id).orderBy("sequence", "desc").executeTakeFirstOrThrow();
  if (!order.current_revision_id) throw new DomainError("INTERNAL_ERROR", "Order has no current pricing revision", 500);
  const revision = await db.selectFrom("pricing_revisions")
    .select(["id", "revision_no", "current_contract_amount_minor", "currency"])
    .where("id", "=", order.current_revision_id).executeTakeFirstOrThrow();
  const segments = await db.selectFrom("stay_segments").select("id").where("stay_id", "=", stay.id).orderBy("sequence").execute();
  return {
    order,
    stay,
    currentSegment: {
      id: currentSegment.id,
      sequence: currentSegment.sequence,
      inventoryUnitId: currentSegment.inventory_unit_id,
      arrivalDate: currentSegment.arrival_date,
      departureDate: currentSegment.departure_date
    },
    revision: {
      id: revision.id,
      revisionNo: revision.revision_no,
      currentContractAmountMinor: revision.current_contract_amount_minor,
      currency: revision.currency
    },
    segmentIds: segments.map((segment) => segment.id)
  };
}

export async function loadActiveStayTimeline(db: DbExecutor, context: OrderContext): Promise<StayTimelineItem[]> {
  const expectedDates = enumerateServiceDates(context.order.arrival_date, context.order.departure_date);
  const claims = await db.selectFrom("inventory_claims")
    .select(["service_date", "inventory_unit_id", "id"])
    .where("source_type", "=", "ORDER_SEGMENT")
    .where("source_id", "in", context.segmentIds)
    .where("active", "=", true)
    .where("service_date", ">=", context.order.arrival_date)
    .where("service_date", "<", context.order.departure_date)
    .orderBy("service_date")
    .orderBy("id")
    .execute();
  const byDate = new Map<string, typeof claims>();
  for (const claim of claims) {
    const existing = byDate.get(claim.service_date) ?? [];
    existing.push(claim);
    byDate.set(claim.service_date, existing);
  }
  return expectedDates.map((serviceDate) => {
    const matches = byDate.get(serviceDate) ?? [];
    if (matches.length !== 1) {
      throw new DomainError("INTERNAL_ERROR", `Stay inventory timeline is invalid on ${serviceDate}`, 500, false, {
        orderId: context.order.id,
        serviceDate,
        activeClaimIds: matches.map((claim) => claim.id)
      });
    }
    return { serviceDate, inventoryUnitId: matches[0]!.inventory_unit_id };
  });
}

export async function lockOrder(trx: Transaction<Database>, orderId: string): Promise<void> {
  const row = await trx.selectFrom("orders").select("id").where("id", "=", orderId).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Order not found", 404);
}

export async function orderAmountSummary(db: DbExecutor, context: OrderContext) {
  const facts = await db.selectFrom("collection_facts").select("net_effect_minor").where("order_id", "=", context.order.id).execute();
  return amountSummary(context.revision.currency, context.revision.currentContractAmountMinor, facts.map((fact) => fact.net_effect_minor));
}

export function orderAllowedActions(
  accessLevel: AccessLevel,
  status: string,
  hasRefundableCollection: boolean,
  fulfillmentDates?: { businessDate: string; arrivalDate: string; departureDate: string }
): OrderAllowedActionDto[] {
  if (accessLevel === "READ") return [];
  const enabledByStatus: Partial<Record<OrderActionCode, readonly string[]>> = {
    CORRECT_ORDER_OCCUPANT: ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"],
    CHECK_IN: ["RESERVED"],
    CHECK_OUT: ["CHECKED_IN"],
    SHORTEN_STAY: ["RESERVED", "CHECKED_IN"],
    EXTEND_STAY: ["RESERVED", "CHECKED_IN"],
    MOVE_UNIT: ["RESERVED", "CHECKED_IN"],
    REPRICE_ORDER: ["RESERVED", "CHECKED_IN"],
    CANCEL_ORDER: ["RESERVED"],
    MARK_NO_SHOW: ["RESERVED"],
    RECORD_COLLECTION: ["RESERVED", "CHECKED_IN", "CHECKED_OUT"],
    RECORD_REFUND: ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]
  };
  return orderActionCodes.map((code) => {
    const statusAllows = enabledByStatus[code]?.includes(status) ?? false;
    let fulfillmentDisabledReason: string | null = null;
    if (fulfillmentDates && statusAllows) {
      if (code === "CHECK_IN") {
        if (fulfillmentDates.businessDate < fulfillmentDates.arrivalDate) {
          fulfillmentDisabledReason = "ARRIVAL_DATE_NOT_REACHED";
        } else if (fulfillmentDates.businessDate > fulfillmentDates.arrivalDate) {
          fulfillmentDisabledReason = "ARRIVAL_DATE_PASSED";
        }
      } else if (code === "CHECK_OUT") {
        if (fulfillmentDates.businessDate < fulfillmentDates.departureDate) {
          fulfillmentDisabledReason = "DEPARTURE_DATE_NOT_REACHED";
        }
      }
    }
    const enabled = statusAllows
      && fulfillmentDisabledReason === null
      && (code !== "RECORD_REFUND" || hasRefundableCollection);
    return {
      code,
      enabled,
      disabledReason: enabled
        ? null
        : fulfillmentDisabledReason ?? (code === "RECORD_REFUND" && statusAllows
          ? "NO_REFUNDABLE_COLLECTION"
          : "ORDER_STATE_NOT_ALLOWED")
    };
  });
}

interface FulfillmentAmendmentRow {
  sequence: number;
  amendment_type: string;
  payload: unknown;
  reason_code: string;
  reason_note: string;
  actor_subject_id: string | null;
  actor_display_name: string | null;
  created_at: Date | string;
}

function fulfillmentPayload(amendment: FulfillmentAmendmentRow): Record<string, unknown> {
  if (!amendment.payload || typeof amendment.payload !== "object" || Array.isArray(amendment.payload)) {
    throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  return amendment.payload as Record<string, unknown>;
}

function validFulfillmentDate(value: unknown, amendment: FulfillmentAmendmentRow): string {
  if (typeof value !== "string") {
    throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  try {
    parseLocalDate(value);
  } catch {
    throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  return value;
}

function historicalRecordedBusinessDate(amendment: FulfillmentAmendmentRow, payload: Record<string, unknown>): string | null {
  if (!("businessDate" in payload) || payload.businessDate === undefined) return null;
  return validFulfillmentDate(payload.businessDate, amendment);
}

function recordedAt(amendment: FulfillmentAmendmentRow): string {
  const value = amendment.created_at instanceof Date ? amendment.created_at : new Date(amendment.created_at);
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "履约记录的记录时间损坏", 500, false, {
      amendmentSequence: amendment.sequence,
      amendmentType: amendment.amendment_type
    });
  }
  return value.toISOString();
}

function fulfillmentRecord(
  amendment: FulfillmentAmendmentRow | undefined,
  type: "CHECK_IN" | "CHECK_OUT",
  plannedBusinessDate: string
): OrderFulfillmentRecordDto | null {
  if (!amendment) return null;
  const payload = fulfillmentPayload(amendment);
  const hasImmutableTiming = "effectiveDate" in payload || "recordingMode" in payload;
  let effectiveDate = plannedBusinessDate;
  let recordedDate: string | null;
  let recordingMode: OrderFulfillmentRecordDto["recordingMode"];
  if (hasImmutableTiming) {
    if (!("effectiveDate" in payload) || !("recordingMode" in payload) || !("businessDate" in payload)) {
      throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500, false, {
        amendmentSequence: amendment.sequence,
        amendmentType: amendment.amendment_type
      });
    }
    effectiveDate = validFulfillmentDate(payload.effectiveDate, amendment);
    recordedDate = validFulfillmentDate(payload.businessDate, amendment);
    if (payload.recordingMode !== "ON_SCHEDULE" && payload.recordingMode !== "LATE_RECORDED") {
      throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500);
    }
    const timingMatches = type === "CHECK_IN"
      ? payload.recordingMode === "ON_SCHEDULE" && recordedDate === effectiveDate
      : payload.recordingMode === "ON_SCHEDULE"
        ? recordedDate === effectiveDate
        : recordedDate > effectiveDate;
    if (!timingMatches) throw new DomainError("INTERNAL_ERROR", "履约记录的办理营业日期损坏", 500);
    recordingMode = payload.recordingMode;
  } else {
    recordedDate = historicalRecordedBusinessDate(amendment, payload);
    recordingMode = recordedDate === plannedBusinessDate
      ? "ON_SCHEDULE"
      : type === "CHECK_OUT" && recordedDate !== null && recordedDate > plannedBusinessDate
        ? "LATE_RECORDED"
        : "LEGACY_UNCLASSIFIED";
  }
  const hasActorId = Boolean(amendment.actor_subject_id);
  const hasActorName = Boolean(amendment.actor_display_name);
  if (hasActorId !== hasActorName) throw new DomainError("INTERNAL_ERROR", "履约记录的操作人信息损坏", 500);
  return {
    type,
    plannedBusinessDate: effectiveDate,
    recordedBusinessDate: recordedDate,
    recordingMode,
    recordedAt: recordedAt(amendment),
    actor: amendment.actor_subject_id && amendment.actor_display_name
      ? { subjectId: amendment.actor_subject_id, displayName: amendment.actor_display_name }
      : null,
    reason: { code: amendment.reason_code, note: amendment.reason_note }
  };
}

export function projectOrderFulfillment(
  amendments: readonly FulfillmentAmendmentRow[],
  dates: { arrivalDate: string; departureDate: string }
): OrderFulfillmentProjectionDto {
  parseLocalDate(dates.arrivalDate);
  parseLocalDate(dates.departureDate);
  const checkIns = amendments.filter((amendment) => amendment.amendment_type === "CHECK_IN");
  const checkOuts = amendments.filter((amendment) => amendment.amendment_type === "CHECK_OUT");
  if (checkIns.length > 1 || checkOuts.length > 1) {
    throw new DomainError("INTERNAL_ERROR", "订单履约记录存在重复状态事实", 500);
  }
  return {
    checkIn: fulfillmentRecord(checkIns[0], "CHECK_IN", dates.arrivalDate),
    checkOut: fulfillmentRecord(checkOuts[0], "CHECK_OUT", dates.departureDate)
  };
}

function hasRefundableCollection(facts: Array<{
  fact_id: string;
  fact_type: string;
  amount_minor: number;
  references_fact_id: string | null;
  reverses_fact_id: string | null;
}>): boolean {
  const reversed = new Set(facts.filter((fact) => fact.fact_type === "REVERSAL" && fact.reverses_fact_id)
    .map((fact) => fact.reverses_fact_id!));
  const activeRefunded = new Map<string, number>();
  for (const fact of facts) {
    if (fact.fact_type !== "REFUND" || !fact.references_fact_id || reversed.has(fact.fact_id)) continue;
    activeRefunded.set(fact.references_fact_id, (activeRefunded.get(fact.references_fact_id) ?? 0) + fact.amount_minor);
  }
  return facts.some((fact) => fact.fact_type === "COLLECTION"
    && !reversed.has(fact.fact_id)
    && (activeRefunded.get(fact.fact_id) ?? 0) < fact.amount_minor);
}

async function getOrderViewSnapshot(db: DbExecutor, orderId: string, accessLevel: AccessLevel) {
  const context = await loadOrderContext(db, orderId);
  const [businessDate, occupantRows, correctionRows, segments, amendments, revisions, coverage, facts, cleaningTasks] = await Promise.all([
    propertyLocalToday(db, context.order.property_id),
    db.selectFrom("order_occupants").selectAll().where("order_id", "=", orderId).orderBy("ordinal").execute(),
    db.selectFrom("order_occupant_corrections")
      .innerJoin("subjects", "subjects.id", "order_occupant_corrections.actor_subject_id")
      .selectAll("order_occupant_corrections")
      .select("subjects.display_name as actor_display_name")
      .where("order_occupant_corrections.order_id", "=", orderId)
      .orderBy("order_occupant_corrections.created_at")
      .orderBy("order_occupant_corrections.id")
      .execute(),
    db.selectFrom("stay_segments").selectAll().where("stay_id", "=", context.stay.id).orderBy("sequence").execute(),
    db.selectFrom("amendments")
      .leftJoin("command_executions", "command_executions.id", "amendments.command_id")
      .leftJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("amendments")
      .select([
        "command_executions.subject_id as actor_subject_id",
        "subjects.display_name as actor_display_name"
      ])
      .where("amendments.order_id", "=", orderId)
      .orderBy("amendments.sequence")
      .execute(),
    db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no").execute(),
    db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute(),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute(),
    currentReleaseFeatures.cleaningWorkflow ? db.selectFrom("cleaning_tasks as task")
      .leftJoin("command_executions as created_command", "created_command.id", "task.created_by_command_id")
      .leftJoin("subjects as created_subject", "created_subject.id", "created_command.subject_id")
      .leftJoin("command_executions as completed_command", "completed_command.id", "task.completed_by_command_id")
      .leftJoin("subjects as completed_subject", "completed_subject.id", "completed_command.subject_id")
      .select([
        "task.id",
        "task.inventory_unit_id",
        "task.service_date",
        "task.status",
        "task.created_at",
        "task.completed_at",
        "created_command.subject_id as created_subject_id",
        "created_subject.display_name as created_subject_name",
        "completed_command.subject_id as completed_subject_id",
        "completed_subject.display_name as completed_subject_name"
      ])
      .where("task.order_id", "=", orderId)
      .orderBy("task.service_date")
      .orderBy("task.created_at")
      .execute() : Promise.resolve([])
  ]);
  const latestByOccupant = new Map<string, (typeof correctionRows)[number]>();
  for (const correction of correctionRows) {
    const current = latestByOccupant.get(correction.occupant_id);
    if (!current || correction.sequence > current.sequence) latestByOccupant.set(correction.occupant_id, correction);
  }
  const snapshot = (correction: (typeof correctionRows)[number], prefix: "prior" | "corrected") => ({
    fullName: correction[`${prefix}_full_name`],
    nickname: correction[`${prefix}_nickname`],
    phone: correction[`${prefix}_phone`],
    documentNumber: correction[`${prefix}_document_number`]
  });
  return {
    accessLevel,
    allowedActions: orderAllowedActions(accessLevel, context.order.status, hasRefundableCollection(facts), {
      businessDate,
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date
    }),
    order: context.order,
    occupants: occupantRows.map((occupant) => {
      const correction = latestByOccupant.get(occupant.id);
      return {
        id: occupant.id,
        orderId: occupant.order_id,
        ordinal: occupant.ordinal,
        role: occupant.role,
        fullName: correction?.corrected_full_name ?? occupant.full_name,
        nickname: correction?.corrected_nickname ?? occupant.nickname,
        phone: correction ? correction.corrected_phone : occupant.phone,
        documentNumber: correction ? correction.corrected_document_number : occupant.document_number,
        createdAt: occupant.created_at instanceof Date ? occupant.created_at.toISOString() : new Date(occupant.created_at).toISOString()
      };
    }),
    occupantCorrections: correctionRows.map((correction) => ({
      id: correction.id,
      orderId: correction.order_id,
      occupantId: correction.occupant_id,
      sequence: correction.sequence,
      priorSnapshot: snapshot(correction, "prior"),
      correctedSnapshot: snapshot(correction, "corrected"),
      reason: { code: correction.reason_code, note: correction.reason_note },
      actor: { subjectId: correction.actor_subject_id, displayName: correction.actor_display_name },
      amendmentId: correction.amendment_id,
      commandId: correction.created_by_command_id,
      createdAt: correction.created_at instanceof Date ? correction.created_at.toISOString() : new Date(correction.created_at).toISOString()
    })),
    stay: context.stay,
    currentSegment: context.currentSegment,
    segments,
    fulfillment: projectOrderFulfillment(amendments, {
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date
    }),
    amendments: amendments.map((amendment) => ({
      id: amendment.id,
      order_id: amendment.order_id,
      sequence: amendment.sequence,
      amendment_type: amendment.amendment_type,
      reason_code: amendment.reason_code,
      reason_note: amendment.reason_note,
      prior_version: amendment.prior_version,
      new_version: amendment.new_version,
      payload: amendment.payload,
      command_id: amendment.command_id,
      actor: amendment.actor_subject_id && amendment.actor_display_name
        ? { subjectId: amendment.actor_subject_id, displayName: amendment.actor_display_name }
        : null,
      created_at: amendment.created_at
    })),
    pricingRevisions: revisions.map((revision) => ({
      ...revision,
      policy_base_amount_minor: revision.current_contract_amount_minor - revision.manual_adjustment_minor
    })),
    coverageSet: coverage,
    collectionFacts: facts,
    cleaningTasks: cleaningTasks.map((task) => ({
      id: task.id,
      inventoryUnitId: task.inventory_unit_id,
      serviceDate: task.service_date,
      status: task.status,
      createdAt: task.created_at instanceof Date ? task.created_at.toISOString() : new Date(task.created_at).toISOString(),
      completedAt: task.completed_at
        ? task.completed_at instanceof Date ? task.completed_at.toISOString() : new Date(task.completed_at).toISOString()
        : null,
      createdBy: task.created_subject_id && task.created_subject_name
        ? { subjectId: task.created_subject_id, displayName: task.created_subject_name }
        : null,
      completedBy: task.completed_subject_id && task.completed_subject_name
        ? { subjectId: task.completed_subject_id, displayName: task.completed_subject_name }
        : null
    })),
    amounts: await orderAmountSummary(db, context)
  };
}

export async function getOrderView(db: Kysely<Database>, orderId: string, accessLevel: AccessLevel = "WRITE") {
  return db.transaction().setIsolationLevel("repeatable read")
    .execute((trx) => getOrderViewSnapshot(trx, orderId, accessLevel));
}

export async function activeCoverageCandidates(db: DbExecutor, orderId: string, dates?: string[]): Promise<CoverageCandidate[]> {
  let query = db.selectFrom("coverage_items")
    .select(["service_date", "lot_id", "status", "inventory_unit_id", "unit_kind"])
    .where("order_id", "=", orderId)
    .where("status", "in", ["HELD", "CONSUMED"]);
  if (dates && dates.length > 0) query = query.where("service_date", "in", dates);
  const items = await query.orderBy("service_date").execute();
  return items.map((item) => ({
    serviceDate: item.service_date,
    entitlementLotId: item.lot_id,
    status: item.status as "HELD" | "CONSUMED",
    ...(item.status === "CONSUMED" ? {
      inventoryUnitId: item.inventory_unit_id,
      unitKind: item.unit_kind as "ROOM_NIGHT" | "BED_NIGHT"
    } : {})
  }));
}

export async function appendAmendment(trx: Transaction<Database>, options: {
  orderId: string;
  sequence: number;
  amendmentType: string;
  reasonCode: string;
  reasonNote: string;
  priorVersion: number;
  payload: Record<string, unknown>;
  commandId?: string;
}): Promise<string> {
  const id = newId("amend");
  await trx.insertInto("amendments").values({
    id,
    order_id: options.orderId,
    sequence: options.sequence,
    amendment_type: options.amendmentType,
    reason_code: options.reasonCode,
    reason_note: options.reasonNote,
    prior_version: options.priorVersion,
    new_version: options.priorVersion + 1,
    payload: options.payload,
    command_id: options.commandId ?? null
  }).execute();
  return id;
}

export async function holdCoverage(trx: Transaction<Database>, options: {
  orderId: string;
  contractId: string;
  memberId?: string;
  inventoryUnitId: string;
  revisionId: string;
  coverageSet: CoverageItemDto[];
  commandId: string;
}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const coverageIds: string[] = [];
  const factIds: string[] = [];
  for (const item of options.coverageSet) {
    const lotOwner = await trx.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.contract_id", "member_contracts.member_id"])
      .where("entitlement_lots.id", "=", item.entitlementLotId)
      .executeTakeFirst();
    if (!lotOwner || (options.memberId ? lotOwner.member_id !== options.memberId : lotOwner.contract_id !== options.contractId)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益不属于本次住宿选择的会员", 409);
    }
    const coverageContractId = lotOwner.contract_id;
    const existing = await trx.selectFrom("coverage_items")
      .select(["id", "status", "contract_id", "lot_id", "unit_kind", "inventory_unit_id"])
      .where("order_id", "=", options.orderId)
      .where("service_date", "=", item.serviceDate)
      .where("status", "!=", "RELEASED")
      .executeTakeFirst();
    if (existing) {
      if (existing.contract_id !== coverageContractId
        || existing.lot_id !== item.entitlementLotId
        || existing.unit_kind !== item.unitKind
        || existing.inventory_unit_id !== item.inventoryUnitId) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "Active coverage differs from the requested coverage", 409, false, {
          orderId: options.orderId,
          serviceDate: item.serviceDate,
          coverageId: existing.id
        });
      }
      coverageIds.push(existing.id);
      continue;
    }
    const coverageId = newId("coverage");
    await trx.insertInto("coverage_items").values({
      id: coverageId,
      order_id: options.orderId,
      contract_id: coverageContractId,
      lot_id: item.entitlementLotId,
      inventory_unit_id: item.inventoryUnitId,
      service_date: item.serviceDate,
      unit_kind: item.unitKind,
      status: "HELD",
      held_by_revision_id: options.revisionId
    }).execute();
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: item.entitlementLotId,
      entry_type: "HOLD",
      quantity_delta: -1,
      service_date: item.serviceDate,
      order_id: options.orderId,
      coverage_id: coverageId,
      reason: "ORDER_COVERAGE_HOLD",
      command_id: options.commandId
    }).execute();
    factIds.push(factId);
    coverageIds.push(coverageId);
  }
  return { coverageIds, factIds };
}

function coverageMatches(item: {
  contract_id: string;
  lot_id: string;
  inventory_unit_id: string;
  unit_kind: string;
}, desired: CoverageItemDto, contractId: string): boolean {
  return item.contract_id === contractId
    && item.lot_id === desired.entitlementLotId
    && item.inventory_unit_id === desired.inventoryUnitId
    && item.unit_kind === desired.unitKind;
}

export async function reconcileCoverage(trx: Transaction<Database>, options: {
  orderId: string;
  contractId: string;
  memberId?: string;
  revisionId: string;
  coverageSet: CoverageItemDto[];
  commandId: string;
}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const desiredByDate = new Map<string, { item: CoverageItemDto; contractId: string }>();
  for (const item of options.coverageSet) {
    if (desiredByDate.has(item.serviceDate)) {
      throw new DomainError("INTERNAL_ERROR", `Pricing produced duplicate coverage on ${item.serviceDate}`, 500);
    }
    const lotOwner = await trx.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.contract_id", "member_contracts.member_id"])
      .where("entitlement_lots.id", "=", item.entitlementLotId)
      .executeTakeFirst();
    if (!lotOwner || (options.memberId ? lotOwner.member_id !== options.memberId : lotOwner.contract_id !== options.contractId)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益不属于本次住宿选择的会员", 409);
    }
    desiredByDate.set(item.serviceDate, { item, contractId: lotOwner.contract_id });
  }

  const active = await trx.selectFrom("coverage_items")
    .selectAll()
    .where("order_id", "=", options.orderId)
    .where("status", "!=", "RELEASED")
    .orderBy("service_date")
    .forUpdate()
    .execute();
  const existingLotIds = [...new Set(active.map((item) => item.lot_id))];
  const expirationRows = existingLotIds.length > 0
    ? await trx.selectFrom("entitlement_ledger")
      .select("lot_id")
      .distinct()
      .where("lot_id", "in", existingLotIds)
      .where("entry_type", "=", "EXPIRE")
      .execute()
    : [];
  const expiredLotIds = new Set(expirationRows.map((row) => row.lot_id));
  const changedLotIds = new Set<string>();
  const coverageIds: string[] = [];
  const factIds: string[] = [];

  for (const item of active) {
    const desired = desiredByDate.get(item.service_date);
    if (item.status === "CONSUMED") {
      if (desired && !coverageMatches(item, desired.item, desired.contractId)) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "A pricing revision cannot rewrite consumed coverage", 409, false, {
          orderId: options.orderId,
          serviceDate: item.service_date,
          coverageId: item.id
        });
      }
      if (desired) desiredByDate.delete(item.service_date);
      coverageIds.push(item.id);
      continue;
    }
    if (desired && coverageMatches(item, desired.item, desired.contractId)) {
      desiredByDate.delete(item.service_date);
      coverageIds.push(item.id);
      continue;
    }

    await trx.updateTable("coverage_items")
      .set({ status: "RELEASED", updated_at: new Date() })
      .where("id", "=", item.id)
      .execute();
    coverageIds.push(item.id);
    const releaseFactId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: releaseFactId, lot_id: item.lot_id, entry_type: "RELEASE", quantity_delta: 1,
      service_date: item.service_date, order_id: options.orderId, coverage_id: item.id,
      reason: "ORDER_COVERAGE_RELEASE", command_id: options.commandId
    }).execute();
    factIds.push(releaseFactId);
    if (expiredLotIds.has(item.lot_id) && desired?.item.entitlementLotId !== item.lot_id) {
      const expirationFactId = newId("fact");
      await trx.insertInto("entitlement_ledger").values({
        fact_id: expirationFactId, lot_id: item.lot_id, entry_type: "EXPIRE", quantity_delta: -1,
        service_date: item.service_date, order_id: options.orderId, coverage_id: item.id,
        reason: "RELEASE_AFTER_EXPIRY", command_id: options.commandId
      }).execute();
      factIds.push(expirationFactId);
    }
    changedLotIds.add(item.lot_id);
  }

  for (const desired of desiredByDate.values()) {
    const { item, contractId } = desired;
    const coverageId = newId("coverage");
    await trx.insertInto("coverage_items").values({
      id: coverageId,
      order_id: options.orderId,
      contract_id: contractId,
      lot_id: item.entitlementLotId,
      inventory_unit_id: item.inventoryUnitId,
      service_date: item.serviceDate,
      unit_kind: item.unitKind,
      status: "HELD",
      held_by_revision_id: options.revisionId
    }).execute();
    const holdFactId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: holdFactId,
      lot_id: item.entitlementLotId,
      entry_type: "HOLD",
      quantity_delta: -1,
      service_date: item.serviceDate,
      order_id: options.orderId,
      coverage_id: coverageId,
      reason: "ORDER_COVERAGE_HOLD",
      command_id: options.commandId
    }).execute();
    factIds.push(holdFactId);
    changedLotIds.add(item.entitlementLotId);
    coverageIds.push(coverageId);
  }

  if (changedLotIds.size > 0) {
    const changedLots = await trx.selectFrom("entitlement_lots").select(["id", "contract_id"])
      .where("id", "in", [...changedLotIds]).execute();
    for (const contractId of new Set(changedLots.map((row) => row.contract_id))) {
      await incrementContractAndLotVersions(trx, contractId, changedLots.filter((row) => row.contract_id === contractId).map((row) => row.id));
    }
  }
  return { coverageIds, factIds };
}

export async function releaseCoverage(trx: Transaction<Database>, orderId: string, commandId: string, options: {
  fromDate?: string;
  incompatibleUnitKind?: string;
  reholdCoverageSet?: CoverageItemDto[];
} = {}): Promise<{ coverageIds: string[]; factIds: string[] }> {
  let query = trx.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).where("status", "=", "HELD");
  if (options.fromDate) query = query.where("service_date", ">=", options.fromDate);
  if (options.incompatibleUnitKind) query = query.where("unit_kind", "!=", options.incompatibleUnitKind);
  const items = await query.forUpdate().execute();
  const lotIds = [...new Set(items.map((item) => item.lot_id))];
  const expirationRows = lotIds.length > 0 ? await trx.selectFrom("entitlement_ledger")
    .select("lot_id").distinct().where("lot_id", "in", lotIds).where("entry_type", "=", "EXPIRE").execute() : [];
  const expiredLotIds = new Set(expirationRows.map((row) => row.lot_id));
  const reholdKeys = new Set((options.reholdCoverageSet ?? []).map((item) => `${item.serviceDate}:${item.entitlementLotId}`));
  const factIds: string[] = [];
  for (const item of items) {
    await trx.updateTable("coverage_items").set({ status: "RELEASED", updated_at: new Date() }).where("id", "=", item.id).execute();
    const releaseFactId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: releaseFactId, lot_id: item.lot_id, entry_type: "RELEASE", quantity_delta: 1,
      service_date: item.service_date, order_id: orderId, coverage_id: item.id,
      reason: "ORDER_COVERAGE_RELEASE", command_id: commandId
    }).execute();
    factIds.push(releaseFactId);
    if (expiredLotIds.has(item.lot_id) && !reholdKeys.has(`${item.service_date}:${item.lot_id}`)) {
      const expirationFactId = newId("fact");
      await trx.insertInto("entitlement_ledger").values({
        fact_id: expirationFactId, lot_id: item.lot_id, entry_type: "EXPIRE", quantity_delta: -1,
        service_date: item.service_date, order_id: orderId, coverage_id: item.id,
        reason: "RELEASE_AFTER_EXPIRY", command_id: commandId
      }).execute();
      factIds.push(expirationFactId);
    }
  }
  for (const contractId of new Set(items.map((item) => item.contract_id))) {
    await incrementContractAndLotVersions(trx, contractId, [...new Set(items.filter((item) => item.contract_id === contractId).map((item) => item.lot_id))]);
  }
  return { coverageIds: items.map((item) => item.id), factIds };
}

export async function consumeCoverage(trx: Transaction<Database>, orderId: string, commandId: string): Promise<{ coverageIds: string[]; factIds: string[] }> {
  const items = await trx.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).where("status", "=", "HELD").forUpdate().execute();
  const factIds: string[] = [];
  for (const item of items) {
    await trx.updateTable("coverage_items").set({ status: "CONSUMED", updated_at: new Date() }).where("id", "=", item.id).execute();
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: item.lot_id, entry_type: "CONSUME", quantity_delta: 0,
      service_date: item.service_date, order_id: orderId, coverage_id: item.id,
      reason: "CHECK_IN_ENTITLEMENT_CONSUMED", command_id: commandId
    }).execute();
    factIds.push(factId);
  }
  for (const contractId of new Set(items.map((item) => item.contract_id))) {
    await incrementContractAndLotVersions(trx, contractId, [...new Set(items.filter((item) => item.contract_id === contractId).map((item) => item.lot_id))]);
  }
  return { coverageIds: items.map((item) => item.id), factIds };
}

export async function incrementContractAndLotVersions(trx: Transaction<Database>, contractId: string, lotIds: string[]): Promise<void> {
  await trx.updateTable("member_contracts").set({ version: sql`version + 1` }).where("id", "=", contractId).execute();
  if (lotIds.length > 0) await trx.updateTable("entitlement_lots").set({ version: sql`version + 1` }).where("id", "in", lotIds).execute();
}
