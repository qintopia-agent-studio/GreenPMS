import { sql, type Transaction } from "kysely";
import { DomainError, type CommandReason, type CoverageItemDto } from "@qintopia/contracts";
import { enumerateServiceDates, newId, stableHash } from "@qintopia/domain";
import { entitlementAvailableBalance } from "../entitlement-balance.ts";
import { inventoryFingerprint, loadInventoryUnit, lockRoomDays, createInventoryClaims, type DbExecutor } from "../inventory.ts";
import { appendAmendment, consumeCoverage, getOrderViewSnapshot, reconcileCoverage, type OrderContext, type StayTimelineItem } from "../orders.ts";
import type { Database } from "../schema.ts";

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export async function loadCheckoutReversalPlan(db: DbExecutor, context: OrderContext) {
  if (context.order.status !== "CHECKED_OUT" || context.stay.status !== "COMPLETED") {
    throw new DomainError("INVALID_ORDER_STATE", "只有已退房订单可以撤销退房", 409);
  }
  const view = await getOrderViewSnapshot(db, context.order.id);
  const checkout = view.amendments.findLast((item) => item.amendment_type === "CHECK_OUT");
  if (!checkout || !view.fulfillment.checkOut) {
    throw new DomainError("INVALID_ORDER_STATE", "订单缺少可撤销的退房记录", 409);
  }
  if (view.amendments.some((item) => item.sequence > checkout.sequence && item.amendment_type !== "CORRECT_ORDER_OCCUPANT")) {
    throw new DomainError("INVALID_ORDER_STATE", "退房后已有住宿、计价或会员变更，无法直接恢复退房前安排", 409);
  }
  if (view.cleaningTasks.length > 0) {
    throw new DomainError("INVALID_ORDER_STATE", "该退房已关联清洁任务，不能直接撤销", 409);
  }
  const shorten = view.amendments.find((item) => item.sequence === checkout.sequence - 1
    && item.amendment_type === "SHORTEN_STAY" && item.command_id === checkout.command_id);
  const segmentIndex = shorten ? view.segments.findIndex((item) => item.amendment_id === shorten.id) : -1;
  const arrangement = shorten ? view.arrangementHistory[segmentIndex]?.before : view.effectiveArrangement;
  const sourceRevision = shorten
    ? view.pricingRevisions.findLast((revision) => {
      const amendment = view.amendments.find((item) => item.id === revision.amendment_id);
      return amendment && amendment.sequence < shorten.sequence;
    })
    : view.pricingRevisions.find((revision) => revision.id === context.revision.id);
  if (!arrangement || !sourceRevision || sourceRevision.arrival_date !== arrangement.arrivalDate
    || sourceRevision.departure_date !== arrangement.departureDate) {
    throw new DomainError("INVALID_ORDER_STATE", "退房前安排与计价记录不完整，无法完整撤销", 409);
  }
  const stayTimeline = arrangement.intervals.flatMap((interval) => enumerateServiceDates(interval.arrivalDate, interval.departureDate)
    .map((serviceDate) => ({ serviceDate, inventoryUnitId: interval.inventoryUnitId })));
  // Reconstruct the original consumption from immutable facts. Conversion pricing
  // can have an empty coverage_set, while earlier shortenings retain consumed nights.
  const sourceCommands = [...new Set(view.amendments.filter((item) => item.sequence < (shorten ?? checkout).sequence)
    .map((item) => item.command_id).filter((id): id is string => id !== null))];
  const originalConsumption = await db.selectFrom("entitlement_ledger").select("coverage_id")
    .where("order_id", "=", context.order.id).where("command_id", "in", sourceCommands)
    .where("coverage_id", "is not", null).groupBy("coverage_id")
    .having(sql<boolean>`sum(quantity_delta) = -1 and bool_or(entry_type in ('CONSUME', 'CONVERSION_CONSUME'))`).execute();
  const originalIds = new Set(originalConsumption.map((item) => item.coverage_id));
  const coverageSet: CoverageItemDto[] = view.coverageSet.filter((item) => originalIds.has(item.id))
    .map((item) => {
      if (item.unit_kind !== "ROOM_NIGHT" && item.unit_kind !== "BED_NIGHT") {
        throw new DomainError("ENTITLEMENT_CONFLICT", "原住宿权益类型不完整", 409);
      }
      return { serviceDate: item.service_date, inventoryUnitId: item.inventory_unit_id,
        entitlementLotId: item.lot_id, unitKind: item.unit_kind };
    });
  if (new Set(coverageSet.map((item) => item.serviceDate)).size !== coverageSet.length
    || (view.membershipConversion && stayTimeline.some((item) => !coverageSet.some((coverage) => coverage.serviceDate === item.serviceDate)))) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "原住宿的逐晚核销记录不完整，无法撤销退房", 409);
  }
  const activeCoverage = view.coverageSet.filter((item) => item.status !== "RELEASED");
  const reconsumeCoverage = coverageSet.filter((desired) => !activeCoverage.some((item) => item.service_date === desired.serviceDate));
  for (const active of activeCoverage) {
    const desired = coverageSet.find((item) => item.serviceDate === active.service_date);
    if (active.status !== "CONSUMED" || !desired || desired.entitlementLotId !== active.lot_id
      || desired.inventoryUnitId !== active.inventory_unit_id || desired.unitKind !== active.unit_kind) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "当前核销与原住宿权益不一致，无法撤销退房", 409);
    }
  }
  const businessDate = view.effectiveArrangement.businessDate;
  const lastUnitId = stayTimeline.at(-1)!.inventoryUnitId;
  const inventoryChecks = [...stayTimeline];
  for (let serviceDate = arrangement.departureDate; serviceDate <= businessDate; serviceDate = nextDate(serviceDate)) {
    inventoryChecks.push({ serviceDate, inventoryUnitId: lastUnitId });
  }
  const net = view.collectionFacts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
  const money = (minorUnits: number) => ({ currency: sourceRevision.currency, minorUnits });
  const effect = {
    operation: "REVOKE_CHECK_OUT" as const,
    orderId: context.order.id,
    fromStatus: "CHECKED_OUT" as const,
    toStatus: "CHECKED_IN" as const,
    checkoutAmendmentId: checkout.id,
    checkoutSequence: checkout.sequence,
    sourceRevisionId: sourceRevision.id,
    mode: shorten ? "UNDO_EARLY_CHECK_OUT" as const : "UNDO_CHECK_OUT" as const,
    businessDate,
    before: { arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      currentContractAmount: money(context.revision.currentContractAmountMinor) },
    after: { arrivalDate: arrangement.arrivalDate, departureDate: arrangement.departureDate,
      stayTimeline, currentContractAmount: money(sourceRevision.current_contract_amount_minor) },
    entitlementReconsumeDates: reconsumeCoverage.map((item) => item.serviceDate),
    fundsSummary: { netRecordedCollection: money(net),
      collectionDifference: money(sourceRevision.current_contract_amount_minor - net),
      refundReferenceAmount: money(Math.max(0, net - sourceRevision.current_contract_amount_minor)) }
  };
  return { effect, sourceRevision, coverageSet, reconsumeCoverage, inventoryChecks, view };
}

