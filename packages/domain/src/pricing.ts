import type { CashLineDto, CoverageItemDto, EntitlementUnitKind, InventoryUnitKind, MoneyDto, StayType } from "@qintopia/contracts";
import { DomainError } from "@qintopia/contracts";
import { enumerateServiceDates } from "./dates.ts";

export type DurationBandAnchorNights = 1 | 7 | 14 | 30;
export type DurationBandAnchors = Record<DurationBandAnchorNights, number>;

export interface PricingPolicy {
  id: string;
  stayType: StayType | null;
  calculationKind: "FLAT_NIGHTLY" | "DURATION_BAND_TOTAL" | "FREE";
  nightlyRateMinor: number | null;
  productAnchorRatesMinor?: Record<string, DurationBandAnchors> | null;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  roundingRule?: "FINAL_TOTAL_WHOLE_YUAN_HALF_UP" | null;
  currency: string;
}

export interface ExactDurationBandAmount {
  nights: number;
  anchorNights: DurationBandAnchorNights;
  anchorAmountMinor: number;
  numeratorMinor: number;
  denominator: number;
}

export interface CoverageCandidate {
  serviceDate: string;
  entitlementLotId: string;
  status?: "HELD" | "CONSUMED";
  inventoryUnitId?: string;
  unitKind?: EntitlementUnitKind;
}

export interface PricingInput {
  propertyId: string;
  inventoryUnitId: string;
  inventoryUnitKind: InventoryUnitKind;
  inventoryProductCode?: string | null;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policy: PricingPolicy;
  memberCoverage?: boolean;
  coverageCandidates?: CoverageCandidate[];
  manualAdjustmentMinor?: number;
}

export interface PricingTimelineItem {
  serviceDate: string;
  inventoryUnitId: string;
  inventoryUnitKind: InventoryUnitKind;
  inventoryProductCode: string | null;
}

export interface DurationTimelinePricingInput {
  propertyId: string;
  arrivalDate: string;
  departureDate: string;
  stayType: StayType;
  policy: PricingPolicy;
  memberCoverage?: boolean;
  timeline: PricingTimelineItem[];
  coverageCandidates?: CoverageCandidate[];
  manualAdjustmentMinor?: number;
}

export interface PricingResult {
  coverageSet: CoverageItemDto[];
  cashLines: CashLineDto[];
  cashRemainder: MoneyDto;
  currentContractAmount: MoneyDto;
}

export function entitlementKindFor(unitKind: InventoryUnitKind): EntitlementUnitKind {
  return unitKind === "ROOM" ? "ROOM_NIGHT" : "BED_NIGHT";
}

export function isTransientDuration(nights: number): boolean {
  if (!Number.isSafeInteger(nights) || nights < 1) throw new DomainError("VALIDATION_ERROR", "Stay nights must be a positive integer");
  return nights < 7;
}

export function paidStayTypeForNights(nights: number): "TRANSIENT" | "CUSTOM" {
  return isTransientDuration(nights) ? "TRANSIENT" : "CUSTOM";
}

