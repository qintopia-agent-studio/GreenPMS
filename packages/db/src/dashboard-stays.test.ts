import { describe, expect, it } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema";
import { loadDashboardStays } from "./dashboard-stays";

// Read-only fixtures exercise the production loader without a database/reset entry point.
function readOnlyFixture(rows: Record<string, unknown[]>): Transaction<Database> {
  return { selectFrom(table: string) {
    const builder: object = new Proxy({}, { get(_, name) {
      if (name === "execute") return async () => rows[table] ?? [];
      if (["select", "selectAll", "where", "orderBy", "innerJoin", "leftJoin"].includes(String(name))) return () => builder;
      throw new Error(`Unsupported fixture operation: ${String(name)}`);
    }});
    return builder;
  }} as unknown as Transaction<Database>;
}
const unit = { id: "room", kind: "ROOM", parent_room_id: null, code: "101", active: true, building_code: "1", room_type_code: "shared_bath_double", created_at: new Date("2026-01-01") };
const range = { from: "2026-10-01", to: "2026-10-10" };
function load(rows: Record<string, unknown[]> = {}, history = range) {
  return loadDashboardStays(readOnlyFixture({ inventory_units: [unit], ...rows }), "demo", "2026-10-11", history, "2026-10-25", "Asia/Shanghai");
}
const reservation = { id: "unverifiable", status: "RESERVED", stay_type: "PAID", arrival_date: "2026-10-12", departure_date: "2026-10-15", current_revision_id: "missing-evidence", version: 1, member_id: null, member_contract_id: null, booking_channel_code: null, stay_id: "stay", stay_status: "PLANNED" };
const rename = { action: "SAVE_ROOM", insertUnits: [], retireUnitIds: [], roomRename: { roomId: "room", beforeCode: "101", afterCode: "102" } };
const changes = (effect: unknown) => ({ room_catalog_changes: [{ created_at: new Date("2026-10-05"), effect }] });

describe("dashboard lodging evidence", () => {
  it("keeps capacity for an identity-preserving legacy room rename", async () => {
    const original = await load();
    const renamed = await load(changes(rename));
    expect(original.capacityFor(range.from, 10, {}).value).toBe(10);
    expect(renamed.capacityFor(range.from, 10, {}).value).toBe(10);
    expect(renamed.capacityFor(range.from, 10, { building: "other" }).value).toBe(0);
  });
  it.each([
    { ...rename, insertUnits: [{ id: "new" }] },
    { ...rename, retireUnitIds: ["old"] },
    { ...rename, roomRename: undefined },
    { ...rename, insertUnits: undefined },
    { action: "SET_ROOM_ACTIVE", insertUnits: [], retireUnitIds: [] },
    null
  ])("continues hiding capacity for real changes or incomplete rename evidence: %j", async effect => {
    expect((await load(changes(effect))).capacityFor(range.from, 10, {}).value).toBeNull();
  });
  it("retains an order-linked future review while keeping unknown dates protected", async () => {
    const result = await load({ "orders as o": [reservation] });
    expect([...result.invalidFutureDates]).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(result.reviews).toHaveLength(0);
    expect(result.futureReviews).toHaveLength(1);
    expect(result.futureReviews[0]).toMatchObject({ id: "future-review:unverifiable", orderId: "unverifiable", metric: "REVIEW", date: "2026-10-12", label: "未来库存待核对", amountMinor: null });
    expect(result.futureReviews[0]!.reason).toContain("2026-10-12 至 2026-10-14");
    expect(result.futureReviews[0]!.reason).not.toContain("missing-evidence");
  });
  it("clips future review dates to the visible horizon and does not duplicate per night", async () => {
    const result = await load({ "orders as o": [{ ...reservation, arrival_date: "2026-10-01", departure_date: "2026-11-01" }] });
    expect(result.futureReviews).toHaveLength(1);
    expect(result.futureReviews[0]!.reason).toContain("2026-10-11 至 2026-10-24");
    expect(result.invalidFutureDates.size).toBe(14);
  });
  it("does not hide future reviews when the historical window changes", async () => {
    const rows = { "orders as o": [reservation] };
    expect((await load(rows, { from: "2026-09-01", to: "2026-09-15" })).futureReviews).toEqual((await load(rows)).futureReviews);
  });
  it("does not count checked-out orders or dates outside the future horizon as future reviews", async () => {
    const result = await load({ "orders as o": [{ ...reservation, status: "CHECKED_OUT" }, { ...reservation, arrival_date: "2026-10-25" }] });
    expect(result.futureReviews).toEqual([]);
    expect(result.invalidFutureDates.size).toBe(0);
  });
});
