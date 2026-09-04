import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronRight, PencilLine, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { commandRecoveryAvailable, principalCan, useWorkspace } from "../session";
import type { BookingChannelCode, CommandRequest, InventoryUnitDto, OrderRowDto } from "../types";
import {
  businessStatusLabel,
  CommandDialog,
  type CommandDialogCloseContext,
  CommandRecoveryBar,
  CommandResultNotice,
  DamagedCommandRecoveryNotice,
  EmptyState,
  formatDate,
  formatMinor,
  guestName,
  guestSearchText,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  QuoteRecoveryConflictNotice,
  recoveryCommandRequest,
  StatusBadge,
  usePersistentCommandRecovery
} from "../ui";

const bookingChannelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

function orderStayTypeLabel(order: OrderRowDto): string {
  if (order.stay_type === "FREE") return "免费住宿";
  if (order.member_id || order.member_contract_id) return "会员住宿";
  return "普通住宿";
}

function orderSourceLabel(order: OrderRowDto): string {
  if (order.member_id || order.member_contract_id) return "会员权益";
  if (order.stay_type === "FREE") return "免费住宿";
  return order.booking_channel_code ? bookingChannelLabels[order.booking_channel_code] : "历史未记录";
}

function orderChannelReferenceLabel(order: OrderRowDto): string {
  if (order.member_id || order.member_contract_id || order.stay_type === "FREE") return "不适用";
  if (order.booking_channel_code === "WECOM") return "不适用";
  return order.channel_order_reference ?? "未填写";
}

function orderAmountLabel(order: OrderRowDto): string {
  return order.current_contract_amount_minor === null || !order.currency
    ? "历史未记录"
    : formatMinor(order.current_contract_amount_minor, order.currency);
}

export function orderRoomTypeLabel(order: OrderRowDto): string {
  const name = order.current_unit_name;
  if (!name) return "历史未记录";
  const separatorIndex = name.indexOf(" · ");
  return separatorIndex > 0 ? name.slice(separatorIndex + 3) : name;
}

type HistoricalStayCorrectionDraft = {
  orderId: string;
  expectedVersion: number;
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
};

function correctionRowsFromDraft(draft: CommandRequest | undefined): HistoricalStayCorrectionDraft[] {
  if (draft?.commandType !== "CORRECT_HISTORICAL_STAY_ARRANGEMENTS" || !Array.isArray(draft.input.correctionSet)) return [];
  return draft.input.correctionSet.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const target = item.target && typeof item.target === "object" && !Array.isArray(item.target)
      ? item.target as Record<string, unknown>
      : undefined;
    if (typeof item.orderId !== "string"
      || !Number.isSafeInteger(item.expectedVersion)
      || typeof target?.inventoryUnitId !== "string"
      || typeof target.arrivalDate !== "string"
      || typeof target.departureDate !== "string") return [];
    return [{
      orderId: item.orderId,
      expectedVersion: item.expectedVersion as number,
      inventoryUnitId: target.inventoryUnitId,
      arrivalDate: target.arrivalDate,
      departureDate: target.departureDate
    }];
  });
}

function eligibleHistoricalOrders(orders: readonly OrderRowDto[]): OrderRowDto[] {
  return orders.filter((order) => order.status === "CHECKED_OUT" && order.stay_status === "COMPLETED");
}

function matchingCorrectionUnits(order: OrderRowDto, inventoryUnits: readonly InventoryUnitDto[]): InventoryUnitDto[] {
  const current = inventoryUnits.find((unit) => unit.property_id === order.property_id && unit.code === order.current_unit_code);
  if (!current) return [];
  return inventoryUnits.filter((unit) => unit.property_id === order.property_id
    && unit.active
    && unit.kind === current.kind
    && unit.pricing_product_code === current.pricing_product_code);
}

