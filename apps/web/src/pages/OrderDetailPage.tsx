import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CalendarMinus2,
  CalendarPlus2,
  CircleDollarSign,
  LogIn,
  LogOut,
  Pencil,
  Sparkles,
  Undo2,
  UserX,
  XCircle
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  currentReleaseFeatures,
  type CommandType,
  type OrderActionCode,
  type OrderAllowedActionDto,
  type OrderFulfillmentRecordDto
} from "@qintopia/contracts";
import { api } from "../api";
import { OrderOccupantCorrectionDialog } from "../components/OrderOccupantCorrectionDialog";
import { useWorkspace } from "../session";
import type { CollectionFactDto, CommandRequest, OrderViewDto } from "../types";
import {
  CommandDialog,
  CommandRecoveryBar,
  businessStatusLabel,
  EmptyState,
  formatDate,
  formatDateTime,
  formatMinor,
  formatMoney,
  guestName,
  InlineError,
  LoadingBlock,
  Modal,
  isTerminalCommandRecovery,
  recoveryCommandRequest,
  usePersistentCommandRecovery,
  StatusBadge
} from "../ui";

type FormAction = "RECORD_COLLECTION" | "RECORD_REFUND" | "SHORTEN_STAY" | "EXTEND_STAY" | "MOVE_UNIT" | "REPRICE_ORDER";
const ORDER_DETAIL_POLL_MS = 4_000;

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const formTitles: Record<FormAction, string> = {
  RECORD_COLLECTION: "记录收款事实",
  RECORD_REFUND: "引用原收款退款",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住",
  MOVE_UNIT: "换房",
  REPRICE_ORDER: "调整订单金额"
};

const bookingChannelLabels = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
} as const;

const occupantFieldLabels: Record<string, string> = {
  nickname: "昵称",
  fullName: "姓名",
  phone: "联系电话",
  documentNumber: "证件号码"
};

type OrderOccupant = OrderViewDto["occupants"][number];

export function enabledOrderActionCodes(actions: readonly OrderAllowedActionDto[]): OrderActionCode[] {
  return actions.filter((action) => action.enabled).map((action) => action.code);
}

export interface OrderFulfillmentNotice {
  action: "CHECK_IN" | "CHECK_OUT";
  title: string;
  body: string;
}

export function orderFulfillmentNotice(actions: readonly OrderAllowedActionDto[]): OrderFulfillmentNotice | undefined {
  const checkIn = actions.find((action) => action.code === "CHECK_IN");
  if (checkIn?.disabledReason === "ARRIVAL_DATE_NOT_REACHED") {
    return {
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: "尚未到计划到店日。当前版本不能提前办理入住；请在计划到店日办理，订单和库存保持不变。"
    };
  }
  if (checkIn?.disabledReason === "ARRIVAL_DATE_PASSED") {
    return {
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: "已超过计划到店日。当前版本不能按普通入住补办；请等待后续的改期、未到或补办入住流程，订单和库存保持不变。"
    };
  }
  const checkout = actions.find((action) => action.code === "CHECK_OUT");
  if (checkout?.disabledReason === "DEPARTURE_DATE_NOT_REACHED") {
    return {
      action: "CHECK_OUT",
      title: "暂不能办理退房",
      body: "尚未到计划退房日。当前版本暂不办理提前退房；订单日期、金额、库存和会员权益保持不变。提前退房将在后续流程中统一核对离店原因、住宿缩短、重新计价和退款参考额。"
    };
  }
  return undefined;
}

export function orderDetailBackTarget(state: unknown): "/" | "/orders" {
  if (!state || typeof state !== "object") return "/orders";
  const source = state as Record<string, unknown>;
  return source.fromRoomStatus === true
    || source.source === "room-status"
    || source.returnTo === "/"
    ? "/"
    : "/orders";
}

export function requestedOrderAction(search: string, actions: readonly OrderAllowedActionDto[]): OrderActionCode | undefined {
  const requested = new URLSearchParams(search).get("action");
  return actions.find((action) => action.enabled && action.code === requested)?.code;
}

export function remainingRefundableMinor(facts: readonly CollectionFactDto[], collection: CollectionFactDto): number {
  if (collection.fact_type !== "COLLECTION" || facts.some((fact) => fact.reverses_fact_id === collection.fact_id)) return 0;
  const activeRefunded = facts
    .filter((fact) => fact.fact_type === "REFUND" && fact.references_fact_id === collection.fact_id)
    .filter((refund) => !facts.some((fact) => fact.reverses_fact_id === refund.fact_id))
    .reduce((sum, refund) => sum + refund.amount_minor, 0);
  return Math.max(0, collection.amount_minor - activeRefunded);
}

export function orderViewMatchesPrincipalScope(loadedScope: string | undefined, currentScope: string): boolean {
  return loadedScope === currentScope;
}

export function orderedOrderOccupants(occupants: readonly OrderOccupant[]): OrderOccupant[] {
  return [...occupants].sort((left, right) => left.ordinal - right.ordinal);
}

