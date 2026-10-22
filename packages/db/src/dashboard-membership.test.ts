import { describe, expect, it } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema.ts";
import { dashboardMembershipProjection, loadDashboardMembership, type DashboardMembershipData } from "./dashboard-membership.ts";

const date = "2026-10-22", dates = ["2026-10-21", date], propertyId = "property-one";
const primary = { id: "guest-one", role: "PRIMARY", documentNumber: null };
const booking = { id: "order-one", member_id: "member-one", member_contract_id: "contract-one" };
function data(patch: Partial<DashboardMembershipData> = {}): DashboardMembershipData {
  return {
    members: [{ id: "member-one", full_name: "权益持有人", nickname: "小甲" }],
    contracts: [{ id: "contract-one", member_id: "member-one", membership_order_id: "membership-one", status: "ACTIVE" }],
    lots: [{ id: "lot-one", contract_id: "contract-one", status: "ACTIVE" }],
    membershipOrders: [{ id: "membership-one", member_id: "member-one", contract_id: "contract-one", entitlement_lot_id: "lot-one", status: "ACTIVE", created_by_command_id: "membership-create", activated_by_command_id: "membership-activate" }],
    orders: [booking],
    coverage: [{ id: "coverage-one", order_id: "order-one", contract_id: "contract-one", lot_id: "lot-one", service_date: date, status: "CONSUMED" }],
    ledger: [{ fact_id: "consume-one", order_id: "order-one", lot_id: "lot-one", service_date: date, coverage_id: "coverage-one", entry_type: "CONSUME", quantity_delta: 0, command_id: "check-in" }],
    ...patch
  };
}

