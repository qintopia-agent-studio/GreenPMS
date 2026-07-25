import { describe, expect, it } from "vitest";
import type { RoomStatusDayDto, RoomStatusIntervalDto, RoomStatusUnitDto } from "@qintopia/contracts";
import {
  DEFAULT_ROOM_STATUS_FILTERS,
  MAX_VISIBLE_DAYS,
  createRoomStatusViewState,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  intervalsRenderedOnRoomStatusGrid,
  moveRoomStatusFocus,
  parseRoomStatusRestoration,
  reconcileRoomStatusRestoration,
  roomStatusAutoVisibleDays,
  roomStatusFactFingerprint,
  roomStatusCellBelongsToStay,
  roomStatusOrderIdentityForDate,
  roomStatusViewReducer,
  selectionFromCells,
  selectionFromInputs,
  serializeRoomStatusRestoration,
  shiftDateWindowStart,
  visibleDateWindow
} from "./roomStatusState";

const orderReference = {
  type: "ORDER" as const,
  id: "order_bed",
  label: "Order order_bed",
  href: "/orders/order_bed"
};
const stayReference = { type: "STAY" as const, id: "stay_bed", label: "Stay stay_bed", href: null };

const day = (serviceDate: string, status: RoomStatusDayDto["status"] = "AVAILABLE"): RoomStatusDayDto => ({
  serviceDate,
  status,
  available: status === "AVAILABLE",
  intervalIds: [],
  conflicts: []
});

function unit(overrides: Partial<RoomStatusUnitDto> = {}): RoomStatusUnitDto {
  return {
    id: "unit_room_101",
    propertyId: "property_qintopia",
    roomId: "unit_room_101",
    parentRoomId: null,
    kind: "ROOM",
    code: "101",
    name: "1栋101",
    active: true,
    salesMode: "BED_SPLIT",
    buildingCode: "1",
    roomTypeCode: "PUBLIC_FOUR_BED",
    pricingProductCode: "PUBLIC_FOUR_BED_WHOLE_ROOM",
    capacity: 4,
    occupancyCapacity: 4,
    childUnitIds: [],
    children: [],
    bedOccupancies: [],
    days: [day("2026-07-20"), day("2026-07-21")],
    intervals: [],
    conflicts: [],
    allowedActions: [],
    ...overrides
  };
}

function lodgingInterval(overrides: Partial<RoomStatusIntervalDto> = {}): RoomStatusIntervalDto {
  return {
    id: "interval_bed_order",
    displayInventoryUnitId: "unit_room_101",
    sourceKind: "ORDER",
    actualInventoryUnitId: "unit_bed_101_a",
    roomId: "unit_room_101",
    startDate: "2026-07-20",
    endDate: "2026-07-21",
    sourceStartDate: "2026-07-20",
    sourceEndDate: "2026-07-21",
    status: "RESERVED",
    available: false,
    blocking: true,
    label: "order_bed",
    primaryOccupantLabel: "山风",
    occupantCount: 1,
    occupants: [{ occupantId: "occupant_bed", nickname: "山风" }],
    reason: null,
    claimIds: [],
    references: [orderReference, stayReference],
    conflicts: [],
    history: [],
    allowedActions: [],
    ...overrides
  };
}

