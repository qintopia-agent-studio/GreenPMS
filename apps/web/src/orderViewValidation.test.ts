import { describe, expect, it } from "vitest";
import type { OrderArrangementDto, OrderArrangementHistoryItemDto } from "@qintopia/contracts";
import type { CollectionFactDto } from "./types";
import { OrderViewValidationError, parseOrderView } from "./orderViewValidation";

type TestHistoryItem = Omit<OrderArrangementHistoryItemDto, "type"> & { type: string };

function money(minorUnits: number) {
  return { currency: "CNY", minorUnits };
}

function arrangement(inventoryUnitId = "room_101", arrivalDate = "2026-07-28", departureDate = "2026-07-30") {
  return {
    arrivalDate,
    departureDate,
    intervals: [{ inventoryUnitId, arrivalDate, departureDate }]
  };
}

function fulfillmentFact(type: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN", plannedBusinessDate: string, recordedAt: string) {
  return {
    type,
    plannedBusinessDate,
    recordedBusinessDate: plannedBusinessDate,
    recordingMode: "ON_SCHEDULE",
    recordedAt,
    actor: { subjectId: "operator", displayName: "前台操作员" },
    reason: { code: type, note: "" }
  };
}

function amendment(overrides: Record<string, unknown> = {}) {
  return {
    id: "amendment_1",
    order_id: "order_u2",
    sequence: 1,
    amendment_type: "CREATE_ORDER",
    reason_code: "CREATE_ORDER",
    reason_note: "",
    prior_version: 0,
    new_version: 1,
    payload: { operation: "CREATE_ORDER" },
    command_id: "command_1",
    actor: { subjectId: "operator", displayName: "前台操作员" },
    created_at: "2026-07-28T08:00:00.000Z",
    ...overrides
  };
}

