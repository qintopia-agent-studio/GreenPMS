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
    {data.community.residentCurrent ? <CurrentResidentSummary data={data} /> : null}
    <div className="dashboard-current-primary">
      <button type="button" className="dashboard-current-card" onClick={() => onDetail("TODAY_SALES")}><span>今日经营销售额 <DashboardHint text="按业务确认日统计：已关联住宿、会员或渠道业务，扣已确认退款和更正；不等于今日登记金额。" /><ArrowRight size={13} aria-hidden="true" /></span>{data.current.todaySales?.enabled&&data.current.todaySales.complete?data.current.todaySales.totals.map(row=><strong key={row.currency}>{money(row.netMinor,row.currency)}</strong>):<strong>待核对</strong>}<small>{data.current.todaySales?.complete?"已关联业务 · 扣退款后":"尚无完整经营销售依据"}</small></button>
      <button type="button" className="dashboard-current-card" onClick={() => onDetail("TODAY_COLLECTIONS")}><span>今日登记金额 <DashboardHint text="按PMS登记日统计收款、退款和更正；退款按负项扣减，更正按正负方向调整。" /><ArrowRight size={13} aria-hidden="true" /></span>{data.current.todayCollections.map(row => <strong key={row.currency}>{money(row.amountMinor, row.currency)}<small> / {row.count} 条</small></strong>)}<small>收款、退款、更正登记净变动{data.current.todayCollectionReviewCount ? ` · 另有${data.current.todayCollectionReviewCount}条待核对` : ""}</small></button>
    </div>
    <div className="dashboard-current-followups" aria-label="当前待跟进">
      <button type="button" onClick={() => onDetail("TODAY_ORDERS")}><span>今日新增订单 <DashboardHint text="按门店当天创建的住宿订单计数，含补录；不等于今天入住订单数。" /></span><strong>{data.current.todayOrders} 单</strong><ArrowRight size={14} /></button>
      <button type="button" onClick={() => onDetail("DEBT")}><span>住宿欠款余额 <DashboardHint text="逐单合同金额减已登记净资金的正差额，不用另一单多收抵销。" /></span><strong>{data.current.debts.map(row => money(row.amountMinor, row.currency)).join("、") || "—"}</strong><ArrowRight size={14} /></button>
      <button type="button" onClick={() => onDetail("RETAINED")}><span>客户留存待用 <DashboardHint text="客户资金归属，不计新增收款；余额按留存事实减使用、退款和解除。" /></span><strong>{data.current.retained.map(row => money(row.amountMinor, row.currency)).join("、") || "—"}</strong><ArrowRight size={14} /></button>
    </div>
  </section>;
}

function CurrentResidentSummary({ data }: { data: DashboardResponse }) {
  const resident = data.community.residentCurrent!;
  return <section className="community-resident-current" aria-label="当前居民与在住会员"><div><span>当日居民数 <DashboardHint text="实际在住，且满足连续已住满7晚或明确会员入住；同一人只计一次。会员短住也可以计入。" /></span><strong>{resident.total === null ? "待核对" : resident.total}<small>{resident.total === null ? "" : "人"}</small></strong><p>长住 {resident.longStay}</p></div><div><span>在住会员 <DashboardHint text="当天实际在住且与会员身份有明确绑定；只有订单会员主体、没有住客绑定时显示待核对。" /></span><strong>{resident.member === null ? "待核对" : resident.member}<small>{resident.member === null ? "" : "人"}</small></strong><p>{resident.memberReview ? `${resident.memberReview} 条关系待绑定` : "会员关系已核对"}</p></div></section>;
}

