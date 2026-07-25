import { sql } from "kysely";
import { DomainError, type CommandType, type CoverageItemDto, type InventoryUnitKind, type StayType } from "@qintopia/contracts";
import {
  calculatePricing,
  calculateDurationTimelinePricing,
  enumerateServiceDates,
  parseLocalDate,
  requireTransactionReference,
  stableHash,
  validateBookingChannel,
  type PricingResult
} from "@qintopia/domain";
import { adjustedEntitlementAvailableBalance, entitlementAvailableBalance, parsePostgresBigInt } from "../entitlement-balance.ts";
import { activeCoverageCandidates, loadActiveStayTimeline, loadOrderContext, orderAmountSummary, type StayTimelineItem } from "../orders.ts";
import { allocateCoverageCandidates, loadPricingPolicy, loadStoredQuote, resolveMemberCoverage } from "../pricing-service.ts";
import { inventoryFingerprint, loadInventoryUnit, type DbExecutor } from "../inventory.ts";
import { propertyLocalToday } from "../members.ts";

export interface BuiltCommandEffect {
  propertyId: string;
  effect: Record<string, unknown>;
  basisVersions: Record<string, unknown>;
  effectHash: string;
}

export function requireObject(value: unknown, field = "input"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("VALIDATION_ERROR", `${field} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  return value.trim();
}

export function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", `${field} must be a string`);
  return value.trim();
}

export function normalizeIdentityCardNumber(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new DomainError("VALIDATION_ERROR", "identityCardNumber is required");
  return value.trim().toUpperCase();
}

const strictDateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Hex = /^[a-f0-9]{64}$/;

function requireFutureDateTime(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field);
  const match = strictDateTime.exec(value);
  if (!match) throw new DomainError("VALIDATION_ERROR", `${field} must be an RFC 3339 date-time`);
  parseLocalDate(match[1]!);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a valid date-time`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new DomainError("VALIDATION_ERROR", `${field} must be in the future`);
  return value;
}

function optionalTokenSecretHash(input: Record<string, unknown>): string | undefined {
  const value = input.tokenSecretHash;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !sha256Hex.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "tokenSecretHash must be a 64-character lowercase SHA-256 hex digest");
  }
  return value;
}

function requireTokenSecretHash(input: Record<string, unknown>): string {
  const value = optionalTokenSecretHash(input);
  if (!value) throw new DomainError("VALIDATION_ERROR", "tokenSecretHash is required for Token rotation");
  return value;
}

