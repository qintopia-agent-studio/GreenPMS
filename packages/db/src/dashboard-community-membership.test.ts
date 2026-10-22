import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema.ts";
import { loadDashboardCommunity } from "./dashboard-community.ts";

const { loadStays } = vi.hoisted(() => ({ loadStays: vi.fn() }));
vi.mock("./dashboard-stays.ts", () => ({ loadDashboardStays: loadStays }));
const today = "2026-10-21";
const range = { from: "2026-10-01", to: "2026-10-20" };
const booking = { id: "usage-order", arrival_date: today, departure_date: "2026-10-25", status: "CHECKED_IN", stay_type: "MEMBER", free_stay_category_code: null, member_id: "member-one", member_contract_id: "contract-one" };
const occupant = { id: "actual-guest", order_id: booking.id, ordinal: 1, role: "PRIMARY", full_name: "实际住客", nickname: "小溪", phone: null, document_number: "GUEST-DOCUMENT", created_at: new Date("2026-10-21T01:00:00Z"), created_by_command_id: null };
const member = { id: "member-one", identity_card_number: "MEMBER-DOCUMENT", nickname: "权益来源", full_name: "会员姓名" };
const contract = { id: "contract-one", member_id: member.id, membership_order_id: "membership-one", status: "ACTIVE" };
const lot = { id: "lot-one", contract_id: contract.id, status: "ACTIVE" };
const membershipOrder = { id: "membership-one", member_id: member.id, contract_id: contract.id, entitlement_lot_id: lot.id, status: "ACTIVE" };
const consumption = (orders = [booking.id], dates = [today]) => {
  const coverage = orders.flatMap(orderId => dates.map(date => ({ id: `${orderId}:${date}`, order_id: orderId, contract_id: contract.id, lot_id: lot.id, service_date: date, status: "CONSUMED" })));
  return { "coverage_items as c": coverage, "entitlement_ledger as l": coverage.map(row => ({ fact_id: `consume:${row.id}`, coverage_id: row.id, order_id: row.order_id, lot_id: lot.id, service_date: row.service_date, entry_type: "CONSUME", quantity_delta: 0, command_id: "check-in" })) };
};
function database(overrides: Record<string, unknown[]> = {}) {
  const tables: Record<string, unknown[]> = { "orders as o": [booking], orders: overrides["orders as o"] ?? [booking], order_occupants: [occupant], order_occupant_corrections: [], amendments: [], order_occupant_removals: [], "members as m": [member], member_contracts: [contract], entitlement_lots: [lot], membership_orders: [membershipOrder], ...consumption(), ...overrides };
  const filters: unknown[][] = [];
  const trx = { selectFrom: (table: string) => {
    const q: any = { innerJoin: () => q, leftJoin: () => q, select: () => q, selectAll: () => q, where: (...args: unknown[]) => { filters.push([table, ...args]); return q; }, orderBy: () => q, execute: async () => tables[table] ?? [] }; return q;
  } } as unknown as Transaction<Database>;
  return { trx, filters };
}
const arrangements = (orders: Array<typeof booking>) => ({ units: [{ id: "room", code: "202" }], statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map(orders.map(order => [order.id, [{ inventoryUnitId: "room", arrivalDate: order.arrival_date, departureDate: order.departure_date }]])) });
beforeEach(() => loadStays.mockResolvedValue(arrangements([booking])));
const load = async (overrides: Record<string, unknown[]> = {}) => loadDashboardCommunity(database(overrides).trx, "property-one", range, today, "Asia/Shanghai");

