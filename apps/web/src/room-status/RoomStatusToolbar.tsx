import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Eraser, RefreshCw, Search } from "lucide-react";
import {
  addLocalDateDays,
  hasActiveRoomStatusFilters,
  isIsoLocalDate,
  ROOM_STATUS_TIMELINE_DAYS,
  type RoomStatusFilterOptions,
  type RoomStatusFilters
} from "./roomStatusState";
import { formatRoomStatusDate, roomStatusRoomTypeLabel } from "./roomStatusPresentation";

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
  range: RoomStatusRange;
  filters: RoomStatusFilters;
  filterOptions: RoomStatusFilterOptions;
  loading?: boolean;
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
  range,
  filters,
  filterOptions,
  loading = false,
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
  const changeStartDate = (startDate: string) => {
    if (!isIsoLocalDate(startDate)) {
      changeRange({ arrivalDate: startDate, departureDate: rangeDraft.departureDate });
      return;
    }
    const nextRange = {
      arrivalDate: startDate,
      departureDate: addLocalDateDays(startDate, ROOM_STATUS_TIMELINE_DAYS)
    };
    changeRange(nextRange);
  };

  return (
    <section className="room-status-toolbar" aria-label="房态范围与筛选">
      <div className="room-status-toolbar-primary">
        <div className="room-status-toolbar-title">
          <h1>房间与床位逐日房态</h1>
        </div>

        <div className="room-status-range-controls" aria-label="房态起始日期">
          <button type="button" className="room-status-icon-button" onClick={onPreviousRange} aria-label="查看前 30 夜" title="前 30 夜">
            <ChevronLeft aria-hidden="true" size={18} />
          </button>
          <label>起始日期
            <input
              type="date"
              value={rangeDraft.arrivalDate}
              data-testid="arrival-date"
              aria-invalid={rangeError ? "true" : undefined}
              aria-describedby={rangeError ? rangeErrorId : undefined}
              onChange={(event) => changeStartDate(event.target.value)}
            />
          </label>
          <span className="room-status-range-summary">{formatRoomStatusDate(rangeDraft.arrivalDate)}起，显示 30 夜</span>
          <button type="button" className="room-status-button" onClick={onToday}>
            <CalendarDays aria-hidden="true" size={17} />今天
          </button>
          <button type="button" className="room-status-icon-button" onClick={onNextRange} aria-label="查看后 30 夜" title="后 30 夜">
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
            {filterOptions.roomTypeCodes.map((code) => <option key={code} value={code}>{roomStatusRoomTypeLabel(code)}</option>)}
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
        <div className="room-status-filter-summary">
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
