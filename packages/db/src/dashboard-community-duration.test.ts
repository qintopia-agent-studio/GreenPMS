import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema";
import { loadDashboardCommunity } from "./dashboard-community";

const { loadStays } = vi.hoisted(() => ({ loadStays: vi.fn() }));
vi.mock("./dashboard-stays", () => ({ loadDashboardStays: loadStays }));
const today = "2026-10-14";
const range = { from: "2026-09-01", to: "2026-09-30" };
const order = { id: "order-one", arrival_date: "2026-09-01", departure_date: "2026-11-01", status: "CHECKED_IN", stay_type: "CUSTOM", free_stay_category_code: null, member_id: "payer-member" };
const occupant = { id: "guest-one", order_id: order.id, ordinal: 1, role: "PRIMARY", full_name: "合成住客", nickname: null, phone: "shared-phone", document_number: "VERIFIED", created_at: new Date("2026-09-01T01:00:00Z"), created_by_command_id: "create" };
const interval = (arrivalDate: string, departureDate: string) => ({ inventoryUnitId: "unit", arrivalDate, departureDate });
function database(overrides: Record<string, unknown[]> = {}) {
  const tables: Record<string, unknown[]> = { "orders as o": [order], order_occupants: [occupant], order_occupant_corrections: [], amendments: [], order_occupant_removals: [], ...overrides };
  return { selectFrom: (table: string) => {
    const q: any = { innerJoin: () => q, select: () => q, selectAll: () => q, where: () => q, orderBy: () => q, execute: async () => tables[table] ?? [] }; return q;
  } } as unknown as Transaction<Database>;
}
beforeEach(() => loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[order.id, [interval(order.arrival_date, order.departure_date)]]]) }));

describe("community duration loader", () => {
  it("keeps today's occupied interval current before a scheduled future room move", async () => {
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[order.id, [interval("2026-09-01", "2026-10-20"), interval("2026-10-20", "2026-11-01")]]]) });
    const c = await loadDashboardCommunity(database(), "property", range, today, "Asia/Shanghai");
    expect(c.current.total).toBe(1);
    expect(c.current.registered?.total).toBe(1);
    expect(c.duration).toEqual([{ nights: 29, current: 0, all: 1 }, { nights: 43, current: 1, all: 0 }]);
    expect(c.durationCoverage?.current.pendingRegistrations).toBe(0);
  });
  it("uses the approved name estimate without treating payer member or phone as guest identity", async () => {
    const c = await loadDashboardCommunity(database({ order_occupants: [{ ...occupant, document_number: null }] }), "property", range, today, "Asia/Shanghai");
    expect(c.duration).toEqual([{ nights: 29, current: 0, all: 1 }, { nights: 43, current: 1, all: 0 }]);
    expect(c.durationCoverage?.current).toMatchObject({ registrationBased: 0, pendingRegistrations: 0, pendingOrders: 0, issues: [] });
    expect(c.current.total).toBe(1);
    expect(c.identityApproximate).toBe(true);
    expect(c.current.registered?.total).toBe(1);
    expect(JSON.stringify(c.durationCoverage)).not.toMatch(/shared-phone|合成住客|payer-member/);
  });
  it("keeps a known guest registration actionable when its effective timeline is missing, without inventing attendance or duration", async () => {
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map() });
    const c = await loadDashboardCommunity(database(), "property", range, today, "Asia/Shanghai");
    expect(c.durationCoverage?.current).toMatchObject({ pendingRegistrations: 1, pendingOrders: 0 });
    expect(c.durationCoverage?.all).toMatchObject({ pendingRegistrations: 1, pendingOrders: 0 });
    expect(c.durationCoverage?.current.issues[0]?.reason).toContain("时间线");
    expect(c.current.total).toBeNull();
    expect(c.current.registered?.total).toBe(1);
    expect(c.duration).toEqual([]);
    expect(c.visitors).toBeNull();
    expect(c.residentCurrent).toMatchObject({ total: null, knownTotal: 0, longStay: 0 });
    expect(c.residentCurrent?.reviewItems).toEqual([expect.objectContaining({ orderId: order.id, occupantId: occupant.id, occupantName: "合成住客" })]);
    expect(c.residentCurrent?.reviewItems?.[0]?.arrivalDate).toBeUndefined();
    expect(c.residentCurrent?.reviewItems?.[0]?.roomCode).toBeUndefined();
    expect(c.trend.every(day => day.total === null)).toBe(true);
    expect(c.residentTrend?.every(day => day.knownTotal === 0 && day.longStay === 0)).toBe(true);
  });
  it.each(["missing", "valid"])("keeps an order with no actual guest roster unresolved when its timeline is %s", async timeline => {
    if (timeline === "missing") loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map() });
    const c = await loadDashboardCommunity(database({ order_occupants: [] }), "property", range, today, "Asia/Shanghai");
    expect(c.durationCoverage?.current).toMatchObject({ pendingRegistrations: 0, pendingOrders: 1 });
    expect(c.current.total).toBeNull(); expect(c.current.registered?.total).toBeNull();
    expect(c.duration).toEqual([]);
    expect(c.residentCurrent).toMatchObject({ total: null, knownTotal: 0, knownMember: 0, longStay: 0 });
    expect(c.residentCurrent?.reviewItems?.[0]).toMatchObject({ orderId: order.id, occupantName: "未登记实际住客" });
    expect(c.residentCurrent?.reviewItems?.[0]?.occupantId).toBeUndefined();
  });
  it("preserves current registrations but refuses to backdate late-added guests", async () => {
    const c = await loadDashboardCommunity(database({ order_occupants: [{ ...occupant, role: "ADDITIONAL", created_at: new Date("2026-10-10T01:00:00Z"), created_by_command_id: "add-person" }] }), "property", range, today, "Asia/Shanghai");
    expect(c.current.registered?.total).toBe(1);
    expect(c.duration).toEqual([]);
    expect(c.durationCoverage?.current.pendingRegistrations).toBe(1);
    expect(c.durationCoverage?.all.pendingRegistrations).toBe(1);
    expect(c.durationCoverage?.current.issues[0]?.reason).toContain("追加");
  });
  it("keeps a removed registration in historical review only, without treating removal as checkout", async () => {
    const c = await loadDashboardCommunity(database({ order_occupant_removals: [{ occupant_id: occupant.id, created_at: new Date("2026-09-20T01:00:00Z") }] }), "property", range, today, "Asia/Shanghai");
    expect(c.duration).toEqual([]);
    expect(c.durationCoverage?.current.pendingRegistrations).toBe(0);
    expect(c.durationCoverage?.all.pendingRegistrations).toBe(1);
    expect(c.durationCoverage?.all.issues[0]?.reason).toContain("不是实际离店日期");
  });
  it("continues to count an overdue checked-in guest until actual checkout", async () => {
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[order.id, [interval("2026-09-01", "2026-10-13")]]]) });
    const c = await loadDashboardCommunity(database({ "orders as o": [{ ...order, departure_date: "2026-10-13" }] }), "property", range, today, "Asia/Shanghai");
    expect(c.duration).toContainEqual({ nights: 43, current: 1, all: 0 });
  });
});
