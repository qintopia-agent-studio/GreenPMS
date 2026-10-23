import { describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DashboardResponseSchema, DashboardDetailsResponseSchema } from "./dashboard";
import { dashboardFixture } from "../../../tests/helpers/dashboard-ui-fixture";
import buildSerializer from "fast-json-stringify";

FormatRegistry.Set("date-time", value => Number.isFinite(Date.parse(value)));

it("实际响应序列化保留居民已确认值、核对入口、待认领金额及同步状态", () => {
  const summary = dashboardFixture(new URL("http://localhost/api/v1/properties/demo/dashboard"));
  summary.community.residentCurrent = {date:summary.businessDate,total:null,longStay:25,member:null,memberReview:2,knownTotal:25,knownMember:1,residentReview:1,reviewItems:[{orderId:"order_review",memberId:"member_review",reason:"权益核销记录不完整"}]};
  summary.current.todayUnclaimed = [{currency:"CNY",amountMinor:"-12500",count:1}];
  summary.current.paymentSync = {enabled:true,lastSyncedAt:"2026-10-09T03:30:00Z",hasError:false};
  const response = JSON.parse(buildSerializer(DashboardResponseSchema)(summary));
  expect(response.community.residentCurrent).toEqual(summary.community.residentCurrent);
  expect(response.current.todayUnclaimed).toEqual(summary.current.todayUnclaimed);
  expect(response.current.paymentSync).toEqual(summary.current.paymentSync);
  expect(Value.Check(DashboardResponseSchema,{...summary,community:{...summary.community,residentCurrent:{...summary.community.residentCurrent,knownMember:-1}}})).toBe(false);
});

it("实际序列化保留逐住客名单与权益使用依据，不输出证件、电话或内部匹配键", () => {
  const summary = dashboardFixture(new URL("http://localhost/api/v1/properties/demo/dashboard"));
  const safePerson = { orderId: "order_one", memberId: "member_one", occupantId: "occupant_one", occupantName: "阿青（青女士）", memberName: "阿青（青女士）", roomCode: "201", arrivalDate: "2026-10-17", departureDate: "2026-10-25" };
  const unsafePerson = { ...safePerson, documentNumber: "PRIVATE-DOCUMENT", phone: "PRIVATE-PHONE", personKey: "PRIVATE-IDENTITY" };
  summary.community.residentCurrent = { date: summary.businessDate, total: null, longStay: 1, member: null, memberReview: 1,
    knownTotal: 1, knownMember: 1, residentReview: 1,
    memberItems: [{ ...unsafePerson, basis: "MEMBER_ENTITLEMENT" }],
    reviewItems: [{ ...unsafePerson, occupantId: "occupant_two", occupantName: "住客乙", reasonLabel: "权益使用记录待核对", reason: "已记录权益覆盖，但缺少对应的核销事实。" }] };
  const serialized = buildSerializer(DashboardResponseSchema)(summary);
  const response = JSON.parse(serialized);
  expect(response.community.residentCurrent.memberItems).toEqual([{ ...safePerson, basis: "MEMBER_ENTITLEMENT" }]);
  expect(response.community.residentCurrent.reviewItems[0]).toMatchObject({ occupantId: "occupant_two", occupantName: "住客乙", memberName: "阿青（青女士）", reasonLabel: "权益使用记录待核对" });
  expect(serialized).not.toContain("PRIVATE-");
  expect(serialized).not.toContain("personKey");
  expect(Value.Check(DashboardResponseSchema, { ...summary, community: { ...summary.community, residentCurrent: {
    ...summary.community.residentCurrent, memberItems: [{ ...safePerson, basis: "SAME_NAME" }]
  } } })).toBe(false);
});

it("财务序列化保留原流水、发生和同步日期，未认领仍为独立状态", () => {
  const detail = {asOf:"2026-10-09T04:00:00Z",definitionVersion:"2026-10-22.3",range:{from:"2026-09-09",to:"2026-10-08"},changedSinceSummary:false,page:0,pageSize:50,total:1,items:[{id:"bill:1",date:"2026-10-09",metric:"TODAY_COLLECTIONS",label:"企微退款待认领",orderId:null,memberId:null,unitId:null,units:null,amountMinor:"-12500",currency:"CNY",registeredAt:"2026-10-09T03:35:00Z",businessDate:null,reason:"未计入已确认合计",sourceType:"WECOM",claimStatus:"UNCLAIMED",externalBillId:"bill_1",refundReference:"refund-test",originalTransactionReference:"collect-test",sourceOccurredAt:"2026-10-08T23:00:00Z",sourceDiscoveredAt:"2026-10-09T03:35:00Z",sourceUpdatedAt:"2026-10-09T03:40:00Z"}]};
  expect(JSON.parse(buildSerializer(DashboardDetailsResponseSchema)(detail)).items).toEqual(detail.items);
});

