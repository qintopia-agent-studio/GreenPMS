import { describe, expect, it } from "vitest";
import { operatingStatisticsScope } from "./operating-statistics.ts";
import { dailySalesCapacity, type CapacityUnit } from "./daily-sales-capacity.ts";
const unit = (id: string, patch: Partial<CapacityUnit> = {}): CapacityUnit => ({ id, kind: "ROOM", parent_room_id: null,
  active: true, building_code: "F", room_type_code: "double", created_at: new Date("2026-01-01"), ...patch });
const rooms = [unit("root", { active: false }), unit("current"), unit("bed", { kind: "BED", parent_room_id: "current" }), unit("ordinary")];
const links = [{ unit_id: "root", asset_id: "root" }, { unit_id: "current", asset_id: "root" }];
describe("经营住宿统计按实体资产继承", () => {
  it("defaults every property/building to included, even F, and leaves unknown units unknown", () => {
    const scope = operatingStatisticsScope(rooms, links, []);
    expect(rooms.every(room => scope.includesUnit(room.id))).toBe(true);
    expect(scope.classifyUnit("missing")).toBeNull();
  });
  it("excludes all versions and children but never another asset in the same building", () => {
    const scope = operatingStatisticsScope(rooms, links, [{ asset_id: "root", included: false }]);
    expect(rooms.map(room => scope.classifyUnit(room.id))).toEqual([false, false, false, true]);
    expect(scope.assetId("bed")).toBe("root");
    expect(operatingStatisticsScope(rooms, links, [{ asset_id: "root", included: true }]).includesUnit("bed")).toBe(true);
  });
  it("filters capacity without dropping the evidence required to replay excluded versions", () => {
    const scope = operatingStatisticsScope(rooms, links, [{ asset_id: "root", included: false }]);
    const changes = [{ created_at: new Date("2026-02-01"), effect: { action: "SAVE_ROOM", retireUnitIds: ["root"], insertUnits: [{ id: "current" }, { id: "bed" }] } }];
    const capacity = dailySalesCapacity(rooms, changes, date => date.toISOString().slice(0, 10), [], scope.includesUnit);
    expect(capacity.on("2026-01-02").value).toBe(1);
    expect(capacity.on("2026-03-02").value).toBe(1);
    expect(capacity.period("2026-01-30", "2026-02-03").value).toBe(4);
    expect(capacity.weight("bed", "2026-03-02")).toBe(0);
    expect(capacity.weight("missing", "2026-03-02")).toBeNull();
  });
  it("ignores excluded late/inactive inventory quality gaps, preserving included unknowns", () => {
    const late = [unit("ordinary"), unit("dorm", { created_at: new Date("2026-03-01"), active: false })];
    const scope = operatingStatisticsScope(late, [], [{ asset_id: "dorm", included: false }]);
    expect(dailySalesCapacity(late, [], date => date.toISOString().slice(0, 10), [], scope.includesUnit).on("2026-02-01").value).toBe(1);
    expect(dailySalesCapacity(late, [], date => date.toISOString().slice(0, 10)).on("2026-02-01").value).toBeNull();
  });
});
