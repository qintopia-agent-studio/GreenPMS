import { describe, expect, it } from "vitest";
import type { RoomStatusActionDto } from "@qintopia/contracts";
import {
  roomStatusQuickActionVisible,
  roomStatusQuickActionDisabledReason,
  roomStatusQuickActionCanRun,
  runRoomStatusQuickAction,
  runRoomStatusWriteBlockAction,
  roomStatusPopoverMeasuredHeight,
  roomStatusPopoverPosition,
  roomStatusPopoverViewportEventShouldClose,
  roomStatusQuickOrderHeaderMarks,
  roomStatusQuickOrderSourceSummary
} from "./RoomStatusQuickPopover";
import type { RoomStatusOrderOption } from "./roomStatusState";

function orderOption(source: RoomStatusOrderOption["source"]): RoomStatusOrderOption {
  return {
    identity: {
      orderId: "order_1",
      stayId: "stay_1",
      intervalId: "interval_1",
      unitId: "unit_1",
      intervalStartDate: "2026-09-01",
      intervalEndDate: "2026-09-02",
      arrivalDate: "2026-09-01",
      departureDate: "2026-09-02"
    },
    label: "朝露",
    source
  };
}

describe("roomStatusPopoverMeasuredHeight", () => {
  it("includes borders without mistaking a clipped box for intrinsic content height", () => {
    expect(roomStatusPopoverMeasuredHeight(
      { scrollHeight: 300, clientHeight: 272 },
      { height: 274 }
    )).toBe(302);
  });
});

describe("roomStatusPopoverPosition", () => {
  it("places the popover below the selected room row when space remains", () => {
    expect(roomStatusPopoverPosition(
      { left: 100, right: 194, top: 80, bottom: 130 },
      { width: 1280, height: 720 },
      { width: 280, height: 220 },
      { top: 60, bottom: 142 }
    )).toEqual({ left: 100, top: 150, maxHeight: 562 });
  });

  it("places the popover above the row and right-aligns near the viewport edge", () => {
    expect(roomStatusPopoverPosition(
      { left: 1100, right: 1194, top: 650, bottom: 700 },
      { width: 1280, height: 720 },
      { width: 280, height: 220 },
      { top: 620, bottom: 708 }
    )).toEqual({ left: 914, top: 392, maxHeight: 604 });
  });

  it("keeps a narrow viewport margin when neither side fits", () => {
    const position = roomStatusPopoverPosition(
      { left: 80, right: 174, top: 20, bottom: 70 },
      { width: 340, height: 400 },
      { width: 324, height: 300 },
      { top: 12, bottom: 70 }
    );
    expect(position.left).toBe(8);
    expect(position.top).toBe(78);
    expect(position.maxHeight).toBe(314);
  });

  it("uses the larger side and constrains height when neither side can fit", () => {
    expect(roomStatusPopoverPosition(
      { left: 100, right: 194, top: 190, bottom: 230 },
      { width: 800, height: 400 },
      { width: 280, height: 300 },
      { top: 180, bottom: 240 }
    )).toEqual({ left: 100, top: 8, maxHeight: 164 });
  });

  it("moves intrinsic content above the row when only the larger upper space fits", () => {
    expect(roomStatusPopoverPosition(
      { left: 100, right: 194, top: 342, bottom: 392 },
      { width: 800, height: 720 },
      { width: 280, height: 300 },
      { top: 350, bottom: 430 }
    )).toEqual({ left: 100, top: 42, maxHeight: 334 });
  });
});

describe("roomStatusPopoverViewportEventShouldClose", () => {
  it("keeps the popover tethered while its anchor remains visible", () => {
    expect(roomStatusPopoverViewportEventShouldClose("scroll", true, false)).toBe(false);
    expect(roomStatusPopoverViewportEventShouldClose("scroll", false, true)).toBe(false);
    expect(roomStatusPopoverViewportEventShouldClose("scroll", false, false)).toBe(true);
    expect(roomStatusPopoverViewportEventShouldClose("resize", true, true)).toBe(true);
  });
});

