import type { CashLineDto, CoverageItemDto, InventoryUnitKind, StayType } from "@qintopia/contracts";
import {
  calculateDurationTimelinePricing,
  calculatePricing,
  durationBandAnchorNights,
  enumerateServiceDates,
  type DurationBandAnchors,
  type PricingPolicy,
  type PricingResult,
  type PricingTimelineItem
} from "@qintopia/domain";
import type {
  PricingFactCase,
  PricingFactCoverageItem,
  PricingFactExecutionResult,
  PricingFactExecutorRegistry,
  PricingFactRevision
} from "./harness.ts";

const policyVersionReference = "policy_qintopia_public_2026_rev561_v1";
const propertyId = "qintopia-pricing-facts";

const products = {
  shared_bath_quad_bed: { kind: "BED", anchors: { 1: 5_800, 7: 30_800, 14: 48_000, 30: 78_000 } },
  shared_bath_double_bed: { kind: "BED", anchors: { 1: 6_800, 7: 38_000, 14: 55_000, 30: 90_000 } },
  shared_bath_single_room: { kind: "ROOM", anchors: { 1: 13_000, 7: 59_000, 14: 82_000, 30: 135_000 } },
  shared_bath_standard_room: { kind: "ROOM", anchors: { 1: 18_000, 7: 79_000, 14: 120_000, 30: 195_000 } },
  private_bath_single_room: { kind: "ROOM", anchors: { 1: 17_000, 7: 72_000, 14: 119_000, 30: 180_000 } },
  private_bath_standard_room: { kind: "ROOM", anchors: { 1: 24_000, 7: 102_000, 14: 168_000, 30: 258_000 } },
  private_bath_king_room: { kind: "ROOM", anchors: { 1: 24_000, 7: 102_000, 14: 168_000, 30: 258_000 } },
  private_bath_suite_room: { kind: "ROOM", anchors: { 1: 32_000, 7: 128_000, 14: 188_000, 30: 320_000 } },
  shared_bath_double_whole_room: { kind: "ROOM", anchors: { 1: 13_600, 7: 76_000, 14: 110_000, 30: 180_000 } },
  shared_bath_quad_whole_room: { kind: "ROOM", anchors: { 1: 23_200, 7: 123_200, 14: 192_000, 30: 312_000 } }
} as const satisfies Record<string, { kind: InventoryUnitKind; anchors: DurationBandAnchors }>;

type ProductCode = keyof typeof products;

const paidPolicy: PricingPolicy = {
  id: policyVersionReference,
  stayType: null,
  calculationKind: "DURATION_BAND_TOTAL",
  nightlyRateMinor: null,
  productAnchorRatesMinor: Object.fromEntries(
    Object.entries(products).map(([code, product]) => [code, product.anchors])
  ),
  effectiveFrom: "2026-02-25",
  effectiveUntil: null,
  roundingRule: "FINAL_TOTAL_WHOLE_YUAN_HALF_UP",
  currency: "CNY"
};

const freePolicy: PricingPolicy = {
  id: "policy_free_v1",
  stayType: "FREE",
  calculationKind: "FREE",
  nightlyRateMinor: 0,
  currency: "CNY"
};

