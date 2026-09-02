import { describe, expect, it } from "vitest";
import { orderActionCodes } from "@qintopia/contracts";
import { orderAllowedActions, pricingReasonFromAmendment, projectOrderFulfillment, projectOrderLifecycle } from "./orders.ts";

const allOrderActionGrants = new Set(orderActionCodes);

describe("pricingReasonFromAmendment", () => {
  it.each(["RESCHEDULE_STAY", "EXTEND_STAY", "SHORTEN_STAY", "MOVE_UNIT"])("keeps the typed pricing reason separate from the %s stay-change reason", (amendmentType) => {
    expect(pricingReasonFromAmendment({
      amendment_type: amendmentType,
      reason_code: "STAY_CHANGE",
      reason_note: "住客调整行程",
      payload: {
        pricingDecision: {
          reason: { code: "RESCHEDULE_STAY_CHANNEL_CONTRACT", note: "渠道活动价格重新确认" }
        }
      }
    })).toEqual({ code: "RESCHEDULE_STAY_CHANNEL_CONTRACT", note: "渠道活动价格重新确认" });
  });

  it("fails closed when a Stage 9 pricing reason is damaged", () => {
    expect(() => pricingReasonFromAmendment({
      amendment_type: "RESCHEDULE_STAY",
      reason_code: "STAY_CHANGE",
      reason_note: "住客调整行程",
      payload: { pricingDecision: {} }
    })).toThrow("订单住宿日期变更的计价原因损坏");
  });

  it("fails closed when a MOVE_UNIT pricing reason is damaged", () => {
    expect(() => pricingReasonFromAmendment({
      amendment_type: "MOVE_UNIT",
      reason_code: "ROOM_MOVE",
      reason_note: "住客申请换房",
      payload: { after: { stayTimeline: [] }, pricingDecision: { reason: { code: "MOVE_UNIT_POLICY" } } }
    })).toThrow("订单住宿日期变更的计价原因损坏");
  });

  it("keeps a pre-Stage 11 MOVE_UNIT readable through its amendment reason", () => {
    expect(pricingReasonFromAmendment({
      amendment_type: "MOVE_UNIT",
      reason_code: "ROOM_MOVE",
      reason_note: "历史换房记录",
      payload: { stayTimeline: [], pricing: {} },
      protocolVersion: "PRE_STAGE_11"
    })).toEqual({ code: "ROOM_MOVE", note: "历史换房记录" });
  });
});

function action(
  status: string,
  code: string,
  hasRefundableCollection = false,
  fulfillmentDates?: { businessDate: string; arrivalDate: string; departureDate: string; localTime?: string },
  hasFutureMove = false,
  completeStayFacts?: {
    stayStatus: string;
    hasCheckIn: boolean;
    hasCheckOut: boolean;
    hasCheckInRevocation: boolean;
  }
) {
  return orderAllowedActions(
    "WRITE",
    status,
    hasRefundableCollection,
    fulfillmentDates,
    hasFutureMove,
    null,
    false,
    false,
    completeStayFacts,
    allOrderActionGrants
  )
    .find((candidate) => candidate.code === code);
}

