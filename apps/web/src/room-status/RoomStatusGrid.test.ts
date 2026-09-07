import { describe, expect, it } from "vitest";
import {
  focusAndRevealRoomStatusCell,
  roomStatusBuildingOccupancySummariesForDate,
  roomStatusBuildingOccupancySummaryLabel,
  roomStatusAttentionLaneOffset,
  roomStatusBedOccupancyNeedsProcessing,
  roomStatusBedOccupancySlots,
  roomStatusBedOccupancyAttentionLabels,
  roomStatusBedHasWholeRoomLodging,
  roomStatusBedOccupancyStateLabel,
  roomStatusOccupancyLifecycleStatus,
  roomStatusOccupancyDisplayRatio,
  roomStatusCellAttentionLabels,
  roomStatusCellAccessibleName,
  roomStatusCellOperationalAttentionTooltipText,
  roomStatusBedOccupancyTooltipPosition,
  roomStatusDateHeaderSummaryLabel,
  roomStatusFocusRestorationTarget,
  roomStatusGridOperationalIntervals,
  roomStatusHorizontalDragAutoScrollDelta,
  roomStatusIntervalServiceDateAtPointer,
  roomStatusTextOverflows,
  roomStatusSingleCellMappingSelection,
  resetRoomStatusHorizontalScroll
} from "./RoomStatusGrid";
import type { RoomStatusBedOccupancyDto, RoomStatusDayDto, RoomStatusIntervalDto, RoomStatusUnitDto } from "@qintopia/contracts";
import { formatRoomStatusDate } from "./roomStatusPresentation";

describe("roomStatusIntervalServiceDateAtPointer", () => {
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

  it("maps every visible part of a multi-day interval to the date that was clicked", () => {
    const bounds = { left: 100, width: 300 };
    expect(roomStatusIntervalServiceDateAtPointer(dates, 0, 3, bounds, 110)).toBe("2026-08-01");
    expect(roomStatusIntervalServiceDateAtPointer(dates, 0, 3, bounds, 210)).toBe("2026-08-02");
    expect(roomStatusIntervalServiceDateAtPointer(dates, 0, 3, bounds, 399)).toBe("2026-08-03");
  });

  it("fails closed to the rendered interval start for keyboard activation or invalid geometry", () => {
    expect(roomStatusIntervalServiceDateAtPointer(dates, 1, 4, { left: 100, width: 0 }, 0)).toBe("2026-08-02");
    expect(roomStatusIntervalServiceDateAtPointer(dates, 1, 4, { left: 100, width: 300 }, Number.NaN)).toBe("2026-08-02");
  });
});

describe("roomStatusAttentionLaneOffset", () => {
  const interval = [{ startColumn: 2, endColumn: 5 }];

  it("reserves a corner-tag lane when an attention cell overlaps a spanning interval", () => {
    expect(roomStatusAttentionLaneOffset(interval, new Set([3]))).toBe(1);
  });

  it("does not grow the row when attention and interval dates do not overlap", () => {
    expect(roomStatusAttentionLaneOffset(interval, new Set([1, 5]))).toBe(0);
  });
});

describe("roomStatusHorizontalDragAutoScrollDelta", () => {
  it("scrolls right only when the pointer is near the right edge", () => {
    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 985,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 240,
      maxScrollLeft: 600
    })).toBeGreaterThan(0);

    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 500,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 240,
      maxScrollLeft: 600
    })).toBe(0);
  });

  it("scrolls left only when the pointer is near the left edge", () => {
    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 115,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 240,
      maxScrollLeft: 600
    })).toBeLessThan(0);

    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 500,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 240,
      maxScrollLeft: 600
    })).toBe(0);
  });

  it("clamps at horizontal scroll boundaries", () => {
    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 115,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 0,
      maxScrollLeft: 600
    })).toBe(0);

    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 985,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 600,
      maxScrollLeft: 600
    })).toBe(0);

    expect(roomStatusHorizontalDragAutoScrollDelta({
      clientX: 985,
      viewportLeft: 100,
      viewportRight: 1000,
      scrollLeft: 590,
      maxScrollLeft: 600
    })).toBe(10);
  });
});

describe("room-status Today reset", () => {
  it("resets both synchronized horizontal scrollers while preserving the body vertical position", () => {
    const calls: unknown[] = [];
    const body = {
      scrollTop: 340,
      scrollTo: (options: unknown) => calls.push(["body", options])
    } as unknown as HTMLElement;
    const header = {
      scrollTo: (options: unknown) => calls.push(["header", options])
    } as unknown as HTMLElement;

    resetRoomStatusHorizontalScroll(body, header);

    expect(calls).toEqual([
      ["body", { left: 0, top: 340, behavior: "auto" }],
      ["header", { left: 0, behavior: "auto" }]
    ]);
  });
});

describe("roomStatusDateHeaderSummaryLabel", () => {
  it("shows future and current dates as remaining sellable inventory", () => {
    expect(roomStatusDateHeaderSummaryLabel("2026-08-14", {
      serviceDate: "2026-08-14",
      availableRooms: 18,
      availableBeds: 12,
      paidOccupiedUnits: 7,
      totalSellableUnits: 77,
      occupantCount: 9
    }, "2026-08-14")).toBe("剩 18 间 · 12 床");
  });

  it("shows historical dates as paid business occupancy and actual paid occupants", () => {
    expect(roomStatusDateHeaderSummaryLabel("2026-08-13", {
      serviceDate: "2026-08-13",
      availableRooms: 18,
      availableBeds: 12,
      paidOccupiedUnits: 17,
      totalSellableUnits: 77,
      occupantCount: 20
    }, "2026-08-14")).toBe("入住率 22% · 20人");
  });

  it("falls back to QinTopia's 77 sellable units when an old response has no denominator", () => {
    expect(roomStatusDateHeaderSummaryLabel("2026-08-13", {
      serviceDate: "2026-08-13",
      availableRooms: 0,
      availableBeds: 0,
      paidOccupiedUnits: 1,
      totalSellableUnits: 0,
      occupantCount: 2
    }, "2026-08-14")).toBe("入住率 1% · 2人");
  });
});

