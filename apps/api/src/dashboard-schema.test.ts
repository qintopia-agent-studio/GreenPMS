import { describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DashboardResponseSchema, DashboardDetailsResponseSchema } from "./dashboard";
import { dashboardFixture } from "../../../tests/helpers/dashboard-ui-fixture";

FormatRegistry.Set("date-time", value => Number.isFinite(Date.parse(value)));

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
