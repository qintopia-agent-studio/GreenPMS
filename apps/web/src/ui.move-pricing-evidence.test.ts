import { describe, expect, it } from "vitest";
import { moveUnitPreviewHasEvidence } from "./ui.tsx";

const dates = ["02", "03", "04", "05", "06", "07", "08", "09"].map((day) => `2026-08-${day}`);

function unit(id: string, code: string, kind: "ROOM" | "BED", occupancyCapacity: number) {
  return {
    id,
    propertyId: "property_1",
    kind,
    roomId: kind === "ROOM" ? id : "room_2",
    code,
    name: `${code} 房源`,
    catalogVersion: "v1",
    buildingCode: "1",
    roomTypeCode: kind === "ROOM" ? "STANDARD" : "DORM4",
    pricingProductCode: kind === "ROOM" ? "ROOM-2" : "BED-1",
    inventoryBasis: kind === "ROOM" ? "INDEPENDENT" : "WHOLE_ROOM_COMBINATION",
    codeProvenance: "SOURCE_EXPLICIT",
    physicalBedCount: kind === "ROOM" ? 2 : null,
    occupancyCapacity
  };
}

function validStayTotalMove() {
  const beforeTimeline = dates.map((serviceDate) => ({ serviceDate, inventoryUnitId: "room_1" }));
  const afterTimeline = dates.map((serviceDate, index) => ({
    serviceDate,
    inventoryUnitId: index < 4 ? "room_1" : "bed_1"
  }));
  return {
    operation: "MOVE_UNIT",
    orderId: "order_1",
    stayId: "stay_1",
    businessDate: "2026-08-01",
    toInventoryUnit: unit("bed_1", "202-A", "BED", 1),
    effectiveDate: "2026-08-06",
    occupantCount: 1,
    occupancyCapacity: 1,
    before: {
      arrivalDate: "2026-08-02",
      departureDate: "2026-08-10",
      nights: 8,
      currentContractAmount: { currency: "CNY", minorUnits: 80_000 },
      stayTimeline: beforeTimeline,
      actualCurrentInventoryUnit: null,
      effectiveDateInventoryUnit: unit("room_1", "101", "ROOM", 2)
    },
    after: {
      arrivalDate: "2026-08-02",
      departureDate: "2026-08-10",
      nights: 8,
      stayTimeline: afterTimeline,
      pricing: {
        coverageSet: [],
        cashLines: [{
          lineKind: "STAY_TOTAL",
          arrivalDate: "2026-08-02",
          departureDate: "2026-08-10",
          inventoryUnitId: "room_1",
          description: "Accommodation total from locked duration band",
          pricingBandAnchorNights: 7,
          calculationSegments: [{
            inventoryUnitId: "room_1",
            pricingProductCode: "ROOM-2",
            arrivalDate: "2026-08-02",
            departureDate: "2026-08-06",
            nights: 4,
            anchorAmountMinor: 81_200,
            numeratorMinor: 324_800,
            denominator: 7
          }, {
            inventoryUnitId: "bed_1",
            pricingProductCode: "BED-1",
            arrivalDate: "2026-08-06",
            departureDate: "2026-08-10",
            nights: 4,
            anchorAmountMinor: 48_050,
            numeratorMinor: 192_200,
            denominator: 7
          }],
          amount: { currency: "CNY", minorUnits: 73_900 }
        }],
        cashRemainder: { currency: "CNY", minorUnits: 73_900 },
        currentContractAmount: { currency: "CNY", minorUnits: 73_900 }
      }
    },
    pricingDecision: {
      pricingBasis: "POLICY",
      policyBaseAmount: { currency: "CNY", minorUnits: 73_900 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 73_900 },
      differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: { code: "MOVE_UNIT_POLICY", note: "" }
    },
    inventoryChange: {
      preservedClaims: beforeTimeline.slice(0, 4),
      releasedClaims: beforeTimeline.slice(4),
      addedClaims: afterTimeline.slice(4)
    },
    entitlementSummary: {
      preservedCoverageDates: [],
      migratedHeldCoverageDates: [],
      consumedCoverageDates: [],
      convertedMembershipCoveragePreserved: false,
      ledgerWriteCount: 0
    },
    fundsSummary: {
      netRecordedCollection: { currency: "CNY", minorUnits: 0 },
      collectionDifference: { currency: "CNY", minorUnits: 73_900 },
      factCount: 0
    }
  };
}

type MoveEffect = ReturnType<typeof validStayTotalMove>;

function stayTotalLine(effect: MoveEffect) {
  return effect.after.pricing.cashLines[0]!;
}

