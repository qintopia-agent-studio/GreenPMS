import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { businessStatusLabel, EmptyState, formatDate, formatMoney, InlineError, LoadingBlock, StatusBadge } from "./uiBasic";
import { createWorkbenchExceptionsReader, type ReadWorkbenchExceptions, type WorkbenchExceptionsState } from "./workbenchExceptionsReader";

export function useWorkbenchExceptions(propertyId: string, refreshToken: number, read: ReadWorkbenchExceptions = api.workbenchExceptions) {
  const reader = useMemo(() => createWorkbenchExceptionsReader(propertyId, read), [propertyId, read]);
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    reader.refresh();
    return reader.cancel;
  }, [reader, refreshToken]);
  return { ...reader, state };
}

export function WorkbenchExceptionsQueue({ state, retry, nextPage, firstPage }: {
  state: WorkbenchExceptionsState;
  retry: () => void;
  nextPage: () => void;
  firstPage: () => void;
}) {
  const { data, loading, error, page } = state;
  return <>
    <div className="queue-exceptions-context">
      <strong>当前待处理异常{data ? ` · ${data.totalOrders} 笔订单` : ""}</strong>
      <p>{data ? `按门店当前营业日 ${data.businessDate} 核对。` : "按门店当前营业日核对。"}不随上方浏览日期变化；同一订单的多个原因合并展示。</p>
      {data ? <small>查询时间：<time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString("zh-CN", { hour12: false })}</time> · 资金异常依据 PMS 已登记记录。</small> : null}
    </div>
    {loading ? <LoadingBlock label="正在载入当前异常事项" /> : error ? <div className="queue-exceptions-feedback">
      <InlineError context="read" error={error} title="无法载入异常事项" />
      <p>当前异常数量未知，请重试核对。</p>
      <button className="button button-secondary" type="button" onClick={retry}>重新载入异常</button>
      {page > 1 ? <button className="button button-secondary" type="button" onClick={firstPage}>回到首页</button> : null}
    </div> : data ? <>
      {data.items.length === 0 ? <EmptyState title={page > 1 ? "本页暂无异常事项" : data.totalOrders === 0 ? "当前没有待处理异常" : "本页暂无异常事项"} detail={data.totalOrders === 0 ? "取消或已标记未到的订单，没有资金、库存或状态遗留时不计入异常。" : "异常清单可能已更新，请回到首页重新核对。"} /> : data.items.map((item) => <article className="queue-row queue-exception-row" key={item.orderId}>
        <div className="queue-icon" aria-hidden="true"><AlertTriangle size={19} /></div>
        <div className="queue-primary">
          <strong>{item.guestName}</strong>
          <span>{item.unitLabel ?? "房间待核对"} · {formatDate(item.arrivalDate)} 至 {formatDate(item.departureDate)}</span>
          <ul className="queue-exception-reasons">{item.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}>
            <span>{reason.message}</span>{reason.amount ? <strong>{formatMoney(reason.amount)}</strong> : null}
          </li>)}</ul>
        </div>
        <StatusBadge value={item.orderStatus} label={businessStatusLabel(item.orderStatus)} />
        <div className="queue-actions"><Link className="button button-secondary" to={item.orderHref} aria-label={`查看${item.guestName}的异常订单`}>查看订单<ChevronRight aria-hidden="true" size={16} /></Link></div>
      </article>)}
      <div className="queue-exceptions-pagination" aria-label="异常分页">
        <span>第 {page} 页 · 本页 {data.items.length} 笔 / 当前共 {data.totalOrders} 笔</span>
        <div><button className="button button-secondary button-small" type="button" onClick={firstPage} disabled={page === 1}>回到首页</button><button className="button button-secondary button-small" type="button" onClick={nextPage} disabled={!data.nextCursor}>下一页</button></div>
      </div>
    </> : null}
  </>;
}
