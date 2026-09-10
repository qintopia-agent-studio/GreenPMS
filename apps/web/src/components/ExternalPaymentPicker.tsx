import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { Modal, formatDateTime, formatMinor } from "../uiBasic";
import type { ExternalPaymentItem, ExternalPaymentList } from "../../../../packages/contracts/src/external-payments.ts";
import "./ExternalPaymentPicker.css";

const labels: Record<ExternalPaymentItem["status"], string> = {
  AVAILABLE: "待匹配", MATCHED: "已匹配", HISTORICAL: "历史不纳入", REVIEW: "待核对", PENDING: "退款处理中", UNVERIFIED: "尚未核实成功"
};
export function paymentOptionText(item: ExternalPaymentItem): string {
  return `${item.nickname || "昵称未取得"} · ${item.amountMinor === null ? "金额待核实" : formatMinor(item.amountMinor, "CNY")} · ${formatDateTime(item.occurredAt)}`;
}
interface Props {
  propertyId: string; kind?: "COLLECTION" | "REFUND"; value: string;
  onChange: (reference: string, item?: ExternalPaymentItem) => void;
  amountMinor?: number | undefined; originalCollectionFactId?: string | undefined;
  disabled?: boolean; testId?: string; label?: string;
}
export function ExternalPaymentPicker(props: Props) {
  return <PaymentPicker key={`${props.propertyId}:${props.kind ?? "COLLECTION"}:${props.originalCollectionFactId ?? ""}`} {...props} />;
}
function PaymentPicker({ propertyId, kind = "COLLECTION", value, onChange, amountMinor,
  originalCollectionFactId, disabled = false, testId, label }: Props) {
  const listId = useId();
  const [data, setData] = useState<ExternalPaymentList>();
  const [failure, setFailure] = useState(false);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [selected, setSelected] = useState<ExternalPaymentItem>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("AVAILABLE");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [filterAmount, setFilterAmount] = useState("");
  const [beforeId, setBeforeId] = useState("");
  const title = label ?? (kind === "REFUND" ? "选择企业微信退款" : "选择企业微信收款");
  useEffect(() => {
    if (!value || selected?.reference === value || !data?.enabled) return;
    const controller = new AbortController();
    void api.externalPayments({ propertyId, kind, query: value, status: "ALL" }, controller.signal).then(result => {
      const matches = result.items.filter(item => item.reference === value);
      if (!controller.signal.aborted && matches.length === 1) setSelected(matches[0]);
    }).catch(() => {});
    return () => controller.abort();
  }, [propertyId, kind, value, selected?.reference, data?.enabled]);
  useEffect(() => { setBeforeId(""); }, [query, status, start, end, filterAmount, full]);
  useEffect(() => {
    let disposed = false;
    let active: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      active = new AbortController();
      const parameters: Record<string, string> = { propertyId, kind, recommended: String(!full) };
      if (originalCollectionFactId) parameters.originalCollectionFactId = originalCollectionFactId;
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
        const result = await api.externalPayments(parameters, active.signal);
        if (!disposed) { setData(result); setFailure(false); }
      } catch { if (!disposed) setFailure(true); }
      finally { if (!disposed) timer = setTimeout(load, 15_000); }
    };
    void load();
    return () => { disposed = true; active?.abort(); clearTimeout(timer); };
  }, [propertyId, kind, originalCollectionFactId, amountMinor, full, query, status, start, end, filterAmount, beforeId]);
  function choose(item: ExternalPaymentItem) {
    if (item.status !== "AVAILABLE" || item.amountMinor === null) return;
    setSelected(item); onChange(item.reference, item); setOpen(false); setFull(false);
  }
  const options = (data?.items ?? []).map(item => <li key={item.id}>
    <button type="button" className="external-payment-option" disabled={item.status !== "AVAILABLE" || disabled}
      onClick={() => choose(item)}>
      <span className="external-payment-primary"><strong>{item.nickname || "昵称未取得"}</strong>
        <strong>{item.amountMinor === null ? "金额待核实" : formatMinor(item.amountMinor, "CNY")}</strong></span>
      <span>{formatDateTime(item.occurredAt)} · {labels[item.status]}</span>
      {full && item.recommendationReasons.length ? <small>{item.recommendationReasons.join(" · ")}</small> : null}
      {full ? <small>编号：{item.reference}{item.originalTransactionReference ? ` · 原收款：${item.originalTransactionReference}` : ""}
        {item.orderId ? ` · 订单：${item.orderId}` : item.membershipOrderId ? ` · 会员订单：${item.membershipOrderId}` : ""}</small> : null}
    </button>
    {!full ? <details><summary>查看编号</summary><code>{item.reference}</code></details> : null}
  </li>);
  return <div className="external-payment-picker span-two" data-testid={testId ? `${testId}-picker` : undefined}>
    {data?.enabled ? <>
      <span className="external-payment-label" id={`${listId}-label`}>{title}</span>
      <button type="button" className="external-payment-trigger" aria-labelledby={`${listId}-label`}
        aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={() => setOpen(!open)}>
        {selected?.reference === value ? paymentOptionText(selected) : value ? `已暂选 · ${value}` : "按付款人、金额和时间选择"}<span aria-hidden="true">⌄</span>
      </button>
      {value ? <small>暂选尚未入账，最终确认后才匹配。<button type="button" className="external-payment-clear" onClick={() => { onChange(""); setSelected(undefined); }} disabled={disabled}>取消选择</button></small> : null}
      {open ? <div className="external-payment-dropdown" id={listId} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
        <ul aria-label="推荐收退款">{options}</ul>
        {!options.length ? <p>暂未找到推荐流水。</p> : null}
        <button type="button" className="button button-secondary" onClick={() => { setFull(true); setOpen(false); }}>查找完整清单</button>
      </div> : null}
    </> : <label>{kind === "REFUND" ? "企业微信退款单号" : "企业微信交易单号"}
      <input value={value} onChange={event => onChange(event.target.value)} required maxLength={200}
        data-testid={testId} disabled={disabled || !data || failure} />
    </label>}
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
          <option value="AVAILABLE">待匹配</option><option value="ALL">全部</option><option value="MATCHED">已匹配</option>
        </select></label>
      </div>
      <ul className="external-payment-full-list" aria-label="完整收退款清单">{options}</ul>
      {!options.length ? <p>没有符合条件的流水。</p> : null}
      {beforeId ? <button type="button" className="button button-secondary" onClick={() => setBeforeId("")}>回到首页</button> : null}
      {data?.hasMore && data.nextBeforeId ? <button type="button" className="button button-secondary" onClick={() => setBeforeId(data.nextBeforeId!)}>下一页</button> : null}
    </Modal> : null}
  </div>;
}
