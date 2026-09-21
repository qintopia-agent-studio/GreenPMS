import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoomStatusActionDto, RoomStatusBoardDto, RoomStatusIntervalDto, RoomStatusUnitDto } from "@qintopia/contracts";
import { RoomStatusContext, roomStatusDraftSelection, type RoomStatusContextProps } from "./RoomStatusContext";

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
  businessDate: "2026-08-14",
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
  selectedInterval: RoomStatusIntervalDto | null = null,
  overrides: Partial<RoomStatusContextProps> = {}
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
    {...overrides}
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

  it("shows original order dates and due-out attention instead of the synthetic safety interval", () => {
    const interval = {
      id: "interval_due_out",
      status: "IN_HOUSE",
      attention: null,
      operationalAttention: "DUE_OUT",
      sourceKind: "ORDER",
      sourceStartDate: "2026-09-01",
      sourceEndDate: "2026-09-02",
      orderArrivalDate: "2026-08-28",
      orderDepartureDate: "2026-09-01",
      occupantCount: 1,
      occupants: [{ occupantId: "occupant_due_out", nickname: "朝露" }],
      primaryOccupantLabel: "朝露",
      label: "order due out",
      reason: "计划退房日 2026-09-01，订单仍待办理退房"
    } as RoomStatusIntervalDto;

    const html = renderContext([], undefined, interval);
    expect(html).toContain("待退房");
    expect(html).toContain("住宿日期</dt><dd>8月28日至9月1日");
    expect(html).not.toContain("住宿日期</dt><dd>9月1日至9月2日");
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

  it("explains a global pause without exposing implementation jargon", () => {
    const html = renderContext([], {
      kind: "RECOVERY",
      reason: "上一笔操作结果尚未收口。请先查询原操作结果；处理完成前不能发起新的补录。",
      actionLabel: "查询原操作结果"
    });
    expect(html).toContain("上一笔操作结果尚未收口");
    expect(html).toContain("查询原操作结果");
    expect(html).not.toContain("服务端未授权当前操作。");
  });

  it("asks for valid dates instead of claiming an empty selection is available", () => {
    const html = renderContext([]);
    expect(html).toContain("请先选择房源并填写有效的入住、退房日期");
    expect(html).not.toContain("当前所选日期可以安排住宿");
    expect(html).not.toContain("服务端");
  });

  it.each([
    ["2026-08-14", "已完成住宿补录"],
    ["2026-08-15", "在住住宿补录"]
  ])("explains historical intent with departure %s as %s", (departureDate, label) => {
    const selection = roomStatusDraftSelection({ unitId: unit.id, arrivalDate: "2026-08-13", departureDate }).selection;
    const html = renderContext([{ ...backfillAction, enabled: true, disabledReason: null }], undefined, null, { selection });
    expect(html).toContain(label);
    expect(html).toContain("入住日期早于今天，请通过“补录住宿”登记");
    expect(html).toMatch(/<button[^>]*>补录住宿/);
  });

  it("labels off-board dates as unverified and gives the actual calendar window", () => {
    const selection = roomStatusDraftSelection({ unitId: unit.id, arrivalDate: "2026-07-31", departureDate: "2026-09-02" }).selection;
    const html = renderContext([], undefined, null, { selection });
    expect(html).toContain("2026-08-01");
    expect(html).toContain("2026-08-30");
    expect(html).toContain("所选住宿日期已保留，超出部分将在办理时核对");
    expect(html).toContain("其余日期将在办理时核对");
    expect(html).not.toContain("当前所选日期可以安排住宿");
  });

  it("explains existing historical records even without an active blocking conflict", () => {
    const selection = roomStatusDraftSelection({ unitId: unit.id, arrivalDate: "2026-08-13", departureDate: "2026-08-14" }).selection;
    const html = renderContext([], undefined, null, {
      selection,
      selectedUnit: { ...unit, days: [{ serviceDate: "2026-08-13", status: "SETTLED", available: false, intervalIds: ["historical"], conflicts: [] }] }
    });
    expect(html).toContain("所选日期已有住宿或锁房记录，请先核对已有记录");
    expect(html).toContain("暂不能新建或补录住宿");
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