describe("roomStatusSingleCellMappingSelection", () => {
  const singleNight = {
    unitId: "unit_room_107",
    anchorDate: "2026-08-14",
    focusDate: "2026-08-14",
    arrivalDate: "2026-08-14",
    departureDate: "2026-08-15"
  };
  const multiNight = {
    ...singleNight,
    focusDate: "2026-08-16",
    departureDate: "2026-08-17"
  };

  it("uses the live pointer preview immediately even when a previous order stay is still selected", () => {
    expect(roomStatusSingleCellMappingSelection(singleNight, null, "stay_previous")).toEqual({
      unitId: "unit_room_107",
      serviceDate: "2026-08-14"
    });
  });

  it("suppresses persisted single-cell mapping while an order stay is selected", () => {
    expect(roomStatusSingleCellMappingSelection(null, singleNight, "stay_selected")).toBeNull();
  });

  it("does not show single-cell mapping for a dragged date range", () => {
    expect(roomStatusSingleCellMappingSelection(multiNight, null, null)).toBeNull();
  });
});

describe("roomStatusBedOccupancyTooltipPosition", () => {
  it("anchors a constrained tooltip above its trigger without consuming the viewport margin", () => {
    const position = roomStatusBedOccupancyTooltipPosition(
      { bottom: 220, left: 700, top: 190, width: 94 },
      { height: 260, width: 1440 },
      "很长的床位占用说明".repeat(30)
    );

    expect(position.placement).toBe("ABOVE");
    expect(position.top).toBeUndefined();
    expect(position.bottom).toBe(77);
    expect(position.maxHeight).toBe(171);
    expect(260 - position.bottom! - position.maxHeight).toBe(12);
  });

  it("keeps a tooltip below its trigger when the content fits there", () => {
    const position = roomStatusBedOccupancyTooltipPosition(
      { bottom: 50, left: 10, top: 20, width: 94 },
      { height: 900, width: 1440 },
      "已占 1/4"
    );

    expect(position.placement).toBe("BELOW");
    expect(position.top).toBe(57);
    expect(position.bottom).toBeUndefined();
    expect(position.left).toBeGreaterThanOrEqual(172);
  });

  it("clamps a below tooltip when its trigger is partly hidden above the viewport", () => {
    const position = roomStatusBedOccupancyTooltipPosition(
      { bottom: -6.671875, left: 700, top: -92, width: 94 },
      { height: 260, width: 1440 },
      "很长的床位占用说明".repeat(30)
    );

    expect(position.placement).toBe("BELOW");
    expect(position.top).toBe(12);
    expect(position.maxHeight).toBe(236);
    expect(position.top! + position.maxHeight).toBe(248);
  });

  it("uses a scrollable viewport overlay when a tall trigger leaves no usable space on either side", () => {
    const position = roomStatusBedOccupancyTooltipPosition(
      { bottom: 670, left: 700, top: 23.328125, width: 94 },
      { height: 260, width: 1440 },
      "很长的床位占用说明".repeat(30)
    );

    expect(position.placement).toBe("ABOVE");
    expect(position.top).toBeUndefined();
    expect(position.bottom).toBe(12);
    expect(position.maxHeight).toBe(156);
    expect(260 - position.bottom! - position.maxHeight).toBe(92);
  });
});

describe("roomStatusTextOverflows", () => {
  it("only treats a nickname as tooltip-eligible when the rendered box actually clips it", () => {
    expect(roomStatusTextOverflows({ scrollWidth: 64, clientWidth: 64 })).toBe(false);
    expect(roomStatusTextOverflows({ scrollWidth: 65, clientWidth: 64 })).toBe(true);
  });
});

describe("room-status focus restoration", () => {
  const unitIds = ["unit_page_1"];
  const dates = ["2026-08-01", "2026-08-02"];

  it("waits for the exact restored cell instead of consuming restoration on the page fallback", () => {
    expect(roomStatusFocusRestorationTarget({
      unitId: "unit_page_2",
      serviceDate: "2026-08-02"
    }, unitIds, dates)).toBeNull();
    expect(roomStatusFocusRestorationTarget(null, unitIds, dates)).toEqual({
      unitId: "unit_page_1",
      serviceDate: "2026-08-01"
    });
  });

  it("restores only once the exact unit and AUTO-window date are both mounted", () => {
    expect(roomStatusFocusRestorationTarget({
      unitId: "unit_page_2",
      serviceDate: "2026-08-11"
    }, ["unit_page_2"], ["2026-08-10", "2026-08-11"])).toEqual({
      unitId: "unit_page_2",
      serviceDate: "2026-08-11"
    });
  });

  it("reveals the exact cell on both axes before focusing without a second browser scroll", () => {
    const calls: unknown[] = [];
    const ownerDocument = { activeElement: null as unknown };
    const cell = {
      isConnected: true,
      ownerDocument,
      scrollIntoView: (options: unknown) => calls.push(["scroll", options]),
      focus: (options: unknown) => {
        calls.push(["focus", options]);
        ownerDocument.activeElement = cell;
      }
    } as unknown as HTMLElement;

    expect(focusAndRevealRoomStatusCell(cell)).toBe(true);
    expect(calls).toEqual([
      ["scroll", { behavior: "auto", block: "nearest", inline: "nearest" }],
      ["focus", { preventScroll: true }]
    ]);
  });

  it("does not report restoration as complete when the exact cell cannot acquire focus", () => {
    const cell = {
      isConnected: true,
      ownerDocument: { activeElement: null },
      scrollIntoView: () => undefined,
      focus: () => undefined
    } as unknown as HTMLElement;
    expect(focusAndRevealRoomStatusCell(cell)).toBe(false);
  });
});

