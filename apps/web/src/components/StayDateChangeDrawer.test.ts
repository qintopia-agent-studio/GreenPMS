import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderViewDto } from "../types";
import {
  buildStayDateChangeRequest,
  StayDateChangeDrawer,
  stayDateChangeActionForDeparture,
  stayDateChangeActionState,
  stayDateChangeInitialDraft
} from "./StayDateChangeDrawer";

function view(overrides: Partial<OrderViewDto> = {}): OrderViewDto {
  return {
    accessLevel: "WRITE",
    allowedActions: [{ code: "RESCHEDULE_STAY", enabled: true, disabledReason: null }],
    order: {
      id: "order_1",
      property_id: "property_1",
      status: "RESERVED",
      stay_type: "TRANSIENT",
      arrival_date: "2026-08-02",
      departure_date: "2026-08-04",
      primary_guest_snapshot: { nickname: "青山" },
      booking_channel_code: "CTRIP",
      channel_order_reference: "CTRIP-1",
      free_stay_reason: null,
      free_stay_category_code: null,
      pricing_policy_version_id: "policy_1",
      member_id: null,
      member_contract_id: null,
      current_revision_id: "revision_1",
      version: 1,
      created_at: "2026-08-01T08:00:00.000Z",
      updated_at: "2026-08-01T08:00:00.000Z"
    },
    occupants: [],
    occupantCorrections: [],
    stay: { id: "stay_1", status: "PLANNED" },
    currentSegment: { id: "segment_1", sequence: 1, inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-04" },
    segments: [],
    originalArrangement: {
      arrivalDate: "2026-08-02",
      departureDate: "2026-08-04",
      intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-04" }]
    },
    effectiveArrangement: {
      arrivalDate: "2026-08-02",
      departureDate: "2026-08-04",
      intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-04" }],
      presentation: "CURRENT",
      businessDate: "2026-08-01"
    },
    fulfillment: { state: "NOT_CHECKED_IN", checkIn: null, checkOut: null },
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
    },
    ...overrides
  };
}

