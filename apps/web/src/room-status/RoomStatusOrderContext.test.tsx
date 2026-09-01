import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderViewDto } from "../types";
import { RoomStatusOrderContext } from "./RoomStatusOrderContext";

function orderView(overrides: Partial<OrderViewDto> = {}): OrderViewDto {
  return {
    accessLevel: "WRITE",
    allowedActions: [
      { code: "CORRECT_ORDER_OCCUPANT", enabled: true, disabledReason: null },
      { code: "CHECK_IN", enabled: true, disabledReason: null },
      { code: "CHECK_OUT", enabled: false, disabledReason: "订单尚未入住" }
    ],
    order: {
      id: "order_stage7",
      property_id: "property_qintopia",
      status: "RESERVED",
      stay_type: "TRANSIENT",
      arrival_date: "2026-07-25",
      departure_date: "2026-07-28",
      primary_guest_snapshot: { nickname: "山峰" },
      booking_channel_code: "WECOM",
      channel_order_reference: null,
      free_stay_reason: null,
      free_stay_category_code: null,
      pricing_policy_version_id: "policy_v1",
      member_id: null,
      member_contract_id: null,
     current_revision_id: "revision_1",
      current_contract_amount_minor: 10_000,
      currency: "CNY",
      version: 2,
      created_at: "2026-07-24T10:00:00.000Z",
      updated_at: "2026-07-25T10:00:00.000Z"
    },
    occupants: [{
      id: "occupant_1",
      orderId: "order_stage7",
      ordinal: 1,
      role: "PRIMARY",
      fullName: "测试姓名",
      nickname: "山峰",
      phone: "13900000001",
      documentNumber: "DOC-1",
      createdAt: "2026-07-24T10:00:00.000Z"
    }],
    occupantCorrections: [{
      id: "correction_1",
      orderId: "order_stage7",
      occupantId: "occupant_1",
      sequence: 1,
      priorSnapshot: { fullName: "测试姓名", nickname: "山风", phone: "13900000001", documentNumber: "DOC-1" },
      correctedSnapshot: { fullName: "测试姓名", nickname: "山峰", phone: "13900000001", documentNumber: "DOC-1" },
      reason: { code: "CORRECT_ORDER_OCCUPANT", note: "录入时昵称写错" },
      actor: { subjectId: "operator", displayName: "前台操作员" },
      amendmentId: "amendment_2",
      commandId: "command_2",
      createdAt: "2026-07-25T10:00:00.000Z"
    }],
    stay: { id: "stay_stage7", status: "PLANNED" },
    currentSegment: { id: "segment_2", sequence: 2, inventoryUnitId: "room_102", arrivalDate: "2026-07-27", departureDate: "2026-07-28" },
    segments: [
      { id: "segment_1", stay_id: "stay_stage7", sequence: 1, inventory_unit_id: "room_101", arrival_date: "2026-07-25", departure_date: "2026-07-27", segment_type: "INITIAL", supersedes_segment_id: null, amendment_id: "amendment_1", created_at: "2026-07-24T10:00:00.000Z" },
      { id: "segment_2", stay_id: "stay_stage7", sequence: 2, inventory_unit_id: "room_102", arrival_date: "2026-07-27", departure_date: "2026-07-28", segment_type: "MOVE", supersedes_segment_id: "segment_1", amendment_id: "amendment_2", created_at: "2026-07-25T10:00:00.000Z" }
    ],
    originalArrangement: {
      arrivalDate: "2026-07-25",
      departureDate: "2026-07-28",
      intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-28" }]
    },
    effectiveArrangement: {
      arrivalDate: "2026-07-25",
      departureDate: "2026-07-28",
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-27" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-07-27", departureDate: "2026-07-28" }
      ],
      presentation: "CURRENT",
      businessDate: "2026-07-25"
    },
    fulfillment: { state: "NOT_CHECKED_IN", checkIn: null, checkOut: null, checkInRevocation: null },
    arrangementHistory: [{
      type: "INITIAL_BOOKING",
      before: null,
      after: {
        arrivalDate: "2026-07-25",
        departureDate: "2026-07-28",
        intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-28" }]
      },
      reason: { code: "CREATE_ORDER", note: "" },
      actor: { subjectId: "operator", displayName: "前台操作员" },
      recordedAt: "2026-07-24T10:00:00.000Z",
      pricingSummary: {
        policyBaseAmount: { currency: "CNY", minorUnits: 60000 },
        currentContractAmount: { currency: "CNY", minorUnits: 60000 },
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 }
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: 60000 },
        refundReferenceAmount: { currency: "CNY", minorUnits: 0 },
        factCount: 0
      }
    }, {
      type: "MOVE",
      before: {
        arrivalDate: "2026-07-25",
        departureDate: "2026-07-28",
        intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-28" }]
      },
      after: {
        arrivalDate: "2026-07-25",
        departureDate: "2026-07-28",
        intervals: [
          { inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-27" },
          { inventoryUnitId: "room_102", arrivalDate: "2026-07-27", departureDate: "2026-07-28" }
        ]
      },
      reason: { code: "ROOM_CHANGE", note: "住客申请换房" },
      actor: { subjectId: "operator", displayName: "前台操作员" },
      recordedAt: "2026-07-25T10:00:00.000Z",
      pricingSummary: {
        policyBaseAmount: { currency: "CNY", minorUnits: 60000 },
        currentContractAmount: { currency: "CNY", minorUnits: 60000 },
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 }
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 30000 },
        collectionDifference: { currency: "CNY", minorUnits: 30000 },
        refundReferenceAmount: { currency: "CNY", minorUnits: 0 },
        factCount: 1
      }
    }],
    amendments: [{
      id: "amendment_2",
      order_id: "order_stage7",
      sequence: 2,
      amendment_type: "MOVE_UNIT",
      reason_code: "ROOM_CHANGE",
      reason_note: "住客申请换房",
      prior_version: 1,
      new_version: 2,
      payload: { fromStatus: "RESERVED", toStatus: "CHECKED_IN" },
      command_id: "command_money_1",
      actor: { subjectId: "operator", displayName: "前台操作员" },
      created_at: "2026-07-25T10:00:00.000Z"
    }],
    pricingRevisions: [{
      id: "revision_2",
      order_id: "order_stage7",
      revision_no: 2,
      amendment_id: "amendment_2",
      policy_version_id: "policy_v1",
      arrival_date: "2026-07-25",
      departure_date: "2026-07-28",
      coverage_set: [],
      cash_lines: [],
      policy_base_amount_minor: 60000,
      pricing_basis: "POLICY",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: 60000,
      difference_from_policy_minor: 0,
      reason: { code: "CREATE_ORDER_POLICY_PRICE", note: "" },
      currency: "CNY",
      created_at: "2026-07-25T10:00:00.000Z"
    }],
    coverageSet: [],
    collectionFacts: [{
      fact_id: "fact_1",
      order_id: "order_stage7",
      fact_type: "COLLECTION",
      amount_minor: 30000,
      net_effect_minor: 30000,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "WECOM",
      cash_collector: null,
      note: "定金",
      transaction_reference: "PAY-1",
      pricing_revision_id: "revision_2",
      command_id: "command_2",
      created_at: "2026-07-25T10:00:00.000Z"
    }],
    cleaningTasks: [],
    membershipConversion: null,
    amounts: {
      currentContractAmount: { currency: "CNY", minorUnits: 60000 },
      netRecordedCollection: { currency: "CNY", minorUnits: 30000 },
      collectionDifference: { currency: "CNY", minorUnits: 30000 },
      refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
    },
    ...overrides
  };
}

