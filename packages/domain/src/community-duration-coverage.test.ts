import { describe, expect, it } from "vitest";
import { communityMetrics, type CommunityStay } from "./community-metrics";

const period = { from: "2026-10-01", to: "2026-10-14" };
const today = "2026-10-14";
const stay = (overrides: Partial<CommunityStay> = {}): CommunityStay => ({
  orderId: "order-a", registrationKey: "registration-a", personKey: null,
  arrival: "2026-09-01", departure: "2026-11-01", current: true, free: false, category: null, ...overrides
});

describe("continuous residence duration coverage", () => {
  it("automatically counts all 31 residents without requiring documents or a manual review queue", () => {
    const stays = Array.from({ length: 31 }, (_, i) => stay({ orderId: `order-${i}`, registrationKey: `guest-${i}`,
      personKey: i === 30 ? "verified-person" : null, arrival: i === 30 ? "2026-10-13" : "2026-09-01" }));
    const c = communityMetrics(stays, [], period, today);
    expect(c.current.registered?.total).toBe(31);
    expect(c.duration).toEqual([{ nights: 1, current: 1, all: 1 }, { nights: 43, current: 30, all: 30 }]);
    expect(c.durationCoverage?.current).toMatchObject({ registrationBased: 30, pendingRegistrations: 0, pendingOrders: 0 });
    expect(c.durationCoverage?.all.issues).toHaveLength(0);
    expect(c.current.total).toBeNull();
    expect(c.visitors).toBeNull();
    expect(JSON.stringify(c.durationCoverage)).not.toContain("verified-person");
  });

  it("counts a registration only once across room segments and keeps unknown rosters as orders", () => {
    const missingRoster = stay({ orderId: "no-roster" });
    delete missingRoster.registrationKey;
    const c = communityMetrics([stay({ departure: "2026-10-10", current: false }), stay({ arrival: "2026-10-10" }), stay({ arrival: "2026-10-10" }),
      missingRoster], [], period, today);
    expect(c.durationCoverage?.current).toMatchObject({ registrationBased: 1, pendingRegistrations: 0, pendingOrders: 1 });
    expect(c.durationCoverage?.all).toMatchObject({ registrationBased: 1, pendingRegistrations: 0, pendingOrders: 1 });
    expect(c.durationCoverage?.all.issues).toHaveLength(1);
    expect(c.duration).toEqual([{ nights: 43, current: 1, all: 1 }]);
  });

  it("keeps current coverage independent of history, and scopes past/future coverage to actual occupancy", () => {
    const stays = [stay({ arrival: "2026-10-10" })];
    const past = communityMetrics(stays, [], { from: "2026-09-01", to: "2026-09-30" }, today);
    const future = communityMetrics(stays, [], { from: "2026-10-15", to: "2026-10-20" }, today);
    for (const c of [past, future]) {
      expect(c.durationCoverage?.current).toMatchObject({registrationBased:1,pendingRegistrations:0});
      expect(c.duration).toEqual([{ nights: 4, current: 1, all: 0 }]);
      expect(c.durationCoverage?.all).toEqual({ registrationBased: 0, pendingRegistrations: 0, pendingOrders: 0, issues: [] });
    }
  });

  it("excludes first-day checkouts, includes cutoff arrivals, and never includes reservations", () => {
    const c = communityMetrics([
      stay({ departure: period.from, current: false }),
      stay({ orderId: "today", registrationKey: "today", arrival: today }),
      stay({ orderId: "after", registrationKey: "after", arrival: "2026-10-15", current: false })
    ], [], period, today, [], [stay({ orderId: "reservation", arrival: today })]);
    expect(c.durationCoverage?.all).toMatchObject({ registrationBased: 1, pendingRegistrations: 0, issues: [] });
    expect(c.duration).toEqual([{ nights: 0, current: 1, all: 1 }]);
  });

  it("does not use an order's arrival date for a late-added guest even with a known identity", () => {
    const c = communityMetrics([
      stay({ historical: false, personKey: "known-guest", durationReviewReason: "独立入住日期待核对" }),
      stay({ current: false, departure: today, durationReviewReason: "独立入住日期待核对" })
    ], [], period, today);
    expect(c.current.total).toBe(1);
    expect(c.duration).toEqual([]);
    expect(c.durationCoverage?.current.pendingRegistrations).toBe(1);
    expect(c.durationCoverage?.all.pendingRegistrations).toBe(1);
  });

  it("keeps verified continuous stays merged across orders and separated returns as distinct person-trips", () => {
    const c = communityMetrics([
      stay({ personKey: "known", departure: "2026-09-20", current: false }),
      stay({ orderId: "continuation", registrationKey: "b", personKey: "known", arrival: "2026-09-20", departure: "2026-10-05", current: false }),
      stay({ orderId: "return", registrationKey: "c", personKey: "known", arrival: "2026-10-10" })
    ], [], period, today);
    expect(c.duration).toEqual([{ nights: 4, current: 1, all: 1 }, { nights: 34, current: 0, all: 1 }]);
    expect(c.durationCoverage?.all).toEqual({ registrationBased: 0, pendingRegistrations: 0, pendingOrders: 0, issues: [] });
  });
});


it("uses the full recorded stay for an undocumented guest, not the last move or the selected window", () => {
  const c = communityMetrics([
    stay({ departure: "2026-09-20", current: false }),
    stay({ arrival: "2026-09-20", departure: "2026-10-01", current: false }),
    stay({ arrival: "2026-10-01", departure: "2026-12-01" })
  ], [], { from: "2026-09-25", to: "2026-09-30" }, today);
  expect(c.duration).toEqual([{ nights: 29, current: 0, all: 1 }, { nights: 43, current: 1, all: 0 }]);
  expect(c.durationCoverage?.current.pendingRegistrations).toBe(0);
  expect(c.counts.NEW).toBe(0); // registration-local history is not unique visitor evidence
});

it("counts actual registrations separately when no cross-order relationship is recorded", () => {
  const c = communityMetrics([
    stay({ departure: "2026-10-01", current: false }),
    stay({ orderId: "another-order", registrationKey: "another-guest", arrival: "2026-10-01" })
  ], [], { from: "2026-09-01", to: today }, today);
  expect(c.duration).toEqual([{ nights: 13, current: 1, all: 1 }, { nights: 30, current: 0, all: 1 }]);
  expect(c.durationCoverage?.all).toMatchObject({ registrationBased: 2, pendingRegistrations: 0, issues: [] });
  expect(c.visitors).toBeNull();
  expect(c.counts.RENEWAL).toBe(0);
});

it("counts two undocumented roommates as two people, not one order or four room segments", () => {
  const c = communityMetrics([
    stay({ departure: "2026-10-01", current: false }), stay({ arrival: "2026-10-01" }),
    stay({ registrationKey: "roommate", departure: "2026-10-01", current: false }),
    stay({ registrationKey: "roommate", arrival: "2026-10-01" })
  ], [], period, today);
  expect(c.duration).toEqual([{ nights: 43, current: 2, all: 2 }]);
  expect(c.durationCoverage?.current).toMatchObject({ registrationBased: 2, pendingRegistrations: 0, issues: [] });
});
