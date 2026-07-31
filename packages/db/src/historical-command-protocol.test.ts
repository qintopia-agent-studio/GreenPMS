import { describe, expect, it } from "vitest";
import { legacyEffectProtocol, legacyReceiptProtocol } from "./historical-command-protocol.ts";

const unit = (id: string) => ({
  id,
  propertyId: "property_1",
  kind: "ROOM",
  roomId: id,
  code: id,
  name: id,
  catalogVersion: null,
  buildingCode: null,
  roomTypeCode: null,
  pricingProductCode: null,
  inventoryBasis: null,
  codeProvenance: null,
  physicalBedCount: null
});

const pricing = {
  coverageSet: [],
  cashLines: [],
  cashRemainder: { currency: "CNY", minorUnits: 0 },
  currentContractAmount: { currency: "CNY", minorUnits: 0 }
};

const money = { currency: "CNY", minorUnits: 0 };
const before = {
  arrivalDate: "2026-07-30",
  departureDate: "2026-08-01",
  nights: 2,
  currentContractAmount: money
};
const after = {
  arrivalDate: "2026-07-30",
  departureDate: "2026-08-01",
  nights: 2,
  stayTimeline: [
    { serviceDate: "2026-07-30", inventoryUnitId: "room_1" },
    { serviceDate: "2026-07-31", inventoryUnitId: "room_1" }
  ],
  pricing
};
const shortenedAfter = {
  ...after,
  departureDate: "2026-07-31",
  nights: 1,
  stayTimeline: [{ serviceDate: "2026-07-30", inventoryUnitId: "room_1" }]
};
const shortenedInventoryChange = {
  preservedDates: ["2026-07-30"],
  releasedDates: ["2026-07-31"],
  addedDates: []
};
const pricingDecision = {
  pricingBasis: "POLICY",
  policyBaseAmount: money,
  targetCurrentContractAmount: money,
  differenceFromPolicy: money,
  manualAdjustmentMinor: 0,
  differenceExceedsThreshold: false,
  reason: { code: "POLICY_DEFAULT", note: "" }
};

