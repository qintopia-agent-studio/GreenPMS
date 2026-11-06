import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { WorkbenchExceptionGroup } from "@qintopia/contracts";
import { api } from "./api";
import { businessStatusLabel, EmptyState, formatDate, formatMoney, InlineError, LoadingBlock, StatusBadge } from "./uiBasic";
import { createWorkbenchExceptionsReader, type ReadWorkbenchExceptions, type WorkbenchExceptionsState } from "./workbenchExceptionsReader";
import "./workbenchExceptions.css";

export function useWorkbenchExceptions(propertyId: string, refreshToken: number, group: WorkbenchExceptionGroup, read: ReadWorkbenchExceptions = api.workbenchExceptions) {
  const reader = useMemo(() => createWorkbenchExceptionsReader(propertyId, read, 12_000, group), [propertyId, group, read]);
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    reader.refresh();
    return reader.cancel;
  }, [reader, refreshToken]);
  return { ...reader, state };
}

export function WorkbenchExceptionsQueue({ state, retry, nextPage, firstPage, group }: {
  group: WorkbenchExceptionGroup;
  state: WorkbenchExceptionsState;
  retry: () => void;
  nextPage: () => void;
  firstPage: () => void;
}) {
  const { data, loading, error, page } = state;
  const business = group === "BUSINESS";
  return <section className="workbench-exceptions-queue" aria-labelledby={`exception-heading-${group}`}>
    <div className="queue-exceptions-context">
      <div className="exception-section-heading"><h3 id={`exception-heading-${group}`}>{business ? "入住、退房和房间安排" : "订单款项"}</h3>{data ? <span>{data.totalOrders} 个订单</span> : null}</div>
      <p>{business ? "查看还没处理完的入住、退房和房间问题。" : "查看订单里的欠款、多收款和待核对退款。"}未处理的问题一直保留，不随上方日期切换。</p>
      {data ? <small>按今天（{data.businessDate}）查看 · 更新于 <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString("zh-CN", { hour12: false })}</time></small> : null}
    </div>
    {loading ? <LoadingBlock label="正在载入当前异常事项" /> : error ? <div className="queue-exceptions-feedback">
      <InlineError context="read" error={error} title="暂时看不到这些订单" />
      <p>列表没有加载出来，还不能确定有哪些问题。</p>
      <button className="button button-secondary" type="button" onClick={retry}>重新加载</button>
      {page > 1 ? <button className="button button-secondary" type="button" onClick={firstPage}>回到首页</button> : null}
    </div> : data ? <>
      {data.items.length === 0 ? <EmptyState title={page > 1 || data.totalOrders > 0 ? "这一页没有订单了" : business ? "目前没有业务异常" : "目前没有订单款项问题"} detail={data.totalOrders === 0 ? business ? "没有需要处理的入住、退房或房间问题。" : "企微收退款的记录请继续看下方清单。" : "清单可能已经更新，请回到首页查看。"} /> : data.items.map((item) => <article className="queue-row queue-exception-row" key={item.orderId}>
        <div className="queue-icon" aria-hidden="true"><AlertTriangle size={19} /></div>
        <div className="queue-primary">
          <strong>{item.guestName}</strong>
          <span>{item.unitLabel ?? "房间信息不完整"} · {formatDate(item.arrivalDate)} 至 {formatDate(item.departureDate)}</span>
          <ul className="queue-exception-reasons">{item.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}>
            <span>{reason.message}</span>{reason.amount ? <strong>{formatMoney(reason.amount)}</strong> : null}
          </li>)}</ul>
        </div>
        <StatusBadge value={item.orderStatus} label={businessStatusLabel(item.orderStatus)} />
        <div className="queue-actions"><Link className="button button-secondary" to={item.orderHref} aria-label={`查看${item.guestName}的异常订单`}>查看订单<ChevronRight aria-hidden="true" size={16} /></Link></div>
      </article>)}
      <div className="queue-exceptions-pagination" aria-label="异常分页">
        <span>第 {page} 页 · 本页 {data.items.length} 个订单 / 共 {data.totalOrders} 个订单</span>
        <div><button className="button button-secondary button-small" type="button" onClick={firstPage} disabled={page === 1}>回到首页</button><button className="button button-secondary button-small" type="button" onClick={nextPage} disabled={!data.nextCursor}>下一页</button></div>
      </div>
    </> : null}
  </section>;
}