export function requireInteger(input: Record<string, unknown>, field: string, options: { min?: number; allowZero?: boolean } = {}): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < -2_147_483_648 || (value as number) > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a safe PostgreSQL integer`);
  }
  const number = value as number;
  if (options.min !== undefined && number < options.min) throw new DomainError("VALIDATION_ERROR", `${field} must be at least ${options.min}`);
  if (options.allowZero === false && number === 0) throw new DomainError("VALIDATION_ERROR", `${field} must not be zero`);
  return number;
}

function requireNonNegativeWholeYuanMinor(input: Record<string, unknown>, field: string): number {
  const value = requireInteger(input, field, { min: 0 });
  if (value % 100 !== 0) throw new DomainError("VALIDATION_ERROR", `${field} must be a non-negative whole-yuan CNY amount`);
  return value;
}

function money(currency: string, minorUnits: number) {
  return { currency, minorUnits };
}

function addOneCalendarYear(localDate: string): string {
  const parsed = parseLocalDate(localDate);
  const year = parsed.getUTCFullYear() + 1;
  const month = parsed.getUTCMonth();
  const day = parsed.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

async function membershipPaymentState(db: DbExecutor, membershipOrderId: string) {
  const facts = await db.selectFrom("membership_payment_facts")
    .selectAll()
    .where("membership_order_id", "=", membershipOrderId)
    .orderBy("created_at")
    .orderBy("fact_id")
    .execute();
  const total = facts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
  if (!Number.isSafeInteger(total) || total < 0 || total > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "会员订单收款合计超出支持范围");
  }
  return {
    facts,
    total,
    hash: stableHash(facts.map((fact) => ({
      factId: fact.fact_id,
      type: fact.fact_type,
      amountMinor: fact.amount_minor,
      netEffectMinor: fact.net_effect_minor,
      transactionReference: fact.transaction_reference,
      correctsFactId: fact.corrects_fact_id,
      reversesFactId: fact.reverses_fact_id
    })))
  };
}

function assertOrderMutable(status: string): void {
  if (!new Set(["RESERVED", "CHECKED_IN"]).has(status)) throw new DomainError("INVALID_ORDER_STATE", `Order cannot be changed from ${status}`, 409);
}

async function memberBasis(db: DbExecutor, memberContractId: string | null, memberId?: string | null) {
  if (!memberContractId && !memberId) return null;
  let contractQuery = db.selectFrom("member_contracts").select(["id", "version", "status"]);
  contractQuery = memberId
    ? contractQuery.where("member_id", "=", memberId)
    : contractQuery.where("id", "=", memberContractId!);
  const contracts = await contractQuery.orderBy("id").execute();
  const contractIds = contracts.map((contract) => contract.id);
  const lots = await db.selectFrom("entitlement_lots")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select(["entitlement_lots.id", "entitlement_lots.version", sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("delta")])
    .where("entitlement_lots.contract_id", "in", contractIds.length ? contractIds : ["__none__"])
    .groupBy(["entitlement_lots.id", "entitlement_lots.version"])
    .orderBy("entitlement_lots.id").execute();
  return {
    contracts,
    lots: lots.map((lot) => ({ ...lot, delta: parsePostgresBigInt(lot.delta, "Entitlement ledger sum").toString() }))
  };
}

async function priceSingleUnit(db: DbExecutor, options: {
  propertyId: string;
  orderId?: string;
  memberId: string | null;
  memberContractId: string | null;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policyVersionId: string;
  manualAdjustmentMinor: number;
}): Promise<PricingResult> {
  if (options.stayType === "FREE" && (options.memberId || options.memberContractId)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const unit = await loadInventoryUnit(db, options.propertyId, options.unitId);
  const dates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  const preserved = options.orderId ? await activeCoverageCandidates(db, options.orderId, dates) : [];
  const candidates = options.memberId
    ? (await resolveMemberCoverage(db, {
      propertyId: options.propertyId,
      memberId: options.memberId,
      inventoryUnitKind: unit.kind,
      roomTypeCode: unit.roomTypeCode,
      dates,
      preserved
    })).coverageCandidates
    : await allocateCoverageCandidates(db, {
      propertyId: options.propertyId,
      inventoryUnitKind: unit.kind,
      dates,
      preserved,
      ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
    });
  const policy = await loadPricingPolicy(db, options.propertyId, options.policyVersionId);
  return calculatePricing({
    propertyId: options.propertyId,
    inventoryUnitId: unit.id,
    inventoryUnitKind: unit.kind,
    inventoryProductCode: unit.pricingProductCode,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    stayType: options.stayType,
    policy,
    memberCoverage: Boolean(options.memberId || options.memberContractId),
    coverageCandidates: candidates,
    manualAdjustmentMinor: options.manualAdjustmentMinor
  });
}

function nextServiceDate(serviceDate: string): string {
  const date = parseLocalDate(serviceDate);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function timelineRuns(timeline: StayTimelineItem[]): Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> {
  const runs: Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }> = [];
  for (const item of timeline) {
    const current = runs.at(-1);
    if (current && current.inventoryUnitId === item.inventoryUnitId && current.departureDate === item.serviceDate) {
      current.departureDate = nextServiceDate(item.serviceDate);
    } else {
      runs.push({ inventoryUnitId: item.inventoryUnitId, arrivalDate: item.serviceDate, departureDate: nextServiceDate(item.serviceDate) });
    }
  }
  return runs;
}

async function priceStayTimeline(db: DbExecutor, options: {
  propertyId: string;
  orderId: string;
  memberId: string | null;
  memberContractId: string | null;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policyVersionId: string;
  timeline: StayTimelineItem[];
  manualAdjustmentMinor: number;
}): Promise<PricingResult> {
  if (options.stayType === "FREE" && (options.memberId || options.memberContractId)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  const expectedDates = enumerateServiceDates(options.arrivalDate, options.departureDate);
  if (expectedDates.length !== options.timeline.length || expectedDates.some((date, index) => options.timeline[index]?.serviceDate !== date)) {
    throw new DomainError("INTERNAL_ERROR", "Stay pricing timeline does not cover the order interval", 500);
  }

  const unitIds = [...new Set(options.timeline.map((item) => item.inventoryUnitId))];
  const units = new Map((await Promise.all(unitIds.map((unitId) => loadInventoryUnit(db, options.propertyId, unitId)))).map((unit) => [unit.id, unit]));
  const unitKinds = new Set([...units.values()].map((unit) => unit.kind));
  if ((options.memberId || options.memberContractId) && unitKinds.size !== 1) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Member coverage cannot span room and bed inventory without an approved business case", 409);
  }

  const preserved = await activeCoverageCandidates(db, options.orderId, expectedDates);
  const firstUnit = units.get(options.timeline[0]!.inventoryUnitId)!;
  if (options.memberId && [...units.values()].some((unit) => unit.kind !== firstUnit.kind || unit.roomTypeCode !== firstUnit.roomTypeCode)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿不能跨越不同会员产品对应的房型", 409);
  }
  const candidates = options.memberId
    ? (await resolveMemberCoverage(db, {
      propertyId: options.propertyId,
      memberId: options.memberId,
      inventoryUnitKind: firstUnit.kind,
      roomTypeCode: firstUnit.roomTypeCode,
      dates: expectedDates,
      preserved
    })).coverageCandidates
    : await allocateCoverageCandidates(db, {
      propertyId: options.propertyId,
      inventoryUnitKind: firstUnit.kind,
      dates: expectedDates,
      preserved,
      ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
    });
  const policy = await loadPricingPolicy(db, options.propertyId, options.policyVersionId);
  if (policy.calculationKind === "DURATION_BAND_TOTAL") {
    return calculateDurationTimelinePricing({
      propertyId: options.propertyId,
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      stayType: options.stayType,
      policy,
      memberCoverage: Boolean(options.memberId || options.memberContractId),
      timeline: options.timeline.map((item) => {
        const unit = units.get(item.inventoryUnitId)!;
        return {
          serviceDate: item.serviceDate,
          inventoryUnitId: unit.id,
          inventoryUnitKind: unit.kind,
          inventoryProductCode: unit.pricingProductCode
        };
      }),
      coverageCandidates: candidates,
      manualAdjustmentMinor: options.manualAdjustmentMinor
    });
  }
  const pieces = timelineRuns(options.timeline).map((run) => {
    const unit = units.get(run.inventoryUnitId)!;
    return calculatePricing({
      propertyId: options.propertyId,
      inventoryUnitId: unit.id,
      inventoryUnitKind: unit.kind,
      inventoryProductCode: unit.pricingProductCode,
      arrivalDate: run.arrivalDate,
      departureDate: run.departureDate,
      stayType: options.stayType,
      policy,
      memberCoverage: Boolean(options.memberId || options.memberContractId),
      coverageCandidates: candidates.filter((candidate) => candidate.serviceDate >= run.arrivalDate && candidate.serviceDate < run.departureDate),
      manualAdjustmentMinor: 0
    });
  });
  const cashRemainderMinor = pieces.reduce((sum, piece) => sum + piece.cashRemainder.minorUnits, 0);
  const currentContractAmountMinor = cashRemainderMinor + options.manualAdjustmentMinor;
  if (!Number.isSafeInteger(cashRemainderMinor) || !Number.isSafeInteger(currentContractAmountMinor)
    || cashRemainderMinor > 2_147_483_647
    || currentContractAmountMinor < -2_147_483_648
    || currentContractAmountMinor > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "Calculated amount exceeds the supported integer range");
  }
  return {
    coverageSet: pieces.flatMap((piece) => piece.coverageSet),
    cashLines: pieces.flatMap((piece) => piece.cashLines),
    cashRemainder: { currency: policy.currency, minorUnits: cashRemainderMinor },
    currentContractAmount: { currency: policy.currency, minorUnits: currentContractAmountMinor }
  };
}

async function activeRefundedAmount(db: DbExecutor, collectionFactId: string): Promise<number> {
  const refunds = await db.selectFrom("collection_facts as refund")
    .leftJoin("collection_facts as reversal", "reversal.reverses_fact_id", "refund.fact_id")
    .select(["refund.amount_minor", "reversal.fact_id as reversal_id"])
    .where("refund.references_fact_id", "=", collectionFactId)
    .where("refund.fact_type", "=", "REFUND")
    .execute();
  return refunds.filter((refund) => !refund.reversal_id).reduce((sum, refund) => sum + refund.amount_minor, 0);
}

function finalize(propertyId: string, effect: Record<string, unknown>, basisVersions: Record<string, unknown>): BuiltCommandEffect {
  return { propertyId, effect, basisVersions, effectHash: stableHash({ effect, basisVersions }) };
}

export async function buildCommandEffect(db: DbExecutor, commandType: CommandType, rawInput: unknown): Promise<BuiltCommandEffect> {
  const input = requireObject(rawInput);
  const propertyId = requireString(input, "propertyId");

  if (commandType === "CREATE_MEMBER") {
    const member = {
      fullName: requireString(input, "fullName"),
      identityCardNumber: normalizeIdentityCardNumber(input.identityCardNumber),
      phone: requireString(input, "phone"),
      wechat: requireString(input, "wechat")
    };
    const existingMember = await db.selectFrom("members").selectAll()
      .where("identity_card_number", "=", member.identityCardNumber)
      .executeTakeFirst();
    if (existingMember) {
      throw new DomainError("VALIDATION_ERROR", "该身份证号已登记，不能重复创建会员档案", 409);
    }

    return finalize(propertyId, {
      operation: "CREATE_MEMBER_PROFILE",
      memberId: null,
      member,
      propertyLink: { operation: "CREATE" }
    }, {
      member: null
    });
  }

  if (commandType === "CREATE_MEMBERSHIP_ORDER") {
    const memberId = requireString(input, "memberId");
    const membershipProductId = requireString(input, "membershipProductId");
    const agreedPriceMinor = requireNonNegativeWholeYuanMinor(input, "agreedPriceMinor");
    const adjustmentReason = optionalString(input, "priceAdjustmentReason");
    const member = await db.selectFrom("members")
      .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
      .select(["members.id", "members.full_name"])
      .where("members.id", "=", memberId)
      .where("member_property_links.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
    const product = await db.selectFrom("membership_products").selectAll()
      .where("id", "=", membershipProductId)
      .where("status", "=", "PUBLISHED")
      .executeTakeFirst();
    if (!product) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
    const property = await db.selectFrom("properties").select("currency").where("id", "=", propertyId).executeTakeFirst();
    if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
    if (product.currency !== property.currency) throw new DomainError("VALIDATION_ERROR", "会员产品币种与门店不一致");
    if (agreedPriceMinor !== product.list_price_minor && !adjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "修改会员成交价时必须填写调价原因");
    }
    if (agreedPriceMinor === product.list_price_minor && adjustmentReason) {
      throw new DomainError("VALIDATION_ERROR", "未修改成交价时不需要填写调价原因");
    }
    return finalize(propertyId, {
      operation: "CREATE_MEMBERSHIP_ORDER",
      member: { memberId: member.id, fullName: member.full_name },
      product: {
        productId: product.id,
        code: product.code,
        version: product.version,
        name: product.name,
        entitlementUnitKind: product.entitlement_unit_kind,
        entitlementUnits: product.entitlement_units,
        allowedRoomTypeCode: product.allowed_room_type_code,
        allowedInventoryKind: product.allowed_inventory_kind
      },
      pricing: {
        listedPrice: money(product.currency, product.list_price_minor),
        agreedPrice: money(product.currency, agreedPriceMinor),
        adjustment: money(product.currency, agreedPriceMinor - product.list_price_minor),
        adjustmentReason: adjustmentReason ?? null
      },
      status: "DRAFT"
    }, {
      member: { id: member.id, fullName: member.full_name },
      product: { id: product.id, version: product.version, status: product.status }
    });
  }

  if (commandType === "RECORD_MEMBERSHIP_PAYMENT" || commandType === "CORRECT_MEMBERSHIP_PAYMENT" || commandType === "ACTIVATE_MEMBERSHIP_ORDER") {
    const membershipOrderId = requireString(input, "membershipOrderId");
    const order = await db.selectFrom("membership_orders")
      .innerJoin("members", "members.id", "membership_orders.member_id")
      .selectAll("membership_orders")
      .select("members.full_name as member_name")
      .where("membership_orders.id", "=", membershipOrderId)
      .where("membership_orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
    if (order.status !== "DRAFT") throw new DomainError("AGGREGATE_VERSION_CONFLICT", "已生效的会员订单不能再修改", 409);
    const paymentState = await membershipPaymentState(db, order.id);

    if (commandType === "RECORD_MEMBERSHIP_PAYMENT") {
      const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
      const transactionReference = requireTransactionReference(input.transactionReference);
      const note = optionalString(input, "note") ?? "";
      const after = paymentState.total + amountMinor;
      if (!Number.isSafeInteger(after) || after > 2_147_483_647) throw new DomainError("VALIDATION_ERROR", "会员订单收款合计超出支持范围");
      return finalize(propertyId, {
        operation: "RECORD_MEMBERSHIP_PAYMENT",
        membershipOrderId: order.id,
        memberName: order.member_name,
        productName: order.product_name,
        payment: { amount: money(order.currency, amountMinor), transactionReference, note },
        totals: {
          before: money(order.currency, paymentState.total),
          after: money(order.currency, after),
          agreedPrice: money(order.currency, order.agreed_price_minor),
          differenceAfter: money(order.currency, after - order.agreed_price_minor)
        },
        status: "DRAFT"
      }, { membershipOrderVersion: order.version, paymentFactsHash: paymentState.hash });
    }

    if (commandType === "CORRECT_MEMBERSHIP_PAYMENT") {
      const originalPaymentFactId = requireString(input, "originalPaymentFactId");
      const original = paymentState.facts.find((fact) => fact.fact_id === originalPaymentFactId);
      if (!original || original.fact_type !== "COLLECTION") throw new DomainError("NOT_FOUND", "待更正的企微收款不存在", 404);
      if (paymentState.facts.some((fact) => fact.reverses_fact_id === original.fact_id)) {
        throw new DomainError("FACT_ALREADY_REVERSED", "该企微收款已经更正", 409);
      }
      const correctedAmountMinor = requireInteger(input, "correctedAmountMinor", { min: 1 });
      const correctedTransactionReference = requireTransactionReference(input.correctedTransactionReference);
      const note = optionalString(input, "note") ?? "";
      const after = paymentState.total - original.amount_minor + correctedAmountMinor;
      if (!Number.isSafeInteger(after) || after < 0 || after > 2_147_483_647) throw new DomainError("VALIDATION_ERROR", "更正后的收款合计超出支持范围");
      return finalize(propertyId, {
        operation: "CORRECT_MEMBERSHIP_PAYMENT",
        membershipOrderId: order.id,
        memberName: order.member_name,
        productName: order.product_name,
        originalPaymentFactId: original.fact_id,
        original: { amount: money(order.currency, original.amount_minor), transactionReference: requireTransactionReference(original.transaction_reference) },
        replacement: { amount: money(order.currency, correctedAmountMinor), transactionReference: correctedTransactionReference, note },
        totals: {
          before: money(order.currency, paymentState.total),
          after: money(order.currency, after),
          agreedPrice: money(order.currency, order.agreed_price_minor),
          differenceAfter: money(order.currency, after - order.agreed_price_minor)
        },
        status: "DRAFT"
      }, { membershipOrderVersion: order.version, paymentFactsHash: paymentState.hash });
    }

    if (paymentState.total <= 0 || !paymentState.facts.some((fact) => fact.fact_type === "COLLECTION" && !paymentState.facts.some((candidate) => candidate.reverses_fact_id === fact.fact_id))) {
      throw new DomainError("VALIDATION_ERROR", "会员订单至少登记一笔有效企微收款后才能生效");
    }
    const validFrom = await propertyLocalToday(db, propertyId);
    const validUntil = addOneCalendarYear(validFrom);
    return finalize(propertyId, {
      operation: "ACTIVATE_MEMBERSHIP_ORDER",
      membershipOrderId: order.id,
      memberName: order.member_name,
      productName: order.product_name,
      paymentTotal: money(order.currency, paymentState.total),
      agreedPrice: money(order.currency, order.agreed_price_minor),
      paymentDifference: money(order.currency, paymentState.total - order.agreed_price_minor),
      validFrom,
      validUntil,
      entitlementUnitKind: order.entitlement_unit_kind,
      entitlementUnits: order.entitlement_units,
      fromStatus: "DRAFT",
      toStatus: "ACTIVE"
    }, { membershipOrderVersion: order.version, paymentFactsHash: paymentState.hash, validFrom });
  }

  if (commandType === "LOCK_MAINTENANCE") {
    const arrivalDate = requireString(input, "arrivalDate");
    const departureDate = requireString(input, "departureDate");
    enumerateServiceDates(arrivalDate, departureDate);
  }
  if (commandType === "EXTEND_STAY") {
    parseLocalDate(requireString(input, "newDepartureDate"));
  }

  if (commandType === "CREATE_ORDER") {
    const quoteId = requireString(input, "quoteId");
    const submittedGuest = requireObject(input.primaryGuest, "primaryGuest");
    const phone = optionalString(submittedGuest, "phone");
    const documentNumber = optionalString(submittedGuest, "documentNumber");
    const guest = {
      fullName: requireString(submittedGuest, "fullName"),
      nickname: requireString(submittedGuest, "nickname"),
      ...(phone ? { phone } : {}),
      ...(documentNumber ? { documentNumber } : {})
    };
    const additionalGuestInputs = input.additionalGuests ?? [];
    if (!Array.isArray(additionalGuestInputs)) {
      throw new DomainError("VALIDATION_ERROR", "additionalGuests must be an array");
    }
    const additionalGuests = additionalGuestInputs.map((value, index) => {
      const submitted = requireObject(value, `additionalGuests[${index}]`);
      const additionalPhone = optionalString(submitted, "phone");
      const additionalDocumentNumber = optionalString(submitted, "documentNumber");
      return {
        fullName: requireString(submitted, "fullName"),
        nickname: requireString(submitted, "nickname"),
        ...(additionalPhone ? { phone: additionalPhone } : {}),
        ...(additionalDocumentNumber ? { documentNumber: additionalDocumentNumber } : {})
      };
    });
    const quote = await loadStoredQuote(db, quoteId);
    if (quote.propertyId !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Quote belongs to another property", 403);
    const memberStay = Boolean(quote.memberId || quote.memberContractId);
    if (memberStay && ((input.bookingChannelCode !== undefined && input.bookingChannelCode !== null)
      || (input.channelOrderReference !== undefined && input.channelOrderReference !== null && input.channelOrderReference !== ""))) {
      throw new DomainError("VALIDATION_ERROR", "会员住宿不应填写订单来源渠道或渠道订单号");
    }
    const { bookingChannelCode, channelOrderReference } = memberStay
      ? { bookingChannelCode: null, channelOrderReference: null }
      : validateBookingChannel(input.bookingChannelCode, input.channelOrderReference);
    const freeStayReason = quote.stayType === "FREE" ? requireString(input, "freeStayReason") : null;
    if (quote.stayType !== "FREE" && input.freeStayReason !== undefined && input.freeStayReason !== null) {
      throw new DomainError("VALIDATION_ERROR", "freeStayReason is only allowed for FREE stays");
    }
    const unit = await loadInventoryUnit(db, propertyId, quote.inventoryUnitId);
    const guestSnapshots = [guest, ...additionalGuests];
    if (guestSnapshots.length > unit.occupancyCapacity) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `${unit.code} 最多登记 ${unit.occupancyCapacity} 位住宿人，本次提交了 ${guestSnapshots.length} 位`
      );
    }
    const frozenOccupantIds = input._occupantIds;
    if (!Array.isArray(frozenOccupantIds) || frozenOccupantIds.length !== guestSnapshots.length
      || frozenOccupantIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(frozenOccupantIds).size !== frozenOccupantIds.length) {
      throw new DomainError("VALIDATION_ERROR", "CREATE_ORDER requires a stable occupant ID for every submitted guest");
    }
    const occupants = guestSnapshots.map((snapshot, index) => ({
      id: frozenOccupantIds[index] as string,
      ordinal: index + 1,
      role: index === 0 ? "PRIMARY" as const : "ADDITIONAL" as const,
      ...snapshot
    }));
    const fingerprint = await inventoryFingerprint(db, propertyId, unit.id, quote.arrivalDate, quote.departureDate);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Quoted inventory is no longer available", 409);
    const pricing = await priceSingleUnit(db, {
      propertyId,
      memberId: quote.memberId ?? null,
      memberContractId: quote.memberContractId ?? null,
      unitId: quote.inventoryUnitId,
      arrivalDate: quote.arrivalDate,
      departureDate: quote.departureDate,
      stayType: quote.stayType,
      policyVersionId: quote.pricingPolicyVersionId,
      manualAdjustmentMinor: 0
    });
    const effect = {
      quoteId,
      primaryGuest: guest,
      occupants,
      occupancyCapacity: unit.occupancyCapacity,
      bookingChannelCode,
      channelOrderReference,
      freeStayReason,
      inventoryUnit: unit,
      stayType: quote.stayType,
      arrivalDate: quote.arrivalDate,
      departureDate: quote.departureDate,
      pricingPolicyVersionId: quote.pricingPolicyVersionId,
      memberId: quote.memberId ?? null,
      memberContractId: quote.memberContractId ?? null,
      pricing
    };
    return finalize(propertyId, effect, {
      quoteInputHash: quote.inputHash,
      inventory: fingerprint,
      occupancyCapacity: unit.occupancyCapacity,
      membership: await memberBasis(db, quote.memberContractId ?? null, quote.memberId)
    });
  }

  if (commandType === "LOCK_MAINTENANCE") {
    const unitId = requireString(input, "inventoryUnitId");
    const arrivalDate = requireString(input, "arrivalDate");
    const departureDate = requireString(input, "departureDate");
    const reason = requireString(input, "reason");
    const unit = await loadInventoryUnit(db, propertyId, unitId);
    const fingerprint = await inventoryFingerprint(db, propertyId, unitId, arrivalDate, departureDate);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Inventory cannot be locked for maintenance", 409);
    return finalize(propertyId, { inventoryUnit: unit, arrivalDate, departureDate, reason }, { inventory: fingerprint });
  }

  if (commandType === "RELEASE_MAINTENANCE") {
    const maintenanceLockId = requireString(input, "maintenanceLockId");
    const lock = await db.selectFrom("maintenance_locks").selectAll().where("id", "=", maintenanceLockId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!lock) throw new DomainError("NOT_FOUND", "Maintenance lock not found", 404);
    if (lock.status !== "ACTIVE") throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock is already released", 409);
    const expectedDates = enumerateServiceDates(lock.arrival_date, lock.departure_date);
    const claims = await db.selectFrom("inventory_claims")
      .select(["id", "property_id", "room_id", "inventory_unit_id", "service_date", "active", "released_at"])
      .where("source_type", "=", "MAINTENANCE")
      .where("source_id", "=", maintenanceLockId)
      .orderBy("service_date")
      .orderBy("id")
      .execute();
    const expectedRoom = await db.selectFrom("inventory_units")
      .select(["id", "kind", "parent_room_id"])
      .where("id", "=", lock.inventory_unit_id)
      .where("property_id", "=", propertyId)
      .executeTakeFirst();
    const expectedRoomId = expectedRoom?.kind === "ROOM" ? expectedRoom.id : expectedRoom?.parent_room_id;
    const completeClaimSet = Boolean(expectedRoomId)
      && claims.length === expectedDates.length
      && claims.every((claim, index) => (
        claim.property_id === propertyId
        && claim.room_id === expectedRoomId
        && claim.inventory_unit_id === lock.inventory_unit_id
        && claim.service_date === expectedDates[index]
        && claim.active
        && claim.released_at === null
      ));
    if (!completeClaimSet) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Maintenance lock Claim set is incomplete or already partially released", 409);
    }
    return finalize(
      propertyId,
      { maintenanceLockId, inventoryUnitId: lock.inventory_unit_id, arrivalDate: lock.arrival_date, departureDate: lock.departure_date },
      {
        maintenanceVersion: lock.version,
        status: lock.status,
        maintenanceClaims: claims.map((claim) => `${claim.service_date}:${claim.id}:ACTIVE`)
      }
    );
  }

  if (commandType === "COMPLETE_CLEANING") {
    const cleaningTaskId = requireString(input, "cleaningTaskId");
    const task = await db.selectFrom("cleaning_tasks").selectAll()
      .where("id", "=", cleaningTaskId)
      .where("property_id", "=", propertyId)
      .executeTakeFirst();
    if (!task) throw new DomainError("NOT_FOUND", "Cleaning task not found", 404);
    if (task.status !== "PENDING") throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Cleaning task is already completed", 409);
    return finalize(propertyId, {
      cleaningTaskId,
      orderId: task.order_id,
      stayId: task.stay_id,
      inventoryUnitId: task.inventory_unit_id,
      roomId: task.room_id,
      serviceDate: task.service_date,
      fromStatus: task.status,
      toStatus: "COMPLETED"
    }, { cleaningTaskVersion: task.version, status: task.status });
  }

  if (commandType === "ADD_MEMBER_ENTITLEMENT_LOT") {
    const contractId = requireString(input, "memberContractId");
    const unitKind = requireString(input, "unitKind");
    if (unitKind !== "ROOM_NIGHT" && unitKind !== "BED_NIGHT") throw new DomainError("VALIDATION_ERROR", "unitKind must be ROOM_NIGHT or BED_NIGHT");
    const units = requireInteger(input, "units", { min: 1 });
    const expiresOn = requireString(input, "expiresOn");
    parseLocalDate(expiresOn);
    const propertyToday = await propertyLocalToday(db, propertyId);
    const contract = await db.selectFrom("member_contracts").selectAll()
      .where("id", "=", contractId).where("property_id", "=", propertyId).executeTakeFirst();
    if (!contract) throw new DomainError("NOT_FOUND", "Member contract not found", 404);
    if (contract.status !== "ACTIVE") throw new DomainError("ENTITLEMENT_CONFLICT", "Member contract is not active", 409);
    if (expiresOn < propertyToday) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is already naturally expired in the property timezone", 409, false, { expiresOn, propertyToday });
    }
    if (expiresOn < contract.valid_from || expiresOn > contract.valid_until) {
      throw new DomainError("VALIDATION_ERROR", "Entitlement lot expiry must be inside the member contract validity interval");
    }
    return finalize(propertyId, { contractId, unitKind, units, expiresOn }, { contractVersion: contract.version, propertyToday });
  }

  if (commandType === "ADJUST_MEMBER_ENTITLEMENT" || commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") {
    const lotId = requireString(input, "entitlementLotId");
    const adjustmentReason = requireString(input, "adjustmentReason");
    const propertyToday = await propertyLocalToday(db, propertyId);
    const lot = await db.selectFrom("entitlement_lots").innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.version", "entitlement_lots.contract_id", "entitlement_lots.unit_kind", "entitlement_lots.total_units", "entitlement_lots.expires_on", "member_contracts.property_id", "member_contracts.version as contract_version"])
      .where("entitlement_lots.id", "=", lotId).where("member_contracts.property_id", "=", propertyId).executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    const expiration = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("lot_id", "=", lotId).where("entry_type", "=", "EXPIRE").executeTakeFirst();
    if (expiration) throw new DomainError("ENTITLEMENT_CONFLICT", "An expired entitlement lot cannot be adjusted", 409, false, { expirationFactId: expiration.fact_id });
    if (lot.expires_on < propertyToday) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "A naturally expired entitlement lot cannot be adjusted", 409, false, { expiresOn: lot.expires_on, propertyToday });
    }
    const ledger = await db.selectFrom("entitlement_ledger")
      .select(sql<string>`cast(coalesce(sum(quantity_delta), 0) as text)`.as("delta"))
      .where("lot_id", "=", lotId)
      .executeTakeFirstOrThrow();
    const availableBefore = entitlementAvailableBalance(lot.total_units, ledger.delta);
    const quantityDelta = commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE"
      ? (() => {
        const expectedAvailableBalance = requireInteger(input, "expectedAvailableBalance", { min: 0 });
        if (expectedAvailableBalance !== availableBefore) {
          throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员余额已变化，请刷新后重新更正", 409, false, { expectedAvailableBalance, availableBefore });
        }
        const targetAvailableBalance = requireInteger(input, "targetAvailableBalance", { min: 0 });
        if (targetAvailableBalance === availableBefore) {
          throw new DomainError("VALIDATION_ERROR", "更正后余额必须与当前余额不同");
        }
        return targetAvailableBalance - availableBefore;
      })()
      : requireInteger(input, "quantityDelta", { allowZero: false });
    const availableAfter = adjustedEntitlementAvailableBalance(availableBefore, quantityDelta);
    return finalize(propertyId, {
      entitlementLotId: lot.id,
      contractId: lot.contract_id,
      unitKind: lot.unit_kind,
      quantityDelta,
      adjustmentReason,
      availableBefore,
      availableAfter
    }, {
      lotVersion: lot.version,
      contractVersion: lot.contract_version,
      availableBefore,
      propertyToday
    });
  }

  if (commandType === "EXPIRE_MEMBER_ENTITLEMENT") {
    const lotId = requireString(input, "entitlementLotId");
    const asOfDate = requireString(input, "asOfDate");
    const asOf = parseLocalDate(asOfDate);
    const propertyToday = await propertyLocalToday(db, propertyId);
    const lot = await db.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.id",
        "entitlement_lots.version",
        "entitlement_lots.contract_id",
        "entitlement_lots.unit_kind",
        "entitlement_lots.total_units",
        "entitlement_lots.expires_on",
        "member_contracts.property_id",
        "member_contracts.version as contract_version",
        sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("ledger_delta"),
        sql<string>`cast(count(*) filter (where entitlement_ledger.entry_type = 'EXPIRE') as text)`.as("expire_count")
      ])
      .where("entitlement_lots.id", "=", lotId)
      .where("member_contracts.property_id", "=", propertyId)
      .groupBy([
        "entitlement_lots.id",
        "entitlement_lots.version",
        "entitlement_lots.contract_id",
        "entitlement_lots.unit_kind",
        "entitlement_lots.total_units",
        "entitlement_lots.expires_on",
        "member_contracts.property_id",
        "member_contracts.version"
    ])
      .executeTakeFirst();
    if (!lot) throw new DomainError("NOT_FOUND", "Entitlement lot not found", 404);
    if (parsePostgresBigInt(lot.expire_count, "Entitlement expiration count") > 0n) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is already expired", 409);
    }
    if (asOf.getTime() <= parseLocalDate(lot.expires_on).getTime()) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot is still valid on asOfDate", 409, false, { expiresOn: lot.expires_on, asOfDate });
    }
    if (asOfDate > propertyToday) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Entitlement lot cannot be expired using a future property date", 409, false, { asOfDate, propertyToday });
    }
    const remainingAvailable = entitlementAvailableBalance(lot.total_units, lot.ledger_delta);
    return finalize(propertyId, {
      entitlementLotId: lot.id,
      contractId: lot.contract_id,
      unitKind: lot.unit_kind,
      expiresOn: lot.expires_on,
      asOfDate,
      remainingAvailable,
      quantityDelta: -remainingAvailable,
      entryType: "EXPIRE"
    }, {
      lotVersion: lot.version,
      contractVersion: lot.contract_version,
      remainingAvailable,
      propertyToday
    });
  }

  if (commandType === "ISSUE_TOKEN") {
    const subjectId = requireString(input, "subjectId");
    const label = requireString(input, "label");
    const accessCeiling = requireString(input, "accessCeiling");
    if (accessCeiling !== "READ" && accessCeiling !== "WRITE") throw new DomainError("VALIDATION_ERROR", "accessCeiling must be READ or WRITE");
    const expiresAt = requireFutureDateTime(input, "expiresAt");
    const tokenSecretHash = optionalTokenSecretHash(input);
    const subject = await db.selectFrom("subjects").innerJoin("subject_property_grants", "subject_property_grants.subject_id", "subjects.id")
      .select(["subjects.id", "subjects.status", "subjects.auth_version", "subject_property_grants.access_level"])
      .where("subjects.id", "=", subjectId).where("subject_property_grants.property_id", "=", propertyId).executeTakeFirst();
    if (!subject || subject.status !== "ACTIVE") throw new DomainError("SUBJECT_DISABLED", "Subject is not active for this property", 409);
    if (subject.access_level === "READ" && accessCeiling === "WRITE") throw new DomainError("INSUFFICIENT_ACCESS", "Token cannot exceed subject READ access", 403);
    return finalize(propertyId, { subjectId, label, accessCeiling, expiresAt }, {
      subjectAuthVersion: subject.auth_version,
      subjectAccess: subject.access_level,
      ...(tokenSecretHash ? { tokenSecretHash } : {})
    });
  }

  if (commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN") {
    const tokenId = requireString(input, "tokenId");
    const token = await db.selectFrom("api_tokens").innerJoin("subjects", "subjects.id", "api_tokens.subject_id")
      .select(["api_tokens.id", "api_tokens.subject_id", "api_tokens.label", "api_tokens.access_ceiling", "api_tokens.property_scope", "api_tokens.expires_at", "api_tokens.revoked_at", "api_tokens.replaced_by_id", "subjects.auth_version"])
      .where("api_tokens.id", "=", tokenId).where("api_tokens.property_scope", "=", propertyId).executeTakeFirst();
    if (!token) throw new DomainError("NOT_FOUND", "Token not found", 404);
    if (token.revoked_at) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Token is already revoked", 409);
    const requestedExpiresAt = optionalString(input, "expiresAt");
    const expiresAt = commandType === "ROTATE_TOKEN"
      ? (requestedExpiresAt ? requireFutureDateTime(input, "expiresAt") : new Date(token.expires_at).toISOString())
      : new Date(token.expires_at).toISOString();
    if (commandType === "ROTATE_TOKEN" && Date.parse(expiresAt) <= Date.now()) throw new DomainError("VALIDATION_ERROR", "Rotated token expiry must be in the future");
    const tokenSecretHash = commandType === "ROTATE_TOKEN" ? requireTokenSecretHash(input) : undefined;
    return finalize(propertyId, {
      tokenId: token.id, subjectId: token.subject_id, label: token.label, accessCeiling: token.access_ceiling,
      expiresAt, operation: commandType === "ROTATE_TOKEN" ? "ROTATE" : "REVOKE"
    }, {
      tokenRevokedAt: token.revoked_at,
      replacedById: token.replaced_by_id,
      subjectAuthVersion: token.auth_version,
      ...(tokenSecretHash ? { tokenSecretHash } : {})
    });
  }

  const orderId = requireString(input, "orderId");
  const context = await loadOrderContext(db, orderId);
  if (context.order.property_id !== propertyId) throw new DomainError("RESOURCE_SCOPE_DENIED", "Order belongs to another property", 403);
  const baseBasis: Record<string, unknown> = {
    orderVersion: context.order.version,
    orderStatus: context.order.status,
    policyVersionId: context.order.pricing_policy_version_id,
    membership: await memberBasis(db, context.order.member_contract_id, context.order.member_id)
  };

  if (commandType === "CORRECT_ORDER_OCCUPANT") {
    const occupantId = requireString(input, "occupantId");
    const occupant = await db.selectFrom("order_occupants")
      .selectAll()
      .where("id", "=", occupantId)
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    if (!occupant) throw new DomainError("NOT_FOUND", "Order occupant not found", 404);
    const latest = await db.selectFrom("order_occupant_corrections")
      .selectAll()
      .where("occupant_id", "=", occupantId)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const before = latest ? {
      fullName: latest.corrected_full_name,
      nickname: latest.corrected_nickname,
      phone: latest.corrected_phone,
      documentNumber: latest.corrected_document_number
    } : {
      fullName: occupant.full_name,
      nickname: occupant.nickname,
      phone: occupant.phone,
      documentNumber: occupant.document_number
    };
    const expectedInput = requireObject(input.expectedPriorSnapshot, "expectedPriorSnapshot");
    const expectedNullableField = (field: "fullName" | "nickname" | "phone" | "documentNumber", maximum: number): string | null => {
      if (!Object.hasOwn(expectedInput, field)) throw new DomainError("VALIDATION_ERROR", `expectedPriorSnapshot.${field} is required`);
      if (expectedInput[field] === null) return null;
      const value = requireString(expectedInput, field);
      if (value.length > maximum) throw new DomainError("VALIDATION_ERROR", `expectedPriorSnapshot.${field} is too long`);
      return value;
    };
    const expectedPriorSnapshot = {
      fullName: expectedNullableField("fullName", 200),
      nickname: expectedNullableField("nickname", 200),
      phone: expectedNullableField("phone", 80),
      documentNumber: expectedNullableField("documentNumber", 120)
    };
    if (stableHash(expectedPriorSnapshot) !== stableHash(before)) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Order occupant details changed; reload before correcting", 409);
    }
    const submitted = requireObject(input.correctedSnapshot, "correctedSnapshot");
    const nullableField = (field: "phone" | "documentNumber", maximum: number): string | null => {
      if (!Object.hasOwn(submitted, field)) throw new DomainError("VALIDATION_ERROR", `correctedSnapshot.${field} is required`);
      if (submitted[field] === null) return null;
      const value = requireString(submitted, field);
      if (value.length > maximum) throw new DomainError("VALIDATION_ERROR", `correctedSnapshot.${field} is too long`);
      return value;
    };
    const after = {
      fullName: requireString(submitted, "fullName"),
      nickname: requireString(submitted, "nickname"),
      phone: nullableField("phone", 80),
      documentNumber: nullableField("documentNumber", 120)
    };
    if (after.fullName.length > 200 || after.nickname.length > 200) {
      throw new DomainError("VALIDATION_ERROR", "Corrected occupant name is too long");
    }
    if (stableHash(before) === stableHash(after)) {
      throw new DomainError("VALIDATION_ERROR", "Corrected occupant snapshot must change at least one field");
    }
    return finalize(propertyId, {
      operation: "CORRECT_ORDER_OCCUPANT",
      orderId,
      occupantId,
      ordinal: occupant.ordinal,
      role: occupant.role,
      before,
      after
    }, {
      ...baseBasis,
      latestCorrectionId: latest?.id ?? null,
      correctionSequence: (latest?.sequence ?? 0) + 1,
      occupantSnapshot: before
    });
  }

  if (commandType === "SHORTEN_STAY") {
    assertOrderMutable(context.order.status);
    const newDepartureDate = requireString(input, "newDepartureDate");
    const dates = enumerateServiceDates(context.order.arrival_date, newDepartureDate);
    if (newDepartureDate >= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "New departure must shorten the stay");
    const currentTimeline = await loadActiveStayTimeline(db, context);
    const stayTimeline = currentTimeline.filter((item) => item.serviceDate < newDepartureDate);
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: newDepartureDate,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId,
      before: { departureDate: context.order.departure_date, currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      after: { departureDate: newDepartureDate, nights: dates.length, stayTimeline, pricing }
    }, { ...baseBasis, stayTimeline: currentTimeline });
  }

  if (commandType === "EXTEND_STAY") {
    assertOrderMutable(context.order.status);
    const newDepartureDate = requireString(input, "newDepartureDate");
    if (newDepartureDate <= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "New departure must extend the stay");
    const currentTimeline = await loadActiveStayTimeline(db, context);
    const extensionUnitId = currentTimeline.at(-1)!.inventoryUnitId;
    const extraFingerprint = await inventoryFingerprint(db, propertyId, extensionUnitId, context.order.departure_date, newDepartureDate, context.segmentIds);
    if (extraFingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Extension inventory is unavailable", 409);
    const stayTimeline = [
      ...currentTimeline,
      ...enumerateServiceDates(context.order.departure_date, newDepartureDate).map((serviceDate) => ({ serviceDate, inventoryUnitId: extensionUnitId }))
    ];
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: newDepartureDate,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: extensionUnitId,
      before: { departureDate: context.order.departure_date, currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      after: { departureDate: newDepartureDate, stayTimeline, pricing }
    }, { ...baseBasis, stayTimeline: currentTimeline, inventory: extraFingerprint });
  }

  if (commandType === "MOVE_UNIT") {
    assertOrderMutable(context.order.status);
    const newInventoryUnitId = requireString(input, "newInventoryUnitId");
    const effectiveDate = requireString(input, "effectiveDate");
    parseLocalDate(effectiveDate);
    if (effectiveDate < context.order.arrival_date || effectiveDate >= context.order.departure_date) throw new DomainError("VALIDATION_ERROR", "effectiveDate must be within the stay");
    const currentTimeline = await loadActiveStayTimeline(db, context);
    const effectiveUnitId = currentTimeline.find((item) => item.serviceDate === effectiveDate)!.inventoryUnitId;
    const currentUnit = await loadInventoryUnit(db, propertyId, effectiveUnitId);
    const newUnit = await loadInventoryUnit(db, propertyId, newInventoryUnitId);
    if (currentUnit.id === newUnit.id) throw new DomainError("VALIDATION_ERROR", "New inventory unit must differ from the current unit");
    const occupantCountRow = await db.selectFrom("order_occupants")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("order_id", "=", orderId)
      .executeTakeFirstOrThrow();
    const occupantCount = Number(occupantCountRow.count);
    if (!Number.isSafeInteger(occupantCount) || occupantCount < 1) {
      throw new DomainError("INTERNAL_ERROR", "Order has no valid frozen occupant list", 500);
    }
    if (occupantCount > newUnit.occupancyCapacity) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `${newUnit.code} 最多登记 ${newUnit.occupancyCapacity} 位住宿人，当前订单有 ${occupantCount} 位`
      );
    }
    if ((context.order.member_id || context.order.member_contract_id)
      && (currentUnit.kind !== newUnit.kind || currentUnit.roomTypeCode !== newUnit.roomTypeCode)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿只能更换到同一会员产品适用的房型", 409);
    }
    const fingerprint = await inventoryFingerprint(db, propertyId, newUnit.id, effectiveDate, context.order.departure_date, context.segmentIds);
    if (fingerprint.length > 0) throw new DomainError("INVENTORY_CONFLICT", "Destination inventory is unavailable", 409);
    const stayTimeline = currentTimeline.map((item) => item.serviceDate < effectiveDate ? item : { ...item, inventoryUnitId: newUnit.id });
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    return finalize(propertyId, {
      orderId,
      fromInventoryUnit: currentUnit,
      toInventoryUnit: newUnit,
      effectiveDate,
      occupantCount,
      occupancyCapacity: newUnit.occupancyCapacity,
      stayTimeline,
      pricing
    }, {
      ...baseBasis,
      stayTimeline: currentTimeline,
      inventory: fingerprint,
      occupantCount,
      destinationOccupancyCapacity: newUnit.occupancyCapacity
    });
  }

  if (commandType === "REPRICE_ORDER") {
    assertOrderMutable(context.order.status);
    const targetCurrentContractAmountMinor = requireNonNegativeWholeYuanMinor(input, "targetCurrentContractAmountMinor");
    if (context.order.stay_type === "FREE" && targetCurrentContractAmountMinor !== 0) {
      throw new DomainError("VALIDATION_ERROR", "Free stays must keep a zero current contract amount");
    }
    const stayTimeline = await loadActiveStayTimeline(db, context);
    const policyPricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    const manualAdjustmentMinor = targetCurrentContractAmountMinor - policyPricing.currentContractAmount.minorUnits;
    const pricing: PricingResult = {
      ...policyPricing,
      currentContractAmount: { currency: policyPricing.currentContractAmount.currency, minorUnits: targetCurrentContractAmountMinor }
    };
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId, stayTimeline,
      before: { currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      policyBaseAmount: policyPricing.currentContractAmount,
      targetCurrentContractAmount: pricing.currentContractAmount,
      pricing, manualAdjustmentMinor
    }, { ...baseBasis, stayTimeline });
  }

  if (commandType === "REFRESH_MEMBER_COVERAGE") {
    assertOrderMutable(context.order.status);
    if (!context.order.member_id && !context.order.member_contract_id) throw new DomainError("ENTITLEMENT_CONFLICT", "订单未选择会员档案，不能刷新会员覆盖", 409);
    const stayTimeline = await loadActiveStayTimeline(db, context);
    const pricing = await priceStayTimeline(db, {
      propertyId, orderId, memberId: context.order.member_id, memberContractId: context.order.member_contract_id,
      arrivalDate: context.order.arrival_date, departureDate: context.order.departure_date,
      stayType: context.order.stay_type as StayType, policyVersionId: context.order.pricing_policy_version_id,
      timeline: stayTimeline, manualAdjustmentMinor: 0
    });
    return finalize(propertyId, {
      orderId, inventoryUnitId: stayTimeline.at(-1)!.inventoryUnitId, stayTimeline,
      before: { currentContractAmount: (await orderAmountSummary(db, context)).currentContractAmount },
      pricing
    }, { ...baseBasis, stayTimeline });
  }

  if (commandType === "RECORD_COLLECTION") {
    const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
    const method = requireString(input, "method");
    const transactionReference = requireTransactionReference(input.transactionReference);
    if (!["RESERVED", "CHECKED_IN", "CHECKED_OUT"].includes(context.order.status)) throw new DomainError("INVALID_ORDER_STATE", "Cannot record a collection for this order", 409);
    return finalize(propertyId, { orderId, amountMinor, currency: context.revision.currency, method, transactionReference, note: optionalString(input, "note") ?? "" }, baseBasis);
  }

  if (commandType === "RECORD_REFUND") {
    const amountMinor = requireInteger(input, "amountMinor", { min: 1 });
    const referencesFactId = requireString(input, "referencesFactId");
    const transactionReference = requireTransactionReference(input.transactionReference);
    const original = await db.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .selectAll("collection_facts")
      .where("collection_facts.fact_id", "=", referencesFactId)
      .where("orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "Referenced collection fact not found", 404);
    if (original.order_id !== orderId) throw new DomainError("CROSS_ORDER_FACT_REFERENCE", "Refund must reference a collection in the same order", 409);
    if (original.fact_type !== "COLLECTION") throw new DomainError("VALIDATION_ERROR", "Refund must reference a collection fact");
    const originalReversal = await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", referencesFactId).executeTakeFirst();
    if (originalReversal) throw new DomainError("FACT_ALREADY_REVERSED", "Cannot refund a reversed collection", 409, false, { reversalFactId: originalReversal.fact_id });
    const activeRefunded = await activeRefundedAmount(db, referencesFactId);
    if (activeRefunded + amountMinor > original.amount_minor) throw new DomainError("REFUND_LIMIT_EXCEEDED", "Refund exceeds the remaining referenced collection", 409);
    return finalize(propertyId, { orderId, amountMinor, currency: original.currency, referencesFactId, method: requireString(input, "method"), transactionReference, note: optionalString(input, "note") ?? "" }, { ...baseBasis, originalFact: original, activeRefunded });
  }

  if (commandType === "REVERSE_FACT") {
    const reversesFactId = requireString(input, "reversesFactId");
    const original = await db.selectFrom("collection_facts")
      .innerJoin("orders", "orders.id", "collection_facts.order_id")
      .selectAll("collection_facts")
      .where("collection_facts.fact_id", "=", reversesFactId)
      .where("orders.property_id", "=", propertyId)
      .executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "Fact not found", 404);
    if (original.order_id !== orderId) throw new DomainError("CROSS_ORDER_FACT_REFERENCE", "Reversal must remain within the order", 409);
    if (original.fact_type === "REVERSAL") throw new DomainError("VALIDATION_ERROR", "A reversal fact cannot itself be reversed");
    const reversal = await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", reversesFactId).executeTakeFirst();
    if (reversal) throw new DomainError("FACT_ALREADY_REVERSED", "Fact is already reversed", 409);
    const activeRefunded = original.fact_type === "COLLECTION" ? await activeRefundedAmount(db, reversesFactId) : 0;
    if (activeRefunded > 0) {
      throw new DomainError("REFUND_LIMIT_EXCEEDED", "Reverse active refunds before reversing their collection", 409, false, { activeRefunded });
    }
    return finalize(propertyId, { orderId, reversesFactId, amountMinor: original.amount_minor, netEffectMinor: -original.net_effect_minor, currency: original.currency, note: requireString(input, "note") }, { ...baseBasis, originalFact: original, activeRefunded });
  }

  if (commandType === "CHECK_IN") {
    if (context.order.status !== "RESERVED") throw new DomainError("INVALID_ORDER_STATE", "Only a reserved order can check in", 409);
    const businessDate = await propertyLocalToday(db, propertyId);
    const expiredReservation = context.order.departure_date <= businessDate;
    const currentBusinessDateInventory = expiredReservation
      ? await inventoryFingerprint(
        db,
        propertyId,
        context.currentSegment.inventoryUnitId,
        businessDate,
        nextServiceDate(businessDate),
        context.segmentIds
      )
      : [];
    if (currentBusinessDateInventory.length > 0) {
      throw new DomainError(
        "INVENTORY_CONFLICT",
        `Expired reservation inventory is unavailable on the current business date ${businessDate}`,
        409
      );
    }
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: "CHECKED_IN",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: heldCoverage.length }
    }, {
      ...baseBasis,
      heldCoverageIds: heldCoverage.map((coverage) => coverage.id),
      checkInInventory: { businessDate, expiredReservation, fingerprint: currentBusinessDateInventory }
    });
  }

  if (commandType === "CHECK_OUT") {
    if (context.order.status !== "CHECKED_IN") throw new DomainError("INVALID_ORDER_STATE", "Only an in-house order can check out", 409);
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    if (heldCoverage.length > 0) throw new DomainError("ENTITLEMENT_CONFLICT", "In-house member coverage must be consumed before check-out", 409);
    const existingCleaningTask = await db.selectFrom("cleaning_tasks").select(["id", "status"])
      .where("order_id", "=", orderId).executeTakeFirst();
    if (existingCleaningTask) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "Check-out already has a cleaning task", 409, false, {
        cleaningTaskId: existingCleaningTask.id,
        status: existingCleaningTask.status
      });
    }
    const businessDate = await propertyLocalToday(db, propertyId);
    const cleaningServiceDate = businessDate < context.currentSegment.arrivalDate
      ? context.order.departure_date
      : businessDate;
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: "CHECKED_OUT",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      amounts: await orderAmountSummary(db, context),
      cleaningTask: {
        inventoryUnitId: context.currentSegment.inventoryUnitId,
        serviceDate: cleaningServiceDate,
        status: "PENDING"
      }
    }, { ...baseBasis, heldCoverageIds: [], cleaningTask: null, businessDate });
  }

  if (commandType === "CANCEL_ORDER" || commandType === "MARK_NO_SHOW") {
    if (context.order.status !== "RESERVED") throw new DomainError("INVALID_ORDER_STATE", `${commandType} requires a reserved order`, 409);
    const heldCoverage = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "HELD").orderBy("id").execute();
    return finalize(propertyId, {
      orderId,
      fromStatus: context.order.status,
      toStatus: commandType === "CANCEL_ORDER" ? "CANCELLED" : "NO_SHOW",
      inventoryUnitId: context.currentSegment.inventoryUnitId,
      freeStayReason: context.order.free_stay_reason,
      currentContractAmount: { currency: context.revision.currency, minorUnits: context.revision.currentContractAmountMinor },
      entitlementTransition: { from: "HELD", to: "RELEASED", coverageCount: heldCoverage.length }
    }, { ...baseBasis, heldCoverageIds: heldCoverage.map((coverage) => coverage.id) });
  }

  throw new DomainError("VALIDATION_ERROR", `Unsupported command type: ${commandType}`);
}

export function coverageFromEffect(effect: Record<string, unknown>): CoverageItemDto[] {
  const pricing = requireObject(effect.pricing ?? requireObject(effect.after, "after").pricing, "pricing");
  const coverageSet = pricing.coverageSet;
  if (!Array.isArray(coverageSet)) throw new DomainError("INTERNAL_ERROR", "Effect pricing has no coverage set", 500);
  return coverageSet as CoverageItemDto[];
}

export function inventoryKindFromEffect(effect: Record<string, unknown>): InventoryUnitKind | undefined {
  const unit = effect.inventoryUnit ?? effect.toInventoryUnit;
  if (!unit || typeof unit !== "object") return undefined;
  const kind = (unit as Record<string, unknown>).kind;
  return kind === "ROOM" || kind === "BED" ? kind : undefined;
}

export function projectPrimaryGuestForRead(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

export function projectCommandEffectForRead(commandType: string, effect: Record<string, unknown>): Record<string, unknown> {
  if (commandType === "CREATE_ORDER") {
    return {
      ...effect,
      primaryGuest: projectPrimaryGuestForRead(effect.primaryGuest),
      ...(Object.hasOwn(effect, "occupants") ? { occupants: effect.occupants } : {}),
      bookingChannelCode: Object.hasOwn(effect, "bookingChannelCode") ? effect.bookingChannelCode : null,
      channelOrderReference: Object.hasOwn(effect, "channelOrderReference") ? effect.channelOrderReference : null,
      freeStayReason: Object.hasOwn(effect, "freeStayReason") ? effect.freeStayReason : null,
      memberId: Object.hasOwn(effect, "memberId") ? effect.memberId : null
    };
  }
  if (commandType === "RECORD_COLLECTION" || commandType === "RECORD_REFUND") {
    return {
      ...effect,
      transactionReference: Object.hasOwn(effect, "transactionReference") ? effect.transactionReference : null
    };
  }
  return effect;
}
