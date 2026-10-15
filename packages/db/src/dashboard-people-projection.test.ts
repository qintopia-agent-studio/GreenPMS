import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema";
import { loadDashboardCommunity, communityEvents } from "./dashboard-community";
vi.mock("./dashboard-stays.ts", () => ({ loadDashboardStays: async () => ({ arrangements: new Map([["order", [{ inventoryUnitId: "room", arrivalDate: "2026-10-01", departureDate: "2026-11-01" }]]]) }) }));
const primary = { id: "primary", order_id: "order", ordinal: 1, role: "PRIMARY", document_number: "ID-A", full_name: "样本", nickname: "样本", phone: null, created_by_command_id: "create", created_at: new Date("2026-10-01") };
const companion = { ...primary, id: "companion", ordinal: 2, role: "ADDITIONAL", document_number: "ID-B" };
const order = { id: "order", arrival_date: "2026-10-01", departure_date: "2026-11-01", status: "CHECKED_IN", stay_type: "NORMAL", free_stay_category_code: null, member_id: "not-the-guest" };
function db(patch: Record<string, unknown[]>): Transaction<Database> {
  const rows: Record<string, unknown[]> = { "orders as o": [order], order_occupants: [primary, companion], amendments: [{ order_id: "order", amendment_type: "CREATE_ORDER", command_id: "create" }], ...patch };
  return { selectFrom(table: string) { const builder = new Proxy({}, { get(_, key) { if (key === "execute") return async () => rows[table] ?? []; return () => builder; } }); return builder; } } as unknown as Transaction<Database>;
}
const range = { from: "2026-10-01", to: "2026-10-11" };
const load = (patch: Record<string, unknown[]> = {}) => loadDashboardCommunity(db(patch), "demo", range, "2026-10-12", "Asia/Shanghai");
describe("historical occupant projection, read-only SQL fixtures", () => {
  it("keeps known roommates when one registration was withdrawn", async () => {
    const result = await load({ order_occupant_removals: [{ order_id: "order", occupant_id: "companion", created_at: new Date("2026-10-05") }] });
    expect(result.current).toMatchObject({ total: 1, paid: 1 });
    expect(result.trend[0]).toMatchObject({ total: null, paid: 1 });
    expect(result.trend[4]).toMatchObject({ total: 1, paid: 1 });
  });
  it("does not infer actual arrival from a late registration, but preserves the current registered person", async () => {
    const result = await load({ order_occupants: [primary, { ...companion, created_by_command_id: "append", created_at: new Date("2026-10-08") }] });
    expect(result.current.total).toBe(2);
    expect(result.trend[0]).toMatchObject({ total: null, paid: 1 });
    expect(result.duration).toEqual([{ nights: 10, current: 0, all: 1 }, { nights: 11, current: 1, all: 0 }]);
    expect(result.reasons.join(" ")).toContain("追加登记");
  });
  it("uses the approved nickname estimate, not the payer membership", async () => {
    const result = await load({ order_occupants: [{ ...primary, document_number: null }] });
    expect(result.current.total).toBe(1);
    expect(result.identityApproximate).toBe(true);
    expect(result.current.unlinked).toBe(0);
  });
  it("does not count reservation-only extensions as actual renewals", () => {
    const event = { id: "extend", order_id: "order", amendment_type: "EXTEND_STAY", payload: {}, command_id: "extend", sequence: 2, reason_note: "延长计划", created_at: new Date("2026-09-30") };
    expect(communityEvents([{ ...order, status: "RESERVED" }], [event], date => date.toISOString().slice(0, 10))).toEqual([]);
    expect(communityEvents([order], [event], date => date.toISOString().slice(0, 10))).toEqual([]);
  });
});
