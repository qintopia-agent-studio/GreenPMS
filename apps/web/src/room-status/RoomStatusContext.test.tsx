import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoomStatusActionDto, RoomStatusBoardDto, RoomStatusIntervalDto, RoomStatusUnitDto } from "@qintopia/contracts";
import { RoomStatusContext, roomStatusDraftSelection } from "./RoomStatusContext";

const unit = {
  id: "unit_room_104_bed_c",
  kind: "BED",
  code: "104-C",
  name: "104-C",
  buildingCode: "1",
  roomTypeCode: "DORM",
  salesMode: "BED_SPLIT",
  occupancyCapacity: 1,
  children: [],
  days: [],
  intervals: []
} as unknown as RoomStatusUnitDto;

const board = {
  rooms: [unit],
  range: { arrivalDate: "2026-08-01", departureDate: "2026-08-31" }
} as unknown as RoomStatusBoardDto;

const backfillAction = {
  code: "BACKFILL_ORDER",
  enabled: false,
  disabledReason: "上一笔操作结果尚未收口。请先查询原操作结果；处理完成前不能发起新的补录。",
  requiresFullInterval: false,
  targetReference: null
} satisfies RoomStatusActionDto;

function renderContext(
  allowedActions: readonly RoomStatusActionDto[],
  writeBlock?: { kind: "REFRESH" | "RECOVERY" | "PERMISSION"; reason: string; actionLabel?: string },
  selectedInterval: RoomStatusIntervalDto | null = null
): string {
  return renderToStaticMarkup(<RoomStatusContext
    board={board}
    selectedUnit={unit}
    selectedDay={null}
    selectedInterval={selectedInterval}
    relatedIntervals={[]}
    selection={null}
    conflicts={[]}
    allowedActions={allowedActions}
    {...(writeBlock ? { writeBlock } : {})}
    onSelectedUnitChange={() => undefined}
    onSelectionChange={() => undefined}
    onDraftValidityChange={() => undefined}
    onOpenReference={() => undefined}
    onOpenReceipt={() => undefined}
    onAction={() => undefined}
    onRefresh={() => undefined}
    onOpenRecovery={() => undefined}
  />);
}

describe("RoomStatusContext write action presentation", () => {
  it("shows the same lifecycle mark and attention badges used by the grid", () => {
    const interval = {
      id: "interval_overdue_debt",
      status: "RESERVED",
      attention: "ARREARS",
      operationalAttention: "OVERDUE_RESERVED",
      sourceKind: "ORDER",
      sourceStartDate: "2026-08-01",
      sourceEndDate: "2026-08-03",
      occupantCount: 1,
      occupants: [{ occupantId: "occupant_1", nickname: "山风" }],
      primaryOccupantLabel: "山风",
      label: "order",
      reason: null
    } as RoomStatusIntervalDto;

    const html = renderContext([], undefined, interval);
    expect(html).toContain("已预订");
    expect(html).toContain("欠款");
    expect(html).toContain("逾期");
  });

  it("renders historical debt as a completed stay with one separate debt badge", () => {
    const interval = {
      id: "interval_historical_debt",
      status: "ARREARS",
      attention: "ARREARS",
      operationalAttention: null,
      sourceKind: "ORDER",
      sourceStartDate: "2026-08-01",
      sourceEndDate: "2026-08-03",
      occupantCount: 1,
      occupants: [{ occupantId: "occupant_1", nickname: "山风" }],
      primaryOccupantLabel: "山风",
      label: "已结单 order_historical_debt",
      reason: null
    } as RoomStatusIntervalDto;

    const html = renderContext([], undefined, interval);
    expect(html).toContain("已结单");
    expect(html).toContain("已结单 order_historical_debt");
    expect(html.match(/欠款/g)).toHaveLength(1);
  });

  it("keeps the server-authorized backfill visible but disabled with a recovery entry", () => {
    const html = renderContext([backfillAction], {
      kind: "RECOVERY",
      reason: backfillAction.disabledReason!,
      actionLabel: "查询原操作结果"
    });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>补录住宿/);
    expect(html).toContain("上一笔操作结果尚未收口");
    expect(html).toContain("查询原操作结果");
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain("服务端未为当前对象下发可执行动作");
  });

  it("names refresh failure and read-only access instead of claiming the server sent no action", () => {
    const refreshHtml = renderContext([], {
      kind: "REFRESH",
      reason: "房态刷新失败，当前仍显示上次成功结果。刷新成功前不能发起补录或其他写入。",
      actionLabel: "重试刷新"
    });
    expect(refreshHtml).toContain("房态刷新失败");
    expect(refreshHtml).toContain("重试刷新");
    expect(refreshHtml).not.toContain("服务端未为当前对象下发可执行动作");

    const readOnlyHtml = renderContext([], {
      kind: "PERMISSION",
      reason: "当前账号只有查看权限，不能补录住宿或执行其他写入。"
    });
    expect(readOnlyHtml).toContain("当前账号只有查看权限");
    expect(readOnlyHtml).not.toContain("服务端未为当前对象下发可执行动作");
  });

  it("shows both a global pause and the lack of server authorization", () => {
    const html = renderContext([], {
      kind: "RECOVERY",
      reason: "上一笔操作结果尚未收口。请先查询原操作结果；处理完成前不能发起新的补录。",
      actionLabel: "查询原操作结果"
    });
    expect(html).toContain("上一笔操作结果尚未收口");
    expect(html).toContain("查询原操作结果");
    expect(html).toContain("服务端未授权当前操作。");
  });

  it("reserves the no-server-action message for a genuinely unblocked empty action set", () => {
    expect(renderContext([])).toContain("服务端未为当前对象下发可执行动作");
  });
});

describe("roomStatusDraftSelection", () => {
  it("clears the action target while an edited date range is invalid", () => {
    expect(roomStatusDraftSelection({
      unitId: unit.id,
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-12"
    })).toEqual({ selection: null, valid: false });
  });

  it("restores a new target only after the edited range is valid", () => {
    expect(roomStatusDraftSelection({
      unitId: unit.id,
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-15"
    })).toMatchObject({
      selection: { unitId: unit.id, arrivalDate: "2026-08-12", departureDate: "2026-08-15" },
      valid: true
    });
  });
});
