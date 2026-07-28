import { useEffect, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarRange,
  Clock3,
  Layers3,
  ShieldAlert,
  X
} from "lucide-react";
import type {
  RoomStatusActionDto,
  RoomStatusBoardDto,
  RoomStatusConflictDto,
  RoomStatusDayDto,
  RoomStatusIntervalDto,
  RoomStatusReferenceDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import { selectionFromInputs, type RoomStatusSelection } from "./roomStatusState";
import {
  formatRoomStatusDate,
  formatRoomStatusDateTime,
  roomStatusActionLabels,
  roomStatusIntervalBusinessLabel,
  roomStatusOccupancyCapacity,
  roomStatusSaleCapabilityLabel,
  roomStatusSelectedSaleLabel,
  roomStatusSourceLabels,
  roomStatusUnitLabel,
  RoomStatusMark,
  RoomStatusWarning
} from "./roomStatusPresentation";

export interface RoomStatusContextProps {
  board: RoomStatusBoardDto;
  selectedUnit: RoomStatusUnitDto | null;
  selectedDay: RoomStatusDayDto | null;
  selectedInterval: RoomStatusIntervalDto | null;
  relatedIntervals: readonly RoomStatusIntervalDto[];
  selection: RoomStatusSelection | null;
  conflicts: readonly RoomStatusConflictDto[];
  allowedActions: readonly RoomStatusActionDto[];
  onSelectedUnitChange: (unit: RoomStatusUnitDto) => void;
  onSelectionChange: (selection: RoomStatusSelection | null) => void;
  onOpenReference: (reference: RoomStatusReferenceDto) => void;
  onOpenReceipt: (receiptId: string) => void;
  onAction: (action: RoomStatusActionDto) => void;
  onClose?: () => void;
}

interface SelectionDraft {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}

function flattenUnits(rooms: readonly RoomStatusUnitDto[]): RoomStatusUnitDto[] {
  return rooms.flatMap((room) => room.salesMode === "BED_SPLIT" ? [room, ...room.children] : [room]);
}

function unitOptionLabel(unit: RoomStatusUnitDto): string {
  const kind = unit.kind === "ROOM" ? "房间" : "床位";
  return `${roomStatusUnitLabel(unit)}（${kind}）`;
}

function ConflictList({ conflicts }: { conflicts: readonly RoomStatusConflictDto[] }) {
  if (!conflicts.length) return <p className="room-status-context-empty">当前所选日期可以安排住宿。</p>;
  return (
    <ul className="room-status-conflict-list">
      {conflicts.map((conflict) => (
        <li key={conflict.id}>
          <div>
            <AlertTriangle aria-hidden="true" size={17} />
            <strong>{roomStatusSourceLabels[conflict.sourceKind]} 已有住宿，不能重复安排</strong>
            <span>{formatRoomStatusDate(conflict.startDate)}至{formatRoomStatusDate(conflict.endDate)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RoomStatusContext({
  board,
  selectedUnit,
  selectedDay,
  selectedInterval,
  relatedIntervals,
  selection,
  conflicts,
  allowedActions,
  onSelectedUnitChange,
  onSelectionChange,
  onOpenReference,
  onOpenReceipt,
  onAction,
  onClose
}: RoomStatusContextProps) {
  const units = useMemo(() => flattenUnits(board.rooms), [board.rooms]);
  const dateErrorId = useId();
  const initialUnitId = selection?.unitId ?? selectedUnit?.id ?? "";
  const [draft, setDraft] = useState<SelectionDraft>({
    unitId: initialUnitId,
    arrivalDate: selection?.arrivalDate ?? "",
    departureDate: selection?.departureDate ?? ""
  });

  useEffect(() => {
    setDraft({
      unitId: selection?.unitId ?? selectedUnit?.id ?? "",
      arrivalDate: selection?.arrivalDate ?? "",
      departureDate: selection?.departureDate ?? ""
    });
  }, [selectedUnit?.id, selection?.arrivalDate, selection?.departureDate, selection?.unitId]);

  const candidateDraftSelection = selectionFromInputs(draft.unitId, draft.arrivalDate, draft.departureDate);
  const draftDateError = draft.arrivalDate && draft.departureDate
    ? !candidateDraftSelection
      ? "退房日期必须晚于入住日期。"
      : candidateDraftSelection.arrivalDate < board.range.arrivalDate
        || candidateDraftSelection.departureDate > board.range.departureDate
        ? `日期必须位于当前房态查询区间 [${board.range.arrivalDate}, ${board.range.departureDate}) 内。`
        : undefined
    : undefined;
  const draftSelection = draftDateError ? null : candidateDraftSelection;
  const contextIntervals = useMemo(() => {
    const intervals = selectedInterval ? [selectedInterval, ...relatedIntervals] : [...relatedIntervals];
    return [...new Map(intervals.map((interval) => [interval.id, interval])).values()];
  }, [relatedIntervals, selectedInterval]);
  const status = selectedInterval?.status ?? selectedDay?.status;
  const contextTitle = selectedInterval?.label ?? (selectedUnit ? roomStatusUnitLabel(selectedUnit) : "尚未选择房源");

  const changeUnit = (unitId: string) => {
    const nextDraft = { ...draft, unitId };
    setDraft(nextDraft);
    const unit = units.find((candidate) => candidate.id === unitId);
    if (unit) onSelectedUnitChange(unit);
    const nextSelection = selectionFromInputs(nextDraft.unitId, nextDraft.arrivalDate, nextDraft.departureDate);
    if (nextSelection
      && nextSelection.arrivalDate >= board.range.arrivalDate
      && nextSelection.departureDate <= board.range.departureDate) onSelectionChange(nextSelection);
  };

  const changeDraftDate = (field: "arrivalDate" | "departureDate", value: string) => {
    const nextDraft = { ...draft, [field]: value };
    setDraft(nextDraft);
    const nextSelection = selectionFromInputs(nextDraft.unitId, nextDraft.arrivalDate, nextDraft.departureDate);
    if (nextSelection
      && nextSelection.arrivalDate >= board.range.arrivalDate
      && nextSelection.departureDate <= board.range.departureDate) onSelectionChange(nextSelection);
  };

  return (
    <aside className="room-status-context" aria-labelledby="room-status-context-heading">
      <header className="room-status-context-header">
        <div>
          <span>选中对象上下文</span>
          <h2 id="room-status-context-heading">{contextTitle}</h2>
        </div>
        <div className="room-status-context-header-actions">
          {status ? <RoomStatusMark status={status} /> : null}
          {onClose ? <button type="button" className="room-status-icon-button" onClick={onClose} aria-label="关闭选中对象上下文" title="关闭选中对象上下文"><X aria-hidden="true" size={17} /></button> : null}
        </div>
      </header>

      <section className="room-status-selection-editor" aria-labelledby="room-status-selection-heading">
        <div className="room-status-context-section-heading">
          <CalendarRange aria-hidden="true" size={17} />
          <h3 id="room-status-selection-heading">日期选区</h3>
        </div>
        <p>修改房源或日期后自动更新住宿草稿，不会创建订单。</p>
        <label>房间或床位
          <select data-testid="room-status-unit-select" value={draft.unitId} onChange={(event) => changeUnit(event.target.value)}>
            <option value="">请选择房源</option>
            {units.map((unit) => <option key={unit.id} value={unit.id}>{unitOptionLabel(unit)}</option>)}
          </select>
        </label>
        <div className="room-status-date-inputs">
          <label>入住日期
            <input
              type="date"
              value={draft.arrivalDate}
              min={board.range.arrivalDate}
              max={board.range.departureDate}
              aria-invalid={draftDateError ? "true" : undefined}
              aria-describedby={draftDateError ? dateErrorId : undefined}
              onChange={(event) => changeDraftDate("arrivalDate", event.target.value)}
            />
          </label>
          <label>退房日期
            <input
              type="date"
              value={draft.departureDate}
              min={draft.arrivalDate || board.range.arrivalDate}
              max={board.range.departureDate}
              aria-invalid={draftDateError ? "true" : undefined}
              aria-describedby={draftDateError ? dateErrorId : undefined}
              onChange={(event) => changeDraftDate("departureDate", event.target.value)}
            />
          </label>
        </div>
        {draftDateError ? (
          <div
            id={dateErrorId}
            className="room-status-field-error-summary"
            role="alert"
            tabIndex={-1}
            data-testid="room-status-selection-date-error"
          >
            <RoomStatusWarning>{draftDateError}</RoomStatusWarning>
          </div>
        ) : null}
      </section>

      {selectedUnit ? (
        <section className="room-status-context-section" aria-labelledby="room-status-unit-heading">
          <div className="room-status-context-section-heading">
            <Layers3 aria-hidden="true" size={17} />
            <h3 id="room-status-unit-heading">房间信息</h3>
          </div>
          <dl className="room-status-context-facts">
            <dt>楼栋 / 房源</dt><dd>{roomStatusUnitLabel(selectedUnit)}</dd>
            <dt>粒度</dt><dd>{selectedUnit.kind === "ROOM" ? "房间" : "床位"}</dd>
            <dt>当前选择</dt><dd>{roomStatusSelectedSaleLabel(selectedUnit)}</dd>
            <dt>房间可售方式</dt><dd>{roomStatusSaleCapabilityLabel(selectedUnit)}</dd>
            <dt>容纳人数</dt><dd>{roomStatusOccupancyCapacity(selectedUnit)}</dd>
          </dl>
        </section>
      ) : null}

      {selectedInterval ? (
        <section className="room-status-context-section" aria-labelledby="room-status-source-heading">
          <div className="room-status-context-section-heading">
            <ShieldAlert aria-hidden="true" size={17} />
            <h3 id="room-status-source-heading">住宿或锁房记录</h3>
          </div>
          <dl className="room-status-context-facts">
            <dt>业务类型</dt><dd>{roomStatusSourceLabels[selectedInterval.sourceKind]}</dd>
            <dt>住宿人</dt><dd>{selectedInterval.sourceKind === "ORDER" || selectedInterval.sourceKind === "FREE_STAY" ? roomStatusIntervalBusinessLabel(selectedInterval) : "不适用"}</dd>
            <dt>住宿日期</dt><dd>{formatRoomStatusDate(selectedInterval.sourceStartDate)}至{formatRoomStatusDate(selectedInterval.sourceEndDate)}</dd>
            <dt>原因</dt><dd>{selectedInterval.reason ?? "未提供原因"}</dd>
          </dl>
        </section>
      ) : selectedDay ? (
        <section className="room-status-context-section" aria-labelledby="room-status-day-heading">
          <div className="room-status-context-section-heading">
            <Clock3 aria-hidden="true" size={17} />
            <h3 id="room-status-day-heading">当日房态</h3>
          </div>
          <dl className="room-status-context-facts">
            <dt>日期</dt><dd>{selectedDay.serviceDate}</dd>
            <dt>状态</dt><dd><RoomStatusMark status={selectedDay.status} compact /></dd>
            <dt>可安排住宿</dt><dd>{selectedDay.available ? "是" : "否"}</dd>
            <dt>关联记录</dt><dd>{selectedDay.intervalIds.length ? `${selectedDay.intervalIds.length} 条` : "无"}</dd>
          </dl>
        </section>
      ) : null}

      {!selectedInterval && contextIntervals.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-related-sources-heading">
          <div className="room-status-context-section-heading">
            <ShieldAlert aria-hidden="true" size={17} />
            <h3 id="room-status-related-sources-heading">选区内住宿或锁房</h3>
          </div>
          <ol className="room-status-related-source-list">
            {contextIntervals.map((interval) => (
              <li key={interval.id}>
                <strong>{roomStatusSourceLabels[interval.sourceKind]} · {interval.label}</strong>
                <dl className="room-status-context-facts">
                  <dt>住宿日期</dt><dd>{formatRoomStatusDate(interval.sourceStartDate)}至{formatRoomStatusDate(interval.sourceEndDate)}</dd>
                </dl>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="room-status-context-section" aria-labelledby="room-status-conflicts-heading">
        <div className="room-status-context-section-heading">
          <AlertTriangle aria-hidden="true" size={17} />
          <h3 id="room-status-conflicts-heading">日期占用</h3>
        </div>
        <ConflictList conflicts={conflicts} />
      </section>

      <section className="room-status-context-actions" aria-labelledby="room-status-actions-heading">
        <div className="room-status-context-section-heading">
          <ArrowRight aria-hidden="true" size={17} />
          <h3 id="room-status-actions-heading">可执行操作</h3>
        </div>
        {allowedActions.length ? (
          <ul>
            {allowedActions.map((action) => (
              <li key={`${action.code}:${action.targetReference?.type ?? "none"}:${action.targetReference?.id ?? "none"}`}>
                <button type="button" className="room-status-button" disabled={!action.enabled} onClick={() => onAction(action)}>
                  {roomStatusActionLabels[action.code]}<ArrowRight aria-hidden="true" size={16} />
                </button>
                {action.requiresFullInterval ? <small>只允许针对完整有效区间执行。</small> : null}
                {!action.enabled && action.disabledReason ? <small className="room-status-action-disabled"><AlertTriangle aria-hidden="true" size={14} />{action.disabledReason}</small> : null}
              </li>
            ))}
          </ul>
        ) : <p className="room-status-context-empty">服务端未为当前对象下发可执行动作。</p>}
      </section>

      <footer className="room-status-context-freshness">
        <Clock3 aria-hidden="true" size={15} />
        <span>数据时点 {formatRoomStatusDateTime(board.asOf)}</span>
        <span>有效至 {formatRoomStatusDateTime(board.freshUntil)}</span>
      </footer>
    </aside>
  );
}