export function durationBandAnchorNights(nights: number): DurationBandAnchorNights {
  if (!Number.isSafeInteger(nights) || nights < 1) throw new DomainError("VALIDATION_ERROR", "Stay nights must be a positive integer");
  if (nights < 7) return 1;
  if (nights < 14) return 7;
  if (nights < 30) return 14;
  return 30;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function exactDurationBandAmount(nights: number, anchors: DurationBandAnchors): ExactDurationBandAmount {
  const anchorNights = durationBandAnchorNights(nights);
  const anchorAmountMinor = anchors[anchorNights];
  if (!Number.isSafeInteger(anchorAmountMinor) || anchorAmountMinor <= 0) {
    throw new DomainError("VALIDATION_ERROR", `The ${anchorNights}-night anchor must be a positive integer in minor units`);
  }
  const rawNumerator = nights * anchorAmountMinor;
  if (!Number.isSafeInteger(rawNumerator)) throw new DomainError("VALIDATION_ERROR", "Pricing amount exceeds the supported integer range");
  const divisor = greatestCommonDivisor(rawNumerator, anchorNights);
  return {
    nights,
    anchorNights,
    anchorAmountMinor,
    numeratorMinor: rawNumerator / divisor,
    denominator: anchorNights / divisor
  };
}

export function roundPositiveRationalHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new DomainError("VALIDATION_ERROR", "Half-up rounding requires a non-negative numerator and positive denominator");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function roundExactAmountToWholeYuanMinor(amount: ExactDurationBandAmount): number {
  const roundedYuan = roundPositiveRationalHalfUp(BigInt(amount.numeratorMinor), BigInt(amount.denominator) * 100n);
  const minorUnits = roundedYuan * 100n;
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError("VALIDATION_ERROR", "Pricing amount exceeds the supported integer range");
  return Number(minorUnits);
}

export function calculateDurationBandTotalMinor(nights: number, anchors: DurationBandAnchors): {
  exact: ExactDurationBandAmount;
  roundedMinor: number;
} {
  const exact = exactDurationBandAmount(nights, anchors);
  return { exact, roundedMinor: roundExactAmountToWholeYuanMinor(exact) };
}

export function manualRefundAmountFromRecordedFacts(currentContractAmountMinor: number, netRecordedCollectionMinor: number): number {
  if (!Number.isSafeInteger(currentContractAmountMinor) || !Number.isSafeInteger(netRecordedCollectionMinor)) {
    throw new DomainError("VALIDATION_ERROR", "Recorded amounts must be safe integers");
  }
  return Math.max(0, netRecordedCollectionMinor - currentContractAmountMinor);
}

function requireDurationAnchors(policy: PricingPolicy, productCode: string | null): DurationBandAnchors {
  const anchors = productCode ? policy.productAnchorRatesMinor?.[productCode] : undefined;
  if (!anchors || ![1, 7, 14, 30].every((nights) => Number.isSafeInteger(anchors[nights as DurationBandAnchorNights]) && anchors[nights as DurationBandAnchorNights] > 0)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", `Duration-band policy anchors are incomplete for ${productCode ?? "an unmapped inventory product"}`, 422);
  }
  if (policy.roundingRule !== "FINAL_TOTAL_WHOLE_YUAN_HALF_UP") {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Duration-band final-total rounding is not configured", 422);
  }
  return anchors;
}

function nextServiceDate(serviceDate: string): string {
  const date = new Date(`${serviceDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function calculateDurationTimelinePricing(input: DurationTimelinePricingInput): PricingResult {
  if (input.stayType === "FREE" || input.policy.calculationKind !== "DURATION_BAND_TOTAL" || input.policy.stayType !== null) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Duration-band policy applies only to paid stays", 422);
  }
  if (!input.policy.effectiveFrom || input.arrivalDate < input.policy.effectiveFrom
    || (input.policy.effectiveUntil !== null && input.policy.effectiveUntil !== undefined && input.arrivalDate >= input.policy.effectiveUntil)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Pricing policy is not effective for the stay arrival date", 422);
  }
  if (input.policy.roundingRule !== "FINAL_TOTAL_WHOLE_YUAN_HALF_UP") {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Duration-band final-total rounding is not configured", 422);
  }
  const manualAdjustment = validateManualAdjustment(input.policy, input.manualAdjustmentMinor);

  const dates = enumerateServiceDates(input.arrivalDate, input.departureDate);
  if (input.timeline.length !== dates.length || input.timeline.some((item, index) => item.serviceDate !== dates[index])) {
    throw new DomainError("INTERNAL_ERROR", "Pricing timeline must cover the complete stay in date order", 500);
  }
  const candidates = new Map((input.coverageCandidates ?? []).map((candidate) => [candidate.serviceDate, candidate]));
  if (candidates.size !== (input.coverageCandidates ?? []).length || [...candidates.keys()].some((serviceDate) => !dates.includes(serviceDate))) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Coverage dates must be unique and inside the stay", 409);
  }
  const coverageSet: CoverageItemDto[] = [];
  for (const item of input.timeline) {
    const candidate = candidates.get(item.serviceDate);
    if (!candidate) continue;
    const timelineUnitKind = entitlementKindFor(item.inventoryUnitKind);
    if (candidate.status === "CONSUMED" && candidate.unitKind && candidate.unitKind !== timelineUnitKind) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "Consumed coverage cannot move across entitlement unit kinds", 409);
    }
    coverageSet.push({
      serviceDate: item.serviceDate,
      inventoryUnitId: candidate.status === "CONSUMED" && candidate.inventoryUnitId ? candidate.inventoryUnitId : item.inventoryUnitId,
      unitKind: candidate.status === "CONSUMED" && candidate.unitKind ? candidate.unitKind : timelineUnitKind,
      entitlementLotId: candidate.entitlementLotId
    });
  }

  const memberCoverage = input.memberCoverage === true || coverageSet.length > 0;
  if (memberCoverage) {
    const cashLines: CashLineDto[] = [];
    for (const item of input.timeline) {
      if (candidates.has(item.serviceDate)) continue;
      const p1 = requireDurationAnchors(input.policy, item.inventoryProductCode)[1];
      if (p1 % 100 !== 0) throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Member P1 cash lines require a confirmed whole-yuan anchor", 422);
      cashLines.push({
        lineKind: "NIGHT",
        serviceDate: item.serviceDate,
        inventoryUnitId: item.inventoryUnitId,
        description: "Member cash remainder at locked one-night transient price",
        amount: { currency: input.policy.currency, minorUnits: p1 }
      });
    }
    const rawCashMinor = cashLines.reduce((sum, line) => sum + line.amount.minorUnits, 0);
    const cashSubtotal = Number(roundPositiveRationalHalfUp(BigInt(rawCashMinor), 100n) * 100n);
    const currentContractAmountMinor = applyManualAdjustment(cashSubtotal, manualAdjustment, true);
    return {
      coverageSet,
      cashLines,
      cashRemainder: { currency: input.policy.currency, minorUnits: cashSubtotal },
      currentContractAmount: { currency: input.policy.currency, minorUnits: currentContractAmountMinor }
    };
  }

  const anchorNights = durationBandAnchorNights(dates.length);
  const segments: Array<{
    inventoryUnitId: string;
    pricingProductCode: string;
    arrivalDate: string;
    departureDate: string;
    nights: number;
    anchorAmountMinor: number;
    numeratorMinor: number;
    denominator: DurationBandAnchorNights;
  }> = [];
  for (const item of input.timeline) {
    if (!item.inventoryProductCode) throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Inventory unit has no pricing product", 422);
    const current = segments.at(-1);
    if (current && current.inventoryUnitId === item.inventoryUnitId && current.pricingProductCode === item.inventoryProductCode && current.departureDate === item.serviceDate) {
      current.departureDate = nextServiceDate(item.serviceDate);
      current.nights += 1;
      current.numeratorMinor += current.anchorAmountMinor;
      continue;
    }
    const anchorAmountMinor = requireDurationAnchors(input.policy, item.inventoryProductCode)[anchorNights];
    segments.push({
      inventoryUnitId: item.inventoryUnitId,
      pricingProductCode: item.inventoryProductCode,
      arrivalDate: item.serviceDate,
      departureDate: nextServiceDate(item.serviceDate),
      nights: 1,
      anchorAmountMinor,
      numeratorMinor: anchorAmountMinor,
      denominator: anchorNights
    });
  }
  const numeratorMinor = segments.reduce((sum, segment) => sum + segment.numeratorMinor, 0);
  if (!Number.isSafeInteger(numeratorMinor)) throw new DomainError("VALIDATION_ERROR", "Pricing amount exceeds the supported integer range");
  const roundedMinorBigInt = roundPositiveRationalHalfUp(BigInt(numeratorMinor), BigInt(anchorNights) * 100n) * 100n;
  if (roundedMinorBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError("VALIDATION_ERROR", "Pricing amount exceeds the supported integer range");
  const roundedMinor = Number(roundedMinorBigInt);
  const currentContractAmountMinor = applyManualAdjustment(roundedMinor, manualAdjustment, true);
  const cashLines: CashLineDto[] = [{
    lineKind: "STAY_TOTAL",
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    inventoryUnitId: input.timeline[0]!.inventoryUnitId,
    description: "Accommodation total from locked duration band",
    pricingBandAnchorNights: anchorNights,
    calculationSegments: segments,
    amount: { currency: input.policy.currency, minorUnits: roundedMinor }
  }];
  return {
    coverageSet,
    cashLines,
    cashRemainder: { currency: input.policy.currency, minorUnits: roundedMinor },
    currentContractAmount: { currency: input.policy.currency, minorUnits: currentContractAmountMinor }
  };
}

function validateManualAdjustment(policy: PricingPolicy, value: number | undefined): number {
  const manualAdjustment = value ?? 0;
  if (!Number.isInteger(manualAdjustment)) throw new DomainError("VALIDATION_ERROR", "Manual adjustment must be an integer");
  if (policy.calculationKind === "FREE" && manualAdjustment !== 0) {
    throw new DomainError("VALIDATION_ERROR", "Free stays cannot have a manual price adjustment");
  }
  return manualAdjustment;
}

function applyManualAdjustment(policyBaseMinor: number, manualAdjustmentMinor: number, requireWholeYuan: boolean): number {
  const targetMinor = policyBaseMinor + manualAdjustmentMinor;
  if (!Number.isSafeInteger(targetMinor) || targetMinor < 0) {
    throw new DomainError("VALIDATION_ERROR", "The final current contract amount must be a non-negative safe integer");
  }
  if (requireWholeYuan && targetMinor % 100 !== 0) {
    throw new DomainError("VALIDATION_ERROR", "The final current contract amount must be a whole-yuan CNY amount");
  }
  return targetMinor;
}

export function calculatePricing(input: PricingInput): PricingResult {
  const approvedPolicyShape = (input.stayType === "TRANSIENT" && input.policy.calculationKind === "FLAT_NIGHTLY" && input.policy.stayType === "TRANSIENT")
    || (input.stayType === "FREE" && input.policy.calculationKind === "FREE" && input.policy.stayType === "FREE")
    || (input.stayType !== "FREE" && input.policy.calculationKind === "DURATION_BAND_TOTAL" && input.policy.stayType === null);
  if (!approvedPolicyShape) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", `${input.stayType} pricing requires an approved finite policy`, 422);
  }

  if (input.policy.calculationKind === "DURATION_BAND_TOTAL") {
    const dates = enumerateServiceDates(input.arrivalDate, input.departureDate);
    return calculateDurationTimelinePricing({
      propertyId: input.propertyId,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      stayType: input.stayType,
      policy: input.policy,
      ...(input.memberCoverage !== undefined ? { memberCoverage: input.memberCoverage } : {}),
      timeline: dates.map((serviceDate) => ({
        serviceDate,
        inventoryUnitId: input.inventoryUnitId,
        inventoryUnitKind: input.inventoryUnitKind,
        inventoryProductCode: input.inventoryProductCode ?? null
      })),
      ...(input.coverageCandidates !== undefined ? { coverageCandidates: input.coverageCandidates } : {}),
      ...(input.manualAdjustmentMinor !== undefined ? { manualAdjustmentMinor: input.manualAdjustmentMinor } : {})
    });
  }

  const dates = enumerateServiceDates(input.arrivalDate, input.departureDate);
  if (input.policy.calculationKind === "FLAT_NIGHTLY" && input.arrivalDate.slice(0, 7) !== input.departureDate.slice(0, 7)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Cross-month pricing requires the approved 2026 duration-band policy", 422);
  }

  const candidates = new Map((input.coverageCandidates ?? []).map((candidate) => [candidate.serviceDate, candidate]));
  if (candidates.size !== (input.coverageCandidates ?? []).length || [...candidates.keys()].some((serviceDate) => !dates.includes(serviceDate))) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Coverage dates must be unique and inside the stay", 409);
  }
  const unitKind = entitlementKindFor(input.inventoryUnitKind);
  const coverageSet: CoverageItemDto[] = [];
  const cashLines: CashLineDto[] = [];
  const manualAdjustment = validateManualAdjustment(input.policy, input.manualAdjustmentMinor);

  if (input.policy.calculationKind === "FREE" && (input.memberCoverage === true || candidates.size > 0)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "Free stays must not hold or consume member entitlement", 409);
  }

  if (!Number.isInteger(input.policy.nightlyRateMinor) || input.policy.nightlyRateMinor === null || input.policy.nightlyRateMinor < 0) {
    throw new DomainError("VALIDATION_ERROR", "Policy nightly rate must be a non-negative integer");
  }
  if (input.policy.calculationKind === "FREE" && input.policy.nightlyRateMinor !== 0) {
    throw new DomainError("VALIDATION_ERROR", "A free policy must have a zero nightly rate");
  }

  for (const serviceDate of dates) {
    const candidate = candidates.get(serviceDate);
    if (candidate !== undefined) {
      if (candidate.status === "CONSUMED" && candidate.unitKind && candidate.unitKind !== unitKind) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "Consumed coverage cannot move across entitlement unit kinds", 409);
      }
      coverageSet.push({
        serviceDate,
        inventoryUnitId: candidate.status === "CONSUMED" && candidate.inventoryUnitId ? candidate.inventoryUnitId : input.inventoryUnitId,
        unitKind: candidate.status === "CONSUMED" && candidate.unitKind ? candidate.unitKind : unitKind,
        entitlementLotId: candidate.entitlementLotId
      });
      continue;
    }
    const amount = input.policy.calculationKind === "FREE" ? 0 : input.policy.nightlyRateMinor;
    cashLines.push({
      serviceDate,
      inventoryUnitId: input.inventoryUnitId,
      description: input.policy.calculationKind === "FREE" ? "Free accommodation" : "Nightly accommodation",
      amount: { currency: input.policy.currency, minorUnits: amount }
    });
  }

  const cashSubtotal = cashLines.reduce((sum, line) => sum + line.amount.minorUnits, 0);
  const currentContractAmountMinor = applyManualAdjustment(cashSubtotal, manualAdjustment, false);
  return {
    coverageSet,
    cashLines,
    cashRemainder: { currency: input.policy.currency, minorUnits: cashSubtotal },
    currentContractAmount: { currency: input.policy.currency, minorUnits: currentContractAmountMinor }
  };
}

export function amountSummary(currency: string, currentContractAmount: number, signedCollectionEffects: number[]) {
  const netRecordedCollection = signedCollectionEffects.reduce((sum, effect) => sum + effect, 0);
  const refundReferenceAmount = Math.max(0, netRecordedCollection - currentContractAmount);
  if (!Number.isSafeInteger(netRecordedCollection)
    || !Number.isSafeInteger(refundReferenceAmount)
    || refundReferenceAmount > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", "订单建议退款金额超出支持范围", 409);
  }
  return {
    currentContractAmount: { currency, minorUnits: currentContractAmount },
    netRecordedCollection: { currency, minorUnits: netRecordedCollection },
    collectionDifference: { currency, minorUnits: currentContractAmount - netRecordedCollection },
    refundReferenceAmount: { currency, minorUnits: refundReferenceAmount }
  };
}