function HistoricalStayCorrectionsDialog({ propertyId, orders, inventoryUnits, draft, onClose, onSubmit }: {
  propertyId: string;
  orders: OrderRowDto[];
  inventoryUnits: InventoryUnitDto[];
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const candidates = eligibleHistoricalOrders(orders);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [rows, setRows] = useState<HistoricalStayCorrectionDraft[]>(() => correctionRowsFromDraft(draft));
  const [evidenceNote, setEvidenceNote] = useState(() => typeof draft?.input.evidenceNote === "string" ? draft.input.evidenceNote : "");
  const [validationError, setValidationError] = useState<string>();
  const orderById = new Map(candidates.map((order) => [order.id, order]));
  const selectableOrders = candidates.filter((order) => !rows.some((row) => row.orderId === order.id));

  function addOrder() {
    const order = orderById.get(selectedOrderId);
    if (!order) return;
    const units = matchingCorrectionUnits(order, inventoryUnits);
    if (!units.length) {
      setValidationError("该订单当前房源无法对应到可用房型，暂时不能在页面中修改。");
      return;
    }
    const currentUnit = units.find((unit) => unit.code === order.current_unit_code) ?? units[0]!;
    setRows((current) => [...current, {
      orderId: order.id,
      expectedVersion: order.version,
      inventoryUnitId: currentUnit.id,
      arrivalDate: order.arrival_date,
      departureDate: order.departure_date
    }]);
    setSelectedOrderId("");
    setValidationError(undefined);
  }

  function updateRow(index: number, patch: Partial<HistoricalStayCorrectionDraft>) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const evidence = evidenceNote.trim();
    if (!rows.length) {
      setValidationError("请至少加入一笔已完成住宿订单。");
      return;
    }
    if (!evidence) {
      setValidationError("请填写能够复核真实安排的证据说明。");
      return;
    }
    if (rows.some((row) => row.arrivalDate >= row.departureDate)) {
      setValidationError("每笔订单的退房日期都必须晚于入住日期。");
      return;
    }
    onSubmit({
      commandType: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      title: "修改历史住宿安排",
      description: "系统会把整组订单作为一个最终结果核对；确认后新增历史修改记录，不改变住宿人、金额、收款或完成状态。",
      initialReason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: evidence },
      inventoryUnitLabels: Object.fromEntries(inventoryUnits.map((unit) => [unit.id, `${unit.code} · ${unit.name}`])),
      historicalStayCorrectionContexts: Object.fromEntries(rows.map((row) => {
        const order = orderById.get(row.orderId);
        return [row.orderId, { guestName: order ? guestName(order.primary_guest_snapshot) : "历史住宿" }];
      })),
      input: {
        propertyId,
        correctionSet: rows.map((row) => ({
          orderId: row.orderId,
          expectedVersion: row.expectedVersion,
          target: {
            inventoryUnitId: row.inventoryUnitId,
            arrivalDate: row.arrivalDate,
            departureDate: row.departureDate
          }
        })),
        evidenceNote: evidence
      }
    });
  }

  return <Modal title="修改历史住宿安排" size="wide" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid form-grid-two">
        <label className="span-two">加入已完成订单
          <select value={selectedOrderId} onChange={(event) => setSelectedOrderId(event.target.value)}>
            <option value="">选择订单</option>
            {selectableOrders.map((order) => <option key={order.id} value={order.id}>{guestName(order.primary_guest_snapshot)} · {formatDate(order.arrival_date)} 至 {formatDate(order.departure_date)} · {order.current_unit_code ?? "房源未记录"}</option>)}
          </select>
        </label>
        <button type="button" className="button button-secondary" onClick={addOrder} disabled={!selectedOrderId}><Plus aria-hidden="true" size={16} />加入修改清单</button>
      </div>
      {!rows.length ? <EmptyState title="尚未加入订单" detail="互换日期或房源的订单必须放在同一集合中一次核对。" /> : <div className="historical-correction-list">
        {rows.map((row, index) => {
          const order = orderById.get(row.orderId);
          if (!order) return null;
          const units = matchingCorrectionUnits(order, inventoryUnits);
          const orderLabel = `${guestName(order.primary_guest_snapshot)}，${formatDate(order.arrival_date)} 至 ${formatDate(order.departure_date)}`;
          return <section key={row.orderId} className="historical-correction-item" aria-label={`修改 ${orderLabel}`}>
            <div className="section-title-row"><div><span className="section-kicker">{guestName(order.primary_guest_snapshot)}</span><h3>{order.current_unit_code ?? "房源未记录"} · {formatDate(order.arrival_date)} 至 {formatDate(order.departure_date)}</h3></div><button type="button" className="icon-button" title="移出修改清单" aria-label={`移出 ${orderLabel}`} onClick={() => setRows((current) => current.filter((candidate) => candidate.orderId !== row.orderId))}><Trash2 aria-hidden="true" size={17} /></button></div>
            <div className="form-grid form-grid-three">
              <label>真实入住日期<input type="date" value={row.arrivalDate} onChange={(event) => updateRow(index, { arrivalDate: event.target.value })} required /></label>
              <label>真实退房日期<input type="date" value={row.departureDate} onChange={(event) => updateRow(index, { departureDate: event.target.value })} required /></label>
              <label>真实房源<select value={row.inventoryUnitId} onChange={(event) => updateRow(index, { inventoryUnitId: event.target.value })} required>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.code} · {unit.name}</option>)}</select></label>
            </div>
          </section>;
        })}
      </div>}
      <label>证据说明<textarea value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} required maxLength={1000} rows={3} placeholder="例如：纸质入住记录、企业微信沟通和收款日期已复核" /></label>
      {validationError ? <InlineError error={new Error(validationError)} /> : null}
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={!rows.length}>生成整组核对</button></div>
    </form>
  </Modal>;
}