describe("orderAllowedActions", () => {
  it("returns no write actions for READ access", () => {
    for (const status of ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]) {
      expect(orderAllowedActions("READ", status, true)).toEqual([]);
    }
  });

  it("filters write actions by exact command grants while preserving existing staff operations", () => {
    const ordinaryStaffGrants = new Set([
      "CHECK_IN",
      "CHECK_OUT",
      "SHORTEN_STAY",
      "MOVE_UNIT",
      "REPRICE_ORDER",
      "CANCEL_ORDER",
      "MARK_NO_SHOW",
      "REVOKE_CHECK_IN",
      "RECORD_COLLECTION",
      "RECORD_REFUND",
      "REVERSE_FACT",
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    ]);
    const checkedIn = orderAllowedActions(
      "WRITE",
      "CHECKED_IN",
      true,
      { businessDate: "2026-08-01", arrivalDate: "2026-08-01", departureDate: "2026-08-03" },
      false,
      "WECOM",
      true,
      false,
      undefined,
      ordinaryStaffGrants
    );
    expect(checkedIn.map((candidate) => candidate.code)).not.toContain("CORRECT_ORDER_OCCUPANT");
    expect(checkedIn.find((candidate) => candidate.code === "REPRICE_ORDER")).toMatchObject({ enabled: true });
    expect(checkedIn.find((candidate) => candidate.code === "RECORD_REFUND")).toMatchObject({ enabled: true });
    expect(checkedIn.find((candidate) => candidate.code === "REVOKE_CHECK_IN")).toMatchObject({ enabled: true });
    expect(checkedIn.find((candidate) => candidate.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")).toMatchObject({ enabled: true });

    const administrator = orderAllowedActions(
      "WRITE",
      "CHECKED_OUT",
      false,
      undefined,
      false,
      null,
      false,
      false,
      undefined,
      new Set(["CORRECT_ORDER_OCCUPANT"])
    );
    expect(administrator).toEqual([{ code: "CORRECT_ORDER_OCCUPANT", enabled: true, disabledReason: null }]);

    expect(orderAllowedActions(
      "WRITE",
      "CHECKED_IN",
      true,
      undefined,
      false,
      null,
      false,
      false,
      undefined,
      new Set(["REPRICE_*", "ADMIN", "reprice_order"])
    )).toEqual([]);
  });

  it("enables reverse fact for ordinary staff only through an exact command grant", () => {
    expect(orderAllowedActions(
      "WRITE",
      "CHECKED_IN",
      false,
      undefined,
      false,
      null,
      false,
      false,
      undefined,
      new Set(["REVERSE_FACT"])
    )).toEqual([{ code: "REVERSE_FACT", enabled: true, disabledReason: null }]);

    expect(orderAllowedActions(
      "WRITE",
      "CHECKED_IN",
      false,
      undefined,
      false,
      null,
      false,
      false,
      undefined,
      new Set(["reverse_fact", "REVERSE_*"])
    )).toEqual([]);
  });

  it("enables scheduled and late-recorded check-in only before the planned departure date", () => {
    const future = { businessDate: "2026-07-25", arrivalDate: "2026-08-01", departureDate: "2026-08-03" };
    expect(action("RESERVED", "CHECK_IN", false, future)).toEqual({
      code: "CHECK_IN",
      enabled: false,
      disabledReason: "ARRIVAL_DATE_NOT_REACHED"
    });
    expect(action("CHECKED_IN", "CHECK_OUT", false, future)).toEqual({
      code: "CHECK_OUT",
      enabled: false,
      disabledReason: "DEPARTURE_DATE_NOT_REACHED"
    });
    expect(action("RESERVED", "CANCEL_ORDER", false, future)?.enabled).toBe(true);
    expect(action("RESERVED", "CHECK_IN", false, { ...future, businessDate: future.arrivalDate })?.enabled).toBe(true);
    expect(action("CHECKED_IN", "CHECK_OUT", false, { ...future, businessDate: future.departureDate })?.enabled).toBe(true);
    expect(action("RESERVED", "CHECK_IN", false, { ...future, businessDate: "2026-08-02" })).toEqual({
      code: "CHECK_IN",
      enabled: true,
      disabledReason: null
    });
    expect(action("RESERVED", "CHECK_IN", false, { ...future, businessDate: future.departureDate })).toMatchObject({
      enabled: false,
      disabledReason: "已到或超过计划退房日，不能补办入住"
    });
    expect(action("CHECKED_IN", "CHECK_OUT", false, { ...future, businessDate: "2026-08-04" })).toEqual({
      code: "CHECK_OUT",
      enabled: true,
      disabledReason: null
    });
  });

  it("gates no-show at local 20:00 and same-day check-in revocation by arrival date", () => {
    const dates = { businessDate: "2026-08-01", arrivalDate: "2026-08-01", departureDate: "2026-08-03" };
    expect(action("RESERVED", "MARK_NO_SHOW", false, { ...dates, localTime: "19:59" })).toMatchObject({
      enabled: false,
      disabledReason: "计划到店日 20:00 后才能标记未到"
    });
    expect(action("RESERVED", "MARK_NO_SHOW", false, { ...dates, localTime: "20:00" })?.enabled).toBe(true);
    expect(action("CHECKED_IN", "REVOKE_CHECK_IN", false, dates)?.enabled).toBe(true);
    expect(action("CHECKED_IN", "REVOKE_CHECK_IN", false, { ...dates, businessDate: "2026-08-02" })).toMatchObject({
      enabled: false,
      disabledReason: "只有计划入住当天可以撤销误办入住"
    });
  });

  it("keeps corrections available while gating fulfillment actions by order state", () => {
    for (const status of ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]) {
      expect(action(status, "CORRECT_ORDER_OCCUPANT")).toEqual({
        code: "CORRECT_ORDER_OCCUPANT",
        enabled: true,
        disabledReason: null
      });
    }
    expect(action("RESERVED", "CHECK_IN")?.enabled).toBe(true);
    expect(action("RESERVED", "CHECK_OUT")?.enabled).toBe(false);
    expect(action("CHECKED_IN", "CHECK_OUT")?.enabled).toBe(true);
    expect(action("CHECKED_IN", "CANCEL_ORDER")?.enabled).toBe(false);
    for (const status of ["CHECKED_OUT", "CANCELLED", "NO_SHOW"]) {
      for (const code of ["CHECK_IN", "CHECK_OUT", "SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT", "CANCEL_ORDER", "MARK_NO_SHOW"]) {
        expect(action(status, code)).toMatchObject({ enabled: false, disabledReason: "ORDER_STATE_NOT_ALLOWED" });
      }
    }
  });

  it("allows membership conversion while in-house or checked out, but not before arrival", () => {
    const conversion = (status: string) => orderAllowedActions(
      "WRITE", status, false, undefined, false, "WECOM", true, false, undefined, allOrderActionGrants
    ).find((candidate) => candidate.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
    expect(conversion("CHECKED_IN")).toEqual({
      code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      enabled: true,
      disabledReason: null
    });
    expect(conversion("CHECKED_OUT")).toEqual({
      code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      enabled: true,
      disabledReason: null
    });
    expect(conversion("RESERVED")).toMatchObject({
      enabled: false,
      disabledReason: "请在入住或退房完成后办理升级会员"
    });
    expect(conversion("CANCELLED")).toMatchObject({
      enabled: false,
      disabledReason: "请在入住或退房完成后办理升级会员"
    });
  });

  it("closes ordinary funds and lifecycle actions after a zero-transfer conversion while keeping fulfillment changes available", () => {
    const actions = orderAllowedActions(
      "WRITE",
      "CHECKED_IN",
      false,
      undefined,
      false,
      "WECOM",
      true,
      true,
      undefined,
      allOrderActionGrants
    );
    for (const code of [
      "RECORD_COLLECTION",
      "RECORD_REFUND",
      "REVERSE_FACT",
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      "REPRICE_ORDER",
      "REVOKE_CHECK_IN"
    ]) {
      expect(actions.find((candidate) => candidate.code === code)).toMatchObject({ enabled: false });
    }
    expect(actions.find((candidate) => candidate.code === "EXTEND_STAY")).toMatchObject({ enabled: true });
    expect(actions.find((candidate) => candidate.code === "MOVE_UNIT")).toMatchObject({ enabled: true });
  });

  it("does not publish the obsolete two-step backfill action", () => {
    const past = { businessDate: "2026-08-04", arrivalDate: "2026-07-25", departureDate: "2026-08-04" };
    for (const status of ["RESERVED", "CHECKED_IN", "CHECKED_OUT"]) {
      expect(orderAllowedActions("WRITE", status, false, past, false, null, false, false, undefined, allOrderActionGrants)
        .some((candidate) => (candidate.code as string) === "BACKFILL_COMPLETED_STAY")).toBe(false);
    }
  });

  it("offers COMPLETE_STAY only for overdue reserved orders after the planned departure date", () => {
    const past = { businessDate: "2026-08-14", arrivalDate: "2026-08-06", departureDate: "2026-08-11" };
    expect(action("RESERVED", "COMPLETE_STAY", false, past)).toEqual({
      code: "COMPLETE_STAY",
      enabled: true,
      disabledReason: null
    });
    // 计划离店当天（businessDate === departureDate）按住宿行业习惯视为住宿已结束，允许完成住宿。
    expect(action("RESERVED", "COMPLETE_STAY", false, { ...past, businessDate: past.departureDate })).toMatchObject({
      enabled: true,
      disabledReason: null
    });
    expect(action("RESERVED", "COMPLETE_STAY", false, { ...past, businessDate: "2026-08-10" })).toEqual({
      code: "COMPLETE_STAY",
      enabled: false,
      disabledReason: "未到计划退房日，请使用普通入住流程"
    });
    for (const status of ["CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]) {
      expect(action(status, "COMPLETE_STAY", false, past)).toMatchObject({
        enabled: false,
        disabledReason: "ORDER_STATE_NOT_ALLOWED"
      });
    }
  });

  it("keeps COMPLETE_STAY action eligibility aligned with planned Stay and absent fulfillment facts", () => {
    const past = { businessDate: "2026-08-14", arrivalDate: "2026-08-06", departureDate: "2026-08-11" };
    const eligibleFacts = {
      stayStatus: "PLANNED",
      hasCheckIn: false,
      hasCheckOut: false,
      hasCheckInRevocation: false
    };
    expect(action("RESERVED", "COMPLETE_STAY", false, past, false, eligibleFacts)?.enabled).toBe(true);
    for (const facts of [
      { ...eligibleFacts, stayStatus: "IN_HOUSE" },
      { ...eligibleFacts, hasCheckIn: true },
      { ...eligibleFacts, hasCheckOut: true },
      { ...eligibleFacts, hasCheckInRevocation: true }
    ]) {
      expect(action("RESERVED", "COMPLETE_STAY", false, past, false, facts)).toEqual({
        code: "COMPLETE_STAY",
        enabled: false,
        disabledReason: "只有已预订且未办理入住的订单可以完成住宿"
      });
    }
  });

  it("allows post-arrival shortening to crop a future room move", () => {
    const dates = { businessDate: "2026-08-03", arrivalDate: "2026-08-01", departureDate: "2026-08-06" };
    expect(action("CHECKED_IN", "SHORTEN_STAY", false, dates)).toEqual({
      code: "SHORTEN_STAY",
      enabled: true,
      disabledReason: null
    });
    expect(action("CHECKED_IN", "SHORTEN_STAY", false, { ...dates, businessDate: dates.arrivalDate })).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining("入住当天")
    });
    expect(action("CHECKED_IN", "SHORTEN_STAY", false, dates, true)).toMatchObject({
      enabled: true,
      disabledReason: null
    });
  });

  it("disables MOVE_UNIT for overdue reserved and departure-day in-house orders", () => {
    const reserved = { businessDate: "2026-08-02", arrivalDate: "2026-08-01", departureDate: "2026-08-04" };
    expect(action("RESERVED", "MOVE_UNIT", false, reserved)).toEqual({
      code: "MOVE_UNIT",
      enabled: false,
      disabledReason: "逾期未到订单暂不能换房，请先处理到店日期"
    });
    expect(action("RESERVED", "MOVE_UNIT", false, { ...reserved, businessDate: reserved.arrivalDate })).toMatchObject({
      enabled: true,
      disabledReason: null
    });

    const inHouse = { businessDate: "2026-08-04", arrivalDate: "2026-08-01", departureDate: "2026-08-04" };
    expect(action("CHECKED_IN", "MOVE_UNIT", false, inHouse)).toEqual({
      code: "MOVE_UNIT",
      enabled: false,
      disabledReason: "已到或超过计划退房日，请先办理续住或退房"
    });
    expect(action("CHECKED_IN", "MOVE_UNIT", false, { ...inHouse, businessDate: "2026-08-03" })).toMatchObject({
      enabled: true,
      disabledReason: null
    });
  });

  it("enables refund only when an active collection still has refundable value", () => {
    expect(action("RESERVED", "RECORD_REFUND", false)).toEqual({
      code: "RECORD_REFUND",
      enabled: false,
      disabledReason: "NO_REFUNDABLE_COLLECTION"
    });
    expect(action("RESERVED", "RECORD_REFUND", true)).toEqual({
      code: "RECORD_REFUND",
      enabled: true,
      disabledReason: null
    });
  });
});