describe("RoomStatus grid intervals", () => {
  it("replaces represented active lodging while retaining unresolved and block intervals", () => {
    const childBed = lodgingInterval();
    const wholeRoom = lodgingInterval({
      id: "interval_whole_room_order",
      actualInventoryUnitId: "unit_room_101",
      label: "order_whole_room",
      primaryOccupantLabel: "北辰"
    });
    const unresolvedChild = lodgingInterval({ id: "interval_unknown", status: "UNKNOWN" });
    const maintenance = lodgingInterval({ id: "interval_maintenance", sourceKind: "MAINTENANCE" });
    const rendered = intervalsRenderedOnRoomStatusGrid(unit({
      bedOccupancies: [{
        serviceDate: "2026-07-20",
        occupiedBedCount: 1,
        totalBedCount: 4,
        occupants: [{
          occupantId: "occupant_bed",
          inventoryUnitId: "unit_bed_101_a",
          inventoryUnitCode: "101-A",
          primaryOccupantLabel: "山风",
          sourceReference: orderReference
        }]
      }],
      intervals: [childBed, wholeRoom, unresolvedChild, maintenance]
    }), ["2026-07-20"]);

    expect(rendered.map((interval) => interval.id)).toEqual([
      "interval_unknown",
      "interval_maintenance"
    ]);

    const aggregationMissing = intervalsRenderedOnRoomStatusGrid(unit({
      bedOccupancies: [],
      intervals: [childBed, wholeRoom, unresolvedChild, maintenance]
    }), ["2026-07-20"]);
    expect(aggregationMissing.map((interval) => interval.id)).toEqual([
      "interval_bed_order",
      "interval_unknown",
      "interval_maintenance"
    ]);

    const missingWholeRoomOccupants = intervalsRenderedOnRoomStatusGrid(unit({
      intervals: [wholeRoom, lodgingInterval({
        id: "interval_whole_room_without_occupants",
        actualInventoryUnitId: "unit_room_101",
        occupants: [],
        occupantCount: 0
      })]
    }), ["2026-07-20"]);
    expect(missingWholeRoomOccupants.map((interval) => interval.id)).toEqual([
      "interval_whole_room_without_occupants"
    ]);
  });

  it("hides typed lodging bars on concrete room and bed rows", () => {
    const room = unit({
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({ actualInventoryUnitId: "unit_room_101" })]
    });
    const bed = unit({
      id: "unit_bed_101_a",
      roomId: "unit_room_101",
      parentRoomId: "unit_room_101",
      kind: "BED",
      salesMode: "BED_SPLIT",
      intervals: [lodgingInterval({ displayInventoryUnitId: "unit_bed_101_a" })]
    });
    expect(intervalsRenderedOnRoomStatusGrid(room)).toEqual([]);
    expect(intervalsRenderedOnRoomStatusGrid(bed)).toEqual([]);
  });
});

describe("RoomStatus stable order selection", () => {
  it("resolves only concrete room or bed rows and highlights every matching Stay segment", () => {
    const wholeRoom = unit({
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({ actualInventoryUnitId: "unit_room_101" })]
    });
    const identity = roomStatusOrderIdentityForDate(wholeRoom, "2026-07-20");
    expect(identity).toMatchObject({ orderId: "order_bed", stayId: "stay_bed" });
    expect(roomStatusCellBelongsToStay(wholeRoom, "2026-07-20", "stay_bed")).toBe(true);
    expect(roomStatusCellBelongsToStay(wholeRoom, "2026-07-21", "stay_bed")).toBe(false);
    expect(roomStatusOrderIdentityForDate(unit({ intervals: [lodgingInterval()] }), "2026-07-20")).toBeNull();

    const mixedModeWholeRoomSale = unit({
      salesMode: "BED_SPLIT",
      intervals: [lodgingInterval({ actualInventoryUnitId: "unit_room_101" })]
    });
    expect(roomStatusOrderIdentityForDate(mixedModeWholeRoomSale, "2026-07-20")).toMatchObject({
      orderId: "order_bed",
      stayId: "stay_bed",
      unitId: "unit_room_101"
    });
  });

  it("fails closed when a concrete cell contains more than one stable order identity", () => {
    const first = lodgingInterval({ actualInventoryUnitId: "unit_room_101" });
    const second = lodgingInterval({
      id: "interval_other",
      actualInventoryUnitId: "unit_room_101",
      references: [
        { ...orderReference, id: "order_other", href: "/orders/order_other" },
        { ...stayReference, id: "stay_other" }
      ]
    });
    expect(roomStatusOrderIdentityForDate(unit({ salesMode: "WHOLE_ROOM", intervals: [first, second] }), "2026-07-20")).toBeNull();
  });
});

