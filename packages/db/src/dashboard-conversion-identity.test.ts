import { describe, expect, it } from "vitest";
import { dashboardConversionBindings, type DashboardConversionIdentityData } from "./dashboard-conversion-identity.ts";
import { dashboardMembershipProjection } from "./dashboard-membership.ts";
import { loadDashboardMembership } from "./dashboard-membership.ts";
import type { Transaction } from "kysely";
import type { Database } from "./schema.ts";

const propertyId = "property-one", date = "2026-10-22", at = "2026-10-10T08:00:00Z";
function fixture(): DashboardConversionIdentityData {
  return {
    members: [{ id: "member-one", identity_card_number: null, full_name: "住客甲", nickname: "小甲", phone: "13800000001" }],
    membershipOrders: [{ id: "membership-one", member_id: "member-one", contract_id: "contract-one", entitlement_lot_id: "lot-one", status: "ACTIVE", created_by_command_id: "convert", activated_by_command_id: "convert" }],
    contracts: [{ id: "contract-one", member_id: "member-one", membership_order_id: "membership-one" }],
    lots: [{ id: "lot-one", contract_id: "contract-one" }],
    events: [{ id: "amendment-convert", order_id: "order-one", command_id: "convert", sequence: 3, created_at: at,
      command_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", command_state: "APPLIED", command_property_id: propertyId, execution_status: "EXECUTED", business_committed: true,
      payload: { operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", orderId: "order-one", primaryOccupant: { fullName: "住客甲", nickname: "小甲", phone: "13800000001" }, member: { memberId: "member-one", fullName: "住客甲", phone: "13800000001" } } }],
    orders: [{ id: "order-one", property_id: propertyId, member_id: "member-one", member_contract_id: "contract-one" }],
    occupants: [{ id: "primary", order_id: "order-one", ordinal: 1, role: "PRIMARY", full_name: "住客甲", nickname: "小甲", phone: "13800000001", document_number: null, created_at: new Date("2026-10-01T00:00:00Z") }],
    corrections: [], memberCorrections: []
  };
}
function projection(data: DashboardConversionIdentityData) {
  return dashboardMembershipProjection({ members: data.members,
    contracts: data.contracts.map(contract => ({ ...contract, status: "ACTIVE", valid_from: "2026-10-10", valid_until: "2027-10-10" })),
    lots: data.lots.map(lot => ({ ...lot, status: "ACTIVE", expires_on: "2027-10-10" })), membershipOrders: data.membershipOrders,
    conversionBindings: dashboardConversionBindings(data, propertyId)
  }, ["2026-10-09", date], date);
}
const primary = { id: "primary", role: "PRIMARY", documentNumber: null };
const booking = { id: "order-one", member_id: "member-one", member_contract_id: "contract-one" };

describe("从已确认住宿升级恢复会员身份", () => {
  it("以命令、唯一主住客和原子会员链确认无证件会员，且仍按日判断有效期", () => {
    const data = fixture();
    expect(dashboardConversionBindings(data, propertyId).get(primary.id)).toEqual({ orderId: booking.id, occupantId: primary.id, memberId: "member-one", verified: true });
    const evidence = projection(data)(primary, booking);
    expect(evidence[date]).toEqual({ status: "CONFIRMED", memberId: "member-one", memberName: "小甲（住客甲）", identityBasis: "STAY_CONVERSION" });
    expect(evidence["2026-10-09"]?.status).toBe("NOT_MEMBER");
    expect(JSON.stringify(evidence)).not.toContain("13800000001");
  });
  it("重放转换前最后一笔更正，不能直接拿最初电话去判身份", () => {
    const data = fixture();
    data.occupants = [{ ...data.occupants[0]!, phone: "13800000000" }];
    data.corrections = [{ occupant_id: "primary", order_id: "order-one", sequence: 1, amendment_sequence: 2,
      prior_full_name: "住客甲", prior_nickname: "小甲", prior_phone: "13800000000", prior_document_number: null,
      corrected_full_name: "住客甲", corrected_nickname: "小甲", corrected_phone: "13800000001", corrected_document_number: null }];
    expect(projection(data)(primary, booking)[date]?.identityBasis).toBe("STAY_CONVERSION");
  });
  it("后续只改昵称保留绑定，姓名、电话、证件更正均不盲目继承", () => {
    for (const field of ["nickname", "full_name", "phone", "document_number"] as const) {
      const data = fixture();
      data.corrections = [{ occupant_id: "primary", order_id: "order-one", sequence: 1, amendment_sequence: 4,
        prior_full_name: "住客甲", prior_nickname: "小甲", prior_phone: "13800000001", prior_document_number: null,
        corrected_full_name: "住客甲", corrected_nickname: "小甲", corrected_phone: "13800000001", corrected_document_number: null,
        [`corrected_${field}`]: "changed" }];
      expect(projection(data)(primary, booking)[date]?.status).toBe(field === "nickname" ? "CONFIRMED" : "UNKNOWN");
    }
  });
  it.each(["full_name", "phone", "identity_card_number"] as const)("会员%s后来更正不能靠碰巧同值恢复旧关系", field => {
    const data = fixture();
    data.memberCorrections = [{ member_id: "member-one", created_at: new Date("2026-10-11T08:00:00Z"),
      prior_full_name: "住客甲", prior_phone: "13800000001", prior_identity_card_number: null,
      corrected_full_name: "住客甲", corrected_phone: "13800000001", corrected_identity_card_number: null,
      [`corrected_${field}`]: "changed" }];
    expect(projection(data)(primary, booking)[date]).toMatchObject({ status: "UNKNOWN", reasonLabel: "升级后身份资料已更正" });
  });
  it("升级后补入不同证件保留更正冲突，不降为确定非会员；独立有效会员证件仍可确认", () => {
    const data = fixture();
    data.members = [{ ...data.members[0]!, identity_card_number: "DOC-MEMBER" }];
    data.corrections = [{ occupant_id: "primary", order_id: "order-one", sequence: 1, amendment_sequence: 4,
      prior_full_name: "住客甲", prior_nickname: "小甲", prior_phone: "13800000001", prior_document_number: null,
      corrected_full_name: "住客甲", corrected_nickname: "小甲", corrected_phone: "13800000001", corrected_document_number: "DOC-DIFFERENT" }];
    expect(dashboardConversionBindings(data, propertyId).get(primary.id)).toMatchObject({ verified: false, reasonLabel: "升级后身份资料已更正" });
    const correctedGuest = { ...primary, documentNumber: "DOC-DIFFERENT" };
    expect(projection(data)(correctedGuest, booking)[date]).toMatchObject({ status: "UNKNOWN", memberId: "member-one", reasonLabel: "升级后身份资料已更正" });
    data.members = [...data.members, { id: "actual-member", identity_card_number: "DOC-DIFFERENT", full_name: "实际会员", nickname: "实际会员", phone: "13800000002" }];
    data.membershipOrders = [...data.membershipOrders, { id: "actual-membership", member_id: "actual-member", contract_id: "actual-contract", entitlement_lot_id: "actual-lot", status: "ACTIVE", created_by_command_id: "other-create", activated_by_command_id: "other-activate" }];
    data.contracts = [...data.contracts, { id: "actual-contract", member_id: "actual-member", membership_order_id: "actual-membership" }];
    data.lots = [...data.lots, { id: "actual-lot", contract_id: "actual-contract" }];
    expect(projection(data)(correctedGuest, booking)[date]).toMatchObject({ status: "CONFIRMED", memberId: "actual-member", identityBasis: "DOCUMENT" });
  });
  it.each(["pending", "receipt", "property", "member", "contract", "lot", "created-command", "activated-command", "late-primary", "duplicate-primary", "duplicate-event", "snapshot", "correction-chain"])("缺失或冲突的%s证据不得自动确认", kind => {
    const data = fixture();
    if (kind === "pending") data.events = [{ ...data.events[0]!, command_state: "EXECUTING" }];
    if (kind === "receipt") data.events = [{ ...data.events[0]!, business_committed: false }];
    if (kind === "property") data.events = [{ ...data.events[0]!, command_property_id: "other-property" }];
    if (kind === "member") data.members = [];
    if (kind === "contract") data.contracts = [];
    if (kind === "lot") data.lots = [];
    if (kind === "created-command") data.membershipOrders = [{ ...data.membershipOrders[0]!, created_by_command_id: "other-command" }];
    if (kind === "activated-command") data.membershipOrders = [{ ...data.membershipOrders[0]!, activated_by_command_id: "other-command" }];
    if (kind === "late-primary") data.occupants = [{ ...data.occupants[0]!, created_at: new Date("2026-10-11T00:00:00Z") }];
    if (kind === "duplicate-primary") data.occupants = [...data.occupants, { ...data.occupants[0]!, id: "other-primary" }];
    if (kind === "duplicate-event") data.events = [...data.events, { ...data.events[0]!, id: "other-event" }];
    if (kind === "snapshot") data.occupants = [{ ...data.occupants[0]!, full_name: "别的住客" }];
    if (kind === "correction-chain") data.corrections = [{ occupant_id: "primary", order_id: "order-one", sequence: 2, amendment_sequence: 2,
      prior_full_name: "住客甲", prior_nickname: "小甲", prior_phone: "13800000000", prior_document_number: null,
      corrected_full_name: "住客甲", corrected_nickname: "小甲", corrected_phone: "13800000001", corrected_document_number: null }];
    expect(projection(data)(primary, booking)[date]?.status).not.toBe("CONFIRMED");
  });
  it("同单同行人、其他订单和后续同名普通住客都不能继承PRIMARY的关系", () => {
    const read = projection(fixture());
    expect(read({ ...primary, id: "companion", role: "ADDITIONAL" }, booking)[date]?.status).toBe("UNKNOWN");
    expect(read(primary, { ...booking, id: "other-order" })[date]?.status).toBe("UNKNOWN");
    expect(read({ ...primary, id: "later-guest" }, {})[date]?.status).toBe("NOT_MEMBER");
  });
  it("临时会员权益订单的自动填充和现时同名同电话仍不算本人关系", () => {
    const data = fixture(); data.events = [];
    expect(projection(data)(primary, booking)[date]).toMatchObject({ status: "UNKNOWN", memberName: "小甲（住客甲）", reasonLabel: "未记录本人入住关系" });
  });
  it("明确证件继续可用，但不能以转换事件覆盖另一个会员的证件", () => {
    const data = fixture();
    data.members = [{ ...data.members[0]!, identity_card_number: "DOC-ONE" }];
    data.occupants = [{ ...data.occupants[0]!, document_number: "DOC-ONE" }];
    expect(projection(data)({ ...primary, documentNumber: "DOC-ONE" }, booking)[date]?.identityBasis).toBe("DOCUMENT");
    expect(projection(data)({ ...primary, documentNumber: "DOC-OTHER" }, booking)[date]).toMatchObject({ status: "UNKNOWN", reasonLabel: "住客与会员证件不一致" });
    data.occupants = [{ ...data.occupants[0]!, document_number: "DOC-CONFLICT" }];
    expect(projection(data)({ ...primary, documentNumber: "DOC-CONFLICT" }, booking)[date]).toMatchObject({ status: "UNKNOWN", reasonLabel: "住客与会员证件不一致" });
  });
  it("实际loader读取同门店事件、原登记和更正后仍以occupantId返回纯身份结论", async () => {
    const data = fixture();
    const tables: Record<string, readonly unknown[]> = {
      "members as m": data.members,
      membership_orders: data.membershipOrders,
      member_contracts: data.contracts.map(contract => ({ ...contract, property_id: propertyId, status: "ACTIVE", valid_from: "2026-10-10", valid_until: "2027-10-10" })),
      entitlement_lots: data.lots.map(lot => ({ ...lot, status: "ACTIVE", expires_on: "2027-10-10" })),
      "amendments as a": data.events, orders: data.orders, order_occupants: data.occupants,
      "order_occupant_corrections as c": data.corrections, member_profile_corrections: data.memberCorrections
    };
    const filters: unknown[][] = [];
    const queried: string[] = [];
    const trx = { selectFrom(table: string) {
      queried.push(table);
      const query: any = { innerJoin: () => query, select: () => query, selectAll: () => query,
        where: (...args: unknown[]) => { filters.push([table, ...args]); return query; }, execute: async () => tables[table] ?? [] };
      return query;
    } } as unknown as Transaction<Database>;
    const read = await loadDashboardMembership(trx, propertyId, [date], date);
    expect(read(primary, booking)[date]).toMatchObject({ status: "CONFIRMED", identityBasis: "STAY_CONVERSION", memberName: "小甲（住客甲）" });
    expect(filters).toContainEqual(["amendments as a", "e.property_id", "=", propertyId]);
    expect(filters).toContainEqual(["amendments as a", "e.state", "=", "APPLIED"]);
    expect(filters).toContainEqual(["orders", "property_id", "=", propertyId]);
    expect(filters).toContainEqual(["member_profile_corrections", "property_id", "=", propertyId]);
    tables["amendments as a"] = [];
    queried.length = 0;
    const noConversion = await loadDashboardMembership(trx, propertyId, [date], date);
    expect(noConversion(primary, booking)[date]).toMatchObject({ status: "UNKNOWN", reasonLabel: "未记录本人入住关系" });
    expect(queried).not.toContain("orders");
    expect(queried).not.toContain("order_occupant_corrections as c");
  });
});
