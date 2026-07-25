import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Hand,
  Layers3,
  SearchX
} from "lucide-react";
import type {
  RoomStatusBedOccupancyDto,
  RoomStatusBoardDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import {
  addLocalDateDays,
  dateWindowStartForFocus,
  filterRoomStatusRooms,
  hasActiveRoomStatusFilters,
  intervalsRenderedOnRoomStatusGrid,
  moveRoomStatusFocus,
  roomStatusCellBelongsToStay,
  selectionFromCells,
  shiftDateWindowStart,
  visibleDateWindow,
  type RoomStatusCellFocus,
  type RoomStatusDateWindowMode,
  type RoomStatusFilters,
  type RoomStatusScrollAnchor,
  type RoomStatusSelection
} from "./roomStatusState";
import {
  formatRoomStatusDate,
  roomStatusBedOccupantLabel,
  roomStatusBedOccupantLabels,
  roomStatusIntervalBusinessLabel,
  roomStatusIntervalGridLabel,
  roomStatusIntervalOccupantLabels,
  roomStatusOccupancyCapacity,
  roomStatusOccupantLabelLines,
  roomStatusPresentation,
  roomStatusRowSalesLabel,
  roomStatusSourceLabels,
  roomStatusUnitDescription,
  roomStatusUnitLabel,
  roomStatusUnitLocationLabel,
  RoomStatusMark,
  RoomStatusWarning,
  useRoomStatusMobileViewport
} from "./roomStatusPresentation";

interface PositionedInterval {
  interval: RoomStatusIntervalDto;
  startColumn: number;
  endColumn: number;
  lane: number;
}

interface RenderedUnit {
  unit: RoomStatusUnitDto;
  parent: RoomStatusUnitDto | null;
  depth: 0 | 1;
}

interface BedOccupancyTooltipState {
  text: string;
  left: number;
  top: number;
  maxHeight: number;
  placement: "ABOVE" | "BELOW";
}

interface PointerSelectionState {
  pointerId: number;
  unitId: string;
  anchorDate: string;
  lastServiceDate: string;
  selection: RoomStatusSelection;
  touch: boolean;
  row: HTMLElement;
  sourceCell: HTMLDivElement;
  unit: RoomStatusUnitDto;
  day: RoomStatusDayDto | null;
}

const roomStatusWeekdayFormatter = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" });

export interface RoomStatusGridProps {
  board: RoomStatusBoardDto;
  filters: RoomStatusFilters;
  expandedRoomIds: readonly string[];
  focusedCell: RoomStatusCellFocus | null;
  selection: RoomStatusSelection | null;
  selectedStayId?: string | null;
  dateWindowStart: number;
  dateWindowSize: number;
  dateWindowMode: RoomStatusDateWindowMode;
  todayDate?: string;
  initialScrollAnchor?: RoomStatusScrollAnchor | null;
  restoreFocus?: boolean;
  focusRequestToken?: number;
  onToggleRoom: (roomId: string) => void;
  onFocusedCellChange: (focus: RoomStatusCellFocus) => void;
  onSelectionChange: (selection: RoomStatusSelection | null) => void;
  onPageChange: (pageIndex: number) => void;
  onDateWindowChange: (start: number) => void;
  onDateWindowModeChange: (mode: RoomStatusDateWindowMode) => void;
  onInspectUnit: (unit: RoomStatusUnitDto) => void;
  onInspectDay: (unit: RoomStatusUnitDto, day: RoomStatusDayDto | null) => void;
  onInspectInterval: (unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto) => void;
  onClearFilters: () => void;
  onScrollAnchorChange?: (anchor: RoomStatusScrollAnchor) => void;
}

function intervalsForWindow(intervals: readonly RoomStatusIntervalDto[], dates: readonly string[]): PositionedInterval[] {
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate) return [];
  const visibleDeparture = addLocalDateDays(lastDate, 1);
  const candidates = intervals
    .filter((interval) => interval.startDate < visibleDeparture && interval.endDate > firstDate)
    .map((interval) => {
      const clippedStart = interval.startDate <= firstDate ? firstDate : interval.startDate;
      const clippedEnd = interval.endDate >= visibleDeparture ? visibleDeparture : interval.endDate;
      const startColumn = Math.max(0, dates.findIndex((date) => date >= clippedStart));
      const exactEnd = dates.findIndex((date) => date >= clippedEnd);
      const endColumn = exactEnd < 0 ? dates.length : exactEnd;
      return { interval, startColumn, endColumn };
    })
    .filter(({ startColumn, endColumn }) => endColumn > startColumn)
    .sort((left, right) => left.startColumn - right.startColumn || right.endColumn - left.endColumn || left.interval.id.localeCompare(right.interval.id));

  const laneEnds: number[] = [];
  return candidates.map((candidate) => {
    const availableLane = laneEnds.findIndex((laneEnd) => laneEnd <= candidate.startColumn);
    const lane = availableLane < 0 ? laneEnds.length : availableLane;
    laneEnds[lane] = candidate.endColumn;
    return { ...candidate, lane };
  });
}