const units = [
  { id: "room_101", code: "101", name: "一栋101" },
  { id: "room_102", code: "102", name: "一栋102" }
] as never[];

describe("RoomStatusOrderContext", () => {
  it("uses the same overdue in-house warning as the full order page", () => {
    const base = orderView();
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...base.order, status: "CHECKED_IN" },
        stay: { ...base.stay, status: "IN_HOUSE" },
        effectiveArrangement: {
          ...base.effectiveArrangement,
          businessDate: "2026-07-31"
        },
        fulfillment: { ...base.fulfillment, state: "IN_HOUSE" }
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);

    expect(html).toContain("逾期在住，需确认实际状态");
    expect(html).toContain("计划离店日");
    expect(html).toContain("办理迟录退房");
    expect(html).toContain('data-testid="overdue-in-house-alert"');
  });

  it("shows the four typed lifecycle layers, correction audit, and only enabled server actions", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext view={orderView()} units={units} onOpenOrder={() => undefined} onFulfillmentAction={() => undefined} onCorrectOccupant={() => undefined} onLocateRange={() => undefined} />);
    expect(html).toContain("3 夜");
    expect(html).toContain("101 一栋101");
    expect(html).toContain("102 一栋102");
    expect(html).toContain("录入时昵称写错");
    expect(html).toContain("换房");
    expect(html).toContain("原始预订安排");
    expect(html).toContain("当前住宿安排");
    expect(html).toContain("入住与退房结果");
    expect(html).toContain("住宿安排变更历史");
    expect(html).toContain("调整前：101 一栋101");
    expect(html).toContain("调整后：101 一栋101");
    expect(html).toContain("变更时已记录净收款");
    expect(html).toContain("差额");
    expect(html).not.toContain("已结清");
    expect(html).toContain("资金记录");
    expect(html).toContain("收款 ·");
    expect(html).toContain("净影响：");
    expect(html).toContain("外部交易单号：PAY-1");
    expect(html).toContain("方式：企业微信");
    expect(html).toContain("定位调整后第 1 段");
    expect(html).not.toContain("MOVE_UNIT");
    expect(html).not.toContain("INITIAL");
    expect(html).not.toContain("Segment ID");
    expect(html).not.toContain("payload");
    expect(html).toContain("更正资料");
    expect(html).toContain("办理入住");
    expect(html).toContain('data-room-status-action-mode="inline"');
    expect(html).not.toContain("办理退房");
  });

  it("shows external-channel contract pricing without per-order collection language after refresh", () => {
    const base = orderView();
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: {
          ...base.order,
          booking_channel_code: "CTRIP",
          channel_order_reference: "CTRIP-204",
          current_revision_id: "revision_channel"
        },
        pricingRevisions: [{
          ...base.pricingRevisions[0]!,
          id: "revision_channel",
          pricing_basis: "CHANNEL_CONTRACT",
          policy_base_amount_minor: 69_600,
          current_contract_amount_minor: 81_600,
          difference_from_policy_minor: 12_000,
          reason: { code: "CHANNEL_PRICE_DIFFERENCE", note: "携程活动价格重新确认" }
        }],
        amounts: {
          currentContractAmount: { currency: "CNY", minorUnits: 81_600 },
          netRecordedCollection: { currency: "CNY", minorUnits: 90_000 },
          collectionDifference: { currency: "CNY", minorUnits: -8_400 },
          refundReferenceAmount: { currency: "CNY", minorUnits: 8_400 }
        }
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);

    expect(html).toContain("政策基础金额");
    expect(html).toContain("本单渠道应结金额");
    expect(html).toContain("与政策基础金额差额");
    expect(html).toContain("渠道价格差异说明");
    expect(html).toContain("携程活动价格重新确认");
    expect(html).toContain("资金记录");
    expect(html).toContain("收款 ·");
    expect(html).not.toMatch(/已登记净收款|待补收参考|多收差额|建议退款/);
  });

  it.each(["POLICY", "MANUAL_ADJUSTMENT"] as const)("keeps external-channel semantics after a later %s repricing", (pricingBasis) => {
    const base = orderView();
    const policyBaseAmount = 69_600;
    const currentContractAmount = pricingBasis === "POLICY" ? policyBaseAmount : 75_000;
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: {
          ...base.order,
          booking_channel_code: "MEITUAN",
          channel_order_reference: "MEITUAN-204",
          current_revision_id: "revision_reprice"
        },
        pricingRevisions: [{
          ...base.pricingRevisions[0]!,
          id: "revision_reprice",
          pricing_basis: pricingBasis,
          policy_base_amount_minor: policyBaseAmount,
          current_contract_amount_minor: currentContractAmount,
          difference_from_policy_minor: currentContractAmount - policyBaseAmount,
          manual_adjustment_minor: pricingBasis === "MANUAL_ADJUSTMENT" ? currentContractAmount - policyBaseAmount : 0,
          reason: { code: "REPRICE_ORDER", note: pricingBasis === "POLICY" ? "恢复政策价" : "渠道重新协商" }
        }],
        amounts: {
          currentContractAmount: { currency: "CNY", minorUnits: currentContractAmount },
          netRecordedCollection: { currency: "CNY", minorUnits: 90_000 },
          collectionDifference: { currency: "CNY", minorUnits: currentContractAmount - 90_000 },
          refundReferenceAmount: { currency: "CNY", minorUnits: 90_000 - currentContractAmount }
        }
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);

    expect(html).toContain("政策基础金额");
    expect(html).toContain("本单渠道应结金额");
    expect(html).toContain("与政策基础金额差额");
    expect(html).toContain("渠道价格差异说明");
    expect(html).not.toMatch(/已登记净收款|待补收参考|多收差额|建议退款/);
  });

  it("keeps check-in and check-out local while routing complex order actions to order detail", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        allowedActions: [
          { code: "CHECK_IN", enabled: true, disabledReason: null },
          { code: "CHECK_OUT", enabled: true, disabledReason: null },
          { code: "MOVE_UNIT", enabled: true, disabledReason: null },
          { code: "REPRICE_ORDER", enabled: true, disabledReason: null }
        ]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onMoveUnit={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html.match(/data-room-status-action-mode="inline"/g)).toHaveLength(3);
    expect(html.match(/data-room-status-action-mode="order-detail"/g)).toHaveLength(1);
    expect(html).toContain("办理入住");
    expect(html).toContain("办理退房");
    expect(html).toContain("换房");
    expect(html).toContain("调整订单金额");
  });

  it("keeps cancel, no-show and revoke check-in inside the current room-status context", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        allowedActions: [
          { code: "CANCEL_ORDER", enabled: true, disabledReason: null },
          { code: "MARK_NO_SHOW", enabled: true, disabledReason: null },
          { code: "REVOKE_CHECK_IN", enabled: true, disabledReason: null }
        ]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onLifecycleAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html.match(/data-room-status-action-mode="inline"/g)).toHaveLength(3);
    expect(html).toContain('data-room-status-action="CANCEL_ORDER"');
    expect(html).toContain('data-room-status-action="MARK_NO_SHOW"');
    expect(html).toContain('data-room-status-action="REVOKE_CHECK_IN"');
    expect(html).not.toContain('data-room-status-action-mode="order-detail"');
  });

  it("exposes one in-house departure-date adjustment entry instead of three competing actions", () => {
    const base = orderView();
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        allowedActions: [
          { code: "CHECK_OUT", enabled: false, disabledReason: "DEPARTURE_DATE_NOT_REACHED" },
          { code: "EXTEND_STAY", enabled: true, disabledReason: null },
          { code: "SHORTEN_STAY", enabled: true, disabledReason: null }
        ],
        order: { ...base.order, status: "CHECKED_IN" },
        stay: { id: base.stay.id, status: "IN_HOUSE" },
        effectiveArrangement: {
          ...base.effectiveArrangement,
          businessDate: "2026-07-26",
          intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-28" }]
        },
        fulfillment: {
          state: "IN_HOUSE",
          checkIn: {
            type: "CHECK_IN",
            plannedBusinessDate: "2026-07-25",
            recordedBusinessDate: "2026-07-25",
            recordingMode: "ON_SCHEDULE",
            recordedAt: "2026-07-25T08:00:00.000Z",
            actor: { subjectId: "operator", displayName: "前台操作员" },
            reason: { code: "CHECK_IN", note: "" }
          },
          checkOut: null,
          checkInRevocation: null
        }
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onDateAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain('data-room-status-action="ADJUST_DEPARTURE"');
    expect(html).toContain("调整退房日期");
    expect(html).not.toContain('data-room-status-action="EXTEND_STAY"');
    expect(html).not.toContain('data-room-status-action="SHORTEN_STAY"');
    expect(html).not.toContain('data-room-status-action="EARLY_CHECK_OUT"');
    expect(html).not.toContain('data-room-status-action-mode="inline">办理退房');
  });

  it("keeps Scheme B multi-room rescheduling and extension inside room status", () => {
    const multiRoom = orderView({
      allowedActions: [{ code: "RESCHEDULE_STAY", enabled: true, disabledReason: null }]
    });
    const blockedHtml = renderToStaticMarkup(<RoomStatusOrderContext
      view={multiRoom}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onDateAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(blockedHtml).toContain('data-room-status-action="RESCHEDULE_STAY"');
    expect(blockedHtml).not.toContain("该订单已有换房安排，当前版本暂不能调整住宿日期");

    const singleRoom = orderView({
      effectiveArrangement: {
        ...orderView().effectiveArrangement,
        intervals: [{ inventoryUnitId: "room_101", arrivalDate: "2026-07-25", departureDate: "2026-07-28" }]
      },
      allowedActions: [{ code: "RESCHEDULE_STAY", enabled: true, disabledReason: null }]
    });
    const enabledHtml = renderToStaticMarkup(<RoomStatusOrderContext
      view={singleRoom}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onDateAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(enabledHtml).toContain("调整住宿日期");
    expect(enabledHtml).not.toContain("调整预订日期");
    expect(enabledHtml).toContain('data-room-status-action="RESCHEDULE_STAY"');
    expect(enabledHtml).toContain('data-room-status-action-mode="inline"');
  });

  it("keeps local fulfillment visible but disabled while room-status writes are blocked", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView()}
      units={units}
      writeBlocked
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-room-status-action-mode="inline"[^>]*>办理入住/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>[\s\S]*?更正资料<\/button>/);
  });

  it("shows a disabled in-house membership-upgrade route together with the server reason", () => {
    const base = orderView();
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: {
          ...base.order,
          status: "CHECKED_IN",
          stay_type: "TRANSIENT",
          booking_channel_code: null
        },
        stay: { ...base.stay, status: "IN_HOUSE" },
        allowedActions: [{
          code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
          enabled: false,
          disabledReason: "只有企业微信来源的普通住宿订单可以升级会员"
        }]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-room-status-action="CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"/);
    expect(html).toContain("升级会员");
    expect(html).toContain("只有企业微信来源的普通住宿订单可以升级会员");
  });

  it("describes an invalid transfer graph without claiming every refunded collection is forbidden", () => {
    const base = orderView();
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...base.order, status: "CHECKED_IN", stay_type: "TRANSIENT", booking_channel_code: "WECOM" },
        stay: { ...base.stay, status: "IN_HOUSE" },
        allowedActions: [{
          code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
          enabled: false,
          disabledReason: "NO_TRANSFERABLE_COLLECTION"
        }]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain("企微住宿净收款无法安全全量转入");
    expect(html).not.toContain("已退款、冲销");
  });

  it("keeps authoritative order facts readable while exposing no write entry to READ access", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext view={orderView({ accessLevel: "READ", allowedActions: [] })} units={units} onOpenOrder={() => undefined} onFulfillmentAction={() => undefined} onCorrectOccupant={() => undefined} onLocateRange={() => undefined} />);
    expect(html).toContain("山峰");
    expect(html).toContain("查看完整订单");
    expect(html).not.toContain("更正资料");
    expect(html).not.toContain("办理入住");
    expect(html).toContain("只读");
  });

  it("counts only active member coverage and keeps room-night and bed-night units distinct", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...orderView().order, member_id: "member_1", member_contract_id: "contract_1" },
        coverageSet: [
          { id: "coverage_1", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_1", inventory_unit_id: "room_101", service_date: "2026-07-25", unit_kind: "ROOM_NIGHT", status: "CONSUMED", held_by_revision_id: "revision_1", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" },
          { id: "coverage_2", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_1", inventory_unit_id: "room_101", service_date: "2026-07-26", unit_kind: "ROOM_NIGHT", status: "RELEASED", held_by_revision_id: "revision_1", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" },
          { id: "coverage_3", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_2", inventory_unit_id: "room_102", service_date: "2026-07-27", unit_kind: "BED_NIGHT", status: "HELD", held_by_revision_id: "revision_2", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" }
        ]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain("会员权益 · 1 房晚 · 1 床晚");
    expect(html).not.toContain("2 房晚");
  });

  it("identifies the exact member product and links to the corresponding member profile", () => {
    const member = {
      member: {
        id: "member_1",
        identity_card_number: "ID-1",
        full_name: "阶段十会员住客",
        phone: "13800000000",
        wechat: "wx-member-1",
        created_at: "2026-07-20T10:00:00.000Z"
      },
      membershipOrders: [{
        order: {
          id: "membership_order_1",
          member_id: "member_1",
          status: "ACTIVE",
          contract_id: "contract_1",
          product_name: "公卫单人间会员",
          entitlement_lot_id: "lot_1"
        }
      }, {
        order: {
          id: "membership_order_other_contract",
          member_id: "member_1",
          status: "ACTIVE",
          contract_id: "contract_other",
          product_name: "其他合同会员产品",
          entitlement_lot_id: "lot_other"
        }
      }]
    } as never;
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...orderView().order, member_id: "member_1", member_contract_id: "contract_1" },
        coverageSet: [
          { id: "coverage_1", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_1", inventory_unit_id: "room_101", service_date: "2026-07-25", unit_kind: "ROOM_NIGHT", status: "CONSUMED", held_by_revision_id: "revision_1", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" },
          { id: "coverage_2", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_1", inventory_unit_id: "room_101", service_date: "2026-07-26", unit_kind: "ROOM_NIGHT", status: "HELD", held_by_revision_id: "revision_1", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" }
        ]
      })}
      units={units}
      memberView={member}
      onOpenMember={() => undefined}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain("会员：阶段十会员住客");
    expect(html).toContain("使用权益：公卫单人间会员");
    expect(html).toContain("已核销 1 间夜");
    expect(html).toContain("已冻结 1 间夜");
    expect(html).toContain("查看会员档案");
    expect(html).not.toContain("contract_1");
    expect(html).not.toContain("lot_1");
    expect(html).not.toContain("其他合同会员产品");
  });

  it("uses the active contract product even when current coverage belongs to another entitlement lot", () => {
    const member = {
      member: {
        id: "member_1",
        identity_card_number: "ID-1",
        full_name: "阶段十会员住客",
        phone: "13800000000",
        wechat: "wx-member-1",
        created_at: "2026-07-20T10:00:00.000Z"
      },
      membershipOrders: [{
        order: {
          id: "membership_order_1",
          member_id: "member_1",
          status: "ACTIVE",
          contract_id: "contract_1",
          product_name: "合同对应会员产品",
          entitlement_lot_id: "lot_other"
        }
      }]
    } as never;
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...orderView().order, member_id: "member_1", member_contract_id: "contract_1" },
        coverageSet: [
          { id: "coverage_1", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_1", inventory_unit_id: "room_101", service_date: "2026-07-25", unit_kind: "ROOM_NIGHT", status: "CONSUMED", held_by_revision_id: "revision_1", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" }
        ]
      })}
      units={units}
      memberView={member}
      onOpenMember={() => undefined}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain("合同对应会员产品");
    expect(html).toContain("查看会员档案");
    expect(html).not.toContain("已核销 1 间夜");
  });

  it("shows the active contract member and product when the current coverage set is empty", () => {
    const member = {
      member: {
        id: "member_1",
        identity_card_number: "ID-1",
        full_name: "阶段十会员住客",
        phone: "13800000000",
        wechat: "wx-member-1",
        created_at: "2026-07-20T10:00:00.000Z"
      },
      membershipOrders: [{
        order: {
          id: "membership_order_1",
          member_id: "member_1",
          status: "ACTIVE",
          contract_id: "contract_1",
          product_name: "公卫单人间会员",
          entitlement_lot_id: "lot_1"
        }
      }, {
        order: {
          id: "membership_order_other_contract",
          member_id: "member_1",
          status: "ACTIVE",
          contract_id: "contract_other",
          product_name: "其他合同会员产品",
          entitlement_lot_id: "lot_other"
        }
      }]
    } as never;
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...orderView().order, member_id: "member_1", member_contract_id: "contract_1" },
        coverageSet: []
      })}
      units={units}
      memberView={member}
      onOpenMember={() => undefined}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain("会员：阶段十会员住客");
    expect(html).toContain("使用权益：公卫单人间会员");
    expect(html).toContain("查看会员档案");
    expect(html).not.toMatch(/已核销|已冻结/);
  });

  it("does not link a draft membership order even when a damaged DTO exposes an active lot", () => {
    const member = {
      member: {
        id: "member_1",
        identity_card_number: "ID-1",
        full_name: "阶段十会员住客",
        phone: "13800000000",
        wechat: "wx-member-1",
        created_at: "2026-07-20T10:00:00.000Z"
      },
      membershipOrders: [{
        order: {
          id: "membership_order_1",
          member_id: "member_1",
          status: "DRAFT",
          contract_id: "contract_1",
          product_name: "未生效会员产品",
          entitlement_lot_id: "lot_1"
        }
      }, {
        order: {
          id: "membership_order_wrong_contract",
          member_id: "member_1",
          status: "ACTIVE",
          contract_id: "contract_wrong",
          product_name: "错误合同会员产品",
          entitlement_lot_id: "lot_wrong"
        }
      }]
    } as never;
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...orderView().order, member_id: "member_1", member_contract_id: "contract_1" },
        coverageSet: [
          { id: "coverage_1", order_id: "order_stage7", contract_id: "contract_1", lot_id: "lot_1", inventory_unit_id: "room_101", service_date: "2026-07-25", unit_kind: "ROOM_NIGHT", status: "CONSUMED", held_by_revision_id: "revision_1", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-25T10:00:00.000Z" }
        ]
      })}
      units={units}
      memberView={member}
      onOpenMember={() => undefined}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).not.toContain("未生效会员产品");
    expect(html).not.toContain("错误合同会员产品");
    expect(html).not.toContain("其他合同会员产品");
    expect(html).not.toContain("查看会员档案");
  });

  it("hides historical cleaning tasks while the current release keeps the workflow disabled", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        order: { ...orderView().order, status: "CHECKED_OUT" },
        stay: { ...orderView().stay, status: "COMPLETED" },
        cleaningTasks: [{
          id: "cleaning_internal",
          inventoryUnitId: "room_102",
          serviceDate: "2026-07-28",
          status: "COMPLETED",
          createdAt: "2026-07-28T10:00:00.000Z",
          completedAt: "2026-07-28T11:00:00.000Z",
          createdBy: { subjectId: "operator", displayName: "前台操作员" },
          completedBy: { subjectId: "housekeeper", displayName: "清洁员" }
        }]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html).toContain("已退房");
    expect(html).not.toContain("清洁任务");
    expect(html).not.toContain("清洁员");
    expect(html).not.toMatch(/CHECKED_OUT|COMPLETED|cleaning_internal/);
  });
});
