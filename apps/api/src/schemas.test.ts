import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  CommandEnvelopeSchema,
  CommandEffectSchema,
  CompleteStayResultSchema,
  EntitlementLedgerRowSchema,
  ExecutedCommandResultSchema,
  HistoricalReceiptReadSchema,
  HistoricalStoredPreviewResponseSchema,
  MemberResponseSchema,
  MeResponseSchema,
  OrdersListResponseSchema,
  ReceiptSchema,
  RoomStatusIntervalSchema,
  RoomStatusOperationalTaskSchema,
  TokensResponseSchema
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

describe("member entitlement ledger response", () => {
  const row = {
    fact_id: "fact_void",
    lot_id: "lot_void",
    entry_type: "VOID",
    quantity_delta: -30,
    service_date: null,
    order_id: null,
    coverage_id: null,
    reason: "错误会员链作废",
    command_id: "command_void",
    created_at: "2026-09-02T08:00:00.000Z"
  };

  it("accepts a typed erroneous-membership VOID fact without treating it as expiry", () => {
    expect(Value.Check(EntitlementLedgerRowSchema, row)).toBe(true);
    expect(Value.Check(EntitlementLedgerRowSchema, { ...row, entry_type: "UNKNOWN" })).toBe(false);
  });
});

describe("member detail response privacy boundary", () => {
  const currentMember = {
    id: "member_current",
    identity_card_number: "510000199001010022",
    nickname: "晶晶",
    full_name: "王晶晶",
    phone: "13900000002",
    wechat: "jingjing-current",
    created_at: "2026-09-03T08:00:00.000Z"
  };
  const maskedResponse = {
    member: currentMember,
    contracts: [],
    lots: [],
    ledger: [],
    externalReferences: [],
    lotBalances: [],
    availableBalance: { ROOM_NIGHT: 0, BED_NIGHT: 0 },
    balanceAsOfDate: "2026-09-03",
    membershipProducts: [],
    membershipOrders: [],
    profileCorrections: [{
      id: "profile_correction_1",
      property_id: "property_green",
      member_id: currentMember.id,
      sequence: 1,
      prior_full_name: "王晶晶",
      prior_nickname: "晶晶旧昵称",
      prior_identity_card_number: "**************0011",
      prior_phone: "138****0001",
      prior_wechat: "j***ld",
      corrected_full_name: "王晶晶",
      corrected_nickname: "晶晶",
      corrected_identity_card_number: "**************0022",
      corrected_phone: "139****0002",
      corrected_wechat: "j***nt",
      changed_fields: ["nickname", "identityCardNumber", "phone", "wechat"],
      evidence_note: "纸质资料与本人确认一致",
      command_id: "command_profile_correction",
      created_at: "2026-09-03T08:30:00.000Z",
      actor: { subjectId: "subject_admin", displayName: "运营管理员" }
    }],
    effectiveDateCorrections: [],
    historicalMembershipBackfills: [{
      id: "historical_membership_backfill_1",
      property_id: "property_green",
      member_id: currentMember.id,
      membership_order_id: "membership_order_backfill_1",
      contract_id: "contract_backfill_1",
      entitlement_lot_id: "lot_backfill_1",
      payment_fact_id: "payment_backfill_1",
      product_id: "membership_product_shared_quad_v1",
      product_code: "MEMBER-SHARED-QUAD",
      product_version: 1,
      product_name: "公卫四人间会员",
      listed_price_minor: 93_600,
      agreed_price_minor: 93_600,
      currency: "CNY",
      entitlement_unit_kind: "BED_NIGHT",
      entitlement_units: 30,
      validity_period: "P1Y",
      allowed_room_type_code: "shared_bath_quad",
      allowed_inventory_kind: "BED",
      actual_membership_date: "2026-08-10",
      valid_until: "2027-08-10",
      business_date: "2026-08-12",
      transaction_reference: "WECOM-HISTORY-001",
      evidence_note: "企微账单与合同已核对",
      command_id: "command_backfill_1",
      created_at: "2026-09-03T08:35:00.000Z",
      actor: { subjectId: "subject_admin", displayName: "运营管理员" }
    }],
    paymentReclassifications: [],
    voidReconversions: []
  };

  it("accepts only masked sensitive correction history while preserving the current member and non-sensitive audit fields", () => {
    expect(Value.Check(MemberResponseSchema, maskedResponse)).toBe(true);
    expect(maskedResponse.member).toEqual(currentMember);
    expect(maskedResponse.profileCorrections[0]).toMatchObject({
      prior_full_name: "王晶晶",
      prior_nickname: "晶晶旧昵称",
      evidence_note: "纸质资料与本人确认一致"
    });
    expect(maskedResponse.historicalMembershipBackfills[0]).toMatchObject({ validity_period: "P1Y" });

    expect(Value.Check(MemberResponseSchema, {
      ...maskedResponse,
      historicalMembershipBackfills: maskedResponse.historicalMembershipBackfills.map(({ validity_period: _validityPeriod, ...row }) => row)
    })).toBe(false);

    const correctionHistoryBody = JSON.stringify(maskedResponse.profileCorrections);
    for (const original of [
      "510000199001010011",
      "13800000001",
      "jingjing-old",
      "510000199001010022",
      "13900000002",
      "jingjing-current"
    ]) {
      expect(correctionHistoryBody).not.toContain(original);
    }
  });

  it("rejects an API response that exposes an unmasked historical sensitive value", () => {
    expect(Value.Check(MemberResponseSchema, {
      ...maskedResponse,
      profileCorrections: [{
        ...maskedResponse.profileCorrections[0],
        prior_phone: "13800000001"
      }]
    })).toBe(false);
  });

  it("accepts cent-precision void-reconversion history with its actual currency", () => {
    expect(Value.Check(MemberResponseSchema, {
      ...maskedResponse,
      voidReconversions: [{
        id: "void_reconversion_fractional",
        property_id: "property_green",
        member_id: currentMember.id,
        old_membership_order_id: "membership_order_old",
        old_contract_id: "contract_old",
        old_entitlement_lot_id: "lot_old",
        prior_old_order_version: 2,
        prior_old_contract_version: 1,
        prior_old_lot_version: 1,
        source_order_id: "order_source",
        source_stay_id: "stay_source",
        prior_source_order_version: 3,
        new_membership_order_id: "membership_order_new",
        new_contract_id: "contract_new",
        new_entitlement_lot_id: "lot_new",
        replacement_payment_fact_id: "payment_replacement",
        replacement_business_date: "2026-08-09",
        replacement_transaction_reference: "WECOM-DIFFERENCE-001",
        actual_membership_date: "2026-08-10",
        valid_until: "2027-08-10",
        old_direct_collection_total_minor: 93_650,
        stay_transfer_total_minor: 20_050,
        membership_agreed_price_minor: 93_650,
        currency: "USD",
        service_dates: ["2026-08-10", "2026-08-11"],
        evidence_note: "原会员链与历史住宿已逐笔核对",
        command_id: "command_void_reconversion",
        created_at: "2026-09-03T08:30:00.000Z",
        actor: { subjectId: "subject_admin", displayName: "运营管理员" }
      }]
    })).toBe(true);
  });
});

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

