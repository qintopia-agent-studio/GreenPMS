import { describe, expect, it } from "vitest";
import type { RoomStatusDayDto, RoomStatusUnitDto } from "@qintopia/contracts";
import { roomStatusCellAccessibleName, rowDescription } from "./RoomStatusGrid";
import {
  roomStatusBedOccupantLabels,
  roomStatusIntervalBusinessLabel,
  roomStatusIntervalGridLabel,
  roomStatusOccupancyCapacity,
  roomStatusOccupantLabelLines,
  roomStatusRowSalesLabel,
  roomStatusSaleCapabilityLabel,
  roomStatusSelectedSaleLabel,
  roomStatusRoomTypeLabel,
  roomStatusUnitDescription,
  roomStatusUnitLabel,
  roomStatusUnitLocationLabel
} from "./roomStatusPresentation";

describe("room status lodging presentation", () => {
  it("keeps every bed nickname in stable DTO order without deduplicating", () => {
    expect(roomStatusBedOccupantLabels([
      { primaryOccupantLabel: "山风" },
      { primaryOccupantLabel: "同名住客" },
      { primaryOccupantLabel: "同名住客" },
      { primaryOccupantLabel: "北辰" }
    ])).toEqual(["山风", "同名住客", "同名住客", "北辰"]);
  });

  it("uses an explicit compatibility label for every historical missing nickname", () => {
    expect(roomStatusBedOccupantLabels([
      { primaryOccupantLabel: null },
      { primaryOccupantLabel: "  " }
    ])).toEqual(["历史未记录", "历史未记录"]);
  });

  it("packs visible nicknames two per line with an ideographic comma", () => {
    expect(roomStatusOccupantLabelLines(["山风", "小满", "小满", "北辰"]))
      .toEqual(["山风、小满", "小满、北辰"]);
    expect(roomStatusOccupantLabelLines(["山风", "小满", "历史未记录"]))
      .toEqual(["山风、小满", "历史未记录"]);
  });

  it("shows every whole-room nickname and the occupant count without exposing stable order IDs", () => {
    expect(roomStatusIntervalBusinessLabel({
      sourceKind: "ORDER",
      status: "RESERVED",
      label: "订单 order_stage5_secret",
      primaryOccupantLabel: "山风",
      occupantCount: 3,
      occupants: [
        { occupantId: "occupant_1", nickname: "山风" },
        { occupantId: "occupant_2", nickname: "同名住客" },
        { occupantId: "occupant_3", nickname: "同名住客" }
      ]
    })).toBe("山风、同名住客、同名住客 · 3人");
    expect(roomStatusIntervalBusinessLabel({
      sourceKind: "FREE_STAY",
      status: "IN_HOUSE",
      label: "免费入住 order_stage5_secret",
      primaryOccupantLabel: null,
      occupantCount: 1,
      occupants: [{ occupantId: "occupant_history", nickname: null }]
    })).toBe("历史未记录 · 1人");
    expect(roomStatusIntervalBusinessLabel({
      sourceKind: "MAINTENANCE",
      status: "MAINTENANCE",
      label: "维修锁房",
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: []
    })).toBe("维修锁房");
    expect(roomStatusIntervalBusinessLabel({
      sourceKind: "ORDER",
      status: "UNKNOWN",
      label: "不得展示的订单标签",
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: []
    })).toBe("状态未知");
  });

  it("derives room-status copy only from nicknames even if an unsafe runtime object has extra personal fields", () => {
    const label = roomStatusIntervalBusinessLabel({
      sourceKind: "ORDER",
      status: "RESERVED",
      label: "unsafe source",
      primaryOccupantLabel: "山风",
      occupantCount: 2,
      occupants: [
        { occupantId: "occupant_1", nickname: "山风", fullName: "隐私姓名", phone: "13800000000" },
        { occupantId: "occupant_2", nickname: "小满", documentNumber: "PRIVATE-DOC" }
      ]
    } as never);

    expect(label).toBe("山风、小满 · 2人");
    expect(label).not.toMatch(/隐私姓名|13800000000|PRIVATE-DOC/);
  });

  it("keeps whole-room accessible names limited to nicknames and occupant count", () => {
    const interval = {
      id: "interval_private_test",
      sourceKind: "ORDER",
      status: "RESERVED",
      label: "order_private_test",
      primaryOccupantLabel: "山风",
      occupantCount: 2,
      occupants: [
        { occupantId: "occupant_1", nickname: "山风", fullName: "隐私姓名", phone: "13800000000" },
        { occupantId: "occupant_2", nickname: "小满", documentNumber: "PRIVATE-DOC" }
      ]
    } as unknown as RoomStatusUnitDto["intervals"][number];
    const unit = {
      kind: "ROOM",
      code: "201",
      name: "大床房",
      buildingCode: "2",
      intervals: [interval]
    } as unknown as RoomStatusUnitDto;
    const day = {
      serviceDate: "2026-07-24",
      status: "RESERVED",
      available: false,
      intervalIds: [interval.id],
      conflicts: []
    } satisfies RoomStatusDayDto;

    const accessibleName = roomStatusCellAccessibleName(unit, day.serviceDate, day, null);
    expect(accessibleName).toMatch(/山风、小满 · 2人/);
    expect(accessibleName).not.toMatch(/隐私姓名|13800000000|PRIVATE-DOC|order_private_test/);
  });

  it("uses a compact bed-specific maintenance label in a parent room row", () => {
    const bed = {
      id: "bed_101_d",
      kind: "BED",
      code: "101-D",
      children: []
    } as const;
    const room = {
      id: "room_101",
      kind: "ROOM",
      code: "101",
      children: [bed]
    } as const;
    const maintenance = {
      sourceKind: "MAINTENANCE",
      status: "MAINTENANCE",
      actualInventoryUnitId: "bed_101_d",
      label: "Maintenance lock",
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: []
    } as const;

    expect(roomStatusIntervalGridLabel(maintenance, room)).toBe("D 维修/锁房");
    expect(roomStatusIntervalGridLabel(maintenance, bed)).toBe("维修/锁房");
    expect(roomStatusIntervalGridLabel({ ...maintenance, status: "UNKNOWN" }, room)).toBe("状态未知");
  });
});

