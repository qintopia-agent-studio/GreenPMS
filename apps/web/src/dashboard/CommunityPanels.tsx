import { displayedCommunityDay, displayedCommunityTrend, registrationExplanation } from "./community-display";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Users, LogIn, LogOut } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CommunityDay, DashboardMetric, DashboardResponse } from "@qintopia/contracts";
import { DashboardHint } from "./DashboardHint";
import { money } from "./dashboard-state";

export const chartAxis = { tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false, axisLine: false };
export const chartTooltip = { contentStyle: { border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", background: "var(--surface)", fontSize: 12 } };
const freeCount = (day: CommunityDay) => day.volunteer + day.reception + day.otherFree;
export function Count({ value, reason, unit = "人" }: { value: number | null; reason: string; unit?: string }) {
  return <>{value === null ? <>— <DashboardHint label="查看缺项原因" text={reason} /></> : value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}<small>{unit}</small></>;
}
export function CurrentScene({ data, onDetail }: { data: DashboardResponse; onDetail: (metric: DashboardMetric) => void }) {
  return <section className="dashboard-current-scene" aria-labelledby="current-scene-title">
    <div className="dashboard-section-heading"><h2 id="current-scene-title">当前现场</h2><span className="dashboard-muted">{data.businessDate} · 不随历史日期变化</span></div>
    <CommunitySnapshot data={data} onDetail={onDetail} />
    <div className="dashboard-current-balances">
      <button type="button" className="dashboard-current-card" onClick={() => onDetail("TODAY_ORDERS")}><span>今日新增订单 <ArrowRight size={13} aria-hidden="true" /></span><strong>{data.current.todayOrders}<small> 单</small></strong><small>今天新建的住宿订单 · 含补录</small></button>
      {data.current.todaySales ? <button type="button" className="dashboard-current-card" onClick={()=>onDetail("TODAY_SALES")}><span>今日经营销售额 <ArrowRight size={13} aria-hidden="true" /></span>{data.current.todaySales.enabled&&data.current.todaySales.complete?data.current.todaySales.totals.map(row=><strong key={row.currency}>{money(row.netMinor,row.currency)}</strong>):<strong>—</strong>}<small>{data.current.todaySales.complete?"已关联业务 · 扣退款后":data.current.todaySales.reason}</small></button>:null}
      <button type="button" className="dashboard-current-card" onClick={() => onDetail("TODAY_COLLECTIONS")}><span>今日登记收款 <ArrowRight size={13} aria-hidden="true" /></span>{data.current.todayCollections.map(row => <strong key={row.currency}>{money(row.amountMinor, row.currency)}<small> / {row.count} 笔</small></strong>)}<small>住宿及会员收款 · 未扣退款{data.current.todayCollectionReviewCount ? ` · 另有${data.current.todayCollectionReviewCount}笔待核对` : ""}</small></button>
    </div>
    <div className="dashboard-current-balances">
      <button type="button" className="dashboard-current-card" onClick={() => onDetail("DEBT")}><span>住宿欠款余额 <ArrowRight size={13} aria-hidden="true" /></span>{data.current.debts.map(row => <strong key={row.currency}>{money(row.amountMinor, row.currency)}<small> / {row.count} 单</small></strong>)}<small>逐单正差额 · 不以多收抵欠款</small></button>
      <button type="button" className="dashboard-current-card" onClick={() => onDetail("RETAINED")}><span>客户留存待用 <ArrowRight size={13} aria-hidden="true" /></span>{data.current.retained.map(row => <strong key={row.currency}>{money(row.amountMinor, row.currency)}<small> / {row.count} 笔</small></strong>)}<small>客户资金归属 · 不计新增收款</small></button>
    </div>
  </section>;
}

export function CommunitySnapshot({ data, onDetail }: { data: DashboardResponse; onDetail: (metric: DashboardMetric) => void }) {
  const registrationBasis = data.community.current.total === null && data.community.current.registered !== undefined;
  const day = displayedCommunityDay(data.community.current, registrationBasis);
  return <section className="community-snapshot" aria-labelledby="community-title">
    <div className="community-total"><div className="community-total-title"><Users size={18} aria-hidden="true" /><h2 id="community-title">社区里的人</h2><span className="community-live">当前</span></div><div className="community-total-value"><Count value={day.total} reason={data.community.reasons.join("；") || "有住客缺少跨单关联依据，请核对当前住宿人登记。"} /></div><p>{data.businessDate} · {registrationBasis ? <>登记在住人数 <DashboardHint text={registrationExplanation}/></> : data.community.identityApproximate ? "昵称/姓名近似去重人数" : "实际登记在住"}</p></div>
    <div className="community-composition"><div className="community-composition-values"><div><span><i className="legend-dot paid" />付费在住 <DashboardHint text="正常应收费的实际住宿人，包含会员权益和欠款、尚未收款订单；不是收款人数。" /></span><strong>{day.paid}<small>人</small></strong></div><div><span><i className="legend-dot free" />免费在住 <DashboardHint text={`沿用免费住宿分类：义工 ${day.volunteer} 人、接待 ${day.reception} 人、其他 ${day.otherFree} 人。免费住宿同样占用房源。`} /></span><strong>{freeCount(day)}<small>人</small></strong></div></div><div className="community-composition-track" aria-hidden="true"><i style={{ flex: day.paid }} /><i style={{ flex: freeCount(day) }} /></div><p>{registrationBasis ? "按住宿登记分类 · 尚未跨单去重" : day.unlinked || day.unclassified ? "分类为已核对部分 · 缺项见说明" : data.community.identityApproximate ? "按昵称/姓名近似去重 · 不是订单数" : "同店同日跨单去重 · 不是订单数"}</p></div>
    <div className="community-today"><span className="dashboard-muted">今天的接待安排 · 订单</span><div><button onClick={() => onDetail("ARRIVAL")}><LogIn size={17} aria-hidden="true" /><span>待到店</span><strong>{data.current.arrivals}</strong><ArrowRight size={14} aria-hidden="true" /></button><button onClick={() => onDetail("DEPARTURE")}><LogOut size={17} aria-hidden="true" /><span>待离店</span><strong>{data.current.departures}</strong><ArrowRight size={14} aria-hidden="true" /></button></div></div>
  </section>;
}

export function CommunityPanels({ data }: { data: DashboardResponse }) {
  const c = data.community;
  const [selected, setSelected] = useState(c.trend.at(-1)?.date ?? "");
  const [expanded, setExpanded] = useState(false);
  const display = displayedCommunityTrend(c.trend);
  const registrationBasis = display.registrationBasis;
  const day = display.rows.find(row => row.date === selected) ?? display.rows.at(-1);
  const rows = display.rows.map(row => ({ ...row, free: freeCount(row) }));
  const reason = "部分日期缺少住客身份或实际进出日期，完整人数尚不能计算；已核对分类仍保留。请查看下方统计依据核对订单。";
  return <section className="dashboard-panel community-trend" aria-labelledby="people-trend-title">
    <div className="dashboard-section-heading"><div><p className="section-kicker">01 / 社区人数</p><h2 id="people-trend-title">每天，有多少人在这里</h2></div><span className="dashboard-tag">历史区间 · 全店</span></div>
    {c.identityApproximate ? <p className="dashboard-muted">人数与去重接待按昵称优先、姓名辅助自动识别，属于近似统计。</p> : null}
    <div className="community-trend-stats"><div><span>{registrationBasis ? "日均登记在住" : "日均在住"} <DashboardHint text={registrationBasis ? registrationExplanation + "日均值为每日登记人数合计除以天数。" : "历史区间每日去重在住人数之和÷天数。不含今天和未来预订；缺项日期不填零。"} /></span><strong><Count value={registrationBasis ? display.dailyAverage : c.dailyAverage} reason={reason} /></strong></div><div><span>本期去重接待 <DashboardHint text="在历史区间实际住过的去重住客；同一人多次入住只计一人。缺少跨单身份依据时不输出完整总数。" /></span><strong><Count value={c.visitors} reason={reason} /></strong></div><button className="dashboard-text-button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起免费分类" : "展开免费分类"}</button></div>
    {registrationBasis ? <p className="dashboard-muted">本区间按住宿登记展示人数与分类；跨单身份尚不完整，续住、复购和去重接待不据此推算。<DashboardHint text={registrationExplanation}/></p> : null}<div className="community-legend"><span><i className="legend-dot total" />{registrationBasis ? "登记人数" : "总人数"}</span><span><i className="legend-dot paid" />付费</span>{expanded ? <><span><i className="legend-dot free" />义工</span><span><i className="legend-dot reception" />接待</span><span>其他免费</span></> : <span><i className="legend-dot free" />免费</span>}</div>
    {rows.length ? <div className="dashboard-chart" aria-label="每日在住人数堆叠趋势；可点击日期或用下方日期选择查看当日">
      <ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} margin={{ top: 14, right: 8, left: -26, bottom: 4 }} accessibilityLayer onClick={state => { if (state.activeLabel) setSelected(String(state.activeLabel)); }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" /><XAxis dataKey="date" {...chartAxis} tickFormatter={value => String(value).slice(5).replace("-", "/")} minTickGap={32} /><YAxis {...chartAxis} allowDecimals={false} /><Tooltip {...chartTooltip} />
        <Area dataKey="paid" name="付费（已核对）" stackId="people" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.14} isAnimationActive={false} />
        {expanded ? <><Area dataKey="volunteer" name="义工" stackId="people" stroke="#80a99a" fill="#bfd6ca" isAnimationActive={false} /><Area dataKey="reception" name="接待" stackId="people" stroke="#ab925b" fill="#e6dbc1" isAnimationActive={false} /><Area dataKey="otherFree" name="其他免费" stackId="people" stroke="#969d98" fill="#d9dfda" isAnimationActive={false} /></> : <Area dataKey="free" name="免费（已核对）" stackId="people" stroke="#92b4a4" fill="#d4e4d9" isAnimationActive={false} />}
        <Line dataKey="total" name={registrationBasis ? "登记人数" : "总人数"} stroke="var(--brand)" strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
        {day ? <ReferenceLine x={day.date} stroke="var(--muted)" strokeDasharray="3 4" /> : null}
      </ComposedChart></ResponsiveContainer>
    </div> : <p className="dashboard-empty">本区间没有逐日人数资料，不能将没有数据视为零。</p>}
    {day ? <div className="community-day-readout"><label><span className="sr-only">查看当日人数</span><select value={day.date} onChange={e => setSelected(e.target.value)}>{c.trend.map(row => <option key={row.date}>{row.date}</option>)}</select></label><span>{registrationBasis ? "登记在住" : "在住"} <b>{day.total ?? "—"}</b> 人</span><span>付费 <b>{day.paid}</b> · 免费 <b>{freeCount(day)}</b></span>{day.total === null || day.unclassified ? <DashboardHint text={registrationBasis ? `${day.date}：已按住宿登记统计；跨单身份尚未完整关联。${registrationExplanation}` : `${day.date}：${day.unlinked} 条登记关系缺少身份/日期依据，${day.unclassified ?? 0} 人的付费/免费分类冲突。已知分类保留；到原订单核对住宿人和来源。`} /> : null}</div> : null}
    <section className="dashboard-data-table" aria-labelledby="daily-people-evidence-title"><h3 id="daily-people-evidence-title">逐日人数与统计依据{c.reasons.length ? ` · ${c.reasons.length} 项待核对` : ""}</h3><div className="dashboard-table-scroll"><table><thead><tr><th>日期</th><th>{registrationBasis ? "登记人数" : "总人数"}</th><th>付费</th><th>义工</th><th>接待</th><th>其他免费</th></tr></thead><tbody>{display.rows.map(row => <tr key={row.date}><td>{row.date}</td><td>{row.total ?? <Count value={null} reason={`${row.date} 有 ${row.unlinked} 条登记关系待核对；${reason}`} unit="" />}</td><td>{row.paid}</td><td>{row.volunteer}</td><td>{row.reception}</td><td>{row.otherFree}</td></tr>)}</tbody></table></div>{c.reasons.map((text, i) => <p key={i}>{text}</p>)}<Link to="/orders">到订单核对实际住宿人 <ArrowRight size={13} /></Link></section>
  </section>;
}
