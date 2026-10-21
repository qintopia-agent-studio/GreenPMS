import { describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DashboardResponseSchema, DashboardDetailsResponseSchema } from "./dashboard";
import { dashboardFixture } from "../../../tests/helpers/dashboard-ui-fixture";
import buildSerializer from "fast-json-stringify";

FormatRegistry.Set("date-time", value => Number.isFinite(Date.parse(value)));

it("实际响应序列化保留居民已确认值、核对入口、待认领金额及同步状态", () => {
  const summary = dashboardFixture(new URL("http://localhost/api/v1/properties/demo/dashboard"));
  summary.community.residentCurrent = {date:summary.businessDate,total:null,longStay:25,member:null,memberReview:2,knownTotal:25,knownMember:1,residentReview:1,reviewItems:[{orderId:"order_review",memberId:"member_review",reason:"缺少明确身份依据"}]};
  summary.current.todayUnclaimed = [{currency:"CNY",amountMinor:"-12500",count:1}];
  summary.current.paymentSync = {enabled:true,lastSyncedAt:"2026-10-09T03:30:00Z",hasError:false};
  const response = JSON.parse(buildSerializer(DashboardResponseSchema)(summary));
  expect(response.community.residentCurrent).toEqual(summary.community.residentCurrent);
  expect(response.current.todayUnclaimed).toEqual(summary.current.todayUnclaimed);
  expect(response.current.paymentSync).toEqual(summary.current.paymentSync);
  expect(Value.Check(DashboardResponseSchema,{...summary,community:{...summary.community,residentCurrent:{...summary.community.residentCurrent,knownMember:-1}}})).toBe(false);
});

it("财务序列化保留原流水、发生和同步日期，未认领仍为独立状态", () => {
  const detail = {asOf:"2026-10-09T04:00:00Z",definitionVersion:"2026-10-21.1",range:{from:"2026-09-09",to:"2026-10-08"},changedSinceSummary:false,page:0,pageSize:50,total:1,items:[{id:"bill:1",date:"2026-10-09",metric:"TODAY_COLLECTIONS",label:"企微退款待认领",orderId:null,memberId:null,unitId:null,units:null,amountMinor:"-12500",currency:"CNY",registeredAt:"2026-10-09T03:35:00Z",businessDate:null,reason:"未计入已确认合计",sourceType:"WECOM",claimStatus:"UNCLAIMED",externalBillId:"bill_1",refundReference:"refund-test",originalTransactionReference:"collect-test",sourceOccurredAt:"2026-10-08T23:00:00Z",sourceDiscoveredAt:"2026-10-09T03:35:00Z",sourceUpdatedAt:"2026-10-09T03:40:00Z"}]};
  expect(JSON.parse(buildSerializer(DashboardDetailsResponseSchema)(detail)).items).toEqual(detail.items);
});

describe("dashboard future review response contract", () => {
  it("requires a non-negative future review count and permits linked future facts outside history", () => {
    const summary = { ...dashboardFixture(new URL("http://localhost/api/v1/properties/demo/dashboard")), futureReviewCount: 1 };
    expect(Value.Check(DashboardResponseSchema, summary)).toBe(true);
    const withDuration = (duration: unknown[]) => ({ ...summary, community: { ...summary.community, duration } });
    expect(Value.Check(DashboardResponseSchema, withDuration([{ nights: 40, current: 1, all: 2 }]))).toBe(true);
    expect(Value.Check(DashboardResponseSchema, withDuration([{ nights: 40, current: 1, completed: 2 }]))).toBe(false);
    expect(Value.Check(DashboardResponseSchema, withDuration([{ nights: 40, current: 1, all: -1 }]))).toBe(false);
    expect(Value.Check(DashboardResponseSchema, { ...summary, community: { ...summary.community, current: { ...summary.community.current, unclassified: 1 }, records: [{ orderId: "order_1", date: "2026-10-08", nights: 7, reason: "工作行程", kind: "EARLY", people: 1 }] }, filters: { ...summary.filters, roomTypeLabels: { custom: "山景房" } } })).toBe(true);
    expect(Value.Check(DashboardResponseSchema, { ...summary, community: { ...summary.community, current: { ...summary.community.current, unclassified: -1 } } })).toBe(false);
    expect(Value.Check(DashboardResponseSchema, { ...summary, futureReviewCount: -1 })).toBe(false);
    const { futureReviewCount: _, ...missing } = summary;
    expect(Value.Check(DashboardResponseSchema, missing)).toBe(false);
    const detail = {
      asOf: summary.asOf, definitionVersion: summary.definitionVersion, range: summary.range,
      changedSinceSummary: false, total: 1, page: 0, pageSize: 50,
      items: [{ id: "future-review:order_1", date: "2026-10-12", metric: "REVIEW", label: "未来库存待核对",
        orderId: "order_1", memberId: null, unitId: null, units: null, amountMinor: null, currency: null,
        registeredAt: null, businessDate: null, reason: "订单住宿时间线或履约证据不完整；影响2026-10-12至2026-10-14" }]
    };
    expect(Value.Check(DashboardDetailsResponseSchema, detail)).toBe(true);
    expect(Value.Check(DashboardDetailsResponseSchema, {
      ...detail,
      items: [{ ...detail.items[0], sourceType: "MEMBERSHIP", claimStatus: "CONFIRMED", sourceFactId: "membership_fact_1",
        referencesFactId: "collection_fact_1", reversesFactId: null, correctsFactId: null,
        syncStatus: "WORKER_SYNCED", evidenceStatus: "COMPLETE" }]
    })).toBe(true);
    expect(Value.Check(DashboardDetailsResponseSchema, {
      ...detail,
      items: [{ ...detail.items[0], sourceType: "NOT_A_SOURCE" }]
    })).toBe(false);
  });
});

it("publishes registration counts separately from unresolved identity totals", () => {
  const summary = dashboardFixture(new URL("http://localhost/api/v1/properties/demo/dashboard"));
  summary.community.current = {date:summary.businessDate,total:null,paid:0,volunteer:0,reception:0,otherFree:0,unlinked:36,registered:{total:36,paid:31,volunteer:5,reception:0,otherFree:0}};
  expect(Value.Check(DashboardResponseSchema,summary)).toBe(true);
  summary.community.current.registered!.total=-1;
  expect(Value.Check(DashboardResponseSchema,summary)).toBe(false);
});

it("serializes duration evidence gaps independently of verified people and rejects invalid counts", () => {
  const summary = dashboardFixture(new URL("http://localhost/api/v1/properties/demo/dashboard"));
  summary.community.identityApproximate = true;
  summary.community.durationCoverage = {
    current: { registrationBased: 30, pendingRegistrations: 0, pendingOrders: 1, issues: [{ orderId: "order_review", reason: "连续入住起点待核对" }] },
    all: { pendingRegistrations: 0, pendingOrders: 0, issues: [] }
  };
  expect(Value.Check(DashboardResponseSchema, summary)).toBe(true);
  summary.community.durationCoverage.current.registrationBased = -1;
  expect(Value.Check(DashboardResponseSchema, summary)).toBe(false);
});
