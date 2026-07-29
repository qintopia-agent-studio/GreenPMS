import { describe, expect, it } from "vitest";
import type { OrderViewDto } from "../types";
import {
  buildStayDateChangeRequest,
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
      collectionDifference: { currency: "CNY", minorUnits: 10_000 }
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

  it("fails closed visibly for a reserved order with an existing room-move arrangement", () => {
    const current = view();
    current.effectiveArrangement.intervals = [
      { inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-03" },
      { inventoryUnitId: "room_2", arrivalDate: "2026-08-03", departureDate: "2026-08-04" }
    ];
    expect(stayDateChangeActionState(current)).toEqual({
      action: "RESCHEDULE_STAY",
      enabled: false,
      reason: "该订单已有换房安排，当前版本暂不能调整预订日期"
    });
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
});
