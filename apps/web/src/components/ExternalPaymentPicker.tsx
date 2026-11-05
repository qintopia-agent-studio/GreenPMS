import type { PaymentAllocationItem, PaymentAllocationList } from "@qintopia/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { Modal, formatDateTime, formatMinor } from "../uiBasic";
import type { ExternalPaymentItem, ExternalPaymentList } from "../../../../packages/contracts/src/external-payments.ts";
import "./ExternalPaymentPicker.css";

export type PaymentItem = ExternalPaymentItem | PaymentAllocationItem;
const labels: Record<string, string> = {
  PARTIALLY_MATCHED: "部分分配", AVAILABLE: "待匹配", MATCHED: "已匹配", HISTORICAL: "历史不纳入", REVIEW: "待核对", PENDING: "退款处理中", UNVERIFIED: "尚未核实成功"
};
export function paymentOptionText(item: PaymentItem): string {
  return `${item.nickname || "昵称未取得"} · ${item.amountMinor === null ? "金额待核实" : formatMinor(item.amountMinor, "CNY")} · ${formatDateTime(item.occurredAt)}`;
}
interface Props {
  allocationMode?: boolean;
  propertyId: string; kind?: "COLLECTION" | "REFUND"; value: string;
  onChange: (reference: string, item?: PaymentItem) => void;
  amountMinor?: number | undefined; originalCollectionFactId?: string | undefined;
  originalCollectionBillId?: string | undefined;
  billId?: string | undefined;
  onResolve?: ((item: PaymentItem | undefined) => void) | undefined;
  onReconcile?: ((item: PaymentItem) => void) | undefined;
  allowRefundedSource?: boolean;
  disabled?: boolean; testId?: string; label?: string;
}
export function ExternalPaymentPicker(props: Props) {
  return <PaymentPicker key={`${props.propertyId}:${props.kind ?? "COLLECTION"}:${props.originalCollectionFactId ?? ""}:${props.originalCollectionBillId ?? ""}`} {...props} />;
}
function PaymentPicker({ propertyId, kind = "COLLECTION", value, onChange, amountMinor,
  originalCollectionFactId, originalCollectionBillId, billId, onResolve, onReconcile, allowRefundedSource = false, disabled = false, testId, label, allocationMode = false }: Props) {
  const loadPayments = allocationMode ? api.paymentAllocations : api.externalPayments;
  const listId = useId();
  const [data, setData] = useState<ExternalPaymentList | PaymentAllocationList>();
  const [failure, setFailure] = useState(false);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [selected, setSelected] = useState<PaymentItem>();
  const [resolveFailure, setResolveFailure] = useState(false);
  const [resolveAttempt, setResolveAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("AVAILABLE");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [filterAmount, setFilterAmount] = useState("");
  const [beforeId, setBeforeId] = useState("");
  const title = label ?? (kind === "REFUND" ? "选择企业微信退款" : "选择企业微信收款");
  const resolveRef = useRef(onResolve);
  resolveRef.current = onResolve;
  useEffect(() => {
    setResolveFailure(false);
    if ((!value && !billId) || (billId ? selected?.id === billId : selected?.reference === value)) return;
    // A restored ID is not usable evidence until its own scoped lookup succeeds.
    setSelected(undefined); resolveRef.current?.(undefined);
    if (!data?.enabled) return;
    let disposed = false;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => controller.abort(new Error("所选流水读取超时")), 12_000);
    void loadPayments({ propertyId, kind, ...(billId ? { billId } : { query: value }), status: "ALL",
      ...(originalCollectionFactId ? { originalCollectionFactId } : {}),
      ...(originalCollectionBillId ? { originalCollectionBillId } : {}) }, controller.signal).then(result => {
      if (disposed) return;
      if (controller.signal.aborted) throw new Error("所选流水读取超时");
      const matches = result.items.filter(item => (billId ? item.id === billId : item.reference === value) && item.kind === kind);
      if (matches.length !== 1) throw new Error("未找到唯一的原选流水");
      setSelected(matches[0]); resolveRef.current?.(matches[0]!);
    }).catch(() => {
      if (disposed) return;
      setResolveFailure(true);
      retry = setTimeout(() => setResolveAttempt(attempt => attempt + 1), 15_000);
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); clearTimeout(retry); };
  }, [propertyId, kind, value, billId, data?.enabled, allocationMode, originalCollectionFactId, originalCollectionBillId, resolveAttempt]);
  useEffect(() => { setBeforeId(""); }, [query, status, start, end, filterAmount, full]);
  useEffect(() => {
    let disposed = false;
    let active: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      active = new AbortController();
      const parameters: Record<string, string> = { propertyId, kind, recommended: String(!full) };
      if (originalCollectionFactId) parameters.originalCollectionFactId = originalCollectionFactId;
      if (originalCollectionBillId) parameters.originalCollectionBillId = originalCollectionBillId;
      if (!full && amountMinor && Number.isSafeInteger(amountMinor)) parameters.amountMinor = String(amountMinor);
      if (full) {
        parameters.status = status;
        if (query.trim()) parameters.query = query.trim();
        if (start) parameters.begin = new Date(`${start}T00:00:00+08:00`).toISOString();
        if (end) parameters.end = new Date(new Date(`${end}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
        const minor = Math.round(Number(filterAmount) * 100);
        if (minor > 0 && Number.isSafeInteger(minor)) parameters.amountMinor = String(minor);
        if (beforeId) parameters.beforeId = beforeId;
      }
      try {
        const result = await loadPayments(parameters, active.signal);
        if (!disposed) { setData(result); setFailure(false); }
      } catch { if (!disposed) setFailure(true); }
      finally { if (!disposed) timer = setTimeout(load, 15_000); }
    };
    void load();
    return () => { disposed = true; active?.abort(); clearTimeout(timer); };
  }, [propertyId, kind, originalCollectionFactId, originalCollectionBillId, amountMinor, full, query, status, start, end, filterAmount, beforeId, allocationMode]);
  function choose(item: PaymentItem) {
    if (!paymentSelectable(item, allocationMode, allowRefundedSource)) return;
    setSelected(item); onChange(item.reference, item); setOpen(false); setFull(false);
  }
  const options = (data?.items ?? []).map(item => <li key={item.id}>
    <button type="button" className="external-payment-option" disabled={!paymentSelectable(item, allocationMode, allowRefundedSource) || disabled}
      onClick={() => choose(item)}>
      <span className="external-payment-primary"><strong>{item.nickname || "昵称未取得"}</strong>
        <strong>{item.amountMinor === null ? "金额待核实" : formatMinor(item.amountMinor, "CNY")}</strong></span>
      {"remainingMinor" in item ? <small>已分配 {formatMinor(item.allocatedMinor, "CNY")} · 尚未分配 {formatMinor(item.remainingMinor, "CNY")}</small> : null}
      {item.kind === "COLLECTION" && item.refundSummary && (item.refundSummary.succeededMinor > 0 || item.refundSummary.pendingCount > 0 || item.refundSummary.reviewCount > 0) ? <small className="external-payment-refund-context">已成功退款 {formatMinor(item.refundSummary.succeededMinor, "CNY")} · 退款待归属 {formatMinor(item.refundSummary.unassignedMinor, "CNY")}{item.refundSummary.pendingCount ? ` · ${item.refundSummary.pendingCount} 笔退款处理中` : ""}{item.refundSummary.reviewCount ? ` · ${item.refundSummary.reviewCount} 笔退款待核对` : ""}</small> : null}
      <span>{formatDateTime(item.occurredAt)} · {labels[item.status]}</span>
      {full && item.recommendationReasons.length ? <small>{item.recommendationReasons.join(" · ")}</small> : null}
      {full ? <small>编号：{item.reference}{item.originalTransactionReference ? ` · 原收款：${item.originalTransactionReference}` : ""}
        {item.orderId ? ` · 订单：${item.orderId}` : item.membershipOrderId ? ` · 会员订单：${item.membershipOrderId}` : ""}</small> : null}
    </button>
    {item.kind === "COLLECTION" && item.refundSummary && item.refundSummary.unassignedMinor > 0 && !allowRefundedSource ? <div className="external-payment-refund-notice"><small>这笔收款已有退款尚未归属，请先核对关联退款。</small>{onReconcile ? <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => { onReconcile(item); setOpen(false); setFull(false); }}>核对关联退款</button> : null}</div> : null}
    {allocationMode && "allocations" in item && item.allocations.length ? <details><summary>查看分配明细</summary><ul>{item.allocations.map(part => <li key={part.id}>订单 {part.orderId} · {formatMinor(part.amountMinor, "CNY")} · {part.released ? "已撤销分配" : "有效分配"}</li>)}</ul></details> : null}
    {!full ? <details><summary>查看编号</summary><code>{item.reference}</code></details> : null}
  </li>);
  return <div className="external-payment-picker span-two" data-testid={testId ? `${testId}-picker` : undefined}>
    {data?.enabled ? <>
      <span className="external-payment-label" id={`${listId}-label`}>{title}</span>
      <button type="button" className="external-payment-trigger" aria-labelledby={`${listId}-label`}
        aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={() => setOpen(!open)}>
        {selected && (selected.reference === value || selected.id === billId) ? paymentOptionText(selected) : value ? `已暂选 · ${value}` : billId ? "正在载入原选流水…" : "按付款人、金额和时间选择"}<span aria-hidden="true">⌄</span>
      </button>
      {value || billId ? <small>暂选尚未入账，最终确认后才匹配。<button type="button" className="external-payment-clear" onClick={() => { onChange(""); setSelected(undefined); }} disabled={disabled}>取消选择</button></small> : null}
      {open ? <div className="external-payment-dropdown" id={listId} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
        <ul aria-label="推荐收退款">{options}</ul>
        {!options.length ? <p>暂未找到推荐流水。</p> : null}
        <button type="button" className="button button-secondary" onClick={() => { setFull(true); setOpen(false); }}>查找完整清单</button>
      </div> : null}
    </> : <label>{kind === "REFUND" ? "企业微信退款单号" : "企业微信交易单号"}
      <input value={value} onChange={event => onChange(event.target.value)} required maxLength={200}
        data-testid={testId} disabled={disabled || !data || failure} />
    </label>}
    {resolveFailure ? <p role="alert">暂时无法核实原选流水，填写内容已保留；核实前不能继续。<button type="button" className="button button-secondary button-small" onClick={() => setResolveAttempt(attempt => attempt + 1)}>重试原选流水</button></p> : null}
    <small role="status">{failure ? "暂时无法读取流水，系统会自动重试。" : data?.enabled
      ? data.synchronizationError ? "后台同步暂时延迟，已保存流水仍可查询。"
        : data.lastSyncedAt ? `同步至 ${formatDateTime(data.lastSyncedAt)}` : "正在进行首次同步。"
      : data ? "尚未启用流水同步，请填写真实单号。" : "正在读取收退款…"}</small>
    {full ? <Modal title={title + " · 完整清单"} onClose={() => setFull(false)} size="wide" className="external-payment-modal">
      <div className="external-payment-filters">
        <label>付款人昵称 / 单号<input value={query} maxLength={200} onChange={e => setQuery(e.target.value)} /></label>
        <label>金额（元）<input type="number" min="0.01" step="0.01" value={filterAmount} onChange={e => setFilterAmount(e.target.value)} /></label>
        <label>从<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>至<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
        <label>处理状态<select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="AVAILABLE">待匹配</option>{allocationMode ? <option value="PARTIALLY_MATCHED">部分分配</option> : null}<option value="ALL">全部</option><option value="MATCHED">已匹配</option>
        </select></label>
      </div>
      <ul className="external-payment-full-list" aria-label="完整收退款清单">{options}</ul>
      {!options.length ? <p>没有符合条件的流水。</p> : null}
      {beforeId ? <button type="button" className="button button-secondary" onClick={() => setBeforeId("")}>回到首页</button> : null}
      {data?.hasMore && data.nextBeforeId ? <button type="button" className="button button-secondary" onClick={() => setBeforeId(data.nextBeforeId!)}>下一页</button> : null}
    </Modal> : null}
  </div>;
}

export function paymentSelectable(item: PaymentItem, allocationMode = false, allowRefundedSource = false): boolean {
  return item.amountMinor !== null && (item.status === "AVAILABLE" || (allocationMode && item.status === "PARTIALLY_MATCHED")) && (!("remainingMinor" in item) || item.remainingMinor > 0)
    && (allowRefundedSource || !allocationMode || item.kind !== "COLLECTION" || !item.refundSummary || item.refundSummary.unassignedMinor === 0);
}