export function CommunitySnapshot({ data, onDetail }: { data: DashboardResponse; onDetail: (metric: DashboardMetric) => void }) {
  const registrationBasis = data.community.current.total === null && data.community.current.registered !== undefined;
  const day = displayedCommunityDay(data.community.current, registrationBasis);
  return <section className="community-snapshot" aria-labelledby="community-title">
    <div className="community-total"><div className="community-total-title"><Users size={18} aria-hidden="true" /><h2 id="community-title">社区里的人</h2><span className="community-live">当前</span></div><div className="community-total-value"><Count value={day.total} reason={data.community.reasons.join("；") || "有住客缺少跨单关联依据，请核对当前住宿人登记。"} /></div><p>{data.businessDate} · {registrationBasis ? <>登记在住人数（总在住，含短住） <DashboardHint text={registrationExplanation}/></> : data.community.identityApproximate ? "总在住人数 · 昵称/姓名近似去重人数" : "总在住人数 · 含短住"}</p></div>
    <div className="community-composition"><div className="community-composition-values"><div><span><i className="legend-dot paid" />付费在住 <DashboardHint text="正常应收费的实际住宿人，包含会员权益和欠款、尚未收款订单；不是收款人数。" /></span><strong>{day.paid}<small>人</small></strong></div><div><span><i className="legend-dot free" />免费在住 <DashboardHint text={`沿用免费住宿分类：义工 ${day.volunteer} 人、接待 ${day.reception} 人、其他 ${day.otherFree} 人。免费住宿同样占用房源。`} /></span><strong>{freeCount(day)}<small>人</small></strong></div></div><div className="community-composition-track" aria-hidden="true"><i style={{ flex: day.paid }} /><i style={{ flex: freeCount(day) }} /></div><p>{registrationBasis ? "按住宿登记分类 · 尚未跨单去重" : day.unlinked || day.unclassified ? "分类为已核对部分 · 缺项见说明" : data.community.identityApproximate ? "按昵称/姓名近似去重 · 不是订单数" : "同店同日跨单去重 · 不是订单数"}</p></div>
    <div className="community-today"><span className="dashboard-muted">今天的接待安排 · 订单</span><div><button onClick={() => onDetail("ARRIVAL")}><LogIn size={17} aria-hidden="true" /><span>待到店</span><strong>{data.current.arrivals}</strong><ArrowRight size={14} aria-hidden="true" /></button><button onClick={() => onDetail("DEPARTURE")}><LogOut size={17} aria-hidden="true" /><span>待离店</span><strong>{data.current.departures}</strong><ArrowRight size={14} aria-hidden="true" /></button></div></div>
  </section>;
}

