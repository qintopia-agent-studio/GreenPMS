import { describe, expect, it } from "vitest";
import { planStayDateChangeTimeline, timelinePairDiff, timelineRuns } from "./stay-timeline-plan.ts";

const currentTimeline = [
  { serviceDate: "2026-08-10", inventoryUnitId: "room_a" },
  { serviceDate: "2026-08-11", inventoryUnitId: "room_a" },
  { serviceDate: "2026-08-12", inventoryUnitId: "room_b" },
  { serviceDate: "2026-08-13", inventoryUnitId: "room_b" }
];

function plan(newArrivalDate: string, newDepartureDate: string) {
  return planStayDateChangeTimeline({
    currentTimeline,
    oldArrivalDate: "2026-08-10",
    oldDepartureDate: "2026-08-14",
    newArrivalDate,
    newDepartureDate
  });
}

describe("Stage 11 Plan B stay timeline", () => {
  it("shifts every move boundary for an equal whole-stay shift", () => {
    expect(timelineRuns(plan("2026-08-12", "2026-08-16"))).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-12", departureDate: "2026-08-14" },
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-14", departureDate: "2026-08-16" }
    ]);
  });

  it("preserves in-range move boundaries and extends or crops only the ends", () => {
    expect(timelineRuns(plan("2026-08-09", "2026-08-14"))).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-09", departureDate: "2026-08-12" },
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-12", departureDate: "2026-08-14" }
    ]);
    expect(timelineRuns(plan("2026-08-11", "2026-08-16"))).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-11", departureDate: "2026-08-12" },
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-12", departureDate: "2026-08-16" }
    ]);
    expect(timelineRuns(plan("2026-08-09", "2026-08-15"))).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-09", departureDate: "2026-08-12" },
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-12", departureDate: "2026-08-15" }
    ]);
  });

  it("drops a move boundary when it lands on the new interval edge", () => {
    expect(timelineRuns(plan("2026-08-10", "2026-08-12"))).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-10", departureDate: "2026-08-12" }
    ]);
    expect(timelineRuns(plan("2026-08-12", "2026-08-14"))).toEqual([
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-12", departureDate: "2026-08-14" }
    ]);
  });

  it("uses the original first or last unit when the new interval is disjoint", () => {
    expect(timelineRuns(plan("2026-08-05", "2026-08-07"))).toEqual([
      { inventoryUnitId: "room_a", arrivalDate: "2026-08-05", departureDate: "2026-08-07" }
    ]);
    expect(timelineRuns(plan("2026-08-16", "2026-08-18"))).toEqual([
      { inventoryUnitId: "room_b", arrivalDate: "2026-08-16", departureDate: "2026-08-18" }
    ]);
  });

  it("diffs inventory by service-date and inventory-unit pairs", () => {
    expect(timelinePairDiff(
      [{ serviceDate: "2026-08-12", inventoryUnitId: "room_a" }],
      [{ serviceDate: "2026-08-12", inventoryUnitId: "room_b" }]
    )).toEqual({
      preserved: [],
      released: [{ serviceDate: "2026-08-12", inventoryUnitId: "room_a" }],
      added: [{ serviceDate: "2026-08-12", inventoryUnitId: "room_b" }]
    });
  });
});
