import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { WorkbenchFundsExceptionItem, WorkbenchFundsExceptionList } from "@qintopia/contracts";
import { api } from "../api";
import { EmptyState, InlineError, LoadingBlock, formatMinor } from "../uiBasic";

function customerClue(item: WorkbenchFundsExceptionItem): string {
  return item.kind === "ORDER_EXCESS"
    ? `入住者线索：${item.customerLabel ?? "未取得"} · 付款归属待核实`
    : `客户线索：${item.customerLabel ?? "未取得"} · ${item.kind === "UNALLOCATED_COLLECTION" ? "付款人待核实" : "客户归属待核实"}`;
}

const sourceLabels = { UNALLOCATED_COLLECTION: "收款未匹配", ORDER_EXCESS: "订单余款", UNASSIGNED_REFUND: "退款待归属核对" };

export function WorkbenchFundsRow({ item, returnSearch }: { item: WorkbenchFundsExceptionItem; returnSearch: string }) {
  return <article className="queue-row funds-exception-row">
    <div className="queue-primary">
      <strong>{sourceLabels[item.kind]}{item.roomLabel ? ` · ${item.roomLabel}` : ""}</strong>
      <span>{customerClue(item)}</span>
      <span className="funds-reference">{item.reference ?? item.billId ?? (item.orderId ? `订单编号：${item.orderId}` : "来源编号待核对")}</span>
      <span>{item.reason}</span>
    </div>
    <strong>{item.amountMinor === null ? "金额待核对" : formatMinor(item.amountMinor, "CNY")}</strong>
    <Link className="button button-secondary" to={item.orderId ? `/orders/${encodeURIComponent(item.orderId)}` : "/orders"}
      state={{ workbenchSearch: returnSearch, workbenchFundsHint: item }}>处理<span className="sr-only">：{sourceLabels[item.kind]} {item.reference ?? item.id}</span></Link>
  </article>;
}

export function WorkbenchFundsResults({ data, returnSearch, onNext, onFirst, hasCursor }: {
  data: WorkbenchFundsExceptionList; returnSearch: string; onNext: (cursor: string) => void; onFirst: () => void; hasCursor: boolean;
}) {
  return <>
    <p role="status">共 {data.total} 条资金待办 · 本页 {data.items.length} 条（不按住宿日期筛选）</p>
    {!data.enabled ? <p role="status">新资金能力已关闭；历史款项仍显示，处理权限以原订单页面为准。</p> : null}
    {data.items.map(item => <WorkbenchFundsRow key={item.id} item={item} returnSearch={returnSearch} />)}
    {!data.items.length ? <EmptyState title={hasCursor ? "本页暂无资金待办" : "暂无匹配的资金待办"} detail={hasCursor ? "数据可能已变化，请返回第一页重新查询。" : "已确认的客户留存款请在订单的资金视图中查看。"} /> : null}
    <div className="form-actions">
      {hasCursor ? <button type="button" className="button button-secondary" onClick={onFirst}>返回第一页</button> : null}
      {data.nextCursor ? <button type="button" className="button button-secondary" onClick={() => onNext(data.nextCursor!)}>下一页资金待办</button> : null}
    </div>
  </>;
}

// The parent keys this reader by property/search/page: old store data never renders in a new store.
export function WorkbenchFundsExceptions({ propertyId, query, cursor, returnSearch, refreshKey, onSearch, onNext, onFirst }: {
  propertyId: string; query: string; cursor: string; returnSearch: string; refreshKey: number;
  onSearch: (query: string) => void; onNext: (cursor: string) => void; onFirst: () => void;
}) {
  const [data, setData] = useState<WorkbenchFundsExceptionList>();
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState(query);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setData(undefined); setError(undefined);
    const timeout = window.setTimeout(() => controller.abort(new Error("资金待办读取超时，请重试")), 12_000);
    void api.workbenchFundsExceptions({ propertyId, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}), limit: "25" }, controller.signal)
      .then(result => { if (current) setData(result); })
      .catch(reason => { if (current) setError(controller.signal.aborted ? controller.signal.reason : reason); })
      .finally(() => window.clearTimeout(timeout));
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [propertyId, query, cursor, refreshKey, retry]);
  return <section className="workbench-funds" aria-label="资金异常">
    <h2>资金待办</h2>
    <form className="list-toolbar" onSubmit={event => { event.preventDefault(); onSearch(draft.trim()); }}>
      <label className="search-control"><span className="sr-only">搜索资金待办</span><input type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} placeholder="客户线索、房号或来源编号" /></label>
      <button className="button button-secondary" type="submit">查询</button>
    </form>
    <WorkbenchFundsReadState data={data} error={error} onRetry={() => setRetry(value => value + 1)} returnSearch={returnSearch} onNext={onNext} onFirst={onFirst} hasCursor={!!cursor} />
  </section>;
}

export function WorkbenchFundsReadState({ data, error, onRetry, ...navigation }: {
  data: WorkbenchFundsExceptionList | undefined; error: unknown; onRetry: () => void;
  returnSearch: string; onNext: (cursor: string) => void; onFirst: () => void; hasCursor: boolean;
}) {
  if (error) return <><InlineError context="read" error={error} title="资金待办未能载入，条数与金额暂不可用" /><button type="button" className="button button-secondary" onClick={onRetry}>重试资金待办</button></>;
  if (!data) return <LoadingBlock label="正在读取资金待办" />;
  return <WorkbenchFundsResults data={data} {...navigation} />;
}

export function WorkbenchFundsContext({ item }: { item: WorkbenchFundsExceptionItem }) {
  const [copyError, setCopyError] = useState(false);
  return <section className="detail-section" aria-label="工作台资金来源线索">
    <h2>工作台资金待办线索</h2>
    <p>以下是工作台带入的来源线索；最新金额与可操作额度以本页订单及原核对表单为准。</p>
    <p>{sourceLabels[item.kind]} · {item.amountMinor === null ? "金额待核对" : formatMinor(item.amountMinor, "CNY")} · {item.reason}</p>
    <p>{customerClue(item)}{item.roomLabel ? ` · ${item.roomLabel}` : ""}</p>
    {item.reference ? <p className="funds-reference">原来源编号：<code>{item.reference}</code> <button type="button" className="button button-secondary button-small" onClick={async () => {
      try { await navigator.clipboard.writeText(item.reference!); setCopyError(false); } catch { setCopyError(true); }
    }}>复制来源编号</button></p> : null}
    {item.billId ? <p className="funds-reference">账单编号：{item.billId}</p> : null}
    {copyError ? <p role="status">复制失败，请选中来源编号手动复制。</p> : null}
    <p>{item.kind === "UNALLOCATED_COLLECTION" && item.amountMinor !== null
      ? "请先核实付款人与订单的关系，再选择正确订单，使用原订单收款入口核对这笔收款；不会自动匹配或提交。"
      : "请在原页面核对资金事实；来源冻结或金额待核对时，不应继续分配或留存。无归属记录不应挂到无关订单。"}</p>
  </section>;
}
