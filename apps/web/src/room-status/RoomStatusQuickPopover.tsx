import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CalendarPlus2, ClipboardList, FileClock, Gift, HandHeart, LockKeyhole, LockKeyholeOpen, RefreshCw, Search, X } from "lucide-react";
import type { RoomStatusActionDto, RoomStatusStatus } from "@qintopia/contracts";
import {
  formatRoomStatusDate,
  roomStatusFreeStayCategoryLabel,
  roomStatusUnitLabel,
  RoomStatusAttentionBadges,
  RoomStatusMark,
  type RoomStatusAttentionLabel
} from "./roomStatusPresentation";
import type { RoomStatusOrderOption, RoomStatusOrderOptionsResult, RoomStatusSelection } from "./roomStatusState";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

export interface RoomStatusPopoverPosition {
  left: number;
  top: number;
  maxHeight: number;
}

export function roomStatusPopoverMeasuredHeight(
  element: Pick<HTMLElement, "scrollHeight" | "clientHeight">,
  bounds: Pick<DOMRect, "height">
): number {
  return element.scrollHeight + Math.max(0, bounds.height - element.clientHeight);
}

export type RoomStatusQuickPopoverCloseReason = "ACTION" | "DISMISS";

export function roomStatusPopoverViewportEventShouldClose(
  eventType: string,
  targetInsidePopover: boolean,
  anchorVisible: boolean
): boolean {
  return eventType !== "scroll" || (!targetInsidePopover && !anchorVisible);
}

export function roomStatusPopoverPosition(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  viewport: { width: number; height: number },
  popover: { width: number; height: number },
  row: Pick<DOMRect, "top" | "bottom"> = anchor
): RoomStatusPopoverPosition {
  const alignedLeft = anchor.left;
  const rightAlignedLeft = anchor.right - popover.width;
  const left = alignedLeft + popover.width <= viewport.width - VIEWPORT_MARGIN
    ? Math.max(VIEWPORT_MARGIN, alignedLeft)
    : Math.max(VIEWPORT_MARGIN, Math.min(rightAlignedLeft, viewport.width - popover.width - VIEWPORT_MARGIN));
  const belowTop = row.bottom + ANCHOR_GAP;
  const availableBelow = Math.max(0, viewport.height - VIEWPORT_MARGIN - belowTop);
  const availableAbove = Math.max(0, row.top - ANCHOR_GAP - VIEWPORT_MARGIN);
  const placeBelow = popover.height <= availableBelow
    || (popover.height > availableAbove && availableBelow >= availableAbove);
  const maxHeight = Math.floor(placeBelow ? availableBelow : availableAbove);
  const renderedHeight = Math.min(popover.height, maxHeight);
  const top = placeBelow ? belowTop : row.top - ANCHOR_GAP - renderedHeight;
  return { left: Math.round(left), top: Math.round(top), maxHeight };
}

function selectionNights(selection: RoomStatusSelection): number {
  const arrival = Date.parse(`${selection.arrivalDate}T00:00:00.000Z`);
  const departure = Date.parse(`${selection.departureDate}T00:00:00.000Z`);
  return Math.max(1, Math.round((departure - arrival) / 86_400_000));
}

export function roomStatusQuickActionVisible(
  action: Pick<RoomStatusActionDto, "code" | "enabled">,
  selectionStartDate: string,
  businessDate?: string
): boolean {
  if (!businessDate) return true;
  const containsHistoricalDate = selectionStartDate < businessDate;
  // A historical selection changes only how a stay is created. It must not
  // hide lifecycle actions that the server has separately authorized.
  const creationAction = action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY";
  return containsHistoricalDate ? !creationAction : action.code !== "BACKFILL_ORDER";
}

export function roomStatusQuickActionCanRun(action: Pick<RoomStatusActionDto, "enabled">): boolean {
  return action.enabled;
}

export function roomStatusQuickActionDisabledReason(
  action: Pick<RoomStatusActionDto, "disabledReason">,
  writeBlock: { reason: string } | undefined
): string | undefined {
  const reason = action.disabledReason ?? undefined;
  return reason === writeBlock?.reason ? undefined : reason;
}