describe("/me command permission projection schema", () => {
  it("requires exact command grants and per-property allowed action lists", () => {
    expect(Value.Check(MeResponseSchema, {
      subjectId: "subject_operator",
      displayName: "前台",
      credentialType: "SESSION",
      propertyAccess: { property_qintopia: "WRITE", property_readonly: "READ" },
      propertyCommandGrants: {
        property_qintopia: ["CREATE_ORDER", "REPRICE_ORDER", "ISSUE_TOKEN", "CORRECT_HISTORICAL_STAY_ARRANGEMENTS", "BACKFILL_COMPLETED_STAY"],
        property_readonly: ["CREATE_ORDER", "PLACE_INTERNAL_USE"]
      },
      allowedActions: {
        property_qintopia: ["CREATE_ORDER", "REPRICE_ORDER", "ISSUE_TOKEN"],
        property_readonly: []
      }
    })).toBe(true);

    expect(Value.Check(MeResponseSchema, {
      subjectId: "subject_operator",
      displayName: "前台",
      credentialType: "SESSION",
      propertyAccess: { property_qintopia: "WRITE" },
      propertyCommandGrants: { property_qintopia: ["CREATE_*"] },
      allowedActions: { property_qintopia: ["CREATE_ORDER"] }
    })).toBe(false);

    expect(Value.Check(MeResponseSchema, {
      subjectId: "subject_operator",
      displayName: "前台",
      credentialType: "SESSION",
      propertyAccess: { property_qintopia: "WRITE" },
      propertyCommandGrants: { property_qintopia: ["CREATE_ORDER", "COMPLETE_CLEANING"] },
      allowedActions: { property_qintopia: ["COMPLETE_CLEANING"] }
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

function currentReceipt(result: Record<string, unknown>) {
  return {
    receiptId: "receipt_current",
    commandId: "command_current",
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId: "correlation-current",
    result,
    resourceRefs: ["resource_current"],
    factRefs: [],
    committedAt: "2026-09-02T08:00:00.000Z"
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

describe("public command envelope schema", () => {
  it.each([
    ["REFRESH_MEMBER_COVERAGE", { propertyId: "prop_test", orderId: "order_test" }],
    ["ADD_MEMBER_ENTITLEMENT_LOT", {
      propertyId: "prop_test",
      memberContractId: "contract_test",
      unitKind: "ROOM_NIGHT",
      units: 1,
      expiresOn: "2028-12-31"
    }],
    ["ADJUST_MEMBER_ENTITLEMENT", {
      propertyId: "prop_test",
      entitlementLotId: "lot_test",
      quantityDelta: 1,
      adjustmentReason: "Internal entitlement repair"
    }],
    ["EXPIRE_MEMBER_ENTITLEMENT", {
      propertyId: "prop_test",
      entitlementLotId: "lot_test",
      asOfDate: "2028-12-31"
    }]
  ])("rejects system-derived command %s", (commandType, input) => {
    expect(Value.Check(CommandEnvelopeSchema, { commandType, input })).toBe(false);
  });
});

describe("Token command ceiling schema", () => {
  const tokenSecret = `qtp_${"A".repeat(43)}`;

  it("requires issue and rotate commands to carry an exact command ceiling", () => {
    const issue = {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: "prop_test",
        subjectId: "subject_test",
        label: "Integration client",
        accessCeiling: "WRITE",
        commandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION", "ISSUE_TOKEN"],
        expiresAt: "2028-01-01T00:00:00.000Z",
        tokenSecret
      }
    };
    const rotate = {
      commandType: "ROTATE_TOKEN",
      input: {
        propertyId: "prop_test",
        tokenId: "token_test",
        commandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION"],
        tokenSecret
      }
    };

    expect(Value.Check(CommandEnvelopeSchema, issue)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, rotate)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, { ...issue, input: { ...issue.input, commandCeiling: ["CREATE_*"] } })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, { ...issue, input: { ...issue.input, commandCeiling: ["ADD_MEMBER_ENTITLEMENT_LOT"] } })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, { ...rotate, input: { ...rotate.input, commandCeiling: ["CREATE_ORDER", "CREATE_ORDER"] } })).toBe(false);
    const { commandCeiling: _issueCeiling, ...issueWithoutCeiling } = issue.input;
    const { commandCeiling: _rotateCeiling, ...rotateWithoutCeiling } = rotate.input;
    expect(Value.Check(CommandEnvelopeSchema, { ...issue, input: issueWithoutCeiling })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, { ...rotate, input: rotateWithoutCeiling })).toBe(false);
  });

  it("distinguishes rotate and revoke command effects by operation", () => {
    const rotateEffect = {
      tokenId: "token_test",
      subjectId: "subject_test",
      subjectDisplayName: "渠道同步账号",
      label: "Integration client",
      accessCeiling: "WRITE",
      previousCommandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION"],
      commandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION"],
      previousPersistedCommandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION"],
      persistedCommandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION"],
      previousExpiresAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2028-01-01T00:00:00.000Z",
      historicalReadCeilingPreserved: true,
      operation: "ROTATE"
    };
    const revokeEffect = {
      tokenId: "token_test",
      subjectId: "subject_test",
      subjectDisplayName: "渠道同步账号",
      label: "Integration client",
      accessCeiling: "WRITE",
      commandCeiling: ["CREATE_ORDER"],
      persistedCommandCeiling: ["CREATE_ORDER"],
      expiresAt: "2028-01-01T00:00:00.000Z",
      historicalReadCeilingPreserved: false,
      operation: "REVOKE"
    };

    expect(Value.Check(CommandEffectSchema, rotateEffect)).toBe(true);
    expect(Value.Check(CommandEffectSchema, revokeEffect)).toBe(true);
    const { commandCeiling: _rotateCeiling, ...rotateWithoutCeiling } = rotateEffect;
    expect(Value.Check(CommandEffectSchema, rotateWithoutCeiling)).toBe(false);
    expect(Value.Check(CommandEffectSchema, { ...revokeEffect, historicalReadCeilingPreserved: true })).toBe(false);
    expect(Value.Check(CommandEffectSchema, { ...revokeEffect, previousCommandCeiling: ["CREATE_ORDER"] })).toBe(false);
  });
});

describe("Token list response schema", () => {
  const baseToken = {
    subjectId: "subject_agent",
    displayName: "渠道同步账号",
    id: "token_public_row",
    label: "房态同步",
    property_scope: "property_green",
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    rotated_from_id: null,
    replaced_by_id: null,
    created_at: "2026-09-01T00:00:00.000Z"
  };

  it("requires both executable and persisted ceilings plus the server-owned historical read flag", () => {
    const response = {
      tokens: [{
        ...baseToken,
        access_ceiling: "WRITE",
        commandCeiling: ["REPRICE_ORDER"],
        persistedCommandCeiling: ["REPRICE_ORDER", "PLACE_INTERNAL_USE"],
        historicalReadCeilingPreserved: true
      }]
    };

    expect(Value.Check(TokensResponseSchema, response)).toBe(true);
    expect(Value.Check(TokensResponseSchema, {
      tokens: [{
        ...baseToken,
        access_ceiling: "WRITE",
        commandCeiling: ["REPRICE_ORDER"],
        persistedCommandCeiling: ["REPRICE_ORDER", "PLACE_INTERNAL_USE"]
      }]
    })).toBe(false);
    expect(Value.Check(TokensResponseSchema, {
      tokens: [{
        ...baseToken,
        access_ceiling: "WRITE",
        commandCeiling: ["PLACE_INTERNAL_USE"],
        persistedCommandCeiling: ["PLACE_INTERNAL_USE"],
        historicalReadCeilingPreserved: true
      }]
    })).toBe(false);
    expect(Value.Check(TokensResponseSchema, {
      tokens: [{
        ...response.tokens[0],
        rawCommandType: "REPRICE_ORDER"
      }]
    })).toBe(false);
  });

  it("requires READ Token rows to have empty executable and persisted ceilings", () => {
    const readRow = {
      ...baseToken,
      access_ceiling: "READ",
      commandCeiling: [],
      persistedCommandCeiling: [],
      historicalReadCeilingPreserved: false
    };

    expect(Value.Check(TokensResponseSchema, { tokens: [readRow] })).toBe(true);
    expect(Value.Check(TokensResponseSchema, {
      tokens: [{ ...readRow, commandCeiling: ["REPRICE_ORDER"] }]
    })).toBe(false);
    expect(Value.Check(TokensResponseSchema, {
      tokens: [{ ...readRow, persistedCommandCeiling: ["PLACE_INTERNAL_USE"] }]
    })).toBe(false);
    expect(Value.Check(TokensResponseSchema, {
      tokens: [{ ...readRow, historicalReadCeilingPreserved: true }]
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

describe("administrator correction receipt schema", () => {
  const audit = {
    reason: { code: "DATA_ENTRY_CORRECTION", note: "管理员核对原始凭据" },
    evidenceNote: "纸质记录与企微凭据一致",
    actor: { subjectId: "subject_administrator", displayName: "运营主管" },
    recordedAt: "2026-09-03T08:00:00.000Z"
  };
  const historicalArrangement = {
    operation: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
    correctionSetHash: "a".repeat(64),
    corrections: [{
      orderId: "order_history",
      stayId: "stay_history",
      correctionId: "fact_history",
      amendmentId: "amend_history",
      staySegmentId: "segment_history",
      pricingRevisionId: "revision_history",
      claimIds: ["claim_history"],
      before: {
        inventoryUnitId: "unit_108",
        arrivalDate: "2026-08-27",
        departureDate: "2026-08-30",
        nights: 3,
        stayTimeline: [
          { serviceDate: "2026-08-27", inventoryUnitId: "unit_108" },
          { serviceDate: "2026-08-28", inventoryUnitId: "unit_108" },
          { serviceDate: "2026-08-29", inventoryUnitId: "unit_108" }
        ]
      },
      after: {
        inventoryUnitId: "unit_109",
        arrivalDate: "2026-08-28",
        departureDate: "2026-08-31",
        nights: 3,
        stayTimeline: [
          { serviceDate: "2026-08-28", inventoryUnitId: "unit_109" },
          { serviceDate: "2026-08-29", inventoryUnitId: "unit_109" },
          { serviceDate: "2026-08-30", inventoryUnitId: "unit_109" }
        ]
      },
      unchanged: {
        orderStatus: "CHECKED_OUT",
        stayStatus: "COMPLETED",
        stayType: "TRANSIENT",
        currentRevisionId: "revision_previous",
        currentContractAmountMinor: 58_000,
        currency: "CNY",
        occupantCount: 2,
        occupants: [
          { ordinal: 1, role: "PRIMARY", fullName: "鹏哥", nickname: "鹏哥" },
          { ordinal: 2, role: "ADDITIONAL", fullName: "小尚", nickname: "小尚" }
        ],
        collectionFactCount: 1,
        netRecordedCollectionMinor: 58_000,
        collectionDifferenceMinor: 0
      }
    }],
    ...audit,
    effectHash: "a".repeat(64)
  };
  const profileCorrection = {
    memberId: "member_profile",
    correctionId: "fact_profile",
    changedFields: ["phone", "wechat"],
    before: {
      fullName: "王晶晶",
      nickname: "晶晶",
      identityCardNumber: "510000000000000001",
      phone: "13800000001",
      wechat: "jingjing-old"
    },
    after: {
      fullName: "王晶晶",
      nickname: "晶晶",
      identityCardNumber: "510000000000000001",
      phone: "13800000002",
      wechat: "jingjing"
    },
    ...audit,
    effectHash: "b".repeat(64)
  };
  const effectiveDateCorrection = {
    memberId: "member_effective",
    membershipOrderId: "membership_order_effective",
    contractId: "contract_effective",
    entitlementLotId: "lot_effective",
    correctionId: "fact_effective",
    validFrom: "2026-08-10",
    validUntil: "2027-08-10",
    status: "ACTIVE",
    before: { validFrom: "2026-08-20", validUntil: "2027-08-20", status: "ACTIVE" },
    after: { validFrom: "2026-08-10", validUntil: "2027-08-10", status: "ACTIVE" },
    unchanged: {
      memberId: "member_effective",
      productName: "公卫四人间会员",
      agreedPrice: { currency: "CNY", minorUnits: 93_600 },
      entitlementUnitKind: "ROOM_NIGHT",
      entitlementUnits: 30,
      usedUnits: 2,
      availableBalance: { ROOM_NIGHT: 28, BED_NIGHT: 0 },
      paymentFactCount: 1,
      lifecycleStatus: "ACTIVE"
    },
    ...audit,
    effectHash: "c".repeat(64)
  };
  const historicalBackfill = {
    memberId: "member_backfill",
    membershipOrderId: "membership_order_backfill",
    paymentFactId: "membership_payment_backfill",
    contractId: "contract_backfill",
    entitlementLotId: "lot_backfill",
    backfillId: "fact_backfill",
    status: "ACTIVE",
    validFrom: "2026-08-10",
    validUntil: "2027-08-10",
    entitlementUnitKind: "ROOM_NIGHT",
    entitlementUnits: 30,
    member: { memberId: "member_backfill", fullName: "晶晶" },
    product: {
      productId: "membership_product_shared_quad",
      code: "MEMBER-SHARED-30",
      version: 1,
      name: "公卫四人间会员",
      listedPrice: { currency: "CNY", minorUnits: 93_600 },
      agreedPrice: { currency: "CNY", minorUnits: 93_600 },
      entitlementUnitKind: "ROOM_NIGHT",
      entitlementUnits: 30,
      validityPeriod: "P1Y",
      allowedRoomTypeCode: "SHARED_QUAD",
      allowedInventoryKind: "ROOM"
    },
    payment: {
      amount: { currency: "CNY", minorUnits: 93_600 },
      businessDate: "2026-08-12",
      transactionReference: "WECOM-BACKFILL-001",
      note: "切换期晚录"
    },
    ...audit,
    effectHash: "d".repeat(64)
  };
  const voidReconversion = {
    memberId: "member_void",
    voidReconversionId: "fact_void",
    member: { memberId: "member_void", fullName: "Cathy" },
    oldMembership: {
      membershipOrderId: "membership_order_wrong",
      contractId: "contract_wrong",
      entitlementLotId: "lot_wrong",
      productId: "membership_product_shared_quad",
      status: "ACTIVE",
      directCollections: [{
        factId: "membership_payment_wrong",
        amount: { currency: "CNY", minorUnits: 93_600 },
        transactionReference: "WECOM-WRONG-001",
        businessDate: "2026-08-20"
      }]
    },
    oldMembershipOrderId: "membership_order_wrong",
    oldContractId: "contract_wrong",
    oldEntitlementLotId: "lot_wrong",
    oldStatus: "VOIDED",
    sourceStayOrderId: "order_source",
    sourceStayId: "stay_source",
    sourceStay: {
      orderId: "order_source",
      stayId: "stay_source",
      arrivalDate: "2026-08-10",
      departureDate: "2026-08-12",
      serviceDates: ["2026-08-10", "2026-08-11"],
      identityEvidence: { phoneMatched: true, documentMatched: false }
    },
    amendmentId: "amend_void",
    pricingRevisionId: "revision_void",
    membershipOrderId: "membership_order_new",
    status: "ACTIVE",
    contractId: "contract_new",
    entitlementLotId: "lot_new",
    oldDirectCollectionTotal: { currency: "CNY", minorUnits: 93_600 },
    transferredAmount: { currency: "CNY", minorUnits: 58_000 },
    replacementDirectPaymentAmount: { currency: "CNY", minorUnits: 35_600 },
    membershipAgreedPrice: { currency: "CNY", minorUnits: 93_600 },
    funds: {
      oldDirectCollectionTotal: { currency: "CNY", minorUnits: 93_600 },
      oldReversalTotal: { currency: "CNY", minorUnits: 93_600 },
      stayTransferTotal: { currency: "CNY", minorUnits: 58_000 },
      replacementDirectPayment: {
        amount: { currency: "CNY", minorUnits: 35_600 },
        businessDate: "2026-08-09",
        transactionReference: "WECOM-DIFFERENCE-001"
      },
      membershipAgreedPrice: { currency: "CNY", minorUnits: 93_600 },
      reclassificationOnly: true
    },
    validFrom: "2026-08-10",
    validUntil: "2027-08-10",
    newMembership: {
      productId: "membership_product_shared_quad",
      productName: "公卫四人间会员",
      validFrom: "2026-08-10",
      validUntil: "2027-08-10",
      membershipOrderId: "membership_order_new",
      contractId: "contract_new",
      entitlementLotId: "lot_new"
    },
    entitlementUnitKind: "ROOM_NIGHT",
    convertedUnits: 2,
    remainingUnits: 28,
    entitlement: {
      unitKind: "ROOM_NIGHT",
      totalUnits: 30,
      consumedUnits: 2,
      remainingUnits: 28,
      serviceDates: ["2026-08-10", "2026-08-11"]
    },
    serviceDates: ["2026-08-10", "2026-08-11"],
    sourceCollectionFactIds: ["collection_source"],
    oldPaymentReversalFactIds: ["membership_payment_reversal_wrong"],
    paymentReclassificationFactIds: ["membership_payment_reclassification_wrong"],
    sourceReversalFactIds: ["collection_reversal_source"],
    transferPaymentFactIds: ["membership_payment_transfer"],
    replacementPaymentFactId: "membership_payment_difference",
    transferIds: ["transfer_source"],
    voidLedgerFactId: "ledger_void_wrong",
    conversionLedgerFactIds: ["ledger_conversion_1", "ledger_conversion_2"],
    ...audit,
    effectHash: "e".repeat(64)
  };

  it.each([
    historicalArrangement,
    profileCorrection,
    effectiveDateCorrection,
    historicalBackfill,
    voidReconversion
  ])("accepts the persisted Step 9 administrator correction result shape", (result) => {
    expect(Value.Check(ExecutedCommandResultSchema, result)).toBe(true);
    expect(Value.Check(ReceiptSchema, currentReceipt(result))).toBe(true);
  });

  it("does not accept invented lifecycle states in administrator correction results", () => {
    expect(Value.Check(ExecutedCommandResultSchema, {
      ...voidReconversion,
      oldStatus: "REFUNDED"
    })).toBe(false);
    expect(Value.Check(ExecutedCommandResultSchema, {
      ...effectiveDateCorrection,
      status: "EXPIRED"
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

describe("room-status original order date schema", () => {
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

  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validateInterval = ajv.compile(RoomStatusIntervalSchema);
  const validateTask = ajv.compile(RoomStatusOperationalTaskSchema);

  it("accepts omitted or paired local dates and rejects either original order date alone", () => {
    expect(Value.Check(RoomStatusIntervalSchema, interval)).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, attention: "ARREARS" })).toBe(true);
    expect(validateInterval({
      ...interval,
      orderArrivalDate: "2026-08-09",
      orderDepartureDate: "2026-08-12"
    })).toBe(true);
    expect(validateInterval({ ...interval, orderArrivalDate: "2026-08-09" })).toBe(false);
    expect(validateInterval({ ...interval, orderDepartureDate: "2026-08-12" })).toBe(false);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, sourceCategory: "CTRIP" })).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, {
      ...interval,
      sourceKind: "FREE_STAY",
      sourceCategory: "FREE_STAY",
      freeStayCategoryCode: "VOLUNTEER",
      freeStayReason: "义工住宿"
    })).toBe(true);
    expect(validateTask({
      ...interval,
      orderArrivalDate: "2026-08-09",
      orderDepartureDate: "2026-08-12",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(true);
    expect(validateTask({
      ...interval,
      orderArrivalDate: "2026-08-09",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
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
      orderArrivalDate: "2026-08-09",
      orderDepartureDate: "2026-08-12"
    })).toBe(true);
    expect(Value.Check(RoomStatusIntervalSchema, { ...interval, operationalAttention: "LATE" })).toBe(false);
    expect(Value.Check(RoomStatusOperationalTaskSchema, {
      ...missingOperationalAttention,
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
  });

  it("rejects a non-local-date order arrival value", () => {
    expect(validateInterval({
      ...interval,
      orderArrivalDate: "2026/08/09",
      orderDepartureDate: "2026-08-12"
    })).toBe(false);
    expect(validateTask({
      ...interval,
      orderArrivalDate: "2026/08/09",
      orderDepartureDate: "2026-08-12",
      taskKind: "ARRIVAL",
      businessDate: "2026-08-10"
    })).toBe(false);
  });
});
