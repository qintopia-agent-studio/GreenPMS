import { describe, expect, it } from "vitest";
import type { MemberSummaryDto, MembershipOrderSummaryDto } from "../types";
import { effectiveMemberId, formalEntitlementLotIds, isEntitlementLotActive, ledgerEntryDisplayQuantity, ledgerEntryLabel, normalizeMemberQuery, parseEntitlementBalance, shouldClearMemberSearchAfterCommit, yuanInputToMinor } from "./MembersPage";

const members = [
  { member: { id: "member_first" } },
  { member: { id: "member_second" } }
] as MemberSummaryDto[];

describe("member directory state", () => {
  it("keeps a valid selection and falls back when the result set changes", () => {
    expect(effectiveMemberId(members, "member_second")).toBe("member_second");
    expect(effectiveMemberId(members, "member_missing")).toBe("member_first");
    expect(effectiveMemberId([], "member_missing")).toBe("");
  });

  it("trims submitted search text without changing the query content", () => {
    expect(normalizeMemberQuery("  张三  ")).toBe("张三");
    expect(normalizeMemberQuery("  ")).toBe("");
  });

  it("keeps the current member search after commands against an existing profile", () => {
    expect(shouldClearMemberSearchAfterCommit("CORRECT_MEMBER_ENTITLEMENT_BALANCE")).toBe(false);
    expect(shouldClearMemberSearchAfterCommit("CREATE_MEMBERSHIP_ORDER")).toBe(false);
    expect(shouldClearMemberSearchAfterCommit("CREATE_MEMBER")).toBe(true);
  });

  it("converts yuan form input to exact minor units", () => {
    expect(yuanInputToMinor("1620", true)).toBe(162000);
    expect(yuanInputToMinor("936.50")).toBe(93650);
    expect(yuanInputToMinor("0.01")).toBe(1);
    expect(yuanInputToMinor("12.345")).toBeUndefined();
    expect(yuanInputToMinor("936.50", true)).toBeUndefined();
    expect(yuanInputToMinor("-1")).toBeUndefined();
  });

  it("accepts only a non-negative PostgreSQL-safe target entitlement balance", () => {
    expect(parseEntitlementBalance(" 27 ")).toBe(27);
    expect(parseEntitlementBalance("0")).toBe(0);
    expect(parseEntitlementBalance("-1")).toBeUndefined();
    expect(parseEntitlementBalance("1.5")).toBeUndefined();
    expect(parseEntitlementBalance("2147483648")).toBeUndefined();
  });

  it("treats an entitlement lot as active only inside both contract and lot dates", () => {
    const contract = { status: "ACTIVE", valid_from: "2026-07-24", valid_until: "2027-07-24" } as const;
    expect(isEntitlementLotActive(contract, "2027-07-24", "2026-07-24")).toBe(true);
    expect(isEntitlementLotActive(contract, "2027-07-24", "2027-07-24")).toBe(true);
    expect(isEntitlementLotActive(contract, "2027-07-24", "2026-07-23")).toBe(false);
    expect(isEntitlementLotActive(contract, "2027-07-24", "2027-07-25")).toBe(false);
    expect(isEntitlementLotActive(contract, "2026-08-01", "2026-08-02")).toBe(false);
    expect(isEntitlementLotActive({ ...contract, status: "CANCELLED" } as never, "2027-07-24", "2026-08-02")).toBe(false);
  });

  it("shows the consumed unit count instead of the zero balance delta for check-in", () => {
    expect(ledgerEntryDisplayQuantity("CONSUME", 0)).toEqual({ label: "本次核销", quantity: 1, prefix: "", tone: "is-negative" });
    expect(ledgerEntryDisplayQuantity("HOLD", -1)).toEqual({ label: "余额", quantity: -1, prefix: "", tone: "is-negative" });
    expect(ledgerEntryDisplayQuantity("RELEASE", 1)).toEqual({ label: "余额", quantity: 1, prefix: "+", tone: "is-positive" });
  });

  it("distinguishes extension consumption from the original check-in consumption", () => {
    expect(ledgerEntryLabel("CONSUME", "CHECK_IN_ENTITLEMENT_CONSUMED")).toBe("入住核销");
    expect(ledgerEntryLabel("CONSUME", "EXTEND_STAY_ENTITLEMENT_CONSUMED")).toBe("续住核销");
  });

  it("shows multiple formal product entitlements in parallel and excludes unclassified historical lots", () => {
    const membershipOrders = [
      { order: { entitlement_lot_id: "lot_shared_single" } },
      { order: { entitlement_lot_id: "lot_shared_quad" } },
      { order: { entitlement_lot_id: null } }
    ] as MembershipOrderSummaryDto[];

    expect([...formalEntitlementLotIds(membershipOrders)]).toEqual([
      "lot_shared_single",
      "lot_shared_quad"
    ]);
    expect(formalEntitlementLotIds(membershipOrders).has("lot_unclassified_history")).toBe(false);
  });
});
