import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Eraser, RefreshCw, Search } from "lucide-react";
import type { RoomStatusBoardDto } from "@qintopia/contracts";
import {
  hasActiveRoomStatusFilters,
  type RoomStatusFilterOptions,
  type RoomStatusFilters
} from "./roomStatusState";

const salesModeLabels = {
  WHOLE_ROOM: "整房销售",
  BED_SPLIT: "可按床销售",
  UNAVAILABLE: "不可售"
} as const;

const statusLabels = {
  AVAILABLE: "可售",
  RESERVED: "已预订",
  IN_HOUSE: "在住",
  CLEANING: "待清洁",
  MAINTENANCE: "维修 / 锁房",
  UNAVAILABLE: "不可售",
  STALE: "数据陈旧",
  UNKNOWN: "状态未知"
} as const;

export interface RoomStatusRange {
  arrivalDate: string;
  departureDate: string;
}

export interface RoomStatusToolbarProps {
  board: RoomStatusBoardDto;
  propertyLabel: string;
  principalLabel: string;
  range: RoomStatusRange;
  filters: RoomStatusFilters;
  filterOptions: RoomStatusFilterOptions;
  filteredRoomCount: number;
  loading?: boolean;
  rangeLoading?: boolean;
  rangeError?: string | undefined;
  focusSearchRequestToken?: number;
  onRangeChange: (range: RoomStatusRange) => void;
  onPreviousRange: () => void;
  onNextRange: () => void;
  onToday: () => void;
  onFiltersChange: (filters: RoomStatusFilters) => void;
  onClearFilters: () => void;
  onRefresh: () => void;
}

function updateFilter<K extends keyof RoomStatusFilters>(
  filters: RoomStatusFilters,
  key: K,
  value: RoomStatusFilters[K],
  onChange: (filters: RoomStatusFilters) => void
) {
  onChange({ ...filters, [key]: value });
}

