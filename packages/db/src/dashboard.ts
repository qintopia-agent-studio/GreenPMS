import { sql, type Kysely, type Transaction } from "kysely";
import { dashboardDefinitionVersion, dashboardSources, DomainError, type DashboardQuery, type DashboardResponse, type DashboardDetailsResponse, type DashboardDetail, type DashboardMetric, type DashboardRange } from "@qintopia/contracts";
import { aggregateDashboardMoney, aggregateDashboardStays, dashboardDate, dashboardRange, dashboardSource, enumerateServiceDates, inDashboardRange, type DashboardStayNight } from "@qintopia/domain";
import { propertyLocalClockAt } from "./members.ts";
import { loadDashboardMoney, dashboardMoneyDetail } from "./dashboard-money.ts";
import { loadDashboardStays } from "./dashboard-stays.ts";
import { loadDashboardCurrent, loadDashboardFuture, newDashboardDetail } from "./dashboard-current.ts";
import type { Database } from "./schema.ts";

async function readDashboard(trx: Transaction<Database>, propertyId: string, query: DashboardQuery) {
  const property = await trx.selectFrom("properties").select(["id", "timezone", "currency", sql<Date>`transaction_timestamp()`.as("as_of")]).where("id", "=", propertyId).executeTakeFirst();
  if (!property) throw new DomainError("NOT_FOUND", "门店不存在", 404);
  const asOf = property.as_of.toISOString();
  const businessDate = propertyLocalClockAt(property.timezone, property.as_of).date;
  const { range, previousRange, nights: periodDays } = dashboardRange(query, businessDate);
  const futureUntil = dashboardDate(businessDate, query.futureDays ?? 14);
  const lodging = await loadDashboardStays(trx, propertyId, businessDate, { from: previousRange.from, to: range.to }, futureUntil, property.timezone);
  const moneyFacts = await loadDashboardMoney(trx, propertyId, property.timezone, previousRange.from, dashboardDate(range.to, 1));
  const { current, details: currentDetails } = await loadDashboardCurrent(trx, propertyId, businessDate, property.currency);
  const future = await loadDashboardFuture(trx, propertyId, businessDate, futureUntil, lodging);
  const matches = (night: DashboardStayNight) => (!query.building || night.building === query.building) && (!query.roomType || night.roomType === query.roomType) && (!query.source || night.source === query.source);
  const filteredNights = lodging.nights.filter(matches);
  const orderById = new Map(lodging.orders.map(order => [order.id, order]));
  const relevantReviews = (period: DashboardRange) => lodging.reviews.filter(review => {
    const order = orderById.get(review.orderId!);
    return order && order.arrival_date <= period.to && order.departure_date > period.from && (!query.source || dashboardSource(order) === query.source);
  });
  function totals(period: DashboardRange, selection = query, values = filteredNights) {
    const capacity = lodging.capacityFor(period.from, periodDays, selection);
    return aggregateDashboardStays(values.filter(night => inDashboardRange(night.date, period)), capacity.value, relevantReviews(period).length, capacity.reason);
  }
  const history = totals(range), previous = totals(previousRange);
  const currentNights = filteredNights.filter(night => inDashboardRange(night.date, range));
  const money = aggregateDashboardMoney(moneyFacts.filter(fact => inDashboardRange(fact.date, range)), property.currency);
  const groups = new Map<string, { building: string; roomType: string }>();
  for (const unit of lodging.atomicUnits.filter(unit => lodging.matchingUnit(unit, query))) {
    const room = unit.kind === "ROOM" ? unit : lodging.units.find(parent => parent.id === unit.parent_room_id);
    const building = room?.building_code ?? "未分配", roomType = unit.room_type_code ?? room?.room_type_code ?? "未分配";
    groups.set(JSON.stringify([building, roomType]), { building, roomType });
  }
  for (const night of currentNights) groups.set(JSON.stringify([night.building, night.roomType]), { building: night.building, roomType: night.roomType });
  const response: DashboardResponse = { propertyId, asOf, businessDate, timezone: property.timezone, currency: property.currency, definitionVersion: dashboardDefinitionVersion,
    range, previousRange, history, previous,
    occupancyChangePoints: history.occupancyRate !== null && previous.occupancyRate !== null ? history.occupancyRate - previous.occupancyRate : null,
    stayTrend: enumerateServiceDates(range.from, dashboardDate(range.to, 1)).map(date => {
      const values = currentNights.filter(night => night.date === date);
      const capacity = lodging.capacityFor(date, 1, query);
      const summary = aggregateDashboardStays(values, capacity.value, relevantReviews({ from: date, to: date }).length, capacity.reason);
      return { date, paid: summary.paidUnitNights, free: summary.freeUnitNights, capacity: capacity.value, quality: summary.quality };
    }),
    breakdown: [...groups.values()].sort((a, b) => a.building.localeCompare(b.building, "zh-CN") || a.roomType.localeCompare(b.roomType, "zh-CN")).map(group => ({ ...group, ...totals(range, { ...query, ...group }, currentNights.filter(night => night.building === group.building && night.roomType === group.roomType)) })),
    sources: dashboardSources.map(source => ({ source, unitNights: currentNights.filter(night => night.source === source).reduce((n, row) => n + row.units, 0) })),
    money, previousMoney: aggregateDashboardMoney(moneyFacts.filter(fact => inDashboardRange(fact.date, previousRange)), property.currency),
    moneyTrend: enumerateServiceDates(range.from, dashboardDate(range.to, 1)).map(date => ({ date, money: aggregateDashboardMoney(moneyFacts.filter(fact => fact.date === date), property.currency) })),
    current, future, filters: { buildings: [...new Set(lodging.units.map(unit => unit.building_code ?? "未分配"))].sort(), roomTypes: [...new Set(lodging.units.map(unit => unit.room_type_code ?? "未分配"))].sort() },
    warnings: [
      ...(history.reviewCount ? [`${history.reviewCount} 单历史住宿缺少完整证据；图表只含可核对部分，待核对单不因楼栋或房型筛选被隐藏。`] : []),
      ...(history.occupancyRate !== null && history.occupancyRate > 100 ? ["经营入住率超过100%，请核对重叠住宿与目录容量；未截断该异常。"] : []),
      ...(money.some(row => row.reviewCount > 0) ? ["资金来源未能全部分类，已隐藏对应币种净额；不能将可核对部分当作完整收退款。"] : []),
      ...(future.some(day => day.quality !== "COMPLETE") ? ["未来存在待核对库存；未知占用不视为空房，无法确认完整性时隐藏可售数。"] : []),
      ...(current.guestReviewOrders ? ["部分在住订单缺少登记住宿人，人数仅包含可核对部分。"] : [])
    ] };
  const stayDetails: DashboardDetail[] = currentNights.map(night => ({ ...newDashboardDetail(`night:${night.orderId}:${night.date}`, night.date),
    metric: night.source === "FREE" ? "FREE" : "PAID", label: `${night.building} / ${night.roomType}`, orderId: night.orderId, unitId: night.unitId, units: night.units,
    reason: `${night.source === "FREE" ? "免费占用" : "已履约付费住宿"}；按有效住宿安排逐日归属` }));
  const details = [...stayDetails, ...relevantReviews(range).map(review => ({ ...review, date: review.date < range.from ? range.from : review.date })), ...moneyFacts.filter(fact => inDashboardRange(fact.date, range)).map(dashboardMoneyDetail), ...currentDetails];
  return { response, details };
}
export async function getDashboard(db: Kysely<Database>, propertyId: string, query: DashboardQuery): Promise<DashboardResponse> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    await sql`set transaction read only`.execute(trx);
    return (await readDashboard(trx, propertyId, query)).response;
  });
}
export async function getDashboardDetails(db: Kysely<Database>, propertyId: string, query: DashboardQuery & { metric: DashboardMetric; page?: number; asOf?: string }): Promise<DashboardDetailsResponse> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    await sql`set transaction read only`.execute(trx);
    const { response, details } = await readDashboard(trx, propertyId, query);
    const page = query.page ?? 0, pageSize = 50;
    const items = details.filter(item => item.metric === query.metric).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    return { asOf: response.asOf, definitionVersion: response.definitionVersion, range: response.range, changedSinceSummary: Boolean(query.asOf && query.asOf !== response.asOf), items: items.slice(page * pageSize, (page + 1) * pageSize), total: items.length, page, pageSize };
  });
}