describe("building occupancy summary", () => {
  const inHouseBedInterval = {
    id: "interval_bed_101_a",
    actualInventoryUnitId: "bed_101_a",
    sourceKind: "ORDER",
    status: "IN_HOUSE",
    startDate: "2026-08-01",
    endDate: "2026-08-03",
    occupantCount: 1
  } as RoomStatusIntervalDto;
  const reservedBedInterval = {
    ...inHouseBedInterval,
    id: "interval_reserved",
    status: "RESERVED",
    occupantCount: 1
  } as RoomStatusIntervalDto;
  const wholeRoomInterval = {
    ...inHouseBedInterval,
    id: "interval_room_102",
    actualInventoryUnitId: "room_102",
    occupantCount: 2
  } as RoomStatusIntervalDto;
  const bed = {
    id: "bed_101_a",
    buildingCode: "1",
    intervals: [inHouseBedInterval, reservedBedInterval]
  } as RoomStatusUnitDto;
  const splitRoom = {
    id: "room_101",
    buildingCode: "1",
    occupancyCapacity: 4,
    intervals: [{ ...inHouseBedInterval, id: "interval_bed_101_a_on_room" }],
    children: [bed]
  } as RoomStatusUnitDto;
  const wholeRoom = {
    id: "room_102",
    buildingCode: "1",
    occupancyCapacity: 2,
    intervals: [wholeRoomInterval],
    children: []
  } as unknown as RoomStatusUnitDto;

  it("summarizes today's in-house occupants and building capacity without double-counting bed facts", () => {
    const summaries = roomStatusBuildingOccupancySummariesForDate([
      { room: splitRoom, children: [bed] },
      { room: wholeRoom, children: [] }
    ], "2026-08-02");

    expect(summaries.get("1")).toEqual({ occupants: 3, capacity: 6 });
  });

  it("formats the building summary exactly as business copy", () => {
    expect(roomStatusBuildingOccupancySummaryLabel({ occupants: 3, capacity: 6 })).toBe("今日 3人 / 总容量 6 人");
  });

  it.each(["ORDER", "FREE_STAY"] as const)("counts %s whole-room stays once across every building", (sourceKind) => {
    const buildingCodes = ["1", "2", "3", "A", "B", "C", "D", "E", null];
    const rooms = buildingCodes.map((buildingCode) => {
      const id = `room_${buildingCode ?? "unassigned"}`;
      const lodging = {
        ...wholeRoomInterval,
        id: `interval_${id}`,
        actualInventoryUnitId: id,
        sourceKind
      };
      const children = ["a", "b"].map((suffix) => ({
        ...bed,
        id: `${id}_${suffix}`,
        intervals: [{ ...lodging, id: `${lodging.id}_on_${suffix}` }]
      }));
      return { room: { ...wholeRoom, id, buildingCode, intervals: [lodging], children }, children };
    });

    const summaries = roomStatusBuildingOccupancySummariesForDate(rooms, "2026-08-02");

    expect([...summaries.keys()]).toEqual(["1", "2", "3", "A", "B", "C", "D", "E", "未分栋"]);
    for (const summary of summaries.values()) {
      expect(summary).toEqual({ occupants: 2, capacity: 2 });
    }
  });

  it.each(["ORDER", "FREE_STAY"] as const)("counts separate %s bed stays once each", (sourceKind) => {
    const children = ["a", "b"].map((suffix) => ({
      ...bed,
      id: `bed_101_${suffix}`,
      intervals: [{
        ...inHouseBedInterval,
        id: `interval_bed_101_${suffix}`,
        actualInventoryUnitId: `bed_101_${suffix}`,
        sourceKind
      }]
    }));
    const room = {
      ...splitRoom,
      children,
      intervals: children.flatMap((child) => child.intervals.map((interval) => ({
        ...interval,
        id: `${interval.id}_on_room`
      })))
    };

    expect(roomStatusBuildingOccupancySummariesForDate([{ room, children }], "2026-08-02").get("1"))
      .toEqual({ occupants: 2, capacity: 4 });
    expect(roomStatusBuildingOccupancySummariesForDate([{ room, children: [children[0]!] }], "2026-08-02").get("1"))
      .toEqual({ occupants: 1, capacity: 4 });
  });

  it("counts only in-house lodging on the requested date", () => {
    const room = {
      ...wholeRoom,
      intervals: [
        wholeRoomInterval,
        { ...wholeRoomInterval, id: "reserved", status: "RESERVED" as const },
        { ...wholeRoomInterval, id: "unknown", status: "UNKNOWN" as const },
        { ...wholeRoomInterval, id: "future", startDate: "2026-08-03" },
        { ...wholeRoomInterval, id: "departed", endDate: "2026-08-02" }
      ]
    };
    expect(roomStatusBuildingOccupancySummariesForDate([{ room, children: [] }], "2026-08-02").get("1"))
      .toEqual({ occupants: 2, capacity: 2 });
    expect(roomStatusBuildingOccupancySummariesForDate([{ room: wholeRoom, children: [] }], "2026-08-01").get("1"))
      .toEqual({ occupants: 2, capacity: 2 });
    expect(roomStatusBuildingOccupancySummariesForDate([{ room: wholeRoom, children: [] }], "2026-08-03").get("1"))
      .toEqual({ occupants: 0, capacity: 2 });
  });
});

describe("whole-room lodging on split-room beds", () => {
  const wholeRoomLodging = {
    id: "interval_room_104",
    actualInventoryUnitId: "room_104",
    sourceKind: "FREE_STAY",
    status: "IN_HOUSE",
    startDate: "2026-08-14",
    endDate: "2026-08-16",
    occupantCount: 2
  } as RoomStatusIntervalDto;
  const bed = {
    id: "bed_104_a",
    roomId: "room_104",
    parentRoomId: "room_104",
    kind: "BED",
    intervals: [wholeRoomLodging]
  } as RoomStatusUnitDto;

  it("identifies inherited whole-room lodging without treating a bed's own stay as whole-room occupancy", () => {
    expect(roomStatusBedHasWholeRoomLodging(bed, "2026-08-14")).toBe(true);
    expect(roomStatusBedHasWholeRoomLodging(bed, "2026-08-16")).toBe(false);
    expect(roomStatusBedHasWholeRoomLodging({
      ...bed,
      intervals: [{ ...wholeRoomLodging, actualInventoryUnitId: bed.id }]
    }, "2026-08-14")).toBe(false);
    expect(roomStatusBedHasWholeRoomLodging({
      ...bed,
      intervals: [{ ...wholeRoomLodging, status: "UNKNOWN" }]
    }, "2026-08-14")).toBe(false);
  });
});

describe("roomStatusGridOperationalIntervals", () => {
  const childBedOperationalIntervals = [
    { id: "maintenance", sourceKind: "MAINTENANCE", status: "MAINTENANCE" },
    { id: "cleaning", sourceKind: "CLEANING", status: "CLEANING" },
    { id: "unsellable", sourceKind: "UNIT_UNSELLABLE", status: "UNAVAILABLE" }
  ].map((interval) => ({
    ...interval,
    id: `${interval.id}_bed_102_c`,
    actualInventoryUnitId: "bed_102_c",
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    occupantCount: 0
  })) as RoomStatusIntervalDto[];

  it("keeps child-bed operational bars on the bed row but not on a BED_SPLIT parent row", () => {
    const parent = {
      id: "room_102",
      kind: "ROOM",
      salesMode: "BED_SPLIT",
      intervals: [
        ...childBedOperationalIntervals,
        ...childBedOperationalIntervals.map((interval) => ({
          ...interval,
          id: interval.id.replace("bed_102_c", "room_102"),
          actualInventoryUnitId: "room_102"
        }))
      ]
    } as RoomStatusUnitDto;
    const bed = {
      id: "bed_102_c",
      kind: "BED",
      salesMode: "BED_SPLIT",
      intervals: childBedOperationalIntervals
    } as RoomStatusUnitDto;

    expect(roomStatusGridOperationalIntervals(parent, ["2026-09-01", "2026-09-02"]).map((interval) => interval.id))
      .toEqual(["maintenance_room_102", "cleaning_room_102", "unsellable_room_102"]);
    expect(roomStatusGridOperationalIntervals(bed, ["2026-09-01", "2026-09-02"]).map((interval) => interval.id))
      .toEqual(["maintenance_bed_102_c", "cleaning_bed_102_c", "unsellable_bed_102_c"]);
  });
});