describe("historical command protocol classification", () => {
  it("accepts the exact pre-Stage 11 MOVE effect and receipt only", () => {
    const effect = {
      orderId: "order_1",
      fromInventoryUnit: unit("room_1"),
      toInventoryUnit: unit("room_2"),
      effectiveDate: "2026-07-30",
      stayTimeline: [{ serviceDate: "2026-07-30", inventoryUnitId: "room_2" }],
      pricing
    };
    expect(legacyEffectProtocol("MOVE_UNIT", effect)).toBe("PRE_STAGE_11");
    expect(legacyEffectProtocol("MOVE_UNIT", { ...effect, unexpected: true })).toBeUndefined();
    expect(legacyEffectProtocol("MOVE_UNIT", { ...effect, pricing: { cashLines: [] } })).toBeUndefined();

    const receipt = {
      orderId: "order_1",
      amendmentId: "amendment_1",
      staySegmentId: "segment_1",
      pricingRevisionId: "revision_1"
    };
    expect(legacyReceiptProtocol("MOVE_UNIT", receipt)).toBe("PRE_STAGE_11");
    expect(legacyReceiptProtocol("MOVE_UNIT", { ...receipt, effectHash: "a".repeat(64) })).toBeUndefined();
  });

  it("does not classify incomplete legacy-looking stay changes", () => {
    expect(legacyEffectProtocol("RESCHEDULE_STAY", {
      operation: "RESCHEDULE_STAY",
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      before: {
        arrivalDate: "2026-07-30",
        departureDate: "2026-08-01",
        nights: 2,
        currentContractAmount: { currency: "CNY", minorUnits: 11_600 }
      },
      after: {},
      pricingDecision: {}
    })).toBeUndefined();
  });

  it("classifies only exact Stage 9 and Stage 10 Preview and Confirm receipt shapes", () => {
    const stayEffect = {
      operation: "RESCHEDULE_STAY",
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      before,
      after,
      pricingDecision,
      inventoryChange: { preservedDates: [], releasedDates: [], addedDates: [] },
      entitlementChange: {
        preservedCoverageDates: [], releasedCoverageDates: [], addedCoverageDates: [], consumedCoverageDates: []
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money }
    };
    const stayPreviewResult = {
      preview: {
        previewId: "preview_1",
        commandType: "RESCHEDULE_STAY",
        effectHash: "a".repeat(64),
        effect: stayEffect,
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    };
    const stayConfirmResult = {
      orderId: "order_1",
      stayId: "stay_1",
      amendmentId: "amendment_1",
      staySegmentId: "segment_1",
      pricingRevisionId: "revision_1",
      arrivalDate: after.arrivalDate,
      departureDate: after.departureDate,
      before,
      after,
      pricingDecision,
      inventoryChange: stayEffect.inventoryChange,
      entitlementChange: stayEffect.entitlementChange,
      fundsSummary: stayEffect.fundsSummary
    };
    expect(legacyReceiptProtocol("PREVIEW:RESCHEDULE_STAY", stayPreviewResult)).toBe("LEGACY_STAGE_9_10");
    expect(legacyReceiptProtocol("RESCHEDULE_STAY", stayConfirmResult)).toBe("LEGACY_STAGE_9_10");
    expect(legacyReceiptProtocol("RESCHEDULE_STAY", { ...stayConfirmResult, effectHash: "a".repeat(64) })).toBeUndefined();

    const shortenEffect = {
      operation: "SHORTEN_STAY",
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      businessDate: "2026-07-30",
      completionMode: "SHORTEN_IN_HOUSE",
      before,
      after: shortenedAfter,
      pricingDecision,
      inventoryChange: shortenedInventoryChange,
      entitlementSummary: {
        currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money, factCount: 0 },
      refundReferenceAmount: money
    };
    const shortenPreviewResult = {
      preview: {
        previewId: "preview_2",
        commandType: "SHORTEN_STAY",
        effectHash: "b".repeat(64),
        effect: shortenEffect,
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    };
    const shortenConfirmResult = {
      orderId: "order_1",
      stayId: "stay_1",
      arrangementAmendmentId: "amendment_2",
      checkoutAmendmentId: null as string | null,
      staySegmentId: "segment_2",
      pricingRevisionId: "revision_2",
      completionMode: "SHORTEN_IN_HOUSE",
      arrivalDate: shortenedAfter.arrivalDate,
      departureDate: shortenedAfter.departureDate,
      before,
      after: shortenedAfter,
      pricingDecision,
      inventoryChange: shortenEffect.inventoryChange,
      entitlementSummary: shortenEffect.entitlementSummary,
      fundsSummary: shortenEffect.fundsSummary,
      refundReferenceAmount: money,
      fulfillmentTiming: null as unknown
    };
    expect(legacyReceiptProtocol("PREVIEW:SHORTEN_STAY", shortenPreviewResult)).toBe("LEGACY_STAGE_10");
    expect(legacyReceiptProtocol("SHORTEN_STAY", shortenConfirmResult)).toBe("LEGACY_STAGE_10");
    expect(legacyReceiptProtocol("SHORTEN_STAY", { ...shortenConfirmResult, unexpected: true })).toBeUndefined();
  });

  it("accepts the exact Stage 10 early-checkout effect and receipt fulfillment timing", () => {
    const earlyCheckoutBefore = {
      ...before,
      departureDate: "2026-08-02",
      nights: 3
    };
    const earlyCheckoutEffect = {
      operation: "SHORTEN_STAY",
      orderId: "order_early_checkout",
      stayId: "stay_early_checkout",
      inventoryUnitId: "room_1",
      businessDate: after.departureDate,
      completionMode: "EARLY_CHECK_OUT",
      before: earlyCheckoutBefore,
      after,
      pricingDecision,
      inventoryChange: {
        preservedDates: ["2026-07-30", "2026-07-31"],
        releasedDates: ["2026-08-01"],
        addedDates: []
      },
      entitlementSummary: {
        currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money, factCount: 0 },
      refundReferenceAmount: money
    };
    expect(legacyEffectProtocol("SHORTEN_STAY", earlyCheckoutEffect)).toBe("LEGACY_STAGE_10");
    expect(legacyReceiptProtocol("PREVIEW:SHORTEN_STAY", {
      preview: {
        previewId: "preview_early_checkout",
        commandType: "SHORTEN_STAY",
        effectHash: "c".repeat(64),
        effect: earlyCheckoutEffect,
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    })).toBe("LEGACY_STAGE_10");

    const earlyCheckoutReceipt = {
      orderId: earlyCheckoutEffect.orderId,
      stayId: earlyCheckoutEffect.stayId,
      arrangementAmendmentId: "amendment_early_checkout",
      checkoutAmendmentId: "amendment_early_checkout_completion",
      staySegmentId: "segment_early_checkout",
      pricingRevisionId: "revision_early_checkout",
      completionMode: "EARLY_CHECK_OUT",
      arrivalDate: after.arrivalDate,
      departureDate: after.departureDate,
      before: earlyCheckoutBefore,
      after,
      pricingDecision,
      inventoryChange: earlyCheckoutEffect.inventoryChange,
      entitlementSummary: earlyCheckoutEffect.entitlementSummary,
      fundsSummary: earlyCheckoutEffect.fundsSummary,
      refundReferenceAmount: money,
      fulfillmentTiming: {
        effectiveDate: after.departureDate,
        recordedBusinessDate: after.departureDate,
        recordingMode: "ON_SCHEDULE"
      }
    };
    expect(legacyReceiptProtocol("SHORTEN_STAY", earlyCheckoutReceipt)).toBe("LEGACY_STAGE_10");
    expect(legacyReceiptProtocol("SHORTEN_STAY", {
      ...earlyCheckoutReceipt,
      checkoutAmendmentId: null
    }), "early checkout requires a checkout amendment").toBeUndefined();

    for (const [name, fulfillmentTiming] of [
      ["missing early-checkout timing", null],
      ["wrong effective date", { ...earlyCheckoutReceipt.fulfillmentTiming, effectiveDate: "2026-07-31" }],
      ["wrong recorded business date", { ...earlyCheckoutReceipt.fulfillmentTiming, recordedBusinessDate: "2026-07-31" }],
      ["wrong recording mode", { ...earlyCheckoutReceipt.fulfillmentTiming, recordingMode: "LATE_RECORDED" }],
      ["extra timing key", { ...earlyCheckoutReceipt.fulfillmentTiming, unexpected: true }]
    ] as const) {
      expect(legacyReceiptProtocol("SHORTEN_STAY", { ...earlyCheckoutReceipt, fulfillmentTiming }), name).toBeUndefined();
    }
  });

  it("fails closed unless a Stage 10 shortening preserves arrival and strictly reduces departure", () => {
    const baseEffect = {
      operation: "SHORTEN_STAY",
      orderId: "order_relationships",
      stayId: "stay_relationships",
      inventoryUnitId: "room_1",
      businessDate: "2026-07-30",
      completionMode: "SHORTEN_IN_HOUSE",
      before: {
        arrivalDate: "2026-07-30",
        departureDate: "2026-08-03",
        nights: 4,
        currentContractAmount: money
      },
      after,
      pricingDecision,
      inventoryChange: {
        preservedDates: ["2026-07-30", "2026-07-31"],
        releasedDates: ["2026-08-01", "2026-08-02"],
        addedDates: [] as string[]
      },
      entitlementSummary: {
        currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money, factCount: 0 },
      refundReferenceAmount: money
    };
    expect(legacyEffectProtocol("SHORTEN_STAY", baseEffect)).toBe("LEGACY_STAGE_10");

    const changedArrival = structuredClone(baseEffect);
    changedArrival.after = {
      ...changedArrival.after,
      arrivalDate: "2026-07-29",
      nights: 3,
      stayTimeline: [
        { serviceDate: "2026-07-29", inventoryUnitId: "room_1" },
        { serviceDate: "2026-07-30", inventoryUnitId: "room_1" },
        { serviceDate: "2026-07-31", inventoryUnitId: "room_1" }
      ]
    };
    changedArrival.inventoryChange = {
      preservedDates: ["2026-07-30", "2026-07-31"],
      releasedDates: ["2026-08-01", "2026-08-02"],
      addedDates: ["2026-07-29"]
    };
    expect(legacyEffectProtocol("SHORTEN_STAY", changedArrival), "arrival changed").toBeUndefined();

    for (const [name, departureDate, dates] of [
      ["departure unchanged", "2026-08-03", ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]],
      ["departure extended", "2026-08-04", ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"]]
    ] as const) {
      const candidate = structuredClone(baseEffect);
      candidate.after = {
        ...candidate.after,
        departureDate,
        nights: dates.length,
        stayTimeline: dates.map((serviceDate) => ({ serviceDate, inventoryUnitId: "room_1" }))
      };
      candidate.inventoryChange = {
        preservedDates: dates.filter((date) => date < baseEffect.before.departureDate),
        releasedDates: [],
        addedDates: dates.filter((date) => date >= baseEffect.before.departureDate)
      };
      expect(legacyEffectProtocol("SHORTEN_STAY", candidate), name).toBeUndefined();
    }
  });

  it("requires exact Stage 10 shortening inventory date sets", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_inventory_relationships",
      stayId: "stay_inventory_relationships",
      inventoryUnitId: "room_1",
      businessDate: "2026-07-30",
      completionMode: "SHORTEN_IN_HOUSE",
      before,
      after: shortenedAfter,
      pricingDecision,
      inventoryChange: shortenedInventoryChange,
      entitlementSummary: {
        currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money, factCount: 0 },
      refundReferenceAmount: money
    };
    expect(legacyEffectProtocol("SHORTEN_STAY", effect)).toBe("LEGACY_STAGE_10");
    for (const [name, inventoryChange] of [
      ["missing preserved date", { preservedDates: [], releasedDates: ["2026-07-31"], addedDates: [] }],
      ["wrong released date", { preservedDates: ["2026-07-30"], releasedDates: [], addedDates: [] }],
      ["invented added date", {
        preservedDates: ["2026-07-30"], releasedDates: ["2026-07-31"], addedDates: ["2026-08-01"]
      }]
    ] as const) {
      expect(legacyEffectProtocol("SHORTEN_STAY", { ...effect, inventoryChange }), name).toBeUndefined();
    }
  });

  it("enforces completion-mode dates for effects without inventing a business date for receipts", () => {
    const shared = {
      before,
      after: shortenedAfter,
      pricingDecision,
      inventoryChange: shortenedInventoryChange,
      entitlementSummary: {
        currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money, factCount: 0 },
      refundReferenceAmount: money
    };
    const inHouseEffect = {
      operation: "SHORTEN_STAY",
      orderId: "order_in_house_dates",
      stayId: "stay_in_house_dates",
      inventoryUnitId: "room_1",
      businessDate: "2026-07-30",
      completionMode: "SHORTEN_IN_HOUSE",
      ...shared
    };
    expect(legacyEffectProtocol("SHORTEN_STAY", inHouseEffect)).toBe("LEGACY_STAGE_10");
    expect(legacyEffectProtocol("SHORTEN_STAY", {
      ...inHouseEffect,
      businessDate: shortenedAfter.departureDate
    }), "in-house departure must be after business date").toBeUndefined();

    const earlyEffect = {
      ...inHouseEffect,
      completionMode: "EARLY_CHECK_OUT",
      businessDate: shortenedAfter.departureDate
    };
    expect(legacyEffectProtocol("SHORTEN_STAY", earlyEffect)).toBe("LEGACY_STAGE_10");
    expect(legacyEffectProtocol("SHORTEN_STAY", {
      ...earlyEffect,
      businessDate: "2026-07-30"
    }), "early checkout must end on business date").toBeUndefined();

    const historicalBefore = {
      arrivalDate: "1999-12-29",
      departureDate: "2000-01-02",
      nights: 4,
      currentContractAmount: money
    };
    const historicalAfter = {
      arrivalDate: "1999-12-29",
      departureDate: "1999-12-31",
      nights: 2,
      stayTimeline: [
        { serviceDate: "1999-12-29", inventoryUnitId: "room_1" },
        { serviceDate: "1999-12-30", inventoryUnitId: "room_1" }
      ],
      pricing
    };
    const historicalReceipt = {
      orderId: "order_historical_in_house",
      stayId: "stay_historical_in_house",
      arrangementAmendmentId: "amendment_historical_arrangement",
      checkoutAmendmentId: null,
      staySegmentId: "segment_historical",
      pricingRevisionId: "revision_historical",
      completionMode: "SHORTEN_IN_HOUSE",
      arrivalDate: historicalAfter.arrivalDate,
      departureDate: historicalAfter.departureDate,
      before: historicalBefore,
      after: historicalAfter,
      pricingDecision,
      inventoryChange: {
        preservedDates: ["1999-12-29", "1999-12-30"],
        releasedDates: ["1999-12-31", "2000-01-01"],
        addedDates: []
      },
      entitlementSummary: shared.entitlementSummary,
      fundsSummary: shared.fundsSummary,
      refundReferenceAmount: money,
      fulfillmentTiming: null
    };
    expect(legacyReceiptProtocol("SHORTEN_STAY", historicalReceipt)).toBe("LEGACY_STAGE_10");
    expect(legacyReceiptProtocol("SHORTEN_STAY", {
      ...historicalReceipt,
      checkoutAmendmentId: "amendment_not_allowed"
    }), "in-house shortening must not have checkout amendment").toBeUndefined();
    expect(legacyReceiptProtocol("SHORTEN_STAY", {
      ...historicalReceipt,
      inventoryChange: { ...historicalReceipt.inventoryChange, releasedDates: ["2000-01-01"] }
    }), "receipt inventory dates must be exact").toBeUndefined();
  });

  it("fails closed for malformed nested legacy effect and receipt values", () => {
    const richPricing = {
      coverageSet: [{
        serviceDate: "2026-07-30", inventoryUnitId: "room_1", unitKind: "ROOM_NIGHT", entitlementLotId: "lot_1"
      }],
      cashLines: [{
        lineKind: "NIGHT",
        serviceDate: "2026-07-31",
        inventoryUnitId: "room_1",
        description: "Nightly accommodation",
        amount: { currency: "CNY", minorUnits: 11_600 }
      }],
      cashRemainder: { currency: "CNY", minorUnits: 11_600 },
      currentContractAmount: { currency: "CNY", minorUnits: 11_600 }
    };
    const richEffect = {
      operation: "RESCHEDULE_STAY",
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      before,
      after: { ...after, pricing: richPricing },
      pricingDecision: {
        ...pricingDecision,
        policyBaseAmount: { currency: "CNY", minorUnits: 10_000 },
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 11_600 },
        differenceFromPolicy: { currency: "CNY", minorUnits: 1_600 },
        differenceExceedsThreshold: true,
        reason: { code: "STAY_CHANGE_POLICY", note: "政策重新计价" }
      },
      inventoryChange: { preservedDates: ["2026-07-30"], releasedDates: [], addedDates: ["2026-07-31"] },
      entitlementChange: {
        preservedCoverageDates: ["2026-07-30"], releasedCoverageDates: [], addedCoverageDates: [], consumedCoverageDates: []
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: 11_600 }
      }
    };
    expect(legacyEffectProtocol("RESCHEDULE_STAY", richEffect)).toBe("LEGACY_STAGE_9_10");

    const malformedEffects: Array<[string, (value: typeof richEffect) => void]> = [
      ["invalid nested local date", (value) => { value.after.stayTimeline[0]!.serviceDate = "2026-02-30"; }],
      ["extra timeline key", (value) => { Object.assign(value.after.stayTimeline[0]!, { extra: true }); }],
      ["empty order identifier", (value) => { value.orderId = " "; }],
      ["lower-case currency", (value) => { value.after.pricing.cashRemainder.currency = "cny"; }],
      ["unsafe cash amount", (value) => { value.after.pricing.cashLines[0]!.amount.minorUnits = 1.5; }],
      ["invalid coverage enum", (value) => { value.after.pricing.coverageSet[0]!.unitKind = "ROOM"; }],
      ["extra coverage key", (value) => { Object.assign(value.after.pricing.coverageSet[0]!, { extra: true }); }],
      ["empty cash description", (value) => { value.after.pricing.cashLines[0]!.description = " "; }],
      ["inconsistent pricing decision", (value) => { value.pricingDecision.differenceFromPolicy.minorUnits = 1; }],
      ["empty reason code", (value) => { value.pricingDecision.reason.code = ""; }],
      ["duplicated inventory date", (value) => { value.inventoryChange.addedDates = ["2026-07-31", "2026-07-31"]; }]
    ];
    for (const [name, mutate] of malformedEffects) {
      const candidate = structuredClone(richEffect);
      mutate(candidate);
      expect(legacyEffectProtocol("RESCHEDULE_STAY", candidate), name).toBeUndefined();
    }

    const stayTotalEffect = {
      orderId: "order_1",
      fromInventoryUnit: unit("room_1"),
      toInventoryUnit: { ...unit("room_2"), occupancyCapacity: 2 },
      effectiveDate: "2026-07-31",
      occupantCount: 1,
      occupancyCapacity: 2,
      stayTimeline: [
        { serviceDate: "2026-07-30", inventoryUnitId: "room_1" },
        { serviceDate: "2026-07-31", inventoryUnitId: "room_2" }
      ],
      pricing: {
        coverageSet: [],
        cashLines: [{
          lineKind: "STAY_TOTAL",
          arrivalDate: "2026-07-30",
          departureDate: "2026-08-01",
          inventoryUnitId: "room_1",
          description: "Accommodation total",
          pricingBandAnchorNights: 7,
          calculationSegments: [{
            inventoryUnitId: "room_1",
            pricingProductCode: "product_1",
            arrivalDate: "2026-07-30",
            departureDate: "2026-07-31",
            nights: 1,
            anchorAmountMinor: 81_200,
            numeratorMinor: 81_200,
            denominator: 7
          }, {
            inventoryUnitId: "room_2",
            pricingProductCode: "product_2",
            arrivalDate: "2026-07-31",
            departureDate: "2026-08-01",
            nights: 1,
            anchorAmountMinor: 81_200,
            numeratorMinor: 81_200,
            denominator: 7
          }],
          amount: { currency: "CNY", minorUnits: 23_200 }
        }],
        cashRemainder: { currency: "CNY", minorUnits: 23_200 },
        currentContractAmount: { currency: "CNY", minorUnits: 23_200 }
      }
    };
    expect(legacyEffectProtocol("MOVE_UNIT", stayTotalEffect)).toBe("PRE_STAGE_11");
    for (const [name, mutate] of [
      ["invalid inventory metadata", (value: typeof stayTotalEffect) => { value.toInventoryUnit.kind = "SUITE"; }],
      ["invalid capacity", (value: typeof stayTotalEffect) => { value.occupancyCapacity = 0; }],
      ["invalid duration denominator", (value: typeof stayTotalEffect) => { value.pricing.cashLines[0]!.calculationSegments[0]!.denominator = 14; }],
      ["extra stay-total key", (value: typeof stayTotalEffect) => { Object.assign(value.pricing.cashLines[0]!, { extra: true }); }],
      ["extra stay-total amount key", (value: typeof stayTotalEffect) => { Object.assign(value.pricing.cashLines[0]!.amount, { extra: true }); }],
      ["extra duration segment key", (value: typeof stayTotalEffect) => { Object.assign(value.pricing.cashLines[0]!.calculationSegments[0]!, { extra: true }); }],
      ["non-contiguous segment coverage", (value: typeof stayTotalEffect) => {
        value.pricing.cashLines[0]!.calculationSegments[1]!.arrivalDate = "2026-08-01";
        value.pricing.cashLines[0]!.calculationSegments[1]!.departureDate = "2026-08-02";
      }],
      ["incomplete segment coverage", (value: typeof stayTotalEffect) => { value.pricing.cashLines[0]!.calculationSegments.pop(); }],
      ["segment nights mismatch", (value: typeof stayTotalEffect) => { value.pricing.cashLines[0]!.calculationSegments[0]!.nights = 2; }],
      ["segment numerator mismatch", (value: typeof stayTotalEffect) => { value.pricing.cashLines[0]!.calculationSegments[0]!.numeratorMinor += 1; }],
      ["cash total is not the once-rounded segment sum", (value: typeof stayTotalEffect) => { value.pricing.cashLines[0]!.amount.minorUnits = 23_100; }],
      ["segment inventory differs from timeline", (value: typeof stayTotalEffect) => { value.pricing.cashLines[0]!.calculationSegments[1]!.inventoryUnitId = "room_1"; }]
    ] as const) {
      const candidate = structuredClone(stayTotalEffect);
      mutate(candidate);
      expect(legacyEffectProtocol("MOVE_UNIT", candidate), name).toBeUndefined();
    }

    const preview = {
      preview: {
        previewId: "preview_1",
        commandType: "RESCHEDULE_STAY",
        effectHash: "a".repeat(64),
        effect: richEffect,
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    };
    expect(legacyReceiptProtocol("PREVIEW:RESCHEDULE_STAY", preview)).toBe("LEGACY_STAGE_9_10");
    for (const [name, mutate] of [
      ["bad preview hash", (value: typeof preview) => { value.preview.effectHash = "A".repeat(64); }],
      ["bad preview timestamp", (value: typeof preview) => { value.preview.expiresAt = "2030-02-30T24:00:00Z"; }],
      ["extra preview key", (value: typeof preview) => { Object.assign(value.preview, { extra: true }); }]
    ] as const) {
      const candidate = structuredClone(preview);
      mutate(candidate);
      expect(legacyReceiptProtocol("PREVIEW:RESCHEDULE_STAY", candidate), name).toBeUndefined();
    }

    const shortenReceipt = {
      orderId: "order_1",
      stayId: "stay_1",
      arrangementAmendmentId: "amendment_1",
      checkoutAmendmentId: null as string | null,
      staySegmentId: "segment_1",
      pricingRevisionId: "revision_1",
      completionMode: "SHORTEN_IN_HOUSE",
      arrivalDate: "2026-07-30",
      departureDate: "2026-07-31",
      before,
      after: shortenedAfter,
      pricingDecision,
      inventoryChange: shortenedInventoryChange,
      entitlementSummary: {
        currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money, collectionDifference: money, factCount: 0 },
      refundReferenceAmount: money,
      fulfillmentTiming: null as unknown
    };
    expect(legacyReceiptProtocol("SHORTEN_STAY", shortenReceipt)).toBe("LEGACY_STAGE_10");
    for (const [name, mutate] of [
      ["empty checkout amendment ID", (value: typeof shortenReceipt) => { value.checkoutAmendmentId = ""; }],
      ["unknown fulfillment metadata", (value: typeof shortenReceipt) => { value.fulfillmentTiming = "now"; }],
      ["receipt date does not match payload", (value: typeof shortenReceipt) => { value.departureDate = "2026-08-02"; }]
    ] as const) {
      const candidate = structuredClone(shortenReceipt);
      mutate(candidate);
      expect(legacyReceiptProtocol("SHORTEN_STAY", candidate), name).toBeUndefined();
    }
  });
});
