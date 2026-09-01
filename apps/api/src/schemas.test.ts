import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CommandEnvelopeSchema,
  CommandEffectSchema,
  CompleteStayResultSchema,
  ExecutedCommandResultSchema,
  HistoricalReceiptReadSchema,
  HistoricalStoredPreviewResponseSchema,
  OrdersListResponseSchema,
  ReceiptSchema,
  RoomStatusIntervalSchema,
  RoomStatusOperationalTaskSchema
} from "./schemas.ts";

FormatRegistry.Set("date-time", (value) => typeof value === "string" && Number.isFinite(Date.parse(value)));

const protocolMoney = { currency: "CNY", minorUnits: 0 };
const protocolTimeline = [
  { serviceDate: "2026-08-25", inventoryUnitId: "unit_source" },
  { serviceDate: "2026-08-26", inventoryUnitId: "unit_source" }
];
const protocolPricing = {
  coverageSet: [],
  cashLines: [],
  cashRemainder: protocolMoney,
  currentContractAmount: protocolMoney
};
const protocolPricingDecision = {
  pricingBasis: "MEMBER_ENTITLEMENT",
  policyBaseAmount: protocolMoney,
  targetCurrentContractAmount: protocolMoney,
  differenceFromPolicy: protocolMoney,
  manualAdjustmentMinor: 0,
  differenceExceedsThreshold: false,
  reason: { code: "MEMBER_ENTITLEMENT", note: "" }
};

describe("orders list operational context", () => {
  const orderRow = {
    id: "order_today",
    property_id: "property_today",
    status: "CHECKED_IN",
    stay_status: "IN_HOUSE",
    stay_type: "TRANSIENT",
    arrival_date: "2026-08-11",
    departure_date: "2026-08-19",
    primary_guest_snapshot: { fullName: "测试住客", nickname: "测试住客" },
    booking_channel_code: "WECOM",
    channel_order_reference: null,
    free_stay_reason: null,
    free_stay_category_code: null,
    pricing_policy_version_id: "policy_today",
    member_id: null,
    member_contract_id: null,
    current_revision_id: "revision_today",
    current_contract_amount_minor: 0,
    currency: "CNY",
    current_unit_name: "1 栋 · 公卫四人间",
    current_unit_code: "104-A",
    version: 1,
    created_at: "2026-08-11T08:00:00.000Z",
    updated_at: "2026-08-27T08:00:00.000Z"
  };

  it("requires the server business date and Stay status used by today's exception gate", () => {
    expect(Value.Check(OrdersListResponseSchema, {
      businessDate: "2026-08-27",
      orders: [orderRow]
    })).toBe(true);
    expect(Value.Check(OrdersListResponseSchema, { orders: [orderRow] })).toBe(false);
    const { stay_status: _stayStatus, ...missingStayStatus } = orderRow;
    expect(Value.Check(OrdersListResponseSchema, {
      businessDate: "2026-08-27",
      orders: [missingStayStatus]
    })).toBe(false);
  });
});

function protocolInventoryUnit(id: string) {
  return {
    id,
    propertyId: "prop_test",
    kind: "ROOM",
    roomId: id,
    code: id,
    name: id,
    catalogVersion: null,
    buildingCode: null,
    roomTypeCode: "ROOM_TYPE",
    pricingProductCode: "ROOM_PRICE",
    inventoryBasis: "INDEPENDENT",
    codeProvenance: "SOURCE_EXPLICIT",
    physicalBedCount: null,
    occupancyCapacity: 2
  };
}

function preInHouseFulfillmentShortenEffect() {
  return {
    operation: "SHORTEN_STAY",
    orderId: "order_test",
    stayId: "stay_test",
    inventoryUnitId: "unit_source",
    businessDate: "2026-08-25",
    completionMode: "SHORTEN_IN_HOUSE",
    before: {
      arrivalDate: "2026-08-25",
      departureDate: "2026-08-27",
      nights: 2,
      currentContractAmount: protocolMoney,
      stayTimeline: protocolTimeline
    },
    after: {
      arrivalDate: "2026-08-25",
      departureDate: "2026-08-26",
      nights: 1,
      stayTimeline: protocolTimeline.slice(0, 1),
      pricing: protocolPricing
    },
    pricingDecision: protocolPricingDecision,
    inventoryChange: {
      preservedDates: ["2026-08-25"],
      releasedDates: ["2026-08-26"],
      addedDates: []
    },
    entitlementSummary: {
      currentConsumedCoverageDates: ["2026-08-25"],
      retainedHistoricalConsumedCoverageDates: ["2026-08-26"],
      ledgerWriteCount: 0
    },
    fundsSummary: {
      netRecordedCollection: protocolMoney,
      collectionDifference: protocolMoney,
      factCount: 0
    },
    refundReferenceAmount: protocolMoney
  };
}