function bedOccupancyDescription(
  occupancy: RoomStatusBedOccupancyDto,
  unit?: RoomStatusUnitDto,
  serviceDate = occupancy.serviceDate
): string {
  const occupants = occupancy.occupants
    .map((occupant) => {
      const source = unit?.intervals.find((interval) => interval.actualInventoryUnitId === occupant.inventoryUnitId
        && interval.startDate <= serviceDate
        && serviceDate < interval.endDate
        && interval.references.some((reference) => reference.type === "ORDER" && reference.id === occupant.sourceReference.id));
      const details = source
        ? `（${roomStatusSourceLabels[source.sourceKind]} · ${roomStatusPresentation[source.status].label} · ${formatRoomStatusDate(serviceDate)}）`
        : `（${formatRoomStatusDate(serviceDate)}）`;
      return `${occupant.inventoryUnitCode}：${roomStatusBedOccupantLabel(occupant)}${details}`;
    })
    .join("；");
  return `已占 ${occupancy.occupiedBedCount}/${occupancy.totalBedCount}${occupants ? `；住宿人：${occupants}` : ""}`;
}

export function roomStatusCellAccessibleName(
  unit: RoomStatusUnitDto,
  serviceDate: string,
  day: RoomStatusDayDto | null,
  bedOccupancy: RoomStatusBedOccupancyDto | null
): string {
  if (!day) return `${roomStatusUnitLabel(unit)}，${formatRoomStatusDate(serviceDate)}，状态未知，服务端未返回逐日事实`;
  const status = roomStatusPresentation[day.status].label;
  const intervals = unit.intervals.filter((interval) => day.intervalIds.includes(interval.id));
  const sources = intervals.map((interval) => [
    roomStatusSourceLabels[interval.sourceKind],
    roomStatusIntervalBusinessLabel(interval),
    roomStatusPresentation[interval.status].label
  ].filter(Boolean).join(" "));
  const conflicts = day.conflicts.length ? ["已有住宿，不能重复安排"] : [];
  const availability = day.available ? "可以安排" : "当前不可安排";
  const occupancy = bedOccupancy ? bedOccupancyDescription(bedOccupancy, unit, serviceDate) : null;
  return [roomStatusUnitLabel(unit), formatRoomStatusDate(serviceDate), status, availability, occupancy, ...sources, ...conflicts]
    .filter(Boolean)
    .join("，");
}

function isCellSelected(selection: RoomStatusSelection | null, unitId: string, serviceDate: string): boolean {
  return Boolean(selection
    && selection.unitId === unitId
    && serviceDate >= selection.arrivalDate
    && serviceDate < selection.departureDate);
}

export function rowDescription(unit: RoomStatusUnitDto): string {
  const kind = unit.kind === "ROOM" ? "房间" : "床位";
  return `${kind}，${roomStatusRowSalesLabel(unit)}，容纳 ${roomStatusOccupancyCapacity(unit)} 人`;
}

const tabbableSelector = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]"
].join(",");

function isTabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(":disabled")) return false;
  if (element.closest("[hidden], [inert]")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function focusNextTabStop(trigger: HTMLElement, excludedRoot: HTMLElement | null): boolean {
  const tabStops = [...document.querySelectorAll<HTMLElement>(tabbableSelector)]
    .filter((element) => !excludedRoot?.contains(element) && isTabbable(element));
  const triggerIndex = tabStops.indexOf(trigger);
  const next = triggerIndex >= 0 ? tabStops[triggerIndex + 1] : null;
  if (!next) return false;
  next.focus({ preventScroll: false });
  return document.activeElement === next;
}

export function RoomStatusGrid({
  board,
  filters,
  expandedRoomIds,
  focusedCell,
  selection,
  selectedStayId = null,
  dateWindowStart,
  dateWindowSize,
  dateWindowMode,
  todayDate,
  initialScrollAnchor,
  restoreFocus = false,
  focusRequestToken = 0,
  onToggleRoom,
  onFocusedCellChange,
  onSelectionChange,
  onPageChange,
  onDateWindowChange,
  onDateWindowModeChange,
  onInspectUnit,
  onInspectDay,
  onInspectInterval,
  onClearFilters,
  onScrollAnchorChange
}: RoomStatusGridProps) {
  const isMobile = useRoomStatusMobileViewport();
  const scrollRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerSelection = useRef<PointerSelectionState | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollRestored = useRef(false);
  const focusRestored = useRef(false);
  const lastFocusRequestToken = useRef(focusRequestToken);
  const pendingKeyboardFocus = useRef<RoomStatusCellFocus | null>(null);
  const [touchSelectionMode, setTouchSelectionMode] = useState(false);
  const [draggingUnitId, setDraggingUnitId] = useState<string | null>(null);
  const [pointerPreviewSelection, setPointerPreviewSelection] = useState<RoomStatusSelection | null>(null);
  const [bedOccupancyTooltip, setBedOccupancyTooltip] = useState<BedOccupancyTooltipState | null>(null);
  const bedOccupancyTooltipDismissTimer = useRef<number | null>(null);
  const bedOccupancyTooltipRef = useRef<HTMLDivElement>(null);
  const bedOccupancyTooltipTriggerRef = useRef<HTMLDivElement | null>(null);
  const suppressBedOccupancyTooltipFocusRef = useRef<HTMLDivElement | null>(null);
  const finishPointerSelection = useCallback((pointerId?: number, commit = false) => {
    const active = pointerSelection.current;
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return false;
    pointerSelection.current = null;
    if (active.sourceCell.hasPointerCapture(active.pointerId)) {
      try {
        active.sourceCell.releasePointerCapture(active.pointerId);
      } catch {
        // The browser may release capture while this handler is running.
      }
    }
    setDraggingUnitId(null);
    setPointerPreviewSelection(null);
    if (active.touch) setTouchSelectionMode(false);
    if (commit && active.lastServiceDate === active.anchorDate) onInspectDay(active.unit, active.day);
    else if (commit) onSelectionChange(active.selection);
    return true;
  }, [onInspectDay, onSelectionChange]);
  const cancelBedOccupancyTooltipDismiss = useCallback(() => {
    if (bedOccupancyTooltipDismissTimer.current === null) return;
    window.clearTimeout(bedOccupancyTooltipDismissTimer.current);
    bedOccupancyTooltipDismissTimer.current = null;
  }, []);
  const closeBedOccupancyTooltip = useCallback(() => {
    cancelBedOccupancyTooltipDismiss();
    bedOccupancyTooltipTriggerRef.current = null;
    suppressBedOccupancyTooltipFocusRef.current = null;
    setBedOccupancyTooltip(null);
  }, [cancelBedOccupancyTooltipDismiss]);
  const pageRooms = useMemo(() => board.rooms.slice(0, Math.max(0, board.page.size)), [board.page.size, board.rooms]);
  const filteredRooms = useMemo(() => filterRoomStatusRooms(pageRooms, filters), [filters, pageRooms]);
  const dates = useMemo(
    () => visibleDateWindow(board.dates, dateWindowStart, dateWindowSize),
    [board.dates, dateWindowSize, dateWindowStart]
  );
  const renderedUnits = useMemo<RenderedUnit[]>(() => filteredRooms.flatMap(({ room, children }) => {
    const rows: RenderedUnit[] = [{ unit: room, parent: null, depth: 0 }];
    if (room.salesMode === "BED_SPLIT" && expandedRoomIds.includes(room.id)) {
      rows.push(...children.map((child): RenderedUnit => ({ unit: child, parent: room, depth: 1 })));
    }
    return rows;
  }), [expandedRoomIds, filteredRooms]);
  const positionedByUnit = useMemo(() => new Map(renderedUnits.map(({ unit }) => [
    unit.id,
    intervalsForWindow(intervalsRenderedOnRoomStatusGrid(unit, dates), dates)
  ])), [dates, renderedUnits]);
  const dayByCell = useMemo(() => {
    const visibleDates = new Set(dates);
    return new Map(renderedUnits.flatMap(({ unit }) => unit.days
      .filter((day) => visibleDates.has(day.serviceDate))
      .map((day) => [`${unit.id}:${day.serviceDate}`, day] as const)));
  }, [dates, renderedUnits]);
  const bedOccupancyByCell = useMemo(() => {
    const occupancyByCell = new Map<string, RoomStatusBedOccupancyDto>();
    const visibleDates = new Set(dates);
    for (const { unit } of renderedUnits) {
      if (unit.kind !== "ROOM" || unit.salesMode !== "BED_SPLIT") continue;
      for (const occupancy of unit.bedOccupancies) {
        if (visibleDates.has(occupancy.serviceDate)) {
          occupancyByCell.set(`${unit.id}:${occupancy.serviceDate}`, occupancy);
        }
      }
    }
    return occupancyByCell;
  }, [dates, renderedUnits]);
  const unitIds = useMemo(() => renderedUnits.map(({ unit }) => unit.id), [renderedUnits]);
  const tooltipContextKey = `${dates.join(",")}|${unitIds.join(",")}`;
  const firstCell = unitIds[0] && dates[0] ? { unitId: unitIds[0], serviceDate: dates[0] } : null;
  const effectiveFocus = focusedCell && unitIds.includes(focusedCell.unitId) && dates.includes(focusedCell.serviceDate)
    ? focusedCell
    : firstCell;
  const firstVisibleDate = dates[0];
  const lastVisibleDate = dates.at(-1);
  const clampedWindowStart = board.dates.indexOf(firstVisibleDate ?? "");
  const previousWindowStart = shiftDateWindowStart(board.dates.length, Math.max(0, clampedWindowStart), dateWindowSize, -1);
  const nextWindowStart = shiftDateWindowStart(board.dates.length, Math.max(0, clampedWindowStart), dateWindowSize, 1);

  useEffect(() => {
    scrollRestored.current = false;
    focusRestored.current = false;
    lastFocusRequestToken.current = focusRequestToken;
  }, [board.propertyId]);

  useEffect(() => {
    if (isMobile) return;
    if (scrollRestored.current || !initialScrollAnchor || !scrollRef.current) return;
    scrollRestored.current = true;
    const scroll = scrollRef.current;
    let top = initialScrollAnchor.top;
    if (initialScrollAnchor.unitId) {
      const row = [...scroll.querySelectorAll<HTMLElement>("[data-room-status-row]")]
        .find((candidate) => candidate.dataset.roomStatusRow === initialScrollAnchor.unitId);
      if (row) top = row.offsetTop - 42;
    }
    scroll.scrollTo({ left: initialScrollAnchor.left, top, behavior: "auto" });
  }, [initialScrollAnchor, isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const restorationRequested = restoreFocus && !focusRestored.current;
    const explicitRequest = focusRequestToken !== lastFocusRequestToken.current;
    if ((!restorationRequested && !explicitRequest) || !effectiveFocus) return;
    const frame = requestAnimationFrame(() => {
      if (restorationRequested) focusRestored.current = true;
      lastFocusRequestToken.current = focusRequestToken;
      const cell = cellRefs.current.get(`${effectiveFocus.unitId}:${effectiveFocus.serviceDate}`);
      if (cell) {
        if (!focusedCell
          || focusedCell.unitId !== effectiveFocus.unitId
          || focusedCell.serviceDate !== effectiveFocus.serviceDate) onFocusedCellChange(effectiveFocus);
        cell.focus({ preventScroll: false });
      }
      else scrollRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [effectiveFocus, focusRequestToken, focusedCell, isMobile, onFocusedCellChange, restoreFocus]);

  useEffect(() => {
    if (isMobile || !pendingKeyboardFocus.current) return;
    const pending = pendingKeyboardFocus.current;
    const frame = requestAnimationFrame(() => {
      const cell = cellRefs.current.get(`${pending.unitId}:${pending.serviceDate}`);
      if (!cell) return;
      pendingKeyboardFocus.current = null;
      cell.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [dateWindowStart, dates, isMobile]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const active = pointerSelection.current;
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      const target = [...active.row.querySelectorAll<HTMLElement>("[data-room-status-cell='true']")]
        .find((cell) => {
          const bounds = cell.getBoundingClientRect();
          return event.clientX >= bounds.left && event.clientX < bounds.right;
        });
      const serviceDate = target?.dataset.serviceDate;
      if (!serviceDate || serviceDate === active.lastServiceDate) return;
      active.lastServiceDate = serviceDate;
      active.selection = selectionFromCells(active.unitId, active.anchorDate, serviceDate);
      setPointerPreviewSelection(active.selection);
    };
    const handlePointerUp = (event: PointerEvent) => finishPointerSelection(event.pointerId, true);
    const handlePointerCancel = (event: PointerEvent) => finishPointerSelection(event.pointerId);
    const handleWindowBlur = () => finishPointerSelection();
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("lostpointercapture", handlePointerCancel, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("lostpointercapture", handlePointerCancel, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [finishPointerSelection, onSelectionChange]);

  useEffect(() => () => {
    pointerSelection.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    if (bedOccupancyTooltipDismissTimer.current !== null) {
      window.clearTimeout(bedOccupancyTooltipDismissTimer.current);
    }
  }, []);

  useEffect(() => {
    closeBedOccupancyTooltip();
  }, [board.revision, closeBedOccupancyTooltip, tooltipContextKey]);

  useEffect(() => {
    const closeForDetachedPosition = (event: Event) => {
      const eventTarget = event.target;
      if (event.type === "scroll"
        && eventTarget instanceof Node
        && bedOccupancyTooltipRef.current?.contains(eventTarget)) return;
      closeBedOccupancyTooltip();
    };
    window.addEventListener("scroll", closeForDetachedPosition, true);
    window.addEventListener("resize", closeForDetachedPosition);
    return () => {
      window.removeEventListener("scroll", closeForDetachedPosition, true);
      window.removeEventListener("resize", closeForDetachedPosition);
    };
  }, [closeBedOccupancyTooltip]);

  if (isMobile) return null;

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>, rowDelta: number, columnDelta: number) => {
    event.preventDefault();
    const current = { unitId: event.currentTarget.dataset.unitId!, serviceDate: event.currentTarget.dataset.serviceDate! };
    const next = moveRoomStatusFocus(unitIds, board.dates, current, rowDelta, columnDelta);
    if (!next) return;
    const targetWindowStart = dateWindowStartForFocus(board.dates, clampedWindowStart, dateWindowSize, next.serviceDate);
    const windowChanges = targetWindowStart !== clampedWindowStart;
    if (windowChanges) {
      pendingKeyboardFocus.current = next;
      onDateWindowChange(targetWindowStart);
    }
    onFocusedCellChange(next);
    if (event.shiftKey) {
      const anchorDate = selection?.unitId === next.unitId ? selection.anchorDate : current.serviceDate;
      onSelectionChange(selectionFromCells(next.unitId, anchorDate, next.serviceDate));
    }
    if (!windowChanges) requestAnimationFrame(() => cellRefs.current.get(`${next.unitId}:${next.serviceDate}`)?.focus());
  };

  const handleCellKeyDown = (event: KeyboardEvent<HTMLDivElement>, unit: RoomStatusUnitDto, day: RoomStatusDayDto | null) => {
    const ownsTooltip = Boolean(bedOccupancyTooltip
      && bedOccupancyTooltipTriggerRef.current === event.currentTarget);
    if (event.key === "Tab" && !event.shiftKey && ownsTooltip) {
      event.preventDefault();
      requestAnimationFrame(() => bedOccupancyTooltipRef.current?.focus({ preventScroll: true }));
      return;
    }
    if (event.key === "ArrowLeft") return moveFocus(event, 0, -1);
    if (event.key === "ArrowRight") return moveFocus(event, 0, 1);
    if (event.key === "ArrowUp") return moveFocus(event, -1, 0);
    if (event.key === "ArrowDown") return moveFocus(event, 1, 0);
    if (event.key === "Escape") {
      event.preventDefault();
      if (ownsTooltip) {
        closeBedOccupancyTooltip();
        return;
      }
      finishPointerSelection();
      onSelectionChange(null);
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      const serviceDate = event.currentTarget.dataset.serviceDate!;
      const anchorDate = event.shiftKey && selection?.unitId === unit.id ? selection.anchorDate : serviceDate;
      onSelectionChange(selectionFromCells(unit.id, anchorDate, serviceDate));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onInspectDay(unit, day);
    }
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    unit: RoomStatusUnitDto,
    serviceDate: string,
    day: RoomStatusDayDto | null
  ) => {
    if (event.button !== 0) return;
    const touch = event.pointerType === "touch";
    if (touch && !touchSelectionMode) {
      event.preventDefault();
      onFocusedCellChange({ unitId: unit.id, serviceDate });
      onInspectDay(unit, day);
      event.currentTarget.focus();
      closeBedOccupancyTooltip();
      return;
    }
    event.preventDefault();
    const row = event.currentTarget.closest<HTMLElement>("[data-room-status-row]");
    if (!row) return;
    const nextPointerSelection: PointerSelectionState = {
      pointerId: event.pointerId,
      unitId: unit.id,
      anchorDate: serviceDate,
      lastServiceDate: serviceDate,
      selection: selectionFromCells(unit.id, serviceDate, serviceDate),
      touch,
      row,
      sourceCell: event.currentTarget,
      unit,
      day
    };
    pointerSelection.current = nextPointerSelection;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events used by assistive and test tooling may not own a native pointer.
    }
    setDraggingUnitId(unit.id);
    setPointerPreviewSelection(nextPointerSelection.selection);
    onFocusedCellChange({ unitId: unit.id, serviceDate });
    event.currentTarget.focus();
    closeBedOccupancyTooltip();
  };

  const scheduleBedOccupancyTooltipDismiss = () => {
    cancelBedOccupancyTooltipDismiss();
    bedOccupancyTooltipDismissTimer.current = window.setTimeout(() => {
      bedOccupancyTooltipDismissTimer.current = null;
      const activeElement = document.activeElement;
      if (activeElement === bedOccupancyTooltipTriggerRef.current
        || (activeElement instanceof Node && bedOccupancyTooltipRef.current?.contains(activeElement))) return;
      closeBedOccupancyTooltip();
    }, 180);
  };

  const showBedOccupancyTooltip = (target: HTMLElement, text: string) => {
    cancelBedOccupancyTooltipDismiss();
    bedOccupancyTooltipTriggerRef.current = target as HTMLDivElement;
    const bounds = target.getBoundingClientRect();
    const viewportMargin = 12;
    const gap = 7;
    const maximumWidth = Math.max(1, Math.min(320, window.innerWidth - viewportMargin * 2));
    const halfWidth = maximumWidth / 2;
    const left = Math.min(
      window.innerWidth - viewportMargin - halfWidth,
      Math.max(viewportMargin + halfWidth, bounds.left + bounds.width / 2)
    );
    const estimatedLines = Math.max(2, Math.ceil(text.length / 25));
    const estimatedHeight = 30 + estimatedLines * 18;
    const availableBelow = Math.max(1, window.innerHeight - bounds.bottom - gap - viewportMargin);
    const availableAbove = Math.max(1, bounds.top - gap - viewportMargin);
    const placement = estimatedHeight <= availableBelow
      ? "BELOW"
      : estimatedHeight <= availableAbove || availableAbove >= availableBelow ? "ABOVE" : "BELOW";
    const maxHeight = Math.floor(placement === "BELOW" ? availableBelow : availableAbove);
    setBedOccupancyTooltip({
      text,
      left,
      top: placement === "BELOW" ? bounds.bottom + gap : bounds.top - gap,
      maxHeight,
      placement
    });
  };

  const handleScroll = () => {
    closeBedOccupancyTooltip();
    if (!scrollRef.current || !onScrollAnchorChange || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const scroll = scrollRef.current;
      if (!scroll) return;
      const firstVisibleRow = [...scroll.querySelectorAll<HTMLElement>("[data-room-status-row]")]
        .find((row) => row.offsetTop + row.offsetHeight > scroll.scrollTop + 42);
      onScrollAnchorChange({
        unitId: firstVisibleRow?.dataset.roomStatusRow ?? null,
        left: scroll.scrollLeft,
        top: scroll.scrollTop
      });
    });
  };

  if (!dates.length) {
    return (
      <section className="room-status-grid-empty" aria-labelledby="room-status-no-dates">
        <Layers3 aria-hidden="true" size={22} />
        <h2 id="room-status-no-dates">当前查询没有逐日房态</h2>
        <p>请选择至少一个住宿夜，并重新查询服务端房态。</p>
      </section>
    );
  }

  if (!renderedUnits.length) {
    const filtered = hasActiveRoomStatusFilters(filters);
    return (
      <section
        className="room-status-grid-empty"
        aria-labelledby="room-status-no-rooms"
        data-room-status-state={filtered ? "filtered-empty" : "empty"}
      >
        <SearchX aria-hidden="true" size={22} />
        <h2 id="room-status-no-rooms">{filtered ? "没有符合筛选的房间" : "当前页没有库存单元"}</h2>
        <p>{filtered ? "调整筛选条件，或清除筛选查看当前页的全部房间。" : "可切换房间分页或刷新房态。"}</p>
        {filtered ? <button type="button" className="room-status-button" onClick={onClearFilters}>清除筛选</button> : null}
      </section>
    );
  }

  const gridStyle = {
    "--room-status-date-count": dates.length,
    "--room-status-interval-lanes": 1
  } as CSSProperties;

  return (
    <section
      className={`room-status-grid-section${touchSelectionMode ? " is-touch-selection" : ""}${draggingUnitId ? " is-drag-selecting" : ""}`}
      aria-labelledby="room-status-grid-heading"
      data-testid="room-status-board-range"
      data-range-arrival={board.range.arrivalDate}
      data-range-departure={board.range.departureDate}
    >
      <header className="room-status-grid-section-header">
        <div>
          <h2 id="room-status-grid-heading">房间与床位逐日房态</h2>
          <p>{formatRoomStatusDate(firstVisibleDate!)}至{formatRoomStatusDate(addLocalDateDays(lastVisibleDate!, 1))}，日期为半开区间</p>
        </div>
        <div className="room-status-window-controls" aria-label="可见日期窗口">
          <button
            type="button"
            className="room-status-button room-status-button-secondary room-status-touch-selection-toggle"
            aria-pressed={touchSelectionMode}
            onClick={() => setTouchSelectionMode((enabled) => !enabled)}
          >
            <Hand aria-hidden="true" size={16} />{touchSelectionMode ? "正在选择" : "触控选区"}
          </button>
          <div className="room-status-window-mode-control" role="group" aria-label="每屏显示天数">
            {(["AUTO", "7", "14", "21"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`date-window-mode-${mode.toLowerCase()}`}
                aria-pressed={dateWindowMode === mode}
                title={mode === "AUTO" ? "根据房态表宽度自动显示" : `每屏显示 ${mode} 天`}
                onClick={() => onDateWindowModeChange(mode)}
              >
                {mode === "AUTO" ? "自动" : mode}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="room-status-icon-button"
            aria-label="向前移动可见日期"
            title="向前移动可见日期"
            disabled={previousWindowStart === Math.max(0, clampedWindowStart)}
            onClick={() => onDateWindowChange(previousWindowStart)}
          >
            <ChevronsLeft aria-hidden="true" size={17} />
          </button>
          <span>{dates.length} 夜</span>
          <button
            type="button"
            className="room-status-icon-button"
            aria-label="向后移动可见日期"
            title="向后移动可见日期"
            disabled={nextWindowStart === Math.max(0, clampedWindowStart)}
            onClick={() => onDateWindowChange(nextWindowStart)}
          >
            <ChevronsRight aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      {board.projectionState === "PARTIAL" ? (
        <div className="room-status-grid-notice" role="status">
          <RoomStatusWarning>投影不完整。页面保留已返回事实，但不能把缺失内容解释为可售。</RoomStatusWarning>
        </div>
      ) : null}

      <div
        className="room-status-grid-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label="房态二维网格，可使用方向键移动，Shift 加方向键扩展选区"
        tabIndex={0}
      >
        <div className="room-status-grid" role="grid" aria-rowcount={renderedUnits.length + 1} aria-colcount={dates.length + 1} style={gridStyle}>
          <div className="room-status-grid-header" role="row">
            <div className="room-status-resource-header" role="columnheader">房源</div>
            <div className="room-status-date-header-track" role="presentation">
              {dates.map((date) => {
                const parsed = new Date(`${date}T00:00:00Z`);
                const weekDay = roomStatusWeekdayFormatter.format(parsed);
                return (
                  <div key={date} className={`room-status-date-header${date === todayDate ? " is-today" : ""}`} role="columnheader" aria-label={`${formatRoomStatusDate(date)} ${weekDay}`}>
                    <strong>{date.slice(5)}</strong>
                    <span>{date === todayDate ? "今天" : weekDay}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {renderedUnits.map(({ unit, depth }, rowIndex) => {
            const canExpand = depth === 0 && unit.salesMode === "BED_SPLIT" && unit.children.length > 0;
            const expanded = canExpand && expandedRoomIds.includes(unit.id);
            const positionedIntervals = positionedByUnit.get(unit.id) ?? [];
            const intervalsByStartColumn = new Map<number, typeof positionedIntervals>();
            for (const positioned of positionedIntervals) {
              const intervals = intervalsByStartColumn.get(positioned.startColumn) ?? [];
              intervals.push(positioned);
              intervalsByStartColumn.set(positioned.startColumn, intervals);
            }
            const rowLanes = Math.max(1, ...positionedIntervals.map((item) => item.lane + 1));
            return (
              <div
                className={`room-status-grid-row room-status-grid-row-depth-${depth}${draggingUnitId === unit.id ? " is-drag-source-row" : ""}`}
                role="row"
                key={unit.id}
                data-room-status-row={unit.id}
                aria-rowindex={rowIndex + 2}
                style={{ "--room-status-interval-lanes": rowLanes } as CSSProperties}
              >
                <div className="room-status-resource-cell" role="rowheader">
                  {canExpand ? (
                    <button
                      type="button"
                      className="room-status-expand-button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "收起" : "展开"}${roomStatusUnitLabel(unit)}床位`}
                      title={`${expanded ? "收起" : "展开"}床位`}
                      onClick={() => onToggleRoom(unit.id)}
                    >
                      {expanded ? <ChevronDown aria-hidden="true" size={17} /> : <ChevronRight aria-hidden="true" size={17} />}
                    </button>
                  ) : <span className="room-status-expand-spacer" aria-hidden="true" />}
                  <button type="button" className="room-status-resource-detail" onClick={() => onInspectUnit(unit)}>
                    <strong>{roomStatusUnitLocationLabel(unit)}</strong>
                    <span>{roomStatusUnitDescription(unit)}</span>
                    <small>{rowDescription(unit)}</small>
                  </button>
                </div>
                <div className="room-status-day-track" role="presentation">
                  {dates.map((date, columnIndex) => {
                    const day = dayByCell.get(`${unit.id}:${date}`) ?? null;
                    const status = day?.status ?? "UNKNOWN";
                    const bedOccupancy = bedOccupancyByCell.get(`${unit.id}:${date}`) ?? null;
                    const bedOccupancyRatio = bedOccupancy
                      ? `${bedOccupancy.occupiedBedCount}/${bedOccupancy.totalBedCount}`
                      : null;
                    const bedOccupancyTooltipText = bedOccupancy ? bedOccupancyDescription(bedOccupancy, unit, date) : undefined;
                    const directLodging = unit.intervals.find((interval) => (
                      interval.actualInventoryUnitId === unit.id
                      && interval.startDate <= date
                      && date < interval.endDate
                      && (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY")
                      && interval.occupantCount > 0
                    )) ?? null;
                    const directOccupantLabels = directLodging ? roomStatusIntervalOccupantLabels(directLodging) : [];
                    const selected = isCellSelected(pointerPreviewSelection ?? selection, unit.id, date)
                      || (!pointerPreviewSelection && selectedStayId ? roomStatusCellBelongsToStay(unit, date, selectedStayId) : false);
                    const focusable = effectiveFocus?.unitId === unit.id && effectiveFocus.serviceDate === date;
                    const startingIntervals = intervalsByStartColumn.get(columnIndex) ?? [];
                    return (
                      <div
                        role="gridcell"
                        aria-rowindex={rowIndex + 2}
                        aria-colindex={columnIndex + 2}
                        aria-selected={selected}
                        aria-label={roomStatusCellAccessibleName(unit, date, day, bedOccupancy)}
                        tabIndex={focusable ? 0 : -1}
                        key={date}
                        data-room-status-cell="true"
                        data-unit-id={unit.id}
                        data-service-date={date}
                        data-bed-occupancy-ratio={bedOccupancyRatio ?? undefined}
                        className={`room-status-day-cell room-status-day-${status.toLowerCase().replaceAll("_", "-")}${selected ? " is-selected" : ""}${selectedStayId && roomStatusCellBelongsToStay(unit, date, selectedStayId) ? " is-stay-selected" : ""}${date === todayDate ? " is-today" : ""}${!day?.available ? " is-authoritatively-unavailable" : ""}${day?.conflicts.length ? " has-blocking-conflict" : ""}${startingIntervals.length ? " has-source-interval" : ""}${bedOccupancy ? " has-bed-occupancy" : ""}${directLodging ? " has-direct-lodging" : ""}`}
                        ref={(node) => {
                          const key = `${unit.id}:${date}`;
                          if (node) cellRefs.current.set(key, node);
                          else cellRefs.current.delete(key);
                        }}
                        onMouseEnter={bedOccupancyTooltipText
                          ? (event) => showBedOccupancyTooltip(event.currentTarget, bedOccupancyTooltipText)
                          : undefined}
                        onMouseLeave={bedOccupancyTooltipText
                          ? (event) => {
                              if (event.currentTarget !== document.activeElement) scheduleBedOccupancyTooltipDismiss();
                            }
                          : undefined}
                        onFocus={(event) => {
                          if (event.target !== event.currentTarget) return;
                          onFocusedCellChange({ unitId: unit.id, serviceDate: date });
                          if (suppressBedOccupancyTooltipFocusRef.current === event.currentTarget) {
                            suppressBedOccupancyTooltipFocusRef.current = null;
                            closeBedOccupancyTooltip();
                            return;
                          }
                          if (bedOccupancyTooltipText) showBedOccupancyTooltip(event.currentTarget, bedOccupancyTooltipText);
                          else closeBedOccupancyTooltip();
                        }}
                        onBlur={bedOccupancyTooltipText
                          ? (event) => {
                              if (event.target !== event.currentTarget) return;
                              const nextTarget = event.relatedTarget;
                              if (nextTarget instanceof Node && bedOccupancyTooltipRef.current?.contains(nextTarget)) return;
                              closeBedOccupancyTooltip();
                            }
                          : undefined}
                        onPointerDown={(event) => handlePointerDown(event, unit, date, day)}
                        onDoubleClick={() => onInspectDay(unit, day)}
                        onKeyDown={(event) => handleCellKeyDown(event, unit, day)}
                      >
                        {bedOccupancy ? (
                          <span className="room-status-bed-occupants" aria-hidden="true">
                            {roomStatusOccupantLabelLines(roomStatusBedOccupantLabels(bedOccupancy.occupants)).map((line, index) => (
                              <span key={`${bedOccupancy.occupants[index * 2]!.inventoryUnitId}:${index}`}>{line}</span>
                            ))}
                          </span>
                        ) : null}
                        {directLodging ? (
                          <span className="room-status-direct-occupants" aria-hidden="true">
                            {roomStatusOccupantLabelLines(directOccupantLabels).map((line, index) => (
                              <span key={`${directLodging.occupants[index * 2]!.occupantId}:${index}`}>{line}</span>
                            ))}
                          </span>
                        ) : null}
                        {bedOccupancyRatio ? (
                          <span className="room-status-bed-occupancy-summary" aria-hidden="true">
                            <span className="room-status-bed-state">{roomStatusPresentation[status].label}</span>
                            <span className="room-status-bed-occupancy">{bedOccupancyRatio}</span>
                          </span>
                        ) : directLodging ? (
                          <span className="room-status-direct-occupancy-summary" aria-hidden="true">
                            <span className="room-status-bed-state">{roomStatusPresentation[status].label}</span>
                            <span className="room-status-direct-count">{directLodging.occupantCount}人</span>
                          </span>
                        ) : <RoomStatusMark status={status} compact />}
                        {startingIntervals.map(({ interval, startColumn, endColumn, lane }) => {
                          const gridLabel = roomStatusIntervalGridLabel(interval, unit);
                          const maintenance = interval.sourceKind === "MAINTENANCE" && interval.status === "MAINTENANCE";
                          const intervalAriaLabel = maintenance
                            ? `${gridLabel}，${formatRoomStatusDate(interval.startDate)}至${formatRoomStatusDate(interval.endDate)}`
                            : `${gridLabel}，${roomStatusSourceLabels[interval.sourceKind]}，${formatRoomStatusDate(interval.startDate)}至${formatRoomStatusDate(interval.endDate)}，${roomStatusPresentation[interval.status].label}`;
                          return (
                            <button
                              key={interval.id}
                              type="button"
                              className={`room-status-interval room-status-interval-${interval.status.toLowerCase().replaceAll("_", "-")}${interval.blocking ? " is-blocking" : ""}${interval.conflicts.length ? " has-blocking-conflict" : ""}`}
                              style={{ left: 0, width: `${(endColumn - startColumn) * 100}%`, top: `calc(5px + ${lane} * 25px)` }}
                              aria-label={intervalAriaLabel}
                              title={maintenance ? gridLabel : `${roomStatusSourceLabels[interval.sourceKind]} · ${gridLabel}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              onClick={() => onInspectInterval(unit, interval)}
                            >
                              <span>{gridLabel}</span>
                              {maintenance ? null : <small>{roomStatusSourceLabels[interval.sourceKind]} · {roomStatusPresentation[interval.status].label}</small>}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="room-status-grid-footer">
        <span>当前第 {board.page.index + 1} / {Math.max(1, board.page.totalPages)} 页，共 {board.page.totalRooms} 间房</span>
        <div aria-label="房间分页">
          <button
            type="button"
            className="room-status-button room-status-button-secondary"
            disabled={board.page.index <= 0}
            onClick={() => onPageChange(Math.max(0, board.page.index - 1))}
          >
            <ChevronLeft aria-hidden="true" size={16} />上一页
          </button>
          <button
            type="button"
            className="room-status-button room-status-button-secondary"
            disabled={board.page.index >= board.page.totalPages - 1}
            onClick={() => onPageChange(Math.min(Math.max(0, board.page.totalPages - 1), board.page.index + 1))}
          >
            下一页<ChevronRight aria-hidden="true" size={16} />
          </button>
        </div>
      </footer>
      {bedOccupancyTooltip ? (
        <div
          ref={bedOccupancyTooltipRef}
          className={`room-status-bed-occupancy-tooltip is-${bedOccupancyTooltip.placement.toLowerCase()}`}
          role="tooltip"
          tabIndex={0}
          data-testid="bed-occupancy-tooltip"
          style={{ left: bedOccupancyTooltip.left, top: bedOccupancyTooltip.top, maxHeight: bedOccupancyTooltip.maxHeight }}
          onMouseEnter={cancelBedOccupancyTooltipDismiss}
          onMouseLeave={scheduleBedOccupancyTooltipDismiss}
          onBlur={(event) => {
            if (event.relatedTarget === bedOccupancyTooltipTriggerRef.current) return;
            closeBedOccupancyTooltip();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" && event.key !== "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            const trigger = bedOccupancyTooltipTriggerRef.current;
            const tooltip = bedOccupancyTooltipRef.current;
            closeBedOccupancyTooltip();
            if (event.key === "Tab" && !event.shiftKey) {
              requestAnimationFrame(() => {
                if (trigger && focusNextTabStop(trigger, tooltip)) return;
                trigger?.focus({ preventScroll: true });
              });
              return;
            }
            suppressBedOccupancyTooltipFocusRef.current = trigger;
            requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
          }}
        >
          {bedOccupancyTooltip.text}
        </div>
      ) : null}
    </section>
  );
}
