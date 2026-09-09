import { describe, expect, it } from "vitest";
import type { OrderRowDto } from "../types";
import { orderRoomTypeLabel } from "./OrdersPage";

const row: OrderRowDto = {
  id: "order-room-search",
  property_id: "property-1",
  status: "RESERVED",
  stay_status: "PLANNED",
  stay_type: "TRANSIENT",
  arrival_date: "2026-09-08",
  departure_date: "2026-09-10",
  primary_guest_snapshot: { nickname: "小满", fullName: "测试住客" },
  current_primary_guest: { nickname: "小满", fullName: "测试住客", phone: "13800000000" },
  booking_channel_code: "WECOM",
  channel_order_reference: null,
  free_stay_reason: null,
  free_stay_category_code: null,
  pricing_policy_version_id: "policy-1",
  member_id: null,
  member_contract_id: null,
  current_revision_id: "revision-1",
  current_contract_amount_minor: 72000,
  currency: "CNY",
  version: 1,
  current_unit_code: "B01-A",
  current_unit_name: "B栋 B01-A · 单人间（独卫）",
  created_at: "2026-09-08T00:00:00.000Z",
  updated_at: "2026-09-08T00:00:00.000Z"
};

describe("订单列表识别", () => {
  it("显示结构化房型而不是从房源名称误读床位", () => {
    expect(orderRoomTypeLabel(row)).toBe("单人间（独卫）");
    expect(orderRoomTypeLabel({ ...row, current_unit_room_type_code: "shared_bath_double", current_unit_name: "A01 · 床位 A" })).not.toContain("床位 A");
  });
});
