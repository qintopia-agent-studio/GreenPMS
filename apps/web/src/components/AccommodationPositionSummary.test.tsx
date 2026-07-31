import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccommodationPositionSummary, accommodationPositionItems } from "./AccommodationPositionSummary";

const units = [
  { id: "room_101", code: "101", name: "标准间" },
  { id: "room_102", code: "102", name: "双人间" },
  { id: "room_103", code: "103", name: "单人间" }
];

function view(state: "NOT_CHECKED_IN" | "IN_HOUSE", businessDate: string) {
  return {
    effectiveArrangement: {
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-05",
      businessDate,
      presentation: "CURRENT" as const,
      intervals: [
        { inventoryUnitId: "room_101", arrivalDate: "2026-08-01", departureDate: "2026-08-03" },
        { inventoryUnitId: "room_102", arrivalDate: "2026-08-03", departureDate: "2026-08-04" },
        { inventoryUnitId: "room_103", arrivalDate: "2026-08-04", departureDate: "2026-08-05" }
      ]
    },
    fulfillment: { state, checkIn: null, checkOut: null, checkInRevocation: null }
  } as never;
}

describe("AccommodationPositionSummary", () => {
  it("shows a reserved stay as a planned first room followed by planned moves", () => {
    const items = accommodationPositionItems(view("NOT_CHECKED_IN", "2026-07-31"));
    expect(items.map((item) => [item.label, item.inventoryUnitId, item.effectiveDate])).toEqual([
      ["计划住宿位置", "room_101", "2026-08-01"],
      ["计划换至", "room_102", "2026-08-03"],
      ["计划换至", "room_103", "2026-08-04"]
    ]);
  });

  it("shows only the current position and future moves for an in-house stay", () => {
    const current = view("IN_HOUSE", "2026-08-03");
    expect(accommodationPositionItems(current).map((item) => [item.label, item.inventoryUnitId])).toEqual([
      ["当前住宿位置", "room_102"],
      ["计划换至", "room_103"]
    ]);
    const html = renderToStaticMarkup(<AccommodationPositionSummary view={current} inventoryUnits={units} />);
    expect(html).toContain("当前住宿位置");
    expect(html).toContain("102 · 双人间");
    expect(html).toContain("计划换至");
    expect(html).toContain("103 · 单人间");
    expect(html).not.toContain("101 · 标准间");
  });

  it.each([
    ["planned departure business date", "2026-08-05"],
    ["overdue in-house business date", "2026-08-06"]
  ])("keeps the final accommodation position for an in-house stay on the %s", (_scenario, businessDate) => {
    expect(accommodationPositionItems(view("IN_HOUSE", businessDate))).toEqual([
      {
        label: "当前住宿位置",
        inventoryUnitId: "room_103",
        effectiveDate: businessDate
      }
    ]);
  });
});