function preInHouseFulfillmentMoveEffect() {
  const targetTimeline = protocolTimeline.map((item) => ({ ...item, inventoryUnitId: "unit_target" }));
  return {
    operation: "MOVE_UNIT",
    orderId: "order_test",
    stayId: "stay_test",
    businessDate: "2026-08-25",
    toInventoryUnit: protocolInventoryUnit("unit_target"),
    effectiveDate: "2026-08-25",
    occupantCount: 1,
    occupancyCapacity: 2,
    before: {
      arrivalDate: "2026-08-25",
      departureDate: "2026-08-27",
      nights: 2,
      currentContractAmount: protocolMoney,
      stayTimeline: protocolTimeline,
      actualCurrentInventoryUnit: protocolInventoryUnit("unit_source"),
      effectiveDateInventoryUnit: protocolInventoryUnit("unit_source")
    },
    after: {
      arrivalDate: "2026-08-25",
      departureDate: "2026-08-27",
      nights: 2,
      stayTimeline: targetTimeline,
      pricing: protocolPricing
    },
    pricingDecision: protocolPricingDecision,
    inventoryChange: {
      preservedClaims: [],
      releasedClaims: protocolTimeline,
      addedClaims: targetTimeline
    },
    entitlementSummary: {
      preservedCoverageDates: [],
      migratedHeldCoverageDates: [],
      consumedCoverageDates: ["2026-08-25", "2026-08-26"],
      ledgerWriteCount: 0
    },
    fundsSummary: {
      netRecordedCollection: protocolMoney,
      collectionDifference: protocolMoney,
      factCount: 0
    }
  };
}

function historicalStoredPreview(commandType: "SHORTEN_STAY" | "MOVE_UNIT", effect: Record<string, unknown>) {
  return {
    id: `preview_${commandType.toLowerCase()}`,
    property_id: "prop_test",
    command_type: commandType,
    input_hash: "a".repeat(64),
    effect,
    effect_hash: "b".repeat(64),
    expires_at: "2026-08-26T12:00:00.000Z",
    status: "USED",
    created_at: "2026-08-26T10:00:00.000Z",
    used_at: "2026-08-26T10:01:00.000Z",
    confirmable: false,
    protocolVersion: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT",
    recoveryMode: "HISTORICAL_READ_ONLY"
  };
}

function preInHouseFulfillmentShortenResult() {
  const effect = preInHouseFulfillmentShortenEffect();
  return {
    orderId: effect.orderId,
    stayId: effect.stayId,
    arrangementAmendmentId: "amendment_shorten",
    checkoutAmendmentId: null,
    staySegmentId: "segment_shorten",
    pricingRevisionId: "revision_shorten",
    effectHash: "c".repeat(64),
    completionMode: effect.completionMode,
    businessDate: effect.businessDate,
    arrivalDate: effect.after.arrivalDate,
    departureDate: effect.after.departureDate,
    before: effect.before,
    after: effect.after,
    pricingDecision: effect.pricingDecision,
    inventoryChange: effect.inventoryChange,
    entitlementSummary: effect.entitlementSummary,
    fundsSummary: effect.fundsSummary,
    refundReferenceAmount: effect.refundReferenceAmount,
    fulfillmentTiming: null
  };
}

function preInHouseFulfillmentMoveResult() {
  const effect = preInHouseFulfillmentMoveEffect();
  return {
    orderId: effect.orderId,
    stayId: effect.stayId,
    amendmentId: "amendment_move",
    staySegmentId: "segment_move",
    pricingRevisionId: "revision_move",
    effectHash: "d".repeat(64),
    businessDate: effect.businessDate,
    effectiveDate: effect.effectiveDate,
    before: effect.before,
    after: effect.after,
    pricingDecision: effect.pricingDecision,
    inventoryChange: effect.inventoryChange,
    entitlementSummary: effect.entitlementSummary,
    fundsSummary: effect.fundsSummary
  };
}

