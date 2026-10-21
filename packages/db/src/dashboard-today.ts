import { sql, type Transaction } from "kysely";
import type { DashboardBalance, DashboardDetail } from "@qintopia/contracts";
import { classifyDashboardMoney, dashboardDate } from "@qintopia/domain";
import { dashboardMoneyDetail, loadDashboardMoney, type LoadedDashboardMoney } from "./dashboard-money.ts";
import type { Database } from "./schema.ts";

interface TodayOrder { id: string; date: string; registeredAt: string }

/** 当前经营登记指标独立于历史筛选；复用既有资金事实分类，内部归属转换不算新增收款。 */
export function summarizeDashboardToday(date: string, currency: string, orders: TodayOrder[], facts: LoadedDashboardMoney[]) {
  const todayOrders = [...new Map(orders.filter(order => order.date === date).map(order => [order.id, order])).values()];
  const todayFacts = [...new Map(facts.filter(fact => fact.date === date).map(fact => [`${fact.family}:${fact.id}`, fact])).values()];
  const registeredFinancialFacts = todayFacts.filter(fact => ["COLLECTION", "REFUND", "CORRECTION"].includes(classifyDashboardMoney(fact)));
  const grouped = new Map<string, DashboardBalance>([[currency, { currency, amountMinor: "0", count: 0 }]]);
  const sourceGrouped = new Map<string, { currency: string; source: "STAY" | "MEMBER" | "CHANNEL"; amountMinor: bigint; count: number }>();
  for (const fact of registeredFinancialFacts) {
    const row = grouped.get(fact.currency) ?? { currency: fact.currency, amountMinor: "0", count: 0 };
    row.amountMinor = String(BigInt(row.amountMinor) + BigInt(fact.netMinor));
    row.count++;
    grouped.set(fact.currency, row);
    const source = fact.family === "CHANNEL" ? "CHANNEL" : fact.family === "MEMBER" ? "MEMBER" : "STAY";
    const key = `${fact.currency}:${source}`;
    const sourceRow = sourceGrouped.get(key) ?? { currency: fact.currency, source, amountMinor: 0n, count: 0 };
    sourceRow.amountMinor += BigInt(fact.netMinor);
    sourceRow.count++;
    sourceGrouped.set(key, sourceRow);
  }
  const details: DashboardDetail[] = [
    ...todayOrders.map(order => ({ id: `today-order:${order.id}`, date, metric: "TODAY_ORDERS" as const,
      label: "今日新增住宿订单", orderId: order.id, memberId: null, unitId: null, units: 1, amountMinor: null, currency: null,
      registeredAt: order.registeredAt, businessDate: null,
      reason: "按门店当天创建的住宿订单计数，包含补录；后来取消不会删除新增记录，不等于今天入住订单数" })),
    ...registeredFinancialFacts.map(fact => ({ ...dashboardMoneyDetail(fact), id: `today-collection:${fact.id}`, metric: "TODAY_COLLECTIONS" as const,
      label: fact.family === "CHANNEL" ? (fact.kind === "REFUND" ? "渠道登记退款" : fact.kind === "REVERSAL" || fact.kind === "CORRECTION" ? "渠道登记更正" : "渠道应结登记")
        : fact.kind === "REFUND" ? "今日登记退款" : fact.kind === "REVERSAL" || fact.correctsFact || fact.deletionCorrection ? "今日登记更正" : fact.family === "MEMBER" ? "今日登记会员收款" : "今日登记住宿收款",
      reason: fact.family === "CHANNEL"
        ? "按PMS登记日统计渠道应结、渠道退款和渠道更正；金额保留正负方向，不代表现金到账"
        : "按PMS登记日统计收款、退款和更正；金额保留正负方向，内部资金归属转换不计入" }))
  ];
  return { todayOrders: todayOrders.length, todayCollections: [...grouped.values()], todayCollectionBreakdown: [...sourceGrouped.values()].map(row => ({ ...row, amountMinor: String(row.amountMinor) })),
    todayCollectionReviewCount: todayFacts.filter(fact => classifyDashboardMoney(fact) === "REVIEW").length, details };
}

export async function loadDashboardToday(trx: Transaction<Database>, propertyId: string, date: string, timezone: string, currency: string) {
  const until = dashboardDate(date, 1);
  const orders = (await sql<TodayOrder>`SELECT id, to_char(created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS date,
    created_at::text AS "registeredAt" FROM orders WHERE property_id=${propertyId}
    AND created_at >= (${date}::date::timestamp AT TIME ZONE ${timezone})
    AND created_at < (${until}::date::timestamp AT TIME ZONE ${timezone}) ORDER BY created_at,id`.execute(trx)).rows
    .map(order => ({ ...order, registeredAt: new Date(order.registeredAt).toISOString() }));
  const facts = await loadDashboardMoney(trx, propertyId, timezone, date, until, { includeChannel: true });
  return summarizeDashboardToday(date, currency, orders, facts);
}
