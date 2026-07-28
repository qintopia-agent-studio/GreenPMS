import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarPlus2, ClipboardList, FileClock, LockKeyhole, X } from "lucide-react";
import type { RoomStatusActionDto, RoomStatusStatus } from "@qintopia/contracts";
import { formatRoomStatusDate, roomStatusUnitLabel, RoomStatusMark } from "./roomStatusPresentation";
import type { RoomStatusOrderOptionsResult, RoomStatusSelection } from "./roomStatusState";

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

export function roomStatusPopoverViewportEventShouldClose(eventType: string, targetInsidePopover: boolean): boolean {
  return eventType !== "scroll" || !targetInsidePopover;
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

export function RoomStatusQuickPopover({
  anchor,
  unit,
  serviceDate,
  status,
  actions,
  orderOptions,
  selection,
  onCreate,
  onLockMaintenance,
  onViewStatus,
  onOpenOrder,
  onClose
}: {
  anchor: HTMLElement;
  unit: Parameters<typeof roomStatusUnitLabel>[0];
  serviceDate: string;
  status: RoomStatusStatus;
  actions: readonly RoomStatusActionDto[];
  orderOptions: RoomStatusOrderOptionsResult;
  selection?: RoomStatusSelection;
  onCreate: () => void;
  onLockMaintenance: (action: RoomStatusActionDto) => void;
  onViewStatus: () => void;
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

  const createAvailable = actions.some((action) => action.enabled
    && (action.code === "CREATE_ORDER" || action.code === "CREATE_FREE_STAY"));
  const maintenanceAction = actions.find((action) => action.enabled && action.code === "LOCK_MAINTENANCE");
  const dateLabel = selection
    ? `${formatRoomStatusDate(selection.arrivalDate)}至${formatRoomStatusDate(selection.departureDate)}`
    : formatRoomStatusDate(serviceDate);
  const rangeLabel = selection
    ? `${selectionNights(selection)}晚 · ${createAvailable || maintenanceAction ? "可办理" : "暂无可办操作"}`
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

  useLayoutEffect(() => {
    const node = popoverRef.current;
    if (!node) return;
    reposition();
    const resizeObserver = new ResizeObserver(reposition);
    resizeObserver.observe(node);
    const frame = requestAnimationFrame(reposition);
    node.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [reposition]);

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
      if (!roomStatusPopoverViewportEventShouldClose(event.type, targetInsidePopover)) return;
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
            {selection ? <span>{rangeLabel}</span> : <RoomStatusMark status={status} compact />}
          </span>
        </div>
        <button type="button" className="room-status-icon-button" onClick={() => close(true)} aria-label="关闭快捷操作" title="关闭快捷操作"><X aria-hidden="true" size={17} /></button>
      </header>
      {orderOptions.kind === "INVALID_REFERENCE" ? (
        <p className="room-status-quick-error" role="alert">当前住宿缺少唯一、稳定的订单引用。请刷新房态后重试。</p>
      ) : orderOptions.orders.length ? (
        <div className="room-status-quick-orders" aria-label="当前订单列表">
          {orderOptions.orders.map((option) => (
            <button key={`${option.identity.orderId}:${option.identity.stayId}`} type="button" onClick={() => { onClose("ACTION"); onOpenOrder(option); }}>
              <ClipboardList aria-hidden="true" size={17} /><span><strong>{option.label}</strong><small>{formatRoomStatusDate(option.identity.arrivalDate)} 至 {formatRoomStatusDate(option.identity.departureDate)}</small></span>
            </button>
          ))}
        </div>
      ) : (
        createAvailable || maintenanceAction ? (
          <div className="room-status-quick-actions">
            {createAvailable ? <button type="button" className="button button-primary" onClick={() => { onClose("ACTION"); onCreate(); }}><CalendarPlus2 aria-hidden="true" size={17} />创建住宿</button> : null}
            {maintenanceAction ? <button type="button" className="button button-secondary" onClick={() => { onClose("ACTION"); onLockMaintenance(maintenanceAction); }}><LockKeyhole aria-hidden="true" size={17} />维修锁房</button> : null}
          </div>
        ) : <p className="room-status-quick-empty">当前选区暂无可执行操作。</p>
      )}
      <button type="button" className="room-status-quick-history" onClick={() => { onClose("ACTION"); onViewStatus(); }}><FileClock aria-hidden="true" size={17} />查看房态记录</button>
    </div>,
    document.body
  );
}
