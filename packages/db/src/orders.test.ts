import { describe, expect, it } from "vitest";
import { orderAllowedActions } from "./orders.ts";

function action(status: string, code: string, hasRefundableCollection = false) {
  return orderAllowedActions("WRITE", status, hasRefundableCollection)
    .find((candidate) => candidate.code === code);
}

describe("orderAllowedActions", () => {
  it("returns no write actions for READ access", () => {
    for (const status of ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]) {
      expect(orderAllowedActions("READ", status, true)).toEqual([]);
    }
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