export function CommunityPanels({ data }: { data: DashboardResponse }) {
  const c = data.community;
  const [selected, setSelected] = useState(c.trend.at(-1)?.date ?? "");
  const [expanded, setExpanded] = useState(false);
  const display = displayedCommunityTrend(c.trend);
  const dailyRows = [...display.rows].sort((a, b) => b.date.localeCompare(a.date));
  const residentTrend = c.residentTrend ?? [];
  const registrationBasis = display.registrationBasis;
  const day = display.rows.find(row => row.date === selected) ?? display.rows.at(-1);
  const rows = display.rows.map(row => ({ ...row, free: freeCount(row), residentTotal: residentTrend.find(item => item.date === row.date)?.total ?? null }));
  const residentAverage = residentTrend.length && residentTrend.every(row => row.total !== null)
    ? residentTrend.reduce((sum, row) => sum + row.total!, 0) / residentTrend.length : null;
  const reason = "部分日期缺少住客身份或实际进出日期，完整人数尚不能计算；已核对分类仍保留。请查看下方统计依据核对订单。";
  return <section className="dashboard-panel community-trend" aria-labelledby="people-trend-title">
    <div className="dashboard-section-heading"><div><p className="section-kicker">01 / 社区人数</p><h2 id="people-trend-title">每天，有多少人在这里</h2></div><span className="dashboard-tag">历史区间 · 全店</span></div>
    {c.identityApproximate ? <p className="dashboard-muted">人数与去重接待按昵称优先、姓名辅助自动识别，属于近似统计。</p> : null}
    <div className="community-trend-stats"><div><span>{registrationBasis ? "日均登记在住（总在住，含短住）" : "日均总在住（含短住）"} <DashboardHint text={registrationBasis ? registrationExplanation + "包含短住；日均值为每日登记在住人数合计除以天数。" : "包含短住、长住、会员、免费和付费的实际在住人数；不含未来预订。"} /></span><strong><Count value={registrationBasis ? display.dailyAverage : c.dailyAverage} reason={reason} /></strong></div><div><span>日均居民数 <DashboardHint text="历史区间内居民数（长住或明确会员入住）的日均值；居民属于总在住人数的子集。" /></span><strong><Count value={residentAverage} reason="历史会员关系存在待绑定记录，居民历史总数暂不能完整计算。" /></strong></div><div><span>本期去重接待 <DashboardHint text="在历史区间实际住过的去重住客；同一人多次入住只计一人。缺少跨单身份依据时不输出完整总数。" /></span><strong><Count value={c.visitors} reason={reason} /></strong></div><button className="dashboard-text-button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起免费分类" : "展开免费分类"}</button></div>

    {registrationBasis ? <p className="dashboard-muted">本区间按住宿登记展示人数与分类；跨单身份尚不完整，续住、复购和去重接待不据此推算。<DashboardHint text={registrationExplanation}/></p> : null}<div className="community-legend"><span><i className="legend-dot total" />{registrationBasis ? "登记人数" : "总人数"}</span><span><i className="legend-dot paid" />付费</span>{expanded ? <><span><i className="legend-dot free" />义工</span><span><i className="legend-dot reception" />接待</span><span>其他免费</span></> : <span><i className="legend-dot free" />免费</span>}</div>
    {rows.length ? <div className="dashboard-chart" aria-label="每日在住人数堆叠趋势；可点击日期或用下方日期选择查看当日">
      <ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} margin={{ top: 14, right: 8, left: -26, bottom: 4 }} accessibilityLayer onClick={state => { if (state.activeLabel) setSelected(String(state.activeLabel)); }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" /><XAxis dataKey="date" {...chartAxis} tickFormatter={value => String(value).slice(5).replace("-", "/")} minTickGap={32} /><YAxis {...chartAxis} allowDecimals={false} /><Tooltip {...chartTooltip} />
        <Area dataKey="paid" name="付费（已核对）" stackId="people" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.14} isAnimationActive={false} />
        {expanded ? <><Area dataKey="volunteer" name="义工" stackId="people" stroke="#80a99a" fill="#bfd6ca" isAnimationActive={false} /><Area dataKey="reception" name="接待" stackId="people" stroke="#ab925b" fill="#e6dbc1" isAnimationActive={false} /><Area dataKey="otherFree" name="其他免费" stackId="people" stroke="#969d98" fill="#d9dfda" isAnimationActive={false} /></> : <Area dataKey="free" name="免费（已核对）" stackId="people" stroke="#92b4a4" fill="#d4e4d9" isAnimationActive={false} />}
        <Line dataKey="total" name={registrationBasis ? "登记人数（含短住）" : "总人数（含短住）"} stroke="var(--brand)" strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line dataKey="residentTotal" name="居民数" stroke="#ab925b" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        {day ? <ReferenceLine x={day.date} stroke="var(--muted)" strokeDasharray="3 4" /> : null}
      </ComposedChart></ResponsiveContainer>
    </div> : <p className="dashboard-empty">本区间没有逐日人数资料，不能将没有数据视为零。</p>}
    {day ? <div className="community-day-readout"><label><span className="sr-only">查看当日人数</span><select value={day.date} onChange={e => setSelected(e.target.value)}>{c.trend.map(row => <option key={row.date}>{row.date}</option>)}</select></label><span>总在住（含短住） <b>{day.total ?? "—"}</b> 人</span><span>付费 <b>{day.paid}</b> · 免费 <b>{freeCount(day)}</b></span>{day.total === null || day.unclassified ? <DashboardHint text={registrationBasis ? `${day.date}：已按住宿登记统计；跨单身份尚未完整关联。${registrationExplanation}` : `${day.date}：${day.unlinked} 条登记关系缺少身份/日期依据，${day.unclassified ?? 0} 人的付费/免费分类冲突。已知分类保留；到原订单核对住宿人和来源。`} /> : null}</div> : null}
    <section className="dashboard-data-table" aria-labelledby="daily-people-evidence-title"><h3 id="daily-people-evidence-title">逐日人数与统计依据{c.reasons.length ? ` · ${c.reasons.length} 项待核对` : ""}</h3><div className="dashboard-table-scroll"><table><thead><tr><th>日期</th><th>{registrationBasis ? "登记人数（含短住）" : "总人数（含短住）"}</th><th>付费</th><th>义工</th><th>接待</th><th>其他免费</th><th>居民</th></tr></thead><tbody>{dailyRows.map(row => { const residentRow = residentTrend.find(item => item.date === row.date); return <tr key={row.date}><td>{row.date}</td><td>{row.total ?? <Count value={null} reason={`${row.date} 有 ${row.unlinked} 条登记关系待核对；${reason}`} unit="" />}</td><td>{row.paid}</td><td>{row.volunteer}</td><td>{row.reception}</td><td>{row.otherFree}</td><td>{residentRow?.total === null ? <>待核对 <DashboardHint label="查看居民数缺项原因" text="会员订单存在，但当前没有住客与会员的明确绑定，不能把会员付款/权益主体当作实际住客。长住人数仍按已完成7晚的实际住宿计算。" /></> : residentRow?.total ?? "—"}</td></tr>; })}</tbody></table></div>{c.reasons.map((text, i) => <p key={i}>{text}</p>)}<Link to="/orders">到订单核对实际住宿人 <ArrowRight size={13} /></Link></section>
  </section>;
}
