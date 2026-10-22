import { displayedCommunityDay, displayedCommunityTrend, registrationExplanation } from "./community-display";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Users, LogIn, LogOut } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CommunityDay, CommunityResidentDay, CommunityResidentMemberItem, CommunityResidentReviewItem, DashboardMetric, DashboardResponse } from "@qintopia/contracts";
import { DashboardHint } from "./DashboardHint";
import { money } from "./dashboard-state";
import { CurrentMoneyCards } from "./CurrentMoneyCards";

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
    <CurrentMoneyCards data={data} onDetail={onDetail} />
    <div className="dashboard-current-followups" aria-label="当前待跟进">
      <div><span>今日新增订单 <DashboardHint text="按门店当天创建的住宿订单计数，含补录；不等于今天入住订单数。" /></span><button type="button" aria-label="查看今日新增订单" onClick={() => onDetail("TODAY_ORDERS")}><strong>{data.current.todayOrders} 单</strong><ArrowRight size={14} /></button></div>
      <div><span>住宿欠款余额 <DashboardHint text="逐单合同金额减已登记净资金的正差额，不用另一单多收抵销。" /></span><button type="button" aria-label="查看住宿欠款" onClick={() => onDetail("DEBT")}><strong>{data.current.debts.map(row => money(row.amountMinor, row.currency)).join("、") || "—"}</strong><ArrowRight size={14} /></button></div>
      <div><span>客户留存待用 <DashboardHint text="客户资金归属，不计新增收款；余额按留存事实减使用、退款和解除。" /></span><button type="button" aria-label="查看客户留存" onClick={() => onDetail("RETAINED")}><strong>{data.current.retained.map(row => money(row.amountMinor, row.currency)).join("、") || "—"}</strong><ArrowRight size={14} /></button></div>
    </div>
  </section>;
}

function CurrentResidentSummary({ data }: { data: DashboardResponse }) {
  const resident = data.community.residentCurrent!;
  const [showReview, setShowReview] = useState(false);
  const listId = useId();
  const knownResidents = resident.total ?? resident.knownTotal;
  const knownMembers = resident.member ?? resident.knownMember;
  const issues = resident.reviewItems ?? [];
  const hasList = issues.length > 0 || Boolean(resident.memberItems?.length);
  return <>
    <section className="community-resident-current" aria-label="当前居民与在住会员">
      <div><span>当日居民数 <DashboardHint text="按有效付费住宿区间统计：入住日计入、退房日期当天不计入。连续已住满7晚与使用付费会员权益的住客取并集，同一人只计一次；免费住宿不计入居民，有空夜后重新累计。" /></span><strong>{knownResidents ?? "待核对"}<small>{knownResidents === undefined ? "" : resident.total === null ? "人 · 已确认" : "人"}</small></strong><p>付费长住 {resident.longStay}{resident.total === null && resident.residentReview ? ` · 另 ${resident.residentReview} 条待核对` : ""}{!resident.memberReview && issues.length ? <button type="button" className="dashboard-text-button" aria-expanded={showReview} aria-controls={listId} onClick={() => setShowReview(!showReview)}>{showReview ? "收起名单" : "核对居住日期"}<ArrowRight size={12} /></button> : null}</p></div>
      <div><span>在住会员 <DashboardHint text="按当天实际使用付费会员权益的有效住宿统计，每笔订单最多计1人，由主要住客登记承接统计份额，不要求是会员本人。免费住宿不计入居民；同人按现有住客口径去重，与付费长住不重复；退房日期当天不计入，预留或已返还权益不计。" /></span><strong>{knownMembers ?? "待核对"}<small>{knownMembers === undefined ? "" : resident.member === null ? "人 · 已确认" : "人"}</small></strong><p>{resident.memberReview ? `${resident.memberReview} 条资料待核对` : null}{hasList ? <button type="button" className="dashboard-text-button" aria-expanded={showReview} aria-controls={listId} onClick={() => setShowReview(!showReview)}>{showReview ? "收起名单" : "查看在住名单"}<ArrowRight size={12} /></button> : null}</p></div>
    </section>
    {showReview ? <div id={listId}><ResidentPeopleList resident={resident} /></div> : null}
  </>;
}

