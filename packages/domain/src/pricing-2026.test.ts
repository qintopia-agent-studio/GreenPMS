import { describe, expect, it } from "vitest";
import { DomainError, type InventoryUnitKind, type StayType } from "@qintopia/contracts";
import {
  calculateDurationBandTotalMinor,
  calculateDurationTimelinePricing,
  calculatePricing,
  durationBandAnchorNights,
  isTransientDuration,
  manualRefundAmountFromRecordedFacts,
  roundPositiveRationalHalfUp,
  type DurationBandAnchors,
  type PricingPolicy,
  type PricingTimelineItem
} from "./pricing.ts";

const propertyId = "10000000-0000-4000-8000-000000000001";
const policyId = "policy_qintopia_public_2026_rev561_v1";

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

const policy: PricingPolicy = {
  id: policyId,
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

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function quote(productCode: ProductCode, nights: number, options: { arrivalDate?: string; stayType?: StayType } = {}) {
  const arrivalDate = options.arrivalDate ?? "2026-03-01";
  const product = products[productCode];
  return calculatePricing({
    propertyId,
    inventoryUnitId: `unit-${productCode}`,
    inventoryUnitKind: product.kind,
    inventoryProductCode: productCode,
    arrivalDate,
    departureDate: addDays(arrivalDate, nights),
    stayType: options.stayType ?? (nights < 7 ? "TRANSIENT" : "CUSTOM"),
    policy
  });
}

function timeline(arrivalDate: string, segments: Array<{
  nights: number;
  unitId: string;
  productCode: ProductCode;
}>): { departureDate: string; items: PricingTimelineItem[] } {
  const items: PricingTimelineItem[] = [];
  let serviceDate = arrivalDate;
  for (const segment of segments) {
    const product = products[segment.productCode];
    for (let night = 0; night < segment.nights; night += 1) {
      items.push({
        serviceDate,
        inventoryUnitId: segment.unitId,
        inventoryUnitKind: product.kind,
        inventoryProductCode: segment.productCode
      });
      serviceDate = addDays(serviceDate, 1);
    }
  }
  return { departureDate: serviceDate, items };
}

const goldNights = [1, 6, 7, 13, 14, 29, 30, 31] as const;
const goldAmounts: Record<ProductCode, readonly number[]> = {
  shared_bath_quad_bed: [5_800, 34_800, 30_800, 57_200, 48_000, 99_400, 78_000, 80_600],
  shared_bath_double_bed: [6_800, 40_800, 38_000, 70_600, 55_000, 113_900, 90_000, 93_000],
  shared_bath_single_room: [13_000, 78_000, 59_000, 109_600, 82_000, 169_900, 135_000, 139_500],
  shared_bath_standard_room: [18_000, 108_000, 79_000, 146_700, 120_000, 248_600, 195_000, 201_500],
  private_bath_single_room: [17_000, 102_000, 72_000, 133_700, 119_000, 246_500, 180_000, 186_000],
  private_bath_standard_room: [24_000, 144_000, 102_000, 189_400, 168_000, 348_000, 258_000, 266_600],
  private_bath_king_room: [24_000, 144_000, 102_000, 189_400, 168_000, 348_000, 258_000, 266_600],
  private_bath_suite_room: [32_000, 192_000, 128_000, 237_700, 188_000, 389_400, 320_000, 330_700],
  shared_bath_double_whole_room: [13_600, 81_600, 76_000, 141_100, 110_000, 227_900, 180_000, 186_000],
  shared_bath_quad_whole_room: [23_200, 139_200, 123_200, 228_800, 192_000, 397_700, 312_000, 322_400]
};

describe("QinTopia 2026 published-price goldens", () => {
  it.each(Object.entries(goldAmounts).flatMap(([productCode, amounts]) =>
    goldNights.map((nights, index) => ({
      productCode: productCode as ProductCode,
      nights,
      expectedMinor: amounts[index]!
    }))))("prices $productCode for $nights nights", ({ productCode, nights, expectedMinor }) => {
      const result = quote(productCode, nights);
      expect(result.currentContractAmount).toEqual({ currency: "CNY", minorUnits: expectedMinor });
      expect(result.cashRemainder).toEqual(result.currentContractAmount);
      expect(result.cashLines).toHaveLength(1);
    });

  it("classifies 6 nights as transient and 7 nights in the next duration band", () => {
    expect(isTransientDuration(6)).toBe(true);
    expect(isTransientDuration(7)).toBe(false);
    expect(durationBandAnchorNights(6)).toBe(1);
    expect(durationBandAnchorNights(7)).toBe(7);
  });

  it("rounds the complete amount half-up to whole yuan and never uses banker's rounding", () => {
    expect(roundPositiveRationalHalfUp(100_50n, 100n)).toBe(101n);
    expect(calculateDurationBandTotalMinor(1, { 1: 10_050, 7: 70_350, 14: 140_700, 30: 301_500 }).roundedMinor).toBe(10_100);
  });

  it("enforces the 2026-02-25 open-ended effective interval", () => {
    expect(() => quote("shared_bath_quad_bed", 1, { arrivalDate: "2026-02-24" })).toThrow(
      expect.objectContaining<Partial<DomainError>>({ code: "PRICING_POLICY_UNCONFIGURED" })
    );
    expect(quote("shared_bath_quad_bed", 1, { arrivalDate: "2026-02-25" }).currentContractAmount.minorUnits).toBe(5_800);
  });

  it("multiplies dorm anchors before final rounding", () => {
    expect(quote("shared_bath_double_whole_room", 13).currentContractAmount.minorUnits).toBe(141_100);
    expect(quote("shared_bath_double_bed", 13).currentContractAmount.minorUnits * 2).toBe(141_200);
    expect(quote("shared_bath_quad_whole_room", 29).currentContractAmount.minorUnits).toBe(397_700);
    expect(quote("shared_bath_quad_bed", 29).currentContractAmount.minorUnits * 4).toBe(397_600);
  });

  it.each([
    { before: 6, after: 7, beforeMinor: 40_800, afterMinor: 38_000 },
    { before: 13, after: 14, beforeMinor: 70_600, afterMinor: 55_000 },
    { before: 29, after: 30, beforeMinor: 113_900, afterMinor: 90_000 }
  ])("reselects the cumulative band across $before to $after nights and accepts inversion", ({ before, after, beforeMinor, afterMinor }) => {
    expect(quote("shared_bath_double_bed", before).currentContractAmount.minorUnits).toBe(beforeMinor);
    expect(quote("shared_bath_double_bed", after).currentContractAmount.minorUnits).toBe(afterMinor);
    expect(afterMinor).toBeLessThan(beforeMinor);
  });

  it("shortening reprices the full shortened interval with the locked policy", () => {
    const original = quote("private_bath_suite_room", 31);
    const shortened = quote("private_bath_suite_room", 6);
    expect(original.currentContractAmount.minorUnits).toBe(330_700);
    expect(shortened.currentContractAmount.minorUnits).toBe(192_000);
    expect(policy.id).toBe(policyId);
  });

  it("does not split a continuous stay at a calendar-month boundary", () => {
    const crossMonth = quote("shared_bath_standard_room", 14, { arrivalDate: "2026-03-25" });
    const sameMonth = quote("shared_bath_standard_room", 14, { arrivalDate: "2026-04-02" });
    expect(crossMonth.currentContractAmount.minorUnits).toBe(120_000);
    expect(crossMonth.currentContractAmount).toEqual(sameMonth.currentContractAmount);
  });
});

describe("continuous-stay and move pricing", () => {
  it("keeps a same-price-product move amount-neutral and rounds only once", () => {
    const moved = timeline("2026-03-01", [
      { nights: 1, unitId: "room-standard", productCode: "private_bath_standard_room" },
      { nights: 12, unitId: "room-king", productCode: "private_bath_king_room" }
    ]);
    const result = calculateDurationTimelinePricing({
      propertyId,
      arrivalDate: "2026-03-01",
      departureDate: moved.departureDate,
      stayType: "CUSTOM",
      policy,
      timeline: moved.items
    });
    expect(result.currentContractAmount.minorUnits).toBe(189_400);
    expect(result.currentContractAmount).toEqual(quote("private_bath_standard_room", 13).currentContractAmount);
    expect(result.cashLines[0]).toMatchObject({ lineKind: "STAY_TOTAL", pricingBandAnchorNights: 7 });
  });

  it("uses one cumulative band for a cross-product move", () => {
    const moved = timeline("2026-03-01", [
      { nights: 7, unitId: "bed-104-A", productCode: "shared_bath_double_bed" },
      { nights: 7, unitId: "room-201", productCode: "shared_bath_single_room" }
    ]);
    const result = calculateDurationTimelinePricing({
      propertyId,
      arrivalDate: "2026-03-01",
      departureDate: moved.departureDate,
      stayType: "CUSTOM",
      policy,
      timeline: moved.items
    });
    expect(result.currentContractAmount.minorUnits).toBe(68_500);
    expect(result.cashLines[0]).toMatchObject({ lineKind: "STAY_TOTAL", pricingBandAnchorNights: 14 });
  });

  it("sums exact segment amounts and rounds the complete stay once", () => {
    const moved = timeline("2026-03-01", [
      { nights: 1, unitId: "bed-104-A", productCode: "shared_bath_double_bed" },
      { nights: 12, unitId: "room-201", productCode: "shared_bath_single_room" }
    ]);
    const result = calculateDurationTimelinePricing({
      propertyId,
      arrivalDate: "2026-03-01",
      departureDate: moved.departureDate,
      stayType: "CUSTOM",
      policy,
      timeline: moved.items
    });
    expect(result.currentContractAmount.minorUnits).toBe(106_600);
    expect(result.currentContractAmount.minorUnits).not.toBe(106_500);
  });

  it("supports a bed-to-whole-room product move without changing the cumulative band", () => {
    const moved = timeline("2026-03-01", [
      { nights: 6, unitId: "bed-104-A", productCode: "shared_bath_double_bed" },
      { nights: 7, unitId: "room-combo-104", productCode: "shared_bath_double_whole_room" }
    ]);
    const result = calculateDurationTimelinePricing({
      propertyId,
      arrivalDate: "2026-03-01",
      departureDate: moved.departureDate,
      stayType: "CUSTOM",
      policy,
      timeline: moved.items
    });
    expect(result.currentContractAmount.minorUnits).toBe(108_600);
    expect(result.cashLines[0]).toMatchObject({ lineKind: "STAY_TOTAL", pricingBandAnchorNights: 7 });
  });

  it("keeps a same-day segment boundary inside one Stay continuous", () => {
    const seamless = timeline("2026-03-01", [
      { nights: 3, unitId: "bed-104-A", productCode: "shared_bath_double_bed" },
      { nights: 4, unitId: "bed-106-A", productCode: "shared_bath_double_bed" }
    ]);
    const result = calculateDurationTimelinePricing({
      propertyId,
      arrivalDate: "2026-03-01",
      departureDate: seamless.departureDate,
      stayType: "CUSTOM",
      policy,
      timeline: seamless.items
    });
    expect(result.currentContractAmount.minorUnits).toBe(38_000);
  });

  it("prices two independent stays separately when at least one service date is uncovered", () => {
    const firstStay = quote("shared_bath_double_bed", 3, { arrivalDate: "2026-03-01" });
    const secondStay = quote("shared_bath_double_bed", 4, { arrivalDate: "2026-03-05" });
    const separateTotal = firstStay.currentContractAmount.minorUnits + secondStay.currentContractAmount.minorUnits;
    expect(separateTotal).toBe(47_600);
    expect(separateTotal).not.toBe(quote("shared_bath_double_bed", 7, { arrivalDate: "2026-03-01" }).currentContractAmount.minorUnits);
  });
});

describe("membership, free-stay, and recorded-money boundaries", () => {
  it("uses P1 for every date when a selected member has zero available coverage", () => {
    const arrivalDate = "2026-03-01";
    const result = calculatePricing({
      propertyId,
      inventoryUnitId: "bed-104-A",
      inventoryUnitKind: "BED",
      inventoryProductCode: "shared_bath_double_bed",
      arrivalDate,
      departureDate: addDays(arrivalDate, 10),
      stayType: "CUSTOM",
      policy,
      memberCoverage: true,
      coverageCandidates: []
    });
    expect(result.coverageSet).toEqual([]);
    expect(result.cashLines).toHaveLength(10);
    expect(result.currentContractAmount.minorUnits).toBe(68_000);
    expect(result.currentContractAmount.minorUnits).not.toBe(54_300);
  });

  it("prices uncovered member dates at P1 even when their count reaches a duration anchor", () => {
    const arrivalDate = "2026-03-01";
    const result = calculatePricing({
      propertyId,
      inventoryUnitId: "bed-104-A",
      inventoryUnitKind: "BED",
      inventoryProductCode: "shared_bath_double_bed",
      arrivalDate,
      departureDate: addDays(arrivalDate, 10),
      stayType: "CUSTOM",
      policy,
      memberCoverage: true,
      coverageCandidates: [0, 1, 2].map((offset) => ({
        serviceDate: addDays(arrivalDate, offset),
        entitlementLotId: `lot-${offset}`
      }))
    });
    expect(result.coverageSet.map((item) => item.serviceDate)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(result.cashLines).toHaveLength(7);
    expect(result.currentContractAmount.minorUnits).toBe(47_600);
    expect(result.currentContractAmount.minorUnits).not.toBe(38_000);
  });

  it("lets a later entitlement lot reduce the uncovered cash remainder without double coverage", () => {
    const arrivalDate = "2026-03-01";
    const input = {
      propertyId,
      inventoryUnitId: "room-201",
      inventoryUnitKind: "ROOM" as const,
      inventoryProductCode: "shared_bath_single_room",
      arrivalDate,
      departureDate: addDays(arrivalDate, 5),
      stayType: "CUSTOM" as const,
      policy,
      memberCoverage: true
    };
    const partial = calculatePricing({
      ...input,
      coverageCandidates: [0, 1].map((offset) => ({ serviceDate: addDays(arrivalDate, offset), entitlementLotId: "lot-original" }))
    });
    const toppedUp = calculatePricing({
      ...input,
      coverageCandidates: [0, 1, 2, 3, 4].map((offset) => ({
        serviceDate: addDays(arrivalDate, offset),
        entitlementLotId: offset < 2 ? "lot-original" : "lot-top-up"
      }))
    });
    expect(partial.currentContractAmount.minorUnits).toBe(39_000);
    expect(toppedUp.currentContractAmount.minorUnits).toBe(0);
    expect(new Set(toppedUp.coverageSet.map((item) => item.serviceDate)).size).toBe(5);
  });

  it("rejects duplicate coverage for the same service date", () => {
    expect(() => calculatePricing({
      propertyId,
      inventoryUnitId: "room-201",
      inventoryUnitKind: "ROOM",
      inventoryProductCode: "shared_bath_single_room",
      arrivalDate: "2026-03-01",
      departureDate: "2026-03-03",
      stayType: "CUSTOM",
      policy,
      coverageCandidates: [
        { serviceDate: "2026-03-01", entitlementLotId: "lot-a" },
        { serviceDate: "2026-03-01", entitlementLotId: "lot-b" }
      ]
    })).toThrow(expect.objectContaining<Partial<DomainError>>({ code: "ENTITLEMENT_CONFLICT" }));
  });

  it("keeps free stays at zero across a calendar month and never forms entitlement coverage", () => {
    const freePolicy: PricingPolicy = {
      id: "policy-free-v1",
      stayType: "FREE",
      calculationKind: "FREE",
      nightlyRateMinor: 0,
      currency: "CNY"
    };
    const input = {
      propertyId,
      inventoryUnitId: "room-201",
      inventoryUnitKind: "ROOM" as const,
      arrivalDate: "2026-03-30",
      departureDate: "2026-04-03",
      stayType: "FREE" as const,
      policy: freePolicy
    };
    const result = calculatePricing(input);
    expect(result.coverageSet).toEqual([]);
    expect(result.currentContractAmount.minorUnits).toBe(0);
    expect(result.cashLines.every((line) => line.amount.minorUnits === 0)).toBe(true);
    expect(() => calculatePricing({ ...input, memberCoverage: true, coverageCandidates: [] }))
      .toThrow(expect.objectContaining<Partial<DomainError>>({ code: "ENTITLEMENT_CONFLICT" }));
  });

  it("contains no electricity fee or electricity line item", () => {
    const result = quote("private_bath_suite_room", 31);
    expect(result.cashLines).toHaveLength(1);
    expect(JSON.stringify(result.cashLines).toLowerCase()).not.toContain("electric");
    expect(JSON.stringify(result.cashLines)).not.toContain("电费");
  });

  it("offers a manual refund amount only for positive recorded overcollection", () => {
    expect(manualRefundAmountFromRecordedFacts(100_000, 125_000)).toBe(25_000);
    expect(manualRefundAmountFromRecordedFacts(125_000, 100_000)).toBe(0);
    expect(manualRefundAmountFromRecordedFacts(100_000, 100_000)).toBe(0);
  });

  it("preserves policy base while applying an explicit whole-yuan final target to one revision", () => {
    const policyBase = quote("private_bath_standard_room", 13);
    const target = calculatePricing({
      propertyId,
      inventoryUnitId: "room-A01",
      inventoryUnitKind: "ROOM",
      inventoryProductCode: "private_bath_standard_room",
      arrivalDate: "2026-03-01",
      departureDate: "2026-03-14",
      stayType: "ROLLING",
      policy,
      manualAdjustmentMinor: 10_600
    });
    expect(policyBase.currentContractAmount.minorUnits).toBe(189_400);
    expect(target.cashRemainder.minorUnits).toBe(189_400);
    expect(target.currentContractAmount.minorUnits).toBe(200_000);
    expect(target.currentContractAmount.minorUnits - target.cashRemainder.minorUnits).toBe(10_600);
    expect(quote("private_bath_standard_room", 13).currentContractAmount.minorUnits).toBe(189_400);
  });

  it("preserves rounded policy base while allowing manual cents and rejecting negative targets", () => {
    const input = {
      propertyId,
      inventoryUnitId: "room-A01",
      inventoryUnitKind: "ROOM" as const,
      inventoryProductCode: "private_bath_standard_room",
      arrivalDate: "2026-03-01",
      departureDate: "2026-03-14",
      stayType: "ROLLING" as const,
      policy
    };
    expect(() => calculatePricing({ ...input, manualAdjustmentMinor: -189_500 }))
      .toThrow(expect.objectContaining<Partial<DomainError>>({ code: "VALIDATION_ERROR" }));
    expect(calculatePricing({ ...input, manualAdjustmentMinor: 1 }).currentContractAmount.minorUnits).toBe(189_401);
    expect(calculatePricing({ ...input, manualAdjustmentMinor: 38_750 - 189_400 }).currentContractAmount.minorUnits).toBe(38_750);
  });
});
