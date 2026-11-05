import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { PaymentReconciliationQuery, PaymentReconciliationResponse, PaymentReconciliationTotals } from "@qintopia/contracts";
import { api } from "./api";
import { formatDateTime, formatMinor, InlineError, LoadingBlock } from "./uiBasic";
import "./paymentReconciliation.css";

/** Totals may exceed Number's exact range; keep integer cents throughout display. */
export function reconciliationMoney(minor: string, currency = "CNY"): string {
  if (!/^-?\d+$/.test(minor)) return "待核对";
  const value = BigInt(minor), positive = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${currency === "CNY" ? "¥" : `${currency} `}${(positive / 100n).toLocaleString("zh-CN")}.${(positive % 100n).toString().padStart(2, "0")}`;
}

export interface PaymentReconciliationState {
  loading: boolean; data?: PaymentReconciliationResponse | undefined; error?: unknown;
}
export function usePaymentReconciliation(propertyId: string, refreshToken: number, active = true, read = api.paymentReconciliation) {
  const [kind, setKind] = useState<NonNullable<PaymentReconciliationQuery["kind"]>>("ALL");
  const [cursor, setCursor] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<PaymentReconciliationState>({ loading: true });
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const lastReadKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => { setCursor(undefined); setKind("ALL"); }, [propertyId]);
  useEffect(() => {
    const readKey = JSON.stringify([propertyId, kind, cursor, refreshToken, refresh]);
    if (!visible || (!active && lastReadKey.current === readKey)) {
      setState(current => current.loading ? { ...current, loading: false } : current);
      return;
    }
    let disposed = false; let controllerInFlight: AbortController | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    setState(current => ({ loading: true, ...(current.data?.propertyId === propertyId ? { data: current.data } : {}) }));
    async function load() {
      const controller = new AbortController();
      controllerInFlight = controller;
      const timeout = setTimeout(() => controller.abort(new Error("收退款核对读取超时，请重试")), 12_000);
      try {
        const data = await read({ propertyId, kind, status: "OPEN", limit: 25, ...(cursor ? { afterId: cursor } : {}) }, controller.signal);
        if (disposed) return;
        if (data.propertyId !== propertyId) throw new Error("收退款核对门店不一致，请重新读取");
        lastReadKey.current = readKey;
        setState({ loading: false, data });
      } catch (error) { if (!disposed) setState({ loading: false, error: controller.signal.aborted ? controller.signal.reason : error }); }
      finally { clearTimeout(timeout); if (!disposed && active) timer = setTimeout(load, 15_000); }
    }
    void load();
    return () => { disposed = true; controllerInFlight?.abort(); clearTimeout(timer); };
  }, [propertyId, kind, cursor, refreshToken, refresh, read, active, visible]);
  return { state, kind, setKind: (next: NonNullable<PaymentReconciliationQuery["kind"]>) => { setKind(next); setCursor(undefined); },
    retry: () => setRefresh(value => value + 1), firstPage: () => setCursor(undefined),
    nextPage: () => { if (state.data?.nextCursor) setCursor(state.data.nextCursor); }, hasPrevious: Boolean(cursor) };
}

function Totals({ title, totals }: { title: string; totals: PaymentReconciliationTotals }) {
  return <section className="payment-reconciliation-total" aria-label={`${title}核对汇总`}><h4>{title}</h4>
    <dl><dt>企微成功金额</dt><dd>{reconciliationMoney(totals.externalMinor)}</dd><dt>业务已登记</dt><dd>{reconciliationMoney(totals.businessMinor)}</dd>
      <dt>流水待归属</dt><dd>{reconciliationMoney(totals.unassignedMinor)}</dd>
      {BigInt(totals.excessMinor) > 0n ? <><dt>超额关联</dt><dd>{reconciliationMoney(totals.excessMinor)}</dd></> : null}
      {BigInt(totals.unbackedMinor) > 0n ? <><dt>业务缺少流水依据</dt><dd>{reconciliationMoney(totals.unbackedMinor)}</dd></> : null}
      {totals.unknownCount ? <><dt>来源待核实</dt><dd>{totals.unknownCount} 笔</dd></> : null}
    </dl></section>;
}

export function PaymentReconciliationQueue({ state, kind, setKind, retry, nextPage, firstPage, hasPrevious }: ReturnType<typeof usePaymentReconciliation>) {
  const { data, loading, error } = state;
  const delayed = data?.sync.lastSyncedAt && Date.parse(data.asOf) - Date.parse(data.sync.lastSyncedAt) > 5 * 60_000;
  const uncertain = Boolean(data && (!data.sync.enabled || !data.sync.lastSyncedAt || data.sync.hasError || delayed));
  return <section className="payment-reconciliation-queue" aria-labelledby="payment-reconciliation-heading">
    <div className="queue-exceptions-context"><h3 id="payment-reconciliation-heading">收退款待核对{data ? ` · ${data.totalItems} 笔` : ""}</h3>
      <p>收款与退款分别核对，未处理事项跨日期保留。这里只列待处理流水，不将订单应收或内部划转当作企微收款。</p>
      {data ? <small>{!data.sync.enabled ? "企微同步未启用" : data.sync.lastSyncedAt ? `流水同步至 ${formatDateTime(data.sync.lastSyncedAt)}` : "尚无成功同步记录"}{data.sync.hasError || delayed ? " · 同步延迟，仍可能有尚未取得的流水" : ""}</small> : null}
    </div>
    <label className="filter-select-control"><span>流水类型</span><select value={kind} onChange={event => setKind(event.target.value as NonNullable<PaymentReconciliationQuery["kind"]>)}><option value="ALL">收款及退款</option><option value="COLLECTION">仅收款</option><option value="REFUND">仅退款</option></select></label>
    {loading ? <LoadingBlock label="正在核对收退款流水" /> : error ? <div><InlineError context="read" error={error} title="收退款核对暂不可用" /><p>当前差额未知，不能据此认定已对平。</p><button type="button" className="button button-secondary" onClick={retry}>重试收退款核对</button></div> : data ? <>
      <div className="payment-reconciliation-totals"><Totals title="收款" totals={data.summary.collections} /><Totals title="退款" totals={data.summary.refunds} /></div>
      {uncertain ? <p role="status" className="form-field-note">同步依据尚未完整；以下为当前已知流水，不能认定全部收退款已对平。</p> : null}
      {!data.items.length ? <p>{hasPrevious ? "本页没有待处理流水，请回到首页核对。" : uncertain ? "当前已知范围内没有待处理流水。" : "当前纳入核对范围的流水没有待处理差额。"}</p> : data.items.map(item => <article className="queue-row payment-reconciliation-row" key={item.id}>
        <div className="queue-primary"><strong>{item.kind === "REFUND" ? "退款" : "收款"} · {item.nickname ?? "付款人昵称未取得"}</strong>
          <span>{item.amountMinor === null ? "外部金额待核实" : `外部 ${formatMinor(item.amountMinor, item.currency)}`} · 业务已登记 {reconciliationMoney(item.businessMinor, item.currency)}</span>
          <small>发生时间：{formatDateTime(item.occurredAt)}</small><small>{item.kind === "REFUND" ? "退款单号" : "收款单号"}：{item.reference ?? "待核对"}</small>
          {item.originalTransactionReference && item.kind === "REFUND" ? <small>原收款：{item.originalTransactionReference}</small> : null}
          <ul className="queue-exception-reasons">{item.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>
        </div>
        <div className="queue-actions">{item.orderIds.length ? item.orderIds.map((orderId, index) => <Link className="button button-secondary button-small" key={orderId} to={`/orders/${encodeURIComponent(orderId)}?action=${item.kind === "REFUND" ? "RECORD_REFUND" : "RECORD_COLLECTION"}`}>{item.orderIds.length === 1 ? "打开订单核对" : `打开关联订单 ${index + 1}`}</Link>) : item.membershipOrderId ? <span>请在会员订单核对原收款</span> : <><Link className="button button-secondary button-small" to="/orders">查找所属订单</Link><small>核实归属后，从订单收款／退款入口选择这笔流水。</small></>}</div>
      </article>)}
      <div className="queue-exceptions-pagination"><span>本页 {data.items.length} 笔 · 共 {data.totalItems} 笔待核对</span><div><button type="button" className="button button-secondary button-small" disabled={!hasPrevious} onClick={firstPage}>回到首页</button><button type="button" className="button button-secondary button-small" disabled={!data.nextCursor} onClick={nextPage}>下一页流水</button></div></div>
    </> : null}
  </section>;
}