interface FactPriceInputs {
  policyVersionReference: string;
  initialProductCode: ProductCode;
  initialInventoryUnitReference: string;
  memberCoverage: boolean;
  initialArrivalDate?: string;
  initialDepartureDate?: string;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer`);
  return value as number;
}

function requireProductCode(value: unknown, field: string): ProductCode {
  const productCode = requireString(value, field);
  if (!Object.hasOwn(products, productCode)) throw new Error(`${field} is not a confirmed pricing product`);
  return productCode as ProductCode;
}

function parseInputs(pricingCase: PricingFactCase): FactPriceInputs {
  const raw = requireObject(pricingCase.priceInputs, "priceInputs");
  const inputs: FactPriceInputs = {
    policyVersionReference: requireString(raw.policyVersionReference, "priceInputs.policyVersionReference"),
    initialProductCode: requireProductCode(raw.initialProductCode, "priceInputs.initialProductCode"),
    initialInventoryUnitReference: requireString(raw.initialInventoryUnitReference, "priceInputs.initialInventoryUnitReference"),
    memberCoverage: raw.memberCoverage === true
  };
  if (raw.initialArrivalDate !== undefined) inputs.initialArrivalDate = requireString(raw.initialArrivalDate, "priceInputs.initialArrivalDate");
  if (raw.initialDepartureDate !== undefined) inputs.initialDepartureDate = requireString(raw.initialDepartureDate, "priceInputs.initialDepartureDate");
  return inputs;
}

function initialTimeline(inputs: FactPriceInputs, arrivalDate: string, departureDate: string): PricingTimelineItem[] {
  const product = products[inputs.initialProductCode];
  return enumerateServiceDates(arrivalDate, departureDate).map((serviceDate) => ({
    serviceDate,
    inventoryUnitId: inputs.initialInventoryUnitReference,
    inventoryUnitKind: product.kind,
    inventoryProductCode: inputs.initialProductCode
  }));
}

function toFactCoverage(items: CoverageItemDto[]): PricingFactCoverageItem[] {
  return items.map((item) => ({
    serviceDate: item.serviceDate,
    inventoryUnitReference: item.inventoryUnitId,
    unitKind: item.unitKind
  }));
}

function toFactCashLines(lines: CashLineDto[]): Record<string, unknown>[] {
  const stayTotal = lines.find((line) => line.lineKind === "STAY_TOTAL");
  if (stayTotal?.lineKind === "STAY_TOTAL") {
    return [{
      lineKind: "STAY_TOTAL",
      pricingBandAnchorNights: stayTotal.pricingBandAnchorNights,
      calculationSegments: stayTotal.calculationSegments.map((segment) => ({
        inventoryUnitReference: segment.inventoryUnitId,
        pricingProductCode: segment.pricingProductCode,
        arrivalDate: segment.arrivalDate,
        departureDate: segment.departureDate,
        nights: segment.nights,
        anchorAmountMinor: segment.anchorAmountMinor,
        numeratorMinor: segment.numeratorMinor,
        denominator: segment.denominator
      })),
      amountMinor: stayTotal.amount.minorUnits
    }];
  }
  return [{
    lineKind: "NIGHT_SET",
    lines: lines.map((line) => {
      if (!("serviceDate" in line)) throw new Error("Expected a nightly cash line");
      return {
        serviceDate: line.serviceDate,
        inventoryUnitReference: line.inventoryUnitId,
        amountMinor: line.amount.minorUnits
      };
    }),
    totalMinor: lines.reduce((sum, line) => sum + line.amount.minorUnits, 0)
  }];
}

function calculateRevision(
  pricingCase: PricingFactCase,
  timeline: PricingTimelineItem[],
  arrivalDate: string,
  departureDate: string,
  manualAdjustmentMinor = 0
): PricingResult {
  if (pricingCase.businessPlan === "FREE") {
    const unit = timeline[0];
    if (!unit) throw new Error("Free pricing timeline cannot be empty");
    return calculatePricing({
      propertyId,
      inventoryUnitId: unit.inventoryUnitId,
      inventoryUnitKind: unit.inventoryUnitKind,
      inventoryProductCode: unit.inventoryProductCode,
      arrivalDate,
      departureDate,
      stayType: "FREE",
      policy: freePolicy
    });
  }
  const coverageCandidates = pricingCase.coverageSet
    .filter((item) => item.serviceDate >= arrivalDate && item.serviceDate < departureDate)
    .map((item) => ({ serviceDate: item.serviceDate, entitlementLotId: `fact-lot-${item.serviceDate}` }));
  return calculateDurationTimelinePricing({
    propertyId,
    arrivalDate,
    departureDate,
    stayType: pricingCase.businessPlan as StayType,
    policy: paidPolicy,
    memberCoverage: parseInputs(pricingCase).memberCoverage,
    timeline,
    coverageCandidates,
    manualAdjustmentMinor
  });
}

function roundingEvidence(
  pricingCase: PricingFactCase,
  nights: number,
  manual?: { policyBaseAmountMinor: number; targetCurrentContractAmountMinor: number }
): Record<string, unknown> {
  if (pricingCase.businessPlan === "FREE") return { rule: "ZERO_FREE_STAY" };
  const base = {
    rule: parseInputs(pricingCase).memberCoverage
      ? "UNCOVERED_DATES_AT_P1_FINAL_WHOLE_YUAN_HALF_UP"
      : "FINAL_STAY_TOTAL_WHOLE_YUAN_HALF_UP",
    pricingBandAnchorNights: durationBandAnchorNights(nights)
  };
  return manual === undefined ? base : {
    ...base,
    policyBaseAmountMinor: manual.policyBaseAmountMinor,
    targetCurrentContractAmountMinor: manual.targetCurrentContractAmountMinor
  };
}

export async function executeConfirmedPricingFact(pricingCase: PricingFactCase): Promise<PricingFactExecutionResult> {
  const inputs = parseInputs(pricingCase);
  const expectedPolicyVersion = pricingCase.businessPlan === "FREE" ? freePolicy.id : policyVersionReference;
  if (inputs.policyVersionReference !== expectedPolicyVersion) throw new Error("Pricing fact does not reference the confirmed locked policy version");
  let arrivalDate = inputs.initialArrivalDate ?? pricingCase.arrivalDate;
  let departureDate = inputs.initialDepartureDate ?? pricingCase.departureDate;
  let timeline = initialTimeline(inputs, arrivalDate, departureDate);
  const revisions: PricingFactRevision[] = [];

  const appendRevision = (amendmentType: PricingFactRevision["amendmentType"], manualTarget?: number): void => {
    const policyBase = calculateRevision(pricingCase, timeline, arrivalDate, departureDate);
    const manualAdjustmentMinor = manualTarget === undefined ? 0 : manualTarget - policyBase.currentContractAmount.minorUnits;
    const result = manualTarget === undefined
      ? policyBase
      : calculateRevision(pricingCase, timeline, arrivalDate, departureDate, manualAdjustmentMinor);
    revisions.push({
      revisionNo: revisions.length + 1,
      amendmentType,
      pricingPolicyVersionReference: inputs.policyVersionReference,
      arrivalDate,
      departureDate,
      coverageSet: toFactCoverage(result.coverageSet),
      cashLines: toFactCashLines(result.cashLines),
      manualAdjustmentMinor,
      cashRemainderMinor: result.cashRemainder.minorUnits,
      currentContractAmountMinor: result.currentContractAmount.minorUnits,
      roundingEvidence: roundingEvidence(pricingCase, timeline.length, manualTarget === undefined ? undefined : {
        policyBaseAmountMinor: policyBase.currentContractAmount.minorUnits,
        targetCurrentContractAmountMinor: manualTarget
      })
    });
  };

  appendRevision("CREATE_ORDER");
  for (const amendment of pricingCase.amendments) {
    const amendmentInput = requireObject(amendment.input, `amendments[${amendment.sequence}].input`);
    if (amendment.amendmentType === "RESCHEDULE_STAY") {
      const newArrivalDate = requireString(amendmentInput.newArrivalDate, "newArrivalDate");
      const newDepartureDate = requireString(amendmentInput.newDepartureDate, "newDepartureDate");
      const template = timeline[0];
      if (!template) throw new Error("Cannot reschedule an empty timeline");
      timeline = enumerateServiceDates(newArrivalDate, newDepartureDate).map((serviceDate) => ({ ...template, serviceDate }));
      arrivalDate = newArrivalDate;
      departureDate = newDepartureDate;
      appendRevision("RESCHEDULE_STAY");
      continue;
    }
    if (amendment.amendmentType === "EXTEND_STAY") {
      const newDepartureDate = requireString(amendmentInput.newDepartureDate, "newDepartureDate");
      const last = timeline.at(-1);
      if (!last) throw new Error("Cannot extend an empty timeline");
      timeline.push(...enumerateServiceDates(departureDate, newDepartureDate).map((serviceDate) => ({ ...last, serviceDate })));
      departureDate = newDepartureDate;
      appendRevision("EXTEND_STAY");
      continue;
    }
    if (amendment.amendmentType === "MOVE_UNIT") {
      const effectiveDate = requireString(amendmentInput.effectiveDate, "effectiveDate");
      const newProductCode = requireProductCode(amendmentInput.newProductCode, "newProductCode");
      const newInventoryUnitReference = requireString(amendmentInput.newInventoryUnitReference, "newInventoryUnitReference");
      const product = products[newProductCode];
      timeline = timeline.map((item) => item.serviceDate < effectiveDate ? item : {
        ...item,
        inventoryUnitId: newInventoryUnitReference,
        inventoryUnitKind: product.kind,
        inventoryProductCode: newProductCode
      });
      appendRevision("MOVE_UNIT");
      continue;
    }
    appendRevision("REPRICE_ORDER", requireInteger(amendmentInput.targetCurrentContractAmountMinor, "targetCurrentContractAmountMinor"));
  }

  const latest = revisions.at(-1)!;
  return {
    pricingRevisions: revisions,
    coverageSet: latest.coverageSet,
    cashLines: latest.cashLines,
    cashRemainderMinor: latest.cashRemainderMinor,
    currentContractAmountMinor: latest.currentContractAmountMinor
  };
}

export const pricingFactExecutors: PricingFactExecutorRegistry = Object.fromEntries(
  (["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING", "FREE"] as const)
    .map((plan) => [plan, executeConfirmedPricingFact])
);
