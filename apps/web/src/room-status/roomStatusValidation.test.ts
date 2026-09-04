import { describe, expect, it } from "vitest";
import type { RoomStatusBoardDto, RoomStatusConflictDto, RoomStatusIntervalDto, RoomStatusOperationalTaskDto } from "@qintopia/contracts";
import { assertRoomStatusBoard } from "./roomStatusValidation";

const expected = {
  propertyId: "property_validation",
  range: { arrivalDate: "2028-01-01", departureDate: "2028-01-02" },
  pageIndex: 0
};

function validBoard(): RoomStatusBoardDto {
  const targetReference = { type: "INVENTORY_UNIT" as const, id: "unit_validation", label: "Validation room", href: null };
  const createAction = {
    code: "CREATE_ORDER" as const,
    enabled: true,
    disabledReason: null,
    requiresFullInterval: false,
    targetReference
  };
  return {
    propertyId: expected.propertyId,
    businessDate: "2028-01-01",
    range: expected.range,
    dates: ["2028-01-01"],
    asOf: "2028-01-01T00:00:00.000Z",
    freshUntil: "2028-01-01T00:00:05.000Z",
    revision: "1",
    accessLevel: "WRITE",
    projectionState: "READY",
    filterOptions: {
      roomTypeCodes: ["VALIDATION"],
      salesModes: ["WHOLE_ROOM"],
      statuses: ["AVAILABLE"],
      capacities: [1],
      unitKinds: ["ROOM"]
    },
    page: { index: 0, size: 200, totalRooms: 1, totalPages: 1 },
    operationalTasks: [],
    availabilitySummary: [{
      serviceDate: "2028-01-01",
      availableRooms: 1,
      availableBeds: 0,
      paidOccupiedUnits: 0,
      totalSellableUnits: 1,
      occupantCount: 0
    }],
    rooms: [{
      id: "unit_validation",
      propertyId: expected.propertyId,
      roomId: "unit_validation",
      parentRoomId: null,
      kind: "ROOM",
      code: "V01",
      name: "Validation room",
      active: true,
      salesMode: "WHOLE_ROOM",
      buildingCode: "V",
      roomTypeCode: "VALIDATION",
      pricingProductCode: "VALIDATION",
      physicalBedCount: 1,
      capacity: 1,
      occupancyCapacity: 2,
      childUnitIds: [],
      children: [],
      bedOccupancies: [],
      bedSlotStates: [],
      days: [{
        serviceDate: "2028-01-01",
        status: "AVAILABLE",
        available: true,
        intervalIds: [],
        conflicts: []
      }],
      intervals: [],
      conflicts: [],
      allowedActions: [createAction]
    }]
  };
}

function maintenanceInterval(overrides: Partial<RoomStatusIntervalDto> = {}): RoomStatusIntervalDto {
  const blockReference = { type: "BLOCK" as const, id: "block_validation", label: "Validation block", href: null };
  const claimReference = { type: "CLAIM" as const, id: "claim_validation", label: "Validation claim", href: null };
  return {
    id: "interval_validation",
    displayInventoryUnitId: "unit_validation",
    actualInventoryUnitId: "unit_validation",
    roomId: "unit_validation",
    startDate: "2028-01-01",
    endDate: "2028-01-02",
    sourceStartDate: "2028-01-01",
    sourceEndDate: "2028-01-02",
    status: "MAINTENANCE",
    attention: null,
    operationalAttention: null,
    available: false,
    blocking: true,
    sourceKind: "MAINTENANCE",
    sourceCategory: null,
    freeStayCategoryCode: null,
    freeStayReason: null,
    label: "Maintenance lock",
    primaryOccupantLabel: null,
    occupantCount: 0,
    occupants: [],
    reason: "Validation",
    claimIds: [claimReference.id],
    references: [claimReference, blockReference],
    conflicts: [{
      id: "conflict_validation",
      blockingFactKind: "CLAIM",
      claimId: claimReference.id,
      claimIds: [claimReference.id],
      requestedInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceKind: "MAINTENANCE",
      sourceReference: blockReference,
      reason: "Validation",
      blocking: true
    }],
    history: [],
    allowedActions: [{
      code: "RELEASE_MAINTENANCE",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: true,
      targetReference: blockReference
    }],
    ...overrides
  };
}

function dayConflict(interval: RoomStatusIntervalDto): RoomStatusConflictDto {
  return {
    ...interval.conflicts[0]!,
    id: "conflict_validation_day",
    startDate: "2028-01-01",
    endDate: "2028-01-02"
  };
}

function boardWithMaintenance(): RoomStatusBoardDto {
  const board = validBoard();
  const interval = maintenanceInterval();
  const room = board.rooms[0]!;
  room.intervals = [interval];
  room.days = [{
    serviceDate: "2028-01-01",
    status: "MAINTENANCE",
    available: false,
    intervalIds: [interval.id],
    conflicts: [dayConflict(interval)]
  }];
  room.conflicts = interval.conflicts;
  room.allowedActions = interval.allowedActions;
  return board;
}

function splitBedLodgingInterval(displayInventoryUnitId: string, actualInventoryUnitId: string): RoomStatusIntervalDto {
  const claimReference = { type: "CLAIM" as const, id: "claim_split_validation", label: "Split-bed claim", href: null };
  const orderReference = { type: "ORDER" as const, id: "order_split_validation", label: "Split-bed order", href: "/orders/order_split_validation" };
  const stayReference = { type: "STAY" as const, id: "stay_split_validation", label: "Split-bed Stay", href: null };
  return {
    id: `interval_split_validation_${displayInventoryUnitId}`,
    displayInventoryUnitId,
    actualInventoryUnitId,
    roomId: "unit_validation",
    startDate: "2028-01-01",
    endDate: "2028-01-02",
    sourceStartDate: "2028-01-01",
    sourceEndDate: "2028-01-02",
    status: "RESERVED",
    attention: null,
    operationalAttention: null,
    available: false,
    blocking: true,
    sourceKind: "ORDER",
    sourceCategory: "DIRECT",
    freeStayCategoryCode: null,
    freeStayReason: null,
    label: "Split-bed order",
    primaryOccupantLabel: "Validation nickname",
    occupantCount: 1,
    occupants: [{ occupantId: "occupant_split_validation", nickname: "Validation nickname" }],
    reason: null,
    claimIds: [claimReference.id],
    references: [claimReference, orderReference, stayReference],
    conflicts: [{
      id: `conflict_split_validation_${displayInventoryUnitId}`,
      blockingFactKind: "CLAIM",
      claimId: claimReference.id,
      claimIds: [claimReference.id],
      requestedInventoryUnitId: displayInventoryUnitId,
      actualInventoryUnitId,
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceKind: "ORDER",
      sourceReference: orderReference,
      reason: "Split-bed order",
      blocking: true
    }],
    history: [],
    allowedActions: [{
      code: "OPEN_ORDER",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: false,
      targetReference: orderReference
    }]
  };
}

