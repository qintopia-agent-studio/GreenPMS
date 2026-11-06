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
    <dl><dt>{title === "退款" ? "企微已退" : "企微已收"}</dt><dd>{reconciliationMoney(totals.externalMinor)}</dd><dt>已记到订单</dt><dd>{reconciliationMoney(totals.businessMinor)}</dd>
      <dt>还没记到订单</dt><dd>{reconciliationMoney(totals.unassignedMinor)}</dd>
      {BigInt(totals.excessMinor) > 0n ? <><dt>超过企微的金额</dt><dd>{reconciliationMoney(totals.excessMinor)}</dd></> : null}
      {BigInt(totals.unbackedMinor) > 0n ? <><dt>订单已记、企微还没对上的金额</dt><dd>{reconciliationMoney(totals.unbackedMinor)}</dd></> : null}
      {totals.unknownCount ? <><dt>结果不确定的记录</dt><dd>{totals.unknownCount} 笔</dd></> : null}
    </dl></section>;
}

export function PaymentReconciliationQueue({ state, kind, setKind, retry, nextPage, firstPage, hasPrevious }: ReturnType<typeof usePaymentReconciliation>) {
  const { data, loading, error } = state;
  const delayed = data?.sync.lastSyncedAt && Date.parse(data.asOf) - Date.parse(data.sync.lastSyncedAt) > 5 * 60_000;
  const uncertain = Boolean(data && (!data.sync.enabled || !data.sync.lastSyncedAt || data.sync.hasError || delayed));
  return <section className="payment-reconciliation-queue" aria-labelledby="payment-reconciliation-heading">
    <div className="queue-exceptions-context"><h3 id="payment-reconciliation-heading">企微收退款{data ? ` · ${data.totalItems} 笔` : ""}</h3>
      <p>核对每笔钱是否记到了正确的订单。没处理完的记录会一直保留。</p>
      {data ? <small>{!data.sync.enabled ? "尚未开始读取企微收退款" : data.sync.lastSyncedAt ? `企微记录更新于 ${formatDateTime(data.sync.lastSyncedAt)}` : "暂时还没有读到企微收退款"}</small> : null}
    </div>
    <label className="filter-select-control"><span>查看</span><select value={kind} onChange={event => setKind(event.target.value as NonNullable<PaymentReconciliationQuery["kind"]>)}><option value="ALL">收款和退款</option><option value="COLLECTION">只看收款</option><option value="REFUND">只看退款</option></select></label>
    {loading ? <LoadingBlock label="正在读取企微收退款" /> : error ? <div className="queue-exceptions-feedback"><InlineError context="read" error={error} title="暂时取不到企微收退款" /><p>还不能确认是否有漏记，请稍后重试。</p><button type="button" className="button button-secondary" onClick={retry}>重新读取</button></div> : data ? <>
      {uncertain ? <p role="status" className="payment-reconciliation-notice">最新的企微收退款还没有取全，下面可能有遗漏，暂时不能确认账目都已对上。</p> : null}
      <details className="payment-reconciliation-summary"><summary>查看收退款汇总</summary><div className="payment-reconciliation-totals"><Totals title="收款" totals={data.summary.collections} /><Totals title="退款" totals={data.summary.refunds} /></div></details>
      {!data.items.length ? <p className="payment-reconciliation-notice">{hasPrevious ? "这一页已经没有需要处理的记录，请回到第一页查看。" : uncertain ? "已经读到的记录里，暂未发现需要处理的事项。" : "已读取的企微收退款中，没有需要处理的记录。"}</p> : data.items.map(item => <article className="queue-row payment-reconciliation-row" key={item.id}>
        <div className="queue-primary"><strong>{item.kind === "REFUND" ? "退款" : "收款"} · {item.nickname ?? "未显示付款人昵称"}</strong>
          <span>{item.amountMinor === null ? "企微金额还不确定" : `企微${item.kind === "REFUND" ? "退款" : "收款"} ${formatMinor(item.amountMinor, item.currency)}`} · 订单已记 {reconciliationMoney(item.businessMinor, item.currency)}</span>
          <small>时间：{formatDateTime(item.occurredAt)}</small><small>{item.kind === "REFUND" ? "退款单号" : "收款单号"}：{item.reference ?? "暂时没有单号"}</small>
          {item.originalTransactionReference && item.kind === "REFUND" ? <small>原收款单号：{item.originalTransactionReference}</small> : null}
          <ul className="queue-exception-reasons">{item.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>
        </div>
        <div className="queue-actions">{item.orderIds.length ? item.orderIds.map((orderId, index) => <Link className="button button-secondary button-small" key={orderId} to={`/orders/${encodeURIComponent(orderId)}?action=${item.kind === "REFUND" ? "RECORD_REFUND" : "RECORD_COLLECTION"}`}>{item.orderIds.length === 1 ? "查看订单" : `查看订单 ${index + 1}`}</Link>) : item.membershipOrderId ? <span>请打开会员订单，核对这笔收款。</span> : <><Link className="button button-secondary button-small" to="/orders">查找订单</Link><small>先确认是哪张订单，再登记这笔{item.kind === "REFUND" ? "退款" : "收款"}。</small></>}</div>
      </article>)}
      <div className="queue-exceptions-pagination" aria-label="企微收退款分页"><span>本页 {data.items.length} 笔 · 共 {data.totalItems} 笔需要处理</span><div><button type="button" className="button button-secondary button-small" disabled={!hasPrevious} onClick={firstPage}>回到第一页</button><button type="button" className="button button-secondary button-small" disabled={!data.nextCursor} onClick={nextPage}>下一页</button></div></div>
    </> : null}
  </section>;
}