describe("room status source badge accessibility", () => {
  it("includes every non-direct badge's complete business name in the cell label", () => {
    const categories = [
      ["YOUMUDAO", "游牧岛"],
      ["CTRIP", "携程"],
      ["MEITUAN", "美团"],
      ["FREE_STAY", "免费入住"],
      ["MEMBER", "会员权益"]
    ] as const;
    const intervals = categories.map(([sourceCategory], index) => ({
      id: `source_${sourceCategory}`,
      actualInventoryUnitId: "room_c01",
      sourceKind: sourceCategory === "FREE_STAY" ? "FREE_STAY" : "ORDER",
      sourceCategory,
      status: "RESERVED",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      occupantCount: 1,
      label: `source ${index}`,
      primaryOccupantLabel: null,
      occupants: [],
      references: []
    })) as unknown as RoomStatusIntervalDto[];
    const label = roomStatusCellAccessibleName({
      id: "room_c01",
      kind: "ROOM",
      code: "C01",
      name: "C01",
      intervals
    } as RoomStatusUnitDto, "2026-09-01", {
      serviceDate: "2026-09-01",
      status: "RESERVED",
      available: false,
      intervalIds: intervals.map((interval) => interval.id),
      conflicts: []
    }, null, "2026-09-01");

    for (const [, title] of categories) expect(label).toContain(title);
  });
});