export function runRoomStatusQuickAction(
  action: RoomStatusActionDto,
  callback: (action: RoomStatusActionDto) => void
): boolean {
  if (!roomStatusQuickActionCanRun(action)) return false;
  callback(action);
  return true;
}

export function runRoomStatusWriteBlockAction(
  writeBlock: { kind: "REFRESH" | "RECOVERY" | "PERMISSION" } | undefined,
  callbacks: { onRefresh?: (() => void) | undefined; onOpenRecovery?: (() => void) | undefined }
): boolean {
  if (writeBlock?.kind === "REFRESH" && callbacks.onRefresh) {
    callbacks.onRefresh();
    return true;
  }
  if (writeBlock?.kind === "RECOVERY" && callbacks.onOpenRecovery) {
    callbacks.onOpenRecovery();
    return true;
  }
  return false;
}

export interface RoomStatusQuickOrderHeaderMark {
  label: string;
  title: string;
}

export function roomStatusQuickOrderHeaderMarks(
  orders: readonly RoomStatusOrderOption[]
): RoomStatusQuickOrderHeaderMark[] {
  if (orders.length !== 1) return [];
  const source = orders[0]!.source;
  if (source.sourceKind !== "FREE_STAY") return [];
  const category = roomStatusFreeStayCategoryLabel(source.freeStayCategoryCode);
  if (!category) {
    return [
      { label: "免费", title: "免费入住" },
      { label: "历史未记录", title: "免费入住类型与原因：历史未记录" }
    ];
  }
  return [
    { label: "免费", title: "免费入住" },
    { label: category, title: `${category}；免费入住原因：${source.freeStayReason ?? "历史未记录"}` }
  ];
}

export function roomStatusQuickOrderSourceSummary(option: RoomStatusOrderOption): string {
  if (option.operationalAttention === "DUE_OUT") return "待退房";
  const { source } = option;
  if (source.sourceKind === "FREE_STAY") {
    return `免费入住 · ${roomStatusFreeStayCategoryLabel(source.freeStayCategoryCode) ?? "历史未记录"}`;
  }
  const labels = {
    DIRECT: "直订",
    YOUMUDAO: "游牧岛",
    CTRIP: "携程",
    MEITUAN: "美团",
    MEMBER: "会员权益"
  } as const;
  return source.sourceCategory && source.sourceCategory in labels
    ? labels[source.sourceCategory as keyof typeof labels]
    : "来源历史未记录";
}

function RoomStatusQuickOrderHeaderMark({ mark, category }: {
  mark: RoomStatusQuickOrderHeaderMark;
  category: boolean;
}) {
  const Icon = category ? HandHeart : Gift;
  return <span
    className="room-status-mark room-status-mark-compact room-status-mark-source"
    title={mark.title}
    aria-label={mark.title}
  ><Icon aria-hidden="true" size={14} /><span>{mark.label}</span></span>;
}

function QuickActionButton({
  action,
  label,
  icon,
  primary = false,
  reasonId,
  disabledReason,
  onRun
}: {
  action: RoomStatusActionDto;
  label: string;
  icon: ReactNode;
  primary?: boolean;
  reasonId: string;
  disabledReason?: string | undefined;
  onRun: (action: RoomStatusActionDto) => void;
}) {
  const disabled = !action.enabled;
  return <div className="room-status-action-with-reason">
    <button
      type="button"
      className={`button ${primary ? "button-primary" : "button-secondary"}`}
      disabled={disabled}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      onClick={() => {
        runRoomStatusQuickAction(action, onRun);
      }}
    >{icon}{label}</button>
    {disabled && disabledReason ? <small id={reasonId} className="room-status-action-disabled" role="status"><AlertTriangle aria-hidden="true" size={14} />{disabledReason}</small> : null}
  </div>;
}