function historicalReceipt(result: Record<string, unknown>) {
  return {
    receiptId: "receipt_historical",
    commandId: "command_historical",
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId: "correlation-historical",
    result,
    resourceRefs: ["order_test"],
    factRefs: [],
    committedAt: "2026-08-26T10:01:00.000Z",
    protocolVersion: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT",
    recoveryMode: "HISTORICAL_READ_ONLY"
  };
}

function createBackfillEnvelope(collection: Record<string, unknown>) {
  return {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: "prop_test",
      quoteId: "quote_test",
      primaryGuest: { fullName: "补录住客", nickname: "补录住客" },
      backfill: true,
      backfillReason: "前台漏录",
      backfillCollection: collection
    }
  };
}

describe("pre-8.6 stay fulfillment protocol", () => {
  it.each([
    ["SHORTEN_STAY", preInHouseFulfillmentShortenEffect()],
    ["MOVE_UNIT", preInHouseFulfillmentMoveEffect()]
  ] as const)("keeps the prior current %s effect readable only as historical", (commandType, effect) => {
    expect(Value.Check(CommandEffectSchema, effect)).toBe(false);
    const historical = historicalStoredPreview(commandType, effect);
    expect(Value.Check(HistoricalStoredPreviewResponseSchema, historical)).toBe(true);
  });

  it.each([
    preInHouseFulfillmentShortenResult(),
    preInHouseFulfillmentMoveResult()
  ])("keeps a prior current executed result readable without accepting it as current", (result) => {
    expect(Value.Check(ExecutedCommandResultSchema, result)).toBe(false);
    expect(Value.Check(HistoricalReceiptReadSchema, historicalReceipt(result))).toBe(true);
  });

  it("requires the new entitlement evidence on current effects", () => {
    const shorten = preInHouseFulfillmentShortenEffect();
    const move = preInHouseFulfillmentMoveEffect();
    expect(Value.Check(CommandEffectSchema, {
      ...shorten,
      entitlementSummary: {
        ...shorten.entitlementSummary,
        restoredFutureCoverageDates: []
      }
    })).toBe(true);
    expect(Value.Check(CommandEffectSchema, {
      ...move,
      entitlementSummary: {
        ...move.entitlementSummary,
        convertedMembershipCoveragePreserved: true
      }
    })).toBe(true);
  });
});

describe("backfill collection command schema", () => {
  it.each([
    { amountMinor: 10_000, method: "WECOM", transactionReference: "WX-001" },
    { amountMinor: 10_000, method: "BANK_TRANSFER", transactionReference: "BANK-001" },
    { amountMinor: 10_000, method: "CASH", cashCollector: "张三", note: "前台现金收款" },
    { amountMinor: 0, method: "WECOM" },
    { amountMinor: 0, method: "CASH" }
  ])("accepts a valid backfill collection shape: $method / $amountMinor", (collection) => {
    expect(Value.Check(CommandEnvelopeSchema, createBackfillEnvelope(collection))).toBe(true);
  });

  it.each([
    { amountMinor: 10_000, method: "OTHER", note: "其他" },
    { amountMinor: 10_000, method: "WECOM" },
    { amountMinor: 10_000, method: "BANK_TRANSFER", transactionReference: "BANK-001", cashCollector: "不应提交" },
    { amountMinor: 10_000, method: "CASH", note: "缺少收款人" },
    { amountMinor: 10_000, method: "CASH", cashCollector: "张三" },
    { amountMinor: 10_000, method: "CASH", cashCollector: "张三", note: "现金", transactionReference: "不应提交" }
  ])("rejects an invalid backfill collection shape: $method", (collection) => {
    expect(Value.Check(CommandEnvelopeSchema, createBackfillEnvelope(collection))).toBe(false);
  });

  it("keeps the obsolete two-step backfill command out of the executable schema", () => {
    expect(Value.Check(CommandEnvelopeSchema, {
      commandType: "BACKFILL_COMPLETED_STAY",
      input: {
        propertyId: "prop_test",
        orderId: "order_test",
        collection: { amountMinor: 10_000, method: "CASH", cashCollector: "张三", note: "现金" }
      }
    })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, {
      commandType: "BACKFILL_COMPLETED_STAY",
      input: {
        propertyId: "prop_test",
        orderId: "order_test",
        collection: { amountMinor: 10_000, method: "CASH", note: "缺少收款人" }
      }
    })).toBe(false);
  });
});

