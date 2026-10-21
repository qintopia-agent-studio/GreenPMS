import { describe, expect, it } from "vitest";
import { dashboardMembershipProjection, type DashboardMembershipData } from "./dashboard-membership.ts";

const today = "2026-10-21";
const dates = ["2026-10-01", "2026-10-10", today];
const member = { id: "member-one", identity_card_number: "DOC-ONE" };
const contract = { id: "contract-one", member_id: member.id, membership_order_id: "membership-one", status: "ACTIVE" as const, valid_from: "2026-10-01", valid_until: "2027-09-30" };
const lot = { id: "lot-one", contract_id: contract.id, status: "ACTIVE" as const, expires_on: contract.valid_until };
const membershipOrder = { id: "membership-one", member_id: member.id, contract_id: contract.id, entitlement_lot_id: lot.id, status: "ACTIVE" as const };
const data = (overrides: Partial<DashboardMembershipData> = {}): DashboardMembershipData => ({ members: [member], contracts: [contract], lots: [lot], membershipOrders: [membershipOrder], ...overrides });
const guest = { documentNumber: " doc-one " };

describe("dashboard exact guest membership evidence", () => {
  it("recognizes a member in an ordinary lodging order by exact document alone", () => {
    const evidence = dashboardMembershipProjection(data(), dates, today)(guest, {});
    expect(evidence[today]).toEqual({ status: "CONFIRMED", memberId: member.id });
  });
  it("does not treat an order payer as its undocumented guest", () => {
    const evidence = dashboardMembershipProjection(data(), dates, today)({ documentNumber: null }, { member_id: member.id });
    expect(evidence[today]).toMatchObject({ status: "UNKNOWN", memberId: member.id });
    expect(evidence[today]?.reason).toContain("不能用订单会员主体");
  });
  it("does not count a documented roommate with a different identity as the order member", () => {
    const evidence = dashboardMembershipProjection(data(), dates, today)({ documentNumber: "DOC-ROOMMATE" }, { member_id: member.id });
    expect(evidence[today]).toEqual({ status: "NOT_MEMBER", memberId: null });
  });
  it("keeps a missing member document unresolved even if the guest has a document", () => {
    const evidence = dashboardMembershipProjection(data({ members: [{ ...member, identity_card_number: null }] }), dates, today)(guest, { member_id: member.id });
    expect(evidence[today]).toMatchObject({ status: "UNKNOWN", memberId: member.id });
  });
  it("refuses ambiguous document matches", () => {
    const evidence = dashboardMembershipProjection(data({ members: [member, { id: "duplicate", identity_card_number: member.identity_card_number }] }), dates, today)(guest, {});
    expect(evidence[today]).toMatchObject({ status: "UNKNOWN", memberId: null });
  });
  it("counts the guest's own active membership when another member is the payer", () => {
    const evidence = dashboardMembershipProjection(data({ members: [member, { id: "payer", identity_card_number: "DOC-PAYER" }] }), dates, today)(guest, { member_id: "payer" });
    expect(evidence[today]).toEqual({ status: "CONFIRMED", memberId: member.id });
  });
  it("checks activation and the earlier of contract and lot expiry on every statistical day", () => {
    const evidence = dashboardMembershipProjection(data({ contracts: [{ ...contract, valid_from: "2026-10-10" }], lots: [{ ...lot, expires_on: "2026-10-10" }] }), dates, today)(guest, {});
    expect(evidence["2026-10-01"]?.status).toBe("NOT_MEMBER");
    expect(evidence["2026-10-10"]?.status).toBe("CONFIRMED");
    expect(evidence[today]?.status).toBe("NOT_MEMBER");
  });
  it("keeps valid historical membership after the contract has expired", () => {
    const evidence = dashboardMembershipProjection(data({ contracts: [{ ...contract, status: "EXPIRED", valid_until: "2026-10-10" }] }), dates, today)(guest, {});
    expect(evidence["2026-10-01"]?.status).toBe("CONFIRMED");
    expect(evidence["2026-10-10"]?.status).toBe("CONFIRMED");
    expect(evidence[today]?.status).toBe("NOT_MEMBER");
  });
  it.each(["contract", "lot", "order"] as const)("keeps historical %s voids unresolved instead of erasing past membership", kind => {
    const evidence = dashboardMembershipProjection(data({
      ...(kind === "contract" ? { contracts: [{ ...contract, status: "VOIDED" as const }] } : {}),
      ...(kind === "lot" ? { lots: [{ ...lot, status: "VOIDED" as const }] } : {}),
      ...(kind === "order" ? { membershipOrders: [{ ...membershipOrder, status: "VOIDED" as const }] } : {})
    }), dates, today)(guest, {});
    expect(evidence["2026-10-10"]?.status).toBe("UNKNOWN");
    expect(evidence[today]?.status).toBe("NOT_MEMBER");
  });
  it("allows another verified valid contract to establish membership despite a voided old contract", () => {
    const evidence = dashboardMembershipProjection(data({ contracts: [{ ...contract, id: "void-old", status: "VOIDED", membership_order_id: null }, contract] }), dates, today)(guest, {});
    expect(evidence["2026-10-10"]?.status).toBe("CONFIRMED");
  });
  it("does not confirm a contract with missing or mismatched entitlement evidence", () => {
    for (const fixture of [data({ lots: [] }), data({ membershipOrders: [] }), data({ membershipOrders: [{ ...membershipOrder, entitlement_lot_id: "wrong-lot" }] })]) {
      expect(dashboardMembershipProjection(fixture, dates, today)(guest, {})[today]?.status).toBe("UNKNOWN");
    }
  });
  it("does not report a missing associated member as a verified zero", () => {
    const evidence = dashboardMembershipProjection(data({ members: [] }), dates, today)(guest, { member_id: "missing" });
    expect(evidence[today]).toMatchObject({ status: "UNKNOWN", memberId: "missing" });
  });
  it("can resolve a contract-only booking reference without treating it as guest identity", () => {
    const evidence = dashboardMembershipProjection(data(), dates, today)({ documentNumber: null }, { member_contract_id: contract.id });
    expect(evidence[today]).toMatchObject({ status: "UNKNOWN", memberId: member.id });
  });
});