function useNightlyCashLines(effect: MoveEffect, amounts: readonly number[]) {
  expect(amounts).toHaveLength(effect.after.stayTimeline.length);
  effect.after.pricing.cashLines = effect.after.stayTimeline.map((item, index) => ({
    lineKind: "NIGHT" as const,
    serviceDate: item.serviceDate,
    inventoryUnitId: item.inventoryUnitId,
    description: "Nightly accommodation",
    amount: { currency: "CNY", minorUnits: amounts[index]! }
  })) as unknown as typeof effect.after.pricing.cashLines;
}

function validMemberMove() {
  const effect = validStayTotalMove();
  effect.toInventoryUnit = unit("room_2", "102", "ROOM", 2);
  effect.occupancyCapacity = 2;
  effect.after.stayTimeline = dates.map((serviceDate, index) => ({
    serviceDate,
    inventoryUnitId: index < 4 ? "room_1" : "room_2"
  }));
  effect.inventoryChange.addedClaims = effect.after.stayTimeline.slice(4);
  effect.before.currentContractAmount.minorUnits = 0;
  effect.after.pricing.coverageSet = effect.after.stayTimeline.map((item) => ({
    serviceDate: item.serviceDate,
    inventoryUnitId: item.inventoryUnitId,
    unitKind: "ROOM_NIGHT",
    entitlementLotId: "lot_1"
  })) as unknown as typeof effect.after.pricing.coverageSet;
  effect.after.pricing.cashLines = [];
  effect.after.pricing.cashRemainder.minorUnits = 0;
  effect.after.pricing.currentContractAmount.minorUnits = 0;
  effect.pricingDecision = {
    ...effect.pricingDecision,
    pricingBasis: "MEMBER_ENTITLEMENT",
    policyBaseAmount: { currency: "CNY", minorUnits: 0 },
    targetCurrentContractAmount: { currency: "CNY", minorUnits: 0 },
    reason: { code: "MOVE_UNIT_MEMBER", note: "" }
  } as typeof effect.pricingDecision;
  effect.entitlementSummary = {
    preservedCoverageDates: dates.slice(0, 4),
    migratedHeldCoverageDates: dates.slice(4),
    consumedCoverageDates: [],
    convertedMembershipCoveragePreserved: false,
    ledgerWriteCount: 8
  } as unknown as typeof effect.entitlementSummary;
  effect.fundsSummary.collectionDifference.minorUnits = 0;
  return effect;
}

function validFreeMove() {
  const effect = validStayTotalMove();
  effect.before.currentContractAmount.minorUnits = 0;
  useNightlyCashLines(effect, dates.map(() => 0));
  effect.after.pricing.cashRemainder.minorUnits = 0;
  effect.after.pricing.currentContractAmount.minorUnits = 0;
  effect.pricingDecision = {
    ...effect.pricingDecision,
    pricingBasis: "FREE",
    policyBaseAmount: { currency: "CNY", minorUnits: 0 },
    targetCurrentContractAmount: { currency: "CNY", minorUnits: 0 },
    reason: { code: "MOVE_UNIT_FREE", note: "" }
  } as typeof effect.pricingDecision;
  effect.fundsSummary.collectionDifference.minorUnits = 0;
  return effect;
}

const input = {
  propertyId: "property_1",
  orderId: "order_1",
  newInventoryUnitId: "bed_1",
  effectiveDate: "2026-08-06"
};

const memberInput = {
  ...input,
  newInventoryUnitId: "room_2"
};

const corruptions: Array<[string, (effect: MoveEffect) => void]> = [
  ["extra cash-line key", (effect) => { Object.assign(stayTotalLine(effect), { rawTotal: 73_900 }); }],
  ["extra cash-line amount key", (effect) => { Object.assign(stayTotalLine(effect).amount, { scale: 2 }); }],
  ["extra segment key", (effect) => { Object.assign(stayTotalLine(effect).calculationSegments[0]!, { rawRate: 812 }); }],
  ["non-contiguous segment coverage", (effect) => {
    stayTotalLine(effect).calculationSegments[1]!.arrivalDate = "2026-08-07";
    stayTotalLine(effect).calculationSegments[1]!.departureDate = "2026-08-11";
  }],
  ["incomplete segment coverage", (effect) => { stayTotalLine(effect).calculationSegments.pop(); }],
  ["segment nights mismatch", (effect) => { stayTotalLine(effect).calculationSegments[0]!.nights = 3; }],
  ["segment numerator mismatch", (effect) => { stayTotalLine(effect).calculationSegments[0]!.numeratorMinor += 1; }],
  ["segment denominator differs from the selected band", (effect) => { stayTotalLine(effect).calculationSegments[0]!.denominator = 14; }],
  ["cash-line amount is not the once-rounded exact sum", (effect) => { stayTotalLine(effect).amount.minorUnits = 73_800; }],
  ["segment inventory does not match the stay timeline", (effect) => { stayTotalLine(effect).calculationSegments[1]!.inventoryUnitId = "room_1"; }]
];