export async function buildCheckoutReversalEffect(db: DbExecutor, context: OrderContext) {
  const plan = await loadCheckoutReversalPlan(db, context);
  const lotIds = [...new Set(plan.reconsumeCoverage.map((item) => item.entitlementLotId))].sort();
  const ownerId = context.order.member_id ?? (context.order.member_contract_id
    ? (await db.selectFrom("member_contracts").select("member_id")
      .where("id", "=", context.order.member_contract_id).executeTakeFirst())?.member_id : undefined);
  const membership = [];
  for (const lotId of lotIds) {
    const lot = await db.selectFrom("entitlement_lots as lot")
      .innerJoin("member_contracts as contract", "contract.id", "lot.contract_id")
      .select(["lot.id", "lot.total_units", "lot.version", "lot.expires_on", "lot.status as lot_status",
        "contract.valid_from", "contract.valid_until", "contract.version as contract_version",
        "contract.member_id", "contract.status"])
      .where("lot.id", "=", lotId).executeTakeFirst();
    const totals = await db.selectFrom("entitlement_ledger").select([
      sql<string>`coalesce(sum(quantity_delta), 0)::text`.as("delta"),
      sql<string>`count(*) filter (where entry_type in ('EXPIRE', 'VOID'))::text`.as("expired")
    ]).where("lot_id", "=", lotId).executeTakeFirstOrThrow();
    const desired = plan.reconsumeCoverage.filter((item) => item.entitlementLotId === lotId);
    if (!lot || lot.status !== "ACTIVE" || lot.lot_status !== "ACTIVE" || lot.member_id !== ownerId
      || lot.expires_on < plan.effect.businessDate || Number(totals.expired) > 0
      || desired.some((item) => item.serviceDate < lot.valid_from || item.serviceDate > lot.valid_until || item.serviceDate > lot.expires_on)
      || entitlementAvailableBalance(lot.total_units, totals.delta) < desired.length) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "原会员权益已失效或可用数量不足，无法完整撤销退房", 409);
    }
    membership.push({ ...lot, ...totals });
  }
  const inventory = [];
  for (const item of plan.inventoryChecks) {
    const fingerprint = await inventoryFingerprint(db, context.order.property_id, item.inventoryUnitId,
      item.serviceDate, nextDate(item.serviceDate), context.segmentIds);
    if (fingerprint.length > 0) {
      throw new DomainError("INVENTORY_CONFLICT", "原房间已有订单、维修或内部占用，无法撤销退房", 409, false,
        { serviceDate: item.serviceDate, inventoryUnitId: item.inventoryUnitId });
    }
    inventory.push({ ...item, fingerprint });
  }
  const basisVersions = { orderVersion: context.order.version, sourceRevision: plan.sourceRevision,
    coverage: plan.view.coverageSet, funds: plan.view.collectionFacts, membership, inventory };
  return { propertyId: context.order.property_id, effect: plan.effect, basisVersions,
    effectHash: stableHash({ effect: plan.effect, basisVersions }) };
}

