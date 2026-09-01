import { describe, expect, it } from "vitest";
import type { RoomStatusBoardDto, RoomStatusOperationalTaskDto } from "@qintopia/contracts";
import {
  executableTaskAction,
  focusReplacementMobileTaskTrigger,
  mobileBedOccupancySummaries,
  mobileLodgingOccupantSummary,
  roomStatusMobileLifecycleLabel,
  mobileTaskDetailWasRemoved,
  mobileWholeRoomOccupancySummaries,
  nextMobileTaskFocusId
} from "./RoomStatusMobileTasks";

function maintenanceTask(overrides: Partial<RoomStatusOperationalTaskDto> = {}): RoomStatusOperationalTaskDto {
  return {
    taskKind: "EXCEPTION",
    businessDate: "2026-07-20",
    id: "task_maintenance_today",
    displayInventoryUnitId: "unit_outside_current_page",
    actualInventoryUnitId: "unit_outside_current_page",
    roomId: "unit_room_outside_current_page",
    startDate: "2026-07-20",
    endDate: "2026-07-21",
    sourceStartDate: "2026-07-19",
    sourceEndDate: "2026-07-23",
    status: "MAINTENANCE",
    attention: null,
    operationalAttention: null,
    available: false,
    blocking: true,
    sourceKind: "MAINTENANCE",
    sourceCategory: null,
    freeStayCategoryCode: null,
    freeStayReason: null,
    label: "维修锁房",
    primaryOccupantLabel: null,
    occupantCount: 0,
    occupants: [],
    reason: "跨页运营任务",
    claimIds: ["claim_maintenance_today"],
    references: [{ type: "BLOCK", id: "maintenance_today", label: "维修锁房", href: null }],
    conflicts: [],
    history: [],
    allowedActions: [{
      code: "RELEASE_MAINTENANCE",
      enabled: true,
      disabledReason: null,
      requiresFullInterval: true,
      targetReference: { type: "BLOCK", id: "maintenance_today", label: "维修锁房", href: null }
    }],
    ...overrides
  };
}

