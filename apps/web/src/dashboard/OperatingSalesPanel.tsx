import type { OperatingSalesSummary } from "@qintopia/contracts";
import { ArrowRight } from "lucide-react";
import { money } from "./dashboard-state";
const labels={DIRECT:'住宿收款',MEMBERSHIP:'会员售卡',CHANNEL:'渠道业务',BASELINE:'已确认封账'};
export function OperatingSalesPanel({summary,onDetail}:{summary:OperatingSalesSummary;onDetail:()=>void}) {
 return <section className="dashboard-panel" aria-label="经营销售额"><div className="dashboard-section-heading"><div><h3>经营销售额</h3><p>真实收款关联业务后计入；渠道按应结金额，退款单独扣减</p></div><button type="button" className="button button-secondary" onClick={onDetail}>组成明细 <ArrowRight size={14}/></button></div>
 {summary.enabled&&summary.complete?<><div className="funds-grid">{summary.totals.map(t=><div key={t.currency}><h4>{t.currency} · 扣退款后</h4><strong>{money(t.netMinor,t.currency)}</strong>{t.salesMinor!==null?<p>销售 {money(t.salesMinor,t.currency)} · 退款 {money(t.refundsMinor,t.currency)} · 更正 {money(t.correctedMinor,t.currency)}</p>:<p>含历史月度封账基准，不拆作某一天的交易。</p>}</div>)}</div><div className="dashboard-table-scroll"><table><thead><tr><th>来源</th><th>净额</th></tr></thead><tbody>{summary.breakdown.map(r=><tr key={`${r.source}:${r.currency}`}><td>{labels[r.source]}</td><td>{money(r.netMinor,r.currency)}</td></tr>)}</tbody></table></div></>:<p role="status">— · {summary.reason}</p>}
 {summary.sealedMonths.length?<p className="dashboard-muted">封账月份：{summary.sealedMonths.join('、')}；新口径不会重算这些月度基准。</p>:null}
 </section>;
}
