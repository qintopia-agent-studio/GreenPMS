import { sql, type Transaction } from "kysely";
import {
  createOrderPricingBasisCodes,
  currentReleaseFeatures,
  DomainError,
  type CommandReason,
  type CommandType,
  type CoverageItemDto,
  type CreateOrderPricingBasis
} from "@qintopia/contracts";
import { enumerateServiceDates, newId, parseLocalDate, requireTransactionReference, validateBookingChannel } from "@qintopia/domain";
import { assertUnitAvailable, createInventoryClaims, loadInventoryUnit, loadInventoryUnitIncludingInactive, lockRoomDays, lockUnitDates, releaseInventoryClaims, releaseInventoryClaimsOnDates } from "../inventory.ts";
import { appendAmendment, consumeCoverage, holdCoverage, incrementContractAndLotVersions, loadActiveStayTimeline, loadOrderContext, lockOrder, reconcileCoverage, releaseCoverage, restoreConsumedCoverage, type StayTimelineItem } from "../orders.ts";
import { loadStoredQuote, lockEntitlementLots, lockMemberEntitlementLots } from "../pricing-service.ts";
import type { Database } from "../schema.ts";
import { planStayDateChangeTimeline, timelinePairDiff } from "../stay-timeline-plan.ts";
import { normalizeIdentityCardNumber, requireObject, requireString } from "./effects.ts";

export interface AppliedCommand {
  persistedResult: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
}

const migratedOrderRepricingCommands = new Set<CommandType>([
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "REFRESH_MEMBER_COVERAGE",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
]);

function rethrowTokenSecretConflict(error: unknown): never {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code === "23505" && databaseError.constraint === "api_tokens_secret_hash_key") {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Token secret is already assigned", 409);
  }
  throw error;
}

function rethrowMemberRegistrationConflict(error: unknown): never {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code === "23505" && databaseError.constraint === "members_identity_card_number_key") {
    throw new DomainError("VALIDATION_ERROR", "该身份证号已登记，不能重复创建会员档案", 409);
  }
  throw error;
}

function nestedObject(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return requireObject(record[field], field);
}

function pricingObject(effect: Record<string, unknown>): Record<string, unknown> {
  if (effect.pricing) return requireObject(effect.pricing, "pricing");
  return nestedObject(nestedObject(effect, "after"), "pricing");
}

function moneyMinor(value: unknown, field: string): { currency: string; minorUnits: number } {
  const money = requireObject(value, field);
  const currency = requireString(money, "currency");
  if (!Number.isInteger(money.minorUnits)) throw new DomainError("INTERNAL_ERROR", `${field}.minorUnits is invalid`, 500);
  return { currency, minorUnits: money.minorUnits as number };
}

function pricingSnapshot(effect: Record<string, unknown>, orderIdentity?: {
  stayType: string;
  memberId: string | null;
  memberContractId: string | null;
}) {
  const pricing = pricingObject(effect);
  const coverageSet = pricing.coverageSet;
  const cashLines = pricing.cashLines;
  if (!Array.isArray(coverageSet) || !Array.isArray(cashLines)) throw new DomainError("INTERNAL_ERROR", "Pricing effect is invalid", 500);
  const contract = moneyMinor(pricing.currentContractAmount, "currentContractAmount");
  const cashRemainder = moneyMinor(pricing.cashRemainder, "cashRemainder");
  const decision = effect.pricingDecision ? requireObject(effect.pricingDecision, "pricingDecision") : undefined;
  const policyBase = decision ? moneyMinor(decision.policyBaseAmount, "policyBaseAmount") : cashRemainder;
  const pricingBasisValue = decision?.pricingBasis;
  const categoricalBasis = orderIdentity?.stayType === "FREE"
    ? "FREE"
    : orderIdentity?.memberId || orderIdentity?.memberContractId
      ? "MEMBER_ENTITLEMENT"
      : undefined;
  const pricingBasis = pricingBasisValue === undefined
    ? categoricalBasis ?? (contract.minorUnits === cashRemainder.minorUnits ? "POLICY" : "MANUAL_ADJUSTMENT")
    : createOrderPricingBasisCodes.includes(pricingBasisValue as CreateOrderPricingBasis)
      ? pricingBasisValue as CreateOrderPricingBasis
      : undefined;
  if (!pricingBasis) throw new DomainError("INTERNAL_ERROR", "Create order pricing basis is invalid", 500);
  if (policyBase.currency !== contract.currency) throw new DomainError("INTERNAL_ERROR", "Pricing currencies do not match", 500);
  const manualAdjustmentMinor = decision?.manualAdjustmentMinor;
  if (manualAdjustmentMinor !== undefined && !Number.isInteger(manualAdjustmentMinor)) {
    throw new DomainError("INTERNAL_ERROR", "Create order manual adjustment is invalid", 500);
  }
  const reasonValue = decision?.reason;
  const reason = reasonValue === undefined ? undefined : requireObject(reasonValue, "reason");
  const reasonCode = reason === undefined ? undefined : requireString(reason, "code");
  const reasonNoteValue = reason?.note;
  if (reasonNoteValue !== undefined && typeof reasonNoteValue !== "string") {
    throw new DomainError("INTERNAL_ERROR", "Create order pricing reason note is invalid", 500);
  }
  return {
    coverageSet: coverageSet as CoverageItemDto[],
    cashLines,
    policyBaseAmountMinor: policyBase.minorUnits,
    pricingBasis,
    currentContractAmountMinor: contract.minorUnits,
    manualAdjustmentMinor: manualAdjustmentMinor as number | undefined ?? contract.minorUnits - cashRemainder.minorUnits,
    currency: contract.currency,
    ...(reasonCode ? { reason: { code: reasonCode, note: reasonNoteValue as string ?? "" } } : {})
  };
}

function stayTimelineFromEffect(effect: Record<string, unknown>): StayTimelineItem[] {
  const after = effect.after && typeof effect.after === "object" && !Array.isArray(effect.after) ? effect.after as Record<string, unknown> : undefined;
  const rawTimeline = effect.stayTimeline ?? after?.stayTimeline;
  if (!Array.isArray(rawTimeline) || rawTimeline.length === 0) throw new DomainError("INTERNAL_ERROR", "Command effect has no stay timeline", 500);
  return rawTimeline.map((rawItem, index) => {
    const item = requireObject(rawItem, `stayTimeline[${index}]`);
    return { serviceDate: requireString(item, "serviceDate"), inventoryUnitId: requireString(item, "inventoryUnitId") };
  });
}

function stringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  }
  return value as string[];
}

function inventoryClaimSummaries(record: Record<string, unknown>, field: string): Array<{ serviceDate: string; inventoryUnitId: string }> {
  const value = record[field];
  if (!Array.isArray(value)) throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  return value.map((entry, index) => {
    const item = requireObject(entry, `${field}[${index}]`);
    return {
      serviceDate: requireString(item, "serviceDate"),
      inventoryUnitId: requireString(item, "inventoryUnitId")
    };
  });
}

function trailingTimelineRun(timeline: StayTimelineItem[]): { inventoryUnitId: string; arrivalDate: string } {
  const last = timeline.at(-1)!;
  let startIndex = timeline.length - 1;
  while (startIndex > 0 && timeline[startIndex - 1]!.inventoryUnitId === last.inventoryUnitId) startIndex -= 1;
  return { inventoryUnitId: last.inventoryUnitId, arrivalDate: timeline[startIndex]!.serviceDate };
}

async function roomDatesForTimeline(trx: Transaction<Database>, propertyId: string, timeline: StayTimelineItem[]) {
  const unitIds = [...new Set(timeline.map((item) => item.inventoryUnitId))];
  const units = new Map((await Promise.all(unitIds.map((unitId) => loadInventoryUnit(trx, propertyId, unitId)))).map((unit) => [unit.id, unit]));
  return timeline.map((item) => ({ roomId: units.get(item.inventoryUnitId)!.roomId, serviceDate: item.serviceDate }));
}

async function assertNoActiveMigrationOverdueHold(trx: Transaction<Database>, orderId: string): Promise<void> {
  const activeHold = await trx.selectFrom("migration_overdue_inventory_holds as hold")
    .leftJoin("migration_overdue_inventory_hold_releases as release", "release.hold_id", "hold.id")
    .select("hold.id")
    .where("hold.order_id", "=", orderId)
    .where("release.id", "is", null)
    .executeTakeFirst();
  if (activeHold) {
    throw new DomainError(
      "INVALID_ORDER_STATE",
      "请先确认历史逾期在住的真实离店日和续住金额",
      409
    );
  }
}