describe("RoomStatus mobile task actions", () => {
  it("keeps completed lodging as the lifecycle and debt as a separate attention fact", () => {
    expect(roomStatusMobileLifecycleLabel("ARREARS")).toBe("已结单");
    expect(roomStatusMobileLifecycleLabel("SETTLED")).toBe("已结单");
    expect(roomStatusMobileLifecycleLabel("RESERVED")).toBe("已预订");
  });

  it("lists every same-day bed nickname without deduplicating or folding", () => {
    const board = {
      businessDate: "2026-07-20",
      rooms: [{
        id: "room_four_bed",
        physicalBedCount: 4,
        days: [{ serviceDate: "2026-07-20", status: "RESERVED" }],
        intervals: [{
          startDate: "2026-07-20",
          endDate: "2026-07-21",
          status: "RESERVED",
          attention: "ARREARS",
          operationalAttention: "OVERDUE_RESERVED"
        }],
        bedOccupancies: [{
          serviceDate: "2026-07-20",
          occupiedBedCount: 4,
          totalBedCount: 4,
          occupants: [
            { primaryOccupantLabel: "山风" },
            { primaryOccupantLabel: "同名住客" },
            { primaryOccupantLabel: "同名住客" },
            { primaryOccupantLabel: null }
          ]
        }]
      }]
    } as unknown as RoomStatusBoardDto;

    expect(mobileBedOccupancySummaries(board)).toEqual([expect.objectContaining({
      ratio: "4/4",
      status: "RESERVED",
      attentionLabels: ["欠款", "逾期"],
      occupantLabels: ["山风", "同名住客", "同名住客", "历史未记录"]
    })]);
  });

  it("keeps the split-bed parent non-interactive while exposing each stable child-bed order", () => {
    const board = {
      businessDate: "2026-07-20",
      rooms: [{
        id: "room_four_bed",
        code: "101",
        physicalBedCount: 4,
        days: [{ serviceDate: "2026-07-21", status: "RESERVED" }],
        intervals: [],
        bedOccupancies: [{
          serviceDate: "2026-07-21",
          occupiedBedCount: 1,
          totalBedCount: 4,
          occupants: [{
            occupantId: "occupant_a",
            inventoryUnitId: "bed_a",
            inventoryUnitCode: "101A",
            primaryOccupantLabel: "山峰",
            sourceReference: { type: "ORDER", id: "order_a", label: "订单", href: "/orders/order_a" }
          }]
        }],
        children: [{
          id: "bed_a",
          code: "101A",
          physicalBedCount: 1,
          days: [{ serviceDate: "2026-07-21", status: "RESERVED" }],
          intervals: [{
            id: "interval_a",
            actualInventoryUnitId: "bed_a",
            startDate: "2026-07-20",
            endDate: "2026-07-23",
            status: "RESERVED",
            attention: "ARREARS",
            operationalAttention: null,
            sourceKind: "ORDER",
            references: [
              { type: "ORDER", id: "order_a", label: "订单", href: "/orders/order_a" },
              { type: "STAY", id: "stay_a", label: "住宿", href: null }
            ]
          }]
        }]
      }]
    } as unknown as RoomStatusBoardDto;

    const summaries = mobileBedOccupancySummaries(board);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ kind: "BED_SPLIT", ratio: "1/4", attentionLabels: [], orderIdentity: null });
    expect(summaries[1]).toMatchObject({
      kind: "BED_ORDER",
      ratio: null,
      attentionLabels: ["欠款"],
      occupantLabels: ["山峰"],
      orderIdentity: { orderId: "order_a", stayId: "stay_a", unitId: "bed_a" }
    });
  });

  it("summarizes a whole-room task with nicknames and count but no personal details", () => {
    const task = maintenanceTask({
      sourceKind: "ORDER",
      occupantCount: 2,
      primaryOccupantLabel: "山风",
      occupants: [{
        occupantId: "occupant_1",
        nickname: "山风",
        fullName: "隐私姓名",
        phone: "13800000000"
      }, {
        occupantId: "occupant_2",
        nickname: "小满",
        documentNumber: "PRIVATE-DOC"
      }] as never
    });

    const summary = mobileLodgingOccupantSummary(task);
    expect(summary).toBe("山风、小满 · 2人");
    expect(summary).not.toMatch(/隐私姓名|13800000000|PRIVATE-DOC/);
  });

  it("lists whole-room occupants for every covered date in the mobile range, including non-business dates", () => {
    const board = {
      businessDate: "2026-07-20",
      dates: ["2026-07-20", "2026-07-21", "2026-07-22"],
      rooms: [{
        id: "room_double",
        code: "201",
        physicalBedCount: 2,
        days: [
          { serviceDate: "2026-07-20", status: "RESERVED" },
          { serviceDate: "2026-07-21", status: "RESERVED" },
          { serviceDate: "2026-07-22", status: "AVAILABLE" }
        ],
        bedOccupancies: [],
        intervals: [{
          id: "interval_whole_room",
          actualInventoryUnitId: "room_double",
          startDate: "2026-07-20",
          endDate: "2026-07-22",
          status: "RESERVED",
          attention: "ARREARS",
          operationalAttention: null,
          sourceKind: "ORDER",
          occupantCount: 2,
          references: [
            { type: "ORDER", id: "order_whole_room", label: "订单", href: "/orders/order_whole_room" },
            { type: "STAY", id: "stay_whole_room", label: "住宿", href: null }
          ],
          occupants: [
            { occupantId: "occupant_1", nickname: "山风" },
            { occupantId: "occupant_2", nickname: "小满" }
          ]
        }]
      }]
    } as unknown as RoomStatusBoardDto;

    expect(mobileWholeRoomOccupancySummaries(board)).toEqual([
      expect.objectContaining({ serviceDate: "2026-07-20", ratio: "2/2", attentionLabels: ["欠款"], occupantLabels: ["山风", "小满"], orderIdentity: expect.objectContaining({ orderId: "order_whole_room", stayId: "stay_whole_room" }) }),
      expect.objectContaining({ serviceDate: "2026-07-21", ratio: "2/2", attentionLabels: ["欠款"], occupantLabels: ["山风", "小满"], orderIdentity: expect.objectContaining({ orderId: "order_whole_room", stayId: "stay_whole_room" }) })
    ]);
  });

  it("uses actual guests over physical beds for a whole-room large-bed order", () => {
    const board = {
      businessDate: "2026-07-20",
      dates: ["2026-07-20"],
      rooms: [{
        id: "room_large_bed",
        physicalBedCount: 1,
        days: [{ serviceDate: "2026-07-20", status: "RESERVED" }],
        intervals: [{
          id: "interval_large_bed",
          actualInventoryUnitId: "room_large_bed",
          startDate: "2026-07-20",
          endDate: "2026-07-21",
          status: "RESERVED",
          sourceKind: "ORDER",
          occupantCount: 2,
          references: [
            { type: "ORDER", id: "order_large_bed", label: "订单", href: "/orders/order_large_bed" },
            { type: "STAY", id: "stay_large_bed", label: "住宿", href: null }
          ],
          occupants: [
            { occupantId: "occupant_1", nickname: "山风" },
            { occupantId: "occupant_2", nickname: "小满" }
          ]
        }]
      }]
    } as unknown as RoomStatusBoardDto;

    expect(mobileWholeRoomOccupancySummaries(board)).toEqual([
      expect.objectContaining({ kind: "WHOLE_ROOM", ratio: "2/1", occupantLabels: ["山风", "小满"] })
    ]);
  });

  it("does not invent an occupant or count for fail-closed UNKNOWN lodging", () => {
    expect(mobileLodgingOccupantSummary(maintenanceTask({
      sourceKind: "ORDER",
      status: "UNKNOWN",
      label: "订单异常",
      occupantCount: 0,
      occupants: [],
      primaryOccupantLabel: null
    }))).toBe("状态未知");
  });

  it("keeps a complete server-authorized Block release executable outside the matrix page", () => {
    expect(executableTaskAction(maintenanceTask(), null)?.code).toBe("RELEASE_MAINTENANCE");
  });

  it("fails closed for disabled, mistyped, or incomplete release facts", () => {
    const base = maintenanceTask();
    expect(executableTaskAction({
      ...base,
      allowedActions: [{ ...base.allowedActions[0]!, enabled: false, disabledReason: "服务端已禁用" }]
    }, null)).toBeUndefined();
    expect(executableTaskAction({ ...base, sourceKind: "CLEANING" }, null)).toBeUndefined();
    expect(executableTaskAction({
      ...base,
      allowedActions: [{
        ...base.allowedActions[0]!,
        targetReference: { type: "ORDER", id: "order_wrong_target", label: "错误目标", href: "/orders/order_wrong_target" }
      }]
    }, null)).toBeUndefined();
    expect(executableTaskAction({ ...base, sourceEndDate: base.sourceStartDate }, null)).toBeUndefined();
  });

  it("returns the next surviving task at the completed task position, then falls back to the tab", () => {
    const first = maintenanceTask({ id: "task_first" });
    const completed = maintenanceTask({ id: "task_completed" });
    const next = maintenanceTask({ id: "task_next" });
    expect(nextMobileTaskFocusId([first, completed, next], completed.id, 1)).toBe(next.id);
    expect(nextMobileTaskFocusId([completed], completed.id, 0)).toBeNull();
  });

  it("restores detail focus to the current same-task trigger after a background refresh replaces its DOM node", () => {
    const calls: unknown[] = [];
    const replacedTrigger = {
      isConnected: false,
      focus: (options: unknown) => calls.push(["replaced", options])
    } as unknown as HTMLButtonElement;
    const replacementTrigger = {
      isConnected: true,
      focus: (options: unknown) => calls.push(["replacement", options])
    } as unknown as HTMLButtonElement;
    const fallback = {
      isConnected: true,
      focus: (options: unknown) => calls.push(["fallback", options])
    } as unknown as HTMLButtonElement;

    const taskRefs = new Map<string, HTMLButtonElement>([["task_maintenance_today", replacementTrigger]]);
    expect(replacedTrigger).not.toBe(replacementTrigger);
    expect(focusReplacementMobileTaskTrigger("task_maintenance_today", taskRefs, fallback)).toBe(true);
    expect(calls).toEqual([["replacement", { preventScroll: true }]]);
  });

  it("falls back to the active tab when the task no longer exists after refresh", () => {
    const calls: unknown[] = [];
    const fallback = {
      isConnected: true,
      focus: (options: unknown) => calls.push(options)
    } as unknown as HTMLButtonElement;

    expect(focusReplacementMobileTaskTrigger("task_removed", new Map(), fallback)).toBe(false);
    expect(calls).toEqual([{ preventScroll: true }]);
  });

  it("closes only a detail whose task disappeared from the refreshed projection", () => {
    const tasks = new Map<string, RoomStatusOperationalTaskDto>([["task_current", maintenanceTask({ id: "task_current" })]]);
    expect(mobileTaskDetailWasRemoved(null, tasks)).toBe(false);
    expect(mobileTaskDetailWasRemoved("task_current", tasks)).toBe(false);
    expect(mobileTaskDetailWasRemoved("task_removed", tasks)).toBe(true);
  });
});