export function RoomStatusToolbar({
  board,
  propertyLabel,
  principalLabel,
  range,
  filters,
  filterOptions,
  filteredRoomCount,
  loading = false,
  rangeLoading = false,
  rangeError,
  focusSearchRequestToken = 0,
  onRangeChange,
  onPreviousRange,
  onNextRange,
  onToday,
  onFiltersChange,
  onClearFilters,
  onRefresh
}: RoomStatusToolbarProps) {
  const projectionReady = board.projectionState === "READY";
  const rangeErrorId = useId();
  const rangeErrorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastFocusSearchRequestToken = useRef(focusSearchRequestToken);
  const [rangeDraft, setRangeDraft] = useState(range);

  useEffect(() => {
    setRangeDraft(range);
  }, [range.arrivalDate, range.departureDate]);

  useEffect(() => {
    if (rangeError) rangeErrorRef.current?.focus();
  }, [rangeError]);

  useEffect(() => {
    if (focusSearchRequestToken === lastFocusSearchRequestToken.current) return;
    lastFocusSearchRequestToken.current = focusSearchRequestToken;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusSearchRequestToken]);

  const changeRange = (nextRange: RoomStatusRange) => {
    setRangeDraft(nextRange);
    onRangeChange(nextRange);
  };

  return (
    <section className="room-status-toolbar" aria-label="房态范围、筛选和数据新鲜度">
      <div className="room-status-toolbar-primary">
        <div className="room-status-toolbar-identity">
          <span>当前物业</span>
          <strong>{propertyLabel}</strong>
          <small>{principalLabel} · {board.accessLevel === "WRITE" ? "可写" : "只读"}</small>
        </div>

        <div className="room-status-range-controls" aria-label="房态日期范围">
          <button type="button" className="room-status-icon-button" onClick={onPreviousRange} aria-label="查看前一日期窗口" title="前一日期窗口">
            <ChevronLeft aria-hidden="true" size={18} />
          </button>
          <label>开始日期
            <input
              type="date"
              value={rangeDraft.arrivalDate}
              max={rangeDraft.departureDate}
              data-testid="arrival-date"
              aria-invalid={rangeError ? "true" : undefined}
              aria-describedby={rangeError ? rangeErrorId : undefined}
              onChange={(event) => changeRange({ ...rangeDraft, arrivalDate: event.target.value })}
            />
          </label>
          <label>结束日期
            <input
              type="date"
              value={rangeDraft.departureDate}
              min={rangeDraft.arrivalDate}
              data-testid="departure-date"
              aria-invalid={rangeError ? "true" : undefined}
              aria-describedby={rangeError ? rangeErrorId : undefined}
              onChange={(event) => changeRange({ ...rangeDraft, departureDate: event.target.value })}
            />
          </label>
          <button type="button" className="room-status-button" onClick={onToday}>
            <CalendarDays aria-hidden="true" size={17} />今天
          </button>
          <button type="button" className="room-status-icon-button" onClick={onNextRange} aria-label="查看后一日期窗口" title="后一日期窗口">
            <ChevronRight aria-hidden="true" size={18} />
          </button>
          {rangeError ? (
            <div
              id={rangeErrorId}
              ref={rangeErrorRef}
              className="room-status-range-error"
              role="alert"
              tabIndex={-1}
              data-testid="room-status-range-error"
            >
              <strong>日期范围无效</strong>
              <span>{rangeError}</span>
            </div>
          ) : null}
        </div>

        <div className={`room-status-freshness room-status-freshness-${projectionReady ? "ready" : "partial"}`}>
          <span role="status" aria-live="polite">{rangeLoading ? "正在载入新范围，旧事实不可操作" : projectionReady ? "投影完整" : "投影不完整，写动作应保持阻断"}</span>
          <strong>数据时点 {new Date(board.asOf).toLocaleString("zh-CN", { hour12: false })}</strong>
          <small>有效至 {new Date(board.freshUntil).toLocaleString("zh-CN", { hour12: false })}</small>
        </div>
      </div>

      <div className="room-status-filter-row">
        <label className="room-status-search-field">搜索房间或床位
          <span>
            <Search aria-hidden="true" size={16} />
            <input
              ref={searchInputRef}
              type="search"
              value={filters.search}
              placeholder="房号、名称、楼栋或价格产品"
              onChange={(event) => updateFilter(filters, "search", event.target.value, onFiltersChange)}
            />
          </span>
        </label>
        <label>房型
          <select value={filters.roomTypeCode} onChange={(event) => updateFilter(filters, "roomTypeCode", event.target.value, onFiltersChange)}>
            <option value="ALL">全部房型</option>
            {filterOptions.roomTypeCodes.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
        <label>销售模式
          <select value={filters.salesMode} onChange={(event) => updateFilter(filters, "salesMode", event.target.value as RoomStatusFilters["salesMode"], onFiltersChange)}>
            <option value="ALL">全部模式</option>
            {filterOptions.salesModes.map((mode) => <option key={mode} value={mode}>{salesModeLabels[mode]}</option>)}
          </select>
        </label>
        <label>状态
          <select value={filters.status} onChange={(event) => updateFilter(filters, "status", event.target.value as RoomStatusFilters["status"], onFiltersChange)}>
            <option value="ALL">全部状态</option>
            {filterOptions.statuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
          </select>
        </label>
        <label>库存粒度
          <select value={filters.kind} onChange={(event) => updateFilter(filters, "kind", event.target.value as RoomStatusFilters["kind"], onFiltersChange)}>
            <option value="ALL">房间和床位</option>
            <option value="ROOM">房间</option>
            <option value="BED">床位</option>
          </select>
        </label>
        <label>房间容量
          <select
            value={filters.minimumCapacity ?? "ALL"}
            onChange={(event) => updateFilter(filters, "minimumCapacity", event.target.value === "ALL" ? null : Number(event.target.value), onFiltersChange)}
          >
            <option value="ALL">不限房间容量</option>
            {filterOptions.capacities.map((capacity) => <option key={capacity} value={capacity}>{capacity} 人及以上</option>)}
          </select>
        </label>
        <div className="room-status-filter-summary" aria-live="polite">
          <span>{filteredRoomCount} 间房</span>
          {hasActiveRoomStatusFilters(filters) ? (
            <button type="button" className="room-status-button room-status-button-secondary" onClick={onClearFilters}>
              <Eraser aria-hidden="true" size={16} />清除筛选
            </button>
          ) : null}
          <button type="button" className="room-status-button room-status-button-secondary" onClick={onRefresh} disabled={loading}>
            <RefreshCw aria-hidden="true" className={loading ? "room-status-spin" : undefined} size={16} />{loading ? "正在刷新" : "刷新房态"}
          </button>
        </div>
      </div>
    </section>
  );
}