describe("community membership-benefit usage", () => {
  it("counts one primary representative using benefits without claiming the guest is the source member", async () => {
    const { trx, filters } = database();
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentCurrent).toMatchObject({ total: 1, member: 1, longStay: 0, memberReview: 0 });
    expect(result.residentCurrent?.memberItems).toEqual([expect.objectContaining({ occupantId: occupant.id, occupantName: "小溪（实际住客）", memberName: "权益来源（会员姓名）", basis: "MEMBER_ENTITLEMENT" })]);
    expect(filters).toContainEqual(["members as m", "mpl.property_id", "=", "property-one"]);
    expect(JSON.stringify(result)).not.toMatch(/GUEST-DOCUMENT|MEMBER-DOCUMENT|documentNumber|phone/);
  });
  it("does not count an ordinary paying guest as a benefit user merely because their document matches a member", async () => {
    const result = await load({ "coverage_items as c": [], "entitlement_ledger as l": [], order_occupants: [{ ...occupant, document_number: member.identity_card_number }] });
    expect(result.current.total).toBe(1); expect(result.residentCurrent).toMatchObject({ total: 0, member: 0, memberItems: [] });
  });
  it("shows corrected nickname and name without making those labels membership evidence", async () => {
    const result = await load({ order_occupant_corrections: [{ occupant_id: occupant.id, sequence: 1, corrected_document_number: "OTHER", corrected_full_name: occupant.full_name, corrected_nickname: "更正昵称", corrected_phone: null }] });
    expect(result.residentCurrent?.memberItems?.[0]?.occupantName).toBe("更正昵称（实际住客）"); expect(result.residentCurrent?.member).toBe(1);
  });
  it("keeps multiple roommates in total headcount while only the sole primary represents benefit usage", async () => {
    const second = { ...occupant, id: "additional", role: "ADDITIONAL", ordinal: 2, nickname: "小叶", full_name: "另一住客", document_number: "OTHER" };
    const result = await load({ order_occupants: [occupant, second] });
    expect(result.current.total).toBe(2); expect(result.residentCurrent).toMatchObject({ total: 1, member: 1 });
    expect(result.residentCurrent?.memberItems?.map(item => item.occupantId)).toEqual([occupant.id]);
  });
  it.each(["none", "multiple"])("keeps %s primary registrations unresolved instead of choosing someone", async mode => {
    const people = mode === "none" ? [{ ...occupant, role: "ADDITIONAL" }] : [occupant, { ...occupant, id: "second-primary", nickname: "小叶", full_name: "另一住客", document_number: "OTHER" }];
    const result = await load({ order_occupants: people });
    expect(result.residentCurrent).toMatchObject({ total: null, knownMember: 0, memberItems: [] });
    expect(result.residentCurrent?.memberReview).toBe(people.length);
    expect(result.residentCurrent?.reviewItems?.every(item => item.reason.includes("主要住客"))).toBe(true);
  });
  it.each([today, "2026-10-20"])("excludes scheduled departure %s even when the order remains CHECKED_IN", async departure => {
    const expired = { ...booking, arrival_date: "2026-10-01", departure_date: departure };
    loadStays.mockResolvedValue(arrangements([expired]));
    const result = await load({ "orders as o": [expired] });
    expect(result.current.total).toBe(0); expect(result.residentCurrent).toMatchObject({ total: 0, member: 0, memberItems: [] });
    expect(result.duration.every(row => row.current === 0)).toBe(true);
  });
  it("counts the new room on move day and keeps continuous nights without counting both intervals", async () => {
    const ongoing = { ...booking, arrival_date: "2026-10-01" };
    loadStays.mockResolvedValue({ ...arrangements([ongoing]), units: [{ id: "old-room", code: "101" }, { id: "room", code: "202" }], arrangements: new Map([[ongoing.id, [
      { inventoryUnitId: "old-room", arrivalDate: "2026-10-01", departureDate: today },
      { inventoryUnitId: "room", arrivalDate: today, departureDate: ongoing.departure_date }
    ]]]) });
    const result = await load({ "orders as o": [ongoing] });
    expect(result.current.total).toBe(1); expect(result.residentCurrent).toMatchObject({ total: 1, member: 1, longStay: 1 });
    expect(result.residentCurrent?.memberItems).toEqual([expect.objectContaining({ roomCode: "202", arrivalDate: today })]);
  });
  it("counts different substitute guests using one account separately, but de-duplicates the same guest across two orders", async () => {
    const second = { ...booking, id: "second-order" };
    loadStays.mockResolvedValue(arrangements([booking, second]));
    const other = { ...occupant, order_id: second.id, id: "other", nickname: "小叶", full_name: "另一住客", document_number: "OTHER" };
    const base = { "orders as o": [booking, second], ...consumption([booking.id, second.id]) };
    const different = await load({ ...base, order_occupants: [occupant, other] });
    expect(different.current.total).toBe(2); expect(different.residentCurrent).toMatchObject({ total: 2, member: 2 });
    const same = await load({ ...base, order_occupants: [occupant, { ...occupant, id: "other", order_id: second.id }] });
    expect(same.current.total).toBe(1); expect(same.residentCurrent).toMatchObject({ total: 1, member: 1 });
    expect(same.residentCurrent?.memberItems).toHaveLength(2);
  });
  it("excludes reserved orders even if inconsistent consumed records exist", async () => {
    const reserved = { ...booking, status: "RESERVED" }; loadStays.mockResolvedValue(arrangements([reserved]));
    const result = await load({ "orders as o": [reserved] });
    expect(result.current.total).toBe(0); expect(result.residentCurrent).toMatchObject({ member: 0, memberItems: [] });
  });
  it("keeps historical attendance unknown for a guest added later, without giving that additional guest a member share", async () => {
    const ongoing = { ...booking, arrival_date: "2026-10-01" }; loadStays.mockResolvedValue(arrangements([ongoing]));
    const primary = { ...occupant, created_at: new Date("2026-10-01T01:00:00Z"), created_by_command_id: "create" };
    const additional = { ...occupant, id: "late", ordinal: 2, role: "ADDITIONAL", nickname: "小叶", full_name: "另一住客", document_number: "OTHER", created_by_command_id: "append" };
    const result = await load({ "orders as o": [ongoing], order_occupants: [primary, additional], amendments: [{ order_id: booking.id, amendment_type: "CREATE_ORDER", command_id: "create" }] });
    expect(result.residentCurrent).toMatchObject({ member: 1, knownTotal: 1 });
    expect(result.residentTrend?.[0]).toMatchObject({ total: null, knownTotal: 0, residentReview: 1, member: 0 });
    expect(result.residentTrend?.[0]?.memberItems).toBeUndefined();
  });
  it.each(["timeline", "roster"])("does not treat benefit usage as attendance with a missing %s", async missing => {
    if (missing === "timeline") loadStays.mockResolvedValue({ ...arrangements([booking]), arrangements: new Map() });
    const result = await load(missing === "roster" ? { order_occupants: [] } : {});
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 0, knownMember: 0, memberItems: [] });
    expect(result.current.total).toBeNull();
  });
});
