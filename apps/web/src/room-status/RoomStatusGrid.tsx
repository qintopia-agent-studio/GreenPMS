import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Hand,
  Layers3,
  SearchX
} from "lucide-react";
import type {
  RoomStatusAvailabilitySummaryDto,
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
  isIsoLocalDate,
  moveRoomStatusFocus,
  roomStatusCellBelongsToStay,
  ROOM_STATUS_TIMELINE_DAYS,
  selectionFromCells,
  visibleDateWindow,
  type RoomStatusCellFocus,
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
  roomStatusIntervalIsOverdueReserved,
  roomStatusIntervalStatusLabel,
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

type RenderedRow =
  | { kind: "BUILDING"; buildingCode: string; id: string }
  | ({ kind: "UNIT" } & RenderedUnit);

interface BuildingOccupancyRoom {
  room: RoomStatusUnitDto;
  children: readonly RoomStatusUnitDto[];
}

interface BedOccupancyTooltipState {
  text: string;
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  placement: "ABOVE" | "BELOW";
}

interface PointerSelectionState {
  pointerId: number;
  unitId: string;
  anchorDate: string;
  lastServiceDate: string;
  lastClientX: number;
  selection: RoomStatusSelection;
  touch: boolean;
  row: HTMLElement;
  sourceCell: HTMLDivElement;
  unit: RoomStatusUnitDto;
  day: RoomStatusDayDto | null;
}

const roomStatusWeekdayFormatter = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" });
const ROOM_STATUS_DRAG_EDGE_SCROLL_ZONE_PX = 72;
const ROOM_STATUS_DRAG_EDGE_SCROLL_MAX_STEP_PX = 22;
const QINTOPIA_TOTAL_SELLABLE_UNITS = 77;

export interface RoomStatusGridProps {
  board: RoomStatusBoardDto;
  range: { arrivalDate: string; departureDate: string };
  filters: RoomStatusFilters;
  expandedRoomIds: readonly string[];
  focusedCell: RoomStatusCellFocus | null;
  selection: RoomStatusSelection | null;
  selectedStayId?: string | null;
  dateWindowStart: number;
  todayDate?: string;
  rangeError?: string | undefined;
  initialScrollAnchor?: RoomStatusScrollAnchor | null;
  restoreFocus?: boolean;
  focusRequestToken?: number;
  todayResetToken?: number;
  onRangeChange: (range: { arrivalDate: string; departureDate: string }) => void;
  onPreviousRange: () => void;
  onNextRange: () => void;
  onToday: () => void;
  onToggleRoom: (roomId: string) => void;
  onFocusedCellChange: (focus: RoomStatusCellFocus) => void;
  onSelectionPreviewChange: (selection: RoomStatusSelection | null) => void;
  onInspectSelection: (unit: RoomStatusUnitDto, selection: RoomStatusSelection, anchor: HTMLElement) => void;
  onPageChange: (pageIndex: number) => void;
  onDateWindowChange: (start: number) => void;
  onInspectUnit: (unit: RoomStatusUnitDto) => void;
  onInspectDay: (unit: RoomStatusUnitDto, day: RoomStatusDayDto | null, anchor: HTMLElement) => void;
  onInspectInterval: (unit: RoomStatusUnitDto, interval: RoomStatusIntervalDto, anchor: HTMLElement, serviceDate: string) => void;
  onClearFilters: () => void;
  onScrollAnchorChange?: (anchor: RoomStatusScrollAnchor) => void;
}

export function roomStatusIntervalServiceDateAtPointer(
  dates: readonly string[],
  startColumn: number,
  endColumn: number,
  bounds: Pick<DOMRect, "left" | "width">,
  clientX: number
): string {
  const span = Math.max(1, endColumn - startColumn);
  if (!Number.isFinite(clientX) || bounds.width <= 0) return dates[startColumn] ?? "";
  const relative = Math.max(0, Math.min(bounds.width - Number.EPSILON, clientX - bounds.left));
  const offset = Math.min(span - 1, Math.floor(relative / (bounds.width / span)));
  return dates[startColumn + offset] ?? dates[startColumn] ?? "";
}

export function roomStatusBedOccupancyTooltipPosition(
  bounds: Pick<DOMRect, "bottom" | "left" | "top" | "width">,
  viewport: { height: number; width: number },
  text: string
): BedOccupancyTooltipState {
  const viewportMargin = 12;
  const gap = 7;
  const maximumWidth = Math.max(1, Math.min(320, viewport.width - viewportMargin * 2));
  const halfWidth = maximumWidth / 2;
  const left = Math.min(
    viewport.width - viewportMargin - halfWidth,
    Math.max(viewportMargin + halfWidth, bounds.left + bounds.width / 2)
  );
  const estimatedLines = Math.max(2, Math.ceil(text.length / 25));
  const estimatedHeight = 30 + estimatedLines * 18;
  const belowAnchor = Math.max(
    viewportMargin,
    Math.min(viewport.height - viewportMargin, bounds.bottom + gap)
  );
  const aboveAnchor = Math.max(
    viewportMargin,
    Math.min(viewport.height - viewportMargin, bounds.top - gap)
  );
  const availableBelow = Math.max(1, viewport.height - viewportMargin - belowAnchor);
  const availableAbove = Math.max(1, aboveAnchor - viewportMargin);
  const placement = estimatedHeight <= availableBelow
    ? "BELOW"
    : estimatedHeight <= availableAbove || availableAbove >= availableBelow ? "ABOVE" : "BELOW";
  const safeViewportHeight = Math.max(1, viewport.height - viewportMargin * 2);
  const minimumUsefulHeight = Math.min(72, safeViewportHeight);
  if (Math.max(availableAbove, availableBelow) < minimumUsefulHeight) {
    const overlayMaxHeight = Math.min(
      safeViewportHeight,
      Math.max(minimumUsefulHeight, Math.floor(viewport.height * 0.6))
    );
    return {
      text,
      left,
      ...(placement === "ABOVE" ? { bottom: viewportMargin } : { top: viewportMargin }),
      maxHeight: overlayMaxHeight,
      placement
    };
  }
  const maxHeight = Math.floor(placement === "BELOW" ? availableBelow : availableAbove);

  if (placement === "ABOVE") {
    return {
      text,
      left,
      bottom: viewport.height - aboveAnchor,
      maxHeight,
      placement
    };
  }
  return {
    text,
    left,
    top: belowAnchor,
    maxHeight,
    placement
  };
}

export function roomStatusFocusRestorationTarget(
  focusedCell: RoomStatusCellFocus | null,
  unitIds: readonly string[],
  dates: readonly string[]
): RoomStatusCellFocus | null {
  if (focusedCell) {
    return unitIds.includes(focusedCell.unitId) && dates.includes(focusedCell.serviceDate)
      ? focusedCell
      : null;
  }
  return unitIds[0] && dates[0] ? { unitId: unitIds[0], serviceDate: dates[0] } : null;
}

export function focusAndRevealRoomStatusCell(cell: HTMLElement): boolean {
  if (!cell.isConnected) return false;
  cell.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
  cell.focus({ preventScroll: true });
  return cell.ownerDocument.activeElement === cell;
}

export function resetRoomStatusHorizontalScroll(
  body: Pick<HTMLElement, "scrollTop" | "scrollTo"> | null,
  header: Pick<HTMLElement, "scrollTo"> | null
): void {
  if (body) body.scrollTo({ left: 0, top: body.scrollTop, behavior: "auto" });
  header?.scrollTo({ left: 0, behavior: "auto" });
}

export function roomStatusHorizontalDragAutoScrollDelta({
  clientX,
  viewportLeft,
  viewportRight,
  scrollLeft,
  maxScrollLeft,
  edgeSize = ROOM_STATUS_DRAG_EDGE_SCROLL_ZONE_PX,
  maxStep = ROOM_STATUS_DRAG_EDGE_SCROLL_MAX_STEP_PX
}: {
  clientX: number;
  viewportLeft: number;
  viewportRight: number;
  scrollLeft: number;
  maxScrollLeft: number;
  edgeSize?: number;
  maxStep?: number;
}): number {
  if (!Number.isFinite(clientX)
    || !Number.isFinite(viewportLeft)
    || !Number.isFinite(viewportRight)
    || viewportRight <= viewportLeft
    || maxScrollLeft <= 0
    || maxStep <= 0) return 0;
  const safeScrollLeft = Math.max(0, Math.min(maxScrollLeft, scrollLeft));
  const safeEdgeSize = Math.max(1, Math.min(edgeSize, (viewportRight - viewportLeft) / 2));
  const leftDistance = clientX - viewportLeft;
  if (leftDistance < safeEdgeSize && safeScrollLeft > 0) {
    const intensity = Math.min(1, Math.max(0, (safeEdgeSize - leftDistance) / safeEdgeSize));
    const delta = -Math.max(1, Math.ceil(maxStep * intensity));
    return Math.max(delta, -safeScrollLeft);
  }
  const rightDistance = viewportRight - clientX;
  if (rightDistance < safeEdgeSize && safeScrollLeft < maxScrollLeft) {
    const intensity = Math.min(1, Math.max(0, (safeEdgeSize - rightDistance) / safeEdgeSize));
    const delta = Math.max(1, Math.ceil(maxStep * intensity));
    return Math.min(delta, maxScrollLeft - safeScrollLeft);
  }
  return 0;
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

export function roomStatusAttentionLaneOffset(
  intervals: readonly { startColumn: number; endColumn: number }[],
  attentionColumnIndexes: ReadonlySet<number>
): 0 | 1 {
  return intervals.some(({ startColumn, endColumn }) => (
    [...attentionColumnIndexes].some((columnIndex) => startColumn <= columnIndex && columnIndex < endColumn)
  )) ? 1 : 0;
}

function bedOccupancyDescription(
  occupancy: RoomStatusBedOccupancyDto,
  unit?: RoomStatusUnitDto,
  serviceDate = occupancy.serviceDate,
  businessDate?: string
): string {
  const occupants = occupancy.occupants
    .map((occupant) => {
      const source = unit?.intervals.find((interval) => interval.actualInventoryUnitId === occupant.inventoryUnitId
        && interval.startDate <= serviceDate
        && serviceDate < interval.endDate
        && interval.references.some((reference) => reference.type === "ORDER" && reference.id === occupant.sourceReference.id));
      const details = source
        ? `（${roomStatusSourceLabels[source.sourceKind]} · ${roomStatusIntervalStatusLabel(source, businessDate)} · ${formatRoomStatusDate(serviceDate)}）`
        : `（${formatRoomStatusDate(serviceDate)}）`;
      return `${occupant.inventoryUnitCode}：${roomStatusBedOccupantLabel(occupant)}${details}`;
    })
    .join("；");
  return `占用 ${occupancy.occupiedBedCount}/${occupancy.totalBedCount}${occupants ? `；住宿人：${occupants}` : ""}`;
}

function bedOccupancySourceIntervals(
  occupancy: RoomStatusBedOccupancyDto,
  unit: RoomStatusUnitDto,
  serviceDate: string
): RoomStatusIntervalDto[] {
  return occupancy.occupants.flatMap((occupant) => {
    const source = unit.intervals.find((interval) => interval.actualInventoryUnitId === occupant.inventoryUnitId
      && interval.startDate <= serviceDate
      && serviceDate < interval.endDate
      && interval.references.some((reference) => reference.type === "ORDER" && reference.id === occupant.sourceReference.id));
    return source ? [source] : [];
  });
}

export function roomStatusBedOccupancyStateLabel(
  occupancy: RoomStatusBedOccupancyDto,
  unit: RoomStatusUnitDto,
  serviceDate: string,
  fallbackStatus: RoomStatusDayDto["status"],
  businessDate?: string
): string {
  const sources = bedOccupancySourceIntervals(occupancy, unit, serviceDate);
  const sourceLabels = new Set(sources.map((source) => roomStatusIntervalStatusLabel(source, businessDate)));
  if (sourceLabels.size > 1) return "占用";
  if (sources.some((source) => source.status === "ARREARS")) return roomStatusPresentation.ARREARS.label;
  if (sources.some((source) => roomStatusIntervalIsOverdueReserved(source, businessDate))) return "逾期预订";
  return roomStatusPresentation[fallbackStatus].label;
}

function roomStatusIntervalNeedsProcessing(interval: RoomStatusIntervalDto, businessDate?: string): boolean {
  return interval.status === "ARREARS" || roomStatusIntervalIsOverdueReserved(interval, businessDate);
}

export function roomStatusBedOccupancyNeedsProcessing(
  occupancy: RoomStatusBedOccupancyDto,
  unit: RoomStatusUnitDto,
  serviceDate: string,
  businessDate?: string
): boolean {
  return bedOccupancySourceIntervals(occupancy, unit, serviceDate)
    .some((source) => roomStatusIntervalNeedsProcessing(source, businessDate));
}

export function roomStatusBedOccupancyAttentionLabels(
  occupancy: RoomStatusBedOccupancyDto,
  unit: RoomStatusUnitDto,
  serviceDate: string,
  businessDate?: string
): readonly ("欠款" | "逾期")[] {
  const sources = bedOccupancySourceIntervals(occupancy, unit, serviceDate);
  const labels: ("欠款" | "逾期")[] = [];
  if (sources.some((source) => source.status === "ARREARS")) labels.push("欠款");
  if (sources.some((source) => roomStatusIntervalIsOverdueReserved(source, businessDate))) labels.push("逾期");
  return labels;
}

export function roomStatusCellAttentionLabels(
  dayIntervals: readonly RoomStatusIntervalDto[],
  serviceDate: string,
  businessDate?: string
): readonly ("欠款" | "逾期")[] {
  if (!businessDate) return [];
  const labels: ("欠款" | "逾期")[] = [];
  for (const interval of dayIntervals) {
    if (interval.sourceKind !== "ORDER" && interval.sourceKind !== "FREE_STAY") continue;
    // 欠款是已完成历史住宿的结算待办，仍只显示在过去日期。
    if (serviceDate < businessDate && interval.status === "ARREARS") {
      if (!labels.includes("欠款")) labels.push("欠款");
    } else if (roomStatusIntervalIsOverdueReserved(interval, businessDate)) {
      // 逾期预订是整张订单的待办，跨今天时整段都需要可见。
      if (!labels.includes("逾期")) labels.push("逾期");
    }
  }
  return labels;
}

export interface RoomStatusBuildingOccupancySummary {
  occupants: number;
  capacity: number;
}

export function roomStatusBuildingOccupancySummaryLabel(summary: RoomStatusBuildingOccupancySummary): string {
  return `今日 ${summary.occupants}人 / 总容量 ${summary.capacity} 人`;
}

export function roomStatusBuildingOccupancySummariesForDate(
  rooms: readonly BuildingOccupancyRoom[],
  serviceDate: string
): Map<string, RoomStatusBuildingOccupancySummary> {
  const summaries = new Map<string, RoomStatusBuildingOccupancySummary>();
  for (const { room, children } of rooms) {
    const buildingCode = room.buildingCode?.trim() || "未分栋";
    const units = [room, ...children];
    const visibleUnitIds = new Set(units.map((unit) => unit.id));
    const countedIntervals = new Set<string>();
    let occupants = 0;
    for (const unit of units) {
      for (const interval of unit.intervals) {
        if ((interval.sourceKind !== "ORDER" && interval.sourceKind !== "FREE_STAY")
          || interval.status !== "IN_HOUSE"
          || interval.startDate > serviceDate
          || serviceDate >= interval.endDate
          || !visibleUnitIds.has(interval.actualInventoryUnitId)) continue;
        const key = `${interval.id}:${interval.actualInventoryUnitId}`;
        if (countedIntervals.has(key)) continue;
        countedIntervals.add(key);
        occupants += Math.max(0, interval.occupantCount);
      }
    }
    const current = summaries.get(buildingCode) ?? { occupants: 0, capacity: 0 };
    const roomCapacity = Number.isFinite(room.occupancyCapacity) ? room.occupancyCapacity : 0;
    summaries.set(buildingCode, {
      occupants: current.occupants + occupants,
      capacity: current.capacity + Math.max(0, roomCapacity)
    });
  }
  return summaries;
}

export function roomStatusCellAccessibleName(
  unit: RoomStatusUnitDto,
  serviceDate: string,
  day: RoomStatusDayDto | null,
  bedOccupancy: RoomStatusBedOccupancyDto | null,
  businessDate?: string
): string {
  if (!day) return `${roomStatusUnitLabel(unit)}，${formatRoomStatusDate(serviceDate)}，状态未知，服务端未返回逐日事实`;
  const historicalBlank = Boolean(businessDate
    && serviceDate < businessDate
    && day.status === "AVAILABLE"
    && !day.available
    && day.intervalIds.length === 0
    && day.conflicts.length === 0);
  const status = historicalBlank ? "历史空白" : roomStatusPresentation[day.status].label;
  const intervals = unit.intervals.filter((interval) => day.intervalIds.includes(interval.id));
  const sources = intervals.map((interval) => [
    roomStatusSourceLabels[interval.sourceKind],
    roomStatusIntervalBusinessLabel(interval),
    roomStatusIntervalStatusLabel(interval, businessDate)
  ].filter(Boolean).join(" "));
  const bedOccupancyStatus = bedOccupancy
    ? roomStatusBedOccupancyStateLabel(bedOccupancy, unit, serviceDate, day.status, businessDate)
    : null;
  const overdueReserved = intervals.some((interval) => roomStatusIntervalIsOverdueReserved(interval, businessDate));
  const conflicts = day.conflicts.length ? ["已有住宿，不能重复安排"] : [];
  const availability = historicalBlank ? "不能创建普通住宿" : day.available ? "可以安排" : "当前不可安排";
  const occupancy = bedOccupancy ? bedOccupancyDescription(bedOccupancy, unit, serviceDate, businessDate) : null;
  return [roomStatusUnitLabel(unit), formatRoomStatusDate(serviceDate), bedOccupancyStatus ?? (overdueReserved ? "逾期预订" : status), availability, occupancy, ...sources, ...conflicts]
    .filter(Boolean)
    .join("，");
}

function isCellSelected(selection: RoomStatusSelection | null, unitId: string, serviceDate: string): boolean {
  return Boolean(selection
    && selection.unitId === unitId
    && serviceDate >= selection.arrivalDate
    && serviceDate < selection.departureDate);
}

function isSingleNightSelection(selection: RoomStatusSelection | null): selection is RoomStatusSelection {
  return Boolean(selection && selection.departureDate === addLocalDateDays(selection.arrivalDate, 1));
}

export function roomStatusSingleCellMappingSelection(
  pointerPreviewSelection: RoomStatusSelection | null,
  selection: RoomStatusSelection | null,
  selectedStayId: string | null
): RoomStatusCellFocus | null {
  const activeSelection = pointerPreviewSelection ?? selection;
  if (!isSingleNightSelection(activeSelection)) return null;
  if (!pointerPreviewSelection && selectedStayId) return null;
  return { unitId: activeSelection.unitId, serviceDate: activeSelection.arrivalDate };
}

export function roomStatusDateHeaderSummaryLabel(
  serviceDate: string,
  summary: RoomStatusAvailabilitySummaryDto | null | undefined,
  businessDate: string
): string {
  if (serviceDate < businessDate) {
    const denominator = summary && summary.totalSellableUnits > 0
      ? summary.totalSellableUnits
      : QINTOPIA_TOTAL_SELLABLE_UNITS;
    const occupancyRate = Math.round(((summary?.paidOccupiedUnits ?? 0) / denominator) * 100);
    return `入住率 ${occupancyRate}% · ${summary?.occupantCount ?? 0}人`;
  }
  return `剩 ${summary?.availableRooms ?? 0} 间 · ${summary?.availableBeds ?? 0} 床`;
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
  range,
  filters,
  expandedRoomIds,
  focusedCell,
  selection,
  selectedStayId = null,
  dateWindowStart,
  todayDate,
  rangeError,
  initialScrollAnchor,
  restoreFocus = false,
  focusRequestToken = 0,
  todayResetToken = 0,
  onRangeChange,
  onPreviousRange,
  onNextRange,
  onToday,
  onToggleRoom,
  onFocusedCellChange,
  onSelectionPreviewChange,
  onInspectSelection,
  onPageChange,
  onDateWindowChange,
  onInspectUnit,
  onInspectDay,
  onInspectInterval,
  onClearFilters,
  onScrollAnchorChange
}: RoomStatusGridProps) {
  const rangeErrorId = useId();
  const rangeInputId = useId();
  const isMobile = useRoomStatusMobileViewport();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerSelection = useRef<PointerSelectionState | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const dragAutoScrollFrame = useRef<number | null>(null);
  const scrollRestored = useRef(false);
  const focusRestored = useRef(false);
  const lastFocusRequestToken = useRef(focusRequestToken);
  const lastTodayResetToken = useRef(todayResetToken);
  const pendingKeyboardFocus = useRef<RoomStatusCellFocus | null>(null);
  const [touchSelectionMode, setTouchSelectionMode] = useState(false);
  const [draggingUnitId, setDraggingUnitId] = useState<string | null>(null);
  const [pointerPreviewSelection, setPointerPreviewSelection] = useState<RoomStatusSelection | null>(null);
  const [rangeDraft, setRangeDraft] = useState(range);
  const [bedOccupancyTooltip, setBedOccupancyTooltip] = useState<BedOccupancyTooltipState | null>(null);
  const rangeErrorRef = useRef<HTMLDivElement>(null);
  const bedOccupancyTooltipDismissTimer = useRef<number | null>(null);
  const bedOccupancyTooltipRef = useRef<HTMLDivElement>(null);
  const bedOccupancyTooltipTriggerRef = useRef<HTMLDivElement | null>(null);
  const suppressBedOccupancyTooltipFocusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setRangeDraft(range);
  }, [range.arrivalDate, range.departureDate]);

  useEffect(() => {
    if (rangeError) rangeErrorRef.current?.focus();
  }, [rangeError]);

  useEffect(() => {
    if (todayResetToken === lastTodayResetToken.current) return;
    lastTodayResetToken.current = todayResetToken;
    resetRoomStatusHorizontalScroll(scrollRef.current, headerScrollRef.current);
  }, [todayResetToken]);

  const changeRange = (nextRange: { arrivalDate: string; departureDate: string }) => {
    setRangeDraft(nextRange);
    onRangeChange(nextRange);
  };

  const changeStartDate = (startDate: string) => {
    if (!isIsoLocalDate(startDate)) {
      changeRange({ arrivalDate: startDate, departureDate: rangeDraft.departureDate });
      return;
    }
    changeRange({
      arrivalDate: startDate,
      departureDate: addLocalDateDays(startDate, ROOM_STATUS_TIMELINE_DAYS)
    });
  };

  const stopHorizontalDragAutoScroll = useCallback(() => {
    if (dragAutoScrollFrame.current === null) return;
    window.cancelAnimationFrame(dragAutoScrollFrame.current);
    dragAutoScrollFrame.current = null;
  }, []);
  const updatePointerSelectionAtClientX = useCallback((active: PointerSelectionState, clientX: number) => {
    active.lastClientX = clientX;
    const cells = [...active.row.querySelectorAll<HTMLElement>("[data-room-status-cell='true']")];
    const firstCell = cells[0];
    const lastCell = cells.at(-1);
    if (!firstCell || !lastCell) return false;
    const target = cells.find((cell) => {
      const bounds = cell.getBoundingClientRect();
      return clientX >= bounds.left && clientX < bounds.right;
    }) ?? (() => {
      const firstBounds = firstCell.getBoundingClientRect();
      if (clientX < firstBounds.left) return firstCell;
      const lastBounds = lastCell.getBoundingClientRect();
      if (clientX >= lastBounds.right) return lastCell;
      return null;
    })();
    const serviceDate = target?.dataset.serviceDate;
    if (!serviceDate || serviceDate === active.lastServiceDate) return false;
    active.lastServiceDate = serviceDate;
    active.selection = selectionFromCells(active.unitId, active.anchorDate, serviceDate);
    setPointerPreviewSelection(active.selection);
    return true;
  }, []);
  const scheduleHorizontalDragAutoScroll = useCallback((active: PointerSelectionState) => {
    if (dragAutoScrollFrame.current !== null) return;
    const tick = () => {
      const current = pointerSelection.current;
      const scroll = scrollRef.current;
      if (current !== active || !scroll) {
        dragAutoScrollFrame.current = null;
        return;
      }
      const bounds = scroll.getBoundingClientRect();
      const maxScrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      const delta = roomStatusHorizontalDragAutoScrollDelta({
        clientX: active.lastClientX,
        viewportLeft: bounds.left,
        viewportRight: bounds.right,
        scrollLeft: scroll.scrollLeft,
        maxScrollLeft
      });
      if (delta === 0) {
        dragAutoScrollFrame.current = null;
        return;
      }
      scroll.scrollLeft = Math.max(0, Math.min(maxScrollLeft, scroll.scrollLeft + delta));
      updatePointerSelectionAtClientX(active, active.lastClientX);
      dragAutoScrollFrame.current = window.requestAnimationFrame(tick);
    };
    dragAutoScrollFrame.current = window.requestAnimationFrame(tick);
  }, [updatePointerSelectionAtClientX]);
  const finishPointerSelection = useCallback((pointerId?: number, commit = false) => {
    const active = pointerSelection.current;
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return false;
    stopHorizontalDragAutoScroll();
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
    if (commit && active.lastServiceDate === active.anchorDate) onInspectDay(active.unit, active.day, active.sourceCell);
    else if (commit) {
      const anchor = cellRefs.current.get(`${active.unitId}:${active.lastServiceDate}`) ?? active.sourceCell;
      onInspectSelection(active.unit, active.selection, anchor);
    }
    return true;
  }, [onInspectDay, onInspectSelection, stopHorizontalDragAutoScroll]);
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
    () => visibleDateWindow(board.dates, dateWindowStart, ROOM_STATUS_TIMELINE_DAYS),
    [board.dates, dateWindowStart]
  );
  const availabilitySummaryByDate = useMemo(() => new Map(board.availabilitySummary
    .map((item) => [item.serviceDate, item] as const)), [board.availabilitySummary]);
  const singleCellSelection = useMemo(() => {
    return roomStatusSingleCellMappingSelection(pointerPreviewSelection, selection, selectedStayId);
  }, [pointerPreviewSelection, selectedStayId, selection]);
  const showBuildingTodayOccupancy = Boolean(todayDate && dates.includes(todayDate));
  const buildingTodayOccupancySummaries = useMemo(() => (
    showBuildingTodayOccupancy && todayDate
      ? roomStatusBuildingOccupancySummariesForDate(filteredRooms, todayDate)
      : new Map<string, RoomStatusBuildingOccupancySummary>()
  ), [filteredRooms, showBuildingTodayOccupancy, todayDate]);
  const renderedRows = useMemo<RenderedRow[]>(() => {
    const rows: RenderedRow[] = [];
    let activeBuildingCode: string | null = null;
    for (const { room, children } of filteredRooms) {
      const buildingCode = room.buildingCode?.trim() || "未分栋";
      if (buildingCode !== activeBuildingCode) {
        activeBuildingCode = buildingCode;
        rows.push({ kind: "BUILDING", buildingCode, id: `building:${buildingCode}` });
      }
      rows.push({ kind: "UNIT", unit: room, parent: null, depth: 0 });
      if (room.salesMode === "BED_SPLIT" && expandedRoomIds.includes(room.id)) {
        rows.push(...children.map((child): RenderedRow => ({ kind: "UNIT", unit: child, parent: room, depth: 1 })));
      }
    }
    return rows;
  }, [expandedRoomIds, filteredRooms]);
  const renderedUnits = useMemo<RenderedUnit[]>(() => renderedRows
    .flatMap((row) => row.kind === "UNIT" ? [{ unit: row.unit, parent: row.parent, depth: row.depth }] : []), [renderedRows]);
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
  const clampedWindowStart = board.dates.indexOf(firstVisibleDate ?? "");
  const restorationFocus = roomStatusFocusRestorationTarget(focusedCell, unitIds, dates);
  const restorationFocusKey = restorationFocus
    ? `${restorationFocus.unitId}:${restorationFocus.serviceDate}`
    : null;

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
      if (row) top = row.offsetTop - 58;
    }
    scroll.scrollTo({ left: initialScrollAnchor.left, top, behavior: "auto" });
  }, [initialScrollAnchor, isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const restorationRequested = restoreFocus && !focusRestored.current;
    const explicitRequest = focusRequestToken !== lastFocusRequestToken.current;
    if ((!restorationRequested && !explicitRequest) || !restorationFocus || !restorationFocusKey) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const cell = cellRefs.current.get(restorationFocusKey);
        if (!cell || !focusAndRevealRoomStatusCell(cell)) return;
        if (!focusedCell) onFocusedCellChange(restorationFocus);
        if (restorationRequested) focusRestored.current = true;
        lastFocusRequestToken.current = focusRequestToken;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [focusRequestToken, focusedCell, isMobile, onFocusedCellChange, restorationFocus, restorationFocusKey, restoreFocus]);

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
      updatePointerSelectionAtClientX(active, event.clientX);
      scheduleHorizontalDragAutoScroll(active);
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
  }, [finishPointerSelection, scheduleHorizontalDragAutoScroll, updatePointerSelectionAtClientX]);

  useEffect(() => () => {
    pointerSelection.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    if (dragAutoScrollFrame.current !== null) cancelAnimationFrame(dragAutoScrollFrame.current);
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
    const targetWindowStart = dateWindowStartForFocus(board.dates, clampedWindowStart, ROOM_STATUS_TIMELINE_DAYS, next.serviceDate);
    const windowChanges = targetWindowStart !== clampedWindowStart;
    if (windowChanges) {
      pendingKeyboardFocus.current = next;
      onDateWindowChange(targetWindowStart);
    }
    onFocusedCellChange(next);
    if (event.shiftKey) {
      const anchorDate = selection?.unitId === next.unitId ? selection.anchorDate : current.serviceDate;
      onSelectionPreviewChange(selectionFromCells(next.unitId, anchorDate, next.serviceDate));
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
      onSelectionPreviewChange(null);
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      const serviceDate = event.currentTarget.dataset.serviceDate!;
      const selectedRange = selection?.unitId === unit.id
        && selection.arrivalDate <= serviceDate
        && serviceDate < selection.departureDate
        && selection.departureDate !== addLocalDateDays(selection.arrivalDate, 1)
        ? selection
        : null;
      if (selectedRange) onInspectSelection(unit, selectedRange, event.currentTarget);
      else onInspectDay(unit, day, event.currentTarget);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const serviceDate = event.currentTarget.dataset.serviceDate!;
      const selectedRange = selection?.unitId === unit.id
        && selection.arrivalDate <= serviceDate
        && serviceDate < selection.departureDate
        && selection.departureDate !== addLocalDateDays(selection.arrivalDate, 1)
        ? selection
        : null;
      if (selectedRange) onInspectSelection(unit, selectedRange, event.currentTarget);
      else onInspectDay(unit, day, event.currentTarget);
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
      onInspectDay(unit, day, event.currentTarget);
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
      lastClientX: event.clientX,
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
    setBedOccupancyTooltip(roomStatusBedOccupancyTooltipPosition(
      target.getBoundingClientRect(),
      { height: window.innerHeight, width: window.innerWidth },
      text
    ));
  };

  const handleScroll = () => {
    closeBedOccupancyTooltip();
    if (headerScrollRef.current && scrollRef.current && headerScrollRef.current.scrollLeft !== scrollRef.current.scrollLeft) {
      headerScrollRef.current.scrollLeft = scrollRef.current.scrollLeft;
    }
    if (!scrollRef.current || !onScrollAnchorChange || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const scroll = scrollRef.current;
      if (!scroll) return;
      const firstVisibleRow = [...scroll.querySelectorAll<HTMLElement>("[data-room-status-row]")]
        .find((row) => row.offsetTop + row.offsetHeight > scroll.scrollTop + 58);
      onScrollAnchorChange({
        unitId: firstVisibleRow?.dataset.roomStatusRow ?? null,
        left: scroll.scrollLeft,
        top: scroll.scrollTop
      });
    });
  };

  const handleHeaderScroll = () => {
    if (scrollRef.current && headerScrollRef.current && scrollRef.current.scrollLeft !== headerScrollRef.current.scrollLeft) {
      scrollRef.current.scrollLeft = headerScrollRef.current.scrollLeft;
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    window.scrollBy({ top: event.deltaY, left: 0, behavior: "auto" });
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
      <h2 id="room-status-grid-heading" className="sr-only">房间与床位逐日房态</h2>
      <header className="room-status-grid-section-header">
        <div className="room-status-window-controls" aria-label="房态日历辅助操作">
          <button
            type="button"
            className="room-status-button room-status-button-secondary room-status-touch-selection-toggle"
            aria-pressed={touchSelectionMode}
            onClick={() => setTouchSelectionMode((enabled) => !enabled)}
          >
            <Hand aria-hidden="true" size={16} />{touchSelectionMode ? "正在选择" : "触控选区"}
          </button>
        </div>
      </header>

      {board.projectionState === "PARTIAL" ? (
        <div className="room-status-grid-notice" role="status">
          <RoomStatusWarning>投影不完整。页面保留已返回事实，但不能把缺失内容解释为可售。</RoomStatusWarning>
        </div>
      ) : null}

      <div className="room-status-grid" role="grid" aria-rowcount={renderedRows.length + 1} aria-colcount={dates.length + 1} style={gridStyle}>
          <div className="room-status-grid-header-scroll" ref={headerScrollRef} onScroll={handleHeaderScroll} role="presentation">
            <div className="room-status-grid-header" role="row">
            <div className="room-status-resource-header" role="columnheader">
              <div className="room-status-grid-range-controls" aria-label="房态起始日期">
                <button type="button" className="room-status-grid-range-button" onClick={onPreviousRange} aria-label="查看前 30 夜" title="前 30 夜">
                  <ChevronLeft aria-hidden="true" size={16} />
                </button>
                <label className="sr-only" htmlFor={rangeInputId}>起始日期</label>
                <input
                  id={rangeInputId}
                  className="room-status-grid-date-input"
                  type="date"
                  value={rangeDraft.arrivalDate}
                  data-testid="arrival-date"
                  aria-invalid={rangeError ? "true" : undefined}
                  aria-describedby={rangeError ? rangeErrorId : undefined}
                  onChange={(event) => changeStartDate(event.target.value)}
                />
                <button type="button" className="room-status-grid-today-button" onClick={onToday}>今天</button>
                <button type="button" className="room-status-grid-range-button" onClick={onNextRange} aria-label="查看后 30 夜" title="后 30 夜">
                  <ChevronRight aria-hidden="true" size={16} />
                </button>
              </div>
              {rangeError ? (
                <div
                  id={rangeErrorId}
                  ref={rangeErrorRef}
                  className="room-status-grid-range-error"
                  role="alert"
                  tabIndex={-1}
                  data-testid="room-status-range-error"
                >
                  <strong>日期无效</strong>
                  <span>{rangeError}</span>
                </div>
              ) : null}
            </div>
            <div className="room-status-date-header-track" role="presentation">
              {dates.map((date) => {
                const parsed = new Date(`${date}T00:00:00Z`);
                const weekDay = roomStatusWeekdayFormatter.format(parsed);
                const summaryLabel = roomStatusDateHeaderSummaryLabel(date, availabilitySummaryByDate.get(date), board.businessDate);
                return (
                  <div
                    key={date}
                    className={`room-status-date-header${date === todayDate ? " is-today" : ""}${singleCellSelection?.serviceDate === date ? " is-cell-selection-column" : ""}`}
                    role="columnheader"
                    aria-label={`${formatRoomStatusDate(date)} ${weekDay} ${summaryLabel}`}
                  >
                    <strong>{date.slice(5)}</strong>
                    <span>{date === todayDate ? "今天" : weekDay}</span>
                    <small>{summaryLabel}</small>
                  </div>
                );
              })}
            </div>
          </div>
          </div>

          <div className="room-status-grid-scroll"
            ref={scrollRef}
            onScroll={handleScroll}
            onWheel={handleWheel}
            role="region"
            aria-label="房态二维网格，可使用方向键移动，Shift 加方向键扩展选区"
            tabIndex={0}
          >
            <div className="room-status-grid-body" role="presentation">
          {renderedRows.map((row, rowIndex) => {
            if (row.kind === "BUILDING") {
              return (
                <div
                  className="room-status-grid-row room-status-building-row"
                  role="row"
                  key={row.id}
                  aria-rowindex={rowIndex + 2}
                >
                  <div className="room-status-building-cell" role="rowheader">
                    <strong>{row.buildingCode === "未分栋" || row.buildingCode.endsWith("栋") ? row.buildingCode : `${row.buildingCode}栋`}</strong>
                    {showBuildingTodayOccupancy ? (
                      <span className="room-status-building-occupancy">
                        {roomStatusBuildingOccupancySummaryLabel(buildingTodayOccupancySummaries.get(row.buildingCode) ?? { occupants: 0, capacity: 0 })}
                      </span>
                    ) : null}
                  </div>
                  <div className="room-status-building-day-track" role="presentation" aria-hidden="true" />
                </div>
              );
            }
            const { unit, depth } = row;
            const canExpand = depth === 0 && unit.salesMode === "BED_SPLIT" && unit.children.length > 0;
            const expanded = canExpand && expandedRoomIds.includes(unit.id);
            const positionedIntervals = positionedByUnit.get(unit.id) ?? [];
            const cellAttentionLabelsByDate = new Map<string, readonly ("欠款" | "逾期")[]>();
            const attentionColumnIndexes = new Set<number>();
            dates.forEach((date, columnIndex) => {
              const day = dayByCell.get(`${unit.id}:${date}`) ?? null;
              const dayIntervals = day ? unit.intervals.filter((interval) => day.intervalIds.includes(interval.id)) : [];
              const labels = roomStatusCellAttentionLabels(dayIntervals, date, board.businessDate);
              cellAttentionLabelsByDate.set(date, labels);
              if (labels.length) attentionColumnIndexes.add(columnIndex);
            });
            const attentionLaneOffset = roomStatusAttentionLaneOffset(positionedIntervals, attentionColumnIndexes);
            const intervalsByStartColumn = new Map<number, typeof positionedIntervals>();
            for (const positioned of positionedIntervals) {
              const intervals = intervalsByStartColumn.get(positioned.startColumn) ?? [];
              intervals.push(positioned);
              intervalsByStartColumn.set(positioned.startColumn, intervals);
            }
            const rowLanes = Math.max(1, ...positionedIntervals.map((item) => item.lane + 1)) + attentionLaneOffset;
            return (
              <div
                className={`room-status-grid-row room-status-grid-row-depth-${depth}${draggingUnitId === unit.id ? " is-drag-source-row" : ""}`}
                role="row"
                key={unit.id}
                data-room-status-row={unit.id}
                aria-rowindex={rowIndex + 2}
                style={{ "--room-status-interval-lanes": rowLanes } as CSSProperties}
              >
                <div className={`room-status-resource-cell${singleCellSelection?.unitId === unit.id ? " is-cell-selection-row" : ""}`} role="rowheader">
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
                    const dayIntervals = day ? unit.intervals.filter((interval) => day.intervalIds.includes(interval.id)) : [];
                    const cellStatusLabel = dayIntervals.some((interval) => roomStatusIntervalIsOverdueReserved(interval, board.businessDate))
                      ? "逾期预订"
                      : roomStatusPresentation[status].label;
                    const bedOccupancy = bedOccupancyByCell.get(`${unit.id}:${date}`) ?? null;
                    const bedOccupancyRatio = bedOccupancy
                      ? `${bedOccupancy.occupiedBedCount}/${bedOccupancy.totalBedCount}`
                      : null;
                    const cellAttentionLabels = cellAttentionLabelsByDate.get(date) ?? [];
                    const bedOccupancyNeedsProcessing = bedOccupancy
                      ? roomStatusBedOccupancyNeedsProcessing(bedOccupancy, unit, date, board.businessDate)
                      : false;
                    const bedOccupancyTooltipText = bedOccupancy ? bedOccupancyDescription(bedOccupancy, unit, date, board.businessDate) : undefined;
                    const historicalBlank = Boolean(day
                      && date < board.businessDate
                      && status === "AVAILABLE"
                      && !day.available
                      && day.intervalIds.length === 0
                      && day.conflicts.length === 0);
                    const directLodging = unit.intervals.find((interval) => (
                      interval.actualInventoryUnitId === unit.id
                      && interval.startDate <= date
                      && date < interval.endDate
                      && (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY")
                      && interval.occupantCount > 0
                    )) ?? null;
                    const directLodgingNeedsProcessing = directLodging
                      ? roomStatusIntervalNeedsProcessing(directLodging, board.businessDate)
                      : false;
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
                        aria-label={roomStatusCellAccessibleName(unit, date, day, bedOccupancy, board.businessDate)}
                        tabIndex={focusable ? 0 : -1}
                        key={date}
                        data-room-status-cell="true"
                        data-unit-id={unit.id}
                        data-service-date={date}
                        data-bed-occupancy-ratio={bedOccupancyRatio ?? undefined}
                        className={`room-status-day-cell room-status-day-${status.toLowerCase().replaceAll("_", "-")}${selected ? " is-selected" : ""}${selectedStayId && roomStatusCellBelongsToStay(unit, date, selectedStayId) ? " is-stay-selected" : ""}${date === todayDate ? " is-today" : ""}${!day?.available ? " is-authoritatively-unavailable" : ""}${historicalBlank ? " is-historical-blank" : ""}${day?.conflicts.length ? " has-blocking-conflict" : ""}${startingIntervals.length ? " has-source-interval" : ""}${bedOccupancy ? " has-bed-occupancy" : ""}${directLodging ? " has-direct-lodging" : ""}${bedOccupancyNeedsProcessing || directLodgingNeedsProcessing ? " has-attention-occupancy" : ""}`}
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
                        onDoubleClick={(event) => onInspectDay(unit, day, event.currentTarget)}
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
                        {cellAttentionLabels.length ? (
                          <span className="room-status-bed-attention-tags" aria-hidden="true">
                            {cellAttentionLabels.map((label) => (
                              <span key={label} className="room-status-bed-attention-tag">{label}</span>
                            ))}
                          </span>
                        ) : null}
                        {bedOccupancyRatio ? (
                          <span className="room-status-bed-occupancy-summary" aria-hidden="true">
                            <span className="room-status-bed-state">占用</span>
                            <span className="room-status-bed-occupancy">{bedOccupancyRatio}</span>
                          </span>
                        ) : directLodging ? (
                          <span className="room-status-direct-occupancy-summary" aria-hidden="true">
                            <span className="room-status-bed-state">{roomStatusIntervalStatusLabel(directLodging, board.businessDate)}</span>
                            <span className="room-status-direct-count">{directLodging.occupantCount}人</span>
                          </span>
                        ) : historicalBlank ? null : <RoomStatusMark status={status} label={cellStatusLabel} compact />}
                        {startingIntervals.map(({ interval, startColumn, endColumn, lane }) => {
                          const gridLabel = roomStatusIntervalGridLabel(interval, unit);
                          const maintenance = interval.sourceKind === "MAINTENANCE" && interval.status === "MAINTENANCE";
                          const intervalStatusLabel = roomStatusIntervalStatusLabel(interval, board.businessDate);
                          const intervalAriaLabel = maintenance
                            ? `${gridLabel}，${formatRoomStatusDate(interval.startDate)}至${formatRoomStatusDate(interval.endDate)}`
                            : `${gridLabel}，${roomStatusSourceLabels[interval.sourceKind]}，${formatRoomStatusDate(interval.startDate)}至${formatRoomStatusDate(interval.endDate)}，${intervalStatusLabel}`;
                          return (
                            <button
                              key={interval.id}
                              type="button"
                              className={`room-status-interval room-status-interval-${interval.status.toLowerCase().replaceAll("_", "-")}${interval.blocking ? " is-blocking" : ""}${interval.conflicts.length ? " has-blocking-conflict" : ""}${roomStatusIntervalNeedsProcessing(interval, board.businessDate) ? " has-attention-interval" : ""}`}
                              style={{ left: 0, width: `${(endColumn - startColumn) * 100}%`, top: `calc(5px + ${lane + attentionLaneOffset} * 25px)` }}
                              aria-label={intervalAriaLabel}
                              title={maintenance ? gridLabel : `${roomStatusSourceLabels[interval.sourceKind]} · ${gridLabel}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              onClick={(event) => onInspectInterval(
                                unit,
                                interval,
                                event.currentTarget,
                                roomStatusIntervalServiceDateAtPointer(
                                  dates,
                                  startColumn,
                                  endColumn,
                                  event.currentTarget.getBoundingClientRect(),
                                  event.clientX
                                )
                              )}
                            >
                              <span>{gridLabel}</span>
                              {maintenance ? null : <small>{roomStatusSourceLabels[interval.sourceKind]} · {intervalStatusLabel}</small>}
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
        </div>

      {board.page.totalPages > 1 ? (
        <footer className="room-status-grid-footer">
          <div aria-label={`房间分页，当前第 ${board.page.index + 1} / ${board.page.totalPages} 页`}>
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
      ) : null}
      {bedOccupancyTooltip ? (
        <div
          ref={bedOccupancyTooltipRef}
          className={`room-status-bed-occupancy-tooltip is-${bedOccupancyTooltip.placement.toLowerCase()}`}
          role="tooltip"
          tabIndex={0}
          data-testid="bed-occupancy-tooltip"
          style={{
            left: bedOccupancyTooltip.left,
            top: bedOccupancyTooltip.top,
            bottom: bedOccupancyTooltip.bottom,
            maxHeight: bedOccupancyTooltip.maxHeight
          }}
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