function orderView() {
  const original = arrangement();
  return {
    accessLevel: "WRITE",
    allowedActions: [],
    order: {
      id: "order_u2",
      property_id: "property_qintopia",
      status: "RESERVED",
      stay_type: "TRANSIENT",
      arrival_date: "2026-07-28",
      departure_date: "2026-07-30",
      primary_guest_snapshot: { fullName: "测试住客", nickname: "测试住客" },
      booking_channel_code: "WECOM",
      channel_order_reference: null,
      free_stay_reason: null,
      free_stay_category_code: null,
      pricing_policy_version_id: "policy_1",
      member_id: null,
      member_contract_id: null,
      current_revision_id: "revision_1",
      current_contract_amount_minor: 46000,
      currency: "CNY",
      version: 1,
      created_at: "2026-07-28T08:00:00.000Z",
      updated_at: "2026-07-28T08:00:00.000Z"
    },
    occupants: [{
      id: "occupant_1",
      orderId: "order_u2",
      ordinal: 1,
      role: "PRIMARY",
      fullName: "测试住客",
      nickname: "测试住客",
      phone: null,
      documentNumber: null,
      createdAt: "2026-07-28T08:00:00.000Z"
    }],
    occupantCorrections: [],
    stay: { id: "stay_u2", status: "PLANNED" },
    currentSegment: { id: "segment_1", sequence: 1, inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-30" },
    segments: [{
      id: "segment_1",
      stay_id: "stay_u2",
      sequence: 1,
      inventory_unit_id: "room_101",
      arrival_date: "2026-07-28",
      departure_date: "2026-07-30",
      segment_type: "INITIAL",
      supersedes_segment_id: null,
      amendment_id: "amendment_1",
      created_at: "2026-07-28T08:00:00.000Z"
    }],
    amendments: [amendment()],
    originalArrangement: original,
    effectiveArrangement: {
      ...original,
      presentation: "CURRENT",
      businessDate: "2026-07-28"
    },
    fulfillment: {
      state: "NOT_CHECKED_IN",
      checkIn: null as ReturnType<typeof fulfillmentFact> | null,
      checkOut: null as ReturnType<typeof fulfillmentFact> | null,
      checkInRevocation: null as ReturnType<typeof fulfillmentFact> | null
    },
    arrangementHistory: [{
      type: "INITIAL_BOOKING",
      before: null,
      after: original,
      reason: { code: "CREATE_ORDER", note: "" },
      actor: { subjectId: "operator", displayName: "前台操作员" },
      recordedAt: "2026-07-28T08:00:00.000Z",
      pricingSummary: {
        policyBaseAmount: money(20_000),
        currentContractAmount: money(20_000),
        differenceFromPolicy: money(0)
      },
      fundsSummary: {
        netRecordedCollection: money(0),
        collectionDifference: money(20_000),
        refundReferenceAmount: money(0),
        factCount: 0
      }
    }] as TestHistoryItem[],
    pricingRevisions: [{
      id: "revision_1",
      order_id: "order_u2",
      revision_no: 1,
      amendment_id: "amendment_1",
      policy_version_id: "policy_1",
      arrival_date: "2026-07-28",
      departure_date: "2026-07-30",
      coverage_set: [],
      cash_lines: [],
      policy_base_amount_minor: 20_000,
      pricing_basis: "POLICY",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: 20_000,
      difference_from_policy_minor: 0,
      reason: { code: "CREATE_ORDER", note: "" },
      currency: "CNY",
      created_at: "2026-07-28T08:00:00.000Z"
    }],
    membershipConversion: null as null | {
      membershipOrderId: string;
      memberId: string;
      contractId: string;
      entitlementLotId: string;
      commandId: string;
    },
    coverageSet: [],
    collectionFacts: [],
    cleaningTasks: [],
    amounts: {
      currentContractAmount: money(20_000),
      netRecordedCollection: money(0),
      collectionDifference: money(20_000),
      refundReferenceAmount: money(0)
    }
  };
}

function memberRepriceView({
  historyAmount = 13_000,
  targetAmount = 11_000,
  policyAmount = 13_000,
  reasonCode = "MEMBER_PRICE_NEGOTIATION",
  reasonNote = "会员现金补差协商调价"
}: {
  historyAmount?: number;
  targetAmount?: number;
  policyAmount?: number;
  reasonCode?: string;
  reasonNote?: string;
} = {}) {
  const input = orderView();
  Object.assign(input.order, {
    member_id: "member_1",
    member_contract_id: "contract_1",
    booking_channel_code: null,
    current_revision_id: "revision_2"
  });
  input.arrangementHistory[0]!.pricingSummary.policyBaseAmount.minorUnits = policyAmount;
  input.arrangementHistory[0]!.pricingSummary.currentContractAmount.minorUnits = historyAmount;
  input.arrangementHistory[0]!.pricingSummary.differenceFromPolicy.minorUnits = historyAmount - policyAmount;
  input.arrangementHistory[0]!.fundsSummary.collectionDifference.minorUnits = historyAmount;
  Object.assign(input.pricingRevisions[0]!, {
    policy_base_amount_minor: policyAmount,
    pricing_basis: "MEMBER_ENTITLEMENT",
    current_contract_amount_minor: historyAmount,
    difference_from_policy_minor: historyAmount - policyAmount
  });
  input.amendments.push(amendment({
    id: "amendment_2",
    sequence: 2,
    amendment_type: "REPRICE_ORDER",
    reason_code: reasonCode,
    reason_note: reasonNote,
    prior_version: 1,
    new_version: 2,
    payload: { operation: "REPRICE_ORDER" },
    command_id: "command_2",
    created_at: "2026-07-28T08:59:00.000Z"
  }));
  input.pricingRevisions.push({
    ...input.pricingRevisions[0]!,
    id: "revision_2",
    revision_no: 2,
    amendment_id: "amendment_2",
    manual_adjustment_minor: targetAmount - policyAmount,
    current_contract_amount_minor: targetAmount,
    difference_from_policy_minor: targetAmount - policyAmount,
    reason: { code: reasonCode, note: reasonNote },
    created_at: "2026-07-28T09:00:00.000Z"
  });
  input.amounts.currentContractAmount.minorUnits = targetAmount;
  input.amounts.collectionDifference.minorUnits = targetAmount;
  return input;
}

function appendHistoryTransition(
  input: ReturnType<typeof orderView>,
  type: TestHistoryItem["type"],
  after: OrderArrangementDto,
  recordedAt = "2026-07-28T09:00:00.000Z"
) {
  const before = input.arrangementHistory.at(-1)!.after;
  input.order.arrival_date = after.arrivalDate;
  input.order.departure_date = after.departureDate;
  input.effectiveArrangement.arrivalDate = after.arrivalDate;
  input.effectiveArrangement.departureDate = after.departureDate;
  input.effectiveArrangement.intervals = after.intervals;
  input.pricingRevisions.at(-1)!.arrival_date = after.arrivalDate;
  input.pricingRevisions.at(-1)!.departure_date = after.departureDate;
  input.arrangementHistory.push({
    type,
    before,
    after,
    reason: { code: type, note: "测试变更" },
    actor: { subjectId: "operator", displayName: "前台操作员" },
    recordedAt,
    pricingSummary: {
      policyBaseAmount: money(20_000),
      currentContractAmount: money(20_000),
      differenceFromPolicy: money(0)
    },
    fundsSummary: {
      netRecordedCollection: money(0),
      collectionDifference: money(20_000),
      refundReferenceAmount: money(0),
      factCount: 0
    }
  });
}

function movedArrangement(): OrderArrangementDto {
  return {
    arrivalDate: "2026-07-28",
    departureDate: "2026-07-30",
    intervals: [
      { inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-29" },
      { inventoryUnitId: "room_102", arrivalDate: "2026-07-29", departureDate: "2026-07-30" }
    ]
  };
}

function roundTripMoveArrangement(): OrderArrangementDto {
  return {
    arrivalDate: "2026-07-28",
    departureDate: "2026-07-30",
    intervals: [
      { inventoryUnitId: "room_102", arrivalDate: "2026-07-28", departureDate: "2026-07-29" },
      { inventoryUnitId: "room_101", arrivalDate: "2026-07-29", departureDate: "2026-07-30" }
    ]
  };
}

describe("parseOrderView", () => {
  it("requires an explicit membership conversion projection on every order view", () => {
    const missing = orderView() as Record<string, unknown>;
    delete missing.membershipConversion;
    expect(() => parseOrderView(missing)).toThrow(OrderViewValidationError);
  });

  it("accepts only a conversion projection tied to this order's member identity and unique conversion amendment", () => {
    const input = orderView();
    Object.assign(input.order, {
      member_id: "member_upgrade",
      member_contract_id: "contract_upgrade"
    });
    input.amendments.push(amendment({
      id: "amendment_conversion",
      sequence: 2,
      amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
      prior_version: 1,
      new_version: 2,
      command_id: "command_conversion",
      payload: { operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" }
    }));
    input.membershipConversion = {
      membershipOrderId: "membership_order_upgrade",
      memberId: "member_upgrade",
      contractId: "contract_upgrade",
      entitlementLotId: "lot_upgrade",
      commandId: "command_conversion"
    };
    expect(parseOrderView(input)).toBe(input);

    input.membershipConversion = { ...input.membershipConversion, memberId: "member_other" };
    expect(() => parseOrderView(input)).toThrow("与订单当前会员身份不一致");
  });

  it("rejects either side of a missing or duplicated conversion projection link", () => {
    const input = orderView();
    input.amendments.push(amendment({
      id: "amendment_conversion_only",
      sequence: 2,
      amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
      prior_version: 1,
      new_version: 2,
      command_id: "command_conversion_only",
      payload: { operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" }
    }));
    expect(() => parseOrderView(input)).toThrow("升级会员事实必须有对应投影");

    Object.assign(input.order, { member_id: "member_upgrade", member_contract_id: "contract_upgrade" });
    input.membershipConversion = {
      membershipOrderId: "membership_order_upgrade",
      memberId: "member_upgrade",
      contractId: "contract_upgrade",
      entitlementLotId: "lot_upgrade",
      commandId: "command_conversion_only"
    };
    input.amendments.push(amendment({
      id: "amendment_conversion_duplicate",
      sequence: 3,
      amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
      prior_version: 2,
      new_version: 3,
      command_id: "command_conversion_only",
      payload: { operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" }
    }));
    expect(() => parseOrderView(input)).toThrow("没有唯一对应的升级会员事实");
  });

  it("accepts a complete typed lifecycle projection without reading raw facts", () => {
    const input = orderView();
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts a revoked same-day check-in while retaining the original check-in record", () => {
    const input = orderView();
    input.order.status = "CHECK_IN_REVOKED";
    input.order.current_revision_id = "revision_2";
    input.order.version = 3;
    input.stay.status = "CHECK_IN_REVOKED";
    input.effectiveArrangement.presentation = "BEFORE_CHECK_IN_REVOCATION";
    input.fulfillment.state = "CHECK_IN_REVOKED";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkInRevocation = fulfillmentFact("REVOKE_CHECK_IN", "2026-07-28", "2026-07-28T09:00:00.000Z");
    input.amendments.push(amendment({
      id: "amendment_2", sequence: 2, amendment_type: "CHECK_IN", prior_version: 1, new_version: 2,
      command_id: "command_2", created_at: "2026-07-28T08:00:00.000Z"
    }), amendment({
      id: "amendment_3", sequence: 3, amendment_type: "REVOKE_CHECK_IN", reason_code: "REVOKE_CHECK_IN",
      reason_note: "住客未实际使用房间", prior_version: 2, new_version: 3, command_id: "command_3",
      created_at: "2026-07-28T09:00:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!, id: "revision_2", revision_no: 2, amendment_id: "amendment_3",
      current_contract_amount_minor: 0, difference_from_policy_minor: -20_000,
      reason: { code: "REVOKE_CHECK_IN", note: "住客未实际使用房间" }, created_at: "2026-07-28T09:00:00.000Z"
    });
    input.amounts.currentContractAmount.minorUnits = 0;
    input.amounts.collectionDifference.minorUnits = 0;
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts a checked-out order whose latest pricing was zeroed by member upgrade", () => {
    const input = orderView();
    input.order.status = "CHECKED_OUT";
    input.order.current_revision_id = "revision_2";
    input.order.current_contract_amount_minor = 0;
    input.order.version = 5;
    input.stay.status = "COMPLETED";
    input.effectiveArrangement.presentation = "LAST";
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-30", "2026-07-30T08:00:00.000Z");
    input.amendments.push(amendment({
      id: "amendment_2",
      sequence: 2,
      amendment_type: "CHECK_IN",
      reason_code: "CHECK_IN",
      prior_version: 1,
      new_version: 2,
      command_id: "command_2",
      created_at: "2026-07-28T08:00:00.000Z"
    }), amendment({
      id: "amendment_3",
      sequence: 3,
      amendment_type: "CHECK_OUT",
      reason_code: "CHECK_OUT",
      prior_version: 2,
      new_version: 3,
      command_id: "command_3",
      created_at: "2026-07-30T08:00:00.000Z"
    }), amendment({
      id: "amendment_4",
      sequence: 4,
      amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
      reason_note: "升级会员",
      prior_version: 3,
      new_version: 4,
      command_id: "command_4",
      created_at: "2026-07-30T09:00:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_4",
      policy_base_amount_minor: 0,
      pricing_basis: "MEMBER_ENTITLEMENT",
      current_contract_amount_minor: 0,
      difference_from_policy_minor: 0,
      reason: { code: "STAY_COLLECTION_TO_MEMBERSHIP", note: "升级会员，住宿金额归零" },
      created_at: "2026-07-30T09:00:00.000Z"
    });
    Object.assign(input.order, { member_id: "member_upgrade", member_contract_id: "contract_upgrade" });
    input.membershipConversion = {
      membershipOrderId: "membership_order_upgrade",
      memberId: "member_upgrade",
      contractId: "contract_upgrade",
      entitlementLotId: "lot_upgrade",
      commandId: "command_4"
    };
    input.amounts.currentContractAmount.minorUnits = 0;
    input.amounts.collectionDifference.minorUnits = 0;
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts a checked-out source stay zeroed by voiding an erroneous membership and reconverting it", () => {
    const input = orderView();
    input.order.status = "CHECKED_OUT";
    input.order.current_revision_id = "revision_2";
    input.order.current_contract_amount_minor = 0;
    input.order.version = 4;
    input.stay.status = "COMPLETED";
    input.effectiveArrangement.presentation = "LAST";
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-30", "2026-07-30T08:00:00.000Z");
    input.amendments.push(amendment({
      id: "amendment_2",
      sequence: 2,
      amendment_type: "CHECK_IN",
      reason_code: "CHECK_IN",
      prior_version: 1,
      new_version: 2,
      command_id: "command_2",
      created_at: "2026-07-28T08:00:00.000Z"
    }), amendment({
      id: "amendment_3",
      sequence: 3,
      amendment_type: "CHECK_OUT",
      reason_code: "CHECK_OUT",
      prior_version: 2,
      new_version: 3,
      command_id: "command_3",
      created_at: "2026-07-30T08:00:00.000Z"
    }), amendment({
      id: "amendment_4",
      sequence: 4,
      amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
      reason_note: "早先错误升级会员",
      prior_version: 3,
      new_version: 4,
      command_id: "command_old_conversion",
      payload: { operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" },
      created_at: "2026-07-30T08:30:00.000Z"
    }), amendment({
      id: "amendment_5",
      sequence: 5,
      amendment_type: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      reason_code: "DATA_ENTRY_CORRECTION",
      reason_note: "错误办卡作废后按真实住宿重新升级",
      prior_version: 4,
      new_version: 5,
      command_id: "command_5",
      payload: { operation: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY" },
      created_at: "2026-07-30T09:00:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_5",
      policy_base_amount_minor: 0,
      pricing_basis: "MEMBER_ENTITLEMENT",
      current_contract_amount_minor: 0,
      difference_from_policy_minor: 0,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "错误办卡作废后按真实住宿重新升级" },
      created_at: "2026-07-30T09:00:00.000Z"
    });
    Object.assign(input.order, { member_id: "member_rebuilt", member_contract_id: "contract_rebuilt" });
    input.membershipConversion = {
      membershipOrderId: "membership_order_rebuilt",
      memberId: "member_rebuilt",
      contractId: "contract_rebuilt",
      entitlementLotId: "lot_rebuilt",
      commandId: "command_5"
    };
    input.amounts.currentContractAmount.minorUnits = 0;
    input.amounts.collectionDifference.minorUnits = 0;
    expect(parseOrderView(input)).toBe(input);

    input.membershipConversion = { ...input.membershipConversion, commandId: "command_other" };
    expect(() => parseOrderView(input)).toThrow("没有唯一对应的升级会员事实");
  });

  it.each([
    ["missing revocation record", (input: ReturnType<typeof orderView>) => { input.fulfillment.checkInRevocation = null; }],
    ["missing retained check-in", (input: ReturnType<typeof orderView>) => { input.fulfillment.checkIn = null; }],
    ["wrong revocation type", (input: ReturnType<typeof orderView>) => { input.fulfillment.checkInRevocation!.type = "CHECK_OUT"; }],
    ["unexpected revocation field", (input: ReturnType<typeof orderView>) => { Object.assign(input.fulfillment.checkInRevocation!, { rawPayload: {} }); }]
  ])("fails closed for a damaged revoked check-in projection: %s", (_label, damage) => {
    const input = orderView();
    input.order.status = "CHECK_IN_REVOKED";
    input.stay.status = "CHECK_IN_REVOKED";
    input.effectiveArrangement.presentation = "BEFORE_CHECK_IN_REVOCATION";
    input.fulfillment.state = "CHECK_IN_REVOKED";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkInRevocation = fulfillmentFact("REVOKE_CHECK_IN", "2026-07-28", "2026-07-28T09:00:00.000Z");
    damage(input);
    expect(() => parseOrderView(input)).toThrow(OrderViewValidationError);
  });

  it("accepts only the lifecycle-specific enabled date action and rejects duplicate actions", () => {
    const reserved = orderView();
    (reserved as unknown as { allowedActions: unknown[] }).allowedActions = [{ code: "RESCHEDULE_STAY", enabled: true, disabledReason: null }];
    expect(parseOrderView(reserved)).toBe(reserved);

    const wrongReserved = orderView();
    (wrongReserved as unknown as { allowedActions: unknown[] }).allowedActions = [{ code: "EXTEND_STAY", enabled: true, disabledReason: null }];
    expect(() => parseOrderView(wrongReserved)).toThrow("与订单状态不一致");

    const duplicate = orderView();
    (duplicate as unknown as { allowedActions: unknown[] }).allowedActions = [
      { code: "RESCHEDULE_STAY", enabled: true, disabledReason: null },
      { code: "RESCHEDULE_STAY", enabled: false, disabledReason: "重复" }
    ];
    expect(() => parseOrderView(duplicate)).toThrow("重复");

    const inHouse = orderView();
    inHouse.order.status = "CHECKED_IN";
    inHouse.stay.status = "IN_HOUSE";
    inHouse.fulfillment.state = "IN_HOUSE";
    inHouse.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    (inHouse as unknown as { allowedActions: unknown[] }).allowedActions = [
      { code: "EXTEND_STAY", enabled: true, disabledReason: null },
      { code: "SHORTEN_STAY", enabled: true, disabledReason: null }
    ];
    expect(parseOrderView(inHouse)).toBe(inHouse);
  });

  it("fails closed when MOVE_UNIT is enabled for an overdue or terminal order", () => {
    const overdueReserved = orderView();
    overdueReserved.effectiveArrangement.businessDate = "2026-07-29";
    (overdueReserved as unknown as { allowedActions: unknown[] }).allowedActions = [{ code: "MOVE_UNIT", enabled: true, disabledReason: null }];
    expect(() => parseOrderView(overdueReserved)).toThrow("换房操作与订单状态或营业日期不一致");

    const overdueInHouse = orderView();
    overdueInHouse.order.status = "CHECKED_IN";
    overdueInHouse.stay.status = "IN_HOUSE";
    overdueInHouse.fulfillment.state = "IN_HOUSE";
    overdueInHouse.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    overdueInHouse.effectiveArrangement.businessDate = "2026-07-30";
    (overdueInHouse as unknown as { allowedActions: unknown[] }).allowedActions = [{ code: "MOVE_UNIT", enabled: true, disabledReason: null }];
    expect(() => parseOrderView(overdueInHouse)).toThrow("换房操作与订单状态或营业日期不一致");

    const checkedOut = orderView();
    checkedOut.order.status = "CHECKED_OUT";
    checkedOut.stay.status = "COMPLETED";
    checkedOut.effectiveArrangement.presentation = "LAST";
    checkedOut.fulfillment.state = "CHECKED_OUT";
    checkedOut.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    checkedOut.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-30", "2026-07-30T08:00:00.000Z");
    checkedOut.effectiveArrangement.businessDate = "2026-07-30";
    (checkedOut as unknown as { allowedActions: unknown[] }).allowedActions = [{ code: "MOVE_UNIT", enabled: true, disabledReason: null }];
    expect(() => parseOrderView(checkedOut)).toThrow("换房操作与订单状态或营业日期不一致");
  });

  it.each([
    ["missing original arrangement", (input: ReturnType<typeof orderView>) => { delete (input as Partial<typeof input>).originalArrangement; }],
    ["unknown history type", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.type = "INITIAL"; }],
    ["unexpected typed field", (input: ReturnType<typeof orderView>) => { Object.assign(input.fulfillment, { rawPayload: {} }); }],
    ["history disconnected from effective arrangement", (input: ReturnType<typeof orderView>) => {
      input.effectiveArrangement.intervals = [{
        inventoryUnitId: "room_102",
        arrivalDate: "2026-07-28",
        departureDate: "2026-07-30"
      }];
    }]
  ])("fails closed for %s even when raw segments and amendments exist", (_label, damage) => {
    const input = orderView();
    damage(input);
    expect(() => parseOrderView(input)).toThrow(OrderViewValidationError);
  });

  it("rejects gaps and overlaps inside an arrangement", () => {
    const input = orderView();
    input.effectiveArrangement.intervals = [
      { inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-29" },
      { inventoryUnitId: "room_102", arrivalDate: "2026-07-28", departureDate: "2026-07-30" }
    ];
    expect(() => parseOrderView(input)).toThrow("与前一区间不连续");
  });

  it("rejects fulfillment state and records that contradict each other", () => {
    const input = orderView();
    input.fulfillment.state = "CHECKED_OUT";
    expect(() => parseOrderView(input)).toThrow("履约状态与入住、退房或撤销记录不一致");
  });

  it("accepts a checked-out projection when order, Stay, presentation, and typed facts agree", () => {
    const input = orderView();
    input.order.status = "CHECKED_OUT";
    input.stay.status = "COMPLETED";
    input.effectiveArrangement.presentation = "LAST";
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-30", "2026-07-30T08:00:00.000Z");

    expect(parseOrderView(input)).toBe(input);
  });

  it.each([
    ["Stay status", (input: ReturnType<typeof orderView>) => { input.stay.status = "IN_HOUSE"; }, "stay.status与订单状态不一致"],
    ["arrangement presentation", (input: ReturnType<typeof orderView>) => { input.effectiveArrangement.presentation = "LAST"; }, "effectiveArrangement.presentation与订单状态不一致"],
    ["order dates", (input: ReturnType<typeof orderView>) => { input.order.departure_date = "2026-07-31"; }, "effectiveArrangement日期与订单当前日期不一致"],
    ["fulfillment state", (input: ReturnType<typeof orderView>) => { input.fulfillment.state = "CANCELLED"; }, "fulfillment.state与订单状态不一致"]
  ])("rejects a %s contradiction across the order lifecycle layers", (_label, damage, expected) => {
    const input = orderView();
    damage(input);
    expect(() => parseOrderView(input)).toThrow(expected);
  });

  it("rejects fulfillment facts whose planned dates do not match the arrangement at fulfillment", () => {
    const input = orderView();
    input.order.status = "CHECKED_IN";
    input.stay.status = "IN_HOUSE";
    input.fulfillment.state = "IN_HOUSE";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-29", "2026-07-29T08:00:00.000Z");
    expect(() => parseOrderView(input)).toThrow("与履约时安排入住日不一致");

    input.order.status = "CHECKED_OUT";
    input.stay.status = "COMPLETED";
    input.effectiveArrangement.presentation = "LAST";
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-29", "2026-07-30T08:00:00.000Z");
    expect(() => parseOrderView(input)).toThrow("与履约时安排退房日不一致");
  });

  it("rejects internally inconsistent recording modes and reversed fulfillment record times", () => {
    const input = orderView();
    input.order.status = "CHECKED_OUT";
    input.stay.status = "COMPLETED";
    input.effectiveArrangement.presentation = "LAST";
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-30T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-30", "2026-07-29T08:00:00.000Z");
    expect(() => parseOrderView(input)).toThrow("退房记录时间早于入住记录时间");

    input.fulfillment.checkIn.recordedAt = "2026-07-28T08:00:00.000Z";
    input.fulfillment.checkOut.recordingMode = "LATE_RECORDED";
    expect(() => parseOrderView(input)).toThrow("迟录退房日期没有晚于计划退房日");
  });

  it("accepts a late-recorded check-in only after its planned arrival date", () => {
    const input = orderView();
    input.order.status = "CHECKED_IN";
    input.stay.status = "IN_HOUSE";
    input.fulfillment.state = "IN_HOUSE";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-29T08:00:00.000Z");
    input.fulfillment.checkIn.recordingMode = "LATE_RECORDED";
    input.fulfillment.checkIn.recordedBusinessDate = "2026-07-29";
    expect(parseOrderView(input)).toBe(input);

    input.fulfillment.checkIn.recordedBusinessDate = "2026-07-28";
    expect(() => parseOrderView(input)).toThrow("迟录入住日期没有晚于计划入住日");
  });

  it("requires history timestamps to be non-decreasing while allowing equal timestamps", () => {
    const reversed = orderView();
    appendHistoryTransition(reversed, "MOVE", movedArrangement(), "2026-07-28T07:59:59.999Z");
    expect(() => parseOrderView(reversed)).toThrow("早于上一条住宿安排变更");

    const equal = orderView();
    appendHistoryTransition(equal, "MOVE", movedArrangement(), "2026-07-28T08:00:00.000Z");
    expect(parseOrderView(equal)).toBe(equal);
  });

  it.each([
    "2026-07-28T08:00:00",
    "2026-02-29T08:00:00.000Z",
    "2026-07-28T24:00:00.000Z",
    "2026-07-28T08:00:00.000000001Z"
  ])("requires every business record time to use canonical UTC milliseconds: %s", (recordedAt) => {
    const input = orderView();
    input.arrangementHistory[0]!.recordedAt = recordedAt;
    expect(() => parseOrderView(input)).toThrow("必须是规范的 UTC 记录时间");
  });

  it("allows rescheduling to trim an edge segment but rejects changing retained-night rooms", () => {
    const trimmed = orderView();
    const before = movedArrangement();
    trimmed.originalArrangement = before;
    trimmed.effectiveArrangement = { ...before, presentation: "CURRENT", businessDate: "2026-07-28" };
    trimmed.arrangementHistory[0]!.after = before;
    appendHistoryTransition(trimmed, "RESCHEDULE", {
      arrivalDate: "2026-07-29",
      departureDate: "2026-07-30",
      intervals: [{ inventoryUnitId: "room_102", arrivalDate: "2026-07-29", departureDate: "2026-07-30" }]
    });
    expect(parseOrderView(trimmed)).toBe(trimmed);

    const reassigned = orderView();
    reassigned.originalArrangement = before;
    reassigned.effectiveArrangement = { ...before, presentation: "CURRENT", businessDate: "2026-07-28" };
    reassigned.arrangementHistory[0]!.after = before;
    appendHistoryTransition(reassigned, "RESCHEDULE", {
      arrivalDate: "2026-07-28",
      departureDate: "2026-07-31",
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-30" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-07-30", departureDate: "2026-07-31" }
      ]
    });
    expect(() => parseOrderView(reassigned)).toThrow("改期后的房源安排不符合已确认的换房节点平移与首尾裁剪规则");
  });

  it("uses the original last room when a reschedule is completely after the prior arrangement", () => {
    const input = orderView();
    const before = movedArrangement();
    input.originalArrangement = before;
    input.effectiveArrangement = { ...before, presentation: "CURRENT", businessDate: "2026-07-28" };
    input.arrangementHistory[0]!.after = before;
    appendHistoryTransition(input, "RESCHEDULE", {
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-02",
      intervals: [{ inventoryUnitId: "room_102", arrivalDate: "2026-08-01", departureDate: "2026-08-02" }]
    });

    expect(parseOrderView(input)).toBe(input);
  });

  it("uses the original first room before the prior arrangement and extends the last room for a later departure", () => {
    const before = movedArrangement();
    const earlier = orderView();
    earlier.originalArrangement = before;
    earlier.effectiveArrangement = { ...before, presentation: "CURRENT", businessDate: "2026-07-28" };
    earlier.arrangementHistory[0]!.after = before;
    appendHistoryTransition(earlier, "RESCHEDULE", {
      arrivalDate: "2026-07-20",
      departureDate: "2026-07-21",
      intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-07-20", departureDate: "2026-07-21" }]
    });
    expect(parseOrderView(earlier)).toBe(earlier);

    const extended = orderView();
    extended.originalArrangement = before;
    extended.effectiveArrangement = { ...before, presentation: "CURRENT", businessDate: "2026-07-28" };
    extended.arrangementHistory[0]!.after = before;
    appendHistoryTransition(extended, "RESCHEDULE", {
      arrivalDate: "2026-07-28",
      departureDate: "2026-07-31",
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-29" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-07-29", departureDate: "2026-07-31" }
      ]
    });
    expect(parseOrderView(extended)).toBe(extended);
  });

  it("accepts receipt-backed historical date corrections without rewriting prior fulfillment facts", () => {
    const input = orderView();
    const before = arrangement("room_101");
    const after = arrangement("room_102", "2026-07-29", "2026-07-31");
    input.order.status = "CHECKED_OUT";
    input.order.arrival_date = after.arrivalDate;
    input.order.departure_date = after.departureDate;
    input.stay.status = "COMPLETED";
    input.order.current_revision_id = "revision_1";
    input.currentSegment = {
      id: "segment_historical",
      sequence: 2,
      inventoryUnitId: "room_102",
      arrivalDate: after.arrivalDate,
      departureDate: after.departureDate
    };
    input.pricingRevisions[0]!.arrival_date = after.arrivalDate;
    input.pricingRevisions[0]!.departure_date = after.departureDate;
    input.effectiveArrangement = { ...after, presentation: "LAST", businessDate: "2026-07-30" };
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-30", "2026-07-30T08:00:00.000Z");
    input.arrangementHistory[0]!.after = before;
    input.arrangementHistory.push({
      type: "HISTORICAL_STAY_CORRECTION",
      before,
      after,
      reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "主管核对真实房源后修改" },
      actor: { subjectId: "administrator", displayName: "主管" },
      recordedAt: "2026-07-30T09:00:00.000Z",
      pricingSummary: {
        policyBaseAmount: money(20_000),
        currentContractAmount: money(20_000),
        differenceFromPolicy: money(0)
      },
      fundsSummary: {
        netRecordedCollection: money(0),
        collectionDifference: money(20_000),
        refundReferenceAmount: money(0),
        factCount: 0
      },
      correctionGroup: {
        correctionSetHash: "b".repeat(64),
        corrections: [{
          orderId: "order_u2",
          stayId: "stay_u2",
          correctionId: "correction_1",
          amendmentId: "amendment_historical",
          staySegmentId: "segment_historical",
          pricingRevisionId: "revision_1",
          before: {
            inventoryUnitId: "room_101",
            arrivalDate: "2026-07-28",
            departureDate: "2026-07-30",
            nights: 2,
            stayTimeline: [
              { serviceDate: "2026-07-28", inventoryUnitId: "room_101" },
              { serviceDate: "2026-07-29", inventoryUnitId: "room_101" }
            ]
          },
          after: {
            inventoryUnitId: "room_102",
            arrivalDate: "2026-07-29",
            departureDate: "2026-07-31",
            nights: 2,
            stayTimeline: [
              { serviceDate: "2026-07-29", inventoryUnitId: "room_102" },
              { serviceDate: "2026-07-30", inventoryUnitId: "room_102" }
            ]
          }
        }],
        reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "主管核对真实房源后修改" },
        actor: { subjectId: "administrator", displayName: "主管" },
        recordedAt: "2026-07-30T09:00:00.000Z"
      }
    });
    expect(parseOrderView(input)).toBe(input);

    input.fulfillment.checkIn!.plannedBusinessDate = "2026-07-27";
    input.fulfillment.checkIn!.recordedBusinessDate = "2026-07-27";
    expect(() => parseOrderView(input)).toThrow("与履约时安排入住日不一致");
    input.fulfillment.checkIn!.plannedBusinessDate = "2026-07-28";
    input.fulfillment.checkIn!.recordedBusinessDate = "2026-07-28";

    delete input.arrangementHistory[1]!.correctionGroup;
    expect(() => parseOrderView(input)).toThrow("历史住宿安排修改必须包含完整的同批修改记录");
  });

  it("accepts a suffix-overlay extension but rejects appending an unrelated room after departure", () => {
    const overlay = orderView();
    appendHistoryTransition(overlay, "EXTENSION", {
      arrivalDate: "2026-07-28",
      departureDate: "2026-07-31",
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-29" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-07-29", departureDate: "2026-07-31" }
      ]
    });
    expect(parseOrderView(overlay)).toBe(overlay);

    const appended = orderView();
    appendHistoryTransition(appended, "EXTENSION", {
      arrivalDate: "2026-07-28",
      departureDate: "2026-07-31",
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-07-28", departureDate: "2026-07-30" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-07-30", departureDate: "2026-07-31" }
      ]
    });
    expect(() => parseOrderView(appended)).toThrow("续住必须保留原安排并延长退房日");
  });

  it.each([
    ["pricing currency", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.pricingSummary.policyBaseAmount.currency = "USD"; }, "金额摘要币种不一致"],
    ["currency format", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.pricingSummary.policyBaseAmount.currency = "cny"; }, "必须是三位大写货币代码"],
    ["policy difference", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.pricingSummary.differenceFromPolicy.minorUnits = 1; }, "与政策基础金额差额不一致"],
    ["collection difference", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.fundsSummary.collectionDifference.minorUnits = 19_999; }, "资金差额不一致"],
    ["refund reference", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.fundsSummary.refundReferenceAmount.minorUnits = 1; }, "退款参考金额不一致"]
  ])("rejects inconsistent history money for %s", (_label, damage, expected) => {
    const input = orderView();
    damage(input);
    expect(() => parseOrderView(input)).toThrow(expected);
  });

  it("rejects a currency change between otherwise consistent history summaries", () => {
    const input = orderView();
    appendHistoryTransition(input, "MOVE", movedArrangement());
    const changed = input.arrangementHistory[1]!;
    changed.pricingSummary.policyBaseAmount.currency = "USD";
    changed.pricingSummary.currentContractAmount.currency = "USD";
    changed.pricingSummary.differenceFromPolicy.currency = "USD";
    changed.fundsSummary.netRecordedCollection.currency = "USD";
    changed.fundsSummary.collectionDifference.currency = "USD";
    changed.fundsSummary.refundReferenceAmount.currency = "USD";
    expect(() => parseOrderView(input)).toThrow("与上一条住宿安排变更币种不一致");
  });

  it("accepts a later standalone repricing when the accommodation arrangement is unchanged", () => {
    const input = orderView();
    input.order.current_revision_id = "revision_2";
    input.amendments.push(amendment({
      id: "amendment_2",
      sequence: 2,
      amendment_type: "REPRICE_ORDER",
      reason_code: "GUEST_PRICE_NEGOTIATION",
      reason_note: "住客协商调价",
      prior_version: 1,
      new_version: 2,
      created_at: "2026-07-28T08:59:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "MANUAL_ADJUSTMENT",
      manual_adjustment_minor: -5_000,
      current_contract_amount_minor: 15_000,
      difference_from_policy_minor: -5_000,
      reason: { code: "GUEST_PRICE_NEGOTIATION", note: "住客协商调价" },
      created_at: "2026-07-28T09:00:00.000Z"
    });
    input.amounts.currentContractAmount.minorUnits = 15_000;
    input.amounts.collectionDifference.minorUnits = 15_000;

    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts a strict member repricing from 13000 to 11000 with a business reason code", () => {
    const input = memberRepriceView();
    expect(input.pricingRevisions[1]!.reason.code).not.toBe("REPRICE_ORDER");
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts a strict zero-difference member repricing back to policy price", () => {
    const input = memberRepriceView({ historyAmount: 11_000, targetAmount: 13_000 });
    expect(input.pricingRevisions[1]).toMatchObject({
      pricing_basis: "MEMBER_ENTITLEMENT",
      manual_adjustment_minor: 0,
      difference_from_policy_minor: 0
    });
    expect(parseOrderView(input)).toBe(input);
  });

  it.each([
    ["missing amendment", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments.splice(1, 1);
    }],
    ["duplicate amendment id", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments.push({ ...input.amendments[1]! });
    }],
    ["mismatched amendment id", (input: ReturnType<typeof memberRepriceView>) => {
      input.pricingRevisions[1]!.amendment_id = "amendment_missing";
    }],
    ["cross-order amendment", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments[1]!.order_id = "order_other";
    }],
    ["wrong amendment type", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments[1]!.amendment_type = "MOVE_UNIT";
    }],
    ["amendment reason code mismatch", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments[1]!.reason_code = "OTHER_BUSINESS_REASON";
    }],
    ["amendment reason note mismatch", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments[1]!.reason_note = "另一份说明";
    }],
    ["empty reason note", (input: ReturnType<typeof memberRepriceView>) => {
      input.pricingRevisions[1]!.reason.note = "   ";
      input.amendments[1]!.reason_note = "   ";
    }],
    ["amendment created after revision", (input: ReturnType<typeof memberRepriceView>) => {
      input.amendments[1]!.created_at = "2026-07-28T09:01:00.000Z";
    }],
    ["repricing is the first pricing record", (input: ReturnType<typeof memberRepriceView>) => {
      const repricing = input.pricingRevisions[1]!;
      repricing.revision_no = 1;
      input.pricingRevisions = [repricing];
    }],
    ["revision number does not match its index", (input: ReturnType<typeof memberRepriceView>) => {
      input.pricingRevisions[1]!.revision_no = 3;
    }],
    ["non-member order", (input: ReturnType<typeof memberRepriceView>) => {
      input.order.member_id = null;
      input.order.member_contract_id = null;
    }],
    ["missing member contract", (input: ReturnType<typeof memberRepriceView>) => {
      input.order.member_contract_id = null;
    }],
    ["missing member", (input: ReturnType<typeof memberRepriceView>) => {
      input.order.member_id = null;
    }],
    ["empty member contract", (input: ReturnType<typeof memberRepriceView>) => {
      (input.order as unknown as { member_contract_id: string }).member_contract_id = "";
    }],
    ["empty member", (input: ReturnType<typeof memberRepriceView>) => {
      (input.order as unknown as { member_id: string }).member_id = "";
    }],
    ["manual adjustment formula mismatch", (input: ReturnType<typeof memberRepriceView>) => {
      input.pricingRevisions[1]!.manual_adjustment_minor += 1;
    }]
  ])("rejects a damaged standalone member repricing: %s", (_label, damage) => {
    const input = memberRepriceView();
    damage(input);
    expect(() => parseOrderView(input)).toThrow(OrderViewValidationError);
  });

  it.each(["POLICY", "CHANNEL_CONTRACT", "FREE", "MANUAL_ADJUSTMENT"] as const)(
    "rejects a member standalone repricing with damaged %s basis",
    (pricingBasis) => {
      const input = memberRepriceView();
      input.pricingRevisions[1]!.pricing_basis = pricingBasis;
      expect(() => parseOrderView(input)).toThrow(OrderViewValidationError);
    }
  );

  it("rejects a zero-difference member repricing unless the same strict predicate holds", () => {
    const input = memberRepriceView({ historyAmount: 11_000, targetAmount: 13_000 });
    input.amendments[1]!.amendment_type = "MOVE_UNIT";
    expect(() => parseOrderView(input)).toThrow("没有合法的后续独立调价记录");
  });

  it("accepts a later standalone repricing that returns the unchanged stay to policy price", () => {
    const input = orderView();
    input.arrangementHistory[0]!.pricingSummary.currentContractAmount.minorUnits = 15_000;
    input.arrangementHistory[0]!.pricingSummary.differenceFromPolicy.minorUnits = -5_000;
    input.arrangementHistory[0]!.fundsSummary.collectionDifference.minorUnits = 15_000;
    input.order.current_revision_id = "revision_2";
    input.amendments.push(amendment({
      id: "amendment_2",
      sequence: 2,
      amendment_type: "REPRICE_ORDER",
      reason_code: "RETURN_TO_POLICY",
      reason_note: "恢复政策价",
      prior_version: 1,
      new_version: 2,
      created_at: "2026-07-28T08:59:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "POLICY",
      policy_base_amount_minor: 20_000,
      current_contract_amount_minor: 20_000,
      difference_from_policy_minor: 0,
      manual_adjustment_minor: 0,
      reason: { code: "RETURN_TO_POLICY", note: "恢复政策价" },
      created_at: "2026-07-28T09:00:00.000Z"
    });

    expect(parseOrderView(input)).toBe(input);
  });

  it.each([
    ["contract differs from policy", (input: ReturnType<typeof orderView>) => {
      input.pricingRevisions[1]!.current_contract_amount_minor = 19_000;
      input.pricingRevisions[1]!.difference_from_policy_minor = -1_000;
      input.amounts.currentContractAmount.minorUnits = 19_000;
      input.amounts.collectionDifference.minorUnits = 19_000;
    }],
    ["non-zero manual adjustment", (input: ReturnType<typeof orderView>) => {
      input.pricingRevisions[1]!.manual_adjustment_minor = 1;
    }],
    ["wrong reason", (input: ReturnType<typeof orderView>) => {
      input.pricingRevisions[1]!.reason.code = "CREATE_ORDER";
    }]
  ])("rejects a damaged standalone policy repricing: %s", (_label, damage) => {
    const input = orderView();
    input.arrangementHistory[0]!.pricingSummary.currentContractAmount.minorUnits = 15_000;
    input.arrangementHistory[0]!.pricingSummary.differenceFromPolicy.minorUnits = -5_000;
    input.arrangementHistory[0]!.fundsSummary.collectionDifference.minorUnits = 15_000;
    input.order.current_revision_id = "revision_2";
    input.amendments.push(amendment({
      id: "amendment_2",
      sequence: 2,
      amendment_type: "REPRICE_ORDER",
      reason_code: "RETURN_TO_POLICY",
      reason_note: "恢复政策价",
      prior_version: 1,
      new_version: 2,
      created_at: "2026-07-28T08:59:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "POLICY",
      reason: { code: "RETURN_TO_POLICY", note: "恢复政策价" },
      created_at: "2026-07-28T09:00:00.000Z"
    });
    damage(input);

    expect(() => parseOrderView(input)).toThrow();
  });

  it.each([
    ["amendment reason mismatch", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.reason.code = "OTHER_REASON"; }, "没有合法的后续独立调价记录"],
    ["wrong basis", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.pricing_basis = "POLICY"; }, "人工调价差额不一致"],
    ["changed arrival", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.arrival_date = "2026-07-29"; }, "与当前住宿安排日期不一致"],
    ["changed departure", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.departure_date = "2026-07-31"; }, "与当前住宿安排日期不一致"],
    ["predates arrangement", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.created_at = "2026-07-27T09:00:00.000Z"; }, "没有合法的后续独立调价记录"]
  ])("rejects an amount mismatch without a valid later standalone repricing: %s", (_label, damage, expected) => {
    const input = orderView();
    input.order.current_revision_id = "revision_2";
    input.amendments.push(amendment({
      id: "amendment_2",
      sequence: 2,
      amendment_type: "REPRICE_ORDER",
      reason_code: "GUEST_PRICE_NEGOTIATION",
      reason_note: "住客协商调价",
      prior_version: 1,
      new_version: 2,
      created_at: "2026-07-28T08:59:00.000Z"
    }));
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "MANUAL_ADJUSTMENT",
      manual_adjustment_minor: -5_000,
      current_contract_amount_minor: 15_000,
      difference_from_policy_minor: -5_000,
      reason: { code: "GUEST_PRICE_NEGOTIATION", note: "住客协商调价" },
      created_at: "2026-07-28T09:00:00.000Z"
    });
    input.amounts.currentContractAmount.minorUnits = 15_000;
    input.amounts.collectionDifference.minorUnits = 15_000;
    damage(input);

    expect(() => parseOrderView(input)).toThrow(expected);
  });

  it("rejects a standalone repricing whose current currency differs from the accommodation history", () => {
    const input = orderView();
    const history = input.arrangementHistory[0]!;
    history.pricingSummary.policyBaseAmount.currency = "USD";
    history.pricingSummary.currentContractAmount.currency = "USD";
    history.pricingSummary.differenceFromPolicy.currency = "USD";
    history.fundsSummary.netRecordedCollection.currency = "USD";
    history.fundsSummary.collectionDifference.currency = "USD";
    history.fundsSummary.refundReferenceAmount.currency = "USD";

    expect(() => parseOrderView(input)).toThrow("与最新住宿安排计价摘要币种不一致");
  });

  it.each([
    ["unknown basis", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.pricing_basis = "MANUAL" as never; }, "不是支持的计价方式"],
    ["negative policy base", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.policy_base_amount_minor = -1; }, "必须是非负金额"],
    ["negative contract amount", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.current_contract_amount_minor = -1; }, "必须是非负金额"],
    ["wrong difference", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.difference_from_policy_minor = 1; }, "与政策基础金额差额不一致"],
    ["wrong manual adjustment", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.manual_adjustment_minor = 1; }, "人工调价差额不一致"],
    ["cross-order revision", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.order_id = "order_other"; }, "与订单不一致"],
    ["invalid revision dates", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.departure_date = input.pricingRevisions[0]!.arrival_date; }, "日期区间无效"],
    ["current revision arrival mismatch", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.arrival_date = "2026-07-29"; }, "与当前住宿安排日期不一致"],
    ["current revision departure mismatch", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[0]!.departure_date = "2026-07-31"; }, "与当前住宿安排日期不一致"]
  ])("rejects a damaged pricing revision: %s", (_label, damage, expected) => {
    const input = orderView();
    damage(input);
    expect(() => parseOrderView(input)).toThrow(expected);
  });

  it.each([
    ["RESCHEDULE", arrangement("room_101", "2026-07-29", "2026-07-31")],
    ["EXTENSION", arrangement("room_101", "2026-07-28", "2026-07-31")],
    ["SHORTENING", arrangement("room_101", "2026-07-28", "2026-07-29")],
    ["MOVE", movedArrangement()],
    ["EARLY_CHECK_OUT", arrangement("room_101", "2026-07-28", "2026-07-29")]
  ])("accepts a %s history item only when its before and after arrangements agree", (type, after) => {
    const input = orderView();
    appendHistoryTransition(input, type, after);
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts Scheme B when an equal reschedule shifts every existing move boundary", () => {
    const input = orderView();
    appendHistoryTransition(input, "MOVE", movedArrangement());
    appendHistoryTransition(input, "RESCHEDULE", {
      arrivalDate: "2026-07-29",
      departureDate: "2026-07-31",
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-07-29", departureDate: "2026-07-30" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-07-30", departureDate: "2026-07-31" }
      ]
    }, "2026-07-28T10:00:00.000Z");
    expect(parseOrderView(input)).toBe(input);
  });

  it.each([
    ["RESCHEDULE_STAY", "LEGACY_STAGE_9_10"],
    ["EXTEND_STAY", "LEGACY_STAGE_9_10"],
    ["SHORTEN_STAY", "LEGACY_STAGE_10"],
    ["SHORTEN_STAY", "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"],
    ["MOVE_UNIT", "PRE_STAGE_11"],
    ["MOVE_UNIT", "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"]
  ])("accepts the exact historical protocol metadata for %s", (amendmentType, protocolVersion) => {
    const input = orderView();
    Object.assign(input.amendments[0]!, {
      amendment_type: amendmentType,
      protocolVersion,
      recoveryMode: "HISTORICAL_READ_ONLY"
    });
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts historical collection facts without a pricing revision association", () => {
    const input = orderView();
    input.collectionFacts.push({
      fact_id: "fact_historical_null_revision",
      order_id: input.order.id,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      note: "",
      transaction_reference: "HISTORICAL-CASH-001",
      cash_collector: null,
      pricing_revision_id: null,
      command_id: "command_historical_null_revision",
      created_at: "2026-07-28T08:00:00.000Z"
    } as never);
    input.amounts.netRecordedCollection.minorUnits += 100;
    input.amounts.collectionDifference.minorUnits -= 100;
    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts the cash collector evidence on collection facts", () => {
    const input = orderView();
    const collectionFact: CollectionFactDto = {
      fact_id: "fact_backfill_cash",
      order_id: input.order.id,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      cash_collector: "前台甲",
      note: "补录现金收款",
      transaction_reference: null,
      pricing_revision_id: "revision_1",
      command_id: "command_backfill_cash",
      created_at: "2026-07-28T08:00:00.000Z"
    };
    input.collectionFacts.push(collectionFact as never);
    input.amounts.netRecordedCollection.minorUnits += 100;
    input.amounts.collectionDifference.minorUnits -= 100;
    expect(parseOrderView(input)).toBe(input);

    collectionFact.cash_collector = null;
    expect(parseOrderView(input)).toBe(input);

    collectionFact.cash_collector = 123 as never;
    expect(() => parseOrderView(input)).toThrow("collectionFacts[0].cash_collector必须是非空文字");
  });

  it.each([
    ["extension that changes rooms without extending", "EXTENSION", movedArrangement(), "续住必须保留原安排并延长退房日"],
    ["reschedule that also changes rooms", "RESCHEDULE", arrangement("room_102", "2026-07-29", "2026-07-31"), "改期后的房源安排不符合已确认的换房节点平移与首尾裁剪规则"],
    ["move without an inventory change", "MOVE", arrangement(), "换房必须只改变住宿周期内的房源安排"],
    ["move containing multiple inventory transitions", "MOVE", roundTripMoveArrangement(), "换房必须只改变住宿周期内的房源安排"],
    ["second initial booking", "INITIAL_BOOKING", arrangement(), "初始预订不能包含变更前安排"]
  ])("rejects a history type mismatch for %s", (_label, type, after, expected) => {
    const input = orderView();
    appendHistoryTransition(input, type, after);
    expect(() => parseOrderView(input)).toThrow(expected);
  });

  it.each([
    ["missing occupants", (input: ReturnType<typeof orderView>) => { delete (input as Partial<typeof input>).occupants; }, "根节点.occupants缺失"],
    ["malformed amount", (input: ReturnType<typeof orderView>) => { input.amounts.currentContractAmount.minorUnits = 1.5; }, "必须是安全整数"],
    ["stale current revision", (input: ReturnType<typeof orderView>) => { input.order.current_revision_id = "revision_stale"; }, "与订单当前计价指针或金额不一致"],
    ["collection total mismatch", (input: ReturnType<typeof orderView>) => { input.amounts.netRecordedCollection.minorUnits = 100; input.amounts.collectionDifference.minorUnits = 19_900; }, "净影响合计与已记录净收款不一致"],
    ["unexpected root field", (input: ReturnType<typeof orderView>) => { Object.assign(input, { rawPayload: {} }); }, "根节点.rawPayload不是允许的字段"],
    ["unexpected order field", (input: ReturnType<typeof orderView>) => { Object.assign(input.order, { rawStatus: "RESERVED" }); }, "order.rawStatus不是允许的字段"],
    ["malformed segment", (input: ReturnType<typeof orderView>) => { input.segments[0]!.stay_id = "stay_other"; }, "segments[0].stay_id与住宿不一致"],
    ["unknown historical protocol", (input: ReturnType<typeof orderView>) => {
      Object.assign(input.amendments[0]!, { amendment_type: "MOVE_UNIT", protocolVersion: "STAGE_UNKNOWN", recoveryMode: "HISTORICAL_READ_ONLY" });
    }, "amendments[0].protocolVersion与住宿变更类型不一致"],
    ["historical protocol without recovery marker", (input: ReturnType<typeof orderView>) => {
      Object.assign(input.amendments[0]!, { amendment_type: "MOVE_UNIT", protocolVersion: "PRE_STAGE_11" });
    }, "历史协议版本与只读恢复标记必须成对提供"],
    ["recovery marker without historical protocol", (input: ReturnType<typeof orderView>) => {
      Object.assign(input.amendments[0]!, { amendment_type: "MOVE_UNIT", recoveryMode: "HISTORICAL_READ_ONLY" });
    }, "历史协议版本与只读恢复标记必须成对提供"],
    ["historical protocol for the wrong amendment type", (input: ReturnType<typeof orderView>) => {
      Object.assign(input.amendments[0]!, { amendment_type: "SHORTEN_STAY", protocolVersion: "PRE_STAGE_11", recoveryMode: "HISTORICAL_READ_ONLY" });
    }, "amendments[0].protocolVersion与住宿变更类型不一致"],
    ["pre-in-house-membership protocol for an unrelated amendment", (input: ReturnType<typeof orderView>) => {
      Object.assign(input.amendments[0]!, {
        amendment_type: "EXTEND_STAY",
        protocolVersion: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT",
        recoveryMode: "HISTORICAL_READ_ONLY"
      });
    }, "amendments[0].protocolVersion与住宿变更类型不一致"],
    ["unsupported historical recovery marker", (input: ReturnType<typeof orderView>) => {
      Object.assign(input.amendments[0]!, { amendment_type: "MOVE_UNIT", protocolVersion: "PRE_STAGE_11", recoveryMode: "RECOVERABLE" });
    }, "amendments[0].recoveryMode不是支持的历史读取模式"],
    ["unexpected collection field", (input: ReturnType<typeof orderView>) => {
      input.collectionFacts.push({
        fact_id: "fact_1", order_id: "order_u2", fact_type: "COLLECTION", amount_minor: 100, net_effect_minor: 100,
        currency: "CNY", references_fact_id: null, reverses_fact_id: null, method: "CASH", note: "", transaction_reference: null, cash_collector: null,
        pricing_revision_id: "revision_1", command_id: "command_1", created_at: "2026-07-28T08:00:00.000Z", raw: true
      } as never);
    }, "collectionFacts[0].raw不是允许的字段"],
    ["write action under read access", (input: ReturnType<typeof orderView>) => {
      (input as { accessLevel: string }).accessLevel = "READ";
      (input as { allowedActions: Array<{ code: string; enabled: boolean; disabledReason: string | null }> }).allowedActions = [{ code: "CHECK_IN", enabled: true, disabledReason: null }];
    }, "只读权限不能包含可执行写操作"]
  ])("fails closed for U2-visible DTO damage: %s", (_label, damage, expected) => {
    const input = orderView();
    damage(input);
    expect(() => parseOrderView(input)).toThrow(expected);
  });
});
