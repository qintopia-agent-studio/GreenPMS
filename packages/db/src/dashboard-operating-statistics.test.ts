import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema.ts";
import { operatingStatisticsScope, type OperatingStatisticsInterval } from "./operating-statistics.ts";
import { loadDashboardCommunity } from "./dashboard-community.ts";
const { loadStays } = vi.hoisted(() => ({ loadStays: vi.fn() }));
vi.mock("./dashboard-stays.ts", () => ({ loadDashboardStays: loadStays }));
const scope = operatingStatisticsScope(["a", "f", "b"].map(id => ({ id, kind: "ROOM", parent_room_id: null })), [], [{ asset_id: "f", included: false }]);
const order = { id: "order", arrival_date: "2026-10-01", departure_date: "2026-10-10", status: "CHECKED_IN", stay_type: "TRANSIENT", free_stay_category_code: null, member_id: null };
const person = { id: "guest", order_id: "order", ordinal: 1, role: "PRIMARY", nickname: "测试住客", full_name: "测试住客", phone: null, document_number: "ID", created_at: new Date("2026-10-01"), created_by_command_id: "create" };
const segments: OperatingStatisticsInterval[] = [
  { inventoryUnitId: "a", arrivalDate: "2026-10-01", departureDate: "2026-10-03" },
  { inventoryUnitId: "f", arrivalDate: "2026-10-03", departureDate: "2026-10-06" },
  { inventoryUnitId: "b", arrivalDate: "2026-10-06", departureDate: "2026-10-10" }
];
async function load(today = "2026-10-05", override: Record<string, unknown[]> = {}, intervals = segments, arrangements = new Map([["order", intervals]]), statistics = scope) {
  const tables: Record<string, unknown[]> = { "orders as o": [order], order_occupants: [person], amendments: [{ order_id: "order", amendment_type: "CREATE_ORDER", command_id: "create" }], ...override };
  loadStays.mockResolvedValue({ statistics, arrangements });
  const trx = { selectFrom(table: string) { const q: any = new Proxy({}, { get: (_, key) => key === "execute" ? async () => tables[table] ?? [] : () => q }); return q; } } as unknown as Transaction<Database>;
  return loadDashboardCommunity(trx, "property", { from: "2026-10-01", to: "2026-10-09" }, today, "Asia/Shanghai");
}
describe("跨房住宿的经营人数按实际分段过滤", () => {
  it("does not invent a return when an included stay moves through a dorm and back", async () => {
    const result = await load("2026-10-07");
    expect(result.duration).toEqual([{ nights: 3, current: 1, all: 1 }]);
    expect(result.counts.NEW).toBe(1);
    expect(result.counts.RETURN).toBe(0);
    expect(result.counts.RENEWAL).toBe(0);
    expect(result.records.filter(record => record.kind === "NEW").map(record => record.date)).toEqual(["2026-10-01"]);
    expect(result.trend.map(day => day.total)).toEqual([1, 1, 0, 0, 0, 1, 1, 1, 1]);
  });
  it("retains excluded identity evidence so two operating guests with an ambiguous nickname do not merge", async () => {
    const second = { ...order, id: "second" };
    const dorm = { ...order, id: "dorm", status: "CHECKED_OUT", arrival_date: "2026-09-01", departure_date: "2026-09-02" };
    const rows = { "orders as o": [order, second, dorm], order_occupants: [
      { ...person, nickname: "小雨", full_name: "小雨", document_number: null },
      { ...person, id: "guest-x", order_id: second.id, nickname: "小雨", full_name: "小雨", document_number: "X" },
      { ...person, id: "guest-y", order_id: dorm.id, nickname: "小雨", full_name: "小雨", document_number: "Y" }
    ] };
    const arrangements = new Map([
      [order.id, [{ inventoryUnitId: "a", arrivalDate: order.arrival_date, departureDate: order.departure_date }]],
      [second.id, [{ inventoryUnitId: "b", arrivalDate: second.arrival_date, departureDate: second.departure_date }]],
      [dorm.id, [{ inventoryUnitId: "f", arrivalDate: dorm.arrival_date, departureDate: dorm.departure_date }]]
    ]);
    const all = operatingStatisticsScope(["a", "b", "f"].map(id => ({ id, kind: "ROOM", parent_room_id: null })), [], []);
    const included = await load("2026-10-07", rows, segments, arrangements, all);
    const excluded = await load("2026-10-07", rows, segments, arrangements);
    expect(included.current.total).toBe(2);
    expect(excluded.current.total).toBe(2);
    expect(excluded.visitors).toBe(2);
    expect(excluded.trend.map(day => day.total)).toEqual(included.trend.map(day => day.total));
  });
  it("does not turn entry from a dorm into NEW and retains genuine returns after a real gap", async () => {
    const fromDorm = segments.map((segment, index) => ({ ...segment, inventoryUnitId: index < 2 ? "f" : "b" }));
    expect((await load("2026-10-07", {}, fromDorm)).counts).toMatchObject({ NEW: 0, RETURN: 0 });
    const actualGap = [segments[0]!, segments[2]!];
    const result = await load("2026-10-07", {}, actualGap);
    expect(result.counts.RETURN).toBe(1);
    expect(result.records.find(record => record.kind === "RETURN")?.date).toBe("2026-10-06");
  });
  it("does not suppress an early checkout's continuation evidence just because the next stay is excluded", async () => {
    const departed = { ...order, status: "CHECKED_OUT", departure_date: "2026-10-03" };
    const next = { ...order, id: "next", arrival_date: "2026-10-03" };
    const arrangements = new Map([
      [order.id, [segments[0]!]], [next.id, [{ inventoryUnitId: "f", arrivalDate: "2026-10-03", departureDate: "2026-10-10" }]]
    ]);
    const result = await load("2026-10-07", { "orders as o": [departed, next],
      order_occupants: [person, { ...person, id: "next-person", order_id: next.id }], amendments: [
        { id: "shorten", order_id: order.id, amendment_type: "SHORTEN_STAY", command_id: "checkout", sequence: 2,
          created_at: new Date("2026-10-03"), payload: { completionMode: "EARLY_CHECK_OUT", before: { departureDate: "2026-10-05" }, after: { departureDate: "2026-10-03" } } },
        { id: "checkout", order_id: order.id, amendment_type: "CHECK_OUT", command_id: "checkout", sequence: 3, created_at: new Date("2026-10-03"), payload: {} }
      ] }, segments, arrangements);
    expect(result.counts.EARLY).toBe(0);
    expect(result.counts.RENEWAL).toBe(0);
    expect(result.current.total).toBe(0);
  });

  it("counts A and B, leaves F days empty, and never uses the earlier included room as today's room", async () => {
    const result = await load();
    expect(result.current.total).toBe(0);
    expect(result.duration).toEqual([{ nights: 2, current: 0, all: 1 }]);
    expect(result.trend.map(day => day.total)).toEqual([1, 1, 0, 0, 0, 1, 1, 1, 1]);
    expect(result.visitors).toBe(1);
    expect((await load("2026-10-07")).current.total).toBe(1);
  });
  it("keeps overdue residents excluded when their last actual room is a dorm", async () => {
    expect((await load("2026-10-12", {}, segments.slice(0, 2))).current.total).toBe(0);
    expect((await load("2026-10-12")).current.total).toBe(1);
  });
  it("clips late registration uncertainty to included segments and preserves current registration", async () => {
    const late = { ...person, role: "ADDITIONAL", created_at: new Date("2026-10-04"), created_by_command_id: "append" };
    const result = await load("2026-10-07", { order_occupants: [late] });
    expect(result.trend[0]!.total).toBeNull();
    expect(result.trend[3]!.total).toBe(0);
    expect(result.current.registered?.total).toBe(1);
    expect((await load("2026-10-05", { order_occupants: [late] })).current.total).toBe(0);
  });
  it("deduplicates adjacent included room segments for the same guest and date", async () => {
    const result = await load("2026-10-07", {}, segments.map(segment => ({ ...segment, inventoryUnitId: "a" })));
    expect(result.trend.every(day => day.total === 1)).toBe(true);
    expect(result.visitors).toBe(1);
    expect(result.current.registered?.total).toBe(1);
  });
  it("keeps unknown room identity unresolved rather than silently excluding it", async () => {
    const result = await load("2026-10-05", {}, [{ inventoryUnitId: "missing", arrivalDate: "2026-10-01", departureDate: "2026-10-10" }]);
    expect(result.current.total).toBeNull();
    expect(result.reasons.join(" ")).toContain("资产无法定位");
  });
  it("does not report missing occupants or extension events for an entirely excluded stay", async () => {
    const result = await load("2026-10-05", { order_occupants: [], amendments: [{ id: "extend", order_id: "order", amendment_type: "EXTEND_STAY", created_at: new Date("2026-10-02"), payload: {} }] }, [{ inventoryUnitId: "f", arrivalDate: "2026-10-01", departureDate: "2026-10-10" }]);
    expect(result.current.total).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.reasons).toEqual([]);
  });
});
