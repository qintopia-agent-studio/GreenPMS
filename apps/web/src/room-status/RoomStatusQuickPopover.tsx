import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarPlus2, ClipboardList, FileClock, LockKeyhole, X } from "lucide-react";
import type { RoomStatusActionDto, RoomStatusStatus } from "@qintopia/contracts";
import { formatRoomStatusDate, roomStatusUnitLabel, RoomStatusMark } from "./roomStatusPresentation";
import type { RoomStatusOrderOptionsResult } from "./roomStatusState";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

export interface RoomStatusPopoverPosition {
  left: number;
  top: number;
}

export type RoomStatusQuickPopoverCloseReason = "ACTION" | "DISMISS";

export function roomStatusPopoverViewportEventShouldClose(eventType: string, targetInsidePopover: boolean): boolean {
  return eventType !== "scroll" || !targetInsidePopover;
}

export function roomStatusPopoverPosition(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  viewport: { width: number; height: number },
  popover: { width: number; height: number }
): RoomStatusPopoverPosition {
  const preferredLeft = anchor.right + ANCHOR_GAP;
  const fallbackLeft = anchor.left - popover.width - ANCHOR_GAP;
  const left = preferredLeft + popover.width <= viewport.width - VIEWPORT_MARGIN
    ? preferredLeft
    : fallbackLeft >= VIEWPORT_MARGIN
      ? fallbackLeft
      : Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, viewport.width - popover.width - VIEWPORT_MARGIN));
  const preferredTop = anchor.top;
  const belowTop = anchor.bottom + ANCHOR_GAP;
  const top = preferredTop + popover.height <= viewport.height - VIEWPORT_MARGIN
    ? preferredTop
    : belowTop + popover.height <= viewport.height - VIEWPORT_MARGIN
      ? belowTop
      : Math.max(VIEWPORT_MARGIN, viewport.height - popover.height - VIEWPORT_MARGIN);
  return { left: Math.round(left), top: Math.round(top) };
}

export function RoomStatusQuickPopover({
  anchor,
  unit,
  serviceDate,
  status,
  actions,
  orderOptions,
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
  onCreate: () => void;
  onLockMaintenance: (action: RoomStatusActionDto) => void;
  onViewStatus: () => void;
  onOpenOrder: (option: Extract<RoomStatusOrderOptionsResult, { kind: "READY" }>["orders"][number]) => void;
  onClose: (reason: RoomStatusQuickPopoverCloseReason) => void;
}) {
  const titleId = useId();
  const popoverId = useId();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<RoomStatusPopoverPosition>(() => roomStatusPopoverPosition(
    anchor.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    { width: 320, height: 260 }
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
    const bounds = node.getBoundingClientRect();
    setPosition(roomStatusPopoverPosition(
      anchor.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      { width: bounds.width, height: bounds.height }
    ));
    node.focus({ preventScroll: true });
  }, [anchor]);

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
      style={{ left: position.left, top: position.top }}
      data-testid="room-status-quick-popover"
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
        <div><strong id={titleId}>{roomStatusUnitLabel(unit)}</strong><span>{formatRoomStatusDate(serviceDate)}</span></div>
        <button type="button" className="room-status-icon-button" onClick={() => close(true)} aria-label="关闭快捷操作" title="关闭快捷操作"><X aria-hidden="true" size={17} /></button>
      </header>
      <div className="room-status-quick-status"><span>当前状态</span><RoomStatusMark status={status} compact /></div>
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
        <div className="room-status-quick-actions">
          {createAvailable ? <button type="button" className="button button-primary" onClick={() => { onClose("ACTION"); onCreate(); }}><CalendarPlus2 aria-hidden="true" size={17} />创建住宿</button> : null}
          {maintenanceAction ? <button type="button" className="button button-secondary" onClick={() => { onClose("ACTION"); onLockMaintenance(maintenanceAction); }}><LockKeyhole aria-hidden="true" size={17} />维修锁房</button> : null}
        </div>
      )}
      <button type="button" className="room-status-quick-history" onClick={() => { onClose("ACTION"); onViewStatus(); }}><FileClock aria-hidden="true" size={17} />查看房态记录</button>
    </div>,
    document.body
  );
}