describe("stay-to-membership conversion command schema", () => {
  const envelope = {
    commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    input: {
      propertyId: "prop_test",
      orderId: "order_test",
      memberId: "member_test",
      membershipProductId: "membership_product_test",
      collectionFactIds: [],
      agreedPriceMinor: 162_000,
      remainingPaymentTransactionReference: "WX-CONVERSION-001"
    }
  };

  it("requires a positive whole-yuan membership price", () => {
    expect(Value.Check(CommandEnvelopeSchema, envelope)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...envelope,
      input: { ...envelope.input, agreedPriceMinor: 0 }
    })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...envelope,
      input: { ...envelope.input, agreedPriceMinor: 16_250 }
    })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...envelope,
      input: { ...envelope.input, agreedPriceMinor: 2_147_483_600 }
    })).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...envelope,
      input: { ...envelope.input, agreedPriceMinor: 2_147_483_700 }
    })).toBe(false);
  });

  it("accepts explicit in-house conversion coverage references", () => {
    const result = {
      orderId: "order_test",
      memberId: "member_test",
      amendmentId: "amendment_test",
      pricingRevisionId: "revision_test",
      membershipOrderId: "membership_order_test",
      status: "ACTIVE",
      contractId: "contract_test",
      entitlementLotId: "lot_test",
      transferredCollectionFactIds: [],
      lodgingReversalFactIds: [],
      membershipPaymentFactIds: ["membership_payment_test"],
      transferIds: [],
      conversionMode: "IN_HOUSE",
      conversionCoverageIds: ["coverage_test"],
      conversionLedgerFactIds: ["ledger_test"],
      transferredAmount: { currency: "CNY", minorUnits: 0 },
      membershipAgreedPrice: { currency: "CNY", minorUnits: 162_000 },
      remainingPaymentAmount: { currency: "CNY", minorUnits: 162_000 },
      entitlementUnitKind: "ROOM_NIGHT",
      convertedUnits: 1,
      remainingUnits: 29
    };
    expect(Value.Check(ExecutedCommandResultSchema, result)).toBe(true);
    const { conversionCoverageIds: _conversionCoverageIds, ...missingCoverageReferences } = result;
    expect(Value.Check(ExecutedCommandResultSchema, missingCoverageReferences)).toBe(false);
    expect(Value.Check(ExecutedCommandResultSchema, {
      ...result,
      conversionMode: "COMPLETED",
      conversionCoverageIds: []
    })).toBe(true);
    const historical = historicalReceipt({
      ...result,
      conversionMode: "COMPLETED",
      conversionCoverageIds: []
    });
    expect(Value.Check(HistoricalReceiptReadSchema, historical)).toBe(true);
    expect(Value.Check(HistoricalReceiptReadSchema, { ...historical, recoveryMode: undefined })).toBe(false);
  });
});

describe("completed-stay backfill receipt schema", () => {
  const receipt = {
    receiptId: "receipt_backfill",
    commandId: "command_backfill",
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId: "correlation_backfill",
    result: {
      orderId: "order_backfill",
      stayId: "stay_backfill",
      segmentId: "segment_backfill",
      pricingRevisionId: "revision_backfill",
      effectHash: "a".repeat(64),
      primaryGuest: null,
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      freeStayReason: null,
      freeStayCategoryCode: null,
      status: "CHECKED_OUT",
      backfill: {
        businessDate: "2026-08-14",
        checkInAmendmentId: "amend_check_in",
        checkOutAmendmentId: "amend_check_out",
        settlementStatus: "ARREARS",
        collectedAmountMinor: 0,
        balanceDueMinor: 10_000,
        collectionFactId: null
      }
    },
    resourceRefs: [],
    factRefs: []
  };

  it("accepts the durable Preview hash on a completed-stay backfill result", () => {
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    expect(Value.Check(ReceiptSchema, {
      ...receipt,
      result: { ...receipt.result, effectHash: "not-a-sha256" }
    })).toBe(false);
  });
});

