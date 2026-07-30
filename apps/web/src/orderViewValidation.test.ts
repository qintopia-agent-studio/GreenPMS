import { describe, expect, it } from "vitest";
import type { OrderArrangementDto, OrderArrangementHistoryItemDto } from "@qintopia/contracts";
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

function fulfillmentFact(type: "CHECK_IN" | "CHECK_OUT", plannedBusinessDate: string, recordedAt: string) {
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
    segments: [{ segment_type: "INITIAL" }],
    amendments: [{ payload: { temptingFallback: true } }],
    originalArrangement: original,
    effectiveArrangement: {
      ...original,
      presentation: "CURRENT",
      businessDate: "2026-07-28"
    },
    fulfillment: {
      state: "NOT_CHECKED_IN",
      checkIn: null as ReturnType<typeof fulfillmentFact> | null,
      checkOut: null as ReturnType<typeof fulfillmentFact> | null
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
  it("accepts a complete typed lifecycle projection without reading raw facts", () => {
    const input = orderView();
    expect(parseOrderView(input)).toBe(input);
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
    expect(() => parseOrderView(input)).toThrow("履约状态与入住、退房记录不一致");
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

  it("rejects fulfillment facts whose planned dates do not match the effective arrangement", () => {
    const input = orderView();
    input.order.status = "CHECKED_IN";
    input.stay.status = "IN_HOUSE";
    input.fulfillment.state = "IN_HOUSE";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-29", "2026-07-29T08:00:00.000Z");
    expect(() => parseOrderView(input)).toThrow("与当前安排入住日不一致");

    input.order.status = "CHECKED_OUT";
    input.stay.status = "COMPLETED";
    input.effectiveArrangement.presentation = "LAST";
    input.fulfillment.state = "CHECKED_OUT";
    input.fulfillment.checkIn = fulfillmentFact("CHECK_IN", "2026-07-28", "2026-07-28T08:00:00.000Z");
    input.fulfillment.checkOut = fulfillmentFact("CHECK_OUT", "2026-07-29", "2026-07-30T08:00:00.000Z");
    expect(() => parseOrderView(input)).toThrow("与当前安排退房日不一致");
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
    expect(() => parseOrderView(reassigned)).toThrow("改期必须只改变住宿日期");
  });

  it("allows a disjoint reschedule to retain a contiguous room sequence edge", () => {
    const input = orderView();
    const before = movedArrangement();
    input.originalArrangement = before;
    input.effectiveArrangement = { ...before, presentation: "CURRENT", businessDate: "2026-07-28" };
    input.arrangementHistory[0]!.after = before;
    appendHistoryTransition(input, "RESCHEDULE", {
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-02",
      intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-08-01", departureDate: "2026-08-02" }]
    });

    expect(parseOrderView(input)).toBe(input);
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
    ["collection difference", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.fundsSummary.collectionDifference.minorUnits = 19_999; }, "待收或多收差额不一致"],
    ["refund reference", (input: ReturnType<typeof orderView>) => { input.arrangementHistory[0]!.fundsSummary.refundReferenceAmount.minorUnits = 1; }, "建议退款金额不一致"]
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
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "MANUAL_ADJUSTMENT",
      manual_adjustment_minor: -5_000,
      current_contract_amount_minor: 15_000,
      difference_from_policy_minor: -5_000,
      reason: { code: "REPRICE_ORDER", note: "住客协商调价" },
      created_at: "2026-07-28T09:00:00.000Z"
    });
    input.amounts.currentContractAmount.minorUnits = 15_000;
    input.amounts.collectionDifference.minorUnits = 15_000;

    expect(parseOrderView(input)).toBe(input);
  });

  it("accepts a later standalone repricing that returns the unchanged stay to policy price", () => {
    const input = orderView();
    input.arrangementHistory[0]!.pricingSummary.currentContractAmount.minorUnits = 15_000;
    input.arrangementHistory[0]!.pricingSummary.differenceFromPolicy.minorUnits = -5_000;
    input.arrangementHistory[0]!.fundsSummary.collectionDifference.minorUnits = 15_000;
    input.order.current_revision_id = "revision_2";
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
      reason: { code: "REPRICE_ORDER", note: "恢复政策价" },
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
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "POLICY",
      reason: { code: "REPRICE_ORDER", note: "恢复政策价" },
      created_at: "2026-07-28T09:00:00.000Z"
    });
    damage(input);

    expect(() => parseOrderView(input)).toThrow();
  });

  it.each([
    ["wrong reason", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.reason.code = "CREATE_ORDER"; }, "没有合法的后续独立调价记录"],
    ["wrong basis", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.pricing_basis = "POLICY"; }, "人工调价差额不一致"],
    ["changed arrival", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.arrival_date = "2026-07-29"; }, "与当前住宿安排日期不一致"],
    ["changed departure", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.departure_date = "2026-07-31"; }, "与当前住宿安排日期不一致"],
    ["predates arrangement", (input: ReturnType<typeof orderView>) => { input.pricingRevisions[1]!.created_at = "2026-07-27T09:00:00.000Z"; }, "没有合法的后续独立调价记录"]
  ])("rejects an amount mismatch without a valid later standalone repricing: %s", (_label, damage, expected) => {
    const input = orderView();
    input.order.current_revision_id = "revision_2";
    input.pricingRevisions.push({
      ...input.pricingRevisions[0]!,
      id: "revision_2",
      revision_no: 2,
      amendment_id: "amendment_2",
      pricing_basis: "MANUAL_ADJUSTMENT",
      manual_adjustment_minor: -5_000,
      current_contract_amount_minor: 15_000,
      difference_from_policy_minor: -5_000,
      reason: { code: "REPRICE_ORDER", note: "住客协商调价" },
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

  it.each([
    ["extension that changes rooms without extending", "EXTENSION", movedArrangement(), "续住必须保留原安排并延长退房日"],
    ["reschedule that also changes rooms", "RESCHEDULE", arrangement("room_102", "2026-07-29", "2026-07-31"), "改期必须只改变住宿日期"],
    ["move without an inventory change", "MOVE", arrangement(), "换房必须只改变住宿周期内的房源安排"],
    ["move containing multiple inventory transitions", "MOVE", roundTripMoveArrangement(), "换房必须只改变住宿周期内的房源安排"],
    ["second initial booking", "INITIAL_BOOKING", arrangement(), "初始预订不能包含变更前安排"]
  ])("rejects a history type mismatch for %s", (_label, type, after, expected) => {
    const input = orderView();
    appendHistoryTransition(input, type, after);
    expect(() => parseOrderView(input)).toThrow(expected);
  });

  it.each([
    ["missing occupants", (input: ReturnType<typeof orderView>) => { delete (input as Partial<typeof input>).occupants; }, "occupants必须是数组"],
    ["malformed amount", (input: ReturnType<typeof orderView>) => { input.amounts.currentContractAmount.minorUnits = 1.5; }, "必须是安全整数"],
    ["stale current revision", (input: ReturnType<typeof orderView>) => { input.order.current_revision_id = "revision_stale"; }, "与订单当前计价指针或金额不一致"],
    ["collection total mismatch", (input: ReturnType<typeof orderView>) => { input.amounts.netRecordedCollection.minorUnits = 100; input.amounts.collectionDifference.minorUnits = 19_900; }, "净影响合计与已登记净收款不一致"],
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