function boardWithSplitBedLodging(): RoomStatusBoardDto {
  const board = validBoard();
  const room = board.rooms[0]!;
  const childId = "bed_split_validation_a";
  const parentInterval = splitBedLodgingInterval(room.id, childId);
  const childInterval = splitBedLodgingInterval(childId, childId);
  const child = {
    ...room,
    id: childId,
    roomId: room.id,
    parentRoomId: room.id,
    kind: "BED" as const,
    code: "V01-A",
    name: "Validation bed A",
    physicalBedCount: null,
    capacity: 1,
    occupancyCapacity: 1,
    salesMode: "BED_SPLIT" as const,
    childUnitIds: [],
    children: [],
    bedOccupancies: [],
    bedSlotStates: [],
    days: [{
      serviceDate: "2028-01-01",
      status: "RESERVED" as const,
      available: false,
      intervalIds: [childInterval.id],
      conflicts: [dayConflict(childInterval)]
    }],
    intervals: [childInterval],
    conflicts: childInterval.conflicts,
    allowedActions: childInterval.allowedActions
  };
  room.salesMode = "BED_SPLIT";
  room.childUnitIds = [childId];
  room.children = [child];
  room.bedOccupancies = [{
    serviceDate: "2028-01-01",
    occupiedBedCount: 1,
    totalBedCount: 1,
    occupants: [{
      occupantId: "occupant_split_validation",
      inventoryUnitId: childId,
      inventoryUnitCode: child.code,
      primaryOccupantLabel: parentInterval.primaryOccupantLabel,
      sourceReference: {
        type: "ORDER",
        id: "order_split_validation",
        label: "Split-bed order",
        href: "/orders/order_split_validation"
      }
    }]
  }];
  room.bedSlotStates = [{
    serviceDate: "2028-01-01",
    inventoryUnitId: childId,
    inventoryUnitCode: child.code,
    status: "RESERVED"
  }];
  room.days = [{
    serviceDate: "2028-01-01",
    status: "RESERVED",
    available: false,
    intervalIds: [parentInterval.id],
    conflicts: [dayConflict(parentInterval)]
  }];
  room.intervals = [parentInterval];
  room.conflicts = parentInterval.conflicts;
  room.allowedActions = parentInterval.allowedActions;
  board.filterOptions = {
    roomTypeCodes: ["VALIDATION"],
    salesModes: ["BED_SPLIT"],
    statuses: ["RESERVED"],
    capacities: [1],
    unitKinds: ["ROOM", "BED"]
  };
  return board;
}

function boardWithWholeRoomLodging(): RoomStatusBoardDto {
  const board = validBoard();
  const room = board.rooms[0]!;
  const interval = splitBedLodgingInterval(room.id, room.id);
  room.days = [{
    serviceDate: "2028-01-01",
    status: "RESERVED",
    available: false,
    intervalIds: [interval.id],
    conflicts: [dayConflict(interval)]
  }];
  room.intervals = [interval];
  room.conflicts = interval.conflicts;
  room.allowedActions = interval.allowedActions;
  board.filterOptions.statuses = ["RESERVED"];
  return board;
}

function orderExceptionTask(status: "RESERVED" | "IN_HOUSE" | "UNKNOWN"): RoomStatusOperationalTaskDto {
  const claimReference = { type: "CLAIM" as const, id: "claim_order_validation", label: "Order claim", href: null };
  const orderReference = { type: "ORDER" as const, id: "order_validation", label: "Order", href: "/orders/order_validation" };
  const stayReference = { type: "STAY" as const, id: "stay_validation", label: "Stay", href: null };
  const inventoryReference = { type: "INVENTORY_UNIT" as const, id: "unit_validation", label: "V01", href: null };
  const overdueDeparture = status === "IN_HOUSE";
  const claimBacked = !overdueDeparture;
  const startDate = overdueDeparture ? "2027-12-30" : status === "RESERVED" ? "2027-12-31" : "2028-01-01";
  const endDate = overdueDeparture ? "2027-12-31" : "2028-01-02";
  return {
    taskKind: "EXCEPTION",
    businessDate: "2028-01-01",
    id: "task_order_exception",
    displayInventoryUnitId: "unit_validation",
    actualInventoryUnitId: "unit_validation",
    roomId: "unit_validation",
    startDate,
    endDate,
    sourceStartDate: startDate,
    sourceEndDate: endDate,
    orderArrivalDate: startDate,
    orderDepartureDate: endDate,
    status,
    attention: null,
    operationalAttention: status === "RESERVED"
      ? "OVERDUE_RESERVED"
      : status === "IN_HOUSE"
        ? "OVERDUE_IN_HOUSE"
        : null,
    available: overdueDeparture,
    blocking: !overdueDeparture,
    sourceKind: "ORDER",
    sourceCategory: status === "UNKNOWN" ? null : "DIRECT",
    freeStayCategoryCode: null,
    freeStayReason: null,
    label: "Order exception",
    primaryOccupantLabel: null,
    occupantCount: status === "UNKNOWN" ? 0 : 1,
    occupants: status === "UNKNOWN" ? [] : [{ occupantId: "occupant_order_validation", nickname: null }],
    reason: "Validation",
    claimIds: claimBacked ? [claimReference.id] : [],
    references: claimBacked ? [claimReference, orderReference, stayReference, inventoryReference] : [orderReference, stayReference, inventoryReference],
    conflicts: overdueDeparture ? [] : [{
      id: "conflict_order_validation",
      blockingFactKind: overdueDeparture ? "OVERDUE_IN_HOUSE" : "CLAIM",
      claimId: claimBacked ? claimReference.id : null,
      claimIds: claimBacked ? [claimReference.id] : [],
      requestedInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceKind: "ORDER",
      sourceReference: orderReference,
      reason: "Validation",
      blocking: true
    }],
    history: [],
    allowedActions: status === "UNKNOWN" ? [] : [{
      code: "OPEN_ORDER",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: false,
      targetReference: orderReference
    }]
  };
}

function normalLodgingTask(taskKind: "ARRIVAL" | "IN_HOUSE" | "DEPARTURE"): RoomStatusOperationalTaskDto {
  const claimReference = { type: "CLAIM" as const, id: "claim_order_validation", label: "Order claim", href: null };
  const task = orderExceptionTask(taskKind === "ARRIVAL" ? "RESERVED" : "IN_HOUSE");
  const orderReference = task.references.find((reference) => reference.type === "ORDER")!;
  task.id = `task_order_${taskKind.toLowerCase()}`;
  task.taskKind = taskKind;
  task.reason = null;
  task.startDate = taskKind === "ARRIVAL" ? "2028-01-01" : "2027-12-31";
  task.endDate = taskKind === "DEPARTURE" ? "2028-01-01" : "2028-01-02";
  task.sourceStartDate = task.startDate;
  task.sourceEndDate = task.endDate;
  task.orderArrivalDate = task.startDate;
  task.orderDepartureDate = task.endDate;
  task.operationalAttention = null;
  if (taskKind === "DEPARTURE") {
    task.operationalAttention = "DUE_OUT";
    task.available = false;
    task.blocking = true;
    task.claimIds = [];
    task.references = task.references.filter((reference) => reference.type !== "CLAIM");
    task.conflicts = [{
      id: "conflict_order_departure",
      blockingFactKind: "DUE_OUT",
      claimId: null,
      claimIds: [],
      requestedInventoryUnitId: task.displayInventoryUnitId,
      actualInventoryUnitId: task.actualInventoryUnitId,
      roomId: task.roomId,
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceKind: "ORDER",
      sourceReference: orderReference,
      reason: "Validation",
      blocking: true
    }];
    return task;
  }
  task.available = false;
  task.blocking = true;
  task.claimIds = [claimReference.id];
  if (!task.references.some((reference) => reference.type === "CLAIM")) task.references.unshift(claimReference);
  task.conflicts = [{
    id: `conflict_order_${taskKind.toLowerCase()}`,
    blockingFactKind: "CLAIM",
    claimId: claimReference.id,
    claimIds: [claimReference.id],
    requestedInventoryUnitId: task.displayInventoryUnitId,
    actualInventoryUnitId: task.actualInventoryUnitId,
    roomId: task.roomId,
    startDate: "2028-01-01",
    endDate: "2028-01-02",
    sourceKind: "ORDER",
    sourceReference: orderReference,
    reason: "Validation",
    blocking: true
  }];
  return task;
}

