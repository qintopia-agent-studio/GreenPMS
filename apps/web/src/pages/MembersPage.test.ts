import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { MemberSummaryDto, MembershipOrderSummaryDto, OrderRowDto } from "../types";
import { availableMemberCorrectionCommandTypes, continueStayUpgradeAfterMemberCreated, currentOrFirstCandidateId, effectiveMemberId, eligibleMembershipReconversionStays, formalEntitlementLotIds, isEntitlementLotActive, ledgerEntryDisplayQuantity, ledgerEntryLabel, ledgerOrderHref, loadMembershipReconversionStayCandidates, memberCorrectionCommandTypes, memberDeepLinkSelection, memberLedgerDisplayItems, MemberCorrectionDialog, MemberCorrectionHistoryPanel, MemberProfile, MembershipOrdersPanel, normalizeMemberQuery, parseEntitlementBalance, parseMemberDeepLink, parseStayUpgradeMemberCreationIntent, shouldClearMemberSearchAfterCommit, stayUpgradeMemberCreationAutoOpenBlockedNotice, stayUpgradeMemberCreationShouldOpen, stayUpgradeMemberCreationState, stayUpgradeOrderHref, targetEntitlementContractId, targetMembershipOrderDeepLinkId, yuanInputToMinor } from "./MembersPage";

const members = [
  { member: { id: "member_first" } },
  { member: { id: "member_second" } }
] as MemberSummaryDto[];

