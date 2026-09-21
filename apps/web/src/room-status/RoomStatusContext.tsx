import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarRange,
  Clock3,
  Layers3,
  RefreshCw,
  Search,
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
import {
  addLocalDateDays,
  isIsoLocalDate,
  roomStatusIntervalBusinessPeriod,
  selectionFromInputs,
  type RoomStatusSelection
} from "./roomStatusState";
import {
  formatRoomStatusDate,
  roomStatusActionLabels,
  roomStatusIntervalAttentionLabels,
  roomStatusIntervalBusinessLabel,
  roomStatusOccupancyCapacity,
  roomStatusSaleCapabilityLabel,
  roomStatusSelectedSaleLabel,
  roomStatusSourceLabels,
  roomStatusUnitLabel,
  RoomStatusAttentionBadges,
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
  writeBlock?: { kind: "REFRESH" | "RECOVERY" | "PERMISSION"; reason: string; actionLabel?: string };
  onSelectedUnitChange: (unit: RoomStatusUnitDto) => void;
  onSelectionChange: (selection: RoomStatusSelection | null) => void;
  onDraftValidityChange: (valid: boolean) => void;
  onOpenReference: (reference: RoomStatusReferenceDto) => void;
  onOpenReceipt: (receiptId: string) => void;
  onAction: (action: RoomStatusActionDto) => void;
  onRefresh?: () => void;
  onOpenRecovery?: () => void;
  onClose?: () => void;
}

interface SelectionDraft {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}

const MAX_STAY_SELECTION_NIGHTS = 366;

function flattenUnits(rooms: readonly RoomStatusUnitDto[]): RoomStatusUnitDto[] {
  return rooms.flatMap((room) => room.salesMode === "BED_SPLIT" ? [room, ...room.children] : [room]);
}

function unitOptionLabel(unit: RoomStatusUnitDto): string {
  const kind = unit.kind === "ROOM" ? "房间" : "床位";
  return `${roomStatusUnitLabel(unit)}（${kind}）`;
}

