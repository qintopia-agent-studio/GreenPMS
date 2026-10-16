import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema.ts";
import { loadDashboardStays } from "./dashboard-stays.ts";
const { project } = vi.hoisted(() => ({ project: vi.fn() }));
vi.mock("./orders.ts", () => ({ projectOrderLifecycle: project }));
const unit = (id: string, building = "A", patch = {}) => ({ id, kind: "ROOM", parent_room_id: null,
  code: id, active: true, building_code: building, room_type_code: "standard", created_at: new Date("2026-01-01"), ...patch });
const units = [unit("a"), unit("f", "F", { active: false }), unit("f-new", "F"), unit("f-bed", "F", { kind: "BED", parent_room_id: "f-new" }), unit("b", "B")];
const order = { id: "mixed", status: "CHECKED_OUT", stay_type: "TRANSIENT", arrival_date: "2026-10-01", departure_date: "2026-10-08", stay_id: "stay", stay_status: "COMPLETED", member_id: null, member_contract_id: null, booking_channel_code: "WECOM" };
const intervals = [
  { inventoryUnitId: "a", arrivalDate: "2026-10-01", departureDate: "2026-10-03" },
  { inventoryUnitId: "f-bed", arrivalDate: "2026-10-03", departureDate: "2026-10-06" },
  { inventoryUnitId: "b", arrivalDate: "2026-10-06", departureDate: "2026-10-08" }
];
async function load(included: boolean) {
  const tables: Record<string, unknown[]> = {
    inventory_units: units, "orders as o": [order],
    "room_catalog_links as link": [{ unit_id: "f", asset_id: "f" }, { unit_id: "f-new", asset_id: "f" }],
    room_operating_statistics: [{ asset_id: "f", included }],
    room_catalog_changes: [{ created_at: new Date("2026-02-01"), effect: { action: "SAVE_ROOM", retireUnitIds: ["f"], insertUnits: [{ id: "f-new" }, { id: "f-bed" }] } }]
  };
  project.mockReturnValue({ effectiveArrangement: { intervals } });
  const trx = { selectFrom(table: string) { const q: any = new Proxy({}, { get: (_, key) => key === "execute" ? async () => tables[table] ?? [] : () => q }); return q; } } as unknown as Transaction<Database>;
  return loadDashboardStays(trx, "property", "2026-10-10", { from: "2026-10-01", to: "2026-10-08" }, "2026-10-24", "Asia/Shanghai");
}
describe("经营单元夜和容量使用相同资产范围", () => {
  it("keeps both ordinary-room segments of a mixed stay and excludes only dorm bed nights", async () => {
    const result = await load(false);
    expect(result.nights.map(night => [night.date, night.unitId, night.units])).toEqual([
      ["2026-10-01", "a", 1], ["2026-10-02", "a", 1], ["2026-10-06", "b", 1], ["2026-10-07", "b", 1]
    ]);
    expect(result.arrangements.get("mixed")).toEqual(intervals);
    expect(result.units).toHaveLength(5);
    expect(result.atomicUnits.map(unit => unit.id)).toEqual(["a", "b"]);
    expect(result.capacityFor("2026-10-01", 7, {}).value).toBe(14);
    expect(result.capacityFor("2026-10-01", 7, { building: "F" }).value).toBe(0);
    expect(result.reviews).toEqual([]);
  });
  it("re-enabling the asset restores all dates and its current child capacity", async () => {
    const result = await load(true);
    expect(result.nights).toHaveLength(7);
    expect(result.nights.filter(night => night.unitId === "f-bed")).toHaveLength(3);
    expect(result.capacityFor("2026-10-01", 7, {}).value).toBe(21);
    expect(result.atomicUnits.map(unit => unit.id)).toEqual(["a", "f-bed", "b"]);
  });
});