export async function lockCheckoutReversalInventory(trx: Transaction<Database>, context: OrderContext) {
  if (context.order.status !== "CHECKED_OUT") return;
  const { inventoryChecks } = await loadCheckoutReversalPlan(trx, context);
  const units = await trx.selectFrom("inventory_units").select(["id", "parent_room_id"])
    .where("id", "in", [...new Set(inventoryChecks.map((item) => item.inventoryUnitId))]).execute();
  const metadataIds = [...new Set(units.flatMap((unit) => [unit.id, ...(unit.parent_room_id ? [unit.parent_room_id] : [])]))].sort();
  await trx.selectFrom("inventory_units").select("id").where("id", "in", metadataIds).orderBy("id").forUpdate().execute();
  const roomDates = [];
  for (const item of inventoryChecks) {
    const unit = await loadInventoryUnit(trx, context.order.property_id, item.inventoryUnitId);
    roomDates.push({ roomId: unit.roomId, serviceDate: item.serviceDate });
  }
  await lockRoomDays(trx, roomDates);
}

export async function applyCheckoutReversal(trx: Transaction<Database>, context: OrderContext,
  commandId: string, reason: CommandReason, effect: Record<string, unknown>) {
  const plan = await loadCheckoutReversalPlan(trx, context);
  if (stableHash(plan.effect) !== stableHash(effect)) {
    throw new DomainError("PREVIEW_STALE", "退房记录已经变化，请重新核对", 409);
  }
  const amendmentId = await appendAmendment(trx, { orderId: context.order.id,
    sequence: context.order.version + 1, amendmentType: "REVOKE_CHECK_OUT", reasonCode: reason.code,
    reasonNote: reason.note, priorVersion: context.order.version, payload: effect, commandId });
  const segmentId = newId("segment");
  const revisionId = newId("revision");
  const timeline: StayTimelineItem[] = plan.effect.after.stayTimeline;
  const lastUnitId = timeline.at(-1)!.inventoryUnitId;
  let tailIndex = timeline.length - 1;
  while (tailIndex > 0 && timeline[tailIndex - 1]!.inventoryUnitId === lastUnitId) tailIndex -= 1;
  await trx.insertInto("stay_segments").values({ id: segmentId, stay_id: context.stay.id,
    sequence: context.currentSegment.sequence + 1, inventory_unit_id: lastUnitId,
    arrival_date: timeline[tailIndex]!.serviceDate, departure_date: plan.effect.after.departureDate,
    segment_type: "REVOKE_CHECK_OUT", supersedes_segment_id: context.currentSegment.id, amendment_id: amendmentId }).execute();
  const source = plan.sourceRevision;
  await trx.insertInto("pricing_revisions").values({ id: revisionId, order_id: context.order.id,
    revision_no: context.revision.revisionNo + 1, amendment_id: amendmentId, policy_version_id: source.policy_version_id,
    arrival_date: source.arrival_date, departure_date: source.departure_date,
    coverage_set: JSON.stringify(source.coverage_set), cash_lines: JSON.stringify(source.cash_lines),
    policy_base_amount_minor: source.policy_base_amount_minor, pricing_basis: source.pricing_basis,
    manual_adjustment_minor: source.manual_adjustment_minor,
    current_contract_amount_minor: source.current_contract_amount_minor, currency: source.currency }).execute();
  const claimIds = [];
  for (const unitId of new Set(timeline.map((item) => item.inventoryUnitId))) {
    const unit = await loadInventoryUnit(trx, context.order.property_id, unitId);
    claimIds.push(...await createInventoryClaims(trx, { propertyId: context.order.property_id, unit,
      dates: timeline.filter((item) => item.inventoryUnitId === unitId).map((item) => item.serviceDate),
      sourceType: "ORDER_SEGMENT", sourceId: segmentId }));
  }
  let coverageRefs = { coverageIds: [] as string[], factIds: [] as string[] };
  let consumptionRefs = { coverageIds: [] as string[], factIds: [] as string[] };
  if (plan.reconsumeCoverage.length > 0) {
    coverageRefs = await reconcileCoverage(trx, { orderId: context.order.id,
      contractId: context.order.member_contract_id ?? "", ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
      revisionId, coverageSet: plan.coverageSet, commandId });
    consumptionRefs = await consumeCoverage(trx, context.order.id, commandId,
      { serviceDates: plan.effect.entitlementReconsumeDates, reason: "REVOKE_CHECK_OUT_ENTITLEMENT_CONSUMED" });
  }
  await trx.updateTable("orders").set({ status: "CHECKED_IN", departure_date: source.departure_date,
    current_revision_id: revisionId, version: context.order.version + 1, updated_at: new Date() })
    .where("id", "=", context.order.id).execute();
  await trx.updateTable("stays").set({ status: "IN_HOUSE" }).where("id", "=", context.stay.id).execute();
  return { persistedResult: { stayId: context.stay.id, amendmentId,
    staySegmentId: segmentId, pricingRevisionId: revisionId, status: "CHECKED_IN", ...plan.effect },
    resourceRefs: [context.order.id, context.stay.id, amendmentId, segmentId, revisionId,
      ...claimIds, ...new Set([...coverageRefs.coverageIds, ...consumptionRefs.coverageIds])],
    factRefs: [...coverageRefs.factIds, ...consumptionRefs.factIds] };
}