describe("RoomStatus date window", () => {
  const dates = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 1 + index));
    return date.toISOString().slice(0, 10);
  });

  it("never renders more than 31 visible days and clamps the trailing window", () => {
    expect(visibleDateWindow(dates, 0, 90)).toHaveLength(MAX_VISIBLE_DAYS);
    expect(visibleDateWindow(dates, 89, 14)).toEqual(dates.slice(76, 90));
    expect(shiftDateWindowStart(dates.length, 76, 14, 1)).toBe(76);
    expect(shiftDateWindowStart(dates.length, 76, 14, -1)).toBe(62);
    expect(dateWindowStartForFocus(dates, 0, 14, dates[13]!)).toBe(0);
    expect(dateWindowStartForFocus(dates, 0, 14, dates[14]!)).toBe(1);
    expect(dateWindowStartForFocus(dates, 20, 14, dates[19]!)).toBe(19);
    expect(dateWindowStartForFocus(dates, 76, 14, dates[89]!)).toBe(76);
  });

  it("calculates an adaptive 7-to-21 day window from the actual board width", () => {
    expect(roomStatusAutoVisibleDays(700)).toBe(7);
    expect(roomStatusAutoVisibleDays(1_170)).toBe(10);
    expect(roomStatusAutoVisibleDays(1_600)).toBe(14);
    expect(roomStatusAutoVisibleDays(2_200)).toBe(20);
    expect(roomStatusAutoVisibleDays(4_000)).toBe(21);
  });

  it("switches between automatic and explicit date-window sizes", () => {
    const automatic = roomStatusViewReducer(createRoomStatusViewState(), {
      type: "SET_DATE_WINDOW_MODE",
      mode: "AUTO",
      autoSize: 10,
      totalDates: dates.length
    });
    expect(automatic).toMatchObject({ dateWindowMode: "AUTO", dateWindowSize: 10 });
    expect(roomStatusViewReducer(automatic, {
      type: "SET_DATE_WINDOW_MODE",
      mode: "21",
      autoSize: 10,
      totalDates: dates.length
    })).toMatchObject({ dateWindowMode: "21", dateWindowSize: 21 });
  });
});

describe("RoomStatus selection", () => {
  it("normalizes forward and reverse cell gestures to one half-open interval", () => {
    expect(selectionFromCells("unit_101", "2026-07-20", "2026-07-22")).toMatchObject({
      arrivalDate: "2026-07-20",
      departureDate: "2026-07-23"
    });
    expect(selectionFromCells("unit_101", "2026-07-22", "2026-07-20")).toMatchObject({
      arrivalDate: "2026-07-20",
      departureDate: "2026-07-23"
    });
  });

  it("rejects invalid equivalent date inputs", () => {
    expect(selectionFromInputs("unit_101", "2026-07-20", "2026-07-20")).toBeNull();
    expect(selectionFromInputs("unit_101", "2026-02-30", "2026-03-02")).toBeNull();
    expect(selectionFromInputs("unit_101", "2026-07-20", "2026-07-22")).toMatchObject({ focusDate: "2026-07-21" });
  });

  it("moves a roving focus and extends from the original anchor", () => {
    const initial = createRoomStatusViewState({ focusedCell: { unitId: "room_a", serviceDate: "2026-07-20" } });
    const moved = roomStatusViewReducer(initial, {
      type: "MOVE_FOCUS",
      unitIds: ["room_a", "bed_a"],
      dates: ["2026-07-20", "2026-07-21"],
      rowDelta: 1,
      columnDelta: 0,
      extendSelection: false
    });
    expect(moved.focusedCell).toEqual({ unitId: "bed_a", serviceDate: "2026-07-20" });

    const selected = roomStatusViewReducer(moved, { type: "SELECT_CELL", unitId: "bed_a", serviceDate: "2026-07-20", extend: false });
    const extended = roomStatusViewReducer(selected, {
      type: "MOVE_FOCUS",
      unitIds: ["room_a", "bed_a"],
      dates: ["2026-07-20", "2026-07-21"],
      rowDelta: 0,
      columnDelta: 1,
      extendSelection: true
    });
    expect(extended.selection).toMatchObject({ unitId: "bed_a", arrivalDate: "2026-07-20", departureDate: "2026-07-22" });
    expect(moveRoomStatusFocus([], [], null, 1, 1)).toBeNull();
  });

  it("preserves state identity for duplicate focus, selection, and scroll events", () => {
    const selection = selectionFromCells("room_a", "2026-07-20", "2026-07-21");
    const state = createRoomStatusViewState({
      focusedCell: { unitId: "room_a", serviceDate: "2026-07-21" },
      selection,
      scrollAnchor: { unitId: "room_a", left: 24, top: 48 }
    });

    expect(roomStatusViewReducer(state, {
      type: "SET_FOCUS",
      focus: { unitId: "room_a", serviceDate: "2026-07-21" }
    })).toBe(state);
    expect(roomStatusViewReducer(state, { type: "SET_SELECTION", selection: { ...selection } })).toBe(state);
    expect(roomStatusViewReducer(state, {
      type: "SET_SCROLL_ANCHOR",
      anchor: { unitId: "room_a", left: 24, top: 48 }
    })).toBe(state);
  });
});

