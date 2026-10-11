import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, X } from "lucide-react";
import type { DashboardMetric } from "@qintopia/contracts";
import { api } from "../api";
import { errorMessage, LoadingBlock } from "../uiBasic";
import { metricLabels, money, useDashboardRead } from "./dashboard-state";

export function DashboardDetails({ propertyId, query, metric, asOf, onClose }: { propertyId: string; query: string; metric: DashboardMetric; asOf: string; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const parameters = new URLSearchParams(query);
  parameters.set("metric", metric); parameters.set("page", String(page)); parameters.set("asOf", asOf);
  const { data, error, isLoading, mutate } = useDashboardRead(`dashboard-details:${propertyId}:${parameters}`, signal => api.dashboardDetails(propertyId, parameters.toString(), signal));
  return <section className="dashboard-panel dashboard-details" aria-labelledby="dashboard-detail-title">
    <div className="dashboard-section-heading"><div><h2 id="dashboard-detail-title" tabIndex={-1} ref={heading}>{metricLabels[metric]} · 组成明细</h2><p>只读查询 · 明细重新读取，不锁定原快照</p></div><button type="button" className="button button-secondary" onClick={onClose}><X size={16} aria-hidden="true" />关闭</button></div>
    {error ? <div role="alert" className="dashboard-notice">{errorMessage(error)} <button type="button" className="button button-secondary" onClick={() => void mutate()}>重试</button></div> : null}
    {isLoading ? <LoadingBlock label="正在读取组成明细" /> : null}
    {data ? <>
      <p className="dashboard-muted">{data.total} 条 · 本次读取 {new Date(data.asOf).toLocaleString("zh-CN")}{data.changedSinceSummary ? " · 已重新读取；数据可能变化，请刷新概览后核对。" : ""}</p>
      <div className="dashboard-table-scroll"><table><thead><tr><th>日期 / 事实</th><th>数量 / 金额</th><th>说明</th><th>原业务记录</th></tr></thead><tbody>
        {data.items.map(item => <tr key={item.id}><td>{item.date}<small>{item.label}</small>{item.registeredAt ? <small>登记：{new Date(item.registeredAt).toLocaleString("zh-CN")}</small> : null}{item.businessDate ? <small>原业务日期：{item.businessDate}</small> : null}</td><td>{item.amountMinor !== null ? money(item.amountMinor, item.currency ?? "CNY") : `${item.units ?? "—"}`}</td><td>{item.reason}</td><td>{item.orderId ? <Link to={`/orders/${encodeURIComponent(item.orderId)}`}>查看订单 <ArrowUpRight size={14} aria-hidden="true" /></Link> : item.memberId ? <Link to={`/members?memberId=${encodeURIComponent(item.memberId)}`}>查看会员 <ArrowUpRight size={14} aria-hidden="true" /></Link> : <Link to="/">核对房态</Link>}</td></tr>)}
        {!data.items.length ? <tr><td colSpan={4}>该范围内没有符合条件的记录。</td></tr> : null}
      </tbody></table></div>
      <div className="dashboard-pagination"><button className="button button-secondary" type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page + 1} 页</span><button className="button button-secondary" type="button" disabled={(page + 1) * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页</button></div>
    </> : null}
  </section>;
}