export function RoomStatusQuickPopover({
  anchor,
  unit,
  serviceDate,
  businessDate,
  status,
  attentionLabels = [],
  actions,
  writeBlock,
  orderOptions,
  selection,
  onCreate,
  onLockMaintenance,
  onReleaseMaintenance,
  onViewStatus,
  onRefresh,
  onOpenRecovery,
  onOpenOrder,
  onClose
}: {
  anchor: HTMLElement;
  unit: Parameters<typeof roomStatusUnitLabel>[0];
  serviceDate: string;
  businessDate?: string;
  status: RoomStatusStatus;
  attentionLabels?: readonly RoomStatusAttentionLabel[];
  actions: readonly RoomStatusActionDto[];
  writeBlock?: { kind: "REFRESH" | "RECOVERY" | "PERMISSION"; reason: string; actionLabel?: string };
  orderOptions: RoomStatusOrderOptionsResult;
  selection?: RoomStatusSelection;
  onCreate: (action: RoomStatusActionDto) => void;
  onLockMaintenance: (action: RoomStatusActionDto) => void;
  onReleaseMaintenance: (action: RoomStatusActionDto) => void;
  onViewStatus: () => void;
  onRefresh?: () => void;
  onOpenRecovery?: () => void;
  onOpenOrder: (option: Extract<RoomStatusOrderOptionsResult, { kind: "READY" }>["orders"][number]) => void;
  onClose: (reason: RoomStatusQuickPopoverCloseReason) => void;
}) {
  const titleId = useId();
  const popoverId = useId();
  const popoverRef = useRef<HTMLDivElement>(null);
  const rowAnchor = anchor.closest<HTMLElement>("[data-room-status-row]");
  const [position, setPosition] = useState<RoomStatusPopoverPosition>(() => roomStatusPopoverPosition(
    anchor.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    { width: 280, height: 220 },
    rowAnchor?.getBoundingClientRect()
  ));
  const restoreSnapshot = useRef({
    windowX: window.scrollX,
    windowY: window.scrollY,
    grid: anchor.closest<HTMLElement>(".room-status-grid-scroll"),
    gridLeft: anchor.closest<HTMLElement>(".room-status-grid-scroll")?.scrollLeft ?? 0,
    gridTop: anchor.closest<HTMLElement>(".room-status-grid-scroll")?.scrollTop ?? 0
  });

  const visibleActions = actions.filter((action) => roomStatusQuickActionVisible(action, selection?.arrivalDate ?? serviceDate, businessDate));
  const createActions = visibleActions.filter((action) => action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY");
  const createAction = createActions.find((action) => action.code === "CREATE_ORDER") ?? createActions[0];
  const backfillAction = visibleActions.find((action) => action.code === "BACKFILL_ORDER");
  const maintenanceAction = visibleActions.find((action) => action.code === "LOCK_MAINTENANCE");
  const releaseAction = visibleActions.find((action) => action.code === "RELEASE_MAINTENANCE");
  const enabledBusinessAction = visibleActions.some((action) => action.enabled && action.code !== "OPEN_ORDER");
  const dateLabel = selection
    ? `${formatRoomStatusDate(selection.arrivalDate)}至${formatRoomStatusDate(selection.departureDate)}`
    : formatRoomStatusDate(serviceDate);
  const historicalBlank = !selection && businessDate !== undefined && serviceDate < businessDate && status === "AVAILABLE";
  const selectedOrderCount = orderOptions.kind === "READY" ? orderOptions.orders.length : 0;
  const quickOrderHeaderMarks = orderOptions.kind === "READY"
    ? roomStatusQuickOrderHeaderMarks(orderOptions.orders)
    : [];
  const hasQuickAction = Boolean(createAction || backfillAction || maintenanceAction || releaseAction);
  const hasApplicableServerAction = hasQuickAction || selectedOrderCount > 0;
  const disabledReason = (action: RoomStatusActionDto) => roomStatusQuickActionDisabledReason(action, writeBlock);
  const actionReasonId = (action: RoomStatusActionDto) => `${popoverId}-disabled-${action.code}-${action.targetReference?.id ?? "selection"}`;
  const rangeLabel = selection
    ? `${selectionNights(selection)}晚 · ${orderOptions.kind === "INVALID_REFERENCE"
      ? "订单信息异常"
      : selectedOrderCount > 0
        ? `${selectedOrderCount}张订单`
        : createAction || backfillAction || maintenanceAction || releaseAction
          ? enabledBusinessAction ? "可办理" : "写入暂停"
          : "暂无可办操作"}`
    : null;

  const reposition = useCallback(() => {
    const node = popoverRef.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    const next = roomStatusPopoverPosition(
      anchor.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      { width: bounds.width, height: roomStatusPopoverMeasuredHeight(node, bounds) },
      rowAnchor?.getBoundingClientRect()
    );
    setPosition((current) => current.left === next.left
      && current.top === next.top
      && current.maxHeight === next.maxHeight
      ? current
      : next);
  }, [anchor, rowAnchor]);

  function close(restoreFocus: boolean) {
    onClose("DISMISS");
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      const snapshot = restoreSnapshot.current;
      snapshot.grid?.scrollTo({ left: snapshot.gridLeft, top: snapshot.gridTop, behavior: "auto" });
      window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
      snapshot.grid?.scrollTo({ left: snapshot.gridLeft, top: snapshot.gridTop, behavior: "auto" });
      window.scrollTo({ left: snapshot.windowX, top: snapshot.windowY, behavior: "auto" });
    });
  }

  function runCreate(action: RoomStatusActionDto) {
    if (!roomStatusQuickActionCanRun(action)) return;
    onClose("ACTION");
    onCreate(action);
  }

  function runMaintenanceAction(action: RoomStatusActionDto, callback: (value: RoomStatusActionDto) => void) {
    if (!roomStatusQuickActionCanRun(action)) return;
    onClose("ACTION");
    callback(action);
  }

  useLayoutEffect(() => {
    const node = popoverRef.current;
    if (!node) return;
    reposition();
    const resizeObserver = new ResizeObserver(reposition);
    const layoutRoot = anchor.closest<HTMLElement>(".room-status-grid");
    const layoutBoundary = anchor.closest<HTMLElement>(".inventory-page")
      ?? anchor.closest<HTMLElement>(".room-status-grid-section")
      ?? layoutRoot;
    for (const observed of new Set<HTMLElement>([
      node,
      anchor,
      ...(rowAnchor ? [rowAnchor] : []),
      ...(layoutRoot ? [layoutRoot] : []),
      ...(layoutBoundary ? [layoutBoundary] : [])
    ])) {
      resizeObserver.observe(observed);
    }
    const geometrySignature = () => {
      const anchorBounds = anchor.getBoundingClientRect();
      const rowBounds = rowAnchor?.getBoundingClientRect() ?? anchorBounds;
      return `${anchorBounds.left}:${anchorBounds.right}:${anchorBounds.top}:${anchorBounds.bottom}:${rowBounds.top}:${rowBounds.bottom}:${window.innerWidth}:${window.innerHeight}`;
    };
    let previousGeometry = geometrySignature();
    let frame = 0;
    const trackGeometry = () => {
      const nextGeometry = geometrySignature();
      if (nextGeometry !== previousGeometry) {
        previousGeometry = nextGeometry;
        reposition();
      }
      frame = requestAnimationFrame(trackGeometry);
    };
    frame = requestAnimationFrame(trackGeometry);
    node.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [anchor, reposition, rowAnchor]);

  useEffect(() => {
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", popoverId);
    return () => {
      anchor.removeAttribute("aria-expanded");
      anchor.removeAttribute("aria-controls");
    };
  }, [anchor, popoverId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || popoverRef.current?.contains(target) || anchor.contains(target)) return;
      close(false);
    };
    const onViewportChange = (event: Event) => {
      const target = event.target;
      const targetInsidePopover = target instanceof Node && Boolean(popoverRef.current?.contains(target));
      const anchorBounds = anchor.getBoundingClientRect();
      const anchorVisible = anchor.isConnected
        && anchorBounds.right > 0
        && anchorBounds.bottom > 0
        && anchorBounds.left < window.innerWidth
        && anchorBounds.top < window.innerHeight;
      if (!roomStatusPopoverViewportEventShouldClose(event.type, targetInsidePopover, anchorVisible)) {
        if (!targetInsidePopover) reposition();
        return;
      }
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  });

  return createPortal(
    <div
      id={popoverId}
      ref={popoverRef}
      className="room-status-quick-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
      data-testid="room-status-quick-popover"
      data-unit-id={anchor.dataset.unitId}
      data-selection-kind={selection ? "range" : "day"}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && (event.currentTarget.contains(next) || anchor.contains(next))) return;
        close(false);
      }}
    >
      <header>
        <div>
          <strong id={titleId}>{roomStatusUnitLabel(unit)}</strong>
          <span className="room-status-quick-meta">
            <span>{dateLabel}</span>
            {selection ? <span>{rangeLabel}</span> : historicalBlank ? <span>历史空白</span> : <RoomStatusMark status={status} compact />}
            {quickOrderHeaderMarks.map((mark, index) => <RoomStatusQuickOrderHeaderMark key={mark.label} mark={mark} category={index === 1} />)}
            <RoomStatusAttentionBadges labels={attentionLabels} />
          </span>
        </div>
        <button type="button" className="room-status-icon-button" onClick={() => close(true)} aria-label="关闭快捷操作" title="关闭快捷操作"><X aria-hidden="true" size={17} /></button>
      </header>
      {orderOptions.kind === "INVALID_REFERENCE" ? (
        <p className="room-status-quick-error" role="alert">当前住宿缺少唯一、稳定的订单引用。请刷新房态后重试。</p>
      ) : (
        <>
          {orderOptions.orders.length ? (
            <div className="room-status-quick-orders" aria-label="当前订单列表">
              {orderOptions.orders.map((option) => (
                <button key={`${option.identity.orderId}:${option.identity.stayId}`} type="button" onClick={() => { onClose("ACTION"); onOpenOrder(option); }}>
                  <ClipboardList aria-hidden="true" size={17} /><span><strong>{option.label}</strong><small>{formatRoomStatusDate(option.identity.arrivalDate)} 至 {formatRoomStatusDate(option.identity.departureDate)} · {roomStatusQuickOrderSourceSummary(option)}</small></span>
                </button>
              ))}
            </div>
          ) : null}
          {hasQuickAction ? (
            <div className="room-status-quick-actions">
              {createAction ? <QuickActionButton action={createAction} label="创建订单" icon={<CalendarPlus2 aria-hidden="true" size={17} />} primary reasonId={actionReasonId(createAction)} disabledReason={disabledReason(createAction)} onRun={runCreate} /> : null}
              {backfillAction ? <QuickActionButton action={backfillAction} label="补录住宿" icon={<CalendarPlus2 aria-hidden="true" size={17} />} primary reasonId={actionReasonId(backfillAction)} disabledReason={disabledReason(backfillAction)} onRun={runCreate} /> : null}
              {maintenanceAction ? <QuickActionButton action={maintenanceAction} label="维修锁房" icon={<LockKeyhole aria-hidden="true" size={17} />} reasonId={actionReasonId(maintenanceAction)} disabledReason={disabledReason(maintenanceAction)} onRun={(action) => runMaintenanceAction(action, onLockMaintenance)} /> : null}
              {releaseAction ? <QuickActionButton action={releaseAction} label="释放维修锁房" icon={<LockKeyholeOpen aria-hidden="true" size={17} />} reasonId={actionReasonId(releaseAction)} disabledReason={disabledReason(releaseAction)} onRun={(action) => runMaintenanceAction(action, onReleaseMaintenance)} /> : null}
            </div>
          ) : null}
          {!hasApplicableServerAction ? <p className="room-status-quick-empty">{writeBlock ? "服务端未授权当前操作。" : "当前选区暂无可执行操作。"}</p> : null}
        </>
      )}
      {writeBlock ? <div className="room-status-quick-gate" role="status">
        <p><AlertTriangle aria-hidden="true" size={15} />{writeBlock.reason}</p>
        {writeBlock.kind === "REFRESH" && onRefresh && writeBlock.actionLabel
          ? <button type="button" className="button button-secondary" onClick={() => { runRoomStatusWriteBlockAction(writeBlock, { onRefresh, onOpenRecovery }); }}><RefreshCw aria-hidden="true" size={16} />{writeBlock.actionLabel}</button>
          : writeBlock.kind === "RECOVERY" && onOpenRecovery && writeBlock.actionLabel
            ? <button type="button" className="button button-secondary" onClick={() => { runRoomStatusWriteBlockAction(writeBlock, { onRefresh, onOpenRecovery }); }}><Search aria-hidden="true" size={16} />{writeBlock.actionLabel}</button>
            : null}
      </div> : null}
      <button type="button" className="room-status-quick-history" onClick={() => { onClose("ACTION"); onViewStatus(); }}><FileClock aria-hidden="true" size={17} />查看房态记录</button>
    </div>,
    document.body
  );
}
