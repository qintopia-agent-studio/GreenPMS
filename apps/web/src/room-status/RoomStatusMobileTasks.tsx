import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Blocks,
  CalendarCheck2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LogIn,
  LogOut,
  Plus,
  ShieldAlert
} from "lucide-react";
import type { RoomStatusActionDto, RoomStatusBoardDto, RoomStatusOperationalTaskDto, RoomStatusUnitDto } from "@qintopia/contracts";
import { Modal } from "../ui";
import {
  formatRoomStatusDate,
  formatRoomStatusDateTime,
  roomStatusBedOccupantLabels,
  roomStatusActionLabels,
  roomStatusIntervalBusinessLabel,
  roomStatusOccupantLabelLines,
  roomStatusPresentation,
  roomStatusSourceLabels,
  roomStatusUnitLabel,
  RoomStatusMark,
  useRoomStatusMobileViewport
} from "./roomStatusPresentation";
import { roomStatusOrderIdentityForInterval, type RoomStatusOrderIdentity } from "./roomStatusState";

export type RoomStatusMobileTab = "ARRIVALS" | "IN_HOUSE" | "DEPARTURES" | "EXCEPTIONS";

export interface RoomStatusMobileGroups {
  arrivals: readonly RoomStatusOperationalTaskDto[];
  inHouse: readonly RoomStatusOperationalTaskDto[];
  departures: readonly RoomStatusOperationalTaskDto[];
  exceptions: readonly RoomStatusOperationalTaskDto[];
}

export interface RoomStatusMobileFocusRequest {
  token: number;
  tab: RoomStatusMobileTab;
  completedTaskId: string;
  taskIndex: number;
  sourceRevision: string;
}

export interface RoomStatusMobileTasksProps {
  board: RoomStatusBoardDto;
  groups: RoomStatusMobileGroups;
  activeTab: RoomStatusMobileTab;
  canCreate: boolean;
  focusRequest?: RoomStatusMobileFocusRequest | undefined;
  onTabChange: (tab: RoomStatusMobileTab) => void;
  onPageChange: (pageIndex: number) => void;
  onCreate: () => void;
  onOpenReference: (reference: RoomStatusOperationalTaskDto["references"][number]) => void;
  onOpenReceipt: (receiptId: string) => void;
  onOpenOrderContext: (identity: RoomStatusOrderIdentity, serviceDate: string) => void;
  onAction: (action: RoomStatusActionDto, task: RoomStatusOperationalTaskDto, unit: RoomStatusUnitDto | null) => void;
}

const tabs: ReadonlyArray<{ code: RoomStatusMobileTab; label: string; group: keyof RoomStatusMobileGroups; Icon: typeof CalendarDays }> = [
  { code: "ARRIVALS", label: "今日到店", group: "arrivals", Icon: LogIn },
  { code: "IN_HOUSE", label: "在住", group: "inHouse", Icon: CalendarCheck2 },
  { code: "DEPARTURES", label: "今日离店", group: "departures", Icon: LogOut },
  { code: "EXCEPTIONS", label: "异常", group: "exceptions", Icon: AlertTriangle }
];

export function nextMobileTaskFocusId(
  tasks: readonly RoomStatusOperationalTaskDto[],
  completedTaskId: string,
  previousIndex: number
): string | null {
  const remaining = tasks.filter((task) => task.id !== completedTaskId);
  if (!remaining.length) return null;
  return remaining[Math.min(Math.max(0, previousIndex), remaining.length - 1)]?.id ?? null;
}

function flattenUnitMap(board: RoomStatusBoardDto): Map<string, RoomStatusUnitDto> {
  return new Map(board.rooms.flatMap((room) => [room, ...room.children]).map((unit) => [unit.id, unit]));
}

export interface MobileBedOccupancySummary {
  key: string;
  kind: "BED_SPLIT" | "BED_ORDER" | "WHOLE_ROOM";
  room: RoomStatusUnitDto;
  serviceDate: string;
  ratio: string;
  status: RoomStatusUnitDto["days"][number]["status"];
  occupantLabels: string[];
  orderIdentity: RoomStatusOrderIdentity | null;
}