export function primaryOrderOccupant(occupants: readonly OrderOccupant[]): OrderOccupant | undefined {
  return occupants.find((occupant) => occupant.role === "PRIMARY") ?? orderedOrderOccupants(occupants)[0];
}

export function occupantSnapshotEntries(snapshot: Pick<OrderOccupant, "nickname" | "fullName" | "phone" | "documentNumber">): Array<[string, unknown]> {
  const canonicalKeys = ["nickname", "fullName", "phone", "documentNumber"] as const;
  const canonical = canonicalKeys.map((key): [string, unknown] => [
    occupantFieldLabels[key]!,
    key === "nickname" && (typeof snapshot[key] !== "string" || !snapshot[key].trim())
      ? "历史未记录"
      : snapshot[key] ?? "-"
  ]);
  return canonical;
}

export function fulfillmentResultLabel(record: OrderFulfillmentRecordDto): string {
  if (record.recordingMode === "LEGACY_UNCLASSIFIED") return "历史记录未分类";
  if (record.recordingMode === "LATE_RECORDED") return "迟录退房";
  return record.type === "CHECK_IN" ? "按计划办理入住" : "按计划办理退房";
}

function FulfillmentResult({ type, record }: {
  type: "CHECK_IN" | "CHECK_OUT";
  record: OrderFulfillmentRecordDto | null;
}) {
  const isCheckIn = type === "CHECK_IN";
  return (
    <article data-testid={isCheckIn ? "check-in-result" : "check-out-result"}>
      <div>
        <strong>{isCheckIn ? "入住结果" : "退房结果"}</strong>
        <span>{record ? fulfillmentResultLabel(record) : isCheckIn ? "未办理入住" : "未办理退房"}</span>
      </div>
      {record ? <dl className="detail-list">
        <div><dt>{isCheckIn ? "计划入住日" : "计划退房日"}</dt><dd>{formatDate(record.plannedBusinessDate)}</dd></div>
        <div><dt>办理营业日</dt><dd>{record.recordedBusinessDate ? formatDate(record.recordedBusinessDate) : "历史未记录"}</dd></div>
        <div><dt>记录时间</dt><dd>{formatDateTime(record.recordedAt)}</dd></div>
        <div><dt>操作人</dt><dd>{record.actor?.displayName ?? "历史未记录"}</dd></div>
        <div><dt>办理原因</dt><dd>{record.reason.note}</dd></div>
      </dl> : null}
    </article>
  );
}