describe("bed occupancy cell summary", () => {
  const baseReference = {
    type: "ORDER",
    label: "Order order_1",
    href: "/orders/order_1"
  } as const;
  const inHouse = {
    id: "interval_in_house",
    actualInventoryUnitId: "bed_104_a",
    sourceKind: "ORDER",
    status: "IN_HOUSE",
    sourceStartDate: "2026-08-11",
    startDate: "2026-08-11",
    endDate: "2026-08-20",
    label: "Order order_in_house",
    primaryOccupantLabel: "132",
    occupantCount: 1,
    occupants: [{ occupantId: "occupant_a", nickname: "132" }],
    references: [{ ...baseReference, id: "order_in_house" }]
  } as RoomStatusIntervalDto;
  const settled = {
    ...inHouse,
    id: "interval_settled",
    actualInventoryUnitId: "bed_104_b",
    status: "SETTLED",
    label: "Order order_settled",
    primaryOccupantLabel: "234",
    occupants: [{ occupantId: "occupant_b", nickname: "234" }],
    references: [{ ...baseReference, id: "order_settled" }]
  } as RoomStatusIntervalDto;
  const arrears = {
    ...settled,
    id: "interval_arrears",
    status: "ARREARS",
    references: [{ ...baseReference, id: "order_arrears" }]
  } as RoomStatusIntervalDto;
  const secondArrears = {
    ...arrears,
    id: "interval_arrears_second",
    actualInventoryUnitId: "bed_104_c",
    primaryOccupantLabel: "235",
    occupants: [{ occupantId: "occupant_arrears_second", nickname: "235" }],
    references: [{ ...baseReference, id: "order_arrears_second" }]
  } as RoomStatusIntervalDto;
  const overdueReserved = {
    ...inHouse,
    id: "interval_overdue_reserved",
    actualInventoryUnitId: "bed_104_b",
    status: "RESERVED",
    operationalAttention: "OVERDUE_RESERVED",
    sourceStartDate: "2026-08-06",
    label: "Order order_overdue_reserved",
    primaryOccupantLabel: "324",
    occupants: [{ occupantId: "occupant_reserved", nickname: "324" }],
    references: [{ ...baseReference, id: "order_overdue_reserved" }]
  } as RoomStatusIntervalDto;
  const secondOverdueReserved = {
    ...overdueReserved,
    id: "interval_overdue_reserved_second",
    actualInventoryUnitId: "bed_104_d",
    primaryOccupantLabel: "325",
    occupants: [{ occupantId: "occupant_reserved_second", nickname: "325" }],
    references: [{ ...baseReference, id: "order_overdue_reserved_second" }]
  } as RoomStatusIntervalDto;
  const reservedArrears = {
    ...inHouse,
    id: "interval_reserved_arrears",
    actualInventoryUnitId: "bed_104_c",
    status: "RESERVED",
    attention: "ARREARS",
    sourceStartDate: "2026-08-15",
    startDate: "2026-08-15",
    primaryOccupantLabel: "欠款住客",
    occupants: [{ occupantId: "occupant_reserved_arrears", nickname: "欠款住客" }],
    references: [{ ...baseReference, id: "order_reserved_arrears" }]
  } as RoomStatusIntervalDto;
  const unit = {
    id: "room_104",
    kind: "ROOM",
    code: "104",
    name: "104 · 四人间（公卫）",
    buildingCode: "1",
    intervals: [inHouse, settled, arrears, secondArrears, overdueReserved, secondOverdueReserved, reservedArrears]
  } as RoomStatusUnitDto;

  it("uses occupancy copy for mixed non-critical bed states", () => {
    expect(roomStatusBedOccupancyStateLabel({
      serviceDate: "2026-08-14",
      occupiedBedCount: 2,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_a", inventoryUnitId: "bed_104_a", inventoryUnitCode: "104-A", primaryOccupantLabel: "132", sourceReference: { ...baseReference, id: "order_in_house" } },
        { occupantId: "occupant_b", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "234", sourceReference: { ...baseReference, id: "order_settled" } }
      ]
    }, unit, "2026-08-14", "IN_HOUSE", "2026-08-14")).toBe("占用");
  });

  it("uses occupancy copy for mixed bed states even when one bed needs attention", () => {
    const mixedWithOverdue = {
      serviceDate: "2026-08-14",
      occupiedBedCount: 2,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_a", inventoryUnitId: "bed_104_a", inventoryUnitCode: "104-A", primaryOccupantLabel: "132", sourceReference: { ...baseReference, id: "order_in_house" } },
        { occupantId: "occupant_reserved", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "324", sourceReference: { ...baseReference, id: "order_overdue_reserved" } }
      ]
    };

    expect(roomStatusBedOccupancyStateLabel(mixedWithOverdue, unit, "2026-08-14", "RESERVED", "2026-08-14")).toBe("占用");
    expect(roomStatusBedOccupancyNeedsProcessing(mixedWithOverdue, unit, "2026-08-14", "2026-08-14")).toBe(true);
    expect(roomStatusBedOccupancyAttentionLabels(mixedWithOverdue, unit, "2026-08-14", "2026-08-14")).toEqual(["逾期"]);
  });

  it("summarizes parent-room attention with one compact label per issue type", () => {
    const mixedWithArrearsAndOverdue = {
      serviceDate: "2026-08-14",
      occupiedBedCount: 3,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_arrears_second", inventoryUnitId: "bed_104_c", inventoryUnitCode: "104-C", primaryOccupantLabel: "235", sourceReference: { ...baseReference, id: "order_arrears_second" } },
        { occupantId: "occupant_reserved", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "324", sourceReference: { ...baseReference, id: "order_overdue_reserved" } },
        { occupantId: "occupant_reserved_second", inventoryUnitId: "bed_104_d", inventoryUnitCode: "104-D", primaryOccupantLabel: "325", sourceReference: { ...baseReference, id: "order_overdue_reserved_second" } }
      ]
    };

    expect(roomStatusBedOccupancyAttentionLabels(mixedWithArrearsAndOverdue, unit, "2026-08-14", "2026-08-14")).toEqual(["逾期", "欠款"]);
  });

  it("keeps an active reservation's lifecycle label while exposing its debt attention", () => {
    const occupancy = {
      serviceDate: "2026-08-15",
      occupiedBedCount: 1,
      totalBedCount: 4,
      occupants: [{
        occupantId: "occupant_reserved_arrears",
        inventoryUnitId: "bed_104_c",
        inventoryUnitCode: "104-C",
        primaryOccupantLabel: "欠款住客",
        sourceReference: { ...baseReference, id: "order_reserved_arrears" }
      }]
    };

    expect(roomStatusBedOccupancyStateLabel(occupancy, unit, "2026-08-15", "RESERVED", "2026-08-14"))
      .toBe("已预订");
    expect(roomStatusBedOccupancyNeedsProcessing(occupancy, unit, "2026-08-15", "2026-08-14"))
      .toBe(true);
    expect(roomStatusBedOccupancyAttentionLabels(occupancy, unit, "2026-08-15", "2026-08-14"))
      .toEqual(["欠款"]);
    const accessibleName = roomStatusCellAccessibleName(unit, "2026-08-15", {
      serviceDate: "2026-08-15",
      status: "RESERVED",
      available: false,
      intervalIds: [reservedArrears.id],
      conflicts: []
    }, occupancy, "2026-08-14");
    expect(accessibleName).toContain("已预订");
    expect(accessibleName).toContain("欠款");
  });

  it("keeps a moved overdue reservation visible in its parent-room summary", () => {
    const movedRun = {
      ...overdueReserved,
      id: "interval_overdue_reserved_moved",
      sourceStartDate: "2026-08-16",
      startDate: "2026-08-16",
      endDate: "2026-08-20",
      orderArrivalDate: "2026-08-06"
    } as RoomStatusIntervalDto;
    const parent = { ...unit, intervals: [movedRun] } as RoomStatusUnitDto;
    const occupancy = {
      serviceDate: "2026-08-17",
      occupiedBedCount: 1,
      totalBedCount: 4,
      occupants: [{
        occupantId: "occupant_reserved",
        inventoryUnitId: "bed_104_b",
        inventoryUnitCode: "104-B",
        primaryOccupantLabel: "324",
        sourceReference: { ...baseReference, id: "order_overdue_reserved" }
      }]
    };

    expect(roomStatusBedOccupancyAttentionLabels(occupancy, parent, "2026-08-17", "2026-08-14"))
      .toEqual(["逾期"]);
  });

  it("does not mark ordinary mixed bed states as requiring processing", () => {
    expect(roomStatusBedOccupancyNeedsProcessing({
      serviceDate: "2026-08-14",
      occupiedBedCount: 2,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_a", inventoryUnitId: "bed_104_a", inventoryUnitCode: "104-A", primaryOccupantLabel: "132", sourceReference: { ...baseReference, id: "order_in_house" } },
        { occupantId: "occupant_b", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "234", sourceReference: { ...baseReference, id: "order_settled" } }
      ]
    }, unit, "2026-08-14", "2026-08-14")).toBe(false);
  });

  it("keeps mixed bed accessible copy honest while retaining per-bed overdue detail", () => {
    const day = {
      serviceDate: "2026-08-14",
      status: "RESERVED",
      available: false,
      intervalIds: ["interval_in_house", "interval_overdue_reserved"],
      conflicts: []
    } satisfies RoomStatusDayDto;
    const accessibleName = roomStatusCellAccessibleName(unit, day.serviceDate, day, {
      serviceDate: "2026-08-14",
      occupiedBedCount: 2,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_a", inventoryUnitId: "bed_104_a", inventoryUnitCode: "104-A", primaryOccupantLabel: "132", sourceReference: { ...baseReference, id: "order_in_house" } },
        { occupantId: "occupant_reserved", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "324", sourceReference: { ...baseReference, id: "order_overdue_reserved" } }
      ]
    }, "2026-08-14");

    expect(accessibleName).toContain("占用");
    expect(accessibleName).toContain("逾期预订");
    expect(accessibleName).not.toContain("1栋 104，8月14日，逾期预订");
  });

  it("keeps urgent bed states visible instead of flattening them into occupancy", () => {
    expect(roomStatusBedOccupancyStateLabel({
      serviceDate: "2026-08-14",
      occupiedBedCount: 1,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_arrears", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "234", sourceReference: { ...baseReference, id: "order_arrears" } }
      ]
    }, unit, "2026-08-14", "ARREARS", "2026-08-14")).toBe("已结单");
    expect(roomStatusBedOccupancyNeedsProcessing({
      serviceDate: "2026-08-14",
      occupiedBedCount: 1,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_arrears", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "234", sourceReference: { ...baseReference, id: "order_arrears" } }
      ]
    }, unit, "2026-08-14", "2026-08-14")).toBe(true);

    expect(roomStatusBedOccupancyStateLabel({
      serviceDate: "2026-08-14",
      occupiedBedCount: 1,
      totalBedCount: 4,
      occupants: [
        { occupantId: "occupant_reserved", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", primaryOccupantLabel: "324", sourceReference: { ...baseReference, id: "order_overdue_reserved" } }
      ]
    }, unit, "2026-08-14", "RESERVED", "2026-08-14")).toBe("逾期预订");
  });

  it("does not announce a historical debt or overdue reservation twice", () => {
    const historicalDebtName = roomStatusCellAccessibleName(unit, "2026-08-13", {
      serviceDate: "2026-08-13",
      status: "ARREARS",
      available: false,
      intervalIds: [arrears.id],
      conflicts: []
    }, null, "2026-08-14");
    expect(historicalDebtName).toContain("已结单");
    expect(historicalDebtName.match(/欠款/g)).toHaveLength(1);

    const overdueName = roomStatusCellAccessibleName(unit, "2026-08-14", {
      serviceDate: "2026-08-14",
      status: "RESERVED",
      available: false,
      intervalIds: [overdueReserved.id],
      conflicts: []
    }, null, "2026-08-14");
    expect(overdueName.match(/逾期预订/g)).toHaveLength(1);
    expect(overdueName).not.toMatch(/逾期预订，逾期/);
  });

  it("maps historical, current, and future split-room beds into the same stable A-D color slots", () => {
    const splitRoom = {
      ...unit,
      salesMode: "BED_SPLIT",
      children: [
        { id: "bed_104_d", kind: "BED", code: "104-D" },
        { id: "bed_104_b", kind: "BED", code: "104-B" },
        { id: "bed_104_a", kind: "BED", code: "104-A" },
        { id: "bed_104_c", kind: "BED", code: "104-C" }
      ],
      bedSlotStates: [
        { serviceDate: "2026-08-13", inventoryUnitId: "bed_104_d", inventoryUnitCode: "104-D", status: "UNKNOWN" },
        { serviceDate: "2026-08-13", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", status: "SETTLED" },
        { serviceDate: "2026-08-13", inventoryUnitId: "bed_104_a", inventoryUnitCode: "104-A", status: "IN_HOUSE" },
        { serviceDate: "2026-08-13", inventoryUnitId: "bed_104_c", inventoryUnitCode: "104-C", status: "MAINTENANCE" },
        { serviceDate: "2026-08-14", inventoryUnitId: "bed_104_d", inventoryUnitCode: "104-D", status: "AVAILABLE" },
        { serviceDate: "2026-08-14", inventoryUnitId: "bed_104_b", inventoryUnitCode: "104-B", status: "RESERVED" },
        { serviceDate: "2026-08-14", inventoryUnitId: "bed_104_a", inventoryUnitCode: "104-A", status: "IN_HOUSE" },
        { serviceDate: "2026-08-14", inventoryUnitId: "bed_104_c", inventoryUnitCode: "104-C", status: "AVAILABLE" }
      ]
    } as unknown as RoomStatusUnitDto;

    expect(roomStatusBedOccupancySlots(splitRoom, "2026-08-14")).toEqual([
      { code: "A", status: "IN_HOUSE", occupied: true },
      { code: "B", status: "RESERVED", occupied: true },
      { code: "C", status: "AVAILABLE", occupied: false },
      { code: "D", status: "AVAILABLE", occupied: false }
    ]);

    expect(roomStatusBedOccupancySlots(splitRoom, "2026-08-13")).toEqual([
      { code: "A", status: "IN_HOUSE", occupied: true },
      { code: "B", status: "SETTLED", occupied: true },
      { code: "C", status: "MAINTENANCE", occupied: true },
      { code: "D", status: "UNKNOWN", occupied: true }
    ]);
  });

  it("uses registered occupants over physical beds for every occupancy ratio", () => {
    expect(roomStatusOccupancyDisplayRatio(2, {
      ...unit,
      capacity: 4,
      physicalBedCount: 1
    } as RoomStatusUnitDto)).toBe("2/1");
    expect(roomStatusOccupancyDisplayRatio(2, {
      ...unit,
      capacity: 1,
      physicalBedCount: 4
    } as RoomStatusUnitDto)).toBe("2/4");
    expect(roomStatusOccupancyDisplayRatio(1, {
      ...unit,
      capacity: 4,
      physicalBedCount: null
    } as RoomStatusUnitDto)).toBe("1/?");
  });

  it("keeps debt as a completed lifecycle color and leaves debt to the attention tag", () => {
    expect(roomStatusOccupancyLifecycleStatus("ARREARS")).toBe("SETTLED");
    expect(roomStatusOccupancyLifecycleStatus("SETTLED")).toBe("SETTLED");
    expect(roomStatusOccupancyLifecycleStatus("IN_HOUSE")).toBe("IN_HOUSE");
  });
});

