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
    fulfillment: { checkIn: null, checkOut: null },
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
      note: "定金",
      transaction_reference: "PAY-1",
      pricing_revision_id: "revision_2",
      command_id: "command_2",
      created_at: "2026-07-25T10:00:00.000Z"
    }],
    cleaningTasks: [],
    amounts: {
      currentContractAmount: { currency: "CNY", minorUnits: 60000 },
      netRecordedCollection: { currency: "CNY", minorUnits: 30000 },
      collectionDifference: { currency: "CNY", minorUnits: 30000 }
    },
    ...overrides
  };
}

const units = [
  { id: "room_101", code: "101", name: "一栋101" },
  { id: "room_102", code: "102", name: "一栋102" }
] as never[];

describe("RoomStatusOrderContext", () => {
  it("shows the complete Stay, each segment, correction audit, and only enabled server actions", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext view={orderView()} units={units} onOpenOrder={() => undefined} onFulfillmentAction={() => undefined} onCorrectOccupant={() => undefined} onLocateRange={() => undefined} />);
    expect(html).toContain("3 夜");
    expect(html).toContain("101 一栋101");
    expect(html).toContain("102 一栋102");
    expect(html).toContain("录入时昵称写错");
    expect(html).toContain("换房");
    expect(html).toContain("101 一栋101 → 102 一栋102");
    expect(html).toContain("操作人：前台操作员");
    expect(html).toContain("变更时资金：已收净额");
    expect(html).toContain("相关资金：收款 ¥300.00 · PAY-1");
    expect(html).toContain("资金记录");
    expect(html).toContain("收款 ·");
    expect(html).toContain("定位这次变更");
    expect(html).not.toContain("MOVE_UNIT");
    expect(html).not.toContain("INITIAL");
    expect(html).toContain("更正资料");
    expect(html).toContain("办理入住");
    expect(html).toContain('data-room-status-action-mode="inline"');
    expect(html).not.toContain("办理退房");
  });

  it("keeps check-in and check-out local while routing complex order actions to order detail", () => {
    const html = renderToStaticMarkup(<RoomStatusOrderContext
      view={orderView({
        allowedActions: [
          { code: "CHECK_IN", enabled: true, disabledReason: null },
          { code: "CHECK_OUT", enabled: true, disabledReason: null },
          { code: "REPRICE_ORDER", enabled: true, disabledReason: null }
        ]
      })}
      units={units}
      onOpenOrder={() => undefined}
      onFulfillmentAction={() => undefined}
      onCorrectOccupant={() => undefined}
      onLocateRange={() => undefined}
    />);
    expect(html.match(/data-room-status-action-mode="inline"/g)).toHaveLength(2);
    expect(html.match(/data-room-status-action-mode="order-detail"/g)).toHaveLength(1);
    expect(html).toContain("办理入住");
    expect(html).toContain("办理退房");
    expect(html).toContain("调整订单金额");
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