it("接待明细保留有效住客、房间和订单日期，并过滤身份及联系方式", () => {
  const safeReception = { occupants: [{ name: "小青（青女士）", isPrimary: true }, { name: "同行人", isPrimary: false }], roomCode: "F05-2", buildingCode: "F", arrivalDate: "2026-10-01", departureDate: "2026-10-23", status: "CHECKED_IN" };
  const detail = { asOf: "2026-10-23T04:00:00Z", definitionVersion: "2026-10-22.3", range: { from: "2026-09-23", to: "2026-10-22" }, changedSinceSummary: false, page: 0, pageSize: 50, total: 1, items: [{
    id: "departure:order", date: "2026-10-23", metric: "DEPARTURE", label: "今日待离", orderId: "order", memberId: null, unitId: null, units: 1, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "计划今日离店，不自动视为已退房",
    reception: { ...safeReception, phone: "PRIVATE-PHONE", occupants: safeReception.occupants.map(person => ({ ...person, documentNumber: "PRIVATE-DOCUMENT" })) }
  }] };
  const serialized = buildSerializer(DashboardDetailsResponseSchema)(detail);
  expect(JSON.parse(serialized).items[0].reception).toEqual(safeReception);
  expect(serialized).not.toContain("PRIVATE-");
  expect(Value.Check(DashboardDetailsResponseSchema, detail)).toBe(true);
  expect(Value.Check(DashboardDetailsResponseSchema, { ...detail, items: [{ ...detail.items[0], reception: { ...safeReception, occupants: [], roomCode: null, buildingCode: null, status: "RESERVED" } }] })).toBe(true);
  expect(Value.Check(DashboardDetailsResponseSchema, { ...detail, items: [{ ...detail.items[0], reception: { ...safeReception, status: "CHECKED_OUT" } }] })).toBe(false);
});

it("经营跟进序列化保留独立资金归属、订单全状态和多房床，过滤证件及联系方式", () => {
  const orderSummary = { occupants: [{ name: "来源住客", isPrimary: true }], rooms: [{ roomCode: "F01", buildingCode: "F" }, { roomCode: "F05-2", buildingCode: "F" }], arrivalDate: "2026-10-01", departureDate: "2026-10-23", status: "CANCELLED" };
  const detail = { asOf: "2026-10-23T04:00:00Z", definitionVersion: "2026-10-22.3", range: { from: "2026-09-23", to: "2026-10-22" }, changedSinceSummary: false, page: 0, pageSize: 50, total: 1, items: [{
    id: "retained:lot", date: "2026-10-23", metric: "RETAINED", label: "留存待用", orderId: "order", memberId: null, unitId: null, units: null, amountMinor: "12000", currency: "CNY", registeredAt: null, businessDate: null, reason: "当前可用留存",
    retainedOwnerName: "代订客户", retainedOwnerContact: "PRIVATE-CONTACT", orderSummary: { ...orderSummary, occupants: [{ ...orderSummary.occupants[0], phone: "PRIVATE-PHONE", documentNumber: "PRIVATE-DOCUMENT" }] }
  }] };
  const serialized = buildSerializer(DashboardDetailsResponseSchema)(detail);
  expect(JSON.parse(serialized).items[0]).toMatchObject({ retainedOwnerName: "代订客户", orderSummary, amountMinor: "12000" });
  expect(serialized).not.toContain("PRIVATE-");
  for (const status of ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"]) {
    expect(Value.Check(DashboardDetailsResponseSchema, { ...detail, items: [{ ...detail.items[0], orderSummary: { ...orderSummary, status } }] })).toBe(true);
  }
  expect(Value.Check(DashboardDetailsResponseSchema, { ...detail, items: [{ ...detail.items[0], orderSummary: { ...orderSummary, status: "DRAFT" } }] })).toBe(false);
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
