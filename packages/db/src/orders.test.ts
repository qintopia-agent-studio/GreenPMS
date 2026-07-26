import { describe, expect, it } from "vitest";
import { orderAllowedActions, projectOrderFulfillment } from "./orders.ts";

function action(
  status: string,
  code: string,
  hasRefundableCollection = false,
  fulfillmentDates?: { businessDate: string; arrivalDate: string; departureDate: string }
) {
  return orderAllowedActions("WRITE", status, hasRefundableCollection, fulfillmentDates)
    .find((candidate) => candidate.code === code);
}

describe("orderAllowedActions", () => {
  it("returns no write actions for READ access", () => {
    for (const status of ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]) {
      expect(orderAllowedActions("READ", status, true)).toEqual([]);
    }
  });

  it("enables normal fulfillment only on the matching planned business date", () => {
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
      enabled: false,
      disabledReason: "ARRIVAL_DATE_PASSED"
    });
    expect(action("CHECKED_IN", "CHECK_OUT", false, { ...future, businessDate: "2026-08-04" })).toEqual({
      code: "CHECK_OUT",
      enabled: true,
      disabledReason: null
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
      }
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