describe("projectOrderFulfillment", () => {
  const actor = { subjectId: "subject_operator", displayName: "前台操作员" };
  const amendment = (
    type: "CHECK_IN" | "CHECK_OUT",
    businessDate: unknown,
    sequence: number
  ) => ({
    sequence,
    amendment_type: type,
    payload: (businessDate === undefined ? { orderId: "order_1" } : { orderId: "order_1", businessDate }) as Record<string, unknown>,
    reason_code: "FRONT_DESK",
    reason_note: type === "CHECK_IN" ? "办理入住" : "办理退房",
    actor_subject_id: actor.subjectId,
    actor_display_name: actor.displayName,
    created_at: new Date(`2026-08-0${sequence}T12:00:00.000Z`)
  });

  it("projects on-time check-in and check-out without inventing actual occurrence times", () => {
    expect(projectOrderFulfillment([
      amendment("CHECK_IN", "2026-08-01", 2),
      amendment("CHECK_OUT", "2026-08-03", 3)
    ], { arrivalDate: "2026-08-01", departureDate: "2026-08-03" })).toEqual({
      checkIn: {
        type: "CHECK_IN",
        plannedBusinessDate: "2026-08-01",
        recordedBusinessDate: "2026-08-01",
        recordingMode: "ON_SCHEDULE",
        recordedAt: "2026-08-02T12:00:00.000Z",
        actor,
        reason: { code: "FRONT_DESK", note: "办理入住" }
      },
      checkOut: {
        type: "CHECK_OUT",
        plannedBusinessDate: "2026-08-03",
        recordedBusinessDate: "2026-08-03",
        recordingMode: "ON_SCHEDULE",
        recordedAt: "2026-08-03T12:00:00.000Z",
        actor,
        reason: { code: "FRONT_DESK", note: "办理退房" }
      },
      checkInRevocation: null
    });
  });

  it("classifies an overdue check-out as late-recorded against the planned departure date", () => {
    const result = projectOrderFulfillment([
      amendment("CHECK_OUT", "2026-08-04", 3)
    ], { arrivalDate: "2026-08-01", departureDate: "2026-08-03" });

    expect(result.checkOut).toMatchObject({
      plannedBusinessDate: "2026-08-03",
      recordedBusinessDate: "2026-08-04",
      recordingMode: "LATE_RECORDED"
    });
  });

  it("uses immutable timing from a new fulfillment fact even if the order header later changes", () => {
    const row = amendment("CHECK_OUT", "2026-08-04", 3);
    row.payload = {
      orderId: "order_1",
      businessDate: "2026-08-04",
      effectiveDate: "2026-08-03",
      recordingMode: "LATE_RECORDED"
    };
    const result = projectOrderFulfillment([row], {
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-05"
    });

    expect(result.checkOut).toMatchObject({
      plannedBusinessDate: "2026-08-03",
      recordedBusinessDate: "2026-08-04",
      recordingMode: "LATE_RECORDED"
    });
  });

  it.each([
    [undefined, null],
    ["2026-07-31", "2026-07-31"]
  ])("keeps legacy fulfillment that cannot satisfy the current date rule unclassified", (businessDate, expectedDate) => {
    const result = projectOrderFulfillment([
      amendment("CHECK_OUT", businessDate, 3)
    ], { arrivalDate: "2026-08-01", departureDate: "2026-08-03" });

    expect(result.checkOut).toMatchObject({
      plannedBusinessDate: "2026-08-03",
      recordedBusinessDate: expectedDate,
      recordingMode: "LEGACY_UNCLASSIFIED"
    });
  });

  it.each([null, 20260803, "2026-02-30", "not-a-date"])("fails closed for a damaged recorded business date: %s", (businessDate) => {
    expect(() => projectOrderFulfillment([
      amendment("CHECK_OUT", businessDate, 3)
    ], { arrivalDate: "2026-08-01", departureDate: "2026-08-03" })).toThrow("履约记录的办理营业日期损坏");
  });

  it("fails closed for partial immutable timing, a damaged record time, a partial actor, or duplicate facts", () => {
    const partialTiming = amendment("CHECK_OUT", "2026-08-04", 3);
    partialTiming.payload = { orderId: "order_1", businessDate: "2026-08-04", effectiveDate: "2026-08-03" };
    expect(() => projectOrderFulfillment([partialTiming], {
      arrivalDate: "2026-08-01", departureDate: "2026-08-03"
    })).toThrow("履约记录的办理营业日期损坏");

    const invalidTime = { ...amendment("CHECK_IN", "2026-08-01", 2), created_at: "invalid" };
    expect(() => projectOrderFulfillment([invalidTime], {
      arrivalDate: "2026-08-01", departureDate: "2026-08-03"
    })).toThrow("履约记录的记录时间损坏");

    const partialActor = { ...amendment("CHECK_IN", "2026-08-01", 2), actor_display_name: null };
    expect(() => projectOrderFulfillment([partialActor], {
      arrivalDate: "2026-08-01", departureDate: "2026-08-03"
    })).toThrow("履约记录的操作人信息损坏");

    expect(() => projectOrderFulfillment([
      amendment("CHECK_IN", "2026-08-01", 2),
      amendment("CHECK_IN", "2026-08-01", 3)
    ], { arrivalDate: "2026-08-01", departureDate: "2026-08-03" })).toThrow("订单履约记录存在重复状态事实");
  });
});

