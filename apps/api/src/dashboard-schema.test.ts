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
    expect(Value.Check(DashboardResponseSchema, { ...summary, community: { ...summary.community, current: { ...summary.community.current, unclassified: 1 }, records: [{ orderId: "order_1", date: "2026-10-08", nights: 7, reason: "工作行程", kind: "EARLY", people: 1 }] }, filters: { ...summary.filters, roomTypeLabels: { custom: "山景房" } } })).toBe(true);
    expect(Value.Check(DashboardResponseSchema, { ...summary, community: { ...summary.community, current: { ...summary.community.current, unclassified: -1 } } })).toBe(false);
    expect(Value.Check(DashboardResponseSchema, { ...summary, futureReviewCount: -1 })).toBe(false);
    const { futureReviewCount: _, ...missing } = summary;
    expect(Value.Check(DashboardResponseSchema, missing)).toBe(false);
    expect(Value.Check(DashboardDetailsResponseSchema, {
      asOf: summary.asOf, definitionVersion: summary.definitionVersion, range: summary.range,
      changedSinceSummary: false, total: 1, page: 0, pageSize: 50,
      items: [{ id: "future-review:order_1", date: "2026-10-12", metric: "REVIEW", label: "未来库存待核对",
        orderId: "order_1", memberId: null, unitId: null, units: null, amountMinor: null, currency: null,
        registeredAt: null, businessDate: null, reason: "订单住宿时间线或履约证据不完整；影响2026-10-12至2026-10-14" }]
    })).toBe(true);
  });
});