function ActionFormDialog({ action, view, initialFactId, onClose, onSubmit }: {
  action: FormAction;
  view: OrderViewDto;
  initialFactId?: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const { meta } = useWorkspace();
  const collections = view.collectionFacts.filter((fact) => fact.fact_type === "COLLECTION");
  const refundableCollections = collections.filter((fact) => remainingRefundableMinor(view.collectionFacts, fact) > 0);
  const currentUnit = meta.inventoryUnits.find((unit) => unit.id === view.currentSegment.inventoryUnitId);
  const moveCandidates = meta.inventoryUnits.filter((unit) => (
    unit.property_id === view.order.property_id
    && unit.id !== view.currentSegment.inventoryUnitId
    && (!view.order.member_contract_id || unit.kind === currentUnit?.kind)
  ));
  const initialSelectedFactId = initialFactId ?? refundableCollections[0]?.fact_id ?? "";
  const recordedExcessMinor = Math.max(0, -view.amounts.collectionDifference.minorUnits);
  function suggestedRefundFor(collectionFactId: string): number {
    const collection = collections.find((fact) => fact.fact_id === collectionFactId);
    if (!collection) return 0;
    return Math.min(recordedExcessMinor, remainingRefundableMinor(view.collectionFacts, collection));
  }
  const initialSuggestedRefund = action === "RECORD_REFUND" ? suggestedRefundFor(initialSelectedFactId) : 0;
  const [amountMinor, setAmountMinor] = useState(initialSuggestedRefund > 0 ? String(initialSuggestedRefund) : "");
  const [method, setMethod] = useState("CASH");
  const [note, setNote] = useState("");
  const [transactionReference, setTransactionReference] = useState("");
  const [factId, setFactId] = useState(initialSelectedFactId);
  const [newDepartureDate, setNewDepartureDate] = useState(action === "SHORTEN_STAY" ? shiftDate(view.order.departure_date, -1) : shiftDate(view.order.departure_date, 1));
  const [newUnitId, setNewUnitId] = useState(moveCandidates[0]?.id ?? "");
  const [effectiveDate, setEffectiveDate] = useState(view.order.arrival_date);
  const [targetContractYuan, setTargetContractYuan] = useState(String(view.amounts.currentContractAmount.minorUnits / 100));
  const [validationError, setValidationError] = useState<unknown>();

  useEffect(() => {
    if (action !== "RECORD_REFUND") return;
    const suggested = suggestedRefundFor(factId);
    setAmountMinor(suggested > 0 ? String(suggested) : "");
  }, [action, factId, recordedExcessMinor]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    const base: Record<string, unknown> = { propertyId: view.order.property_id, orderId: view.order.id };
    let description = "服务端将重新校验订单版本与操作影响。";
    if (action === "RECORD_COLLECTION" || action === "RECORD_REFUND") {
      const parsedAmount = Number(amountMinor);
      if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
        setValidationError(new Error("金额必须是大于零的整数，且需由本次经营事实明确录入"));
        return;
      }
      if (!transactionReference.trim()) {
        setValidationError(new Error("必须录入该笔收款或退款自身的外部交易单号"));
        return;
      }
      Object.assign(base, { amountMinor: parsedAmount, method, transactionReference: transactionReference.trim(), note });
      if (action === "RECORD_REFUND") {
        Object.assign(base, { referencesFactId: factId });
        description = "退款事实必须引用同订单的一笔原收款，服务端将校验可退上限。";
      }
    }
    if (action === "SHORTEN_STAY" || action === "EXTEND_STAY") {
      Object.assign(base, { newDepartureDate });
      description = "服务端使用订单锁定的政策版本重算，并追加 amendment 与 pricing revision。";
    }
    if (action === "MOVE_UNIT") {
      Object.assign(base, { newInventoryUnitId: newUnitId, effectiveDate });
      description = "服务端重新校验目标库存并使用成交时锁定政策重算。";
    }
    if (action === "REPRICE_ORDER") {
      const targetYuan = Number(targetContractYuan);
      const targetCurrentContractAmountMinor = targetYuan * 100;
      if (!Number.isSafeInteger(targetCurrentContractAmountMinor) || targetCurrentContractAmountMinor < 0) {
        setValidationError(new Error("指定最终总价必须是大于或等于零的整元金额"));
        return;
      }
      Object.assign(base, { targetCurrentContractAmountMinor });
      description = "服务端将按锁定政策重新计算基础金额，并把本次指定总价记录为独立计价修订。";
    }
    onSubmit({ commandType: action, title: formTitles[action], description, input: base });
  }

  return (
    <Modal title={formTitles[action]} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <InlineError error={validationError} title="无法继续" />
        {(action === "RECORD_COLLECTION" || action === "RECORD_REFUND") ? (
          <div className="form-grid form-grid-two">
            {action === "RECORD_REFUND" ? <label className="span-two">引用原收款<select value={factId} onChange={(event) => setFactId(event.target.value)} required>{refundableCollections.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{fact.fact_id} · 剩余 {formatMinor(remainingRefundableMinor(view.collectionFacts, fact), fact.currency)} · {fact.method}</option>)}</select></label> : null}
            <label>金额（最小货币单位）<input type="number" min="1" step="1" value={amountMinor} onChange={(event) => { setAmountMinor(event.target.value); setValidationError(undefined); }} required inputMode="numeric" data-testid="fact-amount-minor" /></label>
            <label>方式<select value={method} onChange={(event) => setMethod(event.target.value)}><option value="CASH">CASH</option><option value="BANK_TRANSFER">BANK TRANSFER</option><option value="CARD">CARD</option><option value="OTHER">OTHER</option></select></label>
            <label className="span-two">外部交易单号<input value={transactionReference} onChange={(event) => { setTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="transaction-reference" /></label>
            <label className="span-two">备注<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></label>
          </div>
        ) : null}
        {(action === "SHORTEN_STAY" || action === "EXTEND_STAY") ? (
          <div className="form-grid">
            <label>新离店日期<input type="date" value={newDepartureDate} min={view.order.arrival_date} onChange={(event) => setNewDepartureDate(event.target.value)} required data-testid="new-departure-date" /></label>
          </div>
        ) : null}
        {action === "MOVE_UNIT" ? (
          <div className="form-grid form-grid-two">
            <label>目标库存<select value={newUnitId} onChange={(event) => setNewUnitId(event.target.value)} required data-testid="move-unit-id">{moveCandidates.map((unit) => <option key={unit.id} value={unit.id}>{unit.code} · {unit.name} · {unit.kind}</option>)}</select></label>
            <label>生效日期<input type="date" min={view.order.arrival_date} max={shiftDate(view.order.departure_date, -1)} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} required data-testid="move-effective-date" /></label>
          </div>
        ) : null}
        {action === "REPRICE_ORDER" ? (
          <div className="form-grid">
            <label>指定最终总价（元）<input type="number" min="0" step="1" value={targetContractYuan} onChange={(event) => { setTargetContractYuan(event.target.value); setValidationError(undefined); }} required inputMode="numeric" data-testid="reprice-target-yuan" /></label>
          </div>
        ) : null}
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续生成 Preview</button></div>
      </form>
    </Modal>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return <details className="table-details"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function FactActions({ fact, canRefund, disabled, onRefund }: { fact: CollectionFactDto; canRefund: boolean; disabled: boolean; onRefund: () => void }) {
  return (
    <div className="row-actions">
      {canRefund && fact.fact_type === "COLLECTION" ? <button className="icon-button" type="button" onClick={onRefund} disabled={disabled} title="引用退款" aria-label={`引用事实 ${fact.fact_id} 退款`} data-order-action="RECORD_REFUND"><Undo2 aria-hidden="true" size={16} /></button> : null}
    </div>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { meta, principal, propertyId } = useWorkspace();
  const recoveryScope = propertyId ? `property:${propertyId}` : "";
  const principalOrderScope = `${principal.subjectId}:${principal.credentialType}:${principal.propertyAccess[propertyId] ?? "NONE"}`;
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: recoveryScope });
  const [view, setView] = useState<OrderViewDto>();
  const [loadedPrincipalOrderScope, setLoadedPrincipalOrderScope] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [formAction, setFormAction] = useState<FormAction>();
  const [correctingOccupant, setCorrectingOccupant] = useState<OrderOccupant>();
  const [initialFactId, setInitialFactId] = useState<string>();
  const [command, setCommand] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshNotice, setRefreshNotice] = useState<string>();
  const viewRef = useRef<OrderViewDto | undefined>(undefined);
  const focusedActionKeyRef = useRef<string | undefined>(undefined);

  const pendingRecovery = commandRecovery.pending;
  const orderActionsBlocked = commandRecovery.blocked;
  const enabledActions = useMemo(() => new Set(enabledOrderActionCodes(view?.allowedActions ?? [])), [view]);
  const fulfillmentNotice = useMemo(() => orderFulfillmentNotice(view?.allowedActions ?? []), [view]);
  const requestedAction = useMemo(() => requestedOrderAction(location.search, view?.allowedActions ?? []), [location.search, view]);
  const backTarget = orderDetailBackTarget(location.state);

  useEffect(() => {
    setRecoveryError(undefined);
    setFormAction(undefined);
    setCorrectingOccupant(undefined);
    setInitialFactId(undefined);
    setCommand(undefined);
    setLoadedPrincipalOrderScope(undefined);
    setRecoveryDialogOpen(false);
    setRefreshNotice(undefined);
  }, [orderId, principalOrderScope, recoveryScope]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === "visible") setRefreshToken((value) => value + 1);
    };
    const interval = window.setInterval(refreshVisible, ORDER_DETAIL_POLL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [orderId]);

  useEffect(() => {
    if (!orderId) return;
    let current = true;
    const prior = viewRef.current;
    if (!prior) setLoading(true);
    setError(undefined);
    api.order(orderId)
      .then((response) => {
        if (!current) return;
        if (prior && JSON.stringify(response) !== JSON.stringify(prior) && (formAction || correctingOccupant)) {
          setFormAction(undefined);
          setCorrectingOccupant(undefined);
          setInitialFactId(undefined);
          setRefreshNotice("订单已被其他操作刷新。为避免使用旧数据，原编辑表单已关闭；请重新打开后核对。");
        }
        setView(response);
        setLoadedPrincipalOrderScope(principalOrderScope);
      })
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [orderId, principalOrderScope, refreshToken]);

  useEffect(() => {
    if (view && view.order.property_id !== propertyId) navigate("/orders", { replace: true });
  }, [navigate, propertyId, view]);

  useEffect(() => {
    if (!requestedAction) return;
    const focusKey = `${orderId}:${requestedAction}`;
    if (focusedActionKeyRef.current === focusKey) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-order-action="${requestedAction}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.focus({ preventScroll: true });
      focusedActionKeyRef.current = focusKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [orderId, requestedAction, view]);

  const unitMap = useMemo(() => new Map(meta.inventoryUnits.map((unit) => [unit.id, unit])), [meta.inventoryUnits]);

  function openForm(action: FormAction, factId?: string) {
    if (orderActionsBlocked || !enabledActions.has(action)) return;
    setInitialFactId(factId);
    setFormAction(action);
  }

  function directCommand(commandType: CommandType, title: string, description: string) {
    if (!view || orderActionsBlocked || !enabledActions.has(commandType as OrderActionCode)) return;
    setRecoveryDialogOpen(false);
    setCommand({
      commandType,
      title,
      description,
      ...((commandType === "CHECK_IN" || commandType === "CHECK_OUT") ? { presentation: "FULFILLMENT" as const } : {}),
      input: { propertyId: view.order.property_id, orderId: view.order.id }
    });
  }

  function openRecoveryDialog() {
    if (!pendingRecovery) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(pendingRecovery));
  }

  function closeCommandDialog() {
    if (pendingRecovery && isTerminalCommandRecovery(pendingRecovery.state)) {
      if (commandRecovery.clearResolved()) {
        setRecoveryError(undefined);
      } else {
        setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复写入，订单命令继续保持暂停"));
      }
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    setRefreshToken((value) => value + 1);
  }

  if (loading) return <LoadingBlock label="正在载入订单详情" />;
  if (view && !orderViewMatchesPrincipalScope(loadedPrincipalOrderScope, principalOrderScope)) return <LoadingBlock label="正在切换订单访问权限" />;
  if (error || !view) return <div><Link className="back-link" to={backTarget} state={backTarget === "/" ? location.state : undefined}><ArrowLeft aria-hidden="true" size={17} />{backTarget === "/" ? "返回房态" : "返回订单"}</Link><InlineError error={error ?? new Error("Order not found")} title="无法载入订单" /></div>;

  const currentUnit = unitMap.get(view.currentSegment.inventoryUnitId);
  const occupants = orderedOrderOccupants(view.occupants);
  const primaryOccupant = primaryOrderOccupant(occupants);

  return (
    <div className="order-detail-page">
      <Link className="back-link" to={backTarget} state={backTarget === "/" ? location.state : undefined}><ArrowLeft aria-hidden="true" size={17} />{backTarget === "/" ? "返回房态" : "返回订单"}</Link>
      <header className="order-heading">
        <div><div className="order-title-row"><h1>{guestName(primaryOccupant ? { nickname: primaryOccupant.nickname, fullName: primaryOccupant.fullName } : view.order.primary_guest_snapshot)}</h1><StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} /></div><code>{view.order.id}</code></div>
        <div className="order-unit"><span>当前库存</span><strong>{currentUnit ? `${currentUnit.code} · ${currentUnit.name}` : view.currentSegment.inventoryUnitId}</strong></div>
      </header>

      <section className="amount-strip" aria-label="订单可复算金额" data-testid="order-amounts">
        <div><span>currentContractAmount</span><strong>{formatMoney(view.amounts.currentContractAmount)}</strong></div>
        <div><span>netRecordedCollection</span><strong>{formatMoney(view.amounts.netRecordedCollection)}</strong></div>
        <div><span>collectionDifference</span><strong>{formatMoney(view.amounts.collectionDifference)}</strong></div>
      </section>

      <InlineError error={recoveryError} title="恢复记录未收口" />
      <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />
      {refreshNotice ? <div className="room-status-return-notice" role="alert">{refreshNotice}</div> : null}
      {pendingRecovery ? <CommandRecoveryBar recovery={pendingRecovery} onOpen={openRecoveryDialog} testId="order-command-recovery" /> : null}

      <section className="action-band" aria-labelledby="order-actions-heading">
        <div><h2 id="order-actions-heading">订单操作</h2><p>系统会在提交前重新核对当前业务状态</p></div>
        <div className="action-band-content">
          {fulfillmentNotice ? (
            <div className="fulfillment-date-notice" role="alert" data-testid="fulfillment-date-notice" data-action={fulfillmentNotice.action}>
              <AlertTriangle aria-hidden="true" size={18} />
              <div><strong>{fulfillmentNotice.title}</strong><span>{fulfillmentNotice.body}</span></div>
            </div>
          ) : null}
          <div className="action-toolbar">
            {enabledActions.has("RECORD_COLLECTION") ? <button className="button button-secondary" type="button" onClick={() => openForm("RECORD_COLLECTION")} disabled={orderActionsBlocked} data-testid="record-collection" data-order-action="RECORD_COLLECTION"><CircleDollarSign aria-hidden="true" size={17} />收款</button> : null}
            {enabledActions.has("RECORD_REFUND") ? <button className="button button-secondary" type="button" onClick={() => openForm("RECORD_REFUND")} disabled={orderActionsBlocked} data-order-action="RECORD_REFUND"><Undo2 aria-hidden="true" size={17} />退款</button> : null}
            {enabledActions.has("SHORTEN_STAY") ? <button className="button button-secondary" type="button" onClick={() => openForm("SHORTEN_STAY")} disabled={orderActionsBlocked} data-order-action="SHORTEN_STAY"><CalendarMinus2 aria-hidden="true" size={17} />缩短</button> : null}
            {enabledActions.has("EXTEND_STAY") ? <button className="button button-secondary" type="button" onClick={() => openForm("EXTEND_STAY")} disabled={orderActionsBlocked} data-order-action="EXTEND_STAY"><CalendarPlus2 aria-hidden="true" size={17} />续住</button> : null}
            {enabledActions.has("MOVE_UNIT") ? <button className="button button-secondary" type="button" onClick={() => openForm("MOVE_UNIT")} disabled={orderActionsBlocked} data-order-action="MOVE_UNIT"><ArrowRightLeft aria-hidden="true" size={17} />换房</button> : null}
            {enabledActions.has("REPRICE_ORDER") ? <button className="button button-secondary" type="button" onClick={() => openForm("REPRICE_ORDER")} disabled={orderActionsBlocked} data-testid="reprice-order" data-order-action="REPRICE_ORDER"><CircleDollarSign aria-hidden="true" size={17} />调整金额</button> : null}
            {enabledActions.has("CHECK_IN") ? <button className="button button-primary" type="button" onClick={() => directCommand("CHECK_IN", "办理入住", "核对后将住宿状态更新为在住；会员住宿会同时核销本次仍冻结的权益。") } disabled={orderActionsBlocked} data-testid="check-in" data-order-action="CHECK_IN"><LogIn aria-hidden="true" size={17} />入住</button> : null}
            {enabledActions.has("CHECK_OUT") ? <button className="button button-primary" type="button" onClick={() => directCommand("CHECK_OUT", "办理退房", "核对后将住宿状态更新为已退房并释放后续住宿库存；退房不会重复核销会员权益。") } disabled={orderActionsBlocked} data-testid="check-out" data-order-action="CHECK_OUT"><LogOut aria-hidden="true" size={17} />退房</button> : null}
            {enabledActions.has("CANCEL_ORDER") || enabledActions.has("MARK_NO_SHOW") ? <div className="action-separator" aria-hidden="true" /> : null}
            {enabledActions.has("CANCEL_ORDER") ? <button className="icon-button danger-icon" type="button" onClick={() => directCommand("CANCEL_ORDER", "取消订单", "确认取消订单并释放服务端库存与会员覆盖。") } disabled={orderActionsBlocked} aria-label="取消订单" title="取消订单" data-order-action="CANCEL_ORDER"><XCircle aria-hidden="true" size={18} /></button> : null}
            {enabledActions.has("MARK_NO_SHOW") ? <button className="icon-button danger-icon" type="button" onClick={() => directCommand("MARK_NO_SHOW", "标记未到", "确认标记未到并释放服务端库存与会员覆盖。") } disabled={orderActionsBlocked} aria-label="标记未到" title="标记未到" data-order-action="MARK_NO_SHOW"><UserX aria-hidden="true" size={18} /></button> : null}
            {enabledActions.size === 0 ? <span>当前没有可执行操作</span> : enabledActions.size === 1 && enabledActions.has("CORRECT_ORDER_OCCUPANT") ? <span>请在下方住宿人条目中更正资料</span> : null}
          </div>
        </div>
      </section>

      <div className="detail-grid">
        <section className="detail-section order-occupants-section" aria-labelledby="guest-snapshot-heading">
          <div className="section-title-row"><h2 id="guest-snapshot-heading">住宿人</h2><span>{occupants.length} 人</span></div>
          <ol className="order-occupant-list">
            {occupants.map((occupant) => (
              <li key={occupant.id} data-occupant-id={occupant.id} data-testid="order-occupant">
                <div className="order-occupant-heading">
                  <div><strong>{occupant.nickname?.trim() || "历史未记录"}</strong><span>{occupant.role === "PRIMARY" ? "主要 / 联系人" : `同行人 ${occupant.ordinal - 1}`}</span></div>
                  {enabledActions.has("CORRECT_ORDER_OCCUPANT") ? <button className="button button-secondary" type="button" onClick={() => setCorrectingOccupant(occupant)} disabled={orderActionsBlocked} data-order-action="CORRECT_ORDER_OCCUPANT" data-testid={`correct-occupant-${occupant.id}`}><Pencil aria-hidden="true" size={16} />更正资料</button> : null}
                </div>
                <dl className="detail-list">{occupantSnapshotEntries(occupant).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
              </li>
            ))}
          </ol>
        </section>
        <section className="detail-section" aria-labelledby="stay-heading"><div className="section-title-row"><h2 id="stay-heading">住宿状态</h2><StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} /></div><dl className="detail-list"><div><dt>住宿周期</dt><dd>{formatDate(view.order.arrival_date)} 至 {formatDate(view.order.departure_date)}</dd></div><div><dt>住宿类型</dt><dd>{view.order.stay_type === "FREE" ? "免费住宿" : view.order.member_id || view.order.member_contract_id ? "会员住宿" : "普通住宿"}</dd></div>{view.order.stay_type === "FREE" ? <><div><dt>免费入住类型</dt><dd>{view.order.free_stay_category_code === "VOLUNTEER" ? "义工" : view.order.free_stay_category_code === "RECEPTION" ? "接待" : "历史未记录"}</dd></div><div><dt>免费入住原因</dt><dd>{view.order.free_stay_reason}</dd></div></> : view.order.member_id || view.order.member_contract_id ? <div><dt>住宿来源</dt><dd>会员权益</dd></div> : <><div><dt>订单来源渠道</dt><dd>{view.order.booking_channel_code ? bookingChannelLabels[view.order.booking_channel_code] : "历史未记录"}</dd></div><div><dt>渠道订单号</dt><dd><code>{view.order.booking_channel_code === "WECOM" ? "不适用" : view.order.channel_order_reference ?? (view.order.booking_channel_code ? "未填写" : "历史未记录")}</code></dd></div></>}</dl></section>
      </div>

      <section className="detail-section full-detail" aria-labelledby="fulfillment-heading" data-testid="order-fulfillment">
        <div className="section-title-row"><h2 id="fulfillment-heading">入住与退房结果</h2></div>
        <div className="amendment-list">
          <FulfillmentResult type="CHECK_IN" record={view.fulfillment.checkIn} />
          <FulfillmentResult type="CHECK_OUT" record={view.fulfillment.checkOut} />
        </div>
      </section>

      {currentReleaseFeatures.cleaningWorkflow && view.cleaningTasks.length ? <section className="detail-section full-detail" aria-labelledby="cleaning-heading" data-testid="order-cleaning-tasks">
        <div className="section-title-row"><h2 id="cleaning-heading"><Sparkles aria-hidden="true" size={18} />清洁任务</h2><span>{view.cleaningTasks.length}</span></div>
        <ol className="amendment-list">{view.cleaningTasks.map((task) => {
          const unit = unitMap.get(task.inventoryUnitId);
          return <li key={task.id} data-testid="order-cleaning-task">
            <div><strong>{unit ? `${unit.code} · ${unit.name}` : "退房房源"}</strong><StatusBadge value={task.status} label={businessStatusLabel(task.status)} /></div>
            <div><span>清洁日期：{formatDate(task.serviceDate)}</span><small>生成：{task.createdBy?.displayName ?? "系统记录"} · {formatDateTime(task.createdAt)}</small></div>
            {task.status === "COMPLETED" ? <div><span>清洁已完成</span><small>{task.completedBy?.displayName ?? "系统记录"} · {formatDateTime(task.completedAt ?? undefined)}</small></div> : <p>等待工作人员完成清洁。</p>}
          </li>;
        })}</ol>
      </section> : null}

      <section className="detail-section full-detail" aria-labelledby="occupant-corrections-heading">
        <div className="section-title-row"><h2 id="occupant-corrections-heading">住宿人资料更正记录</h2><span>{view.occupantCorrections.length}</span></div>
        {view.occupantCorrections.length ? <div className="amendment-list" data-testid="occupant-correction-history">{view.occupantCorrections.map((correction) => {
          const occupant = occupants.find((candidate) => candidate.id === correction.occupantId);
          return <article key={correction.id} data-testid="occupant-correction-history-item">
            <div><strong>#{correction.sequence} · {correction.correctedSnapshot.nickname || `住宿人 ${occupant?.ordinal ?? correction.occupantId}`}</strong><code>{correction.occupantId} · {correction.id}</code></div>
            <div><span>{correction.actor.displayName} · <code>{correction.actor.subjectId}</code> · {formatDateTime(correction.createdAt)}</span><p>{correction.reason.code} · {correction.reason.note}</p></div>
            <div><span>更正前</span><dl className="detail-list">{occupantSnapshotEntries(correction.priorSnapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></div>
            <div><span>更正后</span><dl className="detail-list">{occupantSnapshotEntries(correction.correctedSnapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></div>
            <div><span>审计引用</span><p>Amendment <code>{correction.amendmentId}</code> · Command <code>{correction.commandId}</code></p></div>
          </article>;
        })}</div> : <EmptyState title="尚无资料更正" detail="住宿人创建时的原始资料保持不变；人工更正会在此追加审计记录。" />}
      </section>

      <section className="detail-section full-detail"><div className="section-title-row"><h2 id="segments-heading">住宿分段</h2><span>{view.segments.length}</span></div><div className="table-region" role="region" aria-label="住宿分段" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">序号</th><th scope="col">库存单元</th><th scope="col">周期</th><th scope="col">类型</th><th scope="col">Segment ID</th></tr></thead><tbody>{view.segments.map((segment) => { const unit = unitMap.get(segment.inventory_unit_id); return <tr key={segment.id}><td>{segment.sequence}</td><th scope="row">{unit ? `${unit.code} · ${unit.name}` : segment.inventory_unit_id}</th><td>{formatDate(segment.arrival_date)} 至 {formatDate(segment.departure_date)}</td><td>{segment.segment_type}</td><td><code>{segment.id}</code></td></tr>; })}</tbody></table></div></section>

      <section className="detail-section full-detail" aria-labelledby="revisions-heading"><div className="section-title-row"><h2 id="revisions-heading">Pricing revisions</h2><span>{view.pricingRevisions.length}</span></div><div className="table-region" role="region" aria-label="计价修订" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">Revision</th><th scope="col">锁定政策</th><th scope="col">周期</th><th scope="col">Coverage</th><th scope="col">政策基础报价</th><th scope="col">人工调价差额</th><th scope="col">指定最终总价</th><th scope="col">明细</th></tr></thead><tbody>{view.pricingRevisions.map((revision) => <tr key={revision.id}><th scope="row">#{revision.revision_no}<code>{revision.id}</code></th><td><code>{revision.policy_version_id}</code></td><td>{formatDate(revision.arrival_date)} 至 {formatDate(revision.departure_date)}</td><td>{countArray(revision.coverage_set)}</td><td>{formatMinor(revision.policy_base_amount_minor, revision.currency)}</td><td>{formatMinor(revision.manual_adjustment_minor, revision.currency)}</td><td><strong>{formatMinor(revision.current_contract_amount_minor, revision.currency)}</strong></td><td><JsonDetails label="查看" value={{ coverageSet: revision.coverage_set, cashLines: revision.cash_lines, policyBaseAmountMinor: revision.policy_base_amount_minor, manualAdjustmentMinor: revision.manual_adjustment_minor, targetCurrentContractAmountMinor: revision.current_contract_amount_minor }} /></td></tr>)}</tbody></table></div></section>

      <section className="detail-section full-detail" aria-labelledby="coverage-table-heading"><div className="section-title-row"><h2 id="coverage-table-heading">会员权益覆盖</h2><span>{view.coverageSet.length}</span></div>{view.coverageSet.length ? <div className="table-region" role="region" aria-label="会员覆盖" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">服务日期</th><th scope="col">住宿位置</th><th scope="col">权益类型</th><th scope="col">状态</th></tr></thead><tbody>{view.coverageSet.map((coverage) => <tr key={coverage.id}><td>{coverage.service_date}</td><td>{unitMap.get(coverage.inventory_unit_id)?.code ?? "房源"}</td><td>{coverage.unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜"}</td><td><StatusBadge value={coverage.status} label={businessStatusLabel(coverage.status)} /></td></tr>)}</tbody></table></div> : <EmptyState title="没有会员覆盖" detail="此订单未使用会员住宿权益。" />}</section>

      <section className="detail-section full-detail" aria-labelledby="facts-heading"><div className="section-title-row"><h2 id="facts-heading">收退款与冲销事实</h2><span>{view.collectionFacts.length}</span></div>{view.collectionFacts.length ? <div className="table-region" role="region" aria-label="收退款事实" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">Fact ID</th><th scope="col">类型</th><th scope="col">事实金额</th><th scope="col">净影响</th><th scope="col">外部交易单号</th><th scope="col">引用 / 冲销</th><th scope="col">方式与备注</th><th scope="col">操作</th></tr></thead><tbody>{view.collectionFacts.map((fact) => <tr key={fact.fact_id}><th scope="row"><code>{fact.fact_id}</code><small>{formatDateTime(fact.created_at)}</small></th><td><StatusBadge value={fact.fact_type} /></td><td>{formatMinor(fact.amount_minor, fact.currency)}</td><td>{formatMinor(fact.net_effect_minor, fact.currency)}</td><td><code>{fact.transaction_reference ?? (fact.fact_type === "REVERSAL" ? "-" : "历史未记录")}</code></td><td><code>{fact.references_fact_id ?? fact.reverses_fact_id ?? "-"}</code></td><td><strong>{fact.method}</strong><small>{fact.note || "-"}</small></td><td><FactActions fact={fact} canRefund={enabledActions.has("RECORD_REFUND") && remainingRefundableMinor(view.collectionFacts, fact) > 0} disabled={orderActionsBlocked} onRefund={() => openForm("RECORD_REFUND", fact.fact_id)} /></td></tr>)}</tbody></table></div> : <EmptyState title="尚无收退款事实" detail="使用订单操作记录第一笔独立收款。" />}</section>

      <section className="detail-section full-detail" aria-labelledby="amendments-heading"><div className="section-title-row"><h2 id="amendments-heading">Amendments</h2><span>{view.amendments.length}</span></div><div className="amendment-list">{view.amendments.map((amendment) => <article key={amendment.id}><div><strong>#{amendment.sequence} · {amendment.amendment_type}</strong><code>{amendment.id}</code></div><div><span>{amendment.reason_code}</span><p>{amendment.reason_note}</p></div><div><span>v{amendment.prior_version} → v{amendment.new_version}</span><JsonDetails label="payload" value={amendment.payload} /></div></article>)}</div></section>

      {formAction ? <ActionFormDialog action={formAction} view={view} {...(initialFactId ? { initialFactId } : {})} onClose={() => { setFormAction(undefined); setInitialFactId(undefined); }} onSubmit={(request) => { if (orderActionsBlocked || !enabledActions.has(formAction)) return; setFormAction(undefined); setInitialFactId(undefined); setRecoveryDialogOpen(false); setCommand(request); }} /> : null}
      {correctingOccupant ? <OrderOccupantCorrectionDialog view={view} occupant={correctingOccupant} onClose={() => setCorrectingOccupant(undefined)} onSubmit={(request) => { if (orderActionsBlocked || !enabledActions.has("CORRECT_ORDER_OCCUPANT")) return; setCorrectingOccupant(undefined); setRecoveryDialogOpen(false); setCommand(request); }} /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${pendingRecovery?.confirmationKey ?? "missing"}` : "new-order-command"}
        request={command}
        onClose={closeCommandDialog}
        {...(recoveryDialogOpen && pendingRecovery ? {
          initialConfirmationKey: pendingRecovery.confirmationKey,
          ...(pendingRecovery.receipt ? { initialReceipt: pendingRecovery.receipt } : {})
        } : {})}
        onProgress={(progress) => commandRecovery.track(command, progress)}
      /> : null}
    </div>
  );
}