describe("roomStatusQuickActionVisible", () => {
  it("replaces only creation actions with backfill for historical and cross-today selections", () => {
    const action = (code: Parameters<typeof roomStatusQuickActionVisible>[0]["code"]) => ({ code, enabled: true });

    expect(roomStatusQuickActionVisible(action("BACKFILL_ORDER"), "2026-08-12", "2026-08-13")).toBe(true);
    expect(roomStatusQuickActionVisible(action("CREATE_ORDER"), "2026-08-12", "2026-08-13")).toBe(false);
    expect(roomStatusQuickActionVisible(action("CREATE_FREE_STAY"), "2026-08-12", "2026-08-13")).toBe(false);
    expect(roomStatusQuickActionVisible(action("LOCK_MAINTENANCE"), "2026-08-12", "2026-08-13")).toBe(true);
    expect(roomStatusQuickActionVisible(action("RELEASE_MAINTENANCE"), "2026-08-12", "2026-08-13")).toBe(true);
    expect(roomStatusQuickActionVisible(action("OPEN_ORDER"), "2026-08-12", "2026-08-13")).toBe(true);

    expect(roomStatusQuickActionVisible(action("BACKFILL_ORDER"), "2026-08-13", "2026-08-13")).toBe(false);
    expect(roomStatusQuickActionVisible(action("CREATE_ORDER"), "2026-08-13", "2026-08-13")).toBe(true);
    expect(roomStatusQuickActionVisible({ code: "CREATE_ORDER", enabled: false }, "2026-08-13", "2026-08-13")).toBe(true);
    expect(roomStatusQuickActionVisible({ code: "BACKFILL_ORDER", enabled: false }, "2026-08-12", "2026-08-13")).toBe(true);
  });

  it("never treats a disabled server action as runnable", () => {
    expect(roomStatusQuickActionCanRun({ enabled: true })).toBe(true);
    expect(roomStatusQuickActionCanRun({ enabled: false })).toBe(false);
  });

  it("does not dispatch a disabled server action to the write callback", () => {
    const calls: RoomStatusActionDto[] = [];
    const action = { code: "BACKFILL_ORDER", enabled: false, disabledReason: "正在恢复", requiresFullInterval: false, targetReference: null } satisfies RoomStatusActionDto;
    expect(runRoomStatusQuickAction(action, (received) => calls.push(received))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("shows a global write gate once instead of repeating it below every action", () => {
    const action = {
      code: "CREATE_ORDER",
      enabled: false,
      disabledReason: "正在更新房态，更新完成前暂不能写入。"
    } as const;
    const writeBlock = { kind: "REFRESH" as const, reason: action.disabledReason };

    expect(roomStatusQuickActionDisabledReason(action, writeBlock)).toBeUndefined();
    expect(roomStatusQuickActionDisabledReason(
      { ...action, disabledReason: "该日期已经被占用" },
      writeBlock
    )).toBe("该日期已经被占用");
  });

  it("routes refresh and recovery buttons only to their matching callback", () => {
    let refreshed = 0;
    let recovered = 0;
    expect(runRoomStatusWriteBlockAction({ kind: "REFRESH" }, {
      onRefresh: () => { refreshed += 1; },
      onOpenRecovery: () => { recovered += 1; }
    })).toBe(true);
    expect(runRoomStatusWriteBlockAction({ kind: "RECOVERY" }, {
      onRefresh: () => { refreshed += 1; },
      onOpenRecovery: () => { recovered += 1; }
    })).toBe(true);
    expect(runRoomStatusWriteBlockAction({ kind: "PERMISSION" }, {
      onRefresh: () => { refreshed += 1; },
      onOpenRecovery: () => { recovered += 1; }
    })).toBe(false);
    expect({ refreshed, recovered }).toEqual({ refreshed: 1, recovered: 1 });
  });
});

describe("RoomStatus quick order source presentation", () => {
  it("shows free and category marks only for one free order, with its actual recorded reason", () => {
    const free = orderOption({
      sourceKind: "FREE_STAY",
      sourceCategory: "FREE_STAY",
      freeStayCategoryCode: "VOLUNTEER",
      freeStayReason: "协助前台接待"
    });
    expect(roomStatusQuickOrderHeaderMarks([free])).toEqual([
      { label: "免费", title: "免费入住" },
      { label: "义工", title: "义工；免费入住原因：协助前台接待" }
    ]);
  });

  it("does not guess the type of a legacy free stay and does not put source facts in a multi-order header", () => {
    const legacyFree = orderOption({
      sourceKind: "FREE_STAY",
      sourceCategory: null,
      freeStayCategoryCode: null,
      freeStayReason: null
    });
    const direct = orderOption({
      sourceKind: "ORDER",
      sourceCategory: "DIRECT",
      freeStayCategoryCode: null,
      freeStayReason: null
    });
    expect(roomStatusQuickOrderHeaderMarks([legacyFree])).toEqual([
      { label: "免费", title: "免费入住" },
      { label: "历史未记录", title: "免费入住类型与原因：历史未记录" }
    ]);
    expect(roomStatusQuickOrderHeaderMarks([legacyFree, direct])).toEqual([]);
    expect(roomStatusQuickOrderSourceSummary(legacyFree)).toBe("免费入住 · 历史未记录");
    expect(roomStatusQuickOrderSourceSummary(orderOption({
      sourceKind: "ORDER",
      sourceCategory: "CTRIP",
      freeStayCategoryCode: null,
      freeStayReason: null
    }))).toBe("携程");
  });
});
