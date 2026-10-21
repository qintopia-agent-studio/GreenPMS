import type { DashboardMetric, DashboardResponse, OperatingSalesSource } from "@qintopia/contracts";
import { ArrowRight } from "lucide-react";
import { DashboardHint } from "./DashboardHint";
import { money } from "./dashboard-state";

const salesLabels: Record<OperatingSalesSource, string> = { DIRECT: "住宿", MEMBERSHIP: "会员", CHANNEL: "渠道", BASELINE: "封账" };
const registeredLabels = { STAY: "住宿", MEMBER: "会员", CHANNEL: "渠道应结" };

export function CurrentMoneyCards({ data, onDetail }: { data: DashboardResponse; onDetail: (metric: DashboardMetric) => void }) {
  const current = data.current;
  const sales = current.todaySales;
  const salesReady = sales?.enabled && sales.complete;
  const noSales = salesReady && sales.totals.every(row => row.netMinor === "0") && !sales.breakdown.length;
  const noRegistration = current.todayCollections.every(row => row.count === 0);
  const unclaimed = current.todayUnclaimed?.filter(row => row.count > 0) ?? [];
  const sync = current.paymentSync;
  const syncDelayed = Boolean(sync?.lastSyncedAt && Date.parse(data.asOf) - Date.parse(sync.lastSyncedAt) > 5 * 60_000);
  const syncUnknown = !sync || !sync.enabled || !sync.lastSyncedAt || sync.hasError || syncDelayed;
  const syncText = !sync ? "未提供企微同步状态，无法确认原始流水是否齐全。" : !sync.enabled ? "企微同步尚未启用，已登记的业务事实仍保留。" : sync.hasError ? "企微最近同步异常，已显示的金额仅代表目前已知事实。" : !sync.lastSyncedAt ? "企微尚无成功同步记录，不能把尚未同步当作没有交易。" : `企微最近成功同步：${new Date(sync.lastSyncedAt).toLocaleString("zh-CN", { timeZone: data.timezone })}。${syncDelayed ? "距本次数据读取已超过5分钟，可能有尚未同步的流水。" : ""}`;
  return <div className="dashboard-current-primary">
    <article className="dashboard-current-card" aria-label="今日经营销售额">
      <span className="dashboard-current-card-heading">今日经营销售额 <DashboardHint text="按业务确认日统计已关联住宿、会员和渠道业务，退款为负项、更正按正负方向调整。没有今天新确认的业务时显示0；在住人数不会自动产生当天销售额。" /><button className="dashboard-card-detail" type="button" aria-label="查看今日经营销售额明细" onClick={() => onDetail("TODAY_SALES")}><ArrowRight size={14} /></button></span>
      <button className="dashboard-card-value" type="button" aria-label="打开今日经营销售额组成明细" onClick={() => onDetail("TODAY_SALES")}>{salesReady ? sales.totals.map(row => <strong key={row.currency}>{money(row.netMinor, row.currency)}</strong>) : <strong>待核对</strong>}</button>
      {salesReady && sales.breakdown.length ? <small className="dashboard-card-breakdown">{sales.breakdown.map(row => `${salesLabels[row.source]} ${money(row.netMinor, row.currency)}`).join(" · ")}</small> : null}
      <small>{noSales ? "今日暂无已确认业务" : salesReady ? "已关联业务 · 含退款与更正" : "经营依据待核对"}{!salesReady ? <DashboardHint text={sales?.reason ?? "经营销售来源尚未完成承接。"} /> : null}</small>
    </article>
    <article className="dashboard-current-card" aria-label="今日登记金额">
      <span className="dashboard-current-card-heading">今日登记金额 <DashboardHint text={`按PMS登记日统计已确认的收款、渠道应结、退款和更正，退款按负项、更正按正负方向调整。渠道应结不代表现金到账。当天首次同步但尚未被业务认领的企微金额单列，不计入已确认合计。${syncText}`} /><button className="dashboard-card-detail" type="button" aria-label="查看今日登记金额明细" onClick={() => onDetail("TODAY_COLLECTIONS")}><ArrowRight size={14} /></button></span>
      <button className="dashboard-card-value" type="button" aria-label="打开今日登记金额组成明细" onClick={() => onDetail("TODAY_COLLECTIONS")}>{current.todayCollections.map(row => <strong key={row.currency}>{money(row.amountMinor, row.currency)}<small> / {row.count} 条</small></strong>)}</button>
      {current.todayCollectionBreakdown?.length ? <small className="dashboard-card-breakdown">{current.todayCollectionBreakdown.map(row => `${registeredLabels[row.source]} ${money(row.amountMinor, row.currency)}`).join(" · ")}</small> : null}
      {unclaimed.length ? <button type="button" className="dashboard-financial-pending" onClick={() => onDetail("TODAY_COLLECTIONS")}>今日待认领 {unclaimed.map(row => `${money(row.amountMinor, row.currency)} / ${row.count} 条`).join(" · ")}<ArrowRight size={12} /></button> : null}
      <small>{noRegistration && !unclaimed.length && !current.todayCollectionReviewCount && !syncUnknown ? "今日暂无金额登记" : "已确认净额 · 含退款与更正"}{current.todayCollectionReviewCount ? ` · ${current.todayCollectionReviewCount} 条待核对` : ""}{syncUnknown ? <><span> · 同步待核对</span><DashboardHint label="企微同步状态" text={syncText} /></> : null}</small>
    </article>
  </div>;
}