export function mobileBedOccupancySummaries(board: RoomStatusBoardDto): MobileBedOccupancySummary[] {
  return board.rooms.flatMap((room) => room.bedOccupancies.flatMap((occupancy) => {
    const parent: MobileBedOccupancySummary = {
      key: `beds:${room.id}:${occupancy.serviceDate}`,
      kind: "BED_SPLIT",
      room,
      serviceDate: occupancy.serviceDate,
      ratio: `${occupancy.occupiedBedCount}/${occupancy.totalBedCount}`,
      status: room.days.find((day) => day.serviceDate === occupancy.serviceDate)?.status ?? "UNKNOWN",
      occupantLabels: roomStatusBedOccupantLabels(occupancy.occupants),
      orderIdentity: null
    };
    const exactBedOrders = occupancy.occupants.flatMap((occupant): MobileBedOccupancySummary[] => {
      const bed = room.children?.find((child) => child.id === occupant.inventoryUnitId);
      if (!bed) return [];
      const identities = bed.intervals.flatMap((interval) => {
        if (interval.startDate > occupancy.serviceDate || occupancy.serviceDate >= interval.endDate) return [];
        const identity = roomStatusOrderIdentityForInterval(interval);
        return identity?.orderId === occupant.sourceReference.id ? [identity] : [];
      });
      const stableOrders = new Set(identities.map((identity) => `${identity.orderId}:${identity.stayId}`));
      if (stableOrders.size !== 1) return [];
      return [{
        key: `bed-order:${bed.id}:${occupancy.serviceDate}:${identities[0]!.orderId}`,
        kind: "BED_ORDER",
        room: bed,
        serviceDate: occupancy.serviceDate,
        ratio: "1人",
        status: bed.days.find((day) => day.serviceDate === occupancy.serviceDate)?.status ?? "UNKNOWN",
        occupantLabels: [occupant.primaryOccupantLabel?.trim() || "历史未记录"],
        orderIdentity: identities[0]!
      }];
    });
    return [parent, ...exactBedOrders];
  }));
}