describe("complete-overdue-reserved-stay receipt schema", () => {
  const receipt = {
    receiptId: "receipt_complete_stay",
    commandId: "command_complete_stay",
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId: "correlation_complete_stay",
    result: {
      orderId: "order_complete_stay",
      stayId: "stay_complete_stay",
      checkInAmendmentId: "amend_check_in",
      checkOutAmendmentId: "amend_check_out",
      collectionFactId: null,
      releasedClaimIds: ["claim_complete_stay"],
      consumedCoverageIds: [],
      status: "CHECKED_OUT",
      settlementStatus: "ARREARS",
      effectHash: "b".repeat(64),
      fulfillmentTiming: {
        effectiveDate: "2026-08-11",
        recordedBusinessDate: "2026-08-15",
        recordingMode: "LATE_RECORDED"
      }
    },
    resourceRefs: [],
    factRefs: []
  };

  it("accepts a complete-stay result with settlement status", () => {
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    expect(Value.Check(CompleteStayResultSchema, receipt.result)).toBe(true);
    expect(Value.Check(ReceiptSchema, {
      ...receipt,
      result: { ...receipt.result, settlementStatus: "UNKNOWN" }
    })).toBe(false);
  });

  it("requires a lowercase SHA-256 effect hash on the complete-stay result", () => {
    const { effectHash: _effectHash, ...withoutEffectHash } = receipt.result;
    expect(Value.Check(CompleteStayResultSchema, withoutEffectHash)).toBe(false);
    expect(Value.Check(CompleteStayResultSchema, {
      ...receipt.result,
      effectHash: "not-a-sha256"
    })).toBe(false);
  });

  it("requires the actualStayCompletedConfirmed flag on the command envelope", () => {
    expect(Value.Check(CommandEnvelopeSchema, {
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: "prop_test",
        orderId: "order_test",
        actualStayCompletedConfirmed: true,
        reasonNote: "客人实际住过且已离店，现按真实凭据补记"
      }
    })).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, {
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: "prop_test",
        orderId: "order_test",
        reasonNote: "缺少确认"
      }
    })).toBe(false);
  });
});

describe("room-status order arrival date schema", () => {
  const interval = {
    id: "interval_test",
    displayInventoryUnitId: "unit_test",
    actualInventoryUnitId: "unit_test",
    roomId: "room_test",
    startDate: "2026-08-10",
    endDate: "2026-08-12",
    sourceStartDate: "2026-08-10",
    sourceEndDate: "2026-08-12",
    status: "RESERVED",
    attention: null,
    operationalAttention: null,
    available: false,
    blocking: true,
    sourceKind: "ORDER",
    sourceCategory: "DIRECT",
    freeStayCategoryCode: null,
    freeStayReason: null,
    label: "202",
    primaryOccupantLabel: null,
    occupantCount: 0,
    occupants: [],
    reason: null,
    claimIds: [],
    references: [],
    conflicts: [],
    history: [],
    allowedActions: []
  };

  it("accepts an optional local-date value on intervals and operational tasks", () => {
    expect(Value.Check(RoomStatusIntervalSchema, interval)).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, attention: "ARREARS" })).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, orderArrivalDate: "2026-08-09" })).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, sourceCategory: "CTRIP" })).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, {
      ...interval,
      sourceKind: "FREE_STAY",
      sourceCategory: "FREE_STAY",
      freeStayCategoryCode: "VOLUNTEER",
      freeStayReason: "义工住宿"
    })).toBe(true);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...interval,
      orderArrivalDate: "2026-08-09",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(true);
  });

  it("requires explicit lodging source metadata and rejects unknown source categories", () => {
    const { sourceCategory: _sourceCategory, ...missingSourceCategory } = interval;
    const { freeStayCategoryCode: _freeStayCategoryCode, ...missingFreeStayCategoryCode } = interval;
    const { freeStayReason: _freeStayReason, ...missingFreeStayReason } = interval;
    expect(Value.Check(RoomStatusIntervalSchema, missingSourceCategory)).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, missingFreeStayCategoryCode)).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, missingFreeStayReason)).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, sourceCategory: "AIRBNB" })).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, freeStayCategoryCode: "FRIEND" })).toBe(false);
  });

  it("requires an explicit arrears attention marker on intervals and operational tasks", () => {
    const { attention: _attention, ...missingAttention } = interval;
    expect(Value.Check(RoomStatusIntervalSchema, missingAttention)).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, attention: "SETTLED" })).toBe(false);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...missingAttention,
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...interval,
      attention: "SETTLED",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
  });

  it("requires an explicit operational attention marker and rejects unknown values", () => {
    const { operationalAttention: _operationalAttention, ...missingOperationalAttention } = interval;
    expect(Value.Check(RoomStatusIntervalSchema, missingOperationalAttention)).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, {
      ...interval,
      operationalAttention: "OVERDUE_RESERVED",
      orderArrivalDate: "2026-08-09"
    })).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, operationalAttention: "LATE" })).toBe(false);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...missingOperationalAttention,
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
  });

  it("rejects a non-local-date order arrival value", () => {
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, orderArrivalDate: "2026/08/09" })).toBe(false);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...interval,
      orderArrivalDate: "2026/08/09",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
  });
});
