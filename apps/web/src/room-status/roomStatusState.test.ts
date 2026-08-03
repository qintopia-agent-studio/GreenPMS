import { describe, expect, it } from "vitest";
import type { RoomStatusDayDto, RoomStatusIntervalDto, RoomStatusUnitDto } from "@qintopia/contracts";
import {
  DEFAULT_ROOM_STATUS_FILTERS,
  MAX_VISIBLE_DAYS,
  createRoomStatusViewState,
  createRoomStatusOrderReturnState,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  hasRoomStatusOrderReturnEnvelope,
  intervalsRenderedOnRoomStatusGrid,
  moveRoomStatusFocus,
  parseRoomStatusRestoration,
  parseRoomStatusOrderReturnTarget,
  reconcileRoomStatusRestoration,
  resolveRoomStatusOrderReturnTarget,
  roomStatusFactFingerprint,
  roomStatusCellBelongsToStay,
  roomStatusOrderIdentityForDate,
  roomStatusOrderOptionsForDate,
  roomStatusUniqueOrderStayId,
  roomStatusOrderIdentityForReturnTarget,
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

describe("RoomStatus quick order options", () => {
  it("lists every exact bed order from a parent room without guessing a single order", () => {
    const bedAInterval = lodgingInterval({
      label: "订单 order_bed",
      primaryOccupantLabel: "云朵",
      occupants: [{ occupantId: "occupant_bed_a", nickname: "云朵" }],
      actualInventoryUnitId: "unit_bed_101_a",
      startDate: "2026-07-20",
      endDate: "2026-07-21",
      sourceStartDate: "2026-07-18",
      sourceEndDate: "2026-07-24"
    });
    const bedBInterval = lodgingInterval({
      id: "interval_bed_order_b",
      label: "订单 order_bed_b",
      primaryOccupantLabel: "青岚",
      occupants: [{ occupantId: "occupant_bed_b", nickname: "青岚" }],
      actualInventoryUnitId: "unit_bed_101_b",
      references: [
        { ...orderReference, id: "order_bed_b", href: "/orders/order_bed_b" },
        { ...stayReference, id: "stay_bed_b" }
      ]
    });
    const parent = unit({
      children: [
        unit({ id: "unit_bed_101_a", roomId: "unit_room_101", parentRoomId: "unit_room_101", kind: "BED", salesMode: "BED_SPLIT", intervals: [bedAInterval], children: [] }),
        unit({ id: "unit_bed_101_b", roomId: "unit_room_101", parentRoomId: "unit_room_101", kind: "BED", salesMode: "BED_SPLIT", intervals: [bedBInterval], children: [] })
      ]
    });

    const result = roomStatusOrderOptionsForDate(parent, "2026-07-20");
    expect(result.kind).toBe("READY");
    if (result.kind === "READY") {
      expect(result.orders.map((order) => [order.label, order.identity.orderId])).toEqual([
        ["云朵", "order_bed"],
        ["青岚", "order_bed_b"]
      ]);
      expect(result.orders[0]?.identity).toMatchObject({
        arrivalDate: "2026-07-18",
        departureDate: "2026-07-24"
      });
    }
  });

  it("never falls back to a machine interval label when occupant labels are unavailable", () => {
    const interval = lodgingInterval({
      label: "订单 order_internal_123",
      primaryOccupantLabel: null,
      occupants: []
    });
    const bed = unit({
      id: "unit_bed_101_a",
      roomId: "unit_room_101",
      parentRoomId: "unit_room_101",
      kind: "BED",
      salesMode: "BED_SPLIT",
      intervals: [interval],
      children: []
    });
    const result = roomStatusOrderOptionsForDate(bed, "2026-07-20");
    expect(result).toMatchObject({ kind: "READY", orders: [{ label: "住宿订单" }] });
  });

  it("fails closed when any visible lodging lacks a stable order and Stay pair", () => {
    const broken = lodgingInterval({ references: [orderReference] });
    const bed = unit({
      id: "unit_bed_101_a",
      roomId: "unit_room_101",
      parentRoomId: "unit_room_101",
      kind: "BED",
      salesMode: "BED_SPLIT",
      intervals: [broken],
      children: []
    });
    expect(roomStatusOrderOptionsForDate(bed, "2026-07-20")).toEqual({ kind: "INVALID_REFERENCE" });
  });

  it("keeps validating a child-bed lodging inherited by a filtered parent row", () => {
    const inherited = lodgingInterval({
      actualInventoryUnitId: "unit_bed_filtered",
      references: [orderReference]
    });
    const parent = unit({
      kind: "ROOM",
      salesMode: "BED_SPLIT",
      intervals: [inherited],
      children: []
    });

    expect(roomStatusOrderOptionsForDate(parent, "2026-07-20"))
      .toEqual({ kind: "INVALID_REFERENCE" });
  });

  it("fails closed unless visible Order and Stay references form a one-to-one mapping", () => {
    const parentFor = (references: RoomStatusIntervalDto["references"]) => unit({
      children: [
        unit({
          id: "unit_bed_101_a",
          roomId: "unit_room_101",
          parentRoomId: "unit_room_101",
          kind: "BED",
          salesMode: "BED_SPLIT",
          intervals: [lodgingInterval({ actualInventoryUnitId: "unit_bed_101_a" })],
          children: []
        }),
        unit({
          id: "unit_bed_101_b",
          roomId: "unit_room_101",
          parentRoomId: "unit_room_101",
          kind: "BED",
          salesMode: "BED_SPLIT",
          intervals: [lodgingInterval({
            id: "interval_bed_order_b",
            actualInventoryUnitId: "unit_bed_101_b",
            references
          })],
          children: []
        })
      ]
    });

    const oneOrderToTwoStays = parentFor([
      orderReference,
      { ...stayReference, id: "stay_bed_b", label: "Stay stay_bed_b" }
    ]);
    expect(roomStatusOrderOptionsForDate(oneOrderToTwoStays, "2026-07-20"))
      .toEqual({ kind: "INVALID_REFERENCE" });

    const twoOrdersToOneStay = parentFor([
      { ...orderReference, id: "order_bed_b", label: "Order order_bed_b", href: "/orders/order_bed_b" },
      stayReference
    ]);
    expect(roomStatusOrderOptionsForDate(twoOrdersToOneStay, "2026-07-20"))
      .toEqual({ kind: "INVALID_REFERENCE" });

    const duplicateIntervalId = parentFor([
      orderReference,
      { ...stayReference, id: "stay_bed_b", label: "Stay stay_bed_b" }
    ]);
    duplicateIntervalId.children[1]!.intervals[0]!.id = duplicateIntervalId.children[0]!.intervals[0]!.id;
    expect(roomStatusOrderOptionsForDate(duplicateIntervalId, "2026-07-20"))
      .toEqual({ kind: "INVALID_REFERENCE" });
  });
});

describe("RoomStatus stable order selection", () => {
  it("previews a Stay only when a quick-popover cell resolves to exactly one order", () => {
    const exact = roomStatusOrderOptionsForDate(unit({
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({ actualInventoryUnitId: "unit_room_101" })]
    }), "2026-07-20");
    expect(roomStatusUniqueOrderStayId(exact)).toBe("stay_bed");

    expect(exact.kind).toBe("READY");
    if (exact.kind !== "READY") throw new Error("expected an exact order option");
    expect(roomStatusUniqueOrderStayId({
      kind: "READY",
      orders: [
        exact.orders[0]!,
        {
          ...exact.orders[0]!,
          identity: { ...exact.orders[0]!.identity, orderId: "order_b", stayId: "stay_b" }
        }
      ]
    })).toBeNull();
    expect(roomStatusUniqueOrderStayId({ kind: "READY", orders: [] })).toBeNull();
    expect(roomStatusUniqueOrderStayId({ kind: "INVALID_REFERENCE" })).toBeNull();
  });

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

  it("resolves the same Stay from either side of a room move without merging a same-nickname order", () => {
    const movedOrderReference = { ...orderReference, id: "order_moved", href: "/orders/order_moved" };
    const movedStayReference = { ...stayReference, id: "stay_moved" };
    const fromRoom = unit({
      id: "unit_room_b01",
      roomId: "unit_room_b01",
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({
        id: "interval_moved_from",
        displayInventoryUnitId: "unit_room_b01",
        actualInventoryUnitId: "unit_room_b01",
        roomId: "unit_room_b01",
        startDate: "2026-07-20",
        endDate: "2026-07-22",
        sourceStartDate: "2026-07-20",
        sourceEndDate: "2026-07-25",
        primaryOccupantLabel: "青禾",
        references: [movedOrderReference, movedStayReference]
      })]
    });
    const toRoom = unit({
      id: "unit_room_b02",
      roomId: "unit_room_b02",
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({
        id: "interval_moved_to",
        displayInventoryUnitId: "unit_room_b02",
        actualInventoryUnitId: "unit_room_b02",
        roomId: "unit_room_b02",
        startDate: "2026-07-22",
        endDate: "2026-07-25",
        sourceStartDate: "2026-07-20",
        sourceEndDate: "2026-07-25",
        primaryOccupantLabel: "青禾",
        references: [movedOrderReference, movedStayReference]
      })]
    });
    const sameNicknameOtherStay = unit({
      id: "unit_room_b03",
      roomId: "unit_room_b03",
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({
        id: "interval_same_nickname_other_stay",
        displayInventoryUnitId: "unit_room_b03",
        actualInventoryUnitId: "unit_room_b03",
        roomId: "unit_room_b03",
        startDate: "2026-07-22",
        endDate: "2026-07-25",
        sourceStartDate: "2026-07-22",
        sourceEndDate: "2026-07-25",
        primaryOccupantLabel: "青禾",
        references: [
          { ...orderReference, id: "order_other", href: "/orders/order_other" },
          { ...stayReference, id: "stay_other" }
        ]
      })]
    });

    expect(roomStatusOrderIdentityForDate(fromRoom, "2026-07-21")).toMatchObject({
      orderId: "order_moved",
      stayId: "stay_moved",
      unitId: "unit_room_b01"
    });
    expect(roomStatusOrderIdentityForDate(toRoom, "2026-07-22")).toMatchObject({
      orderId: "order_moved",
      stayId: "stay_moved",
      unitId: "unit_room_b02"
    });
    expect(roomStatusCellBelongsToStay(fromRoom, "2026-07-21", "stay_moved")).toBe(true);
    expect(roomStatusCellBelongsToStay(toRoom, "2026-07-22", "stay_moved")).toBe(true);
    expect(roomStatusCellBelongsToStay(fromRoom, "2026-07-22", "stay_moved")).toBe(false);
    expect(roomStatusCellBelongsToStay(sameNicknameOtherStay, "2026-07-22", "stay_moved")).toBe(false);

    const returnState = createRoomStatusOrderReturnState("property_qintopia", {
      orderId: "order_moved",
      stayId: "stay_moved",
      arrivalDate: "2026-07-20"
    }, "2026-07-22");
    const returnTarget = parseRoomStatusOrderReturnTarget(returnState);
    expect(returnTarget).toMatchObject({ orderId: "order_moved", stayId: "stay_moved", triggerDate: "2026-07-22" });
    expect(roomStatusOrderIdentityForReturnTarget([fromRoom, toRoom, sameNicknameOtherStay], returnTarget!)).toMatchObject({
      orderId: "order_moved",
      stayId: "stay_moved",
      unitId: "unit_room_b02"
    });
    const parentAggregateCopy = unit({
      id: "unit_parent_b02",
      roomId: "unit_parent_b02",
      salesMode: "BED_SPLIT",
      intervals: [lodgingInterval({
        id: "interval_moved_to_parent_copy",
        displayInventoryUnitId: "unit_parent_b02",
        actualInventoryUnitId: "unit_room_b02",
        roomId: "unit_parent_b02",
        startDate: "2026-07-22",
        endDate: "2026-07-25",
        sourceStartDate: "2026-07-20",
        sourceEndDate: "2026-07-25",
        primaryOccupantLabel: "青禾",
        references: [movedOrderReference, movedStayReference]
      })]
    });
    expect(roomStatusOrderIdentityForReturnTarget(
      [fromRoom, parentAggregateCopy, toRoom, sameNicknameOtherStay],
      returnTarget!
    )).toMatchObject({
      intervalId: "interval_moved_to",
      unitId: "unit_room_b02"
    });
    expect(roomStatusOrderIdentityForReturnTarget([fromRoom, toRoom], {
      ...returnTarget!,
      triggerDate: "2026-07-19"
    })).toBeNull();
    expect(resolveRoomStatusOrderReturnTarget([fromRoom, toRoom], {
      ...returnTarget!,
      triggerDate: "2026-07-19"
    })).toEqual({ kind: "NOT_FOUND" });
  });

  it("strictly parses a property-scoped order return target", () => {
    const returnState = createRoomStatusOrderReturnState("property_qintopia", {
      orderId: "order_moved",
      stayId: "stay_moved",
      arrivalDate: "2026-07-20"
    }, "2026-07-22");
    expect(parseRoomStatusOrderReturnTarget(returnState)).toEqual({
      version: 1,
      propertyId: "property_qintopia",
      orderId: "order_moved",
      stayId: "stay_moved",
      triggerDate: "2026-07-22"
    });
    expect(hasRoomStatusOrderReturnEnvelope(returnState)).toBe(true);
    expect(hasRoomStatusOrderReturnEnvelope({ fromRoomStatus: true })).toBe(false);

    const invalidStates: unknown[] = [
      null,
      [],
      { fromRoomStatus: true },
      { ...returnState, unexpected: true },
      { ...returnState, fromRoomStatus: false },
      { ...returnState, roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, unexpected: true } },
      { ...returnState, roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, version: 2 } },
      { ...returnState, roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, orderId: " order_moved" } },
      { ...returnState, roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, stayId: "" } },
      { ...returnState, roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, triggerDate: "2026-02-30" } }
    ];
    for (const state of invalidStates) {
      expect(parseRoomStatusOrderReturnTarget(state)).toBeNull();
    }
    expect(hasRoomStatusOrderReturnEnvelope(invalidStates[3])).toBe(true);
    expect(parseRoomStatusOrderReturnTarget({
      ...returnState,
      roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, propertyId: " property_other" }
    })).toBeNull();
    expect(parseRoomStatusOrderReturnTarget({
      ...returnState,
      roomStatusOrderReturn: { ...returnState.roomStatusOrderReturn, propertyId: "property_other" }
    })).toMatchObject({ propertyId: "property_other" });
  });

  it("fails closed when more than one matching Stay segment covers the return trigger date", () => {
    const movedOrderReference = { ...orderReference, id: "order_moved", href: "/orders/order_moved" };
    const movedStayReference = { ...stayReference, id: "stay_moved" };
    const matchingRoom = (unitId: string, intervalId: string) => unit({
      id: unitId,
      roomId: unitId,
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({
        id: intervalId,
        displayInventoryUnitId: unitId,
        actualInventoryUnitId: unitId,
        roomId: unitId,
        startDate: "2026-07-22",
        endDate: "2026-07-25",
        references: [movedOrderReference, movedStayReference]
      })]
    });

    expect(roomStatusOrderIdentityForReturnTarget([
      matchingRoom("unit_room_b01", "interval_moved_b01"),
      matchingRoom("unit_room_b02", "interval_moved_b02")
    ], {
      orderId: "order_moved",
      stayId: "stay_moved",
      triggerDate: "2026-07-22"
    })).toBeNull();
    expect(resolveRoomStatusOrderReturnTarget([
      matchingRoom("unit_room_b01", "interval_moved_b01"),
      matchingRoom("unit_room_b02", "interval_moved_b02")
    ], {
      orderId: "order_moved",
      stayId: "stay_moved",
      triggerDate: "2026-07-22"
    })).toEqual({ kind: "AMBIGUOUS" });
  });

  it("does not collapse distinct direct intervals at the same placement", () => {
    const movedOrderReference = { ...orderReference, id: "order_moved", href: "/orders/order_moved" };
    const movedStayReference = { ...stayReference, id: "stay_moved" };
    const directRoom = unit({
      id: "unit_room_b01",
      roomId: "unit_room_b01",
      salesMode: "WHOLE_ROOM",
      intervals: ["interval_direct_first", "interval_direct_second"].map((id) => lodgingInterval({
        id,
        displayInventoryUnitId: "unit_room_b01",
        actualInventoryUnitId: "unit_room_b01",
        roomId: "unit_room_b01",
        startDate: "2026-07-22",
        endDate: "2026-07-25",
        references: [movedOrderReference, movedStayReference]
      }))
    });

    expect(resolveRoomStatusOrderReturnTarget([directRoom], {
      orderId: "order_moved",
      stayId: "stay_moved",
      triggerDate: "2026-07-22"
    })).toEqual({ kind: "AMBIGUOUS" });
  });

  it("prefers the canonical child interval over its parent-room display copy", () => {
    const bedOrderReference = { ...orderReference, id: "order_bed", href: "/orders/order_bed" };
    const bedStayReference = { ...stayReference, id: "stay_bed" };
    const parent = unit({
      id: "unit_room_101",
      roomId: "unit_room_101",
      salesMode: "BED_SPLIT",
      intervals: [lodgingInterval({
        id: "interval_bed_parent_display",
        displayInventoryUnitId: "unit_room_101",
        actualInventoryUnitId: "unit_room_101_bed_a",
        roomId: "unit_room_101",
        startDate: "2026-07-20",
        endDate: "2026-07-25",
        references: [bedOrderReference, bedStayReference]
      })]
    });
    const bed = unit({
      id: "unit_room_101_bed_a",
      roomId: "unit_room_101",
      salesMode: "BED_SPLIT",
      intervals: [lodgingInterval({
        id: "interval_bed_canonical",
        displayInventoryUnitId: "unit_room_101_bed_a",
        actualInventoryUnitId: "unit_room_101_bed_a",
        roomId: "unit_room_101",
        startDate: "2026-07-20",
        endDate: "2026-07-25",
        references: [bedOrderReference, bedStayReference]
      })]
    });

    expect(roomStatusOrderIdentityForReturnTarget([parent, bed], {
      orderId: "order_bed",
      stayId: "stay_bed",
      triggerDate: "2026-07-22"
    })).toMatchObject({
      intervalId: "interval_bed_canonical",
      unitId: "unit_room_101_bed_a"
    });
    expect(roomStatusCellBelongsToStay(parent, "2026-07-22", "stay_bed")).toBe(false);
    expect(roomStatusCellBelongsToStay(bed, "2026-07-22", "stay_bed")).toBe(true);
  });

  it("does not highlight a damaged interval with an ambiguous stable identity", () => {
    const damaged = unit({
      id: "unit_room_ambiguous",
      roomId: "unit_room_ambiguous",
      salesMode: "WHOLE_ROOM",
      intervals: [lodgingInterval({
        actualInventoryUnitId: "unit_room_ambiguous",
        displayInventoryUnitId: "unit_room_ambiguous",
        references: [
          { ...orderReference, id: "order_first", href: "/orders/order_first" },
          { ...orderReference, id: "order_second", href: "/orders/order_second" },
          { ...stayReference, id: "stay_ambiguous" }
        ]
      })]
    });

    expect(roomStatusOrderIdentityForDate(damaged, "2026-07-20")).toBeNull();
    expect(roomStatusCellBelongsToStay(damaged, "2026-07-20", "stay_ambiguous")).toBe(false);
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
  const dates = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 1 + index));
    return date.toISOString().slice(0, 10);
  });

  it("uses one fixed 30-night date window", () => {
    expect(MAX_VISIBLE_DAYS).toBe(30);
    expect(visibleDateWindow(dates, 0, 90)).toEqual(dates);
    expect(visibleDateWindow(dates, 29, 14)).toEqual(dates.slice(16, 30));
    expect(shiftDateWindowStart(dates.length, 0, 30, 1)).toBe(0);
    expect(shiftDateWindowStart(dates.length, 0, 30, -1)).toBe(0);
    expect(dateWindowStartForFocus(dates, 0, 30, dates[29]!)).toBe(0);
  });

  it("migrates legacy automatic and explicit date-window modes to 30 nights", () => {
    const automatic = roomStatusViewReducer(createRoomStatusViewState({ dateWindowMode: "AUTO", dateWindowSize: 10 }), {
      type: "SET_DATE_WINDOW_MODE",
      mode: "AUTO",
      autoSize: 10,
      totalDates: dates.length
    });
    expect(automatic).toMatchObject({ dateWindowMode: "30", dateWindowSize: 30 });
    expect(roomStatusViewReducer(automatic, {
      type: "SET_DATE_WINDOW_MODE",
      mode: "21",
      autoSize: 10,
      totalDates: dates.length
    })).toMatchObject({ dateWindowMode: "30", dateWindowSize: 30 });
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

  it("replaces an existing range when a different cell is inspected without extension", () => {
    const state = createRoomStatusViewState({
      focusedCell: { unitId: "room_a", serviceDate: "2026-07-20" },
      selection: selectionFromCells("room_a", "2026-07-20", "2026-07-22")
    });
    const next = roomStatusViewReducer(state, {
      type: "SELECT_CELL",
      unitId: "room_b",
      serviceDate: "2026-07-25",
      extend: false
    });
    expect(next.selection).toEqual({
      unitId: "room_b",
      anchorDate: "2026-07-25",
      focusDate: "2026-07-25",
      arrivalDate: "2026-07-25",
      departureDate: "2026-07-26"
    });
    expect(next.focusedCell).toEqual({ unitId: "room_b", serviceDate: "2026-07-25" });
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
    expect(parseRoomStatusRestoration(JSON.stringify(legacySnapshot), snapshot.propertyId)?.state.dateWindowMode).toBe("30");
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
    expect(parseRoomStatusRestoration(JSON.stringify({ ...snapshot, range: { arrivalDate: "2026-07-20", departureDate: "2026-08-19" } }), snapshot.propertyId)?.range)
      .toEqual({ arrivalDate: "2026-07-20", departureDate: "2026-08-19" });
    expect(parseRoomStatusRestoration(JSON.stringify({ ...snapshot, range: { arrivalDate: "2026-07-20", departureDate: "2026-08-20" } }), snapshot.propertyId)).toBeUndefined();
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