export function OrdersPage() {
  const { principal, propertyId, meta } = useWorkspace();
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  const recoveryPendingAllowed = commandRecoveryAvailable(principal, propertyId, commandRecovery.pending?.commandType);
  const commandsBlocked = commandRecovery.blocked && recoveryPendingAllowed;
  const canCorrectHistoricalStays = principalCan(principal, propertyId, "CORRECT_HISTORICAL_STAY_ARRANGEMENTS");
  const [orders, setOrders] = useState<OrderRowDto[]>([]);
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false);
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string>();

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    api.orders(propertyId)
      .then((response) => current && setOrders(response.orders))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [propertyId, refreshToken]);

  const statusOptions = useMemo(() => [...new Set(orders.map((order) => order.status))], [orders]);
  const visibleOrders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return orders.filter((order) => {
      if (status !== "ALL" && order.status !== status) return false;
      if (!needle) return true;
      return order.id.toLowerCase().includes(needle)
        || guestSearchText(order.primary_guest_snapshot).toLowerCase().includes(needle)
        || orderSourceLabel(order).toLowerCase().includes(needle)
        || orderChannelReferenceLabel(order).toLowerCase().includes(needle);
    });
  }, [orders, query, status]);

  function startHistoricalCorrection(request: CommandRequest) {
    if (!canCorrectHistoricalStays || commandsBlocked) return;
    setCorrectionDialogOpen(false);
    setCommandDraft(undefined);
    setRecoveryDialogOpen(false);
    setCommand(request);
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending || !recoveryPendingAllowed) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  async function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    if (context || (commandRecovery.pending && isTerminalCommandRecovery(commandRecovery.pending.state))) {
      refreshAfterClose ||= commandRecovery.pending?.state === "EXECUTED";
      if (await commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已完成操作的本地恢复记录；为避免重复修改，写入继续暂停"));
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) setRefreshToken((value) => value + 1);
  }

  return (
    <div className="orders-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">订单管理</p><h1>订单</h1><p>查询住宿订单、收款与履约进度</p></div>
        <div className="page-heading-buttons">
          {canCorrectHistoricalStays ? <button className="button button-secondary" type="button" onClick={() => setCorrectionDialogOpen(true)} disabled={commandsBlocked || loading}><PencilLine aria-hidden="true" size={17} />修改历史安排</button> : null}
          <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新</button>
        </div>
      </header>
      <InlineError error={recoveryError} title="恢复记录未完成" />
      {commandRecovery.canDiscardCorrupt ? <DamagedCommandRecoveryNotice error={commandRecovery.error} onDiscard={commandRecovery.discardCorruptAfterReview} testId="orders-damaged-command-recovery" /> : <InlineError error={commandRecovery.error} title="本地操作恢复记录不可用" />}
      <QuoteRecoveryConflictNotice conflict={commandRecovery.conflict} testId="orders-quote-recovery-conflict" />
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      {commandRecovery.pending && recoveryPendingAllowed ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="orders-command-recovery" businessFacing /> : null}
      <section className="list-toolbar" aria-label="订单筛选">
        <label className="search-control"><Search aria-hidden="true" size={17} /><span className="sr-only">搜索订单</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="姓名、渠道或渠道订单号" /></label>
        <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部状态</option>{statusOptions.map((option) => <option key={option} value={option}>{businessStatusLabel(option)}</option>)}</select></label>
        <span className="result-count">{visibleOrders.length} / {orders.length}</span>
      </section>
      <InlineError error={error} title="无法载入订单" />
      {loading ? <LoadingBlock label="正在载入订单" /> : visibleOrders.length === 0 ? <EmptyState title="没有匹配订单" detail="调整筛选条件或从房态页创建新订单。" /> : (
        <div className="table-region orders-table-region" role="region" aria-label="订单列表" tabIndex={0}>
          <table className="data-table" data-testid="orders-table">
            <thead><tr><th scope="col">订单 / 住客</th><th scope="col">状态</th><th scope="col">住宿类型</th><th scope="col">房型</th><th scope="col">订单来源</th><th scope="col">渠道订单号</th><th scope="col">住宿周期</th><th scope="col">订单金额</th><th scope="col"><span className="sr-only">查看</span></th></tr></thead>
            <tbody>{visibleOrders.map((order) => (
              <tr key={order.id}>
                <th scope="row"><Link className="primary-cell-link" to={`/orders/${encodeURIComponent(order.id)}`}><strong>{guestName(order.primary_guest_snapshot)}</strong></Link></th>
                <td><StatusBadge value={order.status} label={businessStatusLabel(order.status)} /></td>
                <td>{orderStayTypeLabel(order)}</td>
                <td>{orderRoomTypeLabel(order)}</td>
                <td>{orderSourceLabel(order)}</td>
                <td>{orderChannelReferenceLabel(order)}</td>
                <td><span className="date-range">{formatDate(order.arrival_date)}<span>至</span>{formatDate(order.departure_date)}</span></td>
                <td><strong>{orderAmountLabel(order)}</strong></td>
                <td><Link className="icon-button" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`查看 ${guestName(order.primary_guest_snapshot)}，${formatDate(order.arrival_date)} 至 ${formatDate(order.departure_date)}`} title="查看订单"><ChevronRight aria-hidden="true" size={19} /></Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {correctionDialogOpen && canCorrectHistoricalStays ? <HistoricalStayCorrectionsDialog
        propertyId={propertyId}
        orders={orders}
        inventoryUnits={meta.inventoryUnits.filter((unit) => unit.property_id === propertyId)}
        {...(commandDraft?.commandType === "CORRECT_HISTORICAL_STAY_ARRANGEMENTS" ? { draft: commandDraft } : {})}
        onClose={() => { setCorrectionDialogOpen(false); setCommandDraft(undefined); }}
        onSubmit={startHistoricalCorrection}
      /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}` : "historical-stay-correction"}
        request={command}
        onClose={closeCommandDialog}
        {...(recoveryDialogOpen && commandRecovery.pending ? { initialConfirmationKey: commandRecovery.pending.confirmationKey } : {})}
        onCommitted={() => setRefreshToken((value) => value + 1)}
        onProgress={(progress) => commandRecovery.track(command, progress)}
        onBusinessSuccess={(message) => setCommandNotice(message)}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
        onReturnToEdit={(request) => { setCommandDraft(request); setCorrectionDialogOpen(true); }}
      /> : null}
    </div>
  );
}