describe("member directory state", () => {
  it("derives the correction entry strictly from administrator command grants", () => {
    expect(availableMemberCorrectionCommandTypes(() => false)).toEqual([]);
    const allowed = new Set(memberCorrectionCommandTypes);
    expect(availableMemberCorrectionCommandTypes((commandType) => allowed.has(commandType))).toEqual(memberCorrectionCommandTypes);

    const view = { member: { full_name: "会员甲", nickname: "甲", identity_card_number: null, phone: "13800000000", wechat: "member-a" } } as never;
    const ordinaryHtml = renderToStaticMarkup(createElement(MemberProfile, { member: view, canCorrect: false, disabled: false, onCorrect: () => undefined }));
    const administratorHtml = renderToStaticMarkup(createElement(MemberProfile, { member: view, canCorrect: true, disabled: false, onCorrect: () => undefined }));
    expect(ordinaryHtml).not.toContain("修改会员记录");
    expect(administratorHtml).toContain('data-testid="open-member-corrections"');
    expect(administratorHtml).toContain("修改会员记录");
    expect(administratorHtml).not.toContain("纠正会员记录");
  });

  it("offers completed WECOM stays only when the phone matches and any two supplied documents agree", () => {
    const eligible = {
      id: "order_eligible",
      status: "CHECKED_OUT",
      stay_status: "COMPLETED",
      booking_channel_code: "WECOM",
      member_id: null,
      member_contract_id: null,
      primary_guest_snapshot: { fullName: "会员甲", phone: "138 0000 0000" }
    } as unknown as OrderRowDto;
    const candidates = eligibleMembershipReconversionStays([
      { order: eligible, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "138 0000 0000", documentNumber: " 510000199001010011 " } },
      { order: { ...eligible, id: "order_other_phone" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13900000000", documentNumber: "510000199001010011" } },
      { order: { ...eligible, id: "order_other_identity" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010099" } },
      { order: { ...eligible, id: "order_internal_space_identity" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000 199001010011" } },
      { order: { ...eligible, id: "order_missing_identity" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: null } },
      { order: { ...eligible, id: "order_document_only" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: null, documentNumber: "510000199001010011" } },
      { order: { ...eligible, id: "order_missing_both" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: null, documentNumber: null } },
      { order: { ...eligible, id: "order_not_completed", stay_status: "IN_HOUSE" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010011" } },
      { order: { ...eligible, id: "order_member_stay", member_id: "member_existing" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010011" } },
      { order: { ...eligible, id: "order_other_channel", booking_channel_code: "CTRIP" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010011" } }
    ], "13800000000", "510000199001010011");
    expect(candidates.map(({ order }) => order.id)).toEqual(["order_eligible", "order_missing_identity"]);
    expect(eligibleMembershipReconversionStays([
      { order: eligible, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010011" } },
      { order: { ...eligible, id: "order_other_identity" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010099" } },
      { order: { ...eligible, id: "order_missing_identity" }, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: null } }
    ], "13800000000", null).map(({ order }) => order.id)).toEqual([
      "order_eligible",
      "order_other_identity",
      "order_missing_identity"
    ]);
  });

  it("uses the corrected primary occupant projection when loading membership reconstruction candidates", async () => {
    const staleOrder = {
      id: "order_corrected_phone",
      property_id: "property_green",
      status: "CHECKED_OUT",
      stay_status: "COMPLETED",
      booking_channel_code: "WECOM",
      member_id: null,
      member_contract_id: null,
      primary_guest_snapshot: { fullName: "旧姓名", phone: "13900000000" }
    } as unknown as OrderRowDto;
    const loaded = await loadMembershipReconversionStayCandidates([staleOrder], async () => ({
      order: staleOrder,
      occupants: [{ role: "PRIMARY", fullName: "会员甲", nickname: "甲", phone: "13800000000", documentNumber: "510000199001010011" }]
    } as never));

    expect(eligibleMembershipReconversionStays(loaded, "13800000000", "510000199001010011").map(({ order }) => order.id)).toEqual(["order_corrected_phone"]);
  });

  it("isolates an unreadable legacy order without hiding other membership reconstruction candidates", async () => {
    const candidate = {
      id: "order_readable",
      property_id: "property_green",
      status: "CHECKED_OUT",
      stay_status: "COMPLETED",
      booking_channel_code: "WECOM",
      member_id: null,
      member_contract_id: null
    } as unknown as OrderRowDto;
    const unreadable = { ...candidate, id: "order_unreadable" };
    const loadOrder = async (orderId: string) => {
      if (orderId === unreadable.id) throw new Error("遗留订单详情无法解析");
      return {
        order: candidate,
        occupants: [{ role: "PRIMARY", fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: null }]
      } as never;
    };

    await expect(loadMembershipReconversionStayCandidates([unreadable], loadOrder)).rejects.toThrow("遗留订单详情无法解析");
    await expect(loadMembershipReconversionStayCandidates([unreadable, candidate], loadOrder)).resolves.toEqual([{
      order: candidate,
      primaryOccupant: { role: "PRIMARY", fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: null }
    }]);
  });

  it("selects the first real ids after correction candidates load asynchronously", () => {
    expect(currentOrFirstCandidateId("", [])).toBe("");
    expect(currentOrFirstCandidateId("", ["membership_order_wrong"])).toBe("membership_order_wrong");
    expect(currentOrFirstCandidateId("", ["order_source"])).toBe("order_source");
    expect(currentOrFirstCandidateId("order_source", ["order_source", "order_other"])).toBe("order_source");
  });

  it("renders reconstruction as a non-refund flow without a writable amount", () => {
    const view = {
      member: { id: "member_a", full_name: "会员甲", nickname: "甲", identity_card_number: null, phone: "13800000000", wechat: "member-a" },
      balanceAsOfDate: "2026-09-02",
      membershipProducts: [],
      membershipOrders: [{ order: { id: "membership_order_wrong", status: "ACTIVE", product_name: "公卫四人间会员", valid_from: "2026-08-01", valid_until: "2027-08-01" }, paymentFacts: [] }]
    } as never;
    const sourceStay = {
      id: "order_source",
      status: "CHECKED_OUT",
      stay_status: "COMPLETED",
      booking_channel_code: "WECOM",
      member_id: null,
      member_contract_id: null,
      primary_guest_snapshot: { fullName: "会员甲", phone: "13800000000", documentNumber: "510000199001010011" },
      arrival_date: "2026-08-01",
      departure_date: "2026-08-03",
      current_unit_code: "108"
    } as unknown as OrderRowDto;
    const html = renderToStaticMarkup(createElement(MemberCorrectionDialog, {
      propertyId: "property_green",
      view,
      availableCommands: [...memberCorrectionCommandTypes],
      stayOrders: [{ order: sourceStay, primaryOccupant: { fullName: "会员甲", nickname: null, phone: "13800000000", documentNumber: "510000199001010011" } }],
      stayOrdersLoading: false,
      draft: {
        commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
        title: "返回修改",
        description: "返回修改",
        input: {
          propertyId: "property_green",
          erroneousMembershipOrderId: "membership_order_wrong",
          sourceStayOrderId: "order_source",
          actualMembershipDate: "2026-08-01",
          evidenceNote: "企微与合同复核"
        }
      },
      onClose: () => undefined,
      onSubmit: () => undefined
    }));
    expect(html).toContain("这不是退款");
    expect(html).toContain("这里只处理办卡记录错误且权益从未使用的情况");
    expect(html).toContain("对应历史住宿");
    expect(html).toContain('max="2026-09-02"');
    expect(html).toContain('class="span-two check-row"');
    expect(html).toContain('maxLength="1000" data-testid="member-correction-evidence"');
    expect(html).not.toContain("冲销金额");
    expect(html).not.toContain('data-testid="historical-membership-payment-yuan"');
  });

  it("uses plain membership modification labels and date-only independent start and payment facts", () => {
    const view = {
      member: { id: "member_a", full_name: "会员甲", nickname: "甲", identity_card_number: null, phone: "13800000000", wechat: "member-a" },
      balanceAsOfDate: "2026-09-02",
      membershipProducts: [{ id: "product_a", name: "公卫单人间会员", entitlement_unit_kind: "ROOM_NIGHT", entitlement_units: 30 }],
      membershipOrders: []
    } as never;
    const html = renderToStaticMarkup(createElement(MemberCorrectionDialog, {
      propertyId: "property_green",
      view,
      availableCommands: ["BACKFILL_HISTORICAL_MEMBERSHIP"],
      stayOrders: [],
      stayOrdersLoading: false,
      draft: {
        commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
        title: "返回修改",
        description: "返回修改",
        input: {
          propertyId: "property_green",
          memberId: "member_a",
          membershipProductId: "product_a",
          actualMembershipDate: "2026-08-14",
          payment: { amountMinor: 162_000, businessDate: "2026-08-12", transactionReference: "WX-HISTORY-001" },
          evidenceNote: "企微账单和会员约定已核对"
        }
      },
      onClose: () => undefined,
      onSubmit: () => undefined
    }));
    expect(html).toContain("修改会员记录");
    expect(html).toContain("修改类型");
    expect(html).toContain("会员开始日期");
    expect(html).toContain("企业微信收款日期");
    expect(html).toContain('data-testid="historical-membership-payment-date"');
    expect(html).toContain('type="date"');
    expect(html).toContain('class="info-hint-bubble"');
    expect(html).not.toContain('type="datetime-local"');
    expect(html).not.toContain("纠错类型");
    expect(html).not.toContain("纠正会员资料");
    expect(html).not.toContain("纠正办卡生效日");
  });

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

  it("labels voided membership orders as historical facts without offering active-order actions", () => {
    const view = {
      membershipProducts: [],
      membershipOrders: [{
        order: {
          id: "membership_order_voided",
          product_name: "公卫四人间会员",
          entitlement_unit_kind: "ROOM_NIGHT",
          entitlement_units: 30,
          allowed_inventory_kind: "ROOM",
          status: "VOIDED",
          listed_price_minor: 93_600,
          agreed_price_minor: 93_600,
          price_adjustment_minor: 0,
          price_adjustment_reason: null,
          currency: "CNY",
          valid_from: "2026-08-10",
          valid_until: "2027-08-10"
        },
        paymentFacts: [],
        paymentTotalMinor: 0,
        paymentDifferenceMinor: -93_600
      }]
    } as never;
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MembershipOrdersPanel, {
      view,
      disabled: false,
      canCreate: true,
      canRecordPayment: true,
      canCorrectPayment: true,
      canActivate: true,
      onCreate: () => undefined,
      onPayment: () => undefined,
      onCorrect: () => undefined,
      onActivate: () => undefined
    })));
    expect(html).toContain("已作废");
    expect(html).not.toContain('data-testid="record-membership-payment"');
    expect(html).not.toContain('data-testid="activate-membership-order"');
  });

  it("keeps the standard collection action available on an active underpaid membership only", () => {
    const order = {
      id: "membership_order_active",
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
      valid_from: "2026-08-10",
      valid_until: "2027-08-10"
    };
    const render = (paymentDifferenceMinor: number) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MembershipOrdersPanel, {
      view: { membershipProducts: [], membershipOrders: [{ order, paymentFacts: [], paymentTotalMinor: 93_600, paymentDifferenceMinor }] } as never,
      disabled: false,
      canCreate: true,
      canRecordPayment: true,
      canCorrectPayment: true,
      canActivate: true,
      onCreate: () => undefined,
      onPayment: () => undefined,
      onCorrect: () => undefined,
      onActivate: () => undefined
    })));
    const underpaid = render(-68_400);
    expect(underpaid).toContain('data-testid="record-membership-payment"');
    expect(underpaid).toContain(">收款</button>");
    expect(underpaid).not.toContain("继续收款");
    expect(render(0)).not.toContain('data-testid="record-membership-payment"');
    expect(render(100)).not.toContain('data-testid="record-membership-payment"');
  });

  it("renders persistent administrator correction history with masked profile facts and separate business time", () => {
    const view = {
      profileCorrections: [{
        id: "profile_correction_1",
        changed_fields: ["phone", "identityCardNumber"],
        prior_phone: "13800000001",
        corrected_phone: "13900000002",
        prior_identity_card_number: "510000199001010011",
        corrected_identity_card_number: "510000199001010022",
        evidence_note: "证件和企微资料已核对",
        command_id: "command_profile",
        created_at: "2026-09-02T08:00:00.000Z",
        actor: { subjectId: "subject_admin", displayName: "运营管理员" }
      }],
      effectiveDateCorrections: [],
      historicalMembershipBackfills: [{
        id: "backfill_1",
        product_name: "公卫四人间会员",
        actual_membership_date: "2026-08-10",
        valid_until: "2027-08-10",
        agreed_price_minor: 93_600,
        currency: "CNY",
        entitlement_unit_kind: "BED_NIGHT",
        entitlement_units: 30,
        validity_period: "P1Y",
        business_date: "2026-08-10",
        transaction_reference: "WECOM-HISTORY-001",
        evidence_note: "企微账单与合同已核对",
        command_id: "command_backfill",
        created_at: "2026-09-02T08:10:00.000Z",
        actor: { subjectId: "subject_admin", displayName: "运营管理员" }
      }],
      paymentReclassifications: [{
        id: "reclassification_1",
        amount_minor: 93_650,
        currency: "USD",
        evidence_note: "旧会员收款记账凭证已核对",
        command_id: "command_reclassification",
        created_at: "2026-09-02T08:20:00.000Z",
        actor: { subjectId: "subject_admin", displayName: "运营管理员" }
      }],
      voidReconversions: [{
        id: "void_reconversion_1",
        source_order_id: "order_source",
        actual_membership_date: "2026-08-10",
        valid_until: "2027-08-10",
        old_direct_collection_total_minor: 93_650,
        stay_transfer_total_minor: 20_050,
        membership_agreed_price_minor: 93_650,
        currency: "USD",
        service_dates: ["2026-08-10", "2026-08-11"],
        replacement_business_date: "2026-08-12",
        replacement_transaction_reference: "WECOM-DIFFERENCE-001",
        evidence_note: "住宿与办卡凭证已核对",
        command_id: "command_void_reconversion",
        created_at: "2026-09-02T08:21:00.000Z",
        actor: { subjectId: "subject_admin", displayName: "运营管理员" }
      }]
    } as never;
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MemberCorrectionHistoryPanel, { view })));
    expect(html).toContain("修改与补录记录");
    expect(html).toContain("运营管理员");
    expect(html).toContain("历史办卡补录");
    expect(html).toContain("成交价与权益");
    expect(html).toContain("有效期规则");
    expect(html).toContain("1 年");
    expect(html).not.toContain("收款与权益");
    expect(html).toContain("企业微信收款日期");
    expect(html).toContain("原错误收款不再计入会员实收，也未计入新会员订单");
    expect(html).not.toContain("原错误收款已冲销并转入正确会员订单");
    expect(html).toContain("差额企微交易单号");
    expect(html).toContain("WECOM-DIFFERENCE-001");
    expect(html).toContain("936.50");
    expect(html).toContain("138****0001");
    expect(html).toContain("**************0011");
    expect(html).not.toContain("13800000001");
    expect(html).not.toContain("510000199001010011");
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
    expect(ledgerEntryDisplayQuantity("VOID", -30)).toEqual({ label: "本次作废", quantity: 30, prefix: "", tone: "is-negative" });
  });

  it("distinguishes extension consumption from the original check-in consumption", () => {
    expect(ledgerEntryLabel("CONSUME", "CHECK_IN_ENTITLEMENT_CONSUMED")).toBe("入住核销");
    expect(ledgerEntryLabel("CONSUME", "EXTEND_STAY_ENTITLEMENT_CONSUMED")).toBe("续住核销");
    expect(ledgerEntryLabel("VOID")).toBe("错误权益作废");
    expect(ledgerEntryLabel("EXPIRE")).toBe("权益到期");
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