export function mobileWholeRoomOccupancySummaries(board: RoomStatusBoardDto): MobileBedOccupancySummary[] {
  return board.rooms.flatMap((room) => room.intervals.flatMap((interval) => {
    const wholeRoomLodging = interval.actualInventoryUnitId === room.id
      && interval.status !== "UNKNOWN"
      && (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY")
      && interval.occupantCount > 0;
    if (!wholeRoomLodging) return [];
    return board.dates
      .filter((serviceDate) => interval.startDate <= serviceDate && serviceDate < interval.endDate)
      .map((serviceDate) => ({
        key: `whole-room:${interval.id}:${serviceDate}`,
        kind: "WHOLE_ROOM" as const,
        room,
        serviceDate,
        ratio: `${interval.occupantCount}人`,
        status: room.days.find((day) => day.serviceDate === serviceDate)?.status ?? interval.status,
        occupantLabels: interval.occupants.map((occupant) => occupant.nickname?.trim() || "历史未记录"),
        orderIdentity: roomStatusOrderIdentityForInterval(interval)
      }));
  }));
}

export function mobileLodgingOccupancySummaries(board: RoomStatusBoardDto): MobileBedOccupancySummary[] {
  return [...mobileBedOccupancySummaries(board), ...mobileWholeRoomOccupancySummaries(board)];
}

export function mobileLodgingOccupantSummary(interval: RoomStatusOperationalTaskDto): string {
  return roomStatusIntervalBusinessLabel(interval);
}

export function executableTaskAction(
  task: RoomStatusOperationalTaskDto | null,
  unit: RoomStatusUnitDto | null
): RoomStatusActionDto | undefined {
  if (!task) return undefined;
  return task.allowedActions.find((action) => {
    if (!action.enabled) return false;
    if (action.code === "OPEN_ORDER") return action.targetReference?.type === "ORDER";
    if (action.code === "COMPLETE_CLEANING") {
      return task.sourceKind === "CLEANING" && action.targetReference?.type === "OPERATIONS";
    }
    if (action.code === "RELEASE_MAINTENANCE") {
      return task.sourceKind === "MAINTENANCE"
        && task.blocking
        && action.targetReference?.type === "BLOCK"
        && (!action.requiresFullInterval || task.sourceStartDate < task.sourceEndDate);
    }
    return Boolean(unit);
  });
}

export function RoomStatusMobileTasks({
  board,
  groups,
  activeTab,
  canCreate,
  focusRequest,
  onTabChange,
  onPageChange,
  onCreate,
  onOpenReference,
  onOpenReceipt,
  onOpenOrderContext,
  onAction
}: RoomStatusMobileTasksProps) {
  const isMobile = useRoomStatusMobileViewport();
  const tabsId = useId();
  const panelId = `${tabsId}-panel`;
  const tabRefs = useRef(new Map<RoomStatusMobileTab, HTMLButtonElement>());
  const taskRefs = useRef(new Map<string, HTMLButtonElement>());
  const handledFocusRequest = useRef(0);
  const [detailIntervalId, setDetailIntervalId] = useState<string | null>(null);
  const unitMap = useMemo(() => flattenUnitMap(board), [board]);
  const lodgingOccupancySummaries = useMemo(() => mobileLodgingOccupancySummaries(board), [board]);
  const intervalMap = useMemo(() => {
    const map = new Map<string, RoomStatusOperationalTaskDto>();
    for (const group of [groups.arrivals, groups.inHouse, groups.departures, groups.exceptions]) {
      for (const interval of group) map.set(interval.id, interval);
    }
    return map;
  }, [groups]);
  const activeDefinition = tabs.find((tab) => tab.code === activeTab) ?? tabs[0]!;
  const tasks = groups[activeDefinition.group];
  const detailInterval = detailIntervalId ? intervalMap.get(detailIntervalId) ?? null : null;
  const detailUnit = detailInterval
    ? unitMap.get(detailInterval.displayInventoryUnitId) ?? unitMap.get(detailInterval.actualInventoryUnitId) ?? null
    : null;
  const detailAction = executableTaskAction(detailInterval, detailUnit);
  const detailLodging = detailInterval?.sourceKind === "ORDER" || detailInterval?.sourceKind === "FREE_STAY";

  useEffect(() => {
    if (!focusRequest
      || handledFocusRequest.current === focusRequest.token
      || board.revision === focusRequest.sourceRevision) return;
    handledFocusRequest.current = focusRequest.token;
    const frame = requestAnimationFrame(() => {
      if (activeTab !== focusRequest.tab) {
        tabRefs.current.get(activeTab)?.focus();
        return;
      }
      const targetId = nextMobileTaskFocusId(tasks, focusRequest.completedTaskId, focusRequest.taskIndex);
      if (targetId && taskRefs.current.get(targetId)) taskRefs.current.get(targetId)?.focus();
      else tabRefs.current.get(activeTab)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, board.revision, focusRequest, tasks]);

  if (!isMobile) return null;

  const openTask = (task: RoomStatusOperationalTaskDto) => {
    setDetailIntervalId(task.id);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: RoomStatusMobileTab) => {
    const currentIndex = tabs.findIndex((tab) => tab.code === current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!;
    onTabChange(next.code);
    tabRefs.current.get(next.code)?.focus();
  };

  return (
    <section className="room-status-mobile" aria-labelledby={`${tabsId}-heading`}>
      <header>
        <div>
          <span>移动房态</span>
          <h2 id={`${tabsId}-heading`}>今日运营任务</h2>
        </div>
        <div className="room-status-mobile-header-actions">
          <small>{formatRoomStatusDateTime(board.asOf)} · revision {board.revision}</small>
          {canCreate ? (
            <button type="button" className="room-status-button" aria-label="新建住宿或锁房" onClick={onCreate}>
              <Plus aria-hidden="true" size={17} />新建
            </button>
          ) : null}
        </div>
      </header>

      {board.page.totalPages > 1 ? (
        <nav className="room-status-mobile-pagination" aria-label="移动房源分页">
          <span>房源第 {board.page.index + 1} / {board.page.totalPages} 页，共 {board.page.totalRooms} 间</span>
          <div>
            <button
              type="button"
              className="room-status-icon-button room-status-button-secondary"
              aria-label="上一页房源"
              title="上一页"
              disabled={board.page.index <= 0}
              onClick={() => onPageChange(board.page.index - 1)}
            >
              <ChevronLeft aria-hidden="true" size={19} />
            </button>
            <button
              type="button"
              className="room-status-icon-button room-status-button-secondary"
              aria-label="下一页房源"
              title="下一页"
              disabled={board.page.index >= board.page.totalPages - 1}
              onClick={() => onPageChange(board.page.index + 1)}
            >
              <ChevronRight aria-hidden="true" size={19} />
            </button>
          </div>
        </nav>
      ) : null}

      {lodgingOccupancySummaries.length ? (
        <section className="room-status-mobile-occupancies" aria-label="住宿人" role="region">
          <h3>当前日期范围住宿人</h3>
          <ul>
            {lodgingOccupancySummaries.map((summary) => (
              <li key={summary.key}>
                <div className="room-status-mobile-occupancy-heading">
                  <strong>{roomStatusUnitLabel(summary.room)}</strong>
                  <span>{formatRoomStatusDate(summary.serviceDate)} · {summary.ratio} · {roomStatusPresentation[summary.status].label}</span>
                </div>
                <div className="room-status-mobile-occupant-list">
                  {roomStatusOccupantLabelLines(summary.occupantLabels).map((line, index) => (
                    <span
                      data-mobile-bed-occupant-line={summary.kind === "BED_SPLIT" || summary.kind === "BED_ORDER" ? true : undefined}
                      data-mobile-whole-room-occupant-line={summary.kind === "WHOLE_ROOM" ? true : undefined}
                      key={`${summary.key}:${index}`}
                    >{line}</span>
                  ))}
                </div>
                {summary.orderIdentity ? <button type="button" className="room-status-text-button" onClick={() => onOpenOrderContext(summary.orderIdentity!, summary.serviceDate)}>打开订单上下文<ArrowRight aria-hidden="true" size={16} /></button> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="room-status-mobile-tabs" role="tablist" aria-label="房态任务分类">
        {tabs.map(({ code, label, group, Icon }) => (
          <button
            type="button"
            role="tab"
            id={`${tabsId}-${code}-tab`}
            aria-controls={panelId}
            aria-selected={activeTab === code}
            tabIndex={activeTab === code ? 0 : -1}
            key={code}
            onClick={() => onTabChange(code)}
            onKeyDown={(event) => handleTabKeyDown(event, code)}
            ref={(node) => {
              if (node) tabRefs.current.set(code, node);
              else tabRefs.current.delete(code);
            }}
          >
            <Icon aria-hidden="true" size={17} />
            <span>{label}</span>
            <strong>{groups[group].length}</strong>
          </button>
        ))}
      </div>

      <div
        className="room-status-mobile-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${tabsId}-${activeDefinition.code}-tab`}
      >
        {tasks.length ? (
          <ul className="room-status-mobile-task-list">
            {tasks.map((interval) => {
              const unit = unitMap.get(interval.displayInventoryUnitId) ?? unitMap.get(interval.actualInventoryUnitId) ?? null;
              const primaryAction = executableTaskAction(interval, unit);
              const lodging = interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY";
              const businessLabel = mobileLodgingOccupantSummary(interval);
              return (
                <li key={interval.id}>
                  <button
                    type="button"
                    className="room-status-mobile-task-open"
                    data-room-status-mobile-task={interval.id}
                    ref={(node) => {
                      if (node) taskRefs.current.set(interval.id, node);
                      else taskRefs.current.delete(interval.id);
                    }}
                    onClick={() => openTask(interval)}
                  >
                    <span className="room-status-mobile-task-title">
                      <strong>{unit ? roomStatusUnitLabel(unit) : interval.displayInventoryUnitId}</strong>
                      <RoomStatusMark status={interval.status} compact />
                    </span>
                    {lodging ? <span>住宿人 · {businessLabel}</span> : null}
                    {!lodging ? <span>{interval.label}</span> : null}
                    <small>来源完整区间 {formatRoomStatusDate(interval.sourceStartDate)}至{formatRoomStatusDate(interval.sourceEndDate)} · {roomStatusSourceLabels[interval.sourceKind]}</small>
                    {!unit ? <small className="room-status-mobile-task-warning">库存单元未包含在当前查询页，保留稳定 ID。</small> : null}
                    {!lodging && interval.conflicts.length ? <small className="room-status-mobile-task-warning">{interval.conflicts.length} 个日期占用</small> : null}
                  </button>
                  {primaryAction ? (
                    <button type="button" className="room-status-button room-status-mobile-primary-action" onClick={() => onAction(primaryAction, interval, unit)}>
                      {roomStatusActionLabels[primaryAction.code]}<ArrowRight aria-hidden="true" size={17} />
                    </button>
                  ) : (
                    <button type="button" className="room-status-button room-status-button-secondary room-status-mobile-primary-action" onClick={() => openTask(interval)}>
                      查看事实<ArrowRight aria-hidden="true" size={17} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="room-status-mobile-empty">
            <CalendarDays aria-hidden="true" size={22} />
            <strong>当前没有{activeDefinition.label}任务</strong>
            <p>当前营业日没有相关任务。刷新后仍无记录则无需处理。</p>
          </div>
        )}
      </div>

      {detailInterval ? (
        <Modal
          title={`${detailUnit?.code ?? "稳定库存引用"} · 任务详情`}
          size="mobile-fullscreen"
          onClose={() => setDetailIntervalId(null)}
          footer={(
            <div className="room-status-mobile-detail-actions">
              <button type="button" className="room-status-button room-status-button-secondary" onClick={() => setDetailIntervalId(null)}>返回任务列表</button>
              {detailAction ? (
                <button
                  type="button"
                  className="room-status-button"
                  onClick={() => {
                    setDetailIntervalId(null);
                    onAction(detailAction, detailInterval, detailUnit);
                  }}
                >
                  {roomStatusActionLabels[detailAction.code]}<ArrowRight aria-hidden="true" size={17} />
                </button>
              ) : null}
            </div>
          )}
        >
          <div className="room-status-mobile-detail">
            <div className="room-status-mobile-detail-summary">
              <RoomStatusMark status={detailInterval.status} />
              <strong>{detailLodging ? `住宿人 · ${mobileLodgingOccupantSummary(detailInterval)}` : roomStatusIntervalBusinessLabel(detailInterval)}</strong>
              <span>{roomStatusSourceLabels[detailInterval.sourceKind]}</span>
            </div>
            <section aria-labelledby={`${tabsId}-detail-range`}>
              <h3 id={`${tabsId}-detail-range`}><CalendarDays aria-hidden="true" size={18} />房源与日期</h3>
              <dl>
                <dt>房源</dt><dd>{detailUnit ? roomStatusUnitLabel(detailUnit) : "当前查询页未包含房源名称"}</dd>
                <dt>营业日期</dt><dd><code>{detailInterval.businessDate}</code></dd>
                <dt>任务显示区间</dt><dd><code>[{detailInterval.startDate}, {detailInterval.endDate})</code></dd>
                <dt>来源完整区间</dt><dd><code>[{detailInterval.sourceStartDate}, {detailInterval.sourceEndDate})</code></dd>
                {!detailLodging ? <><dt>显示库存 ID</dt><dd><code>{detailInterval.displayInventoryUnitId}</code></dd></> : null}
                {!detailLodging ? <><dt>实际库存 ID</dt><dd><code>{detailInterval.actualInventoryUnitId}</code></dd></> : null}
              </dl>
            </section>
            {!detailLodging ? <section aria-labelledby={`${tabsId}-detail-source`}>
              <h3 id={`${tabsId}-detail-source`}><Blocks aria-hidden="true" size={18} />来源事实</h3>
              <dl>
                <dt>区间 ID</dt><dd><code>{detailInterval.id}</code></dd>
                <dt>阻断库存</dt><dd>{detailInterval.blocking ? "是" : "否"}</dd>
                <dt>原因</dt><dd>{detailInterval.reason ?? "未提供原因"}</dd>
                <dt>Claim</dt><dd>{detailInterval.claimIds.length ? detailInterval.claimIds.map((id) => <code key={id}>{id} </code>) : "无"}</dd>
              </dl>
              {detailInterval.references.length ? (
                <ul className="room-status-mobile-detail-references">
                  {detailInterval.references.map((reference) => (
                    <li key={`${reference.type}:${reference.id}`}>
                      {reference.href ? (
                        <button type="button" onClick={() => {
                          setDetailIntervalId(null);
                          onOpenReference(reference);
                        }}>
                          <strong>{reference.label}</strong><span>{reference.type}</span><code>{reference.id}</code>
                        </button>
                      ) : <div><strong>{reference.label}</strong><span>{reference.type}</span><code>{reference.id}</code></div>}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section> : (
              <section aria-labelledby={`${tabsId}-detail-source`}>
                <h3 id={`${tabsId}-detail-source`}><CalendarCheck2 aria-hidden="true" size={18} />住宿信息</h3>
                <dl>
                  <dt>住宿状态</dt><dd>{roomStatusPresentation[detailInterval.status].label}</dd>
                  <dt>住宿来源</dt><dd>{roomStatusSourceLabels[detailInterval.sourceKind]}</dd>
                  <dt>说明</dt><dd>{detailInterval.reason ?? "无额外说明"}</dd>
                </dl>
              </section>
            )}
            {!detailLodging && detailInterval.history.length ? (
              <section aria-labelledby={`${tabsId}-detail-history`}>
                <h3 id={`${tabsId}-detail-history`}><Clock3 aria-hidden="true" size={18} />事实历史</h3>
                <ol className="room-status-mobile-detail-history">
                  {detailInterval.history.map((item, index) => (
                    <li key={`${item.occurredAt}:${item.commandId ?? index}`}>
                      <strong>{item.action}</strong>
                      <span>{formatRoomStatusDateTime(item.occurredAt)} · {item.source} · actor {item.actorId ?? "已脱敏 / 未记录"}</span>
                      <code>{item.commandId ?? "无 Command"}</code>
                      {item.receiptId ? (
                        <button type="button" className="room-status-text-button" onClick={() => {
                          setDetailIntervalId(null);
                          onOpenReceipt(item.receiptId!);
                        }}>查看 Receipt <code>{item.receiptId}</code></button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            {detailInterval.conflicts.length ? (
              <section className="room-status-mobile-detail-conflicts" aria-labelledby={`${tabsId}-detail-conflicts`}>
                <h3 id={`${tabsId}-detail-conflicts`}><ShieldAlert aria-hidden="true" size={18} />日期占用</h3>
                <ul>{detailInterval.conflicts.map((conflict) => <li key={conflict.id}><strong>{roomStatusSourceLabels[conflict.sourceKind]} 已有住宿，不能重复安排</strong><span>{formatRoomStatusDate(conflict.startDate)}至{formatRoomStatusDate(conflict.endDate)}</span></li>)}</ul>
              </section>
            ) : null}
            <section aria-labelledby={`${tabsId}-detail-freshness`}>
              <h3 id={`${tabsId}-detail-freshness`}><Clock3 aria-hidden="true" size={18} />数据新鲜度</h3>
              <dl>
                <dt>数据时点</dt><dd>{board.asOf}</dd>
                <dt>有效至</dt><dd>{board.freshUntil}</dd>
                <dt>Revision</dt><dd><code>{board.revision}</code></dd>
              </dl>
            </section>
            {!detailAction ? <p className="room-status-mobile-detail-no-action">服务端未为当前任务下发可执行动作。查看详情不会写入业务事实。</p> : null}
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