describe("stay date change drawer rules", () => {
  it("requires external channels to enter this order's channel settlement amount anew", () => {
    const current = view();
    const draft = stayDateChangeInitialDraft("RESCHEDULE_STAY", current);
    expect(draft.targetContractYuan).toBe("");
    expect(() => buildStayDateChangeRequest("RESCHEDULE_STAY", current, {
      ...draft,
      newArrivalDate: "2026-08-03",
      newDepartureDate: "2026-08-05",
      reason: "住客调整行程"
    })).toThrow("本单渠道应结金额");

    expect(buildStayDateChangeRequest("RESCHEDULE_STAY", current, {
      ...draft,
      newArrivalDate: "2026-08-03",
      newDepartureDate: "2026-08-05",
      reason: " 住客调整行程 ",
      targetContractYuan: "220",
      channelPriceDifferenceReason: "平台活动价"
    })).toMatchObject({
      commandType: "RESCHEDULE_STAY",
      presentation: "STAY_DATES",
      initialReason: { code: "RESCHEDULE_STAY", note: "住客调整行程" },
      input: {
        propertyId: "property_1",
        orderId: "order_1",
        newArrivalDate: "2026-08-03",
        newDepartureDate: "2026-08-05",
        targetCurrentContractAmountMinor: 22_000,
        channelPriceDifferenceReason: "平台活动价"
      }
    });
  });

  it("uses policy repricing for WECOM unless the operator explicitly adjusts it", () => {
    const current = view({ order: { ...view().order, booking_channel_code: "WECOM", channel_order_reference: null } });
    const base = {
      ...stayDateChangeInitialDraft("RESCHEDULE_STAY", current),
      newDepartureDate: "2026-08-05",
      reason: "延后离店"
    };
    expect(buildStayDateChangeRequest("RESCHEDULE_STAY", current, base).input).not.toHaveProperty("targetCurrentContractAmountMinor");
    expect(() => buildStayDateChangeRequest("RESCHEDULE_STAY", current, {
      ...base,
      manuallyAdjustWecomPrice: true,
      targetContractYuan: "210"
    })).toThrow("人工调价原因");
    expect(buildStayDateChangeRequest("RESCHEDULE_STAY", current, {
      ...base,
      manuallyAdjustWecomPrice: true,
      targetContractYuan: "210",
      manualPriceAdjustmentReason: "店长批准"
    }).input).toMatchObject({
      targetCurrentContractAmountMinor: 21_000,
      manualPriceAdjustmentReason: "店长批准"
    });
  });

  it("keeps member and free stays free of paid pricing inputs", () => {
    const member = view({ order: { ...view().order, booking_channel_code: null, channel_order_reference: null, member_id: "member_1", member_contract_id: "contract_1" } });
    const memberRequest = buildStayDateChangeRequest("RESCHEDULE_STAY", member, {
      ...stayDateChangeInitialDraft("RESCHEDULE_STAY", member),
      newDepartureDate: "2026-08-05",
      reason: "会员改期"
    });
    expect(memberRequest.input).not.toHaveProperty("targetCurrentContractAmountMinor");

    const free = view({ order: { ...view().order, stay_type: "FREE", booking_channel_code: null, channel_order_reference: null } });
    const freeRequest = buildStayDateChangeRequest("RESCHEDULE_STAY", free, {
      ...stayDateChangeInitialDraft("RESCHEDULE_STAY", free),
      newDepartureDate: "2026-08-05",
      reason: "招待行程调整"
    });
    expect(freeRequest.input).not.toHaveProperty("targetCurrentContractAmountMinor");
  });

  it("allows Scheme B rescheduling for a reserved order with an existing room-move arrangement", () => {
    const current = view();
    current.effectiveArrangement.intervals = [
      { inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-03" },
      { inventoryUnitId: "room_2", arrivalDate: "2026-08-03", departureDate: "2026-08-04" }
    ];
    expect(stayDateChangeActionState(current)).toEqual({ action: "RESCHEDULE_STAY", enabled: true, reason: null });
  });

  it("only extends checked-in stays and rejects no-op or shortened dates", () => {
    const checkedIn = view({
      allowedActions: [{ code: "EXTEND_STAY", enabled: true, disabledReason: null }],
      order: { ...view().order, status: "CHECKED_IN" },
      stay: { id: "stay_1", status: "IN_HOUSE" },
      fulfillment: { state: "IN_HOUSE", checkIn: null, checkOut: null }
    });
    const draft = stayDateChangeInitialDraft("EXTEND_STAY", checkedIn);
    expect(draft.newArrivalDate).toBe("2026-08-02");
    expect(draft.newDepartureDate).toBe("2026-08-05");
    expect(() => buildStayDateChangeRequest("EXTEND_STAY", checkedIn, { ...draft, newDepartureDate: "2026-08-04", reason: "续住" })).toThrow("晚于原退房日");
  });

  it("uses the same shortening command for a continued stay and an early checkout", () => {
    const checkedIn = view({
      allowedActions: [
        { code: "EXTEND_STAY", enabled: true, disabledReason: null },
        { code: "SHORTEN_STAY", enabled: true, disabledReason: null }
      ],
      order: { ...view().order, status: "CHECKED_IN", arrival_date: "2026-08-01", departure_date: "2026-08-05", booking_channel_code: "WECOM", channel_order_reference: null },
      stay: { id: "stay_1", status: "IN_HOUSE" },
      effectiveArrangement: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-01", departureDate: "2026-08-05" }],
        presentation: "CURRENT",
        businessDate: "2026-08-03"
      },
      fulfillment: { state: "IN_HOUSE", checkIn: null, checkOut: null }
    });
    expect(stayDateChangeActionState(checkedIn, "EXTEND_STAY")?.enabled).toBe(true);
    expect(stayDateChangeActionState(checkedIn, "SHORTEN_STAY")?.enabled).toBe(true);

    const early = stayDateChangeInitialDraft("SHORTEN_STAY", checkedIn, undefined, "EARLY_CHECK_OUT");
    expect(early.newDepartureDate).toBe("2026-08-03");
    expect(buildStayDateChangeRequest("SHORTEN_STAY", checkedIn, { ...early, reason: "住客行程临时变化" })).toMatchObject({
      commandType: "SHORTEN_STAY",
      title: "提前退房",
      input: { newDepartureDate: "2026-08-03" }
    });

    const shortening = stayDateChangeInitialDraft("SHORTEN_STAY", checkedIn);
    expect(shortening.newDepartureDate).toBe("2026-08-04");
    expect(buildStayDateChangeRequest("SHORTEN_STAY", checkedIn, { ...shortening, reason: "后续行程缩短" }).title).toBe("缩短住宿");
    expect(() => buildStayDateChangeRequest("SHORTEN_STAY", checkedIn, { ...shortening, newDepartureDate: "2026-08-02", reason: "追溯" })).toThrow("不能早于当前营业日期");
  });

  it("uses channel-only pricing language in the formal review description", () => {
    const checkedInChannel = view({
      allowedActions: [{ code: "SHORTEN_STAY", enabled: true, disabledReason: null }],
      order: { ...view().order, status: "CHECKED_IN", arrival_date: "2026-08-01", departure_date: "2026-08-05" },
      stay: { id: "stay_1", status: "IN_HOUSE" },
      effectiveArrangement: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-01", departureDate: "2026-08-05" }],
        presentation: "CURRENT",
        businessDate: "2026-08-03"
      },
      fulfillment: { state: "IN_HOUSE", checkIn: null, checkOut: null }
    });
    const request = buildStayDateChangeRequest("SHORTEN_STAY", checkedInChannel, {
      ...stayDateChangeInitialDraft("SHORTEN_STAY", checkedInChannel),
      reason: "住客缩短行程",
      targetContractYuan: "816",
      channelPriceDifferenceReason: "携程活动价格重新确认"
    });

    expect(request.description).toContain("本单渠道应结金额");
    expect(request.description).toContain("渠道价格差异说明");
    expect(request.description).not.toMatch(/已登记收款|待补收|建议退款/);
  });

  it("routes one departure-date adjustment by comparing the new date with the current departure", () => {
    const checkedIn = view({
      allowedActions: [
        { code: "EXTEND_STAY", enabled: true, disabledReason: null },
        { code: "SHORTEN_STAY", enabled: true, disabledReason: null }
      ],
      order: { ...view().order, status: "CHECKED_IN", arrival_date: "2026-08-01", departure_date: "2026-08-05", booking_channel_code: "WECOM", channel_order_reference: null },
      stay: { id: "stay_1", status: "IN_HOUSE" },
      effectiveArrangement: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-01", departureDate: "2026-08-05" }],
        presentation: "CURRENT",
        businessDate: "2026-08-03"
      },
      fulfillment: { state: "IN_HOUSE", checkIn: null, checkOut: null }
    });
    expect(stayDateChangeActionForDeparture(checkedIn, "2026-08-06")).toBe("EXTEND_STAY");
    expect(stayDateChangeActionForDeparture(checkedIn, "2026-08-04")).toBe("SHORTEN_STAY");
    expect(stayDateChangeActionForDeparture(checkedIn, "2026-08-03")).toBe("SHORTEN_STAY");
    expect(stayDateChangeActionForDeparture(checkedIn, "2026-08-05")).toBeUndefined();

    const draft = {
      ...stayDateChangeInitialDraft("EXTEND_STAY", checkedIn, undefined, "ADJUST_DEPARTURE"),
      newDepartureDate: "2026-08-04",
      reason: "住客缩短行程"
    };
    expect(buildStayDateChangeRequest("EXTEND_STAY", checkedIn, draft, "ADJUST_DEPARTURE")).toMatchObject({
      commandType: "SHORTEN_STAY",
      title: "缩短住宿"
    });
    expect(buildStayDateChangeRequest("SHORTEN_STAY", checkedIn, { ...draft, newDepartureDate: "2026-08-06" }, "ADJUST_DEPARTURE")).toMatchObject({
      commandType: "EXTEND_STAY",
      title: "延长住宿"
    });
  });

  it("opens one neutral departure drawer with past dates disabled and no shortening maximum", () => {
    const checkedIn = view({
      allowedActions: [
        { code: "EXTEND_STAY", enabled: true, disabledReason: null },
        { code: "SHORTEN_STAY", enabled: true, disabledReason: null }
      ],
      order: { ...view().order, status: "CHECKED_IN", arrival_date: "2026-08-01", departure_date: "2026-08-05", booking_channel_code: "WECOM", channel_order_reference: null },
      stay: { id: "stay_1", status: "IN_HOUSE" },
      effectiveArrangement: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-01", departureDate: "2026-08-05" }],
        presentation: "CURRENT",
        businessDate: "2026-08-03"
      },
      fulfillment: { state: "IN_HOUSE", checkIn: null, checkOut: null }
    });
    const html = renderToStaticMarkup(createElement(StayDateChangeDrawer, {
      action: "EXTEND_STAY",
      mode: "ADJUST_DEPARTURE",
      view: checkedIn,
      inventoryUnitLabel: "101 · 单人间",
      onClose: () => undefined,
      onSubmit: () => undefined
    }));
    const departureInput = html.match(/<input[^>]*data-testid="stay-date-departure"[^>]*>/)?.[0] ?? "";
    expect(html).toContain("调整退房日期");
    expect(departureInput).toContain('min="2026-08-03"');
    expect(departureInput).toContain('value="2026-08-05"');
    expect(departureInput).not.toContain("max=");
  });

  it("keeps arrival-day and future-move shortening gates server-authoritative and visible", () => {
    const checkedIn = view({
      allowedActions: [{ code: "SHORTEN_STAY", enabled: false, disabledReason: "入住当天暂不办理缩短或提前退房；未实际使用房间时请使用后续的撤销入住流程" }],
      order: { ...view().order, status: "CHECKED_IN" },
      stay: { id: "stay_1", status: "IN_HOUSE" },
      fulfillment: { state: "IN_HOUSE", checkIn: null, checkOut: null }
    });
    expect(stayDateChangeActionState(checkedIn, "SHORTEN_STAY")).toEqual({
      action: "SHORTEN_STAY",
      enabled: false,
      reason: "入住当天暂不办理缩短或提前退房；当前版本尚未开放撤销入住，请在确认住客实际使用房间后再办理入住"
    });
    checkedIn.allowedActions[0]!.disabledReason = "该订单已有尚未生效的换房安排，请在换房流程中处理后再缩短住宿";
    expect(stayDateChangeActionState(checkedIn, "SHORTEN_STAY")?.reason).toContain("尚未生效的换房安排");
  });
});