export function ResidentPeopleList({ resident }: { resident: CommunityResidentDay }) {
  const members = resident.memberItems ?? [];
  const reviews = resident.reviewItems ?? [];
  const groups: Array<{ title: string; review: boolean; items: Array<CommunityResidentMemberItem | CommunityResidentReviewItem> }> = [
    { title: "会员权益住宿", review: false, items: members },
    { title: "待核对登记", review: true, items: reviews }
  ];
  return <div className="dashboard-resident-people" aria-label="在住会员与待核对住客名单">
    {groups.filter(group => group.items.length).map(group => <section className="dashboard-resident-group" key={group.title} aria-label={group.title}>
      <div className="dashboard-resident-group-heading"><h3>{group.title}</h3><span>{group.items.length} 条登记</span></div>
      <table className="dashboard-resident-table">
        <thead><tr><th>在住住客</th><th>本房间住期 <DashboardHint label="房间日期说明" text="日期来自该房间的有效住宿安排，不代表追加住客已核实的独立入住日期；日期缺项在核对事项中说明。" /></th><th>会员权益来源</th><th>{group.review ? "核对事项" : "统计依据"}</th></tr></thead>
        <tbody>{group.items.map((item, index) => {
          const review = "reason" in item ? item : null;
          const basisLabel = "使用会员权益";
          const basisExplanation = "按订单当天已核销且未返还的会员权益统计，每笔住宿最多计1人，不要求住客是会员本人；与该住客登记的长住条件去重。";
          return <tr key={`${item.orderId}:${item.occupantId ?? index}`}>
            <td data-label="在住住客"><strong>{item.occupantName || "住客姓名待补充"}</strong><Link className="dashboard-resident-link" to={`/orders/${encodeURIComponent(item.orderId)}`}>{group.review ? "核对住客" : "住宿订单"}<ArrowRight size={12} aria-hidden="true" /></Link></td>
            <td data-label="本房间住期"><strong>{item.roomCode || "房间待核对"}</strong><small>{item.arrivalDate && item.departureDate ? `${item.arrivalDate} 至 ${item.departureDate}` : "住宿日期待核对"}</small></td>
            <td data-label="会员权益来源">{item.memberId ? <Link className="dashboard-resident-member" to={`/members?memberId=${encodeURIComponent(item.memberId)}`}>{item.memberName || "会员姓名待补充"}<ArrowRight size={12} aria-hidden="true" /></Link> : <span className="dashboard-muted">{item.memberName || (group.review ? "权益来源待核对" : "历史会员权益")}</span>}</td>
            <td data-label={group.review ? "核对事项" : "统计依据"}><span className={group.review ? "dashboard-resident-reason" : "dashboard-resident-confirmed"}>{review ? review.reasonLabel || review.reason : basisLabel}<DashboardHint label={group.review ? "核对原因说明" : "会员统计依据"} text={review ? review.reason : basisExplanation} /></span></td>
          </tr>;
        })}</tbody>
      </table>
    </section>)}
  </div>;
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
  const rows = display.rows.map(row => ({ ...row, free: freeCount(row), residentTotal: residentTrend.find(item => item.date === row.date)?.total ?? residentTrend.find(item => item.date === row.date)?.knownTotal ?? null }));
  const partialResidents = residentTrend.some(row => row.total === null);
  const residentAverage = residentTrend.length && residentTrend.every(row => row.total !== null || row.knownTotal !== undefined)
    ? residentTrend.reduce((sum, row) => sum + (row.total ?? row.knownTotal!), 0) / residentTrend.length : null;
  const reason = "部分日期缺少住客身份或实际进出日期，完整人数尚不能计算；已核对分类仍保留。请查看下方统计依据核对订单。";
  return <section className="dashboard-panel community-trend" aria-labelledby="people-trend-title">
    <div className="dashboard-section-heading"><div><p className="section-kicker">01 / 社区人数</p><h2 id="people-trend-title">每天，有多少人在这里</h2></div><span className="dashboard-tag">历史区间 · 全店</span></div>
    {c.identityApproximate ? <p className="dashboard-muted">人数与去重接待按昵称优先、姓名辅助自动识别，属于近似统计。</p> : null}
    <div className="community-trend-stats"><div><span>{registrationBasis ? "日均登记在住（总在住，含短住）" : "日均总在住（含短住）"} <DashboardHint text={registrationBasis ? registrationExplanation + "包含短住；日均值为每日登记在住人数合计除以天数。" : "包含有效住宿区间内短住、长住、会员权益、免费和付费住客；入住日计入，退房日期当天不计入，不含未来预订。居民只取付费长住和付费会员权益住宿，免费住宿不计入居民。"} /></span><strong><Count value={registrationBasis ? display.dailyAverage : c.dailyAverage} reason={reason} /></strong></div><div><span>{partialResidents ? "日均居民（已确认）" : "日均居民数"} <DashboardHint text="历史区间内居民数的日均值；居民是付费总在住人数的子集。免费住宿不计入居民；有权益使用或日期缺项时仅显示已确认人数的日均值，完整人数可能更高。" /></span><strong><Count value={residentAverage} reason="历史权益使用或实际住宿日期存在缺项，居民历史总数暂不能完整计算。" /></strong></div><div><span>本期去重接待 <DashboardHint text="在历史区间实际住过的去重住客；同一人多次入住只计一人。缺少跨单身份依据时不输出完整总数。" /></span><strong><Count value={c.visitors} reason={reason} /></strong></div><button className="dashboard-text-button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起免费分类" : "展开免费分类"}</button></div>

    {registrationBasis ? <p className="dashboard-muted">本区间按住宿登记展示人数与分类；跨单身份尚不完整，续住、复购和去重接待不据此推算。<DashboardHint text={registrationExplanation}/></p> : null}<div className="community-legend"><span><i className="legend-dot total" />{registrationBasis ? "登记人数" : "总人数"}</span><span><i className="legend-dot resident" />{partialResidents ? "居民（已确认）" : "居民"}</span><span><i className="legend-dot paid" />付费</span>{expanded ? <><span><i className="legend-dot free" />义工</span><span><i className="legend-dot reception" />接待</span><span>其他免费</span></> : <span><i className="legend-dot free" />免费</span>}</div>
    {rows.length ? <div className="dashboard-chart" aria-label="每日在住人数堆叠趋势；可点击日期或用下方日期选择查看当日">
      <ResponsiveContainer width="100%" height="100%"><ComposedChart data={rows} margin={{ top: 14, right: 8, left: -26, bottom: 4 }} accessibilityLayer onClick={state => { if (state.activeLabel) setSelected(String(state.activeLabel)); }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" /><XAxis dataKey="date" {...chartAxis} tickFormatter={value => String(value).slice(5).replace("-", "/")} minTickGap={32} /><YAxis {...chartAxis} allowDecimals={false} /><Tooltip {...chartTooltip} />
        <Area dataKey="paid" name="付费（已核对）" stackId="people" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.14} isAnimationActive={false} />
        {expanded ? <><Area dataKey="volunteer" name="义工" stackId="people" stroke="#80a99a" fill="#bfd6ca" isAnimationActive={false} /><Area dataKey="reception" name="接待" stackId="people" stroke="#ab925b" fill="#e6dbc1" isAnimationActive={false} /><Area dataKey="otherFree" name="其他免费" stackId="people" stroke="#969d98" fill="#d9dfda" isAnimationActive={false} /></> : <Area dataKey="free" name="免费（已核对）" stackId="people" stroke="#92b4a4" fill="#d4e4d9" isAnimationActive={false} />}
        <Line dataKey="total" name={registrationBasis ? "登记人数（含短住）" : "总人数（含短住）"} stroke="var(--brand)" strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line dataKey="residentTotal" name={partialResidents ? "居民（已确认）" : "居民数"} stroke="#ab925b" {...(partialResidents ? {strokeDasharray:"4 3"} : {})} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        {day ? <ReferenceLine x={day.date} stroke="var(--muted)" strokeDasharray="3 4" /> : null}
      </ComposedChart></ResponsiveContainer>
    </div> : <p className="dashboard-empty">本区间没有逐日人数资料，不能将没有数据视为零。</p>}
    {day ? <div className="community-day-readout"><label><span className="sr-only">查看当日人数</span><select value={day.date} onChange={e => setSelected(e.target.value)}>{c.trend.map(row => <option key={row.date}>{row.date}</option>)}</select></label><span>总在住（含短住） <b>{day.total ?? "—"}</b> 人</span><span>付费 <b>{day.paid}</b> · 免费 <b>{freeCount(day)}</b></span>{day.total === null || day.unclassified ? <DashboardHint text={registrationBasis ? `${day.date}：已按住宿登记统计；跨单身份尚未完整关联。${registrationExplanation}` : `${day.date}：${day.unlinked} 条登记关系缺少身份/日期依据，${day.unclassified ?? 0} 人的付费/免费分类冲突。已知分类保留；到原订单核对住宿人和来源。`} /> : null}</div> : null}
    <section className="dashboard-data-table" aria-labelledby="daily-people-evidence-title"><h3 id="daily-people-evidence-title">逐日人数与统计依据{c.reasons.length ? ` · ${c.reasons.length} 项待核对` : ""}</h3><div className="dashboard-table-scroll"><table><thead><tr><th>日期</th><th>{registrationBasis ? "登记人数（含短住）" : "总人数（含短住）"}</th><th>付费</th><th>义工</th><th>接待</th><th>其他免费</th><th>居民</th></tr></thead><tbody>{dailyRows.map(row => { const residentRow = residentTrend.find(item => item.date === row.date); return <tr key={row.date}><td>{row.date}</td><td>{row.total ?? <Count value={null} reason={`${row.date} 有 ${row.unlinked} 条登记关系待核对；${reason}`} unit="" />}</td><td>{row.paid}</td><td>{row.volunteer}</td><td>{row.reception}</td><td>{row.otherFree}</td><td>{residentRow?.total === null ? <>{residentRow.knownTotal === undefined ? "待核对" : `${residentRow.knownTotal} 已确认`} <DashboardHint label="查看居民数缺项原因" text="此日期仍有权益使用记录或连续住宿日期待核对；已确认居民保留，完整总数可能更高。" /></> : residentRow?.total ?? "—"}</td></tr>; })}</tbody></table></div>{c.reasons.map((text, i) => <p key={i}>{text}</p>)}<Link to="/orders">到订单核对实际住宿人 <ArrowRight size={13} /></Link></section>
  </section>;
}
