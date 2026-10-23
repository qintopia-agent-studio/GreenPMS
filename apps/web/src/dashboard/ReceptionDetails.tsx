import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronUp } from "lucide-react";
import type { DashboardDetail } from "@qintopia/contracts";
import { api } from "../api";
import { errorMessage, LoadingBlock } from "../uiBasic";
import { useDashboardRead } from "./dashboard-state";

export function ReceptionDetails({ propertyId, query, metric, businessDate, asOf, onClose, read = api.dashboardDetails }: {
  propertyId: string; query: string; metric: "ARRIVAL" | "DEPARTURE"; businessDate: string; asOf: string;
  onClose: () => void; read?: typeof api.dashboardDetails;
}) {
  const [page, setPage] = useState(0);
  const title = metric === "ARRIVAL" ? "待到店明细" : "待离店明细";
  const parameters = new URLSearchParams(query);
  parameters.set("metric", metric); parameters.set("page", String(page)); parameters.set("asOf", asOf);
  const { data, error, isLoading, mutate } = useDashboardRead(`dashboard-details:${propertyId}:${parameters}`, signal => read(propertyId, parameters.toString(), signal));
  return <section className="dashboard-resident-people dashboard-reception-details" aria-label={title} aria-busy={isLoading}>
    <div className="dashboard-resident-group-heading"><div><h3>{title}</h3><p className="dashboard-muted">{businessDate}{data ? ` · ${data.total} 单` : ""} · 按订单展示</p></div><button type="button" className="dashboard-text-button" onClick={onClose}><ChevronUp size={14} aria-hidden="true" />收起明细</button></div>
    {error ? <div role="alert" className="dashboard-notice">{errorMessage(error)} <button type="button" className="button button-secondary" onClick={() => void mutate()}>重试</button></div> : null}
    {isLoading ? <LoadingBlock label="正在读取接待明细" /> : null}
    {data ? <>
      {data.changedSinceSummary ? <p className="dashboard-reception-note" role="status">明细已更新，可能与上方数量不同；可刷新数据核对。</p> : null}
      {data.items.length ? <ReceptionPeopleTable items={data.items} /> : <p className="dashboard-empty" role="status">{page === 0 ? `今天暂无${metric === "ARRIVAL" ? "待到店" : "待离店"}订单。` : "本页已无符合条件的订单，请返回上一页。"}</p>}
      {data.total > data.pageSize || page > 0 ? <div className="dashboard-pagination"><button className="button button-secondary" type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} 页</span><button className="button button-secondary" type="button" disabled={(page + 1) * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页</button></div> : null}
    </> : null}
  </section>;
}

export function ReceptionPeopleTable({ items }: { items: DashboardDetail[] }) {
  return <table className="dashboard-resident-table dashboard-reception-table">
    <thead><tr><th>住客</th><th>房间 / 床位</th><th>订单住期</th><th>当前状态 / 订单</th></tr></thead>
    <tbody>{items.map(item => {
      const stay = item.reception;
      return <tr key={item.id}>
        <td data-label="住客">{stay?.occupants.length ? stay.occupants.map((guest, index) => <div className="dashboard-reception-guest" key={index}><strong>{guest.name || "住客姓名待补充"}</strong><small>{guest.isPrimary ? "主住客" : "同行人"}</small></div>) : <span className="dashboard-muted">住客登记待补充</span>}</td>
        <td data-label="房间 / 床位"><strong>{stay?.roomCode || "房间待核对"}</strong>{stay?.buildingCode ? <small>{stay.buildingCode}</small> : null}</td>
        <td data-label="订单住期">{stay ? <><span>入住 {stay.arrivalDate}</span><small>离店 {stay.departureDate}</small></> : <span className="dashboard-muted">住宿日期待核对</span>}</td>
        <td data-label="当前状态 / 订单"><span>{stay?.status === "RESERVED" ? "已预订 · 待入住" : stay?.status === "CHECKED_IN" ? "在住 · 待离店" : "状态待核对"}</span>{item.orderId ? <Link className="dashboard-resident-link" to={`/orders/${encodeURIComponent(item.orderId)}`}>查看订单<ArrowRight size={12} aria-hidden="true" /></Link> : null}</td>
      </tr>;
    })}</tbody>
  </table>;
}
