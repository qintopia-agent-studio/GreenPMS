import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CommandEnvelopeSchema,
  CompleteStayResultSchema,
  ReceiptSchema,
  RoomStatusIntervalSchema,
  RoomStatusOperationalTaskSchema
} from "./schemas.ts";

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
    available: false,
    blocking: true,
    sourceKind: "ORDER",
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
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, orderArrivalDate: "2026-08-09" })).toBe(true);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...interval,
      orderArrivalDate: "2026-08-09",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(true);
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