describe("room status unit presentation", () => {
  it("uses lodging capacity instead of physical bed count for a king room", () => {
    const unit = {
      kind: "ROOM",
      salesMode: "WHOLE_ROOM",
      capacity: 1,
      occupancyCapacity: 2
    } as RoomStatusUnitDto;

    expect(roomStatusOccupancyCapacity(unit)).toBe(2);
    expect(rowDescription(unit)).toBe("房间，整房销售，容纳 2 人");
  });

  it("uses building, room code, and room type without repeating the code", () => {
    const unit = { kind: "ROOM", code: "302", name: "302 · 单人间（公卫）", buildingCode: "3" } as const;

    expect(roomStatusUnitLabel(unit)).toBe("3栋 302 单人间（公卫）");
    expect(roomStatusUnitLocationLabel(unit)).toBe("3栋 302");
    expect(roomStatusUnitDescription(unit)).toBe("单人间（公卫）");
  });

  it("shows room type filter options in Chinese business language", () => {
    expect(roomStatusRoomTypeLabel("shared_bath_single")).toBe("单人间（公卫）");
    expect(roomStatusRoomTypeLabel("private_bath_standard")).toBe("标间（独卫）");
    expect(roomStatusRoomTypeLabel("PUBLIC_FOUR_BED")).toBe("四人间（公卫）");
  });

  it("uses the parent room location for a named bed", () => {
    const unit = { kind: "BED", code: "101-A", name: "101 · 床位 A", buildingCode: "1" } as const;

    expect(roomStatusUnitLabel(unit)).toBe("1栋 101 床位 A");
    expect(roomStatusUnitLocationLabel(unit)).toBe("1栋 101-A");
    expect(roomStatusUnitDescription(unit)).toBe("床位 A");
  });

  it("falls back from legacy English room names to the catalog room type", () => {
    const room = {
      kind: "ROOM",
      code: "101",
      name: "Room 101",
      buildingCode: "1",
      roomTypeCode: "shared_bath_quad"
    } as const;
    const bed = {
      kind: "BED",
      code: "101-A",
      name: "Room 101 / Bed A",
      buildingCode: "1",
      roomTypeCode: "shared_bath_quad"
    } as const;

    expect(roomStatusUnitDescription(room)).toBe("四人间（公卫）");
    expect(roomStatusUnitLabel(room)).toBe("1栋 101 四人间（公卫）");
    expect(roomStatusUnitDescription(bed)).toBe("床位 A");
    expect(roomStatusUnitLabel(bed)).toBe("1栋 101 床位 A");
  });

  it("does not expose legacy English room names when the catalog type is missing", () => {
    const room = {
      kind: "ROOM",
      code: "101",
      name: "Room 101",
      buildingCode: "1"
    } as const;

    expect(roomStatusUnitDescription(room)).toBe("房间");
    expect(roomStatusUnitLabel(room)).toBe("1栋 101 房间");
  });

  it("keeps the stable code when a custom name does not contain it", () => {
    const unit = { kind: "ROOM", code: "D01", name: "养蜂单人间", buildingCode: "D" } as const;

    expect(roomStatusUnitLabel(unit)).toBe("D栋 D01 养蜂单人间");
  });
});

describe("room status sales presentation", () => {
  it("describes a split-capable room selection as whole-room sales", () => {
    const unit = { kind: "ROOM", salesMode: "BED_SPLIT" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("整房销售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("支持整房及单床销售");
    expect(roomStatusRowSalesLabel(unit)).toBe("整房/单床");
  });

  it("describes a bed selection as single-bed sales", () => {
    const unit = { kind: "BED", salesMode: "BED_SPLIT" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("单床销售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("支持整房及单床销售");
    expect(roomStatusRowSalesLabel(unit)).toBe("单床销售");
  });

  it("describes a whole-room-only unit without implying bed sales", () => {
    const unit = { kind: "ROOM", salesMode: "WHOLE_ROOM" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("整房销售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("仅整房销售");
    expect(roomStatusRowSalesLabel(unit)).toBe("整房销售");
  });

  it("keeps unavailable inventory explicit", () => {
    const unit = { kind: "ROOM", salesMode: "UNAVAILABLE" } as const;

    expect(roomStatusSelectedSaleLabel(unit)).toBe("不可售");
    expect(roomStatusSaleCapabilityLabel(unit)).toBe("当前不可售");
    expect(roomStatusRowSalesLabel(unit)).toBe("不可售");
  });
});
