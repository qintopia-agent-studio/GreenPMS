import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { MemberSummaryDto, MembershipOrderSummaryDto } from "../types";
import { continueStayUpgradeAfterMemberCreated, effectiveMemberId, formalEntitlementLotIds, isEntitlementLotActive, ledgerEntryDisplayQuantity, ledgerEntryLabel, ledgerOrderHref, memberDeepLinkSelection, memberLedgerDisplayItems, MembershipOrdersPanel, normalizeMemberQuery, parseEntitlementBalance, parseMemberDeepLink, parseStayUpgradeMemberCreationIntent, shouldClearMemberSearchAfterCommit, stayUpgradeMemberCreationAutoOpenBlockedNotice, stayUpgradeMemberCreationShouldOpen, stayUpgradeMemberCreationState, stayUpgradeOrderHref, targetEntitlementContractId, targetMembershipOrderDeepLinkId, yuanInputToMinor } from "./MembersPage";

const members = [
  { member: { id: "member_first" } },
  { member: { id: "member_second" } }
] as MemberSummaryDto[];

describe("member directory state", () => {
  it("does not auto-open a stay-upgrade member creation deep link while recovery is blocked", () => {
    const state = stayUpgradeMemberCreationState({
      action: "STAY_MEMBERSHIP_UPGRADE",
      orderId: "order_upgrade",
      primaryOccupantId: "occupant_primary",
      phone: "13800000000",
      prefill: { fullName: "主要住宿人", nickname: "小住" }
    });
    expect(stayUpgradeMemberCreationAutoOpenBlockedNotice(state, true)).toContain("自动打开建档/升级流程未执行");
    expect(stayUpgradeMemberCreationAutoOpenBlockedNotice(state, false)).toBeUndefined();
    expect(stayUpgradeMemberCreationAutoOpenBlockedNotice(undefined, true)).toBeUndefined();
  });

  it("parses member and contract deep links without accepting blank values", () => {
    expect(parseMemberDeepLink("?memberId=member_2&contractId=contract_2&membershipOrderId=membership_order_2")).toEqual({
      memberId: "member_2",
      contractId: "contract_2",
      membershipOrderId: "membership_order_2"
    });
    expect(parseMemberDeepLink("?memberId=%20&contractId=%20&membershipOrderId=%20")).toEqual({});
  });

  it("selects only a member that exists in the current property list", () => {
    expect(memberDeepLinkSelection(members, "member_second")).toBe("member_second");
    expect(memberDeepLinkSelection(members, "member_missing")).toBeUndefined();
    expect(memberDeepLinkSelection(members, undefined)).toBeUndefined();
  });

  it("targets only a contract that owns a displayed formal entitlement", () => {
    const view = {
      contracts: [{ id: "contract_formal" }, { id: "contract_without_product" }],
      lots: [{ id: "lot_formal", contract_id: "contract_formal" }, { id: "lot_history", contract_id: "contract_without_product" }],
      membershipOrders: [{ order: { entitlement_lot_id: "lot_formal" } }]
    } as never;
    expect(targetEntitlementContractId(view, "contract_formal")).toBe("contract_formal");
    expect(targetEntitlementContractId(view, "contract_without_product")).toBeUndefined();
    expect(targetEntitlementContractId(view, "contract_missing")).toBeUndefined();
  });

  it("targets and marks the exact membership order linked from an upgraded stay", () => {
    const order = {
      id: "membership_order_upgrade",
      product_name: "公卫单人间会员",
      entitlement_unit_kind: "ROOM_NIGHT",
      entitlement_units: 30,
      allowed_inventory_kind: "ROOM",
      status: "ACTIVE",
      listed_price_minor: 162_000,
      agreed_price_minor: 162_000,
      price_adjustment_minor: 0,
      price_adjustment_reason: null,
      currency: "CNY",
      valid_from: "2026-08-26",
      valid_until: "2027-08-26"
    };
    const view = {
      membershipProducts: [],
      membershipOrders: [{
        order,
        paymentFacts: [],
        paymentTotalMinor: 162_000,
        paymentDifferenceMinor: 0
      }]
    } as never;
    expect(targetMembershipOrderDeepLinkId(view, order.id)).toBe(order.id);
    expect(targetMembershipOrderDeepLinkId(view, "membership_order_other")).toBeUndefined();

    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MembershipOrdersPanel, {
      view,
      disabled: false,
      targetMembershipOrderId: order.id,
      canCreate: true,
      canRecordPayment: true,
      canCorrectPayment: true,
      canActivate: true,
      onCreate: () => undefined,
      onPayment: () => undefined,
      onCorrect: () => undefined,
      onActivate: () => undefined
    })));
    expect(html).toContain('data-testid="membership-order-target"');
    expect(html).toContain('data-membership-order-id="membership_order_upgrade"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("当前住宿升级");
  });

  it("links only ledger entries associated with a lodging order", () => {
    expect(ledgerOrderHref({ order_id: "order_member_1" } as never)).toBe("/orders/order_member_1");
    expect(ledgerOrderHref({ order_id: null } as never)).toBeUndefined();
  });

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

  it("groups one stay-to-membership conversion into a single readable ledger row", () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      fact_id: `fact_${index}`,
      lot_id: "lot_conversion",
      entry_type: "CONVERSION_CONSUME",
      quantity_delta: -1,
      service_date: `2026-07-${String(25 + index).padStart(2, "0")}`,
      order_id: "order_conversion",
      coverage_id: null,
      reason: "STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED",
      command_id: "command_conversion",
      created_at: `2026-08-01T00:00:0${index}.000Z`
    })) as never;
    const displayItems = memberLedgerDisplayItems(entries);
    expect(displayItems).toHaveLength(1);
    expect(displayItems[0]).toMatchObject({
      kind: "conversion",
      quantity: 7,
      serviceStart: "2026-07-25",
      serviceEnd: "2026-08-01"
    });
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

  it("prefills a new member from the primary lodging occupant and preserves a constrained return-to-upgrade state", () => {
    const state = stayUpgradeMemberCreationState({
      action: "STAY_MEMBERSHIP_UPGRADE",
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      phone: " 138 0000 0000 ",
      prefill: {
        fullName: "主要住宿人",
        nickname: "小住"
      }
    });
    expect(state).toEqual({
      fullName: "主要住宿人",
      nickname: "小住",
      phone: "13800000000",
      returnTo: {
        action: "STAY_MEMBERSHIP_UPGRADE",
        orderId: "order_in_house_upgrade",
        primaryOccupantId: "occupant_primary_upgrade",
        phone: "13800000000"
      }
    });
    expect(stayUpgradeMemberCreationShouldOpen(state, true)).toBe(false);
    expect(stayUpgradeMemberCreationShouldOpen(state, false)).toBe(true);
    expect(stayUpgradeMemberCreationShouldOpen(undefined, false)).toBe(false);
  });

  it("returns to the exact stay-upgrade only after the created member's phone matches the original primary occupant", () => {
    const creationState = stayUpgradeMemberCreationState({
      action: "STAY_MEMBERSHIP_UPGRADE",
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      phone: "13800000000",
      prefill: { fullName: "主要住宿人", nickname: "小住" }
    });

    expect(continueStayUpgradeAfterMemberCreated(creationState, {
      id: "member_created_from_stay",
      phone: "138 0000 0000"
    })).toEqual({
      action: "STAY_MEMBERSHIP_UPGRADE",
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      memberId: "member_created_from_stay"
    });
    expect(continueStayUpgradeAfterMemberCreated(creationState, {
      id: "member_wrong_phone",
      phone: "13900000000"
    })).toBeUndefined();
    expect(continueStayUpgradeAfterMemberCreated(creationState, {
      id: "member_without_phone",
      phone: null
    })).toBeUndefined();
  });

  it("round-trips only a constrained stay-upgrade member creation target", () => {
    const parsed = parseStayUpgradeMemberCreationIntent("?action=STAY_MEMBERSHIP_UPGRADE&orderId=order%2Fone&primaryOccupantId=occupant_primary&phone=138%200000%200000&fullName=%E4%B8%BB%E8%A6%81%E4%BD%8F%E5%AE%BF%E4%BA%BA&nickname=%E5%B0%8F%E4%BD%8F");
    expect(stayUpgradeMemberCreationState(parsed)).toMatchObject({
      phone: "13800000000",
      returnTo: { orderId: "order/one", primaryOccupantId: "occupant_primary" }
    });
    expect(parseStayUpgradeMemberCreationIntent("?action=STAY_MEMBERSHIP_UPGRADE&orderId=order_one&phone=13800000000")).toBeUndefined();
    expect(stayUpgradeOrderHref({
      action: "STAY_MEMBERSHIP_UPGRADE",
      orderId: "order/one",
      primaryOccupantId: "occupant_primary",
      memberId: "member/new"
    })).toBe("/orders/order%2Fone?action=CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP&memberId=member%2Fnew");
  });
});
