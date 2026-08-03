import { describe, expect, it } from "vitest";
import {
  focusAndRevealRoomStatusCell,
  roomStatusBuildingOccupancySummariesForDate,
  roomStatusBuildingOccupancySummaryLabel,
  roomStatusBedOccupancyTooltipPosition,
  roomStatusFocusRestorationTarget,
  roomStatusHorizontalDragAutoScrollDelta,
  roomStatusIntervalServiceDateAtPointer
} from "./RoomStatusGrid";
import type { RoomStatusIntervalDto, RoomStatusUnitDto } from "@qintopia/contracts";

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
    intervals: [inHouseBedInterval],
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
});
