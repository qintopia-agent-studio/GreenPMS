import type { DashboardDetailsResponse, DashboardResponse } from "@qintopia/contracts";
import { communityMetrics, type CommunityStay } from "../../../../../packages/domain/src/community-metrics";
import { shiftDate } from "../dashboard-state";

export type Scenario = "complete" | "partial" | "zero" | "empty" | "error";
const today = "2026-10-12";
const currency = "CNY";
const base = (i: number, arrival: string, departure: string, current: boolean): CommunityStay => ({ orderId: `sample-order-${i}`, personKey: `sample-person-${i}`, arrival, departure, current, free: false, category: null });
export function sampleDashboard(propertyId: string, query: string, scenario: Scenario): DashboardResponse {
  const params = new URLSearchParams(query);
  const range = { from: params.get("from") ?? "2026-09-12", to: params.get("to") ?? "2026-10-11" };
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  if (days < 1 || days > 366 || range.to >= today) throw new Error("历史区间须为1–366个完整营业日，最晚至昨日。");
  const zero = scenario === "zero";
  const stays: CommunityStay[] = zero ? [] : [
    ...Array.from({ length: propertyId === "sample-b" ? 15 : 34 }, (_, i) => base(i, shiftDate("2026-08-25", (i * 7) % 46), shiftDate(today, 2 + i % 24), true)),
    ...Array.from({ length: 8 }, (_, i) => ({ ...base(40 + i, shiftDate("2026-09-02", i * 4), "2026-11-01", true), free: true, category: i < 5 ? "VOLUNTEER" : "RECEPTION" })),
    ...Array.from({ length: 14 }, (_, i) => base(60 + i, shiftDate("2026-08-18", i * 3), shiftDate("2026-09-18", i), false)),
    base(80, "2026-08-31", "2026-09-20", false), { ...base(80, "2026-09-20", "2026-10-10", false), orderId: "sample-continuation" },
    base(81, "2026-08-01", "2026-08-21", false), { ...base(81, "2026-09-01", "2026-10-11", false), orderId: "sample-forty-nights" },
    base(82, "2026-08-01", "2026-08-10", false), { ...base(82, "2026-09-16", "2026-10-08", false), orderId: "sample-return" }
  ];
  if (scenario === "partial") stays.push({ ...base(99, "2026-10-04", "2026-10-18", true), personKey: null });
  const community = communityMetrics(stays, zero ? [] : [
    { orderId: "sample-order-60", date: "2026-09-18", nights: 7, kind: "EARLY", reason: "工作行程调整，提前返回常住地。住客表示愿意下次再来，已记录回访意向。" },
    { orderId: "sample-order-62", date: "2026-09-20", nights: 3, kind: "EARLY", reason: "家庭事务，需要提前回家" },
    { orderId: "sample-order-0", date: "2026-10-02", nights: 10, kind: "RENEWAL", reason: "原订单延长10晚，连续居住不打断" },
    { orderId: "sample-order-2", date: "2026-10-05", nights: 20, kind: "RENEWAL", reason: "原订单延长20晚，会员权益付费住宿" }
  ], range, today, scenario === "partial" ? ["合成样本 sample-order-99：10月4日起的一条住宿人登记缺少跨单身份依据；此前日期不受影响。"] : []);
  const groups = [
    { building: "A栋", roomType: "shared_bath_double", weight: 18 },
    { building: "A栋", roomType: "ensuite_double", weight: 22 },
    { building: "B栋", roomType: "shared_bath_double", weight: 16 },
    { building: "B栋", roomType: "ensuite_double", weight: 16 }
  ].filter(row => (!params.get("building") || row.building === params.get("building")) && (!params.get("roomType") || row.roomType === params.get("roomType")));
  const source = params.get("source");
  const ratio = source ? ({ WECOM: .58, MEMBER: .27, YOUMUDAO: .15 }[source] ?? 0) : 1;
  const selectedCapacity = groups.reduce((n, row) => n + row.weight, 0);
  const stayTrend: DashboardResponse["stayTrend"] = Array.from({ length: days }, (_, i) => ({ date: shiftDate(range.from, i), paid: zero ? 0 : Math.round(selectedCapacity * (.60 + (i % 8) * .025) * ratio), free: zero || (source && source !== "FREE") ? 0 : Math.round(selectedCapacity * .09), capacity: selectedCapacity, quality: "COMPLETE" }));
  const paidNights = stayTrend.reduce((sum, day) => sum + day.paid, 0);
  const freeNights = stayTrend.reduce((sum, day) => sum + day.free, 0);
  const history = { paidUnitNights: paidNights, freeUnitNights: freeNights, capacityUnitNights: selectedCapacity * days, occupancyRate: selectedCapacity ? paidNights / (selectedCapacity * days) * 100 : null, quality: "COMPLETE" as const, reviewCount: 0, reason: "合成样本：每日有效销售单元按目录累计，维修不扣分母。" };
  const previousRange = { from: shiftDate(range.from, -days), to: shiftDate(range.from, -1) };
  const funds = sampleFunds(range, zero);
  const previousFunds = sampleFunds(previousRange, zero);
  let allocatedPaid = 0, allocatedFree = 0;
  const breakdown = groups.map((row, i) => {
    const paid = i === groups.length - 1 ? paidNights - allocatedPaid : Math.round(paidNights * row.weight / selectedCapacity);
    const free = i === groups.length - 1 ? freeNights - allocatedFree : Math.round(freeNights * row.weight / selectedCapacity);
    allocatedPaid += paid; allocatedFree += free;
    return { ...row, ...history, paidUnitNights: paid, freeUnitNights: free, capacityUnitNights: row.weight * days, occupancyRate: paid / (row.weight * days) * 100 };
  });
  const result: DashboardResponse = {
    propertyId, businessDate: today, asOf: `${today}T01:42:00Z`, timezone: "Asia/Shanghai", currency, definitionVersion: "2026-10-12.2",
    range, previousRange, history, previous: history, occupancyChangePoints: zero ? 0 : 4.2,
    community, current: { todayOrders: zero ? 0 : 3, todayCollections: [{currency, amountMinor: zero ? "0" : "27720", count: zero ? 0 : 1}], todayCollectionReviewCount: 0, paidGuests: community.current.paid, freeGuests: community.current.volunteer + community.current.reception, guestReviewOrders: scenario === "partial" ? 1 : 0, arrivals: zero ? 0 : 4, departures: zero ? 0 : 2, overdue: zero ? 0 : 1, debts: [{ currency, amountMinor: zero ? "0" : "368000", count: zero ? 0 : 3 }], retained: [{ currency, amountMinor: zero ? "0" : "120000", count: zero ? 0 : 2 }] },
    stayTrend,
    breakdown, sources: [{ source: "WECOM", unitNights: Math.round(paidNights * .58) }, { source: "MEMBER", unitNights: Math.round(paidNights * .27) }, { source: "YOUMUDAO", unitNights: Math.round(paidNights * .15) }, { source: "FREE", unitNights: freeNights }], money: funds.money, previousMoney: previousFunds.money, moneyTrend: funds.trend,
    future: Array.from({ length: Number(params.get("futureDays") ?? 14) }, (_, i) => ({ date: shiftDate(today, i), paid: zero ? 0 : Math.max(15, 53 - Math.floor(i / 3) * 3 + i % 3), free: zero ? 0 : i < 14 ? 8 : 6, maintenance: i < 5 ? 2 : 0, review: scenario === "partial" && i < 3 ? 1 : 0, availableRooms: 4 + Math.floor(i / 3), availableBeds: 8 + Math.floor(i / 2), capacity: 72, quality: scenario === "partial" && i < 3 ? "PARTIAL" : "COMPLETE" })),
    futureReviewCount: scenario === "partial" ? 1 : 0, filters: { buildings: ["A栋", "B栋"], roomTypes: ["shared_bath_double", "ensuite_double"], roomTypeLabels: { shared_bath_double: "公卫双人间", ensuite_double: "独卫双人间" } }, warnings: []
  };
  if (scenario === "empty") { result.community.trend = []; result.community.duration = []; result.community.records = []; result.community.counts = { NEW: 0, RETURN: 0, RENEWAL: 0, DUE: 0, EARLY: 0 }; result.community.current = { date: today, total: null, paid: 0, volunteer: 0, reception: 0, otherFree: 0, unlinked: 1 }; result.community.dailyAverage = null; result.community.visitors = null; result.community.reasons = ["样本场景：未返回住客名单与逐日资料，不代表实际人数为零。"]; result.future = []; }
  return result;
}
function sampleFunds(range: DashboardResponse["range"], zero: boolean) {
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  const total = { collectedMinor: 0n, refundedMinor: 0n, correctedMinor: 0n, netMinor: 0n };
  const trend = Array.from({ length: days }, (_, i) => {
    const date = shiftDate(range.from, i);
    const index = Math.floor(Date.parse(date) / 86400000);
    const collectedMinor = zero || index % 6 === 0 ? 0n : BigInt(45000 + (index * 7919) % 920000);
    const refundedMinor = zero || index % 7 !== 0 ? 0n : BigInt(15000 + (index * 1237) % 180000);
    const correctedMinor = zero || index % 11 !== 0 ? 0n : -BigInt(20000 + (index * 431) % 220000);
    const netMinor = collectedMinor - refundedMinor + correctedMinor;
    total.collectedMinor += collectedMinor;
    total.refundedMinor += refundedMinor;
    total.correctedMinor += correctedMinor;
    total.netMinor += netMinor;
    return { date, money: [{ currency, collectedMinor: String(collectedMinor), refundedMinor: String(refundedMinor), correctedMinor: String(correctedMinor), netMinor: String(netMinor), reviewCount: 0, reviewMinor: "0" }] };
  });
  return { trend, money: [{ currency, collectedMinor: String(total.collectedMinor), refundedMinor: String(total.refundedMinor), correctedMinor: String(total.correctedMinor), netMinor: String(total.netMinor), reviewCount: 0, reviewMinor: "0" }] };
}

export function sampleDetails(propertyId: string, query: string, scenario: Scenario): DashboardDetailsResponse {
  const params = new URLSearchParams(query);
  const data = sampleDashboard(propertyId, query, scenario);
  const page = Number(params.get("page") ?? 0), total = scenario === "zero" ? 0 : 56;
  return { asOf: data.asOf, definitionVersion: data.definitionVersion, range: data.range, changedSinceSummary: false, page, pageSize: 50, total, items: Array.from({ length: Math.min(50, Math.max(0, total - page * 50)) }, (_, i) => ({ id: `sample-fact-${page * 50 + i}`, date: shiftDate(data.range.from, (page * 50 + i) % 7), metric: "PAID", label: `合成住宿事实 ${page * 50 + i + 1}`, orderId: `sample-order-${page * 50 + i}`, memberId: null, unitId: null, units: 1, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "合成验收样本，仅验证明细分页与返回；不代表真实业务成功。" })) };
}