describe("roomStatusCellAttentionLabels", () => {
  const baseInterval = {
    id: "interval_1",
    actualInventoryUnitId: "bed_101_a",
    sourceKind: "ORDER",
    status: "SETTLED",
    operationalAttention: null,
    sourceStartDate: "2026-08-06",
    startDate: "2026-08-06",
    endDate: "2026-08-11",
    occupantCount: 1
  } as RoomStatusIntervalDto;

  it("marks historical arrears and overdue reserved cells with compact labels", () => {
    expect(roomStatusCellAttentionLabels([
      { ...baseInterval, status: "ARREARS" },
      { ...baseInterval, id: "interval_2", status: "RESERVED", operationalAttention: "OVERDUE_RESERVED" }
    ], "2026-08-10", "2026-08-14")).toEqual(["逾期", "欠款"]);
    expect(roomStatusCellAttentionLabels([{ ...baseInterval, status: "ARREARS" }], "2026-08-10", "2026-08-14"))
      .toEqual(["欠款"]);
    expect(roomStatusCellAttentionLabels([{
      ...baseInterval,
      status: "RESERVED",
      operationalAttention: "OVERDUE_RESERVED"
    }], "2026-08-10", "2026-08-14"))
      .toEqual(["逾期"]);
  });

  it("keeps debt visible while leaving ordinary non-debt reservations without an attention tag", () => {
    expect(roomStatusCellAttentionLabels([{ ...baseInterval, status: "ARREARS" }], "2026-08-14", "2026-08-14"))
      .toEqual(["欠款"]);
    expect(roomStatusCellAttentionLabels([{
      ...baseInterval,
      status: "RESERVED",
      sourceStartDate: "2026-08-15",
      startDate: "2026-08-15",
      endDate: "2026-08-20"
    }], "2026-08-15", "2026-08-14"))
      .toEqual([]);
    expect(roomStatusCellAttentionLabels([{ ...baseInterval, status: "ARREARS" }], "2026-08-10"))
      .toEqual(["欠款"]);
  });

  it("shows and deduplicates active reservation debt attention on its covered date", () => {
    const activeDebt = {
      ...baseInterval,
      status: "RESERVED",
      attention: "ARREARS",
      sourceStartDate: "2026-08-15",
      startDate: "2026-08-15",
      endDate: "2026-08-20"
    } as RoomStatusIntervalDto;

    expect(roomStatusCellAttentionLabels([
      activeDebt,
      { ...activeDebt, id: "interval_2" }
    ], "2026-08-15", "2026-08-14")).toEqual(["欠款"]);
  });

  it("only exposes an overdue checkout when the service explicitly marks the interval", () => {
    const overdueInHouse = {
      ...baseInterval,
      status: "IN_HOUSE",
      occupants: [],
      operationalAttention: "OVERDUE_IN_HOUSE"
    } as RoomStatusIntervalDto;

    expect(roomStatusCellAttentionLabels([overdueInHouse], "2026-08-14", "2026-08-14"))
      .toEqual(["未退"]);
    expect(roomStatusCellAttentionLabels([{
      ...overdueInHouse,
      operationalAttention: null
    } as RoomStatusIntervalDto], "2026-08-14", "2026-08-14"))
      .toEqual([]);
  });

  it("announces an explicitly overdue checkout once alongside its in-house lifecycle", () => {
    const overdueInHouse = {
      ...baseInterval,
      status: "IN_HOUSE",
      occupants: [],
      operationalAttention: "OVERDUE_IN_HOUSE"
    } as RoomStatusIntervalDto;
    const accessibleName = roomStatusCellAccessibleName({
      id: "room_101",
      kind: "ROOM",
      code: "101",
      name: "101",
      intervals: [overdueInHouse]
    } as RoomStatusUnitDto, "2026-08-14", {
      serviceDate: "2026-08-14",
      status: "IN_HOUSE",
      available: false,
      intervalIds: [overdueInHouse.id],
      conflicts: []
    }, null, "2026-08-14");

    expect(accessibleName).toContain("在住");
    expect(accessibleName.match(/未退/g)).toHaveLength(1);
  });

  it("announces a departure-day checkout once alongside its in-house lifecycle", () => {
    const dueOut = {
      ...baseInterval,
      status: "IN_HOUSE",
      occupants: [],
      operationalAttention: "DUE_OUT"
    } as RoomStatusIntervalDto;
    const accessibleName = roomStatusCellAccessibleName({
      id: "room_101",
      kind: "ROOM",
      code: "101",
      name: "101",
      intervals: [dueOut]
    } as RoomStatusUnitDto, "2026-08-14", {
      serviceDate: "2026-08-14",
      status: "IN_HOUSE",
      available: false,
      intervalIds: [dueOut.id],
      conflicts: []
    }, null, "2026-08-14");

    expect(accessibleName).toContain("在住");
    expect(accessibleName.match(/待退房/g)).toHaveLength(1);
  });

  it("keeps whole-room departure and overdue checkout cells tied to their original order dates", () => {
    for (const [operationalAttention, orderArrivalDate, orderDepartureDate, attention] of [
      ["DUE_OUT", "2026-08-13", "2026-08-14", "待退房"],
      ["OVERDUE_IN_HOUSE", "2026-08-10", "2026-08-13", "未退"]
    ] as const) {
      const interval = {
        ...baseInterval,
        id: `whole_room_${operationalAttention}`,
        actualInventoryUnitId: "room_101",
        status: "IN_HOUSE",
        startDate: operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-10",
        endDate: operationalAttention === "DUE_OUT" ? "2026-08-15" : "2026-08-13",
        sourceStartDate: operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-10",
        sourceEndDate: operationalAttention === "DUE_OUT" ? "2026-08-15" : "2026-08-13",
        orderArrivalDate,
        orderDepartureDate,
        attention: "ARREARS",
        operationalAttention,
        occupants: []
      } as RoomStatusIntervalDto;
      const accessibleName = roomStatusCellAccessibleName({
        id: "room_101",
        kind: "ROOM",
        code: "101",
        name: "101",
        intervals: [interval]
      } as RoomStatusUnitDto, operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-12", {
        serviceDate: operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-12",
        status: "IN_HOUSE",
        available: false,
        intervalIds: [interval.id],
        conflicts: []
      }, null, "2026-08-14");

      expect(accessibleName).toContain(`${formatRoomStatusDate(orderArrivalDate)}至${formatRoomStatusDate(orderDepartureDate)}`);
      expect(accessibleName).toContain(attention);
      expect(roomStatusCellOperationalAttentionTooltipText([interval]))
        .toBe(`原订单日期：${formatRoomStatusDate(orderArrivalDate)}至${formatRoomStatusDate(orderDepartureDate)}；${attention}`);
    }
  });

  it("keeps split-bed departure and overdue checkout cells tied to their original order dates", () => {
    for (const [operationalAttention, orderArrivalDate, orderDepartureDate, attention] of [
      ["DUE_OUT", "2026-08-13", "2026-08-14", "待退房"],
      ["OVERDUE_IN_HOUSE", "2026-08-10", "2026-08-13", "未退"]
    ] as const) {
      const interval = {
        ...baseInterval,
        id: `bed_${operationalAttention}`,
        actualInventoryUnitId: "bed_101_a",
        status: "IN_HOUSE",
        startDate: operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-10",
        endDate: operationalAttention === "DUE_OUT" ? "2026-08-15" : "2026-08-13",
        sourceStartDate: operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-10",
        sourceEndDate: operationalAttention === "DUE_OUT" ? "2026-08-15" : "2026-08-13",
        orderArrivalDate,
        orderDepartureDate,
        attention: "ARREARS",
        operationalAttention,
        references: [{ type: "ORDER", id: "order_101", label: "订单", href: "/orders/order_101" }]
      } as RoomStatusIntervalDto;
      const serviceDate = operationalAttention === "DUE_OUT" ? "2026-08-14" : "2026-08-12";
      const unit = {
        id: "room_101",
        kind: "ROOM",
        code: "101",
        name: "101",
        salesMode: "BED_SPLIT",
        intervals: [interval]
      } as RoomStatusUnitDto;
      const occupancy: RoomStatusBedOccupancyDto = {
        serviceDate,
        occupiedBedCount: 1,
        totalBedCount: 4,
        occupants: [{
          occupantId: "occupant_101",
          inventoryUnitId: "bed_101_a",
          inventoryUnitCode: "101-A",
          primaryOccupantLabel: "住客",
          sourceReference: { type: "ORDER", id: "order_101", label: "订单", href: "/orders/order_101" }
        }]
      };
      const accessibleName = roomStatusCellAccessibleName(unit, serviceDate, {
        serviceDate,
        status: "IN_HOUSE",
        available: false,
        intervalIds: [],
        conflicts: []
      }, occupancy, "2026-08-14");

      expect(accessibleName).toContain(`${formatRoomStatusDate(orderArrivalDate)}至${formatRoomStatusDate(orderDepartureDate)}`);
      expect(accessibleName).toContain(attention);
      expect(roomStatusCellOperationalAttentionTooltipText([interval]))
        .toBe(`原订单日期：${formatRoomStatusDate(orderArrivalDate)}至${formatRoomStatusDate(orderDepartureDate)}；${attention}`);
    }
  });

  it("sorts and deduplicates every due-out bed in parent tooltip and accessible copy", () => {
    const dueOut = (id: string, bedId: string, orderId: string, arrivalDate: string) => ({
      ...baseInterval,
      id,
      actualInventoryUnitId: bedId,
      status: "IN_HOUSE",
      startDate: "2026-08-14",
      endDate: "2026-08-15",
      sourceStartDate: "2026-08-14",
      sourceEndDate: "2026-08-15",
      orderArrivalDate: arrivalDate,
      orderDepartureDate: "2026-08-14",
      operationalAttention: "DUE_OUT",
      references: [{ type: "ORDER", id: orderId, label: "订单", href: `/orders/${orderId}` }]
    }) as RoomStatusIntervalDto;
    const earlier = dueOut("due_out_a", "bed_101_a", "order_a", "2026-08-10");
    const later = dueOut("due_out_b", "bed_101_b", "order_b", "2026-08-12");
    const expectedEarlier = "原订单日期：8月10日至8月14日；待退房";
    const expectedLater = "原订单日期：8月12日至8月14日；待退房";
    const unit = {
      id: "room_101",
      kind: "ROOM",
      code: "101",
      name: "101",
      salesMode: "BED_SPLIT",
      intervals: [later, earlier]
    } as RoomStatusUnitDto;
    const occupancy: RoomStatusBedOccupancyDto = {
      serviceDate: "2026-08-14",
      occupiedBedCount: 2,
      totalBedCount: 4,
      occupants: [
        {
          occupantId: "occupant_b",
          inventoryUnitId: "bed_101_b",
          inventoryUnitCode: "101-B",
          primaryOccupantLabel: "乙",
          sourceReference: { type: "ORDER", id: "order_b", label: "订单", href: "/orders/order_b" }
        },
        {
          occupantId: "occupant_a",
          inventoryUnitId: "bed_101_a",
          inventoryUnitCode: "101-A",
          primaryOccupantLabel: "甲",
          sourceReference: { type: "ORDER", id: "order_a", label: "订单", href: "/orders/order_a" }
        }
      ]
    };

    expect(roomStatusCellOperationalAttentionTooltipText([later, earlier, earlier]))
      .toBe(`${expectedEarlier}；${expectedLater}`);
    const accessibleName = roomStatusCellAccessibleName(unit, "2026-08-14", {
      serviceDate: "2026-08-14",
      status: "IN_HOUSE",
      available: false,
      intervalIds: [],
      conflicts: []
    }, occupancy, "2026-08-14");
    expect(accessibleName.indexOf(expectedEarlier)).toBeLessThan(accessibleName.indexOf(expectedLater));
    expect(accessibleName.match(/待退房/g)).toHaveLength(2);
  });

  it("marks every visible day of a cross-today overdue reservation", () => {
    const crossTodayOverdueReserved: RoomStatusIntervalDto = {
      ...baseInterval,
      status: "RESERVED",
      operationalAttention: "OVERDUE_RESERVED",
      sourceStartDate: "2026-08-06",
      startDate: "2026-08-06",
      endDate: "2026-08-20"
    };

    expect(roomStatusCellAttentionLabels([crossTodayOverdueReserved], "2026-08-13", "2026-08-14"))
      .toEqual(["逾期"]);
    expect(roomStatusCellAttentionLabels([crossTodayOverdueReserved], "2026-08-14", "2026-08-14"))
      .toEqual(["逾期"]);
    expect(roomStatusCellAttentionLabels([crossTodayOverdueReserved], "2026-08-19", "2026-08-14"))
      .toEqual(["逾期"]);
  });

  it("marks the later run of a prearranged room move using the order arrival date", () => {
    const movedRun: RoomStatusIntervalDto = {
      ...baseInterval,
      status: "RESERVED",
      operationalAttention: "OVERDUE_RESERVED",
      sourceStartDate: "2026-08-16",
      startDate: "2026-08-16",
      endDate: "2026-08-20",
      orderArrivalDate: "2026-08-06"
    };

    expect(roomStatusCellAttentionLabels([movedRun], "2026-08-16", "2026-08-14")).toEqual(["逾期"]);
    expect(roomStatusCellAttentionLabels([movedRun], "2026-08-19", "2026-08-14")).toEqual(["逾期"]);
  });

  it("deduplicates labels when the same cell carries multiple intervals", () => {
    expect(roomStatusCellAttentionLabels([
      { ...baseInterval, status: "ARREARS" },
      { ...baseInterval, id: "interval_2", status: "ARREARS" },
      { ...baseInterval, id: "interval_3", status: "RESERVED", operationalAttention: "OVERDUE_RESERVED" }
    ], "2026-08-10", "2026-08-14")).toEqual(["逾期", "欠款"]);
  });

  it("treats overdue free stays as needing attention but never marks settled history", () => {
    expect(roomStatusCellAttentionLabels([
      { ...baseInterval, sourceKind: "FREE_STAY", status: "RESERVED", operationalAttention: "OVERDUE_RESERVED" }
    ], "2026-08-10", "2026-08-14")).toEqual(["逾期"]);
    expect(roomStatusCellAttentionLabels([
      { ...baseInterval, sourceKind: "MAINTENANCE", status: "RESERVED" }
    ], "2026-08-10", "2026-08-14")).toEqual([]);
    expect(roomStatusCellAttentionLabels([{ ...baseInterval, status: "SETTLED" }], "2026-08-10", "2026-08-14"))
      .toEqual([]);
  });
});