function ConflictList({ conflicts, emptyMessage }: { conflicts: readonly RoomStatusConflictDto[]; emptyMessage: string }) {
  if (!conflicts.length) return <p className="room-status-context-empty">{emptyMessage}</p>;
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

function selectionNightCount(arrivalDate: string, departureDate: string): number {
  if (!isIsoLocalDate(arrivalDate) || !isIsoLocalDate(departureDate) || departureDate <= arrivalDate) return 0;
  return Math.round((Date.parse(`${departureDate}T00:00:00.000Z`) - Date.parse(`${arrivalDate}T00:00:00.000Z`)) / 86_400_000);
}

export function roomStatusDraftSelection(input: {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}): { selection: RoomStatusSelection | null; valid: boolean } {
  const selection = selectionFromInputs(input.unitId, input.arrivalDate, input.departureDate);
  const valid = Boolean(selection
    && selectionNightCount(selection.arrivalDate, selection.departureDate) <= MAX_STAY_SELECTION_NIGHTS);
  return { selection: valid ? selection : null, valid };
}

function relatedSourceSummary(interval: RoomStatusIntervalDto): string {
  const period = roomStatusIntervalBusinessPeriod(interval);
  const dates = `${formatRoomStatusDate(period.arrivalDate)}至${formatRoomStatusDate(period.departureDate)}`;
  const source = roomStatusSourceLabels[interval.sourceKind];
  if (interval.sourceKind === "MAINTENANCE") {
    return `${source} · ${dates} · 原因：${interval.reason ?? "未提供原因"}`;
  }
  if (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY") {
    return `${source} · ${roomStatusIntervalBusinessLabel(interval)} · ${dates}`;
  }
  return `${source} · ${dates}`;
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
  writeBlock,
  onSelectedUnitChange,
  onSelectionChange,
  onDraftValidityChange,
  onOpenReference,
  onOpenReceipt,
  onAction,
  onRefresh,
  onOpenRecovery,
  onClose
}: RoomStatusContextProps) {
  const units = useMemo(() => flattenUnits(board.rooms), [board.rooms]);
  const dateErrorId = useId();
  const actionReasonIdPrefix = useId();
  const preserveInvalidDraft = useRef(false);
  const initialUnitId = selection?.unitId ?? selectedUnit?.id ?? "";
  const [draft, setDraft] = useState<SelectionDraft>({
    unitId: initialUnitId,
    arrivalDate: selection?.arrivalDate ?? "",
    departureDate: selection?.departureDate ?? ""
  });

  useEffect(() => {
    // Clearing the upstream selection is required to stop actions targeting the
    // previous range. Keep the typed invalid dates locally so the operator can
    // correct them without having to re-enter the whole range.
    if (selection === null && preserveInvalidDraft.current) {
      onDraftValidityChange(false);
      return;
    }
    preserveInvalidDraft.current = false;
    setDraft({
      unitId: selection?.unitId ?? selectedUnit?.id ?? "",
      arrivalDate: selection?.arrivalDate ?? "",
      departureDate: selection?.departureDate ?? ""
    });
    onDraftValidityChange(true);
  }, [onDraftValidityChange, selectedUnit?.id, selection?.arrivalDate, selection?.departureDate, selection?.unitId]);

  const candidateDraftSelection = selectionFromInputs(draft.unitId, draft.arrivalDate, draft.departureDate);
  const draftNightCount = selectionNightCount(draft.arrivalDate, draft.departureDate);
  const draftDateError = draft.arrivalDate && draft.departureDate
    ? !candidateDraftSelection
      ? "退房日期必须晚于入住日期。"
      : draftNightCount > MAX_STAY_SELECTION_NIGHTS
        ? `住宿日期最长 ${MAX_STAY_SELECTION_NIGHTS} 夜。`
        : undefined
    : undefined;
  const draftSelection = draftDateError ? null : candidateDraftSelection;
  const draftOutsideBoard = Boolean(draftSelection
    && (draftSelection.arrivalDate < board.range.arrivalDate
      || draftSelection.departureDate > board.range.departureDate));
  const historicalDraft = Boolean(draftSelection && draftSelection.arrivalDate < board.businessDate && !selectedInterval);
  const backfillLabel = historicalDraft
    ? draftSelection!.departureDate <= board.businessDate ? "已完成住宿补录" : "在住住宿补录"
    : undefined;
  const draftDays = selectedUnit?.id === draftSelection?.unitId
    ? selectedUnit?.days.filter((day) => day.serviceDate >= draftSelection!.arrivalDate
      && day.serviceDate < draftSelection!.departureDate) ?? []
    : [];
  const hasExistingStay = draftDays.some((day) => day.intervalIds.length > 0);
  const unavailableDraft = draftDays.some((day) => day.serviceDate < board.businessDate
    ? day.status !== "AVAILABLE"
    : !day.available);
  const occupancyMessage = !draftSelection
    ? "请先选择房源并填写有效的入住、退房日期。"
    : writeBlock?.kind === "REFRESH"
      ? "房态尚未核对完成，暂时无法确认所选日期的占用情况。"
      : hasExistingStay
        ? "所选日期已有住宿或锁房记录，请先核对已有记录。"
        : unavailableDraft
          ? "所选日期包含不可安排住宿的日期，请核对房态。"
          : draftOutsideBoard || draftDays.length !== draftNightCount
            ? "当前已显示的日期未发现占用；其余日期将在办理时核对。"
            : "所选日期未发现占用，办理时将再次核对。";
  const noActionMessage = !draftSelection
    ? "请先选择房源并填写有效的入住、退房日期。"
    : hasExistingStay || unavailableDraft || conflicts.length
      ? "所选日期存在住宿、锁房或不可用状态，暂不能新建或补录住宿。"
      : "当前房源暂无可办理的住宿操作，请刷新房态；仍不可操作时请联系管理员核对权限。";
  const contextIntervals = useMemo(() => {
    const intervals = selectedInterval ? [selectedInterval, ...relatedIntervals] : [...relatedIntervals];
    return [...new Map(intervals.map((interval) => [interval.id, interval])).values()];
  }, [relatedIntervals, selectedInterval]);
  const contextAttentionLabels = [...new Set(contextIntervals.flatMap(roomStatusIntervalAttentionLabels))];
  const selectedBusinessPeriod = selectedInterval ? roomStatusIntervalBusinessPeriod(selectedInterval) : null;
  const status = selectedInterval?.status ?? selectedDay?.status;
  const contextTitle = selectedInterval?.label ?? (selectedUnit ? roomStatusUnitLabel(selectedUnit) : "尚未选择房源");

  const changeUnit = (unitId: string) => {
    const nextDraft = { ...draft, unitId };
    setDraft(nextDraft);
    const unit = units.find((candidate) => candidate.id === unitId);
    if (unit) onSelectedUnitChange(unit);
    const next = roomStatusDraftSelection(nextDraft);
    onDraftValidityChange(next.valid);
    if (next.valid && next.selection) {
      preserveInvalidDraft.current = false;
      onSelectionChange(next.selection);
    } else {
      preserveInvalidDraft.current = true;
      onSelectionChange(null);
    }
  };

  const changeDraftDate = (field: "arrivalDate" | "departureDate", value: string) => {
    const nextDraft = { ...draft, [field]: value };
    setDraft(nextDraft);
    const next = roomStatusDraftSelection(nextDraft);
    onDraftValidityChange(next.valid);
    if (next.valid && next.selection) {
      preserveInvalidDraft.current = false;
      onSelectionChange(next.selection);
    } else {
      preserveInvalidDraft.current = true;
      onSelectionChange(null);
    }
  };

  return (
    <aside className="room-status-context" aria-labelledby="room-status-context-heading">
      <header className="room-status-context-header">
        <div>
          <span>{backfillLabel ?? "选中对象上下文"}</span>
          <h2 id="room-status-context-heading">{contextTitle}</h2>
        </div>
        <div className="room-status-context-header-actions">
          {status ? <RoomStatusMark status={status} /> : null}
          <RoomStatusAttentionBadges labels={contextAttentionLabels} />
          {onClose ? <button type="button" className="room-status-icon-button" onClick={onClose} aria-label="关闭选中对象上下文" title="关闭选中对象上下文"><X aria-hidden="true" size={17} /></button> : null}
        </div>
      </header>

      <section className="room-status-selection-editor" aria-labelledby="room-status-selection-heading">
        <div className="room-status-context-section-heading">
          <CalendarRange aria-hidden="true" size={17} />
          <h3 id="room-status-selection-heading">日期选区</h3>
        </div>
        <p className="room-status-selection-intro">选择房源和住宿日期，再选择下方操作；修改日期不会创建订单。</p>
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
              max={draft.departureDate ? addLocalDateDays(draft.departureDate, -1) : undefined}
              aria-invalid={draftDateError ? "true" : undefined}
              aria-describedby={draftDateError ? dateErrorId : undefined}
              onChange={(event) => changeDraftDate("arrivalDate", event.target.value)}
            />
          </label>
          <label>退房日期
            <input
              type="date"
              value={draft.departureDate}
              min={draft.arrivalDate ? addLocalDateDays(draft.arrivalDate, 1) : undefined}
              max={draft.arrivalDate ? addLocalDateDays(draft.arrivalDate, MAX_STAY_SELECTION_NIGHTS) : undefined}
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
        {backfillLabel || draftOutsideBoard ? <div className="room-status-selection-notes" role="status">
          {backfillLabel ? <p><strong>{backfillLabel}</strong><span>入住日期早于今天，请通过“补录住宿”登记。{draftSelection!.departureDate <= board.businessDate ? "确认补录后将记录已完成的住宿。" : "确认补录后将记为在住。"}</span></p> : null}
          {draftOutsideBoard ? <p className="room-status-selection-note">日历当前显示 {board.range.arrivalDate} 至 {addLocalDateDays(board.range.departureDate, -1)} 的每晚房态。所选住宿日期已保留，超出部分将在办理时核对。</p> : null}
        </div> : null}
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
            <dt>住宿日期</dt><dd>{formatRoomStatusDate(selectedBusinessPeriod!.arrivalDate)}至{formatRoomStatusDate(selectedBusinessPeriod!.departureDate)}</dd>
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
                <strong>{relatedSourceSummary(interval)}</strong>
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
        <ConflictList conflicts={conflicts} emptyMessage={occupancyMessage} />
      </section>

      <section className="room-status-context-actions" aria-labelledby="room-status-actions-heading">
        <div className="room-status-context-section-heading">
          <ArrowRight aria-hidden="true" size={17} />
          <h3 id="room-status-actions-heading">可执行操作</h3>
        </div>
        {writeBlock ? <div className="room-status-action-gate" role="status">
          <p><AlertTriangle aria-hidden="true" size={15} />{writeBlock.reason}</p>
          {writeBlock.kind === "REFRESH" && onRefresh && writeBlock.actionLabel
            ? <button type="button" className="button button-secondary" onClick={onRefresh}><RefreshCw aria-hidden="true" size={16} />{writeBlock.actionLabel}</button>
            : writeBlock.kind === "RECOVERY" && onOpenRecovery && writeBlock.actionLabel
              ? <button type="button" className="button button-secondary" onClick={onOpenRecovery}><Search aria-hidden="true" size={16} />{writeBlock.actionLabel}</button>
              : null}
        </div> : null}
        {allowedActions.length ? (
          <ul>
            {allowedActions.map((action) => {
              const actionKey = `${action.code}:${action.targetReference?.type ?? "none"}:${action.targetReference?.id ?? "none"}`;
              const disabledReason = !action.enabled ? action.disabledReason : undefined;
              const disabledReasonId = `${actionReasonIdPrefix}-${actionKey}`;
              return <li key={actionKey}>
                <button type="button" className="room-status-button" disabled={!action.enabled} aria-describedby={disabledReason ? disabledReasonId : undefined} onClick={() => {
                  if (!action.enabled) return;
                  onAction(action);
                }}>
                  {roomStatusActionLabels[action.code]}<ArrowRight aria-hidden="true" size={16} />
                </button>
                {disabledReason ? <small id={disabledReasonId} className="room-status-action-disabled" role="status"><AlertTriangle aria-hidden="true" size={14} />{disabledReason}</small> : null}
              </li>;
            })}
          </ul>
        ) : !writeBlock ? <p className="room-status-context-empty">{noActionMessage}</p> : null}
      </section>

    </aside>
  );
}
