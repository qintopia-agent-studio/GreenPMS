import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema";
import { loadDashboardCommunity } from "./dashboard-community";

const { loadStays } = vi.hoisted(() => ({ loadStays: vi.fn() }));
vi.mock("./dashboard-stays", () => ({ loadDashboardStays: loadStays }));
const order = (id: string, arrival: string, departure: string, status = "CHECKED_OUT") => ({
  id, arrival_date: arrival, departure_date: departure, status, stay_type: "CUSTOM", free_stay_category_code: null, member_id: null
});
const person = (o: ReturnType<typeof order>, id: string, nickname = "Cathy", fullName: string | null = "陈晓") => ({
  id, order_id: o.id, ordinal: 1, role: "PRIMARY", full_name: fullName, nickname, phone: null, document_number: null,
  created_at: new Date(`${o.arrival_date}T01:00:00Z`), created_by_command_id: null
});
async function load(orders: ReturnType<typeof order>[], occupants: ReturnType<typeof person>[], from = "2026-10-01", to = "2026-10-13") {
  const tables: Record<string, unknown[]> = { "orders as o": orders, order_occupants: occupants, order_occupant_corrections: [], amendments: [], order_occupant_removals: [] };
  const trx = { selectFrom(table: string) { const q: any = { innerJoin: () => q, select: () => q, selectAll: () => q, where: () => q, orderBy: () => q, execute: async () => tables[table] ?? [] }; return q; } } as unknown as Transaction<Database>;
  loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map(orders.map(o => [o.id, [{ inventoryUnitId: "unit", arrivalDate: o.arrival_date, departureDate: o.departure_date }]])) });
  return loadDashboardCommunity(trx, "property-one", {from,to}, "2026-10-14", "Asia/Shanghai");
}

describe("nickname matching through the real community loader", () => {
  it("joins same-day continuation, then recognizes a later return using history outside the selected period", async () => {
    const first = order("first", "2026-09-01", "2026-09-10");
    const continuous = order("continuous", "2026-09-10", "2026-09-20");
    const returned = order("returned", "2026-10-01", "2026-10-20", "CHECKED_IN");
    const c = await load([first, continuous, returned], [person(first, "a", "Cathy "), person(continuous, "b", "ＣＡＴＨＹ"), person(returned, "c", "Caty")]);
    expect(c.identityApproximate).toBe(true);
    expect(c.visitors).toBe(1);
    expect(c.counts.RETURN).toBe(1);
    expect(c.records.find(row => row.kind === "RETURN")).toMatchObject({orderId:"returned",date:"2026-10-01",people:1});
    expect(c.duration).toEqual([{nights:12,current:0,all:1},{nights:13,current:1,all:0}]);
    expect(JSON.stringify(c)).not.toMatch(/Cathy|ＣＡＴＨＹ|陈晓|nickname-name:/);
  });
  it("accumulates a cross-order uninterrupted stay even without documents", async () => {
    const a = order("a", "2026-09-01", "2026-09-10");
    const b = order("b", "2026-09-10", "2026-11-01", "CHECKED_IN");
    const c = await load([a,b],[person(a,"a-person"),person(b,"b-person")],"2026-09-01","2026-10-13");
    expect(c.duration).toEqual([{nights:42,current:0,all:1},{nights:43,current:1,all:0}]);
    expect(c.counts.RETURN).toBe(0);
    expect(c.counts.RENEWAL).toBe(1);
    expect(c.current.total).toBe(1);
  });
  it("keeps record count distinct from unique returning people", async () => {
    const old = order("old", "2026-09-01", "2026-09-10");
    const one = order("one", "2026-10-01", "2026-10-05");
    const two = order("two", "2026-10-10", "2026-11-01", "CHECKED_IN");
    const c = await load([old,one,two],[person(old,"old-person"),person(one,"one-person"),person(two,"two-person")]);
    expect(c.visitors).toBe(1);
    expect(c.counts.RETURN).toBe(2);
    expect(c.records.filter(row=>row.kind==="RETURN").map(row=>row.date)).toEqual(["2026-10-10","2026-10-01"]);
  });
  it("aggregates two returning roommates into one order/date record with two people", async () => {
    const old = order("old", "2026-09-01", "2026-09-10");
    const returned = order("returned", "2026-10-01", "2026-11-01", "CHECKED_IN");
    const c = await load([old,returned],[person(old,"old-a"),person(old,"old-b","阿米","李明"),person(returned,"new-a"),person(returned,"new-b","阿米","李明")]);
    expect(c.visitors).toBe(2);
    expect(c.counts.RETURN).toBe(1);
    expect(c.records.find(row=>row.kind==="RETURN")?.people).toBe(2);
    expect(c.current.total).toBe(2);
  });
  it("matches a planned nickname continuation without counting it as an actual return or lived nights", async () => {
    const actual = order("actual", "2026-10-01", "2026-10-20", "CHECKED_IN");
    const future = order("future", "2026-10-20", "2026-11-01", "RESERVED");
    const c = await load([actual,future],[person(actual,"actual-person"),person(future,"planned-person")]);
    expect(c.counts.DUE).toBe(0);
    expect(c.counts.RETURN).toBe(0);
    expect(c.duration).toEqual([{nights:12,current:0,all:1},{nights:13,current:1,all:0}]);
  });
});
