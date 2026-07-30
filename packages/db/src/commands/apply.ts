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
import { appendAmendment, consumeCoverage, holdCoverage, incrementContractAndLotVersions, loadActiveStayTimeline, loadOrderContext, lockOrder, reconcileCoverage, releaseCoverage, type StayTimelineItem } from "../orders.ts";
import { loadStoredQuote, lockEntitlementLots, lockMemberEntitlementLots } from "../pricing-service.ts";
import type { Database } from "../schema.ts";
import { normalizeIdentityCardNumber, requireObject, requireString } from "./effects.ts";

export interface AppliedCommand {
  persistedResult: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
}

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

  const orderId = requireString(input, "orderId");
  await lockOrder(trx, orderId);
  const context = await loadOrderContext(trx, orderId);
  if (context.order.property_id !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Order belongs to another property", 403);
  if (context.order.member_id) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${context.order.member_id}`}, 0::bigint))`.execute(trx);
    await lockMemberEntitlementLots(trx, propertyId, context.order.member_id);
  } else {
    await lockEntitlementLots(trx, context.order.member_contract_id ?? undefined);
  }

  if (["RESCHEDULE_STAY", "SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT", "CANCEL_ORDER", "MARK_NO_SHOW", "CHECK_OUT"].includes(commandType)) {
    const timeline = await loadActiveStayTimeline(trx, context);
    const roomDates = await roomDatesForTimeline(trx, propertyId, timeline);
    if (commandType === "EXTEND_STAY") {
      const extensionUnit = await loadInventoryUnit(trx, propertyId, timeline.at(-1)!.inventoryUnitId);
      roomDates.push(...enumerateServiceDates(context.order.departure_date, requireString(input, "newDepartureDate"))
        .map((serviceDate) => ({ roomId: extensionUnit.roomId, serviceDate })));
    }
    if (commandType === "RESCHEDULE_STAY") {
      const currentUnit = await loadInventoryUnit(trx, propertyId, timeline[0]!.inventoryUnitId);
      roomDates.push(...enumerateServiceDates(
        requireString(input, "newArrivalDate"),
        requireString(input, "newDepartureDate")
      ).map((serviceDate) => ({ roomId: currentUnit.roomId, serviceDate })));
    }
    if (commandType === "MOVE_UNIT") {
      const newUnit = await loadInventoryUnit(trx, propertyId, requireString(input, "newInventoryUnitId"));
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
    const segmentArrivalDate = options.commandType === "RESCHEDULE_STAY"
      ? arrivalDate
      : trailingTimelineRun(stayTimeline).arrivalDate;
    const inventoryChange = nestedObject(effect, "inventoryChange");
    const releasedDates = stringArray(inventoryChange, "releasedDates");
    const addedDates = stringArray(inventoryChange, "addedDates");
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
    const unit = await loadInventoryUnit(trx, propertyId, inventoryUnitId);
    const addedClaimIds = await createInventoryClaims(trx, {
      propertyId,
      unit,
      dates: addedDates,
      sourceType: "ORDER_SEGMENT",
      sourceId: segmentId,
      excludeSourceIds: [...context.segmentIds, segmentId]
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
    const amendmentId = await appendAmendment(trx, {
      orderId, sequence: context.order.version + 1, amendmentType: "MOVE_UNIT",
      reasonCode: options.reason.code, reasonNote: options.reason.note, priorVersion: context.order.version, payload: effect,
      commandId: options.commandId
    });
    const segmentId = newId("segment");
    const pricing = pricingSnapshot(effect, {
      stayType: context.order.stay_type,
      memberId: context.order.member_id,
      memberContractId: context.order.member_contract_id
    });
    const stayTimeline = stayTimelineFromEffect(effect);
    const currentTail = trailingTimelineRun(stayTimeline);
    const unitId = currentTail.inventoryUnitId;
    const departureDate = context.order.departure_date;
    await trx.insertInto("stay_segments").values({
      id: segmentId, stay_id: context.stay.id, sequence: context.currentSegment.sequence + 1,
      inventory_unit_id: unitId, arrival_date: currentTail.arrivalDate, departure_date: departureDate,
      segment_type: "MOVE", supersedes_segment_id: context.currentSegment.id, amendment_id: amendmentId
    }).execute();
    const effectiveDate = requireString(effect, "effectiveDate");
    await releaseInventoryClaims(trx, "ORDER_SEGMENT", context.segmentIds, effectiveDate);
    const released = await releaseCoverage(trx, orderId, options.commandId, { fromDate: effectiveDate, reholdCoverageSet: pricing.coverageSet });
    const unit = await loadInventoryUnit(trx, propertyId, unitId);
    await createInventoryClaims(trx, { propertyId, unit, dates: enumerateServiceDates(effectiveDate, departureDate), sourceType: "ORDER_SEGMENT", sourceId: segmentId });
    const revisionId = await insertRevision(trx, {
      orderId, revisionNo: context.revision.revisionNo + 1, amendmentId,
      policyVersionId: context.order.pricing_policy_version_id,
      arrivalDate: context.order.arrival_date, departureDate, pricing
    });
    const coverageIds = [...released.coverageIds];
    const coverageFactIds = [...released.factIds];
    if (context.order.member_id || context.order.member_contract_id) {
      const held = await holdCoverage(trx, { orderId, contractId: context.order.member_contract_id ?? "", ...(context.order.member_id ? { memberId: context.order.member_id } : {}), inventoryUnitId: unitId, revisionId, coverageSet: pricing.coverageSet, commandId: options.commandId });
      coverageIds.push(...held.coverageIds);
      coverageFactIds.push(...held.factIds);
      await bumpMembershipForCoverage(trx, context.order.member_contract_id, pricing.coverageSet);
      if (context.order.status === "CHECKED_IN") {
        const consumed = await consumeCoverage(trx, orderId, options.commandId);
        coverageIds.push(...consumed.coverageIds);
        coverageFactIds.push(...consumed.factIds);
      }
    }
    await trx.updateTable("orders").set({
      current_revision_id: revisionId,
      version: context.order.version + 1,
      updated_at: new Date()
    }).where("id", "=", orderId).execute();
    return {
      persistedResult: { orderId, amendmentId, staySegmentId: segmentId, pricingRevisionId: revisionId },
      resourceRefs: [...new Set([orderId, amendmentId, segmentId, revisionId, ...coverageIds])],
      factRefs: [...new Set(coverageFactIds)]
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
    const transactionReference = factType === "REVERSAL" ? null : requireTransactionReference(effect.transactionReference);
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
    MARK_NO_SHOW: { orderStatus: "NO_SHOW", stayStatus: "NO_SHOW" }
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
    if (context.order.stay_type === "FREE" && (options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW")) {
      const prior = await trx.selectFrom("pricing_revisions").selectAll().where("id", "=", context.revision.id).executeTakeFirstOrThrow();
      const coverageSet = prior.coverage_set as CoverageItemDto[];
      const cashLines = prior.cash_lines as unknown[];
      if (coverageSet.length !== 0 || cashLines.some((line) => {
        const amount = line && typeof line === "object" ? (line as { amount?: { minorUnits?: unknown } }).amount?.minorUnits : undefined;
        return amount !== 0;
      }) || prior.current_contract_amount_minor !== 0) {
        throw new DomainError("INTERNAL_ERROR", "Free stay pricing must remain zero and entitlement-free", 500);
      }
      statusPricingRevisionId = await insertRevision(trx, {
        orderId,
        revisionNo: context.revision.revisionNo + 1,
        amendmentId,
        policyVersionId: context.order.pricing_policy_version_id,
        arrivalDate: context.order.arrival_date,
        departureDate: context.order.departure_date,
        pricing: {
          coverageSet,
          cashLines,
          policyBaseAmountMinor: 0,
          pricingBasis: "FREE",
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
        ...((options.commandType === "CHECK_IN" || options.commandType === "CANCEL_ORDER" || options.commandType === "MARK_NO_SHOW") ? {
          entitlementTransition: {
            from: "HELD",
            to: options.commandType === "CHECK_IN" ? "CONSUMED" : "RELEASED",
            coverageCount: coverageRefs.coverageIds.length
          }
        } : {}),
        ...(statusPricingRevisionId ? { pricingRevisionId: statusPricingRevisionId } : {}),
        ...((options.commandType === "CHECK_IN" || options.commandType === "CHECK_OUT") ? {
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
