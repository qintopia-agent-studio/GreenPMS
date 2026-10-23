import { useRef, useState } from "react";
import { SWRConfig } from "swr";
import { CalendarDays, RefreshCw } from "lucide-react";
import type { DashboardMetric } from "@qintopia/contracts";
import { api } from "../api";
import { useWorkspace } from "../session";
import { errorMessage, LoadingBlock } from "../uiBasic";
import { CurrentScene, CommunityPanels } from "../dashboard/CommunityPanels";
import { ResidenceChanges } from "../dashboard/ResidenceChanges";
import { ResourcePanels } from "../dashboard/ResourcePanels";
import { DashboardDetails } from "../dashboard/DashboardDetails";
import { ReceptionDetails } from "../dashboard/ReceptionDetails";
import { dashboardPresetRange, shiftDate, useDashboardRead } from "../dashboard/dashboard-state";
import "../dashboard/dashboard.css";

const swrConfig = { provider: () => new Map() };
export function DashboardPage() {
  const { propertyId, principal } = useWorkspace();
  return <SWRConfig key={`${principal.subjectId}:${propertyId}`} value={swrConfig}><DashboardWorkspace propertyId={propertyId} /></SWRConfig>;
}

export function DashboardWorkspace({ propertyId, read = api.dashboard, readDetails = api.dashboardDetails }: {
  propertyId: string; read?: typeof api.dashboard; readDetails?: typeof api.dashboardDetails;
}) {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [preset, setPreset] = useState("30");
  const [futureDays, setFutureDays] = useState(14);
  const [resourceView, setResourceView] = useState("money");
  const [filters, setFilters] = useState({ building: "", roomType: "", source: "" });
  const [detail, setDetail] = useState<DashboardMetric | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const [custom, setCustom] = useState({ from: "", to: "" });
  const query = new URLSearchParams({ ...(range ?? {}), futureDays: String(futureDays), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) }).toString();
  const { data, error, isLoading, isValidating, mutate } = useDashboardRead(`dashboard:${propertyId}:${query}`, signal => read(propertyId, query, signal), 60_000);
  function changePreset(value: string) {
    if (!data) return;
    setDetail(null);
    if (value === "custom") { setCustom(data.range); setPreset(value); return; }
    const next = dashboardPresetRange(value as "7" | "30" | "month", data.businessDate);
    if (next) { setPreset(value); setRange(next); }
  }
  function openDetail(metric: DashboardMetric) {
    detailTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(current => (metric === "ARRIVAL" || metric === "DEPARTURE") && current === metric ? null : metric);
  }
  function closeDetail() {
    setDetail(null);
    requestAnimationFrame(() => detailTrigger.current?.isConnected && detailTrigger.current.focus({ preventScroll: detail === "ARRIVAL" || detail === "DEPARTURE" }));
  }
  const confirmedQuery = new URLSearchParams(query);
  if (data) { confirmedQuery.set("from", data.range.from); confirmedQuery.set("to", data.range.to); }
  const receptionMetric = detail === "ARRIVAL" || detail === "DEPARTURE" ? detail : null;
  return <div className="dashboard" data-testid="dashboard-page" aria-busy={isLoading}>
    <header className="dashboard-heading">
      <div><p className="eyebrow">经营概览 / 社区运营</p><h1>共居经营看板</h1><p className="dashboard-muted">看见社区里的人，跟进每一段居住。</p></div>
      <div className="dashboard-refresh"><span className="dashboard-muted">{data ? `${new Date(data.asOf).toLocaleTimeString("zh-CN", { timeZone: data.timezone, hour: "2-digit", minute: "2-digit" })} 更新 · 只读` : "等待门店数据"}</span><button type="button" className="button button-secondary" disabled={isValidating} onClick={() => void mutate()}><RefreshCw size={15} aria-hidden="true" />{isValidating ? "更新中" : "刷新数据"}</button></div>
    </header>
    {error ? <div className="dashboard-notice" role="alert"><strong>{data ? "刷新失败，以下为上次读取的数据" : "经营数据暂不可用"}</strong><p>{errorMessage(error)}。请求失败不是零，也不是没有记录。</p><button className="button button-secondary" onClick={() => void mutate()}>重新读取</button><button className="button button-secondary" onClick={() => { setRange(null); setPreset("30"); setFilters({ building: "", roomType: "", source: "" }); setDetail(null); }}>恢复近30天</button></div> : null}
    {isLoading ? <LoadingBlock label="正在读取所选范围，不显示上一范围的数据" /> : null}
    {data ? <>
      <CurrentScene data={data} onDetail={openDetail} activeReception={receptionMetric} receptionDetails={receptionMetric ? <ReceptionDetails key={`${receptionMetric}:${confirmedQuery}`} propertyId={propertyId} query={confirmedQuery.toString()} metric={receptionMetric} businessDate={data.businessDate} asOf={data.asOf} onClose={closeDetail} read={readDetails} /> : null} />
      <section className="dashboard-period" aria-label="历史统计区间">
        <div className="dashboard-period-label"><CalendarDays size={17} aria-hidden="true" /><div><strong>历史统计区间</strong><p>{data.range.from} — {data.range.to}</p></div></div>
        <div className="dashboard-range-tabs" role="group" aria-label="历史日期范围">{[["7", "近7天"], ["30", "近30天"], ["month", "本月至昨日"], ["custom", "自定义"]].map(([value, label]) => <button type="button" key={value} disabled={value === "month" && data.businessDate.endsWith("-01")} aria-pressed={preset === value} onClick={() => changePreset(value!)}>{label}</button>)}</div>
        {preset === "custom" ? <form className="dashboard-filters dashboard-custom" onSubmit={event => { event.preventDefault(); setRange(custom); setDetail(null); }}><label>开始日期<input type="date" required value={custom.from} max={custom.to || shiftDate(data.businessDate, -1)} onChange={e => setCustom({ ...custom, from: e.target.value })} /></label><label>结束日期<input type="date" required value={custom.to} min={custom.from} max={shiftDate(data.businessDate, -1)} onChange={e => setCustom({ ...custom, to: e.target.value })} /></label><button type="submit" className="button button-primary">应用日期</button><span className="dashboard-muted">1–366个完整营业日</span></form> : null}
      </section>
      <div className="community-history-grid" key={`${propertyId}:${data.range.from}:${data.range.to}`}>
        <CommunityPanels data={data} />
        <ResidenceChanges data={data} />
      </div>
      <ResourcePanels data={data} view={resourceView} onView={setResourceView} futureDays={futureDays} onFutureDays={value => { setFutureDays(value); setDetail(null); }} filters={filters} onFilters={value => { setFilters(value); setDetail(null); }} onDetail={openDetail} />
      {detail && !receptionMetric ? <DashboardDetails key={`${detail}:${confirmedQuery}`} propertyId={propertyId} query={confirmedQuery.toString()} metric={detail} asOf={data.asOf} onClose={closeDetail} read={readDetails} /> : null}
      <details className="dashboard-definitions"><summary>统计依据与待核对资料</summary><p>{data.community.identityApproximate ? "人数按昵称优先、姓名辅助同店跨单近似去重。" : "人数按实际登记住客的稳定身份同店跨单去重。"}不是订单数或销售单元。当前、历史区间、未来已订三个时间范围分别展示。</p><p>正常应收费住宿包含会员权益与欠款订单；免费单列。入住日计入、离店日不计入。经营人数、入住率、住宿量和容量只计算“计入经营住宿统计”的房源；被排除房源仍保留房态、订单和真实收付款，经营销售额、欠款和留存沿用原资金口径。经营入住率的分母不扣除维修、免费或已有占用。</p><p>{data.history.reason}。环比范围：{data.previousRange.from} 至 {data.previousRange.to}。定义版本：{data.definitionVersion}。</p>{[...data.warnings, ...data.community.reasons].map((reason, i) => <p key={i}>{reason}</p>)}<button className="dashboard-text-button" onClick={() => openDetail("REVIEW")}>打开待核对事实</button></details>
      <footer className="dashboard-footer">PMS 原始业务事实 · {data.timezone} · 看板只读，业务处理请回到原订单</footer>
    </> : null}
  </div>;
}
