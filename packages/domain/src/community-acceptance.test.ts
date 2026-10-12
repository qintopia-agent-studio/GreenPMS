import { describe, expect, it } from "vitest";
import { communityMetrics, type CommunityStay } from "./community-metrics";
const range = { from: "2026-01-01", to: "2026-02-10" };
const stay = (patch: Partial<CommunityStay> = {}): CommunityStay => ({ orderId: "one", personKey: "a", arrival: "2026-01-01", departure: "2026-01-21", current: false, free: false, category: null, ...patch });
describe("community confirmed acceptance boundaries", () => {
  it("counts people separately from order records and excludes only the continuing guest from early departure", () => {
    const result = communityMetrics([stay(), stay({ personKey: "b" }), stay({ orderId: "next", arrival: "2026-01-21", departure: "2026-02-10" })], [{ orderId: "one", date: "2026-01-21", nights: 7, reason: "工作行程", kind: "EARLY" }], range, "2026-02-11");
    expect(result.counts.NEW).toBe(2);
    expect(result.records.filter(row => row.kind === "NEW").map(row => [row.nights, row.people]).sort()).toEqual([[20, 1], [40, 1]]);
    const together = communityMetrics([stay(), stay({ personKey: "b" })], [], range, "2026-02-11");
    expect(together.counts.NEW).toBe(1);
    expect(together.records.find(row => row.kind === "NEW")).toMatchObject({ people: 2 });
    expect(result.records.find(row => row.kind === "EARLY")).toMatchObject({ people: 1, nights: 7 });
    expect(result.visitors).toBe(2);
  });
  it("does not hide a confirmed chained departure that is still within seven days", () => {
    const result = communityMetrics([stay({ current: true, departure: "2026-01-05" })], [], range, "2026-01-03", [], [stay({ orderId: "reserved", arrival: "2026-01-05", departure: "2026-01-08" })]);
    expect(result.records.find(row => row.kind === "DUE")).toMatchObject({ date: "2026-01-08", orderId: "reserved", nights: 2 });
  });
  it("uses completed nights for an overdue current stay rather than freezing on the planned departure", () => {
    expect(communityMetrics([stay({ current: true, departure: "2026-01-05" })], [], range, "2026-01-08").duration).toEqual([{ nights: 7, current: 1, completed: 0 }]);
  });
  it("does not spread unknown identities to dates outside their stay", () => {
    const result = communityMetrics([stay(), stay({ personKey: null, orderId: "missing", arrival: "2026-01-05", departure: "2026-01-07" })], [], range, "2026-02-11");
    expect(result.trend[0]!.total).toBe(1);
    expect(result.trend[4]!.total).toBeNull();
    expect(result.trend[6]!.total).toBe(1);
  });
  it("counts current-only evidence without inventing historical nights or a residence chain", () => {
    const result = communityMetrics([stay({ current: true, historical: false })], [], range, "2026-01-10");
    expect(result.current.total).toBe(1);
    expect(result.trend[0]!.total).toBe(0);
    expect(result.duration).toEqual([]);
    expect(result.records).toEqual([]);
  });
  it("deduplicates unlinked room-move segments by the stable in-order registration", () => {
    const result = communityMetrics([stay({ personKey: null, registrationKey: "occupant" }), stay({ personKey: null, registrationKey: "occupant" })], [], range, "2026-02-11");
    expect(result.trend[0]!.unlinked).toBe(1);
    expect(result.trend[0]!.total).toBeNull();
  });
  it("preserves known totals through classification conflicts without assigning a guessed category", () => {
    const result = communityMetrics([stay(), stay({ orderId: "free", free: true, category: "VOLUNTEER" })], [], range, "2026-02-11");
    expect(result.visitors).toBe(1);
    expect(result.trend[0]).toMatchObject({ total: 1, unclassified: 1, unlinked: 0, paid: 0 });
    expect(result.dailyAverage).not.toBeNull();
  });
});