describe("projectOrderLifecycle", () => {
  const actor = { subjectId: "subject_operator", displayName: "前台操作员" };
  const amendment = (options: {
    id: string;
    sequence: number;
    type: string;
    payload: Record<string, unknown>;
    protocolVersion?: "PRE_STAGE_11";
  }) => ({
    id: options.id,
    order_id: "order_1",
    sequence: options.sequence,
    amendment_type: options.type,
    payload: options.payload,
    reason_code: options.type,
    reason_note: `${options.type} note`,
    prior_version: options.sequence - 1,
    new_version: options.sequence,
    actor_subject_id: actor.subjectId,
    actor_display_name: actor.displayName,
    created_at: new Date(`2026-08-0${options.sequence}T12:00:00.000Z`),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {})
  });
  const revision = (
    amendmentId: string,
    arrivalDate: string,
    departureDate: string,
    amount = 10_000,
    revisionNo = Number(amendmentId.match(/\d+$/)?.[0] ?? 1)
  ) => ({
    id: `revision_${revisionNo}`,
    order_id: "order_1",
    revision_no: revisionNo,
    amendment_id: amendmentId,
    arrival_date: arrivalDate,
    departure_date: departureDate,
    policy_base_amount_minor: amount,
    current_contract_amount_minor: amount,
    currency: "CNY"
  });
  const base = () => ({
    order: {
      id: "order_1",
      status: "RESERVED",
      stay_type: "TRANSIENT",
      arrival_date: "2026-08-01",
      departure_date: "2026-08-03",
      current_revision_id: "revision_1" as string | null,
      version: 1
    },
    stay: { id: "stay_1", status: "PLANNED" },
    businessDate: "2026-08-01",
    segments: [{
      id: "segment_1",
      stay_id: "stay_1",
      sequence: 1,
      inventory_unit_id: "room_a",
      arrival_date: "2026-08-01",
      departure_date: "2026-08-03",
      segment_type: "INITIAL",
      supersedes_segment_id: null as string | null,
      amendment_id: "amend_1"
    }],
    amendments: [amendment({
      id: "amend_1",
      sequence: 1,
      type: "CREATE_ORDER",
      payload: {
        inventoryUnitId: "room_a",
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03"
      }
    })],
    revisions: [revision("amend_1", "2026-08-01", "2026-08-03")],
    facts: [] as Array<{
      order_id: string;
      net_effect_minor: number;
      currency: string;
      created_at: Date;
    }>,
    activeTimeline: [
      { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-02", inventoryUnitId: "room_a" }
    ]
  });

  function moveInput(payload: Record<string, unknown>, protocolVersion?: "PRE_STAGE_11") {
    const input = base();
    input.order.version = 2;
    input.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "MOVE_UNIT",
      payload,
      ...(protocolVersion ? { protocolVersion } : {})
    }));
    input.segments.push({
      id: "segment_2", stay_id: "stay_1", sequence: 2, inventory_unit_id: "room_b",
      arrival_date: "2026-08-02", departure_date: "2026-08-03", segment_type: "MOVE",
      supersedes_segment_id: "segment_1", amendment_id: "amend_2"
    });
    input.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03"));
    input.order.current_revision_id = "revision_2";
    input.activeTimeline = [
      { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-02", inventoryUnitId: "room_b" }
    ];
    return input;
  }

  it.each([
    ["Stage 11 after payload", {
      after: {
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_b" }
        ]
      }
    }, undefined],
    ["legacy top-level payload", {
      stayTimeline: [
        { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-02", inventoryUnitId: "room_b" }
      ]
    }, "PRE_STAGE_11"]
  ] as const)("projects a MOVE_UNIT timeline from the %s", (_label, payload, protocolVersion) => {
    expect(projectOrderLifecycle(moveInput(payload, protocolVersion)).effectiveArrangement.intervals).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-01", departureDate: "2026-08-02" },
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-02", departureDate: "2026-08-03" }
    ]);
  });

  it("fails closed for a damaged Stage 11 MOVE_UNIT timeline instead of falling back to legacy data", () => {
    expect(() => projectOrderLifecycle(moveInput({
      after: { stayTimeline: "damaged" },
      stayTimeline: [
        { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-02", inventoryUnitId: "room_b" }
      ]
    }))).toThrow(/缺少 typed 时间线/);
  });

  it("keeps the original arrangement immutable while replaying a gap-free, non-overlapping effective timeline", () => {
    const input = base();
    input.order.departure_date = "2026-08-04";
    input.order.version = 4;
    input.amendments.push(
      amendment({
        id: "amend_2",
        sequence: 2,
        type: "EXTEND_STAY",
        payload: {
          after: {
            stayTimeline: [
              { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
              { serviceDate: "2026-08-02", inventoryUnitId: "room_a" },
              { serviceDate: "2026-08-03", inventoryUnitId: "room_a" },
              { serviceDate: "2026-08-04", inventoryUnitId: "room_a" }
            ]
          }
        }
      }),
      amendment({
        id: "amend_3",
        sequence: 3,
        type: "MOVE_UNIT",
        protocolVersion: "PRE_STAGE_11",
        payload: {
          stayTimeline: [
            { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
            { serviceDate: "2026-08-02", inventoryUnitId: "room_a" },
            { serviceDate: "2026-08-03", inventoryUnitId: "room_b" },
            { serviceDate: "2026-08-04", inventoryUnitId: "room_b" }
          ]
        }
      }),
      amendment({
        id: "amend_4",
        sequence: 4,
        type: "SHORTEN_STAY",
        payload: {
          completionMode: "SHORTEN_IN_HOUSE",
          fundsSummary: {
            netRecordedCollection: { currency: "CNY", minorUnits: 0 },
            collectionDifference: { currency: "CNY", minorUnits: 15_000 },
            factCount: 0
          },
          refundReferenceAmount: { currency: "CNY", minorUnits: 0 },
          after: {
            stayTimeline: [
              { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
              { serviceDate: "2026-08-02", inventoryUnitId: "room_a" },
              { serviceDate: "2026-08-03", inventoryUnitId: "room_b" }
            ]
          }
        }
      })
    );
    input.segments.push(
      {
        id: "segment_2", stay_id: "stay_1", sequence: 2, inventory_unit_id: "room_a",
        arrival_date: "2026-08-01", departure_date: "2026-08-05", segment_type: "EXTEND_STAY",
        supersedes_segment_id: "segment_1", amendment_id: "amend_2"
      },
      {
        id: "segment_3", stay_id: "stay_1", sequence: 3, inventory_unit_id: "room_b",
        arrival_date: "2026-08-03", departure_date: "2026-08-05", segment_type: "MOVE",
        supersedes_segment_id: "segment_2", amendment_id: "amend_3"
      },
      {
        id: "segment_4", stay_id: "stay_1", sequence: 4, inventory_unit_id: "room_b",
        arrival_date: "2026-08-03", departure_date: "2026-08-04", segment_type: "SHORTEN_STAY",
        supersedes_segment_id: "segment_3", amendment_id: "amend_4"
      }
    );
    input.revisions.push(
      revision("amend_2", "2026-08-01", "2026-08-05", 20_000),
      revision("amend_3", "2026-08-01", "2026-08-05", 20_000),
      revision("amend_4", "2026-08-01", "2026-08-04", 15_000)
    );
    input.order.current_revision_id = "revision_4";
    input.activeTimeline = [
      { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-02", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-03", inventoryUnitId: "room_b" }
    ];

    const result = projectOrderLifecycle(input);
    expect(result.originalArrangement).toEqual({
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-03",
      intervals: [{ inventoryUnitId: "room_a", arrivalDate: "2026-08-01", departureDate: "2026-08-03" }]
    });
    expect(result.effectiveArrangement).toMatchObject({
      presentation: "CURRENT",
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-04",
      intervals: [
        { inventoryUnitId: "room_a", arrivalDate: "2026-08-01", departureDate: "2026-08-03" },
        { inventoryUnitId: "room_b", arrivalDate: "2026-08-03", departureDate: "2026-08-04" }
      ]
    });
    expect(result.arrangementHistory.map((item) => item.type)).toEqual([
      "INITIAL_BOOKING", "EXTENSION", "MOVE", "SHORTENING"
    ]);
    expect(result.arrangementHistory[0]!.before).toBeNull();
    expect(result.arrangementHistory.at(-1)!.before?.departureDate).toBe("2026-08-05");
  });

  it("keeps a SHORTEN_STAY funds summary frozen when later money facts use earlier or equal timestamps", () => {
    const input = base();
    input.order.departure_date = "2026-08-02";
    input.order.version = 2;
    input.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "SHORTEN_STAY",
      payload: {
        completionMode: "SHORTEN_IN_HOUSE",
        fundsSummary: {
          netRecordedCollection: { currency: "CNY", minorUnits: 12_000 },
          collectionDifference: { currency: "CNY", minorUnits: -7_000 },
          factCount: 1
        },
        refundReferenceAmount: { currency: "CNY", minorUnits: 7_000 },
        after: {
          stayTimeline: [{ serviceDate: "2026-08-01", inventoryUnitId: "room_a" }]
        }
      }
    }));
    input.segments.push({
      id: "segment_2", stay_id: "stay_1", sequence: 2, inventory_unit_id: "room_a",
      arrival_date: "2026-08-01", departure_date: "2026-08-02", segment_type: "SHORTEN_STAY",
      supersedes_segment_id: "segment_1", amendment_id: "amend_2"
    });
    input.revisions.push(revision("amend_2", "2026-08-01", "2026-08-02", 5_000));
    input.order.current_revision_id = "revision_2";
    input.activeTimeline = [{ serviceDate: "2026-08-01", inventoryUnitId: "room_a" }];
    input.facts.push({
      order_id: "order_1",
      net_effect_minor: 12_000,
      currency: "CNY",
      created_at: new Date("2026-08-01T12:00:00.000Z")
    });

    const beforeLaterFacts = projectOrderLifecycle(input).arrangementHistory.at(-1)!.fundsSummary;
    input.facts.push(
      {
        order_id: "order_1",
        net_effect_minor: 3_000,
        currency: "CNY",
        created_at: new Date("2026-07-31T12:00:00.000Z")
      },
      {
        order_id: "order_1",
        net_effect_minor: -1_000,
        currency: "CNY",
        created_at: input.amendments[1]!.created_at as Date
      }
    );
    const afterLaterFacts = projectOrderLifecycle(input).arrangementHistory.at(-1)!.fundsSummary;

    expect(beforeLaterFacts).toMatchObject({
      netRecordedCollection: { currency: "CNY", minorUnits: 12_000 },
      collectionDifference: { currency: "CNY", minorUnits: -7_000 },
      refundReferenceAmount: { currency: "CNY", minorUnits: 7_000 }
    });
    expect(afterLaterFacts).toEqual(beforeLaterFacts);
  });

  it.each([
    ["missing funds summary", (payload: Record<string, unknown>) => { delete payload.fundsSummary; }],
    ["extra funds field", (payload: Record<string, unknown>) => {
      (payload.fundsSummary as Record<string, unknown>).unexpected = true;
    }],
    ["wrong frozen currency", (payload: Record<string, unknown>) => {
      ((payload.fundsSummary as { netRecordedCollection: Record<string, unknown> }).netRecordedCollection).currency = "USD";
    }],
    ["invalid frozen fact count", (payload: Record<string, unknown>) => {
      (payload.fundsSummary as Record<string, unknown>).factCount = -1;
    }],
    ["inconsistent collection difference", (payload: Record<string, unknown>) => {
      ((payload.fundsSummary as { collectionDifference: Record<string, unknown> }).collectionDifference).minorUnits = -6_999;
    }],
    ["inconsistent refund reference", (payload: Record<string, unknown>) => {
      (payload.refundReferenceAmount as Record<string, unknown>).minorUnits = 6_999;
    }],
    ["refund reference above the public money limit", (payload: Record<string, unknown>) => {
      const fundsSummary = (payload.fundsSummary as {
        netRecordedCollection: Record<string, unknown>;
        collectionDifference: Record<string, unknown>;
      });
      fundsSummary.netRecordedCollection.minorUnits = 2_147_488_648;
      fundsSummary.collectionDifference.minorUnits = -2_147_483_648;
      (payload.refundReferenceAmount as Record<string, unknown>).minorUnits = 2_147_483_648;
    }]
  ])("fails closed for a SHORTEN_STAY payload with %s", (_label, damage) => {
    const input = base();
    input.order.departure_date = "2026-08-02";
    input.order.version = 2;
    const shorten = amendment({
      id: "amend_2",
      sequence: 2,
      type: "SHORTEN_STAY",
      payload: {
        completionMode: "SHORTEN_IN_HOUSE",
        fundsSummary: {
          netRecordedCollection: { currency: "CNY", minorUnits: 12_000 },
          collectionDifference: { currency: "CNY", minorUnits: -7_000 },
          factCount: 1
        },
        refundReferenceAmount: { currency: "CNY", minorUnits: 7_000 },
        after: {
          stayTimeline: [{ serviceDate: "2026-08-01", inventoryUnitId: "room_a" }]
        }
      }
    });
    damage(shorten.payload);
    input.amendments.push(shorten);
    input.segments.push({
      id: "segment_2", stay_id: "stay_1", sequence: 2, inventory_unit_id: "room_a",
      arrival_date: "2026-08-01", departure_date: "2026-08-02", segment_type: "SHORTEN_STAY",
      supersedes_segment_id: "segment_1", amendment_id: "amend_2"
    });
    input.revisions.push(revision("amend_2", "2026-08-01", "2026-08-02", 5_000));
    input.order.current_revision_id = "revision_2";
    input.activeTimeline = [{ serviceDate: "2026-08-01", inventoryUnitId: "room_a" }];

    expect(() => projectOrderLifecycle(input)).toThrow(/冻结资金摘要/);
  });

  it.each([
    ["CHECKED_IN", "IN_HOUSE", "IN_HOUSE", "CURRENT", "CHECK_IN"],
    ["CHECKED_OUT", "COMPLETED", "CHECKED_OUT", "LAST", "CHECK_OUT"],
    ["CANCELLED", "CANCELLED", "CANCELLED", "BEFORE_CANCELLATION", "CANCEL_ORDER"],
    ["NO_SHOW", "NO_SHOW", "NO_SHOW", "NO_SHOW_ORDER", "MARK_NO_SHOW"],
    ["CHECK_IN_REVOKED", "CHECK_IN_REVOKED", "CHECK_IN_REVOKED", "BEFORE_CHECK_IN_REVOCATION", "REVOKE_CHECK_IN"]
  ] as const)("projects typed %s lifecycle state and the correct arrangement presentation", (
    orderStatus,
    stayStatus,
    expectedState,
    expectedPresentation,
    terminalType
  ) => {
    const input = base();
    input.order.status = orderStatus;
    input.stay.status = stayStatus;
    const checkIn = amendment({
      id: "amend_2",
      sequence: 2,
      type: "CHECK_IN",
      payload: {
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        businessDate: "2026-08-01",
        effectiveDate: "2026-08-01",
        recordingMode: "ON_SCHEDULE"
      }
    });
    if (orderStatus === "CHECKED_IN" || orderStatus === "CHECKED_OUT" || orderStatus === "CHECK_IN_REVOKED") input.amendments.push(checkIn);
    if (orderStatus === "CHECKED_OUT") {
      input.amendments.push(amendment({
        id: "amend_3",
        sequence: 3,
        type: "CHECK_OUT",
        payload: {
          fromStatus: "CHECKED_IN",
          toStatus: "CHECKED_OUT",
          businessDate: "2026-08-03",
          effectiveDate: "2026-08-03",
          recordingMode: "ON_SCHEDULE"
        }
      }));
    } else if (orderStatus === "CANCELLED" || orderStatus === "NO_SHOW") {
      input.amendments.push(amendment({
        id: "amend_2",
        sequence: 2,
        type: terminalType,
        payload: { fromStatus: "RESERVED", toStatus: orderStatus }
      }));
    } else if (orderStatus === "CHECK_IN_REVOKED") {
      input.amendments.push(amendment({
        id: "amend_3",
        sequence: 3,
        type: terminalType,
        payload: {
          fromStatus: "CHECKED_IN",
          toStatus: "CHECK_IN_REVOKED",
          businessDate: "2026-08-01",
          effectiveDate: "2026-08-01",
          recordingMode: "ON_SCHEDULE"
        }
      }));
    }
    input.order.version = input.amendments.length;
    if (orderStatus === "CANCELLED" || orderStatus === "NO_SHOW") {
      input.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03", 0, 2));
      input.order.current_revision_id = "revision_2";
    } else if (orderStatus === "CHECK_IN_REVOKED") {
      input.revisions.push(revision("amend_3", "2026-08-01", "2026-08-03", 0, 2));
      input.order.current_revision_id = "revision_2";
    }
    if (orderStatus === "CHECKED_OUT" || orderStatus === "CANCELLED" || orderStatus === "NO_SHOW" || orderStatus === "CHECK_IN_REVOKED") {
      input.activeTimeline = [];
    }

    const result = projectOrderLifecycle(input);
    expect(result.fulfillment.state).toBe(expectedState);
    expect(result.effectiveArrangement.presentation).toBe(expectedPresentation);
    if (orderStatus === "CHECKED_IN" || orderStatus === "CHECKED_OUT" || orderStatus === "CHECK_IN_REVOKED") expect(result.fulfillment.checkIn).not.toBeNull();
    if (orderStatus === "CHECKED_OUT") expect(result.fulfillment.checkOut).not.toBeNull();
    if (orderStatus === "CHECK_IN_REVOKED") expect(result.fulfillment.checkInRevocation).not.toBeNull();
  });

  it.each([
    ["CANCELLED", "CANCELLED", "CANCEL_ORDER"],
    ["NO_SHOW", "NO_SHOW", "MARK_NO_SHOW"]
  ] as const)("requires one zero-pricing terminal revision for a FREE %s order", (orderStatus, stayStatus, terminalType) => {
    const input = base();
    input.order.status = orderStatus;
    input.order.stay_type = "FREE";
    input.stay.status = stayStatus;
    input.order.version = 2;
    input.activeTimeline = [];
    input.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: terminalType,
      payload: { fromStatus: "RESERVED", toStatus: orderStatus }
    }));
    input.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03", 0));
    input.order.current_revision_id = "revision_2";

    expect(projectOrderLifecycle(input).fulfillment.state).toBe(orderStatus);

    input.revisions.pop();
    input.order.current_revision_id = "revision_1";
    expect(() => projectOrderLifecycle(input)).toThrow(/计价变更没有唯一计价版本/);
  });

  it("fails closed for a broken supersession chain, a mismatched typed timeline, or stale active Claims", () => {
    const broken = base();
    broken.order.version = 2;
    broken.order.departure_date = "2026-08-04";
    broken.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "EXTEND_STAY",
      payload: { after: { stayTimeline: [
        { serviceDate: "2026-08-01", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-02", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-03", inventoryUnitId: "room_a" }
      ] } }
    }));
    broken.segments.push({
      id: "segment_2", stay_id: "stay_1", sequence: 2, inventory_unit_id: "room_a",
      arrival_date: "2026-08-01", departure_date: "2026-08-04", segment_type: "EXTEND_STAY",
      supersedes_segment_id: "segment_missing", amendment_id: "amend_2"
    });
    broken.revisions.push(revision("amend_2", "2026-08-01", "2026-08-04"));
    broken.order.current_revision_id = "revision_2";
    broken.activeTimeline.push({ serviceDate: "2026-08-03", inventoryUnitId: "room_a" });
    expect(() => projectOrderLifecycle(broken)).toThrow(/supersession/);

    const mismatchedTimeline = structuredClone(broken);
    mismatchedTimeline.segments[1]!.supersedes_segment_id = "segment_1";
    (mismatchedTimeline.amendments[1]!.payload as { after: { stayTimeline: Array<{ inventoryUnitId: string }> } })
      .after.stayTimeline[2]!.inventoryUnitId = "room_b";
    expect(() => projectOrderLifecycle(mismatchedTimeline)).toThrow(/typed 变更时间线/);

    const staleClaims = base();
    staleClaims.activeTimeline[1]!.inventoryUnitId = "room_b";
    expect(() => projectOrderLifecycle(staleClaims)).toThrow(/有效 Claim/);
  });

  it("fails closed when order and Stay state do not agree with typed fulfillment facts", () => {
    const input = base();
    input.order.status = "CHECKED_OUT";
    input.stay.status = "COMPLETED";
    input.activeTimeline = [];
    expect(() => projectOrderLifecycle(input)).toThrow(/最终状态与 typed 状态变更链/);

    const wrongStay = base();
    wrongStay.stay.status = "IN_HOUSE";
    expect(() => projectOrderLifecycle(wrongStay)).toThrow(/订单状态与住宿状态/);
  });

  it("rejects non-order amendment types even when their version chain is structurally valid", () => {
    const input = base();
    input.order.version = 2;
    input.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "CREATE_MEMBER",
      payload: {}
    }));

    expect(() => projectOrderLifecycle(input)).toThrow(/订单不可变变更记录链损坏/);
  });

  it("requires a continuous pricing revision chain whose latest ID is the order current pointer", () => {
    const missingPointer = base();
    missingPointer.order.current_revision_id = null;
    expect(() => projectOrderLifecycle(missingPointer)).toThrow(/缺少当前计价版本/);

    const stalePointer = base();
    stalePointer.order.current_revision_id = "revision_missing";
    expect(() => projectOrderLifecycle(stalePointer)).toThrow(/当前计价版本指针与最新计价版本不一致/);

    const skippedRevision = base();
    skippedRevision.revisions[0]!.revision_no = 2;
    expect(() => projectOrderLifecycle(skippedRevision)).toThrow(/计价版本链损坏/);

    const duplicateAmendment = base();
    duplicateAmendment.revisions.push({
      ...duplicateAmendment.revisions[0]!,
      id: "revision_2",
      revision_no: 2
    });
    duplicateAmendment.order.current_revision_id = "revision_2";
    expect(() => projectOrderLifecycle(duplicateAmendment)).toThrow(/计价版本链损坏/);
  });

  it("requires every pricing mutation to create exactly one pricing revision", () => {
    const missingRevision = base();
    missingRevision.order.version = 2;
    missingRevision.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "REPRICE_ORDER",
      payload: { operation: "REPRICE_ORDER" }
    }));
    expect(() => projectOrderLifecycle(missingRevision)).toThrow(/计价变更没有唯一计价版本/);

    missingRevision.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03"));
    missingRevision.order.current_revision_id = "revision_2";
    expect(projectOrderLifecycle(missingRevision).effectiveArrangement.departureDate).toBe("2026-08-03");

    const orphanRevision = base();
    orphanRevision.revisions.push({
      ...revision("amend_missing", "2026-08-01", "2026-08-03", 10_000, 2),
      id: "revision_2"
    });
    orphanRevision.order.current_revision_id = "revision_2";
    expect(() => projectOrderLifecycle(orphanRevision)).toThrow(/计价版本链损坏/);
  });

  it("rejects pricing revisions attached to non-pricing amendments or a mismatched effective arrangement", () => {
    const nonPricingRevision = base();
    nonPricingRevision.order.version = 2;
    nonPricingRevision.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "CORRECT_ORDER_OCCUPANT",
      payload: { operation: "CORRECT_ORDER_OCCUPANT" }
    }));
    nonPricingRevision.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03"));
    nonPricingRevision.order.current_revision_id = "revision_2";
    expect(() => projectOrderLifecycle(nonPricingRevision)).toThrow(/计价版本链损坏/);

    const wrongDates = base();
    wrongDates.order.version = 2;
    wrongDates.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "REPRICE_ORDER",
      payload: { operation: "REPRICE_ORDER" }
    }));
    wrongDates.revisions.push(revision("amend_2", "2026-08-02", "2026-08-03"));
    wrongDates.order.current_revision_id = "revision_2";
    expect(() => projectOrderLifecycle(wrongDates)).toThrow(/与当时有效住宿安排不一致/);

    const wrongCurrency = base();
    wrongCurrency.order.version = 2;
    wrongCurrency.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "REPRICE_ORDER",
      payload: { operation: "REPRICE_ORDER" }
    }));
    wrongCurrency.revisions.push({ ...revision("amend_2", "2026-08-01", "2026-08-03"), currency: "USD" });
    wrongCurrency.order.current_revision_id = "revision_2";
    expect(() => projectOrderLifecycle(wrongCurrency)).toThrow(/金额或币种链损坏/);
  });

  it("requires every stay-changing amendment to create exactly one Stay segment", () => {
    const missingSegment = base();
    missingSegment.order.version = 2;
    missingSegment.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "MOVE_UNIT",
      payload: {
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_b" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_b" }
        ]
      }
    }));
    missingSegment.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03"));
    missingSegment.order.current_revision_id = "revision_2";
    expect(() => projectOrderLifecycle(missingSegment)).toThrow(/住宿变更没有唯一住宿安排版本/);

    const duplicateInitial = base();
    duplicateInitial.segments.push({
      ...duplicateInitial.segments[0]!,
      id: "segment_2",
      sequence: 2
    });
    expect(() => projectOrderLifecycle(duplicateInitial)).toThrow(/住宿变更没有唯一住宿安排版本/);
  });

  it("rejects amendment timestamps that move backwards but includes funds recorded at the same instant", () => {
    const backwards = base();
    backwards.order.version = 2;
    const correction = amendment({
      id: "amend_2",
      sequence: 2,
      type: "CORRECT_ORDER_OCCUPANT",
      payload: { operation: "CORRECT_ORDER_OCCUPANT" }
    });
    correction.created_at = new Date("2026-07-31T12:00:00.000Z");
    backwards.amendments.push(correction);
    expect(() => projectOrderLifecycle(backwards)).toThrow(/记录时间没有按 sequence 非递减/);

    correction.created_at = backwards.amendments[0]!.created_at;
    backwards.facts.push({
      order_id: "order_1",
      net_effect_minor: 4_000,
      currency: "CNY",
      created_at: backwards.amendments[0]!.created_at as Date
    });
    const projection = projectOrderLifecycle(backwards);
    expect(projection.arrangementHistory[0]!.fundsSummary).toMatchObject({
      netRecordedCollection: { currency: "CNY", minorUnits: 4_000 },
      factCount: 1
    });
  });

  it("replays typed status transitions in order and requires the final order state to match", () => {
    const checkOutBeforeCheckIn = base();
    checkOutBeforeCheckIn.order.status = "CHECKED_OUT";
    checkOutBeforeCheckIn.stay.status = "COMPLETED";
    checkOutBeforeCheckIn.order.version = 3;
    checkOutBeforeCheckIn.activeTimeline = [];
    checkOutBeforeCheckIn.amendments.push(
      amendment({
        id: "amend_2",
        sequence: 2,
        type: "CHECK_OUT",
        payload: {
          fromStatus: "CHECKED_IN",
          toStatus: "CHECKED_OUT",
          businessDate: "2026-08-03",
          effectiveDate: "2026-08-03",
          recordingMode: "ON_SCHEDULE"
        }
      }),
      amendment({
        id: "amend_3",
        sequence: 3,
        type: "CHECK_IN",
        payload: {
          fromStatus: "RESERVED",
          toStatus: "CHECKED_IN",
          businessDate: "2026-08-01",
          effectiveDate: "2026-08-01",
          recordingMode: "ON_SCHEDULE"
        }
      })
    );
    expect(() => projectOrderLifecycle(checkOutBeforeCheckIn)).toThrow(/typed 状态变更顺序/);

    const wrongTransitionPayload = base();
    wrongTransitionPayload.order.status = "CHECKED_IN";
    wrongTransitionPayload.stay.status = "IN_HOUSE";
    wrongTransitionPayload.order.version = 2;
    wrongTransitionPayload.amendments.push(amendment({
      id: "amend_2",
      sequence: 2,
      type: "CHECK_IN",
      payload: {
        fromStatus: "CHECKED_IN",
        toStatus: "CHECKED_IN",
        businessDate: "2026-08-01",
        effectiveDate: "2026-08-01",
        recordingMode: "ON_SCHEDULE"
      }
    }));
    expect(() => projectOrderLifecycle(wrongTransitionPayload)).toThrow(/typed 状态变更顺序/);

    const finalStatusMismatch = base();
    finalStatusMismatch.order.status = "CHECKED_IN";
    finalStatusMismatch.stay.status = "IN_HOUSE";
    expect(() => projectOrderLifecycle(finalStatusMismatch)).toThrow(/最终状态与 typed 状态变更链/);
  });

  it("allows occupant corrections after a terminal transition but rejects later mutable-order amendments", () => {
    const cancelled = base();
    cancelled.order.status = "CANCELLED";
    cancelled.stay.status = "CANCELLED";
    cancelled.order.version = 3;
    cancelled.activeTimeline = [];
    cancelled.amendments.push(
      amendment({
        id: "amend_2",
        sequence: 2,
        type: "CANCEL_ORDER",
        payload: { fromStatus: "RESERVED", toStatus: "CANCELLED" }
      }),
      amendment({
        id: "amend_3",
        sequence: 3,
        type: "CORRECT_ORDER_OCCUPANT",
        payload: { operation: "CORRECT_ORDER_OCCUPANT" }
      })
    );
    cancelled.revisions.push(revision("amend_2", "2026-08-01", "2026-08-03", 0, 2));
    cancelled.order.current_revision_id = "revision_2";
    expect(projectOrderLifecycle(cancelled).fulfillment.state).toBe("CANCELLED");

    cancelled.amendments[2] = amendment({
      id: "amend_3",
      sequence: 3,
      type: "REPRICE_ORDER",
      payload: { operation: "REPRICE_ORDER" }
    });
    cancelled.revisions.push(revision("amend_3", "2026-08-01", "2026-08-03", 10_000, 3));
    cancelled.order.current_revision_id = "revision_3";
    expect(() => projectOrderLifecycle(cancelled)).toThrow(/终态订单包含不允许/);
  });
});