describe("社区会员权益在住统计", () => {
  it("当日确实使用权益的订单计PRIMARY一个份额，不要求证件或会员本人", () => {
    const read = dashboardMembershipProjection(data(), dates, date);
    expect(read(primary, booking)[date]).toEqual({ status: "CONFIRMED", memberId: "member-one", memberName: "小甲（权益持有人）", basis: "MEMBER_ENTITLEMENT" });
    expect(read({ ...primary, documentNumber: "OTHER-PERSON" }, booking)[date]).toEqual(read(primary, booking)[date]);
    expect(read({ ...primary, id: "companion", role: "ADDITIONAL" }, booking)[date]).toEqual({ status: "NOT_MEMBER", memberId: null });
    expect(read(primary, booking)["2026-10-21"]?.status).toBe("NOT_MEMBER");
    expect(JSON.stringify(read(primary, booking))).not.toContain("OTHER-PERSON");
  });
  it("有会员档案或订单member_id但未使用权益，不计会员权益在住", () => {
    const read = dashboardMembershipProjection(data({ coverage: [], ledger: [] }), dates, date);
    expect(read(primary, booking)[date]).toEqual({ status: "NOT_MEMBER", memberId: null });
    expect(read({ ...primary, documentNumber: "MEMBER-DOCUMENT" }, { id: "ordinary-order" })[date]?.status).toBe("NOT_MEMBER");
  });
  it.each(["HELD", "RELEASED"] as const)("%s覆盖不算已经实际使用", status => {
    const fixture = data(); fixture.coverage = [{ ...fixture.coverage[0]!, status }];
    expect(dashboardMembershipProjection(fixture, dates, date)(primary, booking)[date]?.status).toBe("NOT_MEMBER");
  });
  it("已返还核销不计，且不以今天合同过期抹去真实历史使用", () => {
    const fixture = data();
    fixture.contracts = [{ ...fixture.contracts[0]!, status: "EXPIRED" }];
    expect(dashboardMembershipProjection(fixture, dates, date)(primary, booking)[date]?.status).toBe("CONFIRMED");
    fixture.ledger = [...fixture.ledger, { ...fixture.ledger[0]!, fact_id: "restore-one", entry_type: "RESTORE", quantity_delta: 1 }];
    expect(dashboardMembershipProjection(fixture, dates, date)(primary, booking)[date]?.status).toBe("NOT_MEMBER");
  });
  it("相同会员可供两笔住宿使用，不把两单代表认成同一个实际住客", () => {
    const fixture = data();
    fixture.orders = [...fixture.orders, { ...booking, id: "order-two" }];
    fixture.coverage = [...fixture.coverage, { ...fixture.coverage[0]!, id: "coverage-two", order_id: "order-two" }];
    fixture.ledger = [...fixture.ledger, { ...fixture.ledger[0]!, fact_id: "consume-two", order_id: "order-two", coverage_id: "coverage-two" }];
    const read = dashboardMembershipProjection(fixture, dates, date);
    expect(read(primary, booking)[date]?.status).toBe("CONFIRMED");
    expect(read({ id: "guest-two", role: "PRIMARY" }, { ...booking, id: "order-two" })[date]?.status).toBe("CONFIRMED");
    expect(read(primary, booking)[date]).not.toHaveProperty("identityBasis");
  });
  it("使用权益但没有实际PRIMARY登记，保留具体缺项", () => {
    const read = dashboardMembershipProjection(data(), dates, date);
    expect(read(null, booking)[date]).toMatchObject({ status: "UNKNOWN", reasonLabel: "缺少唯一主要住客" });
    expect(read({ id: "unknown-role" }, booking)[date]).toMatchObject({ status: "UNKNOWN" });
  });
  it("旧合同无会员档案时仍确认一个权益份额并保留合同显示名", () => {
    const fixture = data({ members: [], membershipOrders: [] });
    fixture.contracts = [{ ...fixture.contracts[0]!, member_id: null, membership_order_id: null, member_name: "历史权益来源" }];
    fixture.orders = [{ ...booking, member_id: null }];
    expect(dashboardMembershipProjection(fixture, dates, date)(primary, fixture.orders[0]!)[date])
      .toEqual({ status: "CONFIRMED", memberId: null, memberName: "历史权益来源", basis: "MEMBER_ENTITLEMENT" });
  });
  it("换房区间调用及重复返回的同一事实不增加份额", () => {
    const fixture = data(); fixture.coverage = [...fixture.coverage, fixture.coverage[0]!]; fixture.ledger = [...fixture.ledger, fixture.ledger[0]!];
    const read = dashboardMembershipProjection(fixture, dates, date);
    expect(read(primary, booking)[date]).toMatchObject({ status: "CONFIRMED", basis: "MEMBER_ENTITLEMENT" });
    expect(read(primary, booking)).toEqual(read(primary, booking));
  });
  it.each(["CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"])("兼容%s无coverage历史追溯核销，不查当时PRIMARY身份快照", command_type => {
    const fixture = data(); fixture.coverage = [];
    fixture.orders = [{ ...booking, member_id: null, member_contract_id: null }];
    fixture.membershipOrders = [{ ...fixture.membershipOrders[0]!, created_by_command_id: "convert", activated_by_command_id: "convert" }];
    fixture.ledger = [{ ...fixture.ledger[0]!, coverage_id: null, service_date: "2026-10-21", entry_type: "CONVERSION_CONSUME", quantity_delta: -1, command_id: "convert", command_type, command_state: "APPLIED" }];
    expect(dashboardMembershipProjection(fixture, dates, date)(primary, fixture.orders[0]!)["2026-10-21"]).toMatchObject({ status: "CONFIRMED", basis: "MEMBER_ENTITLEMENT" });
  });
  it("真实loader按门店和服务日读取权益，不读取住客或会员的证件电话", async () => {
    const fixture = data();
    const tables: Record<string, readonly unknown[]> = {
      "members as m": fixture.members, member_contracts: fixture.contracts, membership_orders: fixture.membershipOrders,
      entitlement_lots: fixture.lots, orders: fixture.orders, "coverage_items as c": fixture.coverage, "entitlement_ledger as l": fixture.ledger
    };
    const selections: unknown[] = [], filters: unknown[][] = [], tablesRead: string[] = [];
    const trx = { selectFrom(table: string) {
      tablesRead.push(table);
      const q: any = { innerJoin: () => q, leftJoin: () => q, selectAll: () => q,
        select: (value: unknown) => { selections.push(value); return q; }, where: (...args: unknown[]) => { filters.push([table, ...args]); return q; }, execute: async () => tables[table] ?? [] };
      return q;
    } } as unknown as Transaction<Database>;
    const read = await loadDashboardMembership(trx, propertyId, dates, date);
    expect(read(primary, booking)[date]?.status).toBe("CONFIRMED");
    expect(filters).toContainEqual(["coverage_items as c", "o.property_id", "=", propertyId]);
    expect(filters).toContainEqual(["entitlement_ledger as l", "l.service_date", "in", dates]);
    expect(JSON.stringify(selections)).not.toMatch(/phone|identity_card_number|document_number/);
    expect(tablesRead).not.toContain("order_occupants");
    expect(tablesRead).not.toContain("amendments as a");
  });
});
