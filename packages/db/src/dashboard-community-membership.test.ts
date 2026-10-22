import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema.ts";
import { loadDashboardCommunity } from "./dashboard-community.ts";

const { loadStays } = vi.hoisted(() => ({ loadStays: vi.fn() }));
vi.mock("./dashboard-stays.ts", () => ({ loadDashboardStays: loadStays }));
const today = "2026-10-21";
const range = { from: "2026-10-01", to: "2026-10-20" };
const booking = { id: "ordinary", arrival_date: "2026-10-21", departure_date: "2026-10-25", status: "CHECKED_IN", stay_type: "TRANSIENT", free_stay_category_code: null, member_id: null, member_contract_id: null };
const occupant = { id: "actual-guest", order_id: booking.id, ordinal: 1, role: "PRIMARY", full_name: "示例住客", nickname: "Example", phone: null, document_number: "DOC-ONE", created_at: new Date("2026-10-21T01:00:00Z"), created_by_command_id: null };
const member = { id: "member-one", identity_card_number: "DOC-ONE", nickname: "会员昵称", full_name: "会员姓名" };
const contract = { id: "contract-one", member_id: member.id, membership_order_id: "membership-one", status: "ACTIVE", valid_from: "2026-10-01", valid_until: "2027-09-30" };
const lot = { id: "lot-one", contract_id: contract.id, status: "ACTIVE", expires_on: contract.valid_until };
const membershipOrder = { id: "membership-one", member_id: member.id, contract_id: contract.id, entitlement_lot_id: lot.id, status: "ACTIVE" };
function database(overrides: Record<string, unknown[]> = {}) {
  const tables: Record<string, unknown[]> = { "orders as o": [booking], order_occupants: [occupant], order_occupant_corrections: [], amendments: [], order_occupant_removals: [], "members as m": [member], member_contracts: [contract], entitlement_lots: [lot], membership_orders: [membershipOrder], ...overrides };
  const filters: unknown[][] = [];
  const trx = { selectFrom: (table: string) => {
    const q: any = { innerJoin: () => q, select: () => q, selectAll: () => q, where: (...args: unknown[]) => { filters.push([table, ...args]); return q; }, orderBy: () => q, execute: async () => tables[table] ?? [] }; return q;
  } } as unknown as Transaction<Database>;
  return { trx, filters };
}
beforeEach(() => loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[booking.id, [{ inventoryUnitId: "room", arrivalDate: booking.arrival_date, departureDate: booking.departure_date }]]]) }));