describe("assertRoomStatusBoard", () => {
  it("strictly keeps source categories mutually exclusive while preserving only all-null historical free metadata", () => {
    const nonLodging = boardWithMaintenance();
    nonLodging.rooms[0]!.intervals[0]!.sourceCategory = "DIRECT";
    expect(() => assertRoomStatusBoard(nonLodging, expected)).toThrow(/非住宿来源/);

    const missingCategory = boardWithWholeRoomLodging();
    missingCategory.rooms[0]!.intervals[0]!.sourceCategory = null;
    expect(() => assertRoomStatusBoard(missingCategory, expected)).toThrow(/住宿来源/);

    const freeWithOrderCategory = boardWithWholeRoomLodging();
    freeWithOrderCategory.rooms[0]!.intervals[0]!.sourceKind = "FREE_STAY";
    expect(() => assertRoomStatusBoard(freeWithOrderCategory, expected)).toThrow(/免费入住来源类别/);

    const currentFreeMissingReason = boardWithWholeRoomLodging();
    const currentFree = currentFreeMissingReason.rooms[0]!.intervals[0]!;
    currentFree.sourceKind = "FREE_STAY";
    currentFree.sourceCategory = "FREE_STAY";
    currentFree.freeStayCategoryCode = "VOLUNTEER";
    currentFree.freeStayReason = null;
    expect(() => assertRoomStatusBoard(currentFreeMissingReason, expected)).toThrow(/免费入住必须携带类别和原因/);

    const historicalLegacyFree = boardWithWholeRoomLodging();
    historicalLegacyFree.businessDate = "2028-01-02";
    const legacyFree = historicalLegacyFree.rooms[0]!.intervals[0]!;
    legacyFree.sourceKind = "FREE_STAY";
    legacyFree.sourceCategory = null;
    legacyFree.freeStayCategoryCode = null;
    legacyFree.freeStayReason = null;
    legacyFree.status = "SETTLED";
    legacyFree.blocking = false;
    legacyFree.available = true;
    legacyFree.conflicts = [];
    historicalLegacyFree.rooms[0]!.conflicts = [];
    historicalLegacyFree.rooms[0]!.days[0]!.conflicts = [];
    historicalLegacyFree.rooms[0]!.days[0]!.status = "SETTLED";
    historicalLegacyFree.rooms[0]!.days[0]!.available = false;
    expect(() => assertRoomStatusBoard(historicalLegacyFree, expected)).not.toThrow();

    const partialLegacyFree = boardWithWholeRoomLodging();
    partialLegacyFree.businessDate = "2028-01-02";
    const partial = partialLegacyFree.rooms[0]!.intervals[0]!;
    partial.sourceKind = "FREE_STAY";
    partial.sourceCategory = null;
    partial.freeStayCategoryCode = "VOLUNTEER";
    partial.freeStayReason = null;
    partial.status = "SETTLED";
    partial.blocking = false;
    partialLegacyFree.rooms[0]!.days[0]!.status = "SETTLED";
    partialLegacyFree.rooms[0]!.days[0]!.available = true;
    expect(() => assertRoomStatusBoard(partialLegacyFree, expected)).toThrow(/历史.*免费|免费入住/);

    const failedClosed = validBoard();
    failedClosed.projectionState = "PARTIAL";
    const unknownTask = orderExceptionTask("UNKNOWN");
    unknownTask.sourceCategory = null;
    failedClosed.operationalTasks = [unknownTask];
    expect(() => assertRoomStatusBoard(failedClosed, expected)).not.toThrow();

    unknownTask.sourceCategory = "DIRECT";
    expect(() => assertRoomStatusBoard(failedClosed, expected)).toThrow(/UNKNOWN 住宿必须隐藏全部来源/);
  });

  it("accepts a complete authoritative board", () => {
    expect(() => assertRoomStatusBoard(validBoard(), expected)).not.toThrow();
  });

  it("accepts paired original order dates only for lodging intervals", () => {
    const lodging = boardWithWholeRoomLodging();
    lodging.rooms[0]!.intervals[0]!.orderArrivalDate = "2027-12-30";
    lodging.rooms[0]!.intervals[0]!.orderDepartureDate = "2028-01-02";
    lodging.rooms[0]!.intervals[0]!.operationalAttention = "OVERDUE_RESERVED";
    expect(() => assertRoomStatusBoard(lodging, expected)).not.toThrow();

    const afterSourceStart = boardWithWholeRoomLodging();
    afterSourceStart.rooms[0]!.intervals[0]!.orderArrivalDate = "2028-01-02";
    afterSourceStart.rooms[0]!.intervals[0]!.orderDepartureDate = "2028-01-03";
    expect(() => assertRoomStatusBoard(afterSourceStart, expected)).toThrow(/不能晚于来源完整区间/);

    const maintenance = boardWithMaintenance();
    maintenance.rooms[0]!.intervals[0]!.orderArrivalDate = "2028-01-01";
    maintenance.rooms[0]!.intervals[0]!.orderDepartureDate = "2028-01-02";
    expect(() => assertRoomStatusBoard(maintenance, expected)).toThrow(/只能由住宿订单来源提供/);

    const missingDeparture = boardWithWholeRoomLodging();
    missingDeparture.rooms[0]!.intervals[0]!.orderArrivalDate = "2028-01-01";
    expect(() => assertRoomStatusBoard(missingDeparture, expected)).toThrow(/同时提供或同时省略/);
  });

  it("accepts backfill only for an authoritative historical blank day", () => {
    const historical = validBoard();
    historical.businessDate = "2028-01-02";
    historical.rooms[0]!.days[0]!.available = false;
    historical.rooms[0]!.allowedActions = [{
      code: "BACKFILL_ORDER",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: false,
      targetReference: { type: "INVENTORY_UNIT", id: "unit_validation", label: "Validation room", href: null }
    }];
    expect(() => assertRoomStatusBoard(historical, expected)).not.toThrow();

    historical.businessDate = "2028-01-01";
    historical.rooms[0]!.days[0]!.available = true;
    expect(() => assertRoomStatusBoard(historical, expected)).toThrow(/补录动作必须指向对应日期可办理的库存单元/);
  });

  it("requires READY child-bed lodging intervals to have matching occupancy while PARTIAL stays fail closed", () => {
    expect(() => assertRoomStatusBoard(boardWithSplitBedLodging(), expected)).not.toThrow();

    const missingReadyAggregation = boardWithSplitBedLodging();
    missingReadyAggregation.rooms[0]!.bedOccupancies = [];
    expect(() => assertRoomStatusBoard(missingReadyAggregation, expected)).toThrow(/READY 投影缺少.*唯一住客聚合/);

    const partialAggregation = boardWithSplitBedLodging();
    partialAggregation.projectionState = "PARTIAL";
    partialAggregation.rooms[0]!.bedOccupancies = [];
    expect(() => assertRoomStatusBoard(partialAggregation, expected)).not.toThrow();
  });

  it("rejects missing or invalid freshness instead of treating it as writable", () => {
    const missing = validBoard() as unknown as Record<string, unknown>;
    delete missing.freshUntil;
    expect(() => assertRoomStatusBoard(missing, expected)).toThrow(/freshUntil/);

    const extended = validBoard();
    extended.freshUntil = "2028-01-01T00:00:06.000Z";
    expect(() => assertRoomStatusBoard(extended, expected)).toThrow(/5 秒 freshness/);
  });

  it("rejects missing facets and incomplete aggregate Claim references", () => {
    const missingFacets = validBoard() as unknown as Record<string, unknown>;
    delete missingFacets.filterOptions;
    expect(() => assertRoomStatusBoard(missingFacets, expected)).toThrow(/filterOptions/);

    const missingSummaryDate = validBoard();
    missingSummaryDate.availabilitySummary[0]!.serviceDate = "2028-01-02";
    expect(() => assertRoomStatusBoard(missingSummaryDate, expected)).toThrow(/availabilitySummary\[0\]\.serviceDate/);

    const missingBedOccupancies = validBoard() as unknown as { rooms: Array<Record<string, unknown>> };
    delete missingBedOccupancies.rooms[0]!.bedOccupancies;
    expect(() => assertRoomStatusBoard(missingBedOccupancies, expected)).toThrow(/bedOccupancies/);

    const missingClaimIds = boardWithMaintenance() as unknown as {
      rooms: Array<{ intervals: Array<{ conflicts: Array<Record<string, unknown>> }> }>;
    };
    delete missingClaimIds.rooms[0]!.intervals[0]!.conflicts[0]!.claimIds;
    expect(() => assertRoomStatusBoard(missingClaimIds, expected)).toThrow(/claimIds/);
  });

  it("rejects a READ projection that exposes any write action", () => {
    const board = validBoard();
    board.accessLevel = "READ";
    expect(() => assertRoomStatusBoard(board, expected)).toThrow(/READ 主体暴露写动作/);
  });

  it("rejects incomplete nested day and interval DTOs", () => {
    const missingDayFacts = validBoard() as unknown as { rooms: Array<{ days: Array<Record<string, unknown>> }> };
    delete missingDayFacts.rooms[0]!.days[0]!.conflicts;
    expect(() => assertRoomStatusBoard(missingDayFacts, expected)).toThrow(/days\[0\]\.conflicts/);

    const missingOccupantField = validBoard();
    missingOccupantField.rooms[0]!.intervals.push({
      id: "interval_validation",
      displayInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2028-01-01",
      endDate: "2028-01-02",
      sourceStartDate: "2028-01-01",
      sourceEndDate: "2028-01-02",
      status: "MAINTENANCE",
      attention: null,
      operationalAttention: null,
      available: false,
      blocking: true,
      sourceKind: "MAINTENANCE",
      sourceCategory: null,
      freeStayCategoryCode: null,
      freeStayReason: null,
      label: "Maintenance lock",
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: [],
      reason: "Validation",
      claimIds: ["claim_validation"],
      references: [],
      conflicts: [],
      history: [],
      allowedActions: []
    });
    const rawInterval = missingOccupantField.rooms[0]!.intervals[0] as unknown as Record<string, unknown>;
    delete rawInterval.primaryOccupantLabel;
    expect(() => assertRoomStatusBoard(missingOccupantField, expected)).toThrow(/primaryOccupantLabel/);
  });

  it("requires explicit nullable arrears attention on intervals and operational tasks", () => {
    const arrearsAttention = boardWithWholeRoomLodging();
    arrearsAttention.rooms[0]!.intervals[0]!.attention = "ARREARS";
    expect(() => assertRoomStatusBoard(arrearsAttention, expected)).not.toThrow();

    const missingHistoricalArrearsAttention = boardWithWholeRoomLodging();
    missingHistoricalArrearsAttention.rooms[0]!.intervals[0]!.status = "ARREARS";
    missingHistoricalArrearsAttention.rooms[0]!.intervals[0]!.attention = null;
    expect(() => assertRoomStatusBoard(missingHistoricalArrearsAttention, expected))
      .toThrow(/历史欠款状态必须显式携带欠款注意事实/);

    const missingIntervalAttention = boardWithWholeRoomLodging() as unknown as {
      rooms: Array<{ intervals: Array<Record<string, unknown>> }>;
    };
    delete missingIntervalAttention.rooms[0]!.intervals[0]!.attention;
    expect(() => assertRoomStatusBoard(missingIntervalAttention, expected)).toThrow(/attention/);

    const invalidIntervalAttention = boardWithWholeRoomLodging();
    invalidIntervalAttention.rooms[0]!.intervals[0]!.attention = "SETTLED" as never;
    expect(() => assertRoomStatusBoard(invalidIntervalAttention, expected)).toThrow(/attention/);

    const maintenanceAttention = boardWithMaintenance();
    maintenanceAttention.rooms[0]!.intervals[0]!.attention = "ARREARS";
    expect(() => assertRoomStatusBoard(maintenanceAttention, expected)).toThrow(/只能附着于当前预订、在住或历史欠款订单/);

    const inHouseAttention = boardWithWholeRoomLodging();
    inHouseAttention.rooms[0]!.intervals[0]!.status = "IN_HOUSE";
    inHouseAttention.rooms[0]!.days[0]!.status = "IN_HOUSE";
    inHouseAttention.rooms[0]!.intervals[0]!.attention = "ARREARS";
    expect(() => assertRoomStatusBoard(inHouseAttention, expected)).not.toThrow();

    const historicalReservedAttention = boardWithWholeRoomLodging();
    historicalReservedAttention.businessDate = "2028-01-02";
    historicalReservedAttention.rooms[0]!.intervals[0]!.attention = "ARREARS";
    expect(() => assertRoomStatusBoard(historicalReservedAttention, expected))
      .toThrow(/欠款注意事实与营业日分区不一致/);

    const currentHistoricalArrears = boardWithWholeRoomLodging();
    currentHistoricalArrears.rooms[0]!.intervals[0]!.status = "ARREARS";
    currentHistoricalArrears.rooms[0]!.days[0]!.status = "ARREARS";
    currentHistoricalArrears.rooms[0]!.intervals[0]!.attention = "ARREARS";
    expect(() => assertRoomStatusBoard(currentHistoricalArrears, expected))
      .toThrow(/欠款注意事实与营业日分区不一致/);

    const clippedSourceStillCurrent = boardWithWholeRoomLodging();
    clippedSourceStillCurrent.businessDate = "2028-01-02";
    clippedSourceStillCurrent.rooms[0]!.intervals[0]!.status = "ARREARS";
    clippedSourceStillCurrent.rooms[0]!.intervals[0]!.attention = "ARREARS";
    clippedSourceStillCurrent.rooms[0]!.intervals[0]!.sourceEndDate = "2028-01-03";
    clippedSourceStillCurrent.rooms[0]!.days[0]!.status = "ARREARS";
    expect(() => assertRoomStatusBoard(clippedSourceStillCurrent, expected))
      .toThrow(/欠款注意事实与营业日分区不一致|已完成住宿状态只能表示营业日前结束的住宿/);

    const futureSettled = boardWithWholeRoomLodging();
    futureSettled.rooms[0]!.intervals[0]!.status = "SETTLED";
    futureSettled.rooms[0]!.intervals[0]!.attention = null;
    futureSettled.rooms[0]!.days[0]!.status = "SETTLED";
    expect(() => assertRoomStatusBoard(futureSettled, expected))
      .toThrow(/已完成住宿状态只能表示营业日前结束的住宿/);

    const missingTaskAttention = validBoard() as unknown as { operationalTasks: Array<Record<string, unknown>> };
    missingTaskAttention.operationalTasks = [orderExceptionTask("RESERVED") as unknown as Record<string, unknown>];
    delete missingTaskAttention.operationalTasks[0]!.attention;
    expect(() => assertRoomStatusBoard(missingTaskAttention, expected)).toThrow(/attention/);

    const invalidTaskAttention = validBoard();
    invalidTaskAttention.operationalTasks = [{ ...orderExceptionTask("RESERVED"), attention: "SETTLED" as never }];
    expect(() => assertRoomStatusBoard(invalidTaskAttention, expected)).toThrow(/attention/);

    const freeTaskAttention = validBoard();
    freeTaskAttention.operationalTasks = [{
      ...orderExceptionTask("RESERVED"),
      sourceKind: "FREE_STAY",
      sourceCategory: "FREE_STAY",
      freeStayCategoryCode: "VOLUNTEER",
      freeStayReason: "Validation",
      attention: "ARREARS"
    }];
    expect(() => assertRoomStatusBoard(freeTaskAttention, expected)).toThrow(/只能附着于当前预订、在住或历史欠款订单/);
  });

  it("requires each daily status to match its authoritative covering intervals", () => {
    const futureEmptyArrears = validBoard();
    futureEmptyArrears.rooms[0]!.days[0]!.status = "ARREARS";
    expect(() => assertRoomStatusBoard(futureEmptyArrears, expected))
      .toThrow(/必须与覆盖该日的权威区间状态一致/);

    const reservedDayAsArrears = boardWithWholeRoomLodging();
    reservedDayAsArrears.rooms[0]!.days[0]!.status = "ARREARS";
    expect(() => assertRoomStatusBoard(reservedDayAsArrears, expected))
      .toThrow(/必须与覆盖该日的权威区间状态一致/);

    const failOpenReserved = boardWithWholeRoomLodging();
    failOpenReserved.rooms[0]!.intervals[0]!.blocking = false;
    failOpenReserved.rooms[0]!.intervals[0]!.available = true;
    failOpenReserved.rooms[0]!.intervals[0]!.conflicts = [];
    failOpenReserved.rooms[0]!.days[0]!.available = true;
    failOpenReserved.rooms[0]!.days[0]!.conflicts = [];
    failOpenReserved.rooms[0]!.conflicts = [];
    expect(() => assertRoomStatusBoard(failOpenReserved, expected))
      .toThrow(/当前或未来住宿必须保持库存阻断/);
  });

  it("requires authoritative physical-bed and daily bed-slot fields", () => {
    const missingPhysical = validBoard() as unknown as { rooms: Array<Record<string, unknown>> };
    delete missingPhysical.rooms[0]!.physicalBedCount;
    expect(() => assertRoomStatusBoard(missingPhysical, expected)).toThrow(/physicalBedCount/);

    const nullablePhysical = validBoard();
    nullablePhysical.rooms[0]!.physicalBedCount = null;
    expect(() => assertRoomStatusBoard(nullablePhysical, expected)).not.toThrow();

    const missingSlots = validBoard() as unknown as { rooms: Array<Record<string, unknown>> };
    delete missingSlots.rooms[0]!.bedSlotStates;
    expect(() => assertRoomStatusBoard(missingSlots, expected)).toThrow(/bedSlotStates/);

    const split = boardWithSplitBedLodging();
    expect(() => assertRoomStatusBoard(split, expected)).not.toThrow();
    (split.rooms[0]!.bedSlotStates[0] as unknown as Record<string, unknown>).occupied = true;
    expect(() => assertRoomStatusBoard(split, expected)).toThrow(/不允许的字段 occupied/);
  });

  it("rejects READY bed slots that disagree with authoritative intervals or child identity", () => {
    const occupiedButAvailable = boardWithSplitBedLodging();
    occupiedButAvailable.rooms[0]!.bedSlotStates[0]!.status = "AVAILABLE";
    expect(() => assertRoomStatusBoard(occupiedButAvailable, expected))
      .toThrow(/唯一权威 interval 状态/);

    const wrongChildCode = boardWithSplitBedLodging();
    wrongChildCode.rooms[0]!.bedSlotStates[0]!.inventoryUnitCode = "V01-X";
    expect(() => assertRoomStatusBoard(wrongChildCode, expected))
      .toThrow(/权威子床代码/);

    const phantomSlotWithoutPhysicalCount = boardWithSplitBedLodging();
    phantomSlotWithoutPhysicalCount.rooms[0]!.physicalBedCount = null;
    phantomSlotWithoutPhysicalCount.rooms[0]!.bedSlotStates.push({
      serviceDate: "2028-01-01",
      inventoryUnitId: "bed_split_validation_phantom",
      inventoryUnitCode: "V01-X",
      status: "AVAILABLE"
    });
    expect(() => assertRoomStatusBoard(phantomSlotWithoutPhysicalCount, expected))
      .toThrow(/权威子床集合/);

    const partialPhantomSlot = boardWithSplitBedLodging();
    partialPhantomSlot.projectionState = "PARTIAL";
    partialPhantomSlot.rooms[0]!.physicalBedCount = null;
    partialPhantomSlot.rooms[0]!.bedSlotStates.push({
      serviceDate: "2028-01-01",
      inventoryUnitId: "bed_split_validation_phantom",
      inventoryUnitCode: "V01-X",
      status: "AVAILABLE"
    });
    expect(() => assertRoomStatusBoard(partialPhantomSlot, expected))
      .toThrow(/床位槽必须来自权威子床集合/);
  });

  it("rejects current or future completed states in PARTIAL bed-slot summaries", () => {
    const partialContradiction = boardWithSplitBedLodging();
    partialContradiction.projectionState = "PARTIAL";
    partialContradiction.rooms[0]!.bedSlotStates[0]!.status = "AVAILABLE";
    expect(() => assertRoomStatusBoard(partialContradiction, expected))
      .toThrow(/必须与当天唯一权威 interval 状态一致/);

    const partialFutureArrears = boardWithSplitBedLodging();
    partialFutureArrears.projectionState = "PARTIAL";
    partialFutureArrears.rooms[0]!.bedSlotStates[0]!.status = "ARREARS";
    expect(() => assertRoomStatusBoard(partialFutureArrears, expected))
      .toThrow(/已完成床位状态只能表示营业日前的住宿/);

    const partialFutureSettled = boardWithSplitBedLodging();
    partialFutureSettled.projectionState = "PARTIAL";
    partialFutureSettled.rooms[0]!.bedSlotStates[0]!.status = "SETTLED";
    expect(() => assertRoomStatusBoard(partialFutureSettled, expected))
      .toThrow(/已完成床位状态只能表示营业日前的住宿/);
  });

  it("allows financial and operational attention to coexist but rejects lifecycle mismatches", () => {
    const overdueReserved = validBoard();
    const task = orderExceptionTask("RESERVED");
    task.attention = "ARREARS";
    overdueReserved.operationalTasks = [task];
    expect(() => assertRoomStatusBoard(overdueReserved, expected)).not.toThrow();

    const missingOperational = validBoard() as unknown as { operationalTasks: Array<Record<string, unknown>> };
    missingOperational.operationalTasks = [orderExceptionTask("RESERVED") as unknown as Record<string, unknown>];
    delete missingOperational.operationalTasks[0]!.operationalAttention;
    expect(() => assertRoomStatusBoard(missingOperational, expected)).toThrow(/operationalAttention/);

    const omittedOverdueAttention = validBoard();
    omittedOverdueAttention.operationalTasks = [{
      ...orderExceptionTask("RESERVED"),
      operationalAttention: null
    }];
    expect(() => assertRoomStatusBoard(omittedOverdueAttention, expected))
      .toThrow(/逾期预订必须显式携带逾期运营关注事实/);

    const wrongLifecycle = validBoard();
    wrongLifecycle.operationalTasks = [{
      ...orderExceptionTask("RESERVED"),
      operationalAttention: "OVERDUE_IN_HOUSE"
    }];
    expect(() => assertRoomStatusBoard(wrongLifecycle, expected)).toThrow(/逾期未退只能附着于在住住宿/);

    const omittedOverdueInHouseAttention = validBoard();
    omittedOverdueInHouseAttention.operationalTasks = [{
      ...orderExceptionTask("IN_HOUSE"),
      operationalAttention: null
    }];
    expect(() => assertRoomStatusBoard(omittedOverdueInHouseAttention, expected))
      .toThrow(/逾期未退任务必须显式携带未退运营关注事实/);
  });

  it("rejects personal details embedded in a room-status occupant summary", () => {
    const board = validBoard();
    const task = orderExceptionTask("RESERVED");
    task.occupants = [{
      occupantId: "occupant_order_validation",
      nickname: "山风",
      fullName: "不应进入房态",
      phone: "13800000000"
    } as never];
    task.primaryOccupantLabel = "山风";
    board.operationalTasks = [task];

    expect(() => assertRoomStatusBoard(board, expected)).toThrow(/不允许的字段.*fullName.*phone/);
  });

  it("rejects lodging occupants above the actual whole-room or bed capacity", () => {
    const wholeRoom = boardWithWholeRoomLodging();
    const wholeRoomInterval = wholeRoom.rooms[0]!.intervals[0]!;
    wholeRoomInterval.occupantCount = 3;
    wholeRoomInterval.occupants = [
      { occupantId: "occupant_whole_1", nickname: "山风" },
      { occupantId: "occupant_whole_2", nickname: "小满" },
      { occupantId: "occupant_whole_3", nickname: "北辰" }
    ];
    wholeRoomInterval.primaryOccupantLabel = "山风";
    expect(() => assertRoomStatusBoard(wholeRoom, expected)).toThrow(/不能超过实际库存单元住宿容量 2/);

    const splitBed = boardWithSplitBedLodging();
    const childInterval = splitBed.rooms[0]!.children[0]!.intervals[0]!;
    childInterval.occupantCount = 2;
    childInterval.occupants = [
      { occupantId: "occupant_split_validation", nickname: "Validation nickname" },
      { occupantId: "occupant_split_extra", nickname: "Extra nickname" }
    ];
    expect(() => assertRoomStatusBoard(splitBed, expected)).toThrow(/不能超过实际库存单元住宿容量 1/);
  });

  it("rejects fail-open unknown, blocking, and mismatched row facts", () => {
    const unknownDay = validBoard();
    unknownDay.rooms[0]!.days[0] = {
      ...unknownDay.rooms[0]!.days[0]!,
      status: "UNKNOWN",
      available: true
    };
    expect(() => assertRoomStatusBoard(unknownDay, expected)).toThrow(/fail closed/);

    const blockingInterval = validBoard();
    blockingInterval.rooms[0]!.intervals.push({
      ...maintenanceInterval({ id: "interval_fail_open" }),
      available: true,
    });
    expect(() => assertRoomStatusBoard(blockingInterval, expected)).toThrow(/阻断区间和冲突事实/);

    const wrongRow = validBoard();
    const wrongRowInterval = maintenanceInterval({
      id: "interval_wrong_row",
      displayInventoryUnitId: "unit_other"
    });
    wrongRowInterval.conflicts = [{
      ...wrongRowInterval.conflicts[0]!,
      requestedInventoryUnitId: "unit_other"
    }];
    wrongRow.rooms[0]!.intervals.push({
      ...wrongRowInterval
    });
    expect(() => assertRoomStatusBoard(wrongRow, expected)).toThrow(/所属库存行/);
  });

  it("requires service-owned operational task boundaries", () => {
    const missingTasks = validBoard() as unknown as Record<string, unknown>;
    delete missingTasks.operationalTasks;
    expect(() => assertRoomStatusBoard(missingTasks, expected)).toThrow(/operationalTasks/);

    const invalidDeparture = validBoard();
    invalidDeparture.operationalTasks.push({
      taskKind: "DEPARTURE",
      businessDate: "2028-01-01",
      id: "task_departure_invalid",
      displayInventoryUnitId: "unit_validation",
      actualInventoryUnitId: "unit_validation",
      roomId: "unit_validation",
      startDate: "2027-12-31",
      endDate: "2028-01-02",
      sourceStartDate: "2027-12-31",
      sourceEndDate: "2028-01-02",
      status: "IN_HOUSE",
      attention: null,
      operationalAttention: null,
      available: true,
      blocking: false,
      sourceKind: "ORDER",
      sourceCategory: "DIRECT",
      freeStayCategoryCode: null,
      freeStayReason: null,
      label: "Order departure",
      primaryOccupantLabel: "Validation guest",
      occupantCount: 1,
      occupants: [{ occupantId: "occupant_departure_validation", nickname: "Validation guest" }],
      reason: null,
      claimIds: [],
      references: [
        { type: "ORDER", id: "order_validation", label: "Order", href: "/orders/order_validation" },
        { type: "STAY", id: "stay_validation", label: "Stay", href: null }
      ],
      conflicts: [],
      history: [],
      allowedActions: [{
        code: "OPEN_ORDER",
        enabled: true,
        disabledReason: null,
        requiresFullInterval: false,
        targetReference: { type: "ORDER", id: "order_validation", label: "Order", href: "/orders/order_validation" }
      }]
    });
    expect(() => assertRoomStatusBoard(invalidDeparture, expected)).toThrow(/离店任务/);
  });

  it("accepts Claim-backed arrival/in-house tasks and an explicit current departure-day blocker", () => {
    const board = validBoard();
    board.operationalTasks = [
      normalLodgingTask("ARRIVAL"),
      normalLodgingTask("IN_HOUSE"),
      normalLodgingTask("DEPARTURE")
    ];
    expect(() => assertRoomStatusBoard(board, expected)).not.toThrow();

    const missingOriginalDeparture = validBoard();
    const missingOriginalDepartureTask = normalLodgingTask("DEPARTURE") as unknown as Record<string, unknown>;
    delete missingOriginalDepartureTask.orderDepartureDate;
    missingOriginalDeparture.operationalTasks = [missingOriginalDepartureTask as unknown as RoomStatusOperationalTaskDto];
    expect(() => assertRoomStatusBoard(missingOriginalDeparture, expected)).toThrow(/同时提供或同时省略/);

    const wrongBusinessDate = validBoard();
    wrongBusinessDate.operationalTasks = [{
      ...normalLodgingTask("DEPARTURE"),
      orderDepartureDate: "2028-01-02"
    }];
    expect(() => assertRoomStatusBoard(wrongBusinessDate, expected)).toThrow(/退房日必须等于营业日/);

    const oldLodgingOrderBlocker = validBoard();
    const oldLodgingOrderTask = normalLodgingTask("DEPARTURE");
    oldLodgingOrderTask.conflicts[0] = {
      ...oldLodgingOrderTask.conflicts[0]!,
      blockingFactKind: "LODGING_ORDER"
    };
    oldLodgingOrderBlocker.operationalTasks = [oldLodgingOrderTask];
    expect(() => assertRoomStatusBoard(oldLodgingOrderBlocker, expected)).toThrow(/专用安全事实|离店任务/);

    const blockerWithoutAttention = validBoard();
    blockerWithoutAttention.operationalTasks = [{
      ...normalLodgingTask("DEPARTURE"),
      operationalAttention: null
    }];
    expect(() => assertRoomStatusBoard(blockerWithoutAttention, expected)).toThrow(/必须同时携带待退房运营关注事实/);

    const attentionWithoutBlocker = validBoard();
    const attentionWithoutBlockerTask = normalLodgingTask("DEPARTURE");
    attentionWithoutBlockerTask.conflicts = [];
    attentionWithoutBlockerTask.blocking = false;
    attentionWithoutBlockerTask.available = true;
    attentionWithoutBlocker.operationalTasks = [attentionWithoutBlockerTask];
    expect(() => assertRoomStatusBoard(attentionWithoutBlocker, expected)).toThrow(/专用安全事实/);

    const misclassified = validBoard();
    const inHouse = normalLodgingTask("IN_HOUSE");
    inHouse.conflicts[0] = { ...inHouse.conflicts[0]!, blockingFactKind: "OVERDUE_IN_HOUSE", claimId: null, claimIds: [] };
    inHouse.claimIds = [];
    inHouse.references = inHouse.references.filter((reference) => reference.type !== "CLAIM");
    misclassified.operationalTasks = [inHouse];
    expect(() => assertRoomStatusBoard(misclassified, expected)).toThrow(/真实 Claim|自动延长/);

    for (const taskKind of ["ARRIVAL", "IN_HOUSE"] as const) {
      const orderOnly = normalLodgingTask(taskKind);
      orderOnly.claimIds = [];
      orderOnly.references = orderOnly.references.filter((reference) => reference.type !== "CLAIM");
      orderOnly.conflicts[0] = {
        ...orderOnly.conflicts[0]!,
        blockingFactKind: "LODGING_ORDER",
        claimId: null,
        claimIds: []
      };
      const invalid = validBoard();
      invalid.operationalTasks = [orderOnly];
      expect(() => assertRoomStatusBoard(invalid, expected), taskKind).toThrow(/真实 Claim/);
    }
  });

  it("accepts fail-closed UNKNOWN and service-defined overdue order/free-stay exception tasks", () => {
    const validUnknown = validBoard();
    validUnknown.operationalTasks = [orderExceptionTask("UNKNOWN")];
    expect(() => assertRoomStatusBoard(validUnknown, expected)).not.toThrow();

    const unknownWithOccupant = orderExceptionTask("UNKNOWN");
    unknownWithOccupant.occupantCount = 1;
    unknownWithOccupant.occupants = [{ occupantId: "occupant_order_validation", nickname: "不应公开" }];
    const invalidUnknownOccupant = validBoard();
    invalidUnknownOccupant.operationalTasks = [unknownWithOccupant];
    expect(() => assertRoomStatusBoard(invalidUnknownOccupant, expected)).toThrow(/UNKNOWN 区间必须隐藏住宿人/);

    const unknownWithPrimaryLabel = orderExceptionTask("UNKNOWN");
    unknownWithPrimaryLabel.primaryOccupantLabel = "不应公开";
    const invalidUnknownLabel = validBoard();
    invalidUnknownLabel.operationalTasks = [unknownWithPrimaryLabel];
    expect(() => assertRoomStatusBoard(invalidUnknownLabel, expected)).toThrow(/UNKNOWN 区间不能公开主住宿人标签/);

    const displayableWithoutOccupant = orderExceptionTask("RESERVED");
    displayableWithoutOccupant.occupantCount = 0;
    displayableWithoutOccupant.occupants = [];
    const invalidDisplayableLodging = validBoard();
    invalidDisplayableLodging.operationalTasks = [displayableWithoutOccupant];
    expect(() => assertRoomStatusBoard(invalidDisplayableLodging, expected)).toThrow(/可展示住宿来源必须包含至少一位住宿人/);

    const missingClaim = orderExceptionTask("UNKNOWN");
    missingClaim.claimIds = [];
    missingClaim.references = missingClaim.references.filter((reference) => reference.type !== "CLAIM");
    missingClaim.conflicts[0] = {
      ...missingClaim.conflicts[0]!,
      blockingFactKind: "LODGING_ORDER",
      claimId: null,
      claimIds: []
    };
    const validMissingClaim = validBoard();
    validMissingClaim.operationalTasks = [missingClaim];
    expect(() => assertRoomStatusBoard(validMissingClaim, expected)).not.toThrow();

    const overdueArrival = validBoard();
    overdueArrival.operationalTasks = [orderExceptionTask("RESERVED")];
    expect(() => assertRoomStatusBoard(overdueArrival, expected)).not.toThrow();

    const historicalNoArrival = orderExceptionTask("RESERVED");
    historicalNoArrival.endDate = "2028-01-01";
    historicalNoArrival.sourceEndDate = "2028-01-01";
    historicalNoArrival.available = true;
    historicalNoArrival.blocking = false;
    historicalNoArrival.claimIds = [];
    historicalNoArrival.references = historicalNoArrival.references.filter((reference) => reference.type !== "CLAIM");
    historicalNoArrival.conflicts = [];
    const validHistoricalNoArrival = validBoard();
    validHistoricalNoArrival.operationalTasks = [historicalNoArrival];
    expect(() => assertRoomStatusBoard(validHistoricalNoArrival, expected)).not.toThrow();

    const failOpenOverdueArrival = orderExceptionTask("RESERVED");
    failOpenOverdueArrival.available = true;
    failOpenOverdueArrival.blocking = false;
    failOpenOverdueArrival.claimIds = [];
    failOpenOverdueArrival.references = failOpenOverdueArrival.references.filter((reference) => reference.type !== "CLAIM");
    failOpenOverdueArrival.conflicts = [];
    const invalidFailOpenOverdueArrival = validBoard();
    invalidFailOpenOverdueArrival.operationalTasks = [failOpenOverdueArrival];
    expect(() => assertRoomStatusBoard(invalidFailOpenOverdueArrival, expected)).toThrow(/真实 Claim/);

    const orderOnlyOverdueArrival = orderExceptionTask("RESERVED");
    orderOnlyOverdueArrival.claimIds = [];
    orderOnlyOverdueArrival.references = orderOnlyOverdueArrival.references.filter((reference) => reference.type !== "CLAIM");
    orderOnlyOverdueArrival.conflicts[0] = {
      ...orderOnlyOverdueArrival.conflicts[0]!,
      blockingFactKind: "LODGING_ORDER",
      claimId: null,
      claimIds: []
    };
    const invalidOrderOnlyOverdueArrival = validBoard();
    invalidOrderOnlyOverdueArrival.operationalTasks = [orderOnlyOverdueArrival];
    expect(() => assertRoomStatusBoard(invalidOrderOnlyOverdueArrival, expected)).toThrow(/真实 Claim/);

    const overdueDeparture = validBoard();
    overdueDeparture.operationalTasks = [orderExceptionTask("IN_HOUSE")];
    expect(() => assertRoomStatusBoard(overdueDeparture, expected)).not.toThrow();

    const notOverdueArrival = validBoard();
    notOverdueArrival.operationalTasks = [{
      ...orderExceptionTask("RESERVED"),
      startDate: "2028-01-01",
      sourceStartDate: "2028-01-01",
      conflicts: [{
        ...orderExceptionTask("RESERVED").conflicts[0]!,
        startDate: "2028-01-01"
      }]
    }];
    expect(() => assertRoomStatusBoard(notOverdueArrival, expected)).toThrow(/逾期未到异常/);

    const oldBlockingOverdueDeparture = validBoard();
    oldBlockingOverdueDeparture.operationalTasks = [{
      ...orderExceptionTask("IN_HOUSE"),
      blocking: true,
      available: false,
      conflicts: [{
        id: "conflict_old_overdue_departure",
        blockingFactKind: "OVERDUE_IN_HOUSE",
        claimId: null,
        claimIds: [],
        requestedInventoryUnitId: "unit_validation",
        actualInventoryUnitId: "unit_validation",
        roomId: "unit_validation",
        startDate: "2028-01-01",
        endDate: "2028-01-02",
        sourceKind: "ORDER",
        sourceReference: { type: "ORDER", id: "order_validation", label: "Order", href: "/orders/order_validation" },
        reason: "Old synthetic occupancy",
        blocking: true
      }]
    }];
    expect(() => assertRoomStatusBoard(oldBlockingOverdueDeparture, expected)).toThrow(/逾期未退异常|自动延长/);

    const missingOverdueReason = validBoard();
    missingOverdueReason.operationalTasks = [{
      ...orderExceptionTask("IN_HOUSE"),
      reason: null
    }];
    expect(() => assertRoomStatusBoard(missingOverdueReason, expected)).toThrow(/逾期未退异常/);

    const notHistoricalOverdueDeparture = validBoard();
    notHistoricalOverdueDeparture.operationalTasks = [{
      ...orderExceptionTask("IN_HOUSE"),
      endDate: "2028-01-01",
      sourceEndDate: "2028-01-01"
    }];
    expect(() => assertRoomStatusBoard(notHistoricalOverdueDeparture, expected)).toThrow(/逾期未退/);

    const missingTaskConflict = validBoard();
    missingTaskConflict.operationalTasks = [orderExceptionTask("UNKNOWN")];
    missingTaskConflict.operationalTasks[0]!.conflicts = [];
    expect(() => assertRoomStatusBoard(missingTaskConflict, expected)).toThrow(/一个精确冲突事实/);
  });

  it("requires visible intervals to be contained by complete source boundaries", () => {
    const outsideSource = boardWithMaintenance();
    outsideSource.rooms[0]!.intervals[0]!.sourceStartDate = "2028-01-02";
    expect(() => assertRoomStatusBoard(outsideSource, expected)).toThrow(/来源完整半开区间/);

    const clippedRelease = boardWithMaintenance();
    const interval = clippedRelease.rooms[0]!.intervals[0]!;
    interval.sourceStartDate = "2027-12-31";
    interval.sourceEndDate = "2028-01-03";
    expect(() => assertRoomStatusBoard(clippedRelease, expected)).not.toThrow();

    const disabledRelease = boardWithMaintenance();
    const disabledInterval = disabledRelease.rooms[0]!.intervals[0]!;
    disabledInterval.sourceStartDate = "2027-12-31";
    disabledInterval.sourceEndDate = "2028-01-03";
    disabledInterval.allowedActions[0] = {
      ...disabledInterval.allowedActions[0]!,
      enabled: false,
      disabledReason: "当前窗口只包含来源完整区间的一部分"
    };
    disabledRelease.rooms[0]!.allowedActions = disabledInterval.allowedActions;
    expect(() => assertRoomStatusBoard(disabledRelease, expected)).not.toThrow();
  });

  it("rejects day facts that diverge from their covering blocking intervals", () => {
    const missingInterval = boardWithMaintenance();
    missingInterval.rooms[0]!.days[0]!.intervalIds = [];
    expect(() => assertRoomStatusBoard(missingInterval, expected)).toThrow(/覆盖该营业日的全部区间/);

    const failOpenAvailability = boardWithMaintenance();
    failOpenAvailability.rooms[0]!.days[0]!.available = true;
    expect(() => assertRoomStatusBoard(failOpenAvailability, expected)).toThrow(/blocking\/UNKNOWN/);

    const mismatchedConflict = boardWithMaintenance();
    mismatchedConflict.rooms[0]!.days[0]!.conflicts[0] = {
      ...mismatchedConflict.rooms[0]!.days[0]!.conflicts[0]!,
      claimId: "claim_other",
      claimIds: ["claim_other"]
    };
    expect(() => assertRoomStatusBoard(mismatchedConflict, expected)).toThrow(/单一 Claim/);
  });

  it("binds every action and href to a trusted typed source reference", () => {
    const wrongTarget = validBoard();
    wrongTarget.rooms[0]!.allowedActions[0]!.targetReference = {
      type: "ORDER",
      id: "order_validation",
      label: "Order",
      href: "/orders/order_validation"
    };
    expect(() => assertRoomStatusBoard(wrongTarget, expected)).toThrow(/目标类型不一致/);

    const unsafeHref = validBoard();
    unsafeHref.rooms[0]!.allowedActions[0]!.targetReference!.href = "javascript:alert(1)";
    expect(() => assertRoomStatusBoard(unsafeHref, expected)).toThrow(/可信内部路径/);

    const unrelatedBlock = boardWithMaintenance();
    unrelatedBlock.rooms[0]!.intervals[0]!.allowedActions[0]!.targetReference = {
      type: "BLOCK",
      id: "block_other",
      label: "Other block",
      href: null
    };
    expect(() => assertRoomStatusBoard(unrelatedBlock, expected)).toThrow(/不属于该区间/);
  });

  it("rejects a non-contiguous date axis and inconsistent pagination", () => {
    const wrongDates = validBoard();
    wrongDates.dates = ["2028-01-02"];
    wrongDates.rooms[0]!.days[0]!.serviceDate = "2028-01-02";
    expect(() => assertRoomStatusBoard(wrongDates, expected)).toThrow(/dates/);

    const wrongPage = validBoard();
    wrongPage.page.totalPages = 2;
    expect(() => assertRoomStatusBoard(wrongPage, expected)).toThrow(/page.totalPages/);
  });
});
