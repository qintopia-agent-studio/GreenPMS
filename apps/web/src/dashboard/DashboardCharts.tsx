import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardResponse } from "@qintopia/contracts";

const grid = <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />;
const axis = { tick: { fill: "var(--muted)", fontSize: 11 }, axisLine: false, tickLine: false };
const tooltip = { contentStyle: { border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", background: "var(--surface)" } };
export function DashboardCharts({ data }: { data: DashboardResponse }) {
  const moneyRows = data.moneyTrend.map(row => {
    const entry = row.money.find(item => item.currency === data.currency);
    const safe = (value: string) => { const n = Number(value); return Number.isSafeInteger(n) ? n / 100 : null; };
    return { date: row.date, collection: entry && entry.netMinor !== null ? safe(entry.collectedMinor) : null,
      refund: entry && entry.netMinor !== null ? safe(entry.refundedMinor) : null,
      correction: entry && entry.netMinor !== null ? safe(entry.correctedMinor) : null };
  });
  return <div className="dashboard-chart-grid">
    <section className="dashboard-panel" aria-labelledby="stay-chart-title">
      <div className="dashboard-section-heading"><div><h3 id="stay-chart-title">入住与占用</h3><p>按住宿日 · 单元夜，非人数</p></div><span className="dashboard-tag">历史经营</span></div>
      <div className="dashboard-chart" role="img" aria-label="付费与免费住宿单元夜趋势，精确数值见下方数据表">
        <ResponsiveContainer width="100%" height="100%"><LineChart data={data.stayTrend} margin={{ top: 12, right: 12, left: -22, bottom: 0 }} accessibilityLayer>
          {grid}<XAxis dataKey="date" {...axis} tickFormatter={date => String(date).slice(5)} minTickGap={26} /><YAxis {...axis} allowDecimals={false} />
          <Tooltip {...tooltip} /><Legend iconType="plainline" /><Line dataKey="paid" name="付费" stroke="var(--brand)" strokeWidth={2.5} dot={false} isAnimationActive={false} /><Line dataKey="free" name="免费" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer>
      </div>
      <details className="dashboard-data-table"><summary>逐日住宿数据</summary><div className="dashboard-table-scroll"><table><thead><tr><th>住宿日</th><th>付费</th><th>免费</th><th>容量</th><th>质量</th></tr></thead><tbody>{data.stayTrend.map(row => <tr key={row.date}><td>{row.date}</td><td>{row.paid}</td><td>{row.free}</td><td>{row.capacity ?? "—"}</td><td>{row.quality === "COMPLETE" ? "完整" : "部分可核对"}</td></tr>)}</tbody></table></div></details>
    </section>
    <section className="dashboard-panel" aria-labelledby="money-chart-title">
      <div className="dashboard-section-heading"><div><h3 id="money-chart-title">收款、退款与更正</h3><p>按 PMS 登记日 · {data.currency} 元</p></div><span className="dashboard-tag">不受住宿筛选影响</span></div>
      <div className="dashboard-chart" role="img" aria-label="登记收款、退款及更正分组柱状图，精确数值见下方数据表">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={moneyRows} margin={{ top: 12, right: 12, left: -12, bottom: 0 }} accessibilityLayer>
          {grid}<XAxis dataKey="date" {...axis} tickFormatter={date => String(date).slice(5)} minTickGap={26} /><YAxis {...axis} width={55} />
          <Tooltip {...tooltip} /><Legend iconType="square" /><Bar dataKey="collection" name="收款" fill="var(--brand)" radius={[2, 2, 0, 0]} isAnimationActive={false} /><Bar dataKey="refund" name="退款" fill="var(--warning)" radius={[2, 2, 0, 0]} isAnimationActive={false} /><Bar dataKey="correction" name="更正" fill="var(--accent)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart></ResponsiveContainer>
      </div>
      <details className="dashboard-data-table"><summary>逐日资金数据（整数分）</summary><div className="dashboard-table-scroll"><table><thead><tr><th>登记日</th><th>币种</th><th>收款</th><th>退款</th><th>更正</th><th>净额</th></tr></thead><tbody>{data.moneyTrend.flatMap(row => row.money.map(item => <tr key={`${row.date}-${item.currency}`}><td>{row.date}</td><td>{item.currency}</td><td>{item.collectedMinor}</td><td>{item.refundedMinor}</td><td>{item.correctedMinor}</td><td>{item.netMinor ?? "待核对"}</td></tr>))}</tbody></table></div></details>
    </section>
  </div>;
}