describe("community loader exact current membership", () => {
  it("loads property-scoped members and recognizes an actual member from an ordinary order on arrival day", async () => {
    const { trx, filters } = database();
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentCurrent).toMatchObject({ total: 1, member: 1, longStay: 0, knownMember: 1, memberReview: 0 });
    expect(filters).toContainEqual(["members as m", "mpl.property_id", "=", "property-one"]);
    expect(filters).toContainEqual(["member_contracts", "property_id", "=", "property-one"]);
    expect(JSON.stringify(result)).not.toContain("DOC-ONE");
  });
  it("uses the latest corrected guest document without changing the registration facts", async () => {
    const { trx } = database({ order_occupants: [{ ...occupant, document_number: "OLD-DOCUMENT" }], order_occupant_corrections: [{ occupant_id: occupant.id, sequence: 1, corrected_document_number: "DOC-ONE", corrected_full_name: occupant.full_name, corrected_nickname: "更正昵称", corrected_phone: null }] });
    const current = (await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai")).residentCurrent;
    expect(current?.member).toBe(1);
    expect(current?.memberItems).toEqual([expect.objectContaining({ occupantId: occupant.id, occupantName: "更正昵称（示例住客）" })]);
  });
  it("shows the current room's effective dates after a move, rather than the original booking start", async () => {
    const ongoing = { ...booking, arrival_date: "2026-10-01" };
    loadStays.mockResolvedValue({ units: [{ id: "old-room", code: "101" }, { id: "room", code: "202" }], statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[ongoing.id, [
      { inventoryUnitId: "old-room", arrivalDate: "2026-10-01", departureDate: "2026-10-17" },
      { inventoryUnitId: "room", arrivalDate: "2026-10-17", departureDate: ongoing.departure_date }
    ]]]) });
    const { trx } = database({ "orders as o": [ongoing] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentCurrent?.memberItems).toEqual([expect.objectContaining({ occupantId: occupant.id, occupantName: "Example（示例住客）", roomCode: "202", arrivalDate: "2026-10-17", departureDate: "2026-10-25" })]);
    expect(JSON.stringify(result.residentTrend)).not.toContain("Example");
  });
  it("keeps two unnamed membership relations on the same order attached to their exact guest names", async () => {
    const linked = { ...booking, member_id: member.id };
    const one = { ...occupant, nickname: "住客甲", document_number: null };
    const two = { ...one, id: "guest-two", ordinal: 2, role: "ADDITIONAL", nickname: "住客乙" };
    const { trx } = database({ "orders as o": [linked], order_occupants: [one, two] });
    const current = (await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai")).residentCurrent;
    expect(current).toMatchObject({ memberReview: 2, residentReview: 2 });
    expect(current?.reviewItems).toEqual([
      expect.objectContaining({ occupantId: one.id, occupantName: "住客甲（示例住客）", memberId: member.id }),
      expect.objectContaining({ occupantId: two.id, occupantName: "住客乙（示例住客）", memberId: member.id })
    ]);
  });
  it("keeps confirmed members visible alongside unresolved order membership and supplies a review link target", async () => {
    const other = { ...booking, id: "unresolved", member_id: member.id };
    const otherGuest = { ...occupant, id: "other-guest", order_id: other.id, full_name: "另一位住客", nickname: "Other", document_number: null };
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([booking, other].map(order => [order.id, [{ inventoryUnitId: "room", arrivalDate: order.arrival_date, departureDate: order.departure_date }]])) });
    const { trx } = database({ "orders as o": [booking, other], order_occupants: [occupant, otherGuest] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 1, member: null, knownMember: 1, residentReview: 1, memberReview: 1 });
    expect(result.residentCurrent?.reviewItems).toEqual([expect.objectContaining({ orderId: other.id, memberId: member.id })]);
  });
  it("does not pass historical exact membership through a matching nickname to an undocumented return", async () => {
    const old = { ...booking, id: "old", arrival_date: "2026-10-01", departure_date: "2026-10-02", status: "CHECKED_OUT" };
    const oldGuest = { ...occupant, id: "old-guest", order_id: old.id, created_at: new Date("2026-10-01T01:00:00Z") };
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([old, booking].map(order => [order.id, [{ inventoryUnitId: "room", arrivalDate: order.arrival_date, departureDate: order.departure_date }]])) });
    const { trx } = database({ "orders as o": [old, booking], order_occupants: [oldGuest, { ...occupant, document_number: null }] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentTrend?.[0]).toMatchObject({ total: 1, member: 1 });
    expect(result.residentCurrent).toMatchObject({ total: 0, member: 0, longStay: 0 });
  });
  it("counts a member appended today only in confirmed current attendance, never throughout the order's prior dates", async () => {
    const ongoing = { ...booking, arrival_date: "2026-10-01" };
    const primary = { ...occupant, id: "primary", document_number: "DOC-OTHER", full_name: "原住宿人", nickname: "Original", created_at: new Date("2026-10-01T01:00:00Z"), created_by_command_id: "create" };
    const appended = { ...occupant, role: "ADDITIONAL", ordinal: 2, created_by_command_id: "append" };
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[ongoing.id, [{ inventoryUnitId: "room", arrivalDate: ongoing.arrival_date, departureDate: ongoing.departure_date }]]]) });
    const { trx } = database({ "orders as o": [ongoing], order_occupants: [primary, appended], amendments: [{ order_id: ongoing.id, amendment_type: "CREATE_ORDER", command_id: "create" }] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentTrend).toHaveLength(20);
    for (const day of result.residentTrend ?? []) {
      expect(day).toMatchObject({ member: null, knownMember: 0, memberReview: 1, residentReview: 1 });
    }
    expect(result.residentTrend?.[0]).toMatchObject({ total: null, knownTotal: 0 });
    expect(result.residentCurrent).toMatchObject({ total: 2, member: 1, knownTotal: 2, knownMember: 1, longStay: 1, memberReview: 0, residentReview: 0 });
  });
  it("does not backfill confirmed membership into historical attendance from a withdrawn guest registration", async () => {
    const ongoing = { ...booking, arrival_date: "2026-10-01" };
    const primary = { ...occupant, id: "primary", document_number: "DOC-OTHER", full_name: "原住宿人", nickname: "Original", created_at: new Date("2026-10-01T01:00:00Z"), created_by_command_id: "create" };
    const removedMember = { ...occupant, role: "ADDITIONAL", ordinal: 2, created_at: new Date("2026-10-01T01:00:00Z"), created_by_command_id: "create" };
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[ongoing.id, [{ inventoryUnitId: "room", arrivalDate: ongoing.arrival_date, departureDate: ongoing.departure_date }]]]) });
    const { trx } = database({ "orders as o": [ongoing], order_occupants: [primary, removedMember], order_occupant_removals: [{ occupant_id: removedMember.id, created_at: new Date("2026-10-21T01:00:00Z") }], amendments: [{ order_id: ongoing.id, amendment_type: "CREATE_ORDER", command_id: "create" }] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    for (const day of result.residentTrend ?? []) {
      expect(day).toMatchObject({ member: null, knownMember: 0, memberReview: 1, residentReview: 1 });
    }
    expect(result.residentCurrent).toMatchObject({ total: 1, member: 0, knownMember: 0, memberReview: 0 });
  });
  it.each(["timeline", "roster"])("does not report confirmed member attendance with a missing %s", async missing => {
    const ongoing = { ...booking, arrival_date: "2026-10-01", member_id: member.id, member_contract_id: contract.id };
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: missing === "timeline" ? new Map() : new Map([[ongoing.id, [{ inventoryUnitId: "room", arrivalDate: ongoing.arrival_date, departureDate: ongoing.departure_date }]]]) });
    const { trx } = database({ "orders as o": [ongoing], order_occupants: missing === "roster" ? [] : [{ ...occupant, created_at: new Date("2026-10-01T01:00:00Z") }] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentCurrent).toMatchObject({ total: null, member: null, knownTotal: 0, knownMember: 0, longStay: 0, residentReview: 1, memberReview: 1 });
    expect(result.residentTrend?.[0]).toMatchObject({ total: null, member: null, knownTotal: 0, knownMember: 0, residentReview: 1, memberReview: 1 });
  });
  it("keeps confirmed member totals complete when a withdrawn nonmember only leaves an attendance gap", async () => {
    const ongoing = { ...booking, arrival_date: "2026-10-01" };
    const primary = { ...occupant, created_at: new Date("2026-10-01T01:00:00Z"), created_by_command_id: "create" };
    const removedNonmember = { ...primary, id: "withdrawn-nonmember", role: "ADDITIONAL", ordinal: 2, document_number: "DOC-OTHER", full_name: "另一位住客", nickname: "Other" };
    loadStays.mockResolvedValue({ statistics: { includesUnit: () => true, classifyUnit: () => true }, arrangements: new Map([[ongoing.id, [{ inventoryUnitId: "room", arrivalDate: ongoing.arrival_date, departureDate: ongoing.departure_date }]]]) });
    const { trx } = database({ "orders as o": [ongoing], order_occupants: [primary, removedNonmember], order_occupant_removals: [{ occupant_id: removedNonmember.id, created_at: new Date("2026-10-21T01:00:00Z") }], amendments: [{ order_id: ongoing.id, amendment_type: "CREATE_ORDER", command_id: "create" }] });
    const result = await loadDashboardCommunity(trx, "property-one", range, today, "Asia/Shanghai");
    expect(result.residentTrend?.[0]).toMatchObject({ total: null, knownTotal: 1, member: 1, knownMember: 1, residentReview: 1, memberReview: 0 });
  });
});