export async function lockCommandResources(trx: Transaction<Database>, commandType: CommandType, rawInput: unknown): Promise<void> {
  const input = requireObject(rawInput);
  const propertyId = requireString(input, "propertyId");

  if (commandType === "CREATE_MEMBER") {
    const identityCardNumber = normalizeIdentityCardNumber(input.identityCardNumber);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-identity:${identityCardNumber}`}, 0::bigint))`.execute(trx);
    await trx.selectFrom("members").select("id")
      .where("identity_card_number", "=", identityCardNumber).forUpdate().executeTakeFirst();
    return;
  }

  if (commandType === "CREATE_MEMBERSHIP_ORDER") {
    const memberId = requireString(input, "memberId");
    const productId = requireString(input, "membershipProductId");
    const member = await trx.selectFrom("member_property_links").select("member_id")
      .where("member_id", "=", memberId).where("property_id", "=", propertyId).forShare().executeTakeFirst();
    if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
    const product = await trx.selectFrom("membership_products").select("id").where("id", "=", productId).forShare().executeTakeFirst();
    if (!product) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
    return;
  }

  if (commandType === "RECORD_MEMBERSHIP_PAYMENT" || commandType === "CORRECT_MEMBERSHIP_PAYMENT" || commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
    const membershipOrderId = requireString(input, "membershipOrderId");
    const order = await trx.selectFrom("membership_orders").select(["id", "member_id"])
      .where("id", "=", membershipOrderId).where("property_id", "=", propertyId).forUpdate().executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
    if (commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${order.member_id}`}, 0::bigint))`.execute(trx);
      await trx.selectFrom("members").select("id").where("id", "=", order.member_id).forUpdate().executeTakeFirst();
    }
    await trx.selectFrom("membership_payment_facts").select("fact_id")
      .where("membership_order_id", "=", membershipOrderId).forUpdate().execute();
    return;
  }

  if (commandType === "CREATE_ORDER") {
    const quote = await loadStoredQuote(trx, requireString(input, "quoteId"));
    if (quote.memberId) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${quote.memberId}`}, 0::bigint))`.execute(trx);
      await trx.selectFrom("members").select("id").where("id", "=", quote.memberId).forUpdate().executeTakeFirst();
    }
    await lockEntitlementLots(trx, quote.memberContractId);
    await lockUnitDates(trx, propertyId, quote.inventoryUnitId, quote.arrivalDate, quote.departureDate);
    return;
  }
  if (commandType === "LOCK_MAINTENANCE") {
    await lockUnitDates(trx, propertyId, requireString(input, "inventoryUnitId"), requireString(input, "arrivalDate"), requireString(input, "departureDate"));
    return;
  }
  if (commandType === "RELEASE_MAINTENANCE") {
    const lock = await trx.selectFrom("maintenance_locks").selectAll().where("id", "=", requireString(input, "maintenanceLockId")).where("property_id", "=", propertyId).forUpdate().executeTakeFirst();
    if (!lock) throw new DomainError("NOT_FOUND", "Maintenance lock not found", 404);
    await lockUnitDates(trx, propertyId, lock.inventory_unit_id, lock.arrival_date, lock.departure_date, true);
    return;
  }
  if (commandType === "COMPLETE_CLEANING") {
    const task = await trx.selectFrom("cleaning_tasks").select("id")
      .where("id", "=", requireString(input, "cleaningTaskId"))
      .where("property_id", "=", propertyId)
      .forUpdate()
      .executeTakeFirst();
    if (!task) throw new DomainError("NOT_FOUND", "Cleaning task not found", 404);
    return;
  }
  if (commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(input, "memberContractId");
    const contract = await trx.selectFrom("member_contracts").select("id")
      .where("id", "=", contractId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!contract) throw new DomainError("NOT_FOUND", "Member contract not found", 404);
    await lockEntitlementLots(trx, contractId);
    return;
  }
  if (commandType === "ADJUST_MEMBER_ENTITLEMENT" || commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE" || commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lot = await trx.selectFrom("entitlement_lots").innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.contract_id"])
      .where("entitlement_lots.id", "=", requireString(input, "entitlementLotId"))
      .where("member_contracts.property_id", "=", propertyId).executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    await lockEntitlementLots(trx, lot.contract_id);
    return;
  }
  if (commandType === "ISSUE_TOKEN") {
    const subjectId = requireString(input, "subjectId");
    const subject = await trx.selectFrom("subjects").select("id").where("id", "=", subjectId).forUpdate().executeTakeFirst();
    if (!subject) throw new DomainError("NOT_FOUND", "Subject not found", 404);
    return;
  }
  if (commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN") {
    const token = await trx.selectFrom("api_tokens").select("subject_id").where("id", "=", requireString(input, "tokenId")).forUpdate().executeTakeFirst();
    if (!token) throw new DomainError("NOT_FOUND", "Token not found", 404);
    await trx.selectFrom("subjects").select("id").where("id", "=", token.subject_id).forUpdate().executeTakeFirst();
    return;
  }

  if (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    const orderId = requireString(input, "orderId");
    const memberId = requireString(input, "memberId");
    await lockOrder(trx, orderId);
    const context = await loadOrderContext(trx, orderId);
    if (context.order.property_id !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Order belongs to another property", 403);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${memberId}`}, 0::bigint))`.execute(trx);
    await trx.selectFrom("members").select("id").where("id", "=", memberId).forUpdate().executeTakeFirst();
    await trx.selectFrom("membership_products").select("id")
      .where("id", "=", requireString(input, "membershipProductId"))
      .forShare()
      .executeTakeFirst();
    const rawCollectionFactIds = input.collectionFactIds;
    if (Array.isArray(rawCollectionFactIds)) {
      const collectionFactIds = [...new Set(rawCollectionFactIds
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .map((value) => value.trim()))].sort();
      for (const factId of collectionFactIds) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:stay-collection-transfer:${factId}`}, 0::bigint))`.execute(trx);
      }
      if (collectionFactIds.length > 0) {
        await trx.selectFrom("collection_facts")
          .select("fact_id")
          .where("fact_id", "in", collectionFactIds)
          .forUpdate()
          .execute();
        await trx.selectFrom("stay_collection_membership_transfers")
          .select("id")
          .where("source_collection_fact_id", "in", collectionFactIds)
          .forUpdate()
          .execute();
      }
    }
    return;
  }

  if (commandType === "RESOLVE_MIGRATED_OVERDUE_STAY") {
    const orderId = requireString(input, "orderId");
    const holdId = requireString(input, "holdId");
    const newDepartureDate = requireString(input, "newDepartureDate");
    parseLocalDate(newDepartureDate);
    const hold = await trx.selectFrom("migration_overdue_inventory_holds")
      .selectAll()
      .where("id", "=", holdId)
      .where("property_id", "=", propertyId)
      .executeTakeFirst();
    if (!hold) throw new DomainError("NOT_FOUND", "Migrated overdue inventory hold not found", 404);
    if (hold.order_id !== orderId) {
      throw new DomainError("RESOURCE_SCOPE_DENIED", "Migrated overdue inventory hold belongs to another order", 403);
    }
    const dates = enumerateServiceDates(hold.starts_on, newDepartureDate);
    await lockRoomDays(trx, dates.map((serviceDate) => ({ roomId: hold.room_id, serviceDate })));
    await trx.selectFrom("migration_overdue_inventory_holds")
      .select("id")
      .where("id", "=", hold.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx.selectFrom("migration_order_sources")
      .select("id")
      .where("id", "=", hold.source_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await lockOrder(trx, orderId);
    const release = await trx.selectFrom("migration_overdue_inventory_hold_releases")
      .select("id")
      .where("hold_id", "=", hold.id)
      .executeTakeFirst();
    if (release) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Migrated overdue inventory hold has already been resolved", 409);
    const order = await trx.selectFrom("orders")
      .select(["id", "property_id", "migration_source_id"])
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    if (order.property_id !== propertyId || order.migration_source_id !== hold.source_id) {
      throw new DomainError("RESOURCE_SCOPE_DENIED", "Migrated overdue inventory hold does not match the order source", 403);
    }
    return;
  }

  const orderId = requireString(input, "orderId");
  await lockOrder(trx, orderId);
  const context = await loadOrderContext(trx, orderId);
  if (context.order.property_id !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Order belongs to another property", 403);
  if (commandType === "CHECK_OUT") await assertNoActiveMigrationOverdueHold(trx, orderId);
  if (context.order.member_id) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${context.order.member_id}`}, 0::bigint))`.execute(trx);
    await lockMemberEntitlementLots(trx, propertyId, context.order.member_id);
  } else {
    await lockEntitlementLots(trx, context.order.member_contract_id ?? undefined);
  }

  if (["RESCHEDULE_STAY", "SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT", "CANCEL_ORDER", "MARK_NO_SHOW", "REVOKE_CHECK_IN", "CHECK_OUT"].includes(commandType)) {
    const timeline = await loadActiveStayTimeline(trx, context);
    const roomDates = await roomDatesForTimeline(trx, propertyId, timeline);
    if (commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY") {
      const plannedTimeline = planStayDateChangeTimeline({
        currentTimeline: timeline,
        oldArrivalDate: context.order.arrival_date,
        oldDepartureDate: context.order.departure_date,
        newArrivalDate: commandType === "RESCHEDULE_STAY"
          ? requireString(input, "newArrivalDate")
          : context.order.arrival_date,
        newDepartureDate: requireString(input, "newDepartureDate")
      });
      roomDates.push(...await roomDatesForTimeline(trx, propertyId, plannedTimeline));
    }
    if (commandType === "MOVE_UNIT") {
      const newInventoryUnitId = requireString(input, "newInventoryUnitId");
      const target = await trx.selectFrom("inventory_units")
        .select(["id", "parent_room_id"])
        .where("id", "=", newInventoryUnitId)
        .where("property_id", "=", propertyId)
        .executeTakeFirst();
      if (!target) throw new DomainError("NOT_FOUND", "Inventory unit not found", 404);
      const metadataUnitIds = [...new Set([target.id, target.parent_room_id].filter((id): id is string => Boolean(id)))].sort();
      await trx.selectFrom("inventory_units")
        .select("id")
        .where("id", "in", metadataUnitIds)
        .orderBy("id")
        .forUpdate()
        .execute();
      const newUnit = await loadInventoryUnit(trx, propertyId, newInventoryUnitId);
      const effectiveDate = requireString(input, "effectiveDate");
      parseLocalDate(effectiveDate);
      roomDates.push(...enumerateServiceDates(effectiveDate, context.order.departure_date)
        .map((serviceDate) => ({ roomId: newUnit.roomId, serviceDate })));
    }
    await lockRoomDays(trx, roomDates);
  }
  if (commandType === "RECORD_REFUND") {
    await trx.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id")
      .where("collection_facts.fact_id", "=", requireString(input, "referencesFactId"))
      .where("orders.property_id", "=", propertyId)
      .forUpdate("collection_facts")
      .executeTakeFirst();
  }
  if (commandType === "REVERSE_FACT") {
    await trx.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id")
      .where("collection_facts.fact_id", "=", requireString(input, "reversesFactId"))
      .where("orders.property_id", "=", propertyId)
      .forUpdate("collection_facts")
      .executeTakeFirst();
  }
}

async function insertRevision(trx: Transaction<Database>, options: {
  orderId: string;
  revisionNo: number;
  amendmentId: string;
  policyVersionId: string;
  arrivalDate: string;
  departureDate: string;
  pricing: ReturnType<typeof pricingSnapshot>;
}): Promise<string> {
  const id = newId("revision");
  await trx.insertInto("pricing_revisions").values({
    id,
    order_id: options.orderId,
    revision_no: options.revisionNo,
    amendment_id: options.amendmentId,
    policy_version_id: options.policyVersionId,
    arrival_date: options.arrivalDate,
    departure_date: options.departureDate,
    coverage_set: JSON.stringify(options.pricing.coverageSet),
    cash_lines: JSON.stringify(options.pricing.cashLines),
    policy_base_amount_minor: options.pricing.policyBaseAmountMinor,
    pricing_basis: options.pricing.pricingBasis,
    manual_adjustment_minor: options.pricing.manualAdjustmentMinor,
    current_contract_amount_minor: options.pricing.currentContractAmountMinor,
    currency: options.pricing.currency
  }).execute();
  return id;
}

async function bumpMembershipForCoverage(trx: Transaction<Database>, contractId: string | null, coverageSet: CoverageItemDto[]): Promise<void> {
  if (coverageSet.length === 0) return;
  const lotIds = [...new Set(coverageSet.map((item) => item.entitlementLotId))];
  const lots = await trx.selectFrom("entitlement_lots").select(["id", "contract_id"]).where("id", "in", lotIds).execute();
  if (lots.length !== lotIds.length) throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益批次不存在", 409);
  for (const ownerContractId of new Set(lots.map((lot) => lot.contract_id))) {
    if (!contractId && !ownerContractId) continue;
    await incrementContractAndLotVersions(trx, ownerContractId, lots.filter((lot) => lot.contract_id === ownerContractId).map((lot) => lot.id));
  }
}

export async function applyCommand(trx: Transaction<Database>, options: {
  commandType: CommandType;
  input: unknown;
  effect: Record<string, unknown>;
  reason: CommandReason;
  commandId: string;
}): Promise<AppliedCommand> {
  const input = requireObject(options.input);
  const propertyId = requireString(input, "propertyId");
  const effect = options.effect;

  if (options.commandType === "CREATE_MEMBER") {
    const operation = requireString(effect, "operation");
    const memberProfile = nestedObject(effect, "member");
    const propertyLink = nestedObject(effect, "propertyLink");
    if (operation !== "CREATE_MEMBER_PROFILE"
      || effect.memberId !== null
      || requireString(propertyLink, "operation") !== "CREATE") {
      throw new DomainError("INTERNAL_ERROR", "Member registration effect has an invalid operation", 500);
    }
    const memberId = newId("member");
    try {
      await trx.insertInto("members").values({
        id: memberId,
        identity_card_number: normalizeIdentityCardNumber(memberProfile.identityCardNumber),
        full_name: requireString(memberProfile, "fullName"),
        phone: requireString(memberProfile, "phone"),
        wechat: requireString(memberProfile, "wechat")
      }).execute();
      await trx.insertInto("member_property_links").values({
        member_id: memberId,
        property_id: propertyId
      }).execute();
      return {
        persistedResult: { memberId, memberCreated: true },
        resourceRefs: [memberId],
        factRefs: []
      };
    } catch (error) {
      rethrowMemberRegistrationConflict(error);
    }
  }

  if (options.commandType === "CREATE_MEMBERSHIP_ORDER") {
    const member = nestedObject(effect, "member");
    const product = nestedObject(effect, "product");
    const pricing = nestedObject(effect, "pricing");
    const listedPrice = moneyMinor(pricing.listedPrice, "listedPrice");
    const agreedPrice = moneyMinor(pricing.agreedPrice, "agreedPrice");
    const adjustment = moneyMinor(pricing.adjustment, "adjustment");
    const adjustmentReason = typeof pricing.adjustmentReason === "string" ? pricing.adjustmentReason : null;
    const entitlementUnitKind = requireString(product, "entitlementUnitKind");
    const allowedInventoryKind = requireString(product, "allowedInventoryKind");
    if (entitlementUnitKind !== "ROOM_NIGHT" && entitlementUnitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Invalid membership entitlement unit", 500);
    if (allowedInventoryKind !== "ROOM" && allowedInventoryKind !== "BED") throw new DomainError("INTERNAL_ERROR", "Invalid membership inventory kind", 500);
    const entitlementUnits = product.entitlementUnits;
    const productVersion = product.version;
    if (!Number.isInteger(entitlementUnits) || (entitlementUnits as number) <= 0 || !Number.isInteger(productVersion) || (productVersion as number) <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Invalid membership product snapshot", 500);
    }
    const membershipOrderId = newId("membership_order");
    await trx.insertInto("membership_orders").values({
      id: membershipOrderId,
      property_id: propertyId,
      member_id: requireString(member, "memberId"),
      product_id: requireString(product, "productId"),
      product_code: requireString(product, "code"),
      product_version: productVersion as number,
      product_name: requireString(product, "name"),
      listed_price_minor: listedPrice.minorUnits,
      agreed_price_minor: agreedPrice.minorUnits,
      price_adjustment_minor: adjustment.minorUnits,
      price_adjustment_reason: adjustmentReason,
      currency: agreedPrice.currency,
      entitlement_unit_kind: entitlementUnitKind,
      entitlement_units: entitlementUnits as number,
      allowed_room_type_code: requireString(product, "allowedRoomTypeCode"),
      allowed_inventory_kind: allowedInventoryKind,
      status: "DRAFT",
      activated_at: null,
      valid_from: null,
      valid_until: null,
      contract_id: null,
      entitlement_lot_id: null,
      version: 1,
      created_by_command_id: options.commandId,
      activated_by_command_id: null
    }).execute();
    return {
      persistedResult: { membershipOrderId, status: "DRAFT" },
      resourceRefs: [membershipOrderId, requireString(member, "memberId")],
      factRefs: []
    };
  }

  if (options.commandType === "RECORD_MEMBERSHIP_PAYMENT") {
    const payment = nestedObject(effect, "payment");
    const amount = moneyMinor(payment.amount, "payment.amount");
    const factId = newId("membership_payment");
    const membershipOrderId = requireString(effect, "membershipOrderId");
    await trx.insertInto("membership_payment_facts").values({
      fact_id: factId,
      membership_order_id: membershipOrderId,
      fact_type: "COLLECTION",
      amount_minor: amount.minorUnits,
      net_effect_minor: amount.minorUnits,
      currency: amount.currency,
      transaction_reference: requireTransactionReference(payment.transactionReference),
      corrects_fact_id: null,
      reverses_fact_id: null,
      note: typeof payment.note === "string" ? payment.note : "",
      command_id: options.commandId
    }).execute();
    await trx.updateTable("membership_orders").set({ version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", membershipOrderId).where("status", "=", "DRAFT").executeTakeFirstOrThrow();
    return { persistedResult: { membershipOrderId, paymentFactId: factId, status: "DRAFT" }, resourceRefs: [membershipOrderId], factRefs: [factId] };
  }

  if (options.commandType === "CORRECT_MEMBERSHIP_PAYMENT") {
    const originalPaymentFactId = requireString(effect, "originalPaymentFactId");
    const original = nestedObject(effect, "original");
    const replacement = nestedObject(effect, "replacement");
    const originalAmount = moneyMinor(original.amount, "original.amount");
    const replacementAmount = moneyMinor(replacement.amount, "replacement.amount");
    const membershipOrderId = requireString(effect, "membershipOrderId");
    const reversalFactId = newId("membership_payment_reversal");
    const replacementFactId = newId("membership_payment");
    const note = typeof replacement.note === "string" ? replacement.note : "";
    await trx.insertInto("membership_payment_facts").values({
      fact_id: reversalFactId,
      membership_order_id: membershipOrderId,
      fact_type: "REVERSAL",
      amount_minor: originalAmount.minorUnits,
      net_effect_minor: -originalAmount.minorUnits,
      currency: originalAmount.currency,
      transaction_reference: null,
      corrects_fact_id: null,
      reverses_fact_id: originalPaymentFactId,
      note: `更正原企微收款：${note}`,
      command_id: options.commandId
    }).execute();
    await trx.insertInto("membership_payment_facts").values({
      fact_id: replacementFactId,
      membership_order_id: membershipOrderId,
      fact_type: "COLLECTION",
      amount_minor: replacementAmount.minorUnits,
      net_effect_minor: replacementAmount.minorUnits,
      currency: replacementAmount.currency,
      transaction_reference: requireTransactionReference(replacement.transactionReference),
      corrects_fact_id: originalPaymentFactId,
      reverses_fact_id: null,
      note,
      command_id: options.commandId
    }).execute();
    await trx.updateTable("membership_orders").set({ version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", membershipOrderId).where("status", "=", "DRAFT").executeTakeFirstOrThrow();
    return {
      persistedResult: { membershipOrderId, originalPaymentFactId, reversalFactId, replacementFactId, status: "DRAFT" },
      resourceRefs: [membershipOrderId],
      factRefs: [reversalFactId, replacementFactId]
    };
  }

  if (options.commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
    const membershipOrderId = requireString(effect, "membershipOrderId");
    const order = await trx.selectFrom("membership_orders")
      .innerJoin("members", "members.id", "membership_orders.member_id")
      .selectAll("membership_orders")
      .select("members.full_name as member_name")
      .where("membership_orders.id", "=", membershipOrderId)
      .where("membership_orders.property_id", "=", propertyId)
      .where("membership_orders.status", "=", "DRAFT")
      .executeTakeFirst();
    if (!order) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单已经生效或不存在", 409);
    const contractId = newId("contract");
    const lotId = newId("lot");
    const activatedAt = new Date();
    const validFrom = requireString(effect, "validFrom");
    const validUntil = requireString(effect, "validUntil");
    const entitlementUnitKind = requireString(effect, "entitlementUnitKind");
    const entitlementUnits = effect.entitlementUnits;
    if ((entitlementUnitKind !== "ROOM_NIGHT" && entitlementUnitKind !== "BED_NIGHT") || !Number.isInteger(entitlementUnits) || (entitlementUnits as number) <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Invalid activation entitlement", 500);
    }
    await trx.insertInto("member_contracts").values({
      id: contractId,
      property_id: propertyId,
      member_id: order.member_id,
      member_name: order.member_name,
      status: "ACTIVE",
      valid_from: validFrom,
      valid_until: validUntil,
      version: 1,
      membership_order_id: membershipOrderId
    }).execute();
    await trx.insertInto("entitlement_lots").values({
      id: lotId,
      contract_id: contractId,
      unit_kind: entitlementUnitKind,
      total_units: entitlementUnits as number,
      expires_on: validUntil,
      version: 1
    }).execute();
    const updated = await trx.updateTable("membership_orders").set({
      status: "ACTIVE",
      activated_at: activatedAt,
      valid_from: validFrom,
      valid_until: validUntil,
      contract_id: contractId,
      entitlement_lot_id: lotId,
      version: sql`version + 1`,
      activated_by_command_id: options.commandId,
      updated_at: activatedAt
    }).where("id", "=", membershipOrderId).where("status", "=", "DRAFT").returning("id").executeTakeFirst();
    if (!updated) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单已经生效", 409);
    return {
      persistedResult: { membershipOrderId, status: "ACTIVE", contractId, entitlementLotId: lotId, validFrom, validUntil, entitlementUnits },
      resourceRefs: [membershipOrderId, contractId, lotId],
      factRefs: []
    };
  }

  if (options.commandType === "CREATE_ORDER") {
    const orderId = newId("order");
    const stayId = newId("stay");
    const amendmentId = newId("amend");
    const segmentId = newId("segment");
    const pricing = pricingSnapshot(effect);
    const inventoryUnit = nestedObject(effect, "inventoryUnit");
    const primaryGuest = nestedObject(effect, "primaryGuest");
    requireString(primaryGuest, "fullName");
    requireString(primaryGuest, "nickname");
    if (!Array.isArray(effect.occupants) || effect.occupants.length < 1) {
      throw new DomainError("INTERNAL_ERROR", "Create order effect has no occupants", 500);
    }
    const occupants = effect.occupants.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DomainError("INTERNAL_ERROR", `Create order occupant ${index + 1} is invalid`, 500);
      }
      const occupant = value as Record<string, unknown>;
      const id = requireString(occupant, "id");
      const ordinal = occupant.ordinal;
      const role = occupant.role;
      if (!Number.isSafeInteger(ordinal) || ordinal !== index + 1
        || role !== (index === 0 ? "PRIMARY" : "ADDITIONAL")) {
        throw new DomainError("INTERNAL_ERROR", `Create order occupant ${index + 1} ordering is invalid`, 500);
      }
      return {
        id,
        ordinal: ordinal as number,
        role: role as "PRIMARY" | "ADDITIONAL",
        fullName: requireString(occupant, "fullName"),
        nickname: requireString(occupant, "nickname"),
        phone: typeof occupant.phone === "string" && occupant.phone.trim() ? occupant.phone.trim() : null,
        documentNumber: typeof occupant.documentNumber === "string" && occupant.documentNumber.trim()
          ? occupant.documentNumber.trim()
          : null
      };
    });
    const unitId = requireString(inventoryUnit, "id");
    const arrivalDate = requireString(effect, "arrivalDate");
    const departureDate = requireString(effect, "departureDate");
    const stayType = requireString(effect, "stayType");
    const policyVersionId = requireString(effect, "pricingPolicyVersionId");
    const memberId = typeof effect.memberId === "string" ? effect.memberId : null;
    const memberContractId = typeof effect.memberContractId === "string" ? effect.memberContractId : null;
    const memberStay = Boolean(memberId || memberContractId);
    if (memberStay && (effect.bookingChannelCode !== null || effect.channelOrderReference !== null)) {
      throw new DomainError("VALIDATION_ERROR", "会员住宿不得写入订单来源渠道或渠道订单号");
    }
    if (stayType === "FREE" && (effect.bookingChannelCode !== null || effect.channelOrderReference !== null)) {
      throw new DomainError("VALIDATION_ERROR", "免费入住不得写入订单来源渠道或渠道订单号");
    }
    const { bookingChannelCode, channelOrderReference } = memberStay || stayType === "FREE"
      ? { bookingChannelCode: null, channelOrderReference: null }
      : validateBookingChannel(effect.bookingChannelCode, effect.channelOrderReference);
    const freeStayReason = stayType === "FREE" ? requireString(effect, "freeStayReason") : null;
    const freeStayCategoryCode = stayType === "FREE" ? requireString(effect, "freeStayCategoryCode") : null;
    await trx.insertInto("orders").values({
      id: orderId, property_id: propertyId, status: "RESERVED", stay_type: stayType,
      arrival_date: arrivalDate, departure_date: departureDate, primary_guest_snapshot: primaryGuest,
      booking_channel_code: bookingChannelCode, channel_order_reference: channelOrderReference, free_stay_reason: freeStayReason,
      free_stay_category_code: freeStayCategoryCode,
      pricing_policy_version_id: policyVersionId, member_id: memberId, member_contract_id: memberContractId, current_revision_id: null, version: 1
    }).execute();
    const occupantCreatedAt = new Date();
    const persistedOccupants = occupants.map(({ id, ordinal, role, ...snapshot }) => ({
      id,
      orderId,
      ordinal,
      role,
      ...snapshot,
      createdAt: occupantCreatedAt.toISOString()
    }));
    await trx.insertInto("order_occupants").values(persistedOccupants.map((occupant) => ({
      id: occupant.id,
      order_id: occupant.orderId,
      ordinal: occupant.ordinal,
      role: occupant.role,
      full_name: occupant.fullName,
      nickname: occupant.nickname,
      phone: occupant.phone,
      document_number: occupant.documentNumber,
      created_by_command_id: options.commandId,
      created_at: occupantCreatedAt
    }))).execute();
    await trx.insertInto("stays").values({ id: stayId, order_id: orderId, status: "PLANNED" }).execute();
    await trx.insertInto("amendments").values({
      id: amendmentId, order_id: orderId, sequence: 1, amendment_type: "CREATE_ORDER",
      reason_code: options.reason.code, reason_note: options.reason.note, prior_version: 0, new_version: 1,
      payload: { quoteId: effect.quoteId, inventoryUnitId: unitId, arrivalDate, departureDate, primaryGuest, occupants, bookingChannelCode, channelOrderReference, freeStayReason, freeStayCategoryCode, pricingDecision: effect.pricingDecision },
      command_id: options.commandId
    }).execute();
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: stayId, sequence: 1, inventory_unit_id: unitId, arrival_date: arrivalDate,
      departure_date: departureDate, segment_type: "INITIAL", supersedes_segment_id: null, amendment_id: amendmentId
    }).execute();
    const revisionId = await insertRevision(trx, { orderId, revisionNo: 1, amendmentId, policyVersionId, arrivalDate, departureDate, pricing });
    await trx.updateTable("orders").set({ current_revision_id: revisionId }).where("id", "=", orderId).execute();
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(arrivalDate, departureDate), sourceType: "ORDER_SEGMENT", sourceId: segmentId });
    const coverageRefs = memberContractId
      ? await holdCoverage(trx, { orderId, contractId: memberContractId, ...(memberId ? { memberId } : {}), inventoryUnitId: unitId, revisionId, coverageSet: pricing.coverageSet, commandId: options.commandId })
      : { coverageIds: [], factIds: [] };
    if (memberContractId) {
      await bumpMembershipForCoverage(trx, memberContractId, pricing.coverageSet);
    }
    return {
      persistedResult: { orderId, stayId, segmentId, pricingRevisionId: revisionId, primaryGuest, occupants: persistedOccupants, bookingChannelCode, channelOrderReference, freeStayReason, freeStayCategoryCode, pricingPolicyVersionId: policyVersionId, pricingDecision: effect.pricingDecision },
      resourceRefs: [orderId, stayId, segmentId, revisionId, ...persistedOccupants.map((occupant) => occupant.id), ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  if (options.commandType === "LOCK_MAINTENANCE") {
    const maintenanceLockId = newId("maint");
    const unitObject = nestedObject(effect, "inventoryUnit");
    const unitId = requireString(unitObject, "id");
    const arrivalDate = requireString(effect, "arrivalDate");
    const departureDate = requireString(effect, "departureDate");
    await trx.insertInto("maintenance_locks").values({
      id: maintenanceLockId, property_id: propertyId, inventory_unit_id: unitId, arrival_date: arrivalDate,
      departure_date: departureDate, reason: requireString(effect, "reason"), status: "ACTIVE", version: 1,
      created_by_command_id: options.commandId, released_by_command_id: null, released_at: null
    }).execute();
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    const claimIds = await createInventoryClaims(trx, {
      propertyId,
      unit,
      dates: enumerateServiceDates(arrivalDate, departureDate),
      sourceType: "MAINTENANCE",
      sourceId: maintenanceLockId
    });
    return { persistedResult: { maintenanceLockId }, resourceRefs: [maintenanceLockId], factRefs: claimIds };
  }

  if (options.commandType === "RELEASE_MAINTENANCE") {
    const maintenanceLockId = requireString(effect, "maintenanceLockId");
    const releasedClaimIds = await releaseInventoryClaims(trx, "MAINTENANCE", [maintenanceLockId]);
    const released = await trx.updateTable("maintenance_locks").set({
      status: "RELEASED",
      version: sql`version + 1`,
      released_by_command_id: options.commandId,
      released_at: new Date()
    }).where("id", "=", maintenanceLockId).where("status", "=", "ACTIVE").returning("id").executeTakeFirst();
    if (!released) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock is already released", 409);
    return {
      persistedResult: { maintenanceLockId, status: "RELEASED" },
      resourceRefs: [maintenanceLockId],
      factRefs: releasedClaimIds
    };
  }

  if (options.commandType === "COMPLETE_CLEANING") {
    if (!currentReleaseFeatures.cleaningWorkflow) {
      throw new DomainError("VALIDATION_ERROR", "Cleaning workflow is disabled in this release", 409);
    }
    const cleaningTaskId = requireString(effect, "cleaningTaskId");
    const updated = await trx.updateTable("cleaning_tasks").set({
      status: "COMPLETED",
      version: sql`version + 1`,
      completed_by_command_id: options.commandId,
      completed_at: new Date()
    }).where("id", "=", cleaningTaskId).where("status", "=", "PENDING").returning("id").executeTakeFirst();
    if (!updated) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Cleaning task is already completed", 409);
    return {
      persistedResult: { cleaningTaskId, status: "COMPLETED" },
      resourceRefs: [cleaningTaskId],
      factRefs: []
    };
  }

  if (options.commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(effect, "contractId");
    const unitKind = requireString(effect, "unitKind");
    if (unitKind !== "ROOM_NIGHT" && unitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Entitlement lot effect has an invalid unit kind", 500);
    const units = effect.units;
    if (!Number.isInteger(units) || (units as number) <= 0) throw new DomainError("INTERNAL_ERROR", "Entitlement lot effect has invalid units", 500);
    const expiresOn = requireString(effect, "expiresOn");
    const lotId = newId("lot");
    const factId = newId("fact");
    await trx.insertInto("entitlement_lots").values({
      id: lotId, contract_id: contractId, unit_kind: unitKind, total_units: 0, expires_on: expiresOn, version: 1
    }).execute();
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: lotId, entry_type: "ADJUST", quantity_delta: units as number,
      service_date: null, order_id: null, coverage_id: null,
      reason: `MEMBER_ENTITLEMENT_LOT_ADDED ${options.reason.code}: ${options.reason.note}`,
      command_id: options.commandId
    }).execute();
    await trx.updateTable("member_contracts").set({ version: sql`version + 1` }).where("id", "=", contractId).execute();
    return {
      persistedResult: { entitlementLotId: lotId, contractId, adjustmentFactId: factId, units },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "ADJUST_MEMBER_ENTITLEMENT" || options.commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") {
    const lotId = requireString(effect, "entitlementLotId");
    const contractId = requireString(effect, "contractId");
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId, lot_id: lotId, entry_type: "ADJUST", quantity_delta: effect.quantityDelta as number,
      service_date: null, order_id: null, coverage_id: null, reason: requireString(effect, "adjustmentReason"), command_id: options.commandId
    }).execute();
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return {
      persistedResult: {
        entitlementLotId: lotId,
        adjustmentFactId: factId,
        availableBefore: effect.availableBefore,
        availableAfter: effect.availableAfter,
        quantityDelta: effect.quantityDelta
      },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lotId = requireString(effect, "entitlementLotId");
    const contractId = requireString(effect, "contractId");
    const asOfDate = requireString(effect, "asOfDate");
    const remainingAvailable = effect.remainingAvailable;
    if (!Number.isInteger(remainingAvailable) || (remainingAvailable as number) < 0) {
      throw new DomainError("INTERNAL_ERROR", "Expiration effect has an invalid remaining balance", 500);
    }
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: lotId,
      entry_type: "EXPIRE",
      quantity_delta: -(remainingAvailable as number),
      service_date: null,
      order_id: null,
      coverage_id: null,
      reason: `ENTITLEMENT_EXPIRED asOfDate=${asOfDate}`,
      command_id: options.commandId
    }).execute();
    await incrementContractAndLotVersions(trx, contractId, [lotId]);
    return {
      persistedResult: {
        entitlementLotId: lotId,
        contractId,
        factId,
        entryType: "EXPIRE",
        expiredUnits: remainingAvailable,
        remainingAvailable: 0,
        asOfDate
      },
      resourceRefs: [contractId, lotId],
      factRefs: [factId]
    };
  }

  if (options.commandType === "ISSUE_TOKEN") {
    const tokenId = newId("token");
    const secretHash = requireString(input, "tokenSecretHash");
    const subjectId = requireString(effect, "subjectId");
    try {
      await trx.insertInto("api_tokens").values({
        id: tokenId, subject_id: subjectId, label: requireString(effect, "label"), secret_hash: secretHash,
        access_ceiling: requireString(effect, "accessCeiling") as "READ" | "WRITE", property_scope: propertyId,
        expires_at: requireString(effect, "expiresAt"), revoked_at: null, rotated_from_id: null, replaced_by_id: null
      }).execute();
    } catch (error) {
      rethrowTokenSecretConflict(error);
    }
    return {
      persistedResult: { tokenId, subjectId, accessCeiling: effect.accessCeiling, expiresAt: effect.expiresAt },
      resourceRefs: [tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === "ROTATE_TOKEN") {
    const oldTokenId = requireString(effect, "tokenId");
    const tokenId = newId("token");
    const secretHash = requireString(input, "tokenSecretHash");
    const subjectId = requireString(effect, "subjectId");
    try {
      await trx.insertInto("api_tokens").values({
        id: tokenId, subject_id: subjectId, label: requireString(effect, "label"), secret_hash: secretHash,
        access_ceiling: requireString(effect, "accessCeiling") as "READ" | "WRITE", property_scope: propertyId,
        expires_at: requireString(effect, "expiresAt"), revoked_at: null, rotated_from_id: oldTokenId, replaced_by_id: null
      }).execute();
    } catch (error) {
      rethrowTokenSecretConflict(error);
    }
    await trx.updateTable("api_tokens").set({ revoked_at: new Date(), replaced_by_id: tokenId }).where("id", "=", oldTokenId).execute();
    return {
      persistedResult: { tokenId, rotatedFromTokenId: oldTokenId, subjectId, accessCeiling: effect.accessCeiling, expiresAt: effect.expiresAt },
      resourceRefs: [oldTokenId, tokenId, subjectId],
      factRefs: []
    };
  }

  if (options.commandType === "REVOKE_TOKEN") {
    const tokenId = requireString(effect, "tokenId");
    await trx.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", tokenId).execute();
    return { persistedResult: { tokenId, revoked: true }, resourceRefs: [tokenId], factRefs: [] };
  }

  const orderId = requireString(effect, "orderId");
  const context = await loadOrderContext(trx, orderId);
  const migrationSourceId = (context.order as typeof context.order & { migration_source_id?: string | null }).migration_source_id ?? null;
  if (migrationSourceId && migratedOrderRepricingCommands.has(options.commandType)) {
    throw new DomainError("VALIDATION_ERROR", "历史实价订单需使用迁移更正流程", 409);
  }
  if (options.commandType === "CHECK_OUT") await assertNoActiveMigrationOverdueHold(trx, orderId);

  if (options.commandType === "RESOLVE_MIGRATED_OVERDUE_STAY") {
    if (requireString(effect, "operation") !== "RESOLVE_MIGRATED_OVERDUE_STAY") {
      throw new DomainError("INTERNAL_ERROR", "Migrated overdue resolution effect has an invalid operation", 500);
    }
    const holdId = requireString(effect, "holdId");
    const sourceId = requireString(effect, "sourceId");
    const newDepartureDate = requireString(effect, "newDepartureDate");
    const historicalActualAmountMinor = effect.historicalActualAmountMinor;
    const postCutoverIncrementAmountMinor = effect.postCutoverIncrementAmountMinor;
    const newContractAmountMinor = effect.newContractAmountMinor;
    if (!Number.isSafeInteger(historicalActualAmountMinor)
      || !Number.isSafeInteger(postCutoverIncrementAmountMinor)
      || !Number.isSafeInteger(newContractAmountMinor)) {
      throw new DomainError("INTERNAL_ERROR", "Migrated overdue resolution effect has invalid amounts", 500);
    }
    const historicalAmount = historicalActualAmountMinor as number;
    const incrementAmount = postCutoverIncrementAmountMinor as number;
    const contractAmount = newContractAmountMinor as number;
    const hold = await trx.selectFrom("migration_overdue_inventory_holds as hold")
      .leftJoin("migration_overdue_inventory_hold_releases as release", "release.hold_id", "hold.id")
      .selectAll("hold")
      .where("hold.id", "=", holdId)
      .where("hold.order_id", "=", orderId)
      .where("hold.source_id", "=", sourceId)
      .where("release.id", "is", null)
      .executeTakeFirst();
    if (!hold || migrationSourceId !== sourceId) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Migrated overdue inventory hold is no longer active", 409);
    }
    const priorRevision = await trx.selectFrom("pricing_revisions")
      .selectAll()
      .where("id", "=", context.revision.id)
      .executeTakeFirstOrThrow();
    if (priorRevision.pricing_origin !== "MIGRATED_ACTUAL"
      || priorRevision.current_contract_amount_minor !== historicalAmount
      || contractAmount !== historicalAmount + incrementAmount) {
      throw new DomainError("INTERNAL_ERROR", "Migrated overdue resolution no longer matches the historical pricing source", 500);
    }
    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: "EXTEND_STAY",
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const segmentId = newId("segment");
    await trx.insertInto("stay_segments").values({
      id: segmentId,
      stay_id: context.stay.id,
      sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: hold.inventory_unit_id,
      arrival_date: context.currentSegment.arrivalDate,
      departure_date: newDepartureDate,
      segment_type: "EXTEND_STAY",
      supersedes_segment_id: context.currentSegment.id,
      amendment_id: amendmentId
    }).execute();
    const revisionId = newId("revision");
    await trx.insertInto("pricing_revisions").values({
      id: revisionId,
      order_id: orderId,
      revision_no: priorRevision.revision_no + 1,
      amendment_id: amendmentId,
      policy_version_id: context.order.pricing_policy_version_id,
      arrival_date: context.order.arrival_date,
      departure_date: newDepartureDate,
      coverage_set: JSON.stringify(priorRevision.coverage_set),
      cash_lines: JSON.stringify([{
        lineKind: "MIGRATED_ACTUAL_PLUS_POST_CUTOVER",
        historicalActualAmountMinor: historicalAmount,
        postCutoverIncrementAmountMinor: incrementAmount,
        newContractAmountMinor: contractAmount,
        currency: priorRevision.currency
      }]),
      policy_base_amount_minor: null,
      pricing_basis: priorRevision.pricing_basis,
      pricing_origin: "MIGRATED_ACTUAL_PLUS_POST_CUTOVER",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: contractAmount,
      currency: priorRevision.currency
    }).execute();
    const holdReleaseId = newId("fact");
    await trx.insertInto("migration_overdue_inventory_hold_releases").values({
      id: holdReleaseId,
      hold_id: hold.id,
      source_id: sourceId,
      order_id: orderId,
      command_id: options.commandId,
      extension_segment_id: segmentId,
      pricing_revision_id: revisionId,
      new_departure_date: newDepartureDate
    }).execute();
    const dates = enumerateServiceDates(hold.starts_on, newDepartureDate);
    const unit = await loadInventoryUnit(trx, propertyId, hold.inventory_unit_id);
    const claimIds = await createInventoryClaims(trx, {
      propertyId,
      unit,
      dates,
      sourceType: "ORDER_SEGMENT",
      sourceId: segmentId,
      excludeSourceIds: [...context.segmentIds, segmentId]
    });
    if (claimIds.length !== dates.length) {
      throw new DomainError("INTERNAL_ERROR", "Migrated overdue resolution did not create the complete inventory interval", 500);
    }
    await trx.updateTable("orders").set({
      departure_date: newDepartureDate,
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).executeTakeFirstOrThrow();
    return {
      persistedResult: {
        orderId,
        amendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        holdId,
        holdReleaseId,
        historicalActualAmountMinor: historicalAmount,
        postCutoverIncrementAmountMinor: incrementAmount,
        newContractAmountMinor: contractAmount,
        newDepartureDate
      },
      resourceRefs: [orderId, context.stay.id, amendmentId, segmentId, revisionId, holdId, ...claimIds],
      factRefs: [holdReleaseId]
    };
  }

  if (options.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    if (requireString(effect, "operation") !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion effect has an invalid operation", 500);
    }
    const member = nestedObject(effect, "member");
    const product = nestedObject(effect, "product");
    const transfer = nestedObject(effect, "transfer");
    const membershipPricing = nestedObject(effect, "membershipPricing");
    const entitlement = nestedObject(effect, "entitlement");
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: null,
      memberContractId: null
    });
    const listedPrice = moneyMinor(membershipPricing.listedPrice, "membershipPricing.listedPrice");
    const agreedPrice = moneyMinor(membershipPricing.agreedPrice, "membershipPricing.agreedPrice");
    const adjustment = moneyMinor(membershipPricing.adjustment, "membershipPricing.adjustment");
    const adjustmentReason = typeof membershipPricing.adjustmentReason === "string" ? membershipPricing.adjustmentReason : null;
    const transferTotal = moneyMinor(transfer.total, "transfer.total");
    const transferCollectionsValue = transfer.collections;
    if (!Array.isArray(transferCollectionsValue) || transferCollectionsValue.length === 0) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion effect has no source collection", 500);
    }
    const transferCollections = transferCollectionsValue.map((value, index) => {
      const item = requireObject(value, `transfer.collections[${index}]`);
      return {
        factId: requireString(item, "factId"),
        amount: moneyMinor(item.amount, `transfer.collections[${index}].amount`)
      };
    });
    const transferCollectionIds = transferCollections.map((item) => item.factId);
    if (new Set(transferCollectionIds).size !== transferCollectionIds.length) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion effect contains duplicate source collections", 500);
    }
    const transferAmountMinor = transferCollections.reduce((sum, item) => sum + item.amount.minorUnits, 0);
    if (transferAmountMinor !== transferTotal.minorUnits) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion transfer total is inconsistent", 500);
    }
    const entitlementUnitKind = requireString(entitlement, "entitlementUnitKind");
    const allowedInventoryKind = requireString(product, "allowedInventoryKind");
    if (entitlementUnitKind !== "ROOM_NIGHT" && entitlementUnitKind !== "BED_NIGHT") throw new DomainError("INTERNAL_ERROR", "Invalid conversion entitlement unit", 500);
    if (allowedInventoryKind !== "ROOM" && allowedInventoryKind !== "BED") throw new DomainError("INTERNAL_ERROR", "Invalid conversion inventory kind", 500);
    const entitlementUnits = entitlement.entitlementUnits;
    const consumedUnits = entitlement.consumedUnits;
    const remainingUnits = entitlement.remainingUnits;
    const productVersion = product.version;
    if (!Number.isInteger(entitlementUnits) || (entitlementUnits as number) <= 0
      || !Number.isInteger(consumedUnits) || (consumedUnits as number) <= 0
      || !Number.isInteger(remainingUnits) || (remainingUnits as number) < 0
      || (entitlementUnits as number) - (consumedUnits as number) !== remainingUnits
      || !Number.isInteger(productVersion) || (productVersion as number) <= 0) {
      throw new DomainError("INTERNAL_ERROR", "Invalid conversion membership product snapshot", 500);
    }
    const serviceDates = stringArray(entitlement, "serviceDates");
    if (serviceDates.length !== consumedUnits || new Set(serviceDates).size !== serviceDates.length) {
      throw new DomainError("INTERNAL_ERROR", "Conversion consumption dates do not match consumed units", 500);
    }
    const validFrom = requireString(entitlement, "validFrom");
    const validUntil = requireString(entitlement, "validUntil");
    const remainingPayment = effect.remainingPayment === null ? null : nestedObject(effect, "remainingPayment");
    const remainingPaymentAmount = remainingPayment ? moneyMinor(remainingPayment.amount, "remainingPayment.amount") : null;
    if (listedPrice.currency !== agreedPrice.currency
      || adjustment.currency !== agreedPrice.currency
      || transferTotal.currency !== agreedPrice.currency
      || pricing.currency !== agreedPrice.currency
      || transferCollections.some((item) => item.amount.currency !== agreedPrice.currency)
      || (remainingPaymentAmount && remainingPaymentAmount.currency !== agreedPrice.currency)
      || agreedPrice.minorUnits - transferTotal.minorUnits !== (remainingPaymentAmount?.minorUnits ?? 0)
      || adjustment.minorUnits !== agreedPrice.minorUnits - listedPrice.minorUnits) {
      throw new DomainError("INTERNAL_ERROR", "Stay collection conversion money summary is inconsistent", 500);
    }

    const membershipOrderId = newId("membership_order");
    await trx.insertInto("membership_orders").values({
      id: membershipOrderId,
      property_id: propertyId,
      member_id: requireString(member, "memberId"),
      product_id: requireString(product, "productId"),
      product_code: requireString(product, "code"),
      product_version: productVersion as number,
      product_name: requireString(product, "name"),
      listed_price_minor: listedPrice.minorUnits,
      agreed_price_minor: agreedPrice.minorUnits,
      price_adjustment_minor: adjustment.minorUnits,
      price_adjustment_reason: adjustmentReason,
      currency: agreedPrice.currency,
      entitlement_unit_kind: entitlementUnitKind,
      entitlement_units: entitlementUnits as number,
      allowed_room_type_code: requireString(product, "allowedRoomTypeCode"),
      allowed_inventory_kind: allowedInventoryKind,
      status: "DRAFT",
      activated_at: null,
      valid_from: null,
      valid_until: null,
      contract_id: null,
      entitlement_lot_id: null,
      version: 1,
      created_by_command_id: options.commandId,
      activated_by_command_id: null
    }).execute();

    const membershipTransferPaymentFactIds: string[] = [];
    const lodgingReversalFactIds: string[] = [];
    const transferIds: string[] = [];
    for (const item of transferCollections) {
      const membershipPaymentFactId = newId("membership_payment");
      await trx.insertInto("membership_payment_facts").values({
        fact_id: membershipPaymentFactId,
        membership_order_id: membershipOrderId,
        fact_type: "COLLECTION",
        amount_minor: item.amount.minorUnits,
        net_effect_minor: item.amount.minorUnits,
        currency: item.amount.currency,
        transaction_reference: null,
        corrects_fact_id: null,
        reverses_fact_id: null,
        source_type: "STAY_COLLECTION_TRANSFER",
        source_order_id: orderId,
        source_collection_fact_id: item.factId,
        note: "升级会员：住宿收款转入",
        command_id: options.commandId
      }).execute();
      const reversalFactId = newId("fact");
      await trx.insertInto("collection_facts").values({
        fact_id: reversalFactId,
        order_id: orderId,
        fact_type: "REVERSAL",
        amount_minor: item.amount.minorUnits,
        net_effect_minor: -item.amount.minorUnits,
        currency: item.amount.currency,
        references_fact_id: null,
        reverses_fact_id: item.factId,
        method: "REVERSAL",
        note: "升级会员：住宿收款已用于会员订单",
        transaction_reference: null,
        pricing_revision_id: context.revision.id,
        command_id: options.commandId
      }).execute();
      const transferId = newId("transfer");
      await trx.insertInto("stay_collection_membership_transfers").values({
        id: transferId,
        property_id: propertyId,
        order_id: orderId,
        source_collection_fact_id: item.factId,
        source_reversal_fact_id: reversalFactId,
        membership_order_id: membershipOrderId,
        membership_payment_fact_id: membershipPaymentFactId,
        command_id: options.commandId
      }).execute();
      membershipTransferPaymentFactIds.push(membershipPaymentFactId);
      lodgingReversalFactIds.push(reversalFactId);
      transferIds.push(transferId);
    }

    const membershipPaymentFactIds = [...membershipTransferPaymentFactIds];
    if (remainingPayment) {
      const remainingPaymentFactId = newId("membership_payment");
      await trx.insertInto("membership_payment_facts").values({
        fact_id: remainingPaymentFactId,
        membership_order_id: membershipOrderId,
        fact_type: "COLLECTION",
        amount_minor: remainingPaymentAmount!.minorUnits,
        net_effect_minor: remainingPaymentAmount!.minorUnits,
        currency: remainingPaymentAmount!.currency,
        transaction_reference: requireTransactionReference(remainingPayment.transactionReference),
        corrects_fact_id: null,
        reverses_fact_id: null,
        note: typeof remainingPayment.note === "string" ? remainingPayment.note : "",
        command_id: options.commandId
      }).execute();
      membershipPaymentFactIds.push(remainingPaymentFactId);
    }

    const contractId = newId("contract");
    const lotId = newId("lot");
    const activatedAt = new Date();
    await trx.insertInto("member_contracts").values({
      id: contractId,
      property_id: propertyId,
      member_id: requireString(member, "memberId"),
      member_name: requireString(member, "fullName"),
      status: "ACTIVE",
      valid_from: validFrom,
      valid_until: validUntil,
      version: 1,
      membership_order_id: membershipOrderId
    }).execute();
    await trx.insertInto("entitlement_lots").values({
      id: lotId,
      contract_id: contractId,
      unit_kind: entitlementUnitKind,
      total_units: entitlementUnits as number,
      expires_on: validUntil,
      version: 1
    }).execute();
    const updatedMembershipOrder = await trx.updateTable("membership_orders").set({
      status: "ACTIVE",
      activated_at: activatedAt,
      valid_from: validFrom,
      valid_until: validUntil,
      contract_id: contractId,
      entitlement_lot_id: lotId,
      version: sql`version + 1`,
      activated_by_command_id: options.commandId,
      updated_at: activatedAt
    }).where("id", "=", membershipOrderId).where("status", "=", "DRAFT").returning("id").executeTakeFirst();
    if (!updatedMembershipOrder) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单已经生效", 409);

    const conversionLedgerFactIds: string[] = [];
    for (const serviceDate of serviceDates) {
      const factId = newId("fact");
      await trx.insertInto("entitlement_ledger").values({
        fact_id: factId,
        lot_id: lotId,
        entry_type: "CONVERSION_CONSUME",
        quantity_delta: -1,
        service_date: serviceDate,
        order_id: orderId,
        coverage_id: null,
        reason: "STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED",
        command_id: options.commandId
      }).execute();
      conversionLedgerFactIds.push(factId);
    }
    await incrementContractAndLotVersions(trx, contractId, [lotId]);

    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const revisionId = await insertRevision(trx, {
      orderId,
      revisionNo: context.revision.revisionNo + 1,
      amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date,
      departureDate: context.order.departure_date,
      pricing
    });
    await trx.updateTable("orders").set({
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    return {
      persistedResult: {
        orderId,
        memberId: requireString(member, "memberId"),
        amendmentId,
        pricingRevisionId: revisionId,
        membershipOrderId,
        status: "ACTIVE",
        contractId,
        entitlementLotId: lotId,
        transferredCollectionFactIds: transferCollectionIds,
        lodgingReversalFactIds,
        membershipPaymentFactIds,
        transferIds,
        conversionLedgerFactIds,
        transferredAmount: { currency: transferTotal.currency, minorUnits: transferTotal.minorUnits },
        membershipAgreedPrice: { currency: agreedPrice.currency, minorUnits: agreedPrice.minorUnits },
        remainingPaymentAmount: remainingPaymentAmount
          ? { currency: remainingPaymentAmount.currency, minorUnits: remainingPaymentAmount.minorUnits }
          : { currency: agreedPrice.currency, minorUnits: 0 },
        entitlementUnitKind,
        convertedUnits: consumedUnits,
        remainingUnits
      },
      resourceRefs: [orderId, amendmentId, revisionId, membershipOrderId, contractId, lotId, ...transferIds],
      factRefs: [...lodgingReversalFactIds, ...membershipPaymentFactIds, ...conversionLedgerFactIds]
    };
  }

  if (options.commandType === "CORRECT_ORDER_OCCUPANT") {
    const occupantId = requireString(effect, "occupantId");
    const before = nestedObject(effect, "before");
    const after = nestedObject(effect, "after");
    const latest = await trx.selectFrom("order_occupant_corrections")
      .select("sequence")
      .where("occupant_id", "=", occupantId)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: options.commandType,
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const correctionId = newId("fact");
    const command = await trx.selectFrom("command_executions")
      .select("subject_id")
      .where("id", "=", options.commandId)
      .executeTakeFirstOrThrow();
    const nullableSnapshotString = (snapshot: Record<string, unknown>, field: string): string | null => {
      const value = snapshot[field];
      if (value === null) return null;
      return requireString(snapshot, field);
    };
    await trx.insertInto("order_occupant_corrections").values({
      id: correctionId,
      order_id: orderId,
      occupant_id: occupantId,
      sequence: (latest?.sequence ?? 0) + 1,
      prior_full_name: before.fullName === null ? null : requireString(before, "fullName"),
      prior_nickname: before.nickname === null ? null : requireString(before, "nickname"),
      prior_phone: nullableSnapshotString(before, "phone"),
      prior_document_number: nullableSnapshotString(before, "documentNumber"),
      corrected_full_name: requireString(after, "fullName"),
      corrected_nickname: requireString(after, "nickname"),
      corrected_phone: nullableSnapshotString(after, "phone"),
      corrected_document_number: nullableSnapshotString(after, "documentNumber"),
      reason_code: options.reason.code,
      reason_note: options.reason.note,
      actor_subject_id: command.subject_id,
      amendment_id: amendmentId,
      created_by_command_id: options.commandId
    }).execute();
    await trx.updateTable("orders").set({
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    return {
      persistedResult: { orderId, occupantId, correctionId, amendmentId, occupant: after },
      resourceRefs: [orderId, occupantId, correctionId, amendmentId],
      factRefs: []
    };
  }

  if (options.commandType === "RESCHEDULE_STAY" || options.commandType === "EXTEND_STAY") {
    const amendmentId = await appendAmendment(trx, {
      orderId,
      sequence: context.order.version + 1,
      amendmentType: options.commandType,
      reasonCode: options.reason.code,
      reasonNote: options.reason.note,
      priorVersion: context.order.version,
      payload: effect,
      commandId: options.commandId
    });
    const after = nestedObject(effect, "after");
    const arrivalDate = requireString(after, "arrivalDate");
    const departureDate = requireString(after, "departureDate");
    const stayTimeline = stayTimelineFromEffect(effect);
    const inventoryUnitId = requireString(effect, "inventoryUnitId");
    const currentTimeline = await loadActiveStayTimeline(trx, context);
    const expectedTimeline = planStayDateChangeTimeline({
      currentTimeline,
      oldArrivalDate: context.order.arrival_date,
      oldDepartureDate: context.order.departure_date,
      newArrivalDate: arrivalDate,
      newDepartureDate: departureDate
    });
    if (stayTimeline.length !== expectedTimeline.length || stayTimeline.some((item, index) => (
      item.serviceDate !== expectedTimeline[index]?.serviceDate
      || item.inventoryUnitId !== expectedTimeline[index]?.inventoryUnitId
    ))) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期的结果与方案 B 时间线不一致", 500);
    }
    const currentTail = trailingTimelineRun(stayTimeline);
    if (inventoryUnitId !== currentTail.inventoryUnitId) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期的尾段房源不一致", 500);
    }
    const segmentArrivalDate = currentTail.arrivalDate;
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const releasedDates = stringArray(inventoryChange, "releasedDates");
    const addedDates = stringArray(inventoryChange, "addedDates");
    const preservedDates = stringArray(inventoryChange, "preservedDates");
    const pairDiff = timelinePairDiff(currentTimeline, stayTimeline);
    const sameDates = (actual: string[], expected: StayTimelineItem[]) => actual.length === expected.length
      && actual.every((date, index) => date === expected[index]?.serviceDate);
    if (!sameDates(preservedDates, pairDiff.preserved)
      || !sameDates(releasedDates, pairDiff.released)
      || !sameDates(addedDates, pairDiff.added)) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期的库存差异与完整时间线不一致", 500);
    }
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const segmentId = newId("segment");
    await trx.insertInto("stay_segments").values({
      id: segmentId,
      stay_id: context.stay.id,
      sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: inventoryUnitId,
      arrival_date: segmentArrivalDate,
      departure_date: departureDate,
      segment_type: options.commandType,
      supersedes_segment_id: context.currentSegment.id,
      amendment_id: amendmentId
    }).execute();

    const revisionId = await insertRevision(trx, {
      orderId,
      revisionNo: context.revision.revisionNo + 1,
      amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate,
      departureDate,
      pricing
    });

    const releasedClaimIds = await releaseInventoryClaimsOnDates(
      trx,
      "ORDER_SEGMENT",
      context.segmentIds,
      releasedDates
    );
    if (releasedClaimIds.length !== pairDiff.released.length) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期未精确释放旧库存占用", 500);
    }
    const addedByUnit = new Map<string, string[]>();
    for (const item of pairDiff.added) {
      const dates = addedByUnit.get(item.inventoryUnitId) ?? [];
      dates.push(item.serviceDate);
      addedByUnit.set(item.inventoryUnitId, dates);
    }
    const addedClaimIds: string[] = [];
    for (const [unitId, dates] of addedByUnit) {
      const unit = await loadInventoryUnit(trx, propertyId, unitId);
      addedClaimIds.push(...await createInventoryClaims(trx, {
        propertyId,
        unit,
        dates,
        sourceType: "ORDER_SEGMENT",
        sourceId: segmentId,
        excludeSourceIds: [...context.segmentIds, segmentId]
      }));
    }
    if (addedClaimIds.length !== pairDiff.added.length) {
      throw new DomainError("INTERNAL_ERROR", "调整住宿日期未精确创建新库存占用", 500);
    }

    const reconciled = context.order.member_id || context.order.member_contract_id
      ? await reconcileCoverage(trx, {
        orderId,
        contractId: context.order.member_contract_id ?? "",
        ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
        revisionId,
        coverageSet: pricing.coverageSet,
        commandId: options.commandId
      })
      : { coverageIds: [], factIds: [] };
    const entitlementChange = nestedObject(effect, "entitlementChange");
    const consumedCoverageDates = stringArray(entitlementChange, "consumedCoverageDates");
    const consumed = options.commandType === "EXTEND_STAY" && (context.order.member_id || context.order.member_contract_id)
      ? await consumeCoverage(trx, orderId, options.commandId, {
        serviceDates: consumedCoverageDates,
        reason: "EXTEND_STAY_ENTITLEMENT_CONSUMED"
      })
      : { coverageIds: [], factIds: [] };

    await trx.updateTable("orders").set({
      arrival_date: arrivalDate,
      departure_date: departureDate,
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();

    const pricingDecision = nestedObject(effect, "pricingDecision");
    const fundsSummary = nestedObject(effect, "fundsSummary");
    const before = nestedObject(effect, "before");
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        amendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        arrivalDate,
        departureDate,
        before,
        after,
        pricingDecision,
        inventoryChange,
        entitlementChange,
        fundsSummary
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        amendmentId,
        segmentId,
        revisionId,
        ...releasedClaimIds,
        ...addedClaimIds,
        ...reconciled.coverageIds,
        ...consumed.coverageIds
      ])],
      factRefs: [...new Set([...reconciled.factIds, ...consumed.factIds])]
    };
  }

  if (options.commandType === "SHORTEN_STAY") {
    if (requireString(effect, "operation") !== "SHORTEN_STAY") {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay effect has an invalid operation", 500);
    }
    const completionMode = requireString(effect, "completionMode");
    if (completionMode !== "SHORTEN_IN_HOUSE" && completionMode !== "EARLY_CHECK_OUT") {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay effect has an invalid completion mode", 500);
    }
    const businessDate = requireString(effect, "businessDate");
    const after = nestedObject(effect, "after");
    const arrivalDate = requireString(after, "arrivalDate");
    const departureDate = requireString(after, "departureDate");
    if ((completionMode === "EARLY_CHECK_OUT" && departureDate !== businessDate)
      || (completionMode === "SHORTEN_IN_HOUSE" && departureDate <= businessDate)) {
      throw new DomainError("INTERNAL_ERROR", "Shorten stay effect completion mode does not match its business date", 500);
    }
    const stayTimeline = stayTimelineFromEffect(effect);
    const currentTail = trailingTimelineRun(stayTimeline);
    const inventoryUnitId = currentTail.inventoryUnitId;
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const releasedDates = stringArray(inventoryChange, "releasedDates");
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const arrangementAmendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: "SHORTEN_STAY",
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const segmentId = newId("segment");
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: context.stay.id, sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: inventoryUnitId, arrival_date: currentTail.arrivalDate, departure_date: departureDate,
      segment_type: "SHORTEN_STAY", supersedes_segment_id: context.currentSegment.id, amendment_id: arrangementAmendmentId
    }).execute();
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId: arrangementAmendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate, departureDate, pricing
    });
    const releasedClaimIds = completionMode === "EARLY_CHECK_OUT"
      ? await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds)
      : await releaseInventoryClaimsOnDates(trx, "ORDER_SEGMENT", context.segmentIds, releasedDates);
    let checkoutAmendmentId: string | null = null;
    let fulfillmentTiming: { effectiveDate: string; recordedBusinessDate: string; recordingMode: "ON_SCHEDULE" } | null = null;
    if (completionMode === "EARLY_CHECK_OUT") {
      const checkoutEffect = {
        orderId,
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_OUT",
        inventoryUnitId,
        businessDate: departureDate,
        effectiveDate: departureDate,
        recordingMode: "ON_SCHEDULE"
      };
      checkoutAmendmentId = await appendAmendment(trx, {
        orderId,
        sequence: context.order.version + 2,
        amendmentType: "CHECK_OUT",
        reasonCode: options.reason.code,
        reasonNote: options.reason.note,
        priorVersion: context.order.version + 1,
        payload: checkoutEffect,
        commandId: options.commandId
      });
      fulfillmentTiming = {
        effectiveDate: departureDate,
        recordedBusinessDate: departureDate,
        recordingMode: "ON_SCHEDULE"
      };
      await trx.updateTable("stays").set({ status: "COMPLETED" }).where("id", "=", context.stay.id).execute();
    }
    await trx.updateTable("orders").set({
      departure_date: departureDate,
      current_revision_id: revisionId,
      ...(completionMode === "EARLY_CHECK_OUT" ? { status: "CHECKED_OUT" } : {}),
      version: context.order.version + (completionMode === "EARLY_CHECK_OUT" ? 2 : 1),
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    const before = nestedObject(effect, "before");
    const pricingDecision = nestedObject(effect, "pricingDecision");
    const entitlementSummary = nestedObject(effect, "entitlementSummary");
    const fundsSummary = nestedObject(effect, "fundsSummary");
    const refundReferenceAmount = moneyMinor(effect.refundReferenceAmount, "refundReferenceAmount");
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        arrangementAmendmentId,
        checkoutAmendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        completionMode,
        businessDate,
        arrivalDate,
        departureDate,
        before,
        after,
        pricingDecision,
        inventoryChange,
        entitlementSummary,
        fundsSummary,
        refundReferenceAmount,
        fulfillmentTiming
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        arrangementAmendmentId,
        ...(checkoutAmendmentId ? [checkoutAmendmentId] : []),
        segmentId,
        revisionId,
        ...releasedClaimIds
      ])],
      factRefs: []
    };
  }

  if (options.commandType === "MOVE_UNIT") {
    if (requireString(effect, "operation") !== "MOVE_UNIT") {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect has an invalid operation", 500);
    }
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: "MOVE_UNIT",
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const segmentId = newId("segment");
    const after = nestedObject(effect, "after");
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const stayTimeline = stayTimelineFromEffect(effect);
    const currentTail = trailingTimelineRun(stayTimeline);
    const unitId = currentTail.inventoryUnitId;
    const arrivalDate = requireString(after, "arrivalDate");
    const departureDate = requireString(after, "departureDate");
    const effectiveDate = requireString(effect, "effectiveDate");
    const businessDate = requireString(effect, "businessDate");
    if (arrivalDate !== context.order.arrival_date || departureDate !== context.order.departure_date
      || currentTail.arrivalDate > effectiveDate || unitId !== requireString(nestedObject(effect, "toInventoryUnit"), "id")) {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect has an invalid resulting timeline", 500);
    }
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: context.stay.id, sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: unitId, arrival_date: effectiveDate, departure_date: departureDate,
      segment_type: "MOVE", supersedes_segment_id: context.currentSegment.id, amendment_id: amendmentId
    }).execute();
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const preservedClaims = inventoryClaimSummaries(inventoryChange, "preservedClaims");
    const releasedClaims = inventoryClaimSummaries(inventoryChange, "releasedClaims");
    const addedClaims = inventoryClaimSummaries(inventoryChange, "addedClaims");
    const beforeTimelineByDate = new Map(
      inventoryClaimSummaries(nestedObject(effect, "before"), "stayTimeline")
        .map((claim) => [claim.serviceDate, claim.inventoryUnitId])
    );
    const afterTimelineByDate = new Map(stayTimeline.map((claim) => [claim.serviceDate, claim.inventoryUnitId]));
    const expectedPreserved = [...beforeTimelineByDate].filter(([serviceDate, inventoryUnitId]) =>
      afterTimelineByDate.get(serviceDate) === inventoryUnitId
    );
    const expectedReleased = [...beforeTimelineByDate].filter(([serviceDate, inventoryUnitId]) =>
      afterTimelineByDate.get(serviceDate) !== inventoryUnitId
    );
    const expectedAdded = [...afterTimelineByDate].filter(([serviceDate, inventoryUnitId]) =>
      beforeTimelineByDate.get(serviceDate) !== inventoryUnitId
    );
    const matchesClaimSet = (
      actual: Array<{ serviceDate: string; inventoryUnitId: string }>,
      expected: Array<[string, string]>
    ) => {
      const actualKeys = actual.map((claim) => `${claim.serviceDate}\u0000${claim.inventoryUnitId}`).sort();
      const expectedKeys = expected.map(([serviceDate, inventoryUnitId]) => `${serviceDate}\u0000${inventoryUnitId}`).sort();
      return actualKeys.length === expectedKeys.length
        && new Set(actualKeys).size === actualKeys.length
        && new Set(expectedKeys).size === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index]);
    };
    if (!matchesClaimSet(preservedClaims, expectedPreserved)
      || !matchesClaimSet(releasedClaims, expectedReleased)
      || !matchesClaimSet(addedClaims, expectedAdded)
      || addedClaims.some((claim) => claim.inventoryUnitId !== unitId)) {
      throw new DomainError("INTERNAL_ERROR", "Move unit effect inventory diff does not match its stay timeline", 500);
    }
    const releasedClaimIds = await releaseInventoryClaimsOnDates(
      trx,
      "ORDER_SEGMENT",
      context.segmentIds,
      releasedClaims.map((claim) => claim.serviceDate)
    );
    if (releasedClaimIds.length !== releasedClaims.length) {
      throw new DomainError("INTERNAL_ERROR", "Move unit did not release the exact inventory claim set", 500);
    }
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    const addedClaimIds = await createInventoryClaims(trx, {
      propertyId,
      unit,
      dates: addedClaims.map((claim) => claim.serviceDate),
      sourceType: "ORDER_SEGMENT",
      sourceId: segmentId,
      excludeSourceIds: [...context.segmentIds, segmentId]
    });
    if (addedClaimIds.length !== addedClaims.length) {
      throw new DomainError("INTERNAL_ERROR", "Move unit did not create the exact inventory claim set", 500);
    }
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate, departureDate, pricing
    });
    const reconciled = context.order.member_id || context.order.member_contract_id
      ? await reconcileCoverage(trx, {
        orderId,
        contractId: context.order.member_contract_id ?? "",
        ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
        revisionId,
        coverageSet: pricing.coverageSet,
        commandId: options.commandId
      })
      : { coverageIds: [], factIds: [] };
    const entitlementSummary = nestedObject(effect, "entitlementSummary");
    const ledgerWriteCount = entitlementSummary.ledgerWriteCount;
    if (!Number.isSafeInteger(ledgerWriteCount) || ledgerWriteCount !== reconciled.factIds.length) {
      throw new DomainError("INTERNAL_ERROR", "Move unit entitlement summary does not match persisted ledger writes", 500);
    }
    await trx.updateTable("orders").set({
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    const before = nestedObject(effect, "before");
    const pricingDecision = nestedObject(effect, "pricingDecision");
    const fundsSummary = nestedObject(effect, "fundsSummary");
    return {
      persistedResult: {
        orderId,
        stayId: context.stay.id,
        amendmentId,
        staySegmentId: segmentId,
        pricingRevisionId: revisionId,
        businessDate,
        effectiveDate,
        before,
        after,
        pricingDecision,
        inventoryChange,
        entitlementSummary,
        fundsSummary
      },
      resourceRefs: [...new Set([
        orderId,
        context.stay.id,
        amendmentId,
        segmentId,
        revisionId,
        ...releasedClaimIds,
        ...addedClaimIds,
        ...reconciled.coverageIds
      ])],
      factRefs: [...new Set(reconciled.factIds)]
    };
  }

  if (options.commandType === "REPRICE_ORDER" || options.commandType === "REFRESH_MEMBER_COVERAGE") {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date, pricing
    });
    const reconciledCoverage = context.order.member_id || context.order.member_contract_id
      ? await reconcileCoverage(trx, {
        orderId,
        contractId: context.order.member_contract_id ?? "",
        ...(context.order.member_id ? { memberId: context.order.member_id } : {}),
        revisionId,
        coverageSet: pricing.coverageSet,
        commandId: options.commandId
      })
      : { coverageIds: [], factIds: [] };
    const consumedCoverage = (context.order.member_id || context.order.member_contract_id) && context.order.status === "CHECKED_IN"
      ? await consumeCoverage(trx, orderId, options.commandId)
      : { coverageIds: [], factIds: [] };
    const coverageRefs = {
      coverageIds: [...new Set([...reconciledCoverage.coverageIds, ...consumedCoverage.coverageIds])],
      factIds: [...new Set([...reconciledCoverage.factIds, ...consumedCoverage.factIds])]
    };
    await trx.updateTable("orders").set({ current_revision_id: revisionId, version: context.order.version + 1, updated_at: new Date() }).where("id", "=", orderId).execute();
    const persistedResult: Record<string, unknown> = { orderId, amendmentId, pricingRevisionId: revisionId };
    if (options.commandType === "REPRICE_ORDER") {
      persistedResult.policyBaseAmount = moneyMinor(effect.policyBaseAmount, "policyBaseAmount");
      persistedResult.targetCurrentContractAmount = moneyMinor(effect.targetCurrentContractAmount, "targetCurrentContractAmount");
      persistedResult.manualAdjustmentMinor = effect.manualAdjustmentMinor;
    }
    return {
      persistedResult,
      resourceRefs: [orderId, amendmentId, revisionId, ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  if (options.commandType === "RECORD_COLLECTION" || options.commandType === "RECORD_REFUND" || options.commandType === "REVERSE_FACT") {
    const factId = newId("fact");
    const amountMinor = effect.amountMinor as number;
    const factType = options.commandType === "RECORD_COLLECTION" ? "COLLECTION" : options.commandType === "RECORD_REFUND" ? "REFUND" : "REVERSAL";
    const netEffectMinor = factType === "COLLECTION" ? amountMinor : factType === "REFUND" ? -amountMinor : effect.netEffectMinor as number;
    const transactionReference = factType === "REVERSAL" ? null
      : typeof effect.transactionReference === "string" && effect.transactionReference.trim() !== "" ? effect.transactionReference.trim() : null;
    await trx.insertInto("collection_facts").values({
      fact_id: factId, order_id: orderId, fact_type: factType, amount_minor: amountMinor,
      net_effect_minor: netEffectMinor, currency: requireString(effect, "currency"),
      references_fact_id: typeof effect.referencesFactId === "string" ? effect.referencesFactId : null,
      reverses_fact_id: typeof effect.reversesFactId === "string" ? effect.reversesFactId : null,
      method: typeof effect.method === "string" ? effect.method : "REVERSAL",
      note: typeof effect.note === "string" ? effect.note : options.reason.note,
      transaction_reference: transactionReference,
      pricing_revision_id: context.revision.id,
      command_id: options.commandId
    }).execute();
    return { persistedResult: { orderId, factId, factType, netEffectMinor, transactionReference }, resourceRefs: [orderId], factRefs: [factId] };
  }

  const statusCommands: Partial<Record<CommandType, { orderStatus: string; stayStatus: string }>> = {
    CHECK_IN: { orderStatus: "CHECKED_IN", stayStatus: "IN_HOUSE" },
    CHECK_OUT: { orderStatus: "CHECKED_OUT", stayStatus: "COMPLETED" },
    CANCEL_ORDER: { orderStatus: "CANCELLED", stayStatus: "CANCELLED" },
    MARK_NO_SHOW: { orderStatus: "NO_SHOW", stayStatus: "NO_SHOW" },
    REVOKE_CHECK_IN: { orderStatus: "CHECK_IN_REVOKED", stayStatus: "CHECK_IN_REVOKED" }
  };
  const target = statusCommands[options.commandType];
  if (target) {
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: options.commandType,
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    let coverageRefs = { coverageIds: [] as string[], factIds: [] as string[] };
    let statusPricingRevisionId: string | undefined;
    let cleaningTaskId: string | undefined;
    if (!migrationSourceId
      && (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW" || options.commandType === "REVOKE_CHECK_IN")) {
      const prior = await trx.selectFrom("pricing_revisions").selectAll().where("id", "=", context.revision.id).executeTakeFirstOrThrow();
      const pricingRevision = nestedObject(effect, "pricingRevision");
      const pricingBasis = requireString(pricingRevision, "pricingBasis");
      if (!createOrderPricingBasisCodes.includes(pricingBasis as CreateOrderPricingBasis)
        || moneyMinor(pricingRevision.currentContractAmount, "pricingRevision.currentContractAmount").minorUnits !== 0) {
        throw new DomainError("INTERNAL_ERROR", "Terminal pricing revision must be a typed zero amount", 500);
      }
      statusPricingRevisionId = await insertRevision(trx, {
        orderId,
        revisionNo: context.revision.revisionNo + 1,
        amendmentId,
        policyVersionId: context.order.pricing_policy_version_id,
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        pricing: {
          coverageSet: [],
          cashLines: [],
          policyBaseAmountMinor: 0,
          pricingBasis: pricingBasis as CreateOrderPricingBasis,
          manualAdjustmentMinor: 0,
          currentContractAmountMinor: 0,
          currency: prior.currency
        }
      });
    }
    if (options.commandType === "CHECK_IN") {
      coverageRefs = await consumeCoverage(trx, orderId, options.commandId);
    }
    if (options.commandType === "CHECK_OUT") {
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
      if (currentReleaseFeatures.cleaningWorkflow) {
        const cleaningTask = nestedObject(effect, "cleaningTask");
        const inventoryUnitId = requireString(cleaningTask, "inventoryUnitId");
        const serviceDate = requireString(cleaningTask, "serviceDate");
        const unit = await loadInventoryUnitIncludingInactive(trx, propertyId, inventoryUnitId);
        cleaningTaskId = newId("cleaning");
        await trx.insertInto("cleaning_tasks").values({
          id: cleaningTaskId,
          property_id: propertyId,
          order_id: orderId,
          stay_id: context.stay.id,
          inventory_unit_id: inventoryUnitId,
          room_id: unit.roomId,
          service_date: serviceDate,
          status: "PENDING",
          version: 1,
          created_by_command_id: options.commandId,
          completed_by_command_id: null,
          completed_at: null
        }).execute();
      }
    }
    if (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW") {
      coverageRefs = await releaseCoverage(trx, orderId, options.commandId);
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    }
    if (options.commandType === "REVOKE_CHECK_IN") {
      if (effect.unusedRoomConfirmed !== true) {
        throw new DomainError("INTERNAL_ERROR", "撤销入住缺少未使用房间确认", 500);
      }
      coverageRefs = await restoreConsumedCoverage(trx, orderId, options.commandId);
      await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds);
    }
    await trx.updateTable("orders").set({
      status: target.orderStatus,
      ...(statusPricingRevisionId ? { current_revision_id: statusPricingRevisionId } : {}),
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    await trx.updateTable("stays").set({ status: target.stayStatus }).where("id", "=", context.stay.id).execute();
    return {
      persistedResult: {
        orderId,
        amendmentId,
        status: target.orderStatus,
        ...((options.commandType === "CHECK_IN" || options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW" || options.commandType === "REVOKE_CHECK_IN") ? {
          entitlementTransition: {
            from: options.commandType === "REVOKE_CHECK_IN" ? "CONSUMED" : "HELD",
            to: options.commandType === "CHECK_IN" ? "CONSUMED" : options.commandType === "REVOKE_CHECK_IN" ? "RESTORED" : "RELEASED",
            coverageCount: coverageRefs.coverageIds.length
          }
        } : {}),
        ...(statusPricingRevisionId ? { pricingRevisionId: statusPricingRevisionId } : {}),
        ...((options.commandType === "CHECK_IN" || options.commandType === "CHECK_OUT" || options.commandType === "REVOKE_CHECK_IN") ? {
          fulfillmentTiming: {
            effectiveDate: requireString(effect, "effectiveDate"),
            recordedBusinessDate: requireString(effect, "businessDate"),
            recordingMode: requireString(effect, "recordingMode")
          }
        } : {}),
        ...(cleaningTaskId ? { cleaningTaskId } : {})
      },
      resourceRefs: [orderId, amendmentId, ...(statusPricingRevisionId ? [statusPricingRevisionId] : []), ...(cleaningTaskId ? [cleaningTaskId] : []), ...coverageRefs.coverageIds],
      factRefs: coverageRefs.factIds
    };
  }

  throw new DomainError("VALIDATION_ERROR", `Unsupported command: ${options.commandType}`);
}