describe("MOVE_UNIT stay-total pricing evidence", () => {
  it("accepts exact contiguous segments and one final positive half-up rounding", () => {
    expect(moveUnitPreviewHasEvidence(validStayTotalMove(), input)).toBe(true);
  });

  it.each(corruptions)("rejects %s", (_name, mutate) => {
    const effect = validStayTotalMove();
    mutate(effect);
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(false);
  });

  it("continues accepting structurally valid nightly pricing evidence", () => {
    const effect = validStayTotalMove();
    useNightlyCashLines(effect, [9_200, 9_200, 9_200, 9_200, 9_200, 9_200, 9_200, 9_500]);
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(true);
  });

  it("rejects empty paid cash lines", () => {
    const effect = validStayTotalMove();
    effect.after.pricing.cashLines = [];
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(false);
  });

  it("rejects incomplete paid NIGHT coverage", () => {
    const effect = validStayTotalMove();
    useNightlyCashLines(effect, [9_200, 9_200, 9_200, 9_200, 9_200, 9_200, 9_200, 9_500]);
    effect.after.pricing.cashLines.pop();
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(false);
  });

  it("rejects duplicate paid NIGHT dates even when each row matches that date's unit", () => {
    const effect = validStayTotalMove();
    useNightlyCashLines(effect, [9_200, 9_200, 9_200, 9_200, 9_200, 9_200, 9_200, 9_500]);
    const duplicate = effect.after.pricing.cashLines.at(-1)! as unknown as {
      serviceDate: string;
      inventoryUnitId: string;
    };
    duplicate.serviceDate = dates[0]!;
    duplicate.inventoryUnitId = "room_1";
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(false);
  });

  it("rejects eight valid 90-yuan NIGHT rows when policy authority is 739 yuan", () => {
    const effect = validStayTotalMove();
    useNightlyCashLines(effect, dates.map(() => 9_000));
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(false);
  });

  it("retains valid fully covered member evidence with no cash lines", () => {
    expect(moveUnitPreviewHasEvidence(validMemberMove(), memberInput)).toBe(true);
  });

  it("preserves converted membership coverage without a synthetic held migration or ledger write", () => {
    const effect = validMemberMove();
    effect.entitlementSummary = {
      preservedCoverageDates: [],
      migratedHeldCoverageDates: [],
      consumedCoverageDates: dates,
      convertedMembershipCoveragePreserved: true,
      ledgerWriteCount: 0
    } as unknown as typeof effect.entitlementSummary;
    expect(moveUnitPreviewHasEvidence(effect, memberInput)).toBe(true);

    effect.entitlementSummary.convertedMembershipCoveragePreserved = false;
    expect(moveUnitPreviewHasEvidence(effect, memberInput)).toBe(false);
  });

  it("retains a consumed member coverage's historical room ID", () => {
    const effect = validMemberMove();
    const coverage = effect.after.pricing.coverageSet as unknown as Array<{
      serviceDate: string;
      inventoryUnitId: string;
      unitKind: string;
    }>;
    coverage[4]!.inventoryUnitId = "room_1";
    effect.entitlementSummary = {
      preservedCoverageDates: dates.slice(0, 4),
      migratedHeldCoverageDates: dates.slice(5),
      consumedCoverageDates: [dates[4]!],
      convertedMembershipCoveragePreserved: false,
      ledgerWriteCount: 6
    } as unknown as typeof effect.entitlementSummary;
    expect(moveUnitPreviewHasEvidence(effect, memberInput)).toBe(true);
  });

  it("rejects a member move from a ROOM to a BED even when coverage claims ROOM_NIGHT", () => {
    const effect = validMemberMove();
    effect.toInventoryUnit = unit("bed_1", "202-A", "BED", 1);
    effect.occupancyCapacity = 1;
    effect.after.stayTimeline = dates.map((serviceDate, index) => ({
      serviceDate,
      inventoryUnitId: index < 4 ? "room_1" : "bed_1"
    }));
    effect.inventoryChange.addedClaims = effect.after.stayTimeline.slice(4);
    const coverage = effect.after.pricing.coverageSet as unknown as Array<{
      inventoryUnitId: string;
    }>;
    for (const item of coverage.slice(4)) item.inventoryUnitId = "bed_1";
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(false);
  });

  it("rejects mixed ROOM_NIGHT and BED_NIGHT member coverage", () => {
    const effect = validMemberMove();
    const coverage = effect.after.pricing.coverageSet as unknown as Array<{
      unitKind: string;
    }>;
    coverage.at(-1)!.unitKind = "BED_NIGHT";
    expect(moveUnitPreviewHasEvidence(effect, memberInput)).toBe(false);
  });

  it("retains valid free evidence with zero nightly cash lines", () => {
    expect(moveUnitPreviewHasEvidence(validFreeMove(), input)).toBe(true);
  });
});
