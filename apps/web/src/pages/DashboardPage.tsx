import { lazy, Suspense, useState } from "react";
import { SWRConfig } from "swr";
import { ArrowRight, ChartNoAxesCombined, Info, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { dashboardSources, type DashboardMetric } from "@qintopia/contracts";
import { api } from "../api";
import { useWorkspace } from "../session";
import { errorMessage, LoadingBlock } from "../uiBasic";
import { DashboardDetails } from "../dashboard/DashboardDetails";
import { metricLabels, money, shiftDate, sourceLabels, useDashboardRead } from "../dashboard/dashboard-state";
import "../dashboard/dashboard.css";

const DashboardCharts = lazy(() => import("../dashboard/DashboardCharts").then(module => ({ default: module.DashboardCharts })));
const swrConfig = { provider: () => new Map() };

export function DashboardPage() {
  const { propertyId, principal } = useWorkspace();
  return <SWRConfig key={`${principal.subjectId}:${propertyId}`} value={swrConfig}><DashboardWorkspace propertyId={propertyId} /></SWRConfig>;
}
function DashboardWorkspace({ propertyId }: { propertyId: string }) {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [preset, setPreset] = useState("30");
  const [futureDays, setFutureDays] = useState(14);
  const [building, setBuilding] = useState("");
  const [roomType, setRoomType] = useState("");
  const [source, setSource] = useState("");
  const [detail, setDetail] = useState<DashboardMetric | null>(null);
  const [custom, setCustom] = useState({ from: "", to: "" });
  const query = new URLSearchParams({ ...(range ?? {}), futureDays: String(futureDays), ...(building ? { building } : {}), ...(roomType ? { roomType } : {}), ...(source ? { source } : {}) }).toString();
  const { data, error, isLoading, isValidating, mutate } = useDashboardRead(`dashboard:${propertyId}:${query}`, signal => api.dashboard(propertyId, query, signal), 60_000);
  function changePreset(value: string) {
    setPreset(value); setDetail(null);
    if (!data || value === "custom") return;
    const to = shiftDate(data.businessDate, -1);
    setRange({ from: value === "month" ? `${data.businessDate.slice(0, 7)}-01` : shiftDate(data.businessDate, -Number(value)), to });
  }
  const mainMoney = data?.money.find(item => item.currency === data.currency);
  const confirmedQuery = new URLSearchParams(query);
  if (data) { confirmedQuery.set("from", data.range.from); confirmedQuery.set("to", data.range.to); }
  const openDetail = (metric: DashboardMetric) => setDetail(metric);
  return <div className="dashboard" data-testid="dashboard-page">
    <header className="dashboard-heading"><div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>经营概览</h1><p className="dashboard-muted">从住宿到资金，看清每一笔经营事实。</p></div><button type="button" className="button button-secondary" disabled={isValidating} onClick={() => void mutate()}><RefreshCw size={16} aria-hidden="true" />{isValidating ? "更新中" : "刷新数据"}</button></header>
    <div className="dashboard-context"><span><ChartNoAxesCombined size={15} aria-hidden="true" />当前门店 · 只读概览</span><span>{data ? `${data.timezone} · 更新于 ${new Date(data.asOf).toLocaleTimeString("zh-CN", { timeZone: data.timezone })}` : "等待服务器数据"}</span></div>
    {error ? <div className="dashboard-notice" role="alert"><strong>{data ? "数据已过期，刷新失败" : "经营数据暂不可用"}</strong><p>{errorMessage(error)}。不会将失败数据显示为零。</p><button className="button button-secondary" type="button" onClick={() => void mutate()}>重新读取</button><button className="button button-secondary" type="button" onClick={() => { setRange(null); setPreset("30"); setBuilding(""); setRoomType(""); setSource(""); setDetail(null); }}>恢复近30天</button></div> : null}
    {isLoading ? <LoadingBlock label="正在汇总住宿、资金与可售库存" /> : null}
    {data ? <>
      <section aria-labelledby="current-title"><div className="dashboard-section-heading"><h2 id="current-title">当前现场</h2><span className="dashboard-muted">{data.businessDate} · 不随历史日期变化</span></div><div className="dashboard-current-grid">
        <button type="button" className="dashboard-current-card" onClick={() => openDetail("IN_HOUSE")}><span>当前在住人数</span><strong>{data.current.paidGuests + data.current.freeGuests}<small> 人</small></strong><small>付费 {data.current.paidGuests} / 免费 {data.current.freeGuests}{data.current.guestReviewOrders ? ` · ${data.current.guestReviewOrders} 单人数待核对` : ""}</small></button>
        <div className="dashboard-current-card"><span>今日待办</span><div className="dashboard-today"><button type="button" onClick={() => openDetail("ARRIVAL")}><strong>{data.current.arrivals}</strong><small>待到店</small></button><button type="button" onClick={() => openDetail("DEPARTURE")}><strong>{data.current.departures}</strong><small>待离店</small></button></div></div>
        <button type="button" className="dashboard-current-card" onClick={() => openDetail("DEBT")}><span>住宿欠款余额</span>{data.current.debts.map(item => <strong key={item.currency}>{money(item.amountMinor, item.currency)}<small> / {item.count} 单</small></strong>)}<small>逐单正差额 · 不以多收抵欠款</small></button>
        <button type="button" className="dashboard-current-card" onClick={() => openDetail("RETAINED")}><span>客户留存待用</span>{data.current.retained.map(item => <strong key={item.currency}>{money(item.amountMinor, item.currency)}<small> / {item.count} 笔</small></strong>)}<small>客户资金归属 · 不计新增收款</small></button>
      </div></section>
      <section aria-labelledby="history-title"><div className="dashboard-section-heading dashboard-history-heading"><div><h2 id="history-title">历史经营</h2><p>{data.range.from} 至 {data.range.to} · 完整营业日</p></div><div className="dashboard-range-tabs" role="group" aria-label="历史日期范围">{[["7", "近7天"], ["30", "近30天"], ["month", "本月至昨日"], ["custom", "自定义"]].map(([value, label]) => <button type="button" key={value} aria-pressed={preset === value} disabled={value === "month" && data.businessDate.endsWith("-01")} onClick={() => changePreset(value!)}>{label}</button>)}</div></div>
        {preset === "custom" ? <form className="dashboard-filters" onSubmit={event => { event.preventDefault(); setRange(custom); setDetail(null); }}><label>开始日期<input type="date" required value={custom.from} max={custom.to || shiftDate(data.businessDate, -1)} onChange={event => setCustom({ ...custom, from: event.target.value })} /></label><label>结束日期<input type="date" required value={custom.to} min={custom.from} max={shiftDate(data.businessDate, -1)} onChange={event => setCustom({ ...custom, to: event.target.value })} /></label><button type="submit" className="button button-primary">应用日期</button><span className="dashboard-muted">最多366天</span></form> : null}
        <details className="dashboard-definitions"><summary><Info size={15} aria-hidden="true" />口径说明与数据质量</summary><p>经营入住率仅含已履约付费住宿（含会员权益），不含过去预订、取消及未到。整房计1，可拆床房整间按可售床数换算；免费占用单列。住宿含入住日、不含离店日。</p><p>资金按 PMS 登记时间，不是银行到账、营业收入或利润。内部划转和转会员不重复计入；更正不是退款。未知资金存在时隐藏净额。</p><p>容量：{data.history.reason}。环比对照 {data.previousRange.from} 至 {data.previousRange.to}。来源筛选只改变住宿分子，不缩减房源容量。</p><p>在住人数按订单内实际住宿人关系去重，不代表跨订单独立访客数。统计定义 {data.definitionVersion}。</p>{data.warnings.map(warning => <p key={warning} className="dashboard-warning">{warning}</p>)}</details>
        <div className="dashboard-filters"><label>楼栋<select value={building} onChange={event => { setBuilding(event.target.value); setDetail(null); }}><option value="">全部楼栋</option>{data.filters.buildings.map(value => <option key={value}>{value}</option>)}</select></label><label>房型<select value={roomType} onChange={event => { setRoomType(event.target.value); setDetail(null); }}><option value="">全部房型</option>{data.filters.roomTypes.map(value => <option key={value}>{value}</option>)}</select></label><label>住宿来源<select value={source} onChange={event => { setSource(event.target.value); setDetail(null); }}><option value="">全部来源</option>{dashboardSources.map(value => <option value={value} key={value}>{sourceLabels[value]}</option>)}</select></label><p className="dashboard-muted">仅筛选住宿分析，不影响门店资金、当前现场和未来库存。</p></div>
        <div className="dashboard-kpi-grid"><div className="dashboard-kpi dashboard-kpi-primary"><span>经营入住率</span><strong>{data.history.occupancyRate === null ? "—" : `${data.history.occupancyRate.toFixed(1)}%`}</strong><small>{data.history.occupancyRate === null ? "容量或住宿事实不可比" : "按当前目录口径"}</small><p>{data.occupancyChangePoints === null ? "环比 — · 缺少可比基础" : `较上期 ${data.occupancyChangePoints >= 0 ? "+" : ""}${data.occupancyChangePoints.toFixed(1)} 个百分点`}</p></div>
          <button className="dashboard-kpi" type="button" onClick={() => openDetail("PAID")}><span>付费住宿单元夜 <ArrowRight size={14} aria-hidden="true" /></span><strong>{data.history.paidUnitNights.toLocaleString("zh-CN")}</strong><small>{data.history.quality === "COMPLETE" ? "已核对住宿时间线" : `可核对部分 · ${data.history.reviewCount} 单待核对`}</small><p>免费占用 {data.history.freeUnitNights} 单元夜</p></button>
          <button className="dashboard-kpi" type="button" onClick={() => openDetail("MONEY")}><span>收退款登记净额 <ArrowRight size={14} aria-hidden="true" /></span><strong>{money(mainMoney?.netMinor, data.currency)}</strong><small>收款 − 退款 + 更正</small><p>非财务收入 · {data.currency}</p></button>
          <button className="dashboard-kpi" type="button" onClick={() => openDetail("MONEY")}><span>登记退款额 <ArrowRight size={14} aria-hidden="true" /></span><strong>{money(mainMoney?.refundedMinor, data.currency)}</strong><small>更正 {money(mainMoney?.correctedMinor, data.currency)}</small><p>不含内部资金归属转换</p></button></div>
        {data.money.some(item => item.reviewCount > 0) ? <div role="status" className="dashboard-notice">本期存在来源待核对的资金，净额暂不展示。已分类收款、退款和更正仅代表可核对部分。<button type="button" className="button button-secondary" onClick={() => openDetail("REVIEW")}>查看待核对事实</button></div> : null}
        {data.money.filter(item => item.currency !== data.currency).map(item => <p key={item.currency} className="dashboard-notice">其他币种独立统计：{item.currency} 登记净额 {money(item.netMinor, item.currency)}，不与 {data.currency} 相加。</p>)}
        <Suspense fallback={<LoadingBlock label="正在加载趋势图" />}><DashboardCharts data={data} /></Suspense>
        <div className="dashboard-chart-grid"><section className="dashboard-panel"><div className="dashboard-section-heading"><div><h3>楼栋与房型表现</h3><p>按每段有效住宿归属，不按最后房间归整单</p></div></div><div className="dashboard-table-scroll"><table><thead><tr><th>楼栋 / 房型</th><th>付费夜</th><th>免费夜</th><th>容量夜</th><th>入住率</th></tr></thead><tbody>{data.breakdown.map(item => <tr key={`${item.building}:${item.roomType}`}><td>{item.building}<small>{item.roomType}</small></td><td>{item.paidUnitNights}</td><td>{item.freeUnitNights}</td><td>{item.capacityUnitNights ?? "—"}</td><td>{item.occupancyRate === null ? "—" : `${item.occupancyRate.toFixed(1)}%`}</td></tr>)}{!data.breakdown.length ? <tr><td colSpan={5}>当前筛选没有住宿或房源记录。</td></tr> : null}</tbody><tfoot><tr><th>合计</th><td>{data.history.paidUnitNights}</td><td>{data.history.freeUnitNights}</td><td>{data.history.capacityUnitNights ?? "—"}</td><td>{data.history.occupancyRate === null ? "—" : `${data.history.occupancyRate.toFixed(1)}%`}</td></tr></tfoot></table></div></section>
          <section className="dashboard-panel"><div className="dashboard-section-heading"><div><h3>住宿来源结构</h3><p>住宿单元夜 · 不是收入贡献</p></div></div><div className="dashboard-source-list">{data.sources.map(item => <div className="dashboard-source" key={item.source}><span>{sourceLabels[item.source]}</span><div className="dashboard-source-track"><div style={{ width: `${item.unitNights / Math.max(1, ...data.sources.map(row => row.unitNights)) * 100}%` }} /></div><strong>{item.unitNights}</strong></div>)}</div><button className="dashboard-text-button" type="button" onClick={() => openDetail("FREE")}>查看免费占用明细 <ArrowRight size={14} aria-hidden="true" /></button></section></div>
      </section>
      <section className="dashboard-panel" aria-labelledby="future-title"><div className="dashboard-section-heading"><div><h2 id="future-title">未来可售库存</h2><p>固定从 {data.businessDate} 起 · 已订占用，不是入住预测</p></div><label className="dashboard-future-select"><span className="sr-only">未来天数</span><select value={futureDays} onChange={event => setFutureDays(Number(event.target.value))}><option value={14}>未来14天</option><option value={30}>未来30天</option></select></label></div><div className="dashboard-future-grid">{data.future.map(day => <div className={`dashboard-future-day ${day.quality !== "COMPLETE" ? "dashboard-future-review" : ""}`} key={day.date}><span>{day.date.slice(5)}</span><strong>{day.availableRooms === null || day.availableBeds === null ? "—" : day.availableRooms + day.availableBeds}<small> 可售</small></strong><div className="dashboard-inventory-bar" aria-hidden="true"><i style={{ width: `${day.paid / Math.max(day.capacity, 1) * 100}%` }} /><i style={{ width: `${day.free / Math.max(day.capacity, 1) * 100}%` }} /><i style={{ width: `${day.maintenance / Math.max(day.capacity, 1) * 100}%` }} /></div><small>{day.availableRooms ?? "—"}间 / {day.availableBeds ?? "—"}床</small><small>已订 {day.paid} · 免费 {day.free}</small><small>维修 {day.maintenance} · 待核对 {day.review}</small></div>)}</div><p className="dashboard-footnote">当天前客待退不等于今晚不可售；能预订不代表此刻能办理后客入住。<Link to="/">去房态核对 <ArrowRight size={14} aria-hidden="true" /></Link></p></section>
      <section className="dashboard-panel" aria-labelledby="attention-title"><div className="dashboard-section-heading"><div><h2 id="attention-title">需关注事项</h2><p>在原业务页面核对和处理，概览不办理业务</p></div><Link to="/today">前往工作台 <ArrowRight size={14} aria-hidden="true" /></Link></div><div className="dashboard-attention">{(["OVERDUE", "DEBT", "RETAINED", "REVIEW"] as const).map(metric => <button type="button" key={metric} onClick={() => openDetail(metric)}><span>{metricLabels[metric]}</span><strong>{metric === "OVERDUE" ? data.current.overdue : metric === "DEBT" ? data.current.debts.reduce((n, row) => n + row.count, 0) : metric === "RETAINED" ? data.current.retained.reduce((n, row) => n + row.count, 0) : data.history.reviewCount + data.money.reduce((n, row) => n + row.reviewCount, 0)}</strong><ArrowRight size={16} aria-hidden="true" /></button>)}</div></section>
      {detail ? <DashboardDetails key={`${detail}:${confirmedQuery}`} propertyId={propertyId} query={confirmedQuery.toString()} metric={detail} asOf={data.asOf} onClose={() => setDetail(null)} /> : null}
      <footer className="dashboard-footer">数据来自 PMS 原始业务事实 · 摘要使用同一只读快照 · 点击指标可核对组成明细</footer>
    </> : null}
  </div>;
}
