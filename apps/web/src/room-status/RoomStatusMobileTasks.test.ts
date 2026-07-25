import { describe, expect, it } from "vitest";
import type { RoomStatusBoardDto, RoomStatusOperationalTaskDto } from "@qintopia/contracts";
import { executableTaskAction, mobileBedOccupancySummaries, mobileLodgingOccupantSummary, mobileWholeRoomOccupancySummaries, nextMobileTaskFocusId } from "./RoomStatusMobileTasks";

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
    available: false,
    blocking: true,
    sourceKind: "MAINTENANCE",
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
  it("lists every same-day bed nickname without deduplicating or folding", () => {
    const board = {
      businessDate: "2026-07-20",
      rooms: [{
        id: "room_four_bed",
        days: [{ serviceDate: "2026-07-20", status: "RESERVED" }],
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
      occupantLabels: ["山风", "同名住客", "同名住客", "历史未记录"]
    })]);
  });

  it("keeps the split-bed parent non-interactive while exposing each stable child-bed order", () => {
    const board = {
      businessDate: "2026-07-20",
      rooms: [{
        id: "room_four_bed",
        code: "101",
        days: [{ serviceDate: "2026-07-21", status: "RESERVED" }],
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
          days: [{ serviceDate: "2026-07-21", status: "RESERVED" }],
          intervals: [{
            id: "interval_a",
            actualInventoryUnitId: "bed_a",
            startDate: "2026-07-20",
            endDate: "2026-07-23",
            status: "RESERVED",
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
    expect(summaries[0]).toMatchObject({ kind: "BED_SPLIT", ratio: "1/4", orderIdentity: null });
    expect(summaries[1]).toMatchObject({
      kind: "BED_ORDER",
      ratio: "1人",
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
      expect.objectContaining({ serviceDate: "2026-07-20", ratio: "2人", occupantLabels: ["山风", "小满"], orderIdentity: expect.objectContaining({ orderId: "order_whole_room", stayId: "stay_whole_room" }) }),
      expect.objectContaining({ serviceDate: "2026-07-21", ratio: "2人", occupantLabels: ["山风", "小满"], orderIdentity: expect.objectContaining({ orderId: "order_whole_room", stayId: "stay_whole_room" }) })
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
});
