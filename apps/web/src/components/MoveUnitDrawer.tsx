import { ArrowRightLeft, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import type { CommandRequest, InventoryUnitDto, OrderViewDto, UnitAvailabilityDto } from "../types";
import {
  InlineError,
  Modal,
  businessStatusLabel,
  formatDate,
  formatMoney,
  moveUnitPreviewSummary,
  stayDateFundsAreOperatorFacing,
  type RecoveryCoordinatedPreviewRunner,
  type MoveUnitPreviewSummary
} from "../ui";

const externalChannels = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const maxWholeYuan = 21_474_836;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export interface MoveUnitDraft {
  newInventoryUnitId: string;
  effectiveDate: string;
  reason: string;
  targetContractYuan: string;
  channelPriceDifferenceReason: string;
  manuallyAdjustWecomPrice: boolean;
  manualPriceAdjustmentReason: string;
}

type PreviewEvidence = {
  summary: MoveUnitPreviewSummary;
  expiresAt: string;
  signature: string;
};

type PreviewState =
  | { status: "EMPTY" }
  | { status: "LOADING" }
  | ({ status: "READY" | "REFRESHING" } & PreviewEvidence)
  | ({ status: "STALE"; error: unknown } & PreviewEvidence)
  | { status: "ERROR"; error: unknown };

type CandidateAvailabilityState =
  | { status: "LOADING" }
  | { status: "READY"; units: ReadonlyMap<string, UnitAvailabilityDto> }
  | { status: "ERROR" };

export type MoveUnitCandidateStatus =
  | { status: "LOADING" }
  | { status: "READY"; unit: UnitAvailabilityDto }
  | { status: "ERROR" };

function isLocalDate(value: string): boolean {
  if (!localDatePattern.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

function shiftDate(value: string, days: number): string {
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return value;
  return new Date(epoch + days * 86_400_000).toISOString().slice(0, 10);
}

function wholeYuanMinor(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const yuan = Number(value);
  if (!Number.isSafeInteger(yuan) || yuan < 0 || yuan > maxWholeYuan) return undefined;
  return yuan * 100;
}

function recoveredString(request: CommandRequest | undefined, key: string): string {
  const value = request?.commandType === "MOVE_UNIT" ? request.input[key] : undefined;
  return typeof value === "string" ? value : "";
}

function recoveredAmount(request: CommandRequest | undefined): string {
  const value = request?.commandType === "MOVE_UNIT" ? request.input.targetCurrentContractAmountMinor : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % 100 === 0
    ? String(value / 100)
    : "";
}

export function inventoryUnitAtDate(view: OrderViewDto, serviceDate: string): string | undefined {
  return view.effectiveArrangement.intervals.find((interval) => (
    interval.arrivalDate <= serviceDate && serviceDate < interval.departureDate
  ))?.inventoryUnitId;
}

export function moveUnitInitialDraft(
  view: OrderViewDto,
  units: readonly InventoryUnitDto[],
  recovered?: CommandRequest
): MoveUnitDraft {
  const recoveredTarget = recoveredString(recovered, "newInventoryUnitId");
  const candidates = moveUnitCandidates(view, units);
  const initialEffectiveDate = view.order.status === "CHECKED_IN"
    ? view.effectiveArrangement.businessDate
    : view.effectiveArrangement.arrivalDate;
  const effectiveDate = recoveredString(recovered, "effectiveDate") || initialEffectiveDate;
  const effectiveDateUnitId = inventoryUnitAtDate(view, effectiveDate);
  const defaultCandidate = candidates.find((unit) => unit.id !== effectiveDateUnitId) ?? candidates[0];
  const amount = recoveredAmount(recovered);
  return {
    newInventoryUnitId: candidates.some((unit) => unit.id === recoveredTarget)
      ? recoveredTarget
      : defaultCandidate?.id ?? "",
    effectiveDate,
    reason: recovered?.commandType === "MOVE_UNIT" ? recovered.initialReason?.note ?? "" : "",
    targetContractYuan: amount,
    channelPriceDifferenceReason: recoveredString(recovered, "channelPriceDifferenceReason"),
    manuallyAdjustWecomPrice: view.order.booking_channel_code === "WECOM" && amount !== "",
    manualPriceAdjustmentReason: recoveredString(recovered, "manualPriceAdjustmentReason")
  };
}

export function moveUnitCandidates(view: OrderViewDto, units: readonly InventoryUnitDto[]): InventoryUnitDto[] {
  return units
    .filter((unit) => unit.active && unit.property_id === view.order.property_id)
    .sort((left, right) => left.code.localeCompare(right.code, "zh-CN", { numeric: true }));
}

export function moveUnitCandidateStatusLabel(status: MoveUnitCandidateStatus): string {
  if (status.status === "LOADING") return "正在核对目标区间";
  if (status.status === "ERROR") return "目标区间状态暂不可用";
  return status.unit.available ? "目标区间可用" : "目标区间已有占用";
}

export function moveUnitCandidateOptionStatusLabel(status: MoveUnitCandidateStatus): string {
  if (status.status === "LOADING") return "核对中";
  if (status.status === "ERROR") return "状态暂不可用";
  return status.unit.available ? "可用" : "已有占用";
}

export function moveUnitCandidateDisplayName(unit: InventoryUnitDto): string {
  const name = unit.name.trim();
  const roomCode = unit.kind === "BED" ? unit.code.split("-")[0] : unit.code;
  for (const prefix of [`${unit.code} · `, `${unit.code}·`, `${roomCode} · `, `${roomCode}·`]) {
    if (prefix.length > 2 && name.startsWith(prefix)) return name.slice(prefix.length).trim();
  }
  return name === unit.code || name === roomCode ? (unit.kind === "ROOM" ? "整房" : "床位") : name;
}

export function moveUnitDisplayLabel(unit: InventoryUnitDto): string {
  return `${unit.code} · ${moveUnitCandidateDisplayName(unit)}`;
}

export function moveUnitCandidateLabel(
  unit: InventoryUnitDto,
  targetIntervalStatus?: string,
  parentRoom?: InventoryUnitDto
): string {
  const unitDescription = moveUnitCandidateDisplayName(unit);
  const roomType = unit.kind === "BED" && parentRoom
    ? moveUnitCandidateDisplayName(parentRoom)
    : unitDescription;
  const position = unit.kind === "ROOM"
    ? "整房"
    : parentRoom ? unitDescription : "床位";
  return `${unit.code} · ${roomType} · ${position} · 可住 ${unit.occupancy_capacity} 人${targetIntervalStatus ? ` · ${targetIntervalStatus}` : ""}`;
}

export function moveUnitCandidateMatches(unit: InventoryUnitDto, query: string, parentRoom?: InventoryUnitDto): boolean {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return true;
  return [
    unit.code,
    moveUnitCandidateDisplayName(unit),
    parentRoom ? moveUnitCandidateDisplayName(parentRoom) : "",
    unit.kind === "ROOM" ? "整房" : "床位",
    `可住 ${unit.occupancy_capacity} 人`
  ].join(" ").toLocaleLowerCase("zh-CN").includes(normalized);
}

export function buildMoveUnitRequest(view: OrderViewDto, draft: MoveUnitDraft): CommandRequest {
  const allowed = view.allowedActions.find((action) => action.code === "MOVE_UNIT");
  if (view.accessLevel !== "WRITE" || !allowed?.enabled) {
    throw new Error("服务端当前未允许办理换房，请刷新订单状态后重新核对");
  }
  if (!draft.newInventoryUnitId) throw new Error("请选择目标房源");
  if (!isLocalDate(draft.effectiveDate)) throw new Error("请选择有效的换房生效日期");
  if (draft.effectiveDate < view.effectiveArrangement.arrivalDate
    || draft.effectiveDate >= view.effectiveArrangement.departureDate) {
    throw new Error("换房生效日期必须位于当前住宿周期内");
  }
  if (view.order.status === "CHECKED_IN" && draft.effectiveDate < view.effectiveArrangement.businessDate) {
    throw new Error("在住订单不能追溯办理换房");
  }
  const reason = draft.reason.trim();
  if (!reason) throw new Error("请填写真实的换房原因");

  const memberStay = Boolean(view.order.member_id || view.order.member_contract_id);
  const freeStay = view.order.stay_type === "FREE";
  const channel = view.order.booking_channel_code;
  const input: Record<string, unknown> = {
    propertyId: view.order.property_id,
    orderId: view.order.id,
    newInventoryUnitId: draft.newInventoryUnitId,
    effectiveDate: draft.effectiveDate
  };
  if (!memberStay && !freeStay && channel && externalChannels.has(channel)) {
    const target = wholeYuanMinor(draft.targetContractYuan);
    if (target === undefined) throw new Error("请填写本单渠道应结金额，金额必须是支持范围内的非负整元");
    input.targetCurrentContractAmountMinor = target;
    if (draft.channelPriceDifferenceReason.trim()) {
      input.channelPriceDifferenceReason = draft.channelPriceDifferenceReason.trim();
    }
  } else if (!memberStay && !freeStay && channel === "WECOM" && draft.manuallyAdjustWecomPrice) {
    const target = wholeYuanMinor(draft.targetContractYuan);
    if (target === undefined) throw new Error("人工调整后的订单金额必须是支持范围内的非负整元");
    if (!draft.manualPriceAdjustmentReason.trim()) throw new Error("主动偏离政策重算金额时必须填写人工调价原因");
    input.targetCurrentContractAmountMinor = target;
    input.manualPriceAdjustmentReason = draft.manualPriceAdjustmentReason.trim();
  }
  return {
    commandType: "MOVE_UNIT",
    title: "换房",
    description: channel && externalChannels.has(channel) && !memberStay && !freeStay
      ? "系统将核对换房前后的完整住宿安排、目标库存、政策基础金额和本单渠道应结金额。"
      : "系统将核对换房前后的完整住宿安排、目标库存、订单金额和会员权益，不会自动收款或退款。",
    presentation: "MOVE_UNIT",
    initialReason: { code: "MOVE_UNIT", note: reason },
    input
  };
}

function Timeline({ summary, units, side }: {
  summary: MoveUnitPreviewSummary;
  units: ReadonlyMap<string, InventoryUnitDto>;
  side: "before" | "after";
}) {
  const timeline = side === "before" ? summary.beforeTimeline : summary.afterTimeline;
  const groups = timeline.reduce<Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }>>((result, item) => {
    const last = result.at(-1);
    if (last?.inventoryUnitId === item.inventoryUnitId && last.departureDate === item.serviceDate) {
      last.departureDate = shiftDate(item.serviceDate, 1);
    } else {
      result.push({ inventoryUnitId: item.inventoryUnitId, arrivalDate: item.serviceDate, departureDate: shiftDate(item.serviceDate, 1) });
    }
    return result;
  }, []);
  return <ol className="move-unit-timeline" data-testid={`move-unit-${side}-timeline`}>
    {groups.map((group) => {
      const unit = units.get(group.inventoryUnitId);
      return <li key={`${group.inventoryUnitId}:${group.arrivalDate}`}>
        <strong>{unit ? moveUnitDisplayLabel(unit) : "房源信息不可用"}</strong>
        <span>{formatDate(group.arrivalDate)} 至 {formatDate(group.departureDate)}</span>
      </li>;
    })}
  </ol>;
}

export function MoveUnitDrawer({
  view,
  units,
  draft: recovered,
  writeBlocked = false,
  runPreview,
  onClose,
  onSubmit
}: {
  view: OrderViewDto;
  units: readonly InventoryUnitDto[];
  draft?: CommandRequest;
  writeBlocked?: boolean;
  runPreview: RecoveryCoordinatedPreviewRunner;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const candidates = useMemo(() => moveUnitCandidates(view, units), [units, view.order.property_id]);
  const [draft, setDraft] = useState(() => moveUnitInitialDraft(view, units, recovered));
  const [targetSearch, setTargetSearch] = useState("");
  const [error, setError] = useState<unknown>();
  const [preview, setPreview] = useState<PreviewState>({ status: "EMPTY" });
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [candidateAvailability, setCandidateAvailability] = useState<CandidateAvailabilityState>({ status: "LOADING" });
  const generationRef = useRef(0);
  const runPreviewRef = useRef(runPreview);
  runPreviewRef.current = runPreview;
  const unitMap = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const inventoryUnitLabels = useMemo(() => Object.fromEntries(
    units.map((unit) => [unit.id, moveUnitDisplayLabel(unit)])
  ), [units]);
  const memberStay = Boolean(view.order.member_id || view.order.member_contract_id);
  const freeStay = view.order.stay_type === "FREE";
  const externalChannel = Boolean(view.order.booking_channel_code && externalChannels.has(view.order.booking_channel_code));
  const wecom = view.order.booking_channel_code === "WECOM";
  const guest = typeof view.order.primary_guest_snapshot.nickname === "string" && view.order.primary_guest_snapshot.nickname.trim()
    ? view.order.primary_guest_snapshot.nickname.trim()
    : "未命名住客";
  const allowed = view.allowedActions.find((action) => action.code === "MOVE_UNIT");
  const currentPositionId = view.order.status === "CHECKED_IN"
    ? inventoryUnitAtDate(view, view.effectiveArrangement.businessDate)
    : undefined;
  const plannedPositionId = inventoryUnitAtDate(view, draft.effectiveDate);
  const currentPosition = currentPositionId ? unitMap.get(currentPositionId) : undefined;
  const plannedPosition = plannedPositionId ? unitMap.get(plannedPositionId) : undefined;
  const visibleCandidates = useMemo(
    () => candidates.filter((unit) => moveUnitCandidateMatches(
      unit,
      targetSearch,
      unit.parent_room_id ? unitMap.get(unit.parent_room_id) : undefined
    )),
    [candidates, targetSearch, unitMap]
  );
  const selectedTargetAvailability = candidateAvailability.status === "READY"
    ? candidateAvailability.units.get(draft.newInventoryUnitId)
    : undefined;
  const selectedTarget = unitMap.get(draft.newInventoryUnitId);
  const occupantCount = Math.max(1, view.occupants.length);
  const selectedTargetCapacityBlocked = selectedTargetAvailability !== undefined
    && occupantCount > selectedTargetAvailability.occupancyCapacity;
  const selectedTargetInventoryBlocked = selectedTargetAvailability?.available === false
    && !selectedTargetCapacityBlocked;
  const selectedTargetBlocked = selectedTargetCapacityBlocked || selectedTargetInventoryBlocked;
  const selectedTargetAvailable = selectedTargetAvailability?.available === true
    && !selectedTargetCapacityBlocked;
  const selectedTargetBlockedMessage = selectedTargetCapacityBlocked && selectedTarget
    ? `${selectedTarget.code} 最多登记 ${selectedTarget.occupancy_capacity} 位住宿人，当前订单有 ${occupantCount} 位。`
    : "目标房源在所选换房日期内已有占用，请选择其他房源。";

  const previewRequest = useMemo(() => {
    if (candidateAvailability.status !== "READY" || !selectedTargetAvailable) return undefined;
    try {
      return buildMoveUnitRequest(view, { ...draft, reason: draft.reason.trim() || "换房安排核对" });
    } catch {
      return undefined;
    }
  }, [candidateAvailability.status, selectedTargetAvailable, view, draft.newInventoryUnitId, draft.effectiveDate, draft.targetContractYuan, draft.channelPriceDifferenceReason, draft.manuallyAdjustWecomPrice, draft.manualPriceAdjustmentReason]);
  const previewSignature = previewRequest ? JSON.stringify(previewRequest.input) : "";
  const previewSemanticSignature = JSON.stringify({
    orderId: view.order.id,
    orderVersion: view.order.version,
    revisionId: view.order.current_revision_id,
    status: view.order.status,
    arrivalDate: view.effectiveArrangement.arrivalDate,
    departureDate: view.effectiveArrangement.departureDate,
    businessDate: view.effectiveArrangement.businessDate,
    input: previewSignature
  });

  function candidateStatus(unitId: string): MoveUnitCandidateStatus {
    if (candidateAvailability.status !== "READY") return candidateAvailability;
    const unit = candidateAvailability.units.get(unitId);
    return unit ? { status: "READY", unit } : { status: "ERROR" };
  }

  useEffect(() => {
    let active = true;
    if (!isLocalDate(draft.effectiveDate)
      || draft.effectiveDate < view.effectiveArrangement.arrivalDate
      || draft.effectiveDate >= view.effectiveArrangement.departureDate) {
      setCandidateAvailability({ status: "ERROR" });
      return () => { active = false; };
    }
    setCandidateAvailability({ status: "LOADING" });
    void api.availability(
      view.order.property_id,
      draft.effectiveDate,
      view.effectiveArrangement.departureDate,
      undefined,
      view.order.id
    ).then((response) => {
      if (!active) return;
      setCandidateAvailability({
        status: "READY",
        units: new Map(response.units.map((unit) => [unit.id, unit]))
      });
    }).catch(() => {
      if (active) setCandidateAvailability({ status: "ERROR" });
    });
    return () => { active = false; };
  }, [draft.effectiveDate, view.effectiveArrangement.arrivalDate, view.effectiveArrangement.departureDate, view.order.id, view.order.property_id]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!previewRequest || !previewSignature || writeBlocked || !allowed?.enabled) {
      setPreview({ status: "EMPTY" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreview((current) => "summary" in current && current.signature === previewSignature
        ? { ...current, status: "REFRESHING" }
        : { status: "LOADING" });
      void runPreviewRef.current(() => api.preview(
        { commandType: "MOVE_UNIT", input: previewRequest.input },
        api.commandMetadata("move-unit-price"),
        controller.signal
      )).then((response) => {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        const summary = moveUnitPreviewSummary(response.preview, previewRequest.input);
        setPreview(summary
          ? { status: "READY", summary, expiresAt: response.preview.expiresAt, signature: previewSignature }
          : { status: "ERROR", error: new Error("服务端返回的换房核对信息不完整，未允许继续确认") });
      }).catch((nextError: unknown) => {
        if (controller.signal.aborted || generationRef.current !== generation
          || (nextError instanceof DOMException && nextError.name === "AbortError")) return;
        setPreview((current) => "summary" in current && current.signature === previewSignature
          ? { ...current, status: "STALE", error: nextError }
          : { status: "ERROR", error: nextError });
      });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [allowed?.enabled, previewRefresh, previewSemanticSignature, previewSignature, writeBlocked]);

  useEffect(() => {
    if (preview.status !== "READY") return;
    const expiry = Date.parse(preview.expiresAt);
    const timer = window.setTimeout(() => {
      setPreview((current) => current.status === "READY" && current.signature === preview.signature
        ? { ...current, status: "REFRESHING" }
        : current);
      setPreviewRefresh((value) => value + 1);
    }, Math.max(0, (Number.isFinite(expiry) ? expiry : Date.now()) - Date.now() + 20));
    return () => window.clearTimeout(timer);
  }, [preview]);

  function update(patch: Partial<MoveUnitDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(undefined);
  }

  function updateTargetSearch(value: string) {
    setTargetSearch(value);
    const selected = candidates.find((unit) => unit.id === draft.newInventoryUnitId);
    if (selected && !moveUnitCandidateMatches(
      selected,
      value,
      selected.parent_room_id ? unitMap.get(selected.parent_room_id) : undefined
    )) update({ newInventoryUnitId: "" });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      if (preview.status !== "READY" || preview.signature !== previewSignature) {
        throw new Error("请等待换房安排和金额核对完成，再继续确认");
      }
      onSubmit({ ...buildMoveUnitRequest(view, draft), inventoryUnitLabels });
    } catch (nextError) {
      setError(nextError);
    }
  }

  const minEffectiveDate = view.order.status === "CHECKED_IN"
    ? view.effectiveArrangement.businessDate
    : view.effectiveArrangement.arrivalDate;
  return <Modal
    title="换房"
    size="drawer"
    className="move-unit-drawer room-status-write-drawer"
    onClose={onClose}
    footer={<>
      <button type="button" className="button button-secondary" onClick={onClose}>取消</button>
      <button type="submit" form="move-unit-form" className="button button-primary" disabled={writeBlocked || !allowed?.enabled || !draft.reason.trim() || !selectedTargetAvailable || preview.status !== "READY" || preview.signature !== previewSignature}>继续核对</button>
    </>}
  >
    <div className="stay-date-change-heading">
      <ArrowRightLeft aria-hidden="true" size={20} />
      <div data-testid="move-unit-order-context">
        <span>{view.order.status === "RESERVED" ? "计划住宿" : "当前住宿"} · {businessStatusLabel(view.order.status)}</span>
        <strong>{guest}</strong>
        <small>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</small>
        {view.order.status === "CHECKED_IN"
          ? <small>当前住宿位置：{currentPosition ? moveUnitDisplayLabel(currentPosition) : "当前营业日位置无法确认"}</small>
          : <small>生效日原计划位置：{plannedPosition ? moveUnitDisplayLabel(plannedPosition) : "计划位置无法确认"}</small>}
        {view.order.status === "CHECKED_IN" && plannedPosition && plannedPosition.id !== currentPosition?.id
          ? <small>生效日原计划位置：{moveUnitDisplayLabel(plannedPosition)}</small>
          : null}
      </div>
    </div>
    <InlineError error={error} title="无法继续核对" />
    <InlineError error={!allowed?.enabled ? new Error(allowed?.disabledReason || "当前订单状态暂不能办理换房") : undefined} title="暂不能办理" hideTechnicalDetails />
    <InlineError error={writeBlocked ? new Error("当前订单或房态事实已经变化，请关闭后重新打开换房") : undefined} title="写入已暂停" hideTechnicalDetails />
    <form id="move-unit-form" className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <label>换房生效日期<input type="date" min={minEffectiveDate} max={shiftDate(view.effectiveArrangement.departureDate, -1)} value={draft.effectiveDate} onChange={(event) => update({ effectiveDate: event.target.value })} required data-testid="move-effective-date" /></label>
        <div className="move-unit-target-picker">
          <label htmlFor="move-unit-target-search">目标房源</label>
          <div className="move-unit-target-search">
            <Search aria-hidden="true" size={16} />
            <input id="move-unit-target-search" type="search" value={targetSearch} onChange={(event) => updateTargetSearch(event.target.value)} placeholder="搜索房号或房型" autoComplete="off" data-testid="move-unit-target-search" />
          </div>
          <div className="move-unit-target-picker-meta"><span>选择房源</span><small>{visibleCandidates.length} / {candidates.length} 个房源</small></div>
          <select aria-label="选择目标房源" value={draft.newInventoryUnitId} onChange={(event) => update({ newInventoryUnitId: event.target.value })} required data-testid="move-unit-id">
            <option value="">{visibleCandidates.length ? "请选择目标房源" : "没有符合条件的房源"}</option>
            {visibleCandidates.map((unit) => <option key={unit.id} value={unit.id}>{moveUnitCandidateLabel(
              unit,
              moveUnitCandidateOptionStatusLabel(candidateStatus(unit.id)),
              unit.parent_room_id ? unitMap.get(unit.parent_room_id) : undefined
            )}</option>)}
          </select>
          <small data-testid="move-unit-target-status">目标区间状态：{draft.newInventoryUnitId ? moveUnitCandidateStatusLabel(candidateStatus(draft.newInventoryUnitId)) : "请选择目标房源"}{selectedTargetBlocked ? "，请选择其他房源。" : "。正式确认时会再次核对。"}</small>
          {selectedTargetBlocked ? <InlineError error={new Error(selectedTargetBlockedMessage)} title={selectedTargetCapacityBlocked ? "目标房源容量不足" : "目标房源不可用"} hideTechnicalDetails /> : null}
        </div>
        <label>换房原因<textarea value={draft.reason} onChange={(event) => update({ reason: event.target.value })} required maxLength={1000} rows={3} data-testid="move-unit-reason" /></label>
      </div>

      {externalChannel && !memberStay && !freeStay ? <section className="stay-date-pricing-section" aria-labelledby="move-channel-heading">
        <h3 id="move-channel-heading">渠道订单金额</h3>
        <p>请按本次渠道约定重新填写，系统会与完整换房安排的政策基础金额比较。</p>
        <div className="form-grid">
          <label>本单渠道应结金额（元）<input type="number" min="0" max={maxWholeYuan} step="1" inputMode="numeric" value={draft.targetContractYuan} onChange={(event) => update({ targetContractYuan: event.target.value })} required data-testid="move-channel-amount" /></label>
          <label>渠道价格差异说明<textarea value={draft.channelPriceDifferenceReason} onChange={(event) => update({ channelPriceDifferenceReason: event.target.value })} maxLength={1000} rows={2} data-testid="move-channel-reason" /></label>
          <small>与政策基础金额差异超过 15% 时必须填写；由服务端最终核对结果判定。</small>
        </div>
      </section> : null}

      {wecom && !memberStay && !freeStay ? <section className="stay-date-pricing-section" aria-labelledby="move-wecom-heading">
        <h3 id="move-wecom-heading">订单金额</h3>
        <p>默认按换房后的完整住宿安排使用政策价重新计算。</p>
        <label className="stay-date-price-toggle"><input type="checkbox" role="switch" checked={draft.manuallyAdjustWecomPrice} onChange={(event) => update({ manuallyAdjustWecomPrice: event.target.checked, ...(!event.target.checked ? { targetContractYuan: "", manualPriceAdjustmentReason: "" } : {}) })} /><span><strong>另行调整金额</strong><small>只有本次需要使用其他金额时才打开。</small></span></label>
        {draft.manuallyAdjustWecomPrice ? <div className="form-grid">
          <label>调整后订单金额（元）<input type="number" min="0" max={maxWholeYuan} step="1" inputMode="numeric" value={draft.targetContractYuan} onChange={(event) => update({ targetContractYuan: event.target.value })} required data-testid="move-wecom-amount" /></label>
          <label>人工调价原因<textarea value={draft.manualPriceAdjustmentReason} onChange={(event) => update({ manualPriceAdjustmentReason: event.target.value })} required maxLength={1000} rows={2} data-testid="move-wecom-reason" /></label>
        </div> : null}
      </section> : null}

      <section className="stay-date-pricing-section" aria-labelledby="move-preview-heading" aria-live="polite">
        <h3 id="move-preview-heading">换房结果核对</h3>
        {preview.status === "EMPTY" && !selectedTargetBlocked ? <p>选择有效日期、可用房源并填写所需金额后，系统会显示完整结果。</p> : null}
        {preview.status === "LOADING" ? <div className="stay-date-price-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" size={17} /><span>正在核对库存、住宿安排和金额</span></div> : null}
        {preview.status === "ERROR" ? <InlineError error={preview.error} title="暂时无法核对换房结果" hideTechnicalDetails /> : null}
        {preview.status === "REFRESHING" ? <div className="stay-date-price-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" size={17} /><span>正在重新核对，原结果暂时保留</span></div> : null}
        {preview.status === "STALE" ? <div className="move-unit-preview-retry"><InlineError error={new Error("本次核对已失效，原结果仅供查看；重新核对完成前不能继续。")} title="需要重新核对" hideTechnicalDetails /><button type="button" className="button button-secondary" onClick={() => { setPreview((current) => "summary" in current ? { ...current, status: "REFRESHING" } : current); setPreviewRefresh((value) => value + 1); }}><RefreshCw aria-hidden="true" size={16} />重新核对</button></div> : null}
        {"summary" in preview ? <div className="move-unit-preview" data-testid="move-unit-preview">
          <div className="move-unit-preview-side"><h4>换房前完整安排</h4><Timeline summary={preview.summary} units={unitMap} side="before" /></div>
          <div className="move-unit-preview-side"><h4>换房后完整安排</h4><Timeline summary={preview.summary} units={unitMap} side="after" /></div>
          <dl className="stay-date-price-preview">
            <span>换房生效日期</span><strong>{formatDate(preview.summary.effectiveDate)}</strong>
            {!externalChannel ? <><span>原订单金额</span><strong data-testid="move-unit-original-amount">{formatMoney(preview.summary.beforeAmount)}</strong></> : null}
            <span>政策基础金额</span><strong>{formatMoney(preview.summary.policyBaseAmount)}</strong>
            <span>{stayDateFundsAreOperatorFacing(view.order.booking_channel_code, preview.summary.pricingBasis) ? "换房后订单金额" : "本单渠道应结金额"}</span><strong>{formatMoney(preview.summary.targetAmount)}</strong>
            {!externalChannel ? <><span>订单金额变化</span><strong>{formatMoney({
              currency: preview.summary.targetAmount.currency,
              minorUnits: preview.summary.targetAmount.minorUnits - preview.summary.beforeAmount.minorUnits
            })}</strong></> : null}
            <span>与政策基础金额差额</span><strong>{formatMoney(preview.summary.differenceFromPolicy)}</strong>
            {externalChannel ? <><span>渠道价格差异说明</span><strong>{draft.channelPriceDifferenceReason.trim() || "无"}</strong></> : null}
          </dl>
          <p>正式确认时会再次核对目标库存、订单版本和完整计价结果。</p>
        </div> : null}
      </section>
      {memberStay ? <p className="stay-date-pricing-note">会员住宿将保持既有已核销权益，只迁移尚未使用且房源发生变化的冻结权益。</p> : null}
      {freeStay ? <p className="stay-date-pricing-note">免费住宿保持 0 元，不产生收款或退款记录。</p> : null}
    </form>
  </Modal>;
}
