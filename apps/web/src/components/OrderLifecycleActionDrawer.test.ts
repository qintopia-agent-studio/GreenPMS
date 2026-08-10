import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderViewDto } from "../types";
import {
  OrderLifecycleActionDrawer,
  buildOrderLifecycleRequest,
  lifecycleActionCopy
} from "./OrderLifecycleActionDrawer";

function view(): OrderViewDto {
  return {
    accessLevel: "WRITE",
    allowedActions: [{ code: "CANCEL_ORDER", enabled: true, disabledReason: null }],
    migrationOverdueHold: null,
    order: {
      id: "order_45",
      property_id: "property_qintopia",
      status: "RESERVED",
      stay_type: "TRANSIENT",
      arrival_date: "2026-08-01",
      departure_date: "2026-08-03",
      primary_guest_snapshot: { fullName: "林晓", nickname: "小林" },
      booking_channel_code: "WECOM",
      channel_order_reference: null,
      free_stay_reason: null,
      free_stay_category_code: null,
      pricing_policy_version_id: "policy_1",
      member_id: null,
      member_contract_id: null,
     current_revision_id: "revision_1",
      current_contract_amount_minor: 10_000,
      currency: "CNY",
      version: 1,
      created_at: "2026-07-31T08:00:00.000Z",
      updated_at: "2026-07-31T08:00:00.000Z"
    },
    occupants: [{ id: "occupant_1", orderId: "order_45", ordinal: 1, role: "PRIMARY", fullName: "林晓", nickname: "小林", phone: null, documentNumber: null, createdAt: "2026-07-31T08:00:00.000Z" }],
    occupantCorrections: [],
    stay: { id: "stay_45", status: "PLANNED" },
    currentSegment: { id: "segment_1", sequence: 1, inventoryUnitId: "room_101", arrivalDate: "2026-08-01", departureDate: "2026-08-03" },
    segments: [],
    originalArrangement: { arrivalDate: "2026-08-01", departureDate: "2026-08-03", intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-08-01", departureDate: "2026-08-03" }] },
    effectiveArrangement: { arrivalDate: "2026-08-01", departureDate: "2026-08-03", intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-08-01", departureDate: "2026-08-03" }], presentation: "CURRENT", businessDate: "2026-07-31" },
    fulfillment: { state: "NOT_CHECKED_IN", checkIn: null, checkOut: null, checkInRevocation: null },
    arrangementHistory: [],
    amendments: [],
    pricingRevisions: [],
    coverageSet: [],
    collectionFacts: [],
    cleaningTasks: [],
    amounts: {
      currentContractAmount: { currency: "CNY", minorUnits: 20_000 },
      netRecordedCollection: { currency: "CNY", minorUnits: 10_000 },
      collectionDifference: { currency: "CNY", minorUnits: 10_000 },
      refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
    }
  };
}

describe("OrderLifecycleActionDrawer", () => {
  it("builds a business-facing cancel request with a mandatory operator reason", () => {
    expect(buildOrderLifecycleRequest("CANCEL_ORDER", view(), "住客取消行程", false, { room_101: "101 · 单人间" })).toEqual({
      commandType: "CANCEL_ORDER",
      title: "取消订单",
      description: expect.stringContaining("退款参考"),
      presentation: "ORDER_LIFECYCLE",
      input: { propertyId: "property_qintopia", orderId: "order_45" },
      inventoryUnitLabels: { room_101: "101 · 单人间" },
      orderLifecycleContext: {
        guestName: "小林",
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03"
      },
      initialReason: { code: "CANCEL_ORDER", note: "住客取消行程" }
    });
    expect(() => buildOrderLifecycleRequest("CANCEL_ORDER", view(), "  ", false)).toThrow("必须填写取消原因");
  });

  it("requires explicit unused-room confirmation before building revoke check-in", () => {
    const checkedIn = view();
    checkedIn.order.status = "CHECKED_IN";
    checkedIn.stay.status = "IN_HOUSE";
    expect(() => buildOrderLifecycleRequest("REVOKE_CHECK_IN", checkedIn, "误点入住", false)).toThrow("确认房间未被实际使用");
    expect(buildOrderLifecycleRequest("REVOKE_CHECK_IN", checkedIn, "住客看房后未入住", true)).toMatchObject({
      commandType: "REVOKE_CHECK_IN",
      input: { propertyId: "property_qintopia", orderId: "order_45", unusedRoomConfirmed: true },
      initialReason: { code: "REVOKE_CHECK_IN", note: "住客看房后未入住" }
    });
  });

  it("renders only Chinese business copy and makes the revoke acknowledgement visible", () => {
    const copy = lifecycleActionCopy("REVOKE_CHECK_IN");
    expect(copy.title).toBe("撤销入住");
    const html = renderToStaticMarkup(createElement(OrderLifecycleActionDrawer, {
      action: "REVOKE_CHECK_IN",
      view: view(),
      inventoryUnitLabels: { room_101: "101 · 单人间" },
      onClose: () => undefined,
      onSubmit: () => undefined
    }));
    expect(html).toContain("小林");
    expect(html).toContain("101 · 单人间");
    expect(html).toContain("确认房间未被实际使用");
    expect(html).toContain("立即恢复可售");
    expect(html).not.toMatch(/REVOKE_CHECK_IN|unusedRoomConfirmed|reason code|Command|Preview/);
  });
});