describe("RoomStatus filters", () => {
  const bedA = unit({
    id: "unit_bed_101_a",
    roomId: "unit_room_101",
    parentRoomId: "unit_room_101",
    kind: "BED",
    code: "101-A",
    name: "1栋101 A床",
    capacity: 1,
    childUnitIds: [],
    days: [day("2026-07-20", "IN_HOUSE")]
  });
  const bedB = unit({
    id: "unit_bed_101_b",
    roomId: "unit_room_101",
    parentRoomId: "unit_room_101",
    kind: "BED",
    code: "101-B",
    name: "1栋101 B床",
    capacity: 1,
    childUnitIds: [],
    days: [day("2026-07-20", "AVAILABLE")]
  });
  const room = unit({ childUnitIds: [bedA.id, bedB.id], children: [bedA, bedB] });

  it("keeps the parent row while filtering to a matching child bed", () => {
    const result = filterRoomStatusRooms([room], {
      ...DEFAULT_ROOM_STATUS_FILTERS,
      kind: "BED",
      status: "IN_HOUSE"
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.room.id).toBe(room.id);
    expect(result[0]?.children.map((child) => child.id)).toEqual([bedA.id]);
  });

  it("does not expose children when the authoritative sales mode is whole-room", () => {
    const result = filterRoomStatusRooms([{ ...room, salesMode: "WHOLE_ROOM" }], {
      ...DEFAULT_ROOM_STATUS_FILTERS,
      kind: "BED"
    });
    expect(result).toEqual([]);
  });

  it("clears the previous selection and roving focus whenever filters change or clear", () => {
    const selected = createRoomStatusViewState({
      focusedCell: { unitId: room.id, serviceDate: "2026-07-20" },
      selection: selectionFromCells(room.id, "2026-07-20", "2026-07-21")
    });

    const filtered = roomStatusViewReducer(selected, {
      type: "SET_FILTERS",
      filters: { ...DEFAULT_ROOM_STATUS_FILTERS, search: "不存在的房源" }
    });
    expect(filtered.focusedCell).toBeNull();
    expect(filtered.selection).toBeNull();

    const cleared = roomStatusViewReducer({
      ...filtered,
      focusedCell: { unitId: room.id, serviceDate: "2026-07-20" },
      selection: selectionFromCells(room.id, "2026-07-20", "2026-07-20")
    }, { type: "CLEAR_FILTERS" });
    expect(cleared.filters).toEqual(DEFAULT_ROOM_STATUS_FILTERS);
    expect(cleared.focusedCell).toBeNull();
    expect(cleared.selection).toBeNull();
  });
});

describe("RoomStatus restoration", () => {
  it("round-trips a versioned property-scoped view and rejects unsafe restoration", () => {
    const snapshot = {
      version: 1 as const,
      propertyId: "property_qintopia",
      range: {
        arrivalDate: "2026-07-20",
        departureDate: "2026-08-03"
      },
      revision: "room-status-revision-42",
      savedAt: "2026-07-20T10:00:00.000Z",
      state: createRoomStatusViewState({
        expandedRoomIds: ["unit_room_101"],
        dateWindowStart: 7,
        selection: selectionFromCells("unit_bed_101_a", "2026-07-20", "2026-07-21")
      })
    };
    const serialized = serializeRoomStatusRestoration(snapshot);
    expect(parseRoomStatusRestoration(serialized, snapshot.propertyId)).toEqual(snapshot);
    const legacySnapshot = JSON.parse(serialized) as { state: Record<string, unknown> };
    delete legacySnapshot.state.dateWindowMode;
    expect(parseRoomStatusRestoration(JSON.stringify(legacySnapshot), snapshot.propertyId)?.state.dateWindowMode).toBe("AUTO");
    const fullStaySelection = {
      ...snapshot,
      state: createRoomStatusViewState({
        focusedCell: { unitId: "unit_bed_101_a", serviceDate: "2026-07-21" },
        selection: {
          unitId: "unit_bed_101_a",
          anchorDate: "2026-07-21",
          focusDate: "2026-07-21",
          arrivalDate: "2026-07-20",
          departureDate: "2026-07-24"
        }
      })
    };
    expect(parseRoomStatusRestoration(serializeRoomStatusRestoration(fullStaySelection), snapshot.propertyId))
      .toEqual(fullStaySelection);
    expect(parseRoomStatusRestoration(JSON.stringify({
      ...fullStaySelection,
      state: {
        ...fullStaySelection.state,
        selection: { ...fullStaySelection.state.selection!, focusDate: "2026-07-24" }
      }
    }), snapshot.propertyId)).toBeUndefined();
    expect(parseRoomStatusRestoration(serialized, "property_other")).toBeUndefined();
    expect(parseRoomStatusRestoration(JSON.stringify({ ...snapshot, range: { arrivalDate: "2026-07-20", departureDate: "2026-07-20" } }), snapshot.propertyId)).toBeUndefined();
    expect(parseRoomStatusRestoration(JSON.stringify({
      ...snapshot,
      state: createRoomStatusViewState({ selection: selectionFromCells("unit_room_101", "2026-07-19", "2026-07-19") })
    }), snapshot.propertyId)).toBeUndefined();
    expect(parseRoomStatusRestoration(JSON.stringify({ ...snapshot, range: { arrivalDate: "2026-07-20", departureDate: "2026-10-18" } }), snapshot.propertyId)?.range)
      .toEqual({ arrivalDate: "2026-07-20", departureDate: "2026-10-18" });
    expect(parseRoomStatusRestoration(JSON.stringify({ ...snapshot, range: { arrivalDate: "2026-07-20", departureDate: "2026-10-19" } }), snapshot.propertyId)).toBeUndefined();
    expect(parseRoomStatusRestoration("{", snapshot.propertyId)).toBeUndefined();
  });

  it("restores only cells rendered by the current filters, expansion and date window", () => {
    const bedA = unit({
      id: "unit_bed_101_a",
      roomId: "unit_room_101",
      parentRoomId: "unit_room_101",
      kind: "BED",
      code: "101-A",
      name: "1栋101 A床",
      capacity: 1
    });
    const room = unit({ childUnitIds: [bedA.id], children: [bedA] });
    const state = createRoomStatusViewState({
      expandedRoomIds: [room.id],
      focusedCell: { unitId: bedA.id, serviceDate: "2026-07-21" },
      selection: selectionFromCells(bedA.id, "2026-07-20", "2026-07-21"),
      scrollAnchor: { unitId: bedA.id, left: 32, top: 48 }
    });

    expect(reconcileRoomStatusRestoration([room], ["2026-07-20", "2026-07-21"], state)).toEqual({
      state,
      outcome: "RESTORED",
      filtersCleared: false,
      dateWindowAdjusted: false,
      scrollAnchorAdjusted: false
    });
  });

  it("keeps a changed selection inspectable but returns focus to its start", () => {
    const original = unit();
    const state = createRoomStatusViewState({
      focusedCell: { unitId: original.id, serviceDate: "2026-07-21" },
      selection: selectionFromCells(original.id, "2026-07-20", "2026-07-21"),
      scrollAnchor: { unitId: original.id, left: 32, top: 48 }
    });
    const fingerprint = roomStatusFactFingerprint([original], state);
    const changed = unit({
      days: [day("2026-07-20"), day("2026-07-21", "IN_HOUSE")]
    });

    const result = reconcileRoomStatusRestoration(
      [changed],
      ["2026-07-20", "2026-07-21"],
      state,
      fingerprint
    );

    expect(result.outcome).toBe("FACT_CHANGED");
    expect(result.state.selection).toEqual(state.selection);
    expect(result.state.focusedCell).toEqual({ unitId: original.id, serviceDate: "2026-07-20" });
    expect(roomStatusFactFingerprint([changed], result.state)).not.toBe(fingerprint);
  });

  it("clears a hidden child selection and focuses the first genuinely visible cell", () => {
    const bedA = unit({
      id: "unit_bed_101_a",
      roomId: "unit_room_101",
      parentRoomId: "unit_room_101",
      kind: "BED",
      code: "101-A",
      name: "1栋101 A床",
      capacity: 1
    });
    const room = unit({ childUnitIds: [bedA.id], children: [bedA] });
    const state = createRoomStatusViewState({
      expandedRoomIds: [],
      focusedCell: { unitId: bedA.id, serviceDate: "2026-07-21" },
      selection: selectionFromCells(bedA.id, "2026-07-20", "2026-07-21")
    });
    const result = reconcileRoomStatusRestoration([room], ["2026-07-20", "2026-07-21"], state);

    expect(result.outcome).toBe("FALLBACK");
    expect(result.filtersCleared).toBe(false);
    expect(result.state.selection).toBeNull();
    expect(result.state.focusedCell).toEqual({ unitId: room.id, serviceDate: "2026-07-20" });
    expect(result.state.scrollAnchor).toEqual({ unitId: room.id, left: 0, top: 0 });
  });

  it("clears an obsolete zero-result filter before choosing a focusable fallback", () => {
    const room = unit();
    const state = createRoomStatusViewState({
      filters: { ...DEFAULT_ROOM_STATUS_FILTERS, search: "房间已删除" },
      focusedCell: { unitId: "unit_removed", serviceDate: "2026-07-20" },
      selection: selectionFromCells("unit_removed", "2026-07-20", "2026-07-20")
    });
    const result = reconcileRoomStatusRestoration([room], ["2026-07-20", "2026-07-21"], state);

    expect(result.outcome).toBe("FALLBACK");
    expect(result.filtersCleared).toBe(true);
    expect(result.state.filters).toEqual(DEFAULT_ROOM_STATUS_FILTERS);
    expect(result.state.focusedCell).toEqual({ unitId: room.id, serviceDate: "2026-07-20" });
  });

  it("moves a stale date window to a valid saved selection instead of clearing it", () => {
    const room = unit();
    const dates = ["2026-07-20", "2026-07-21", "2026-07-22"];
    const state = createRoomStatusViewState({
      dateWindowStart: 99,
      dateWindowSize: 2,
      focusedCell: { unitId: room.id, serviceDate: "2026-07-20" },
      selection: selectionFromCells(room.id, "2026-07-20", "2026-07-20")
    });
    const result = reconcileRoomStatusRestoration([room], dates, state);

    expect(result.outcome).toBe("RESTORED");
    expect(result.dateWindowAdjusted).toBe(true);
    expect(result.state.dateWindowStart).toBe(0);
    expect(result.state.focusedCell).toEqual({ unitId: room.id, serviceDate: "2026-07-20" });
    expect(result.state.selection).toEqual(state.selection);
  });

  it("rejects serialized selections whose active cell falls outside the selected Stay range", () => {
    const valid = {
      version: 1 as const,
      propertyId: "property_qintopia",
      range: { arrivalDate: "2026-07-20", departureDate: "2026-08-03" },
      revision: "room-status-revision-42",
      savedAt: "2026-07-20T10:00:00.000Z",
      state: createRoomStatusViewState({
        selection: {
          unitId: "unit_room_101",
          anchorDate: "2026-07-20",
          focusDate: "2026-07-21",
          arrivalDate: "2026-07-20",
          departureDate: "2026-07-30"
        }
      })
    };
    expect(parseRoomStatusRestoration(JSON.stringify({
      ...valid,
      state: {
        ...valid.state,
        selection: { ...valid.state.selection!, focusDate: "2026-07-30" }
      }
    }), valid.propertyId)).toBeUndefined();
    expect(parseRoomStatusRestoration(JSON.stringify({ ...valid, factFingerprint: 42 }), valid.propertyId)).toBeUndefined();
  });
});
