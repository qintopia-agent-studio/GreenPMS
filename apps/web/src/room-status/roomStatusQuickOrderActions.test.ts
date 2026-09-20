import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderActionCode } from "@qintopia/contracts";
import type { MemberViewDto, OrderViewDto } from "../types";
import { RoomStatusQuickOrderContent } from "./RoomStatusQuickPopover";
import type { RoomStatusOrderOption } from "./roomStatusState";
import {
  roomStatusMatchingQuickOrder, roomStatusQuickOrderActions, roomStatusQuickOrderChannelFacts, roomStatusQuickOrderFundsFacts,
  roomStatusQuickOrderMembershipFacts, roomStatusQuickOrderNotices
} from "./roomStatusQuickOrderActions";

const day = "2026-09-20";
const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
const option: RoomStatusOrderOption = {
  identity: { orderId: "order_1", stayId: "stay_1", intervalId: "interval_1", unitId: "room_1",
    intervalStartDate: day, intervalEndDate: "2026-09-23", arrivalDate: day, departureDate: "2026-09-23" },
  label: "山风", operationalAttention: null,
  source: { sourceKind: "ORDER", sourceCategory: "DIRECT", freeStayCategoryCode: null, freeStayReason: null }
};
function view(status = "RESERVED"): OrderViewDto {
  const interval = { inventoryUnitId: "room_1", arrivalDate: day, departureDate: "2026-09-23" };
  const result: OrderViewDto = {
    accessLevel: "WRITE", allowedActions: [],
    order: { id: "order_1", property_id: "property_1", status, stay_type: "TRANSIENT", arrival_date: day,
      departure_date: "2026-09-23", primary_guest_snapshot: {}, booking_channel_code: "WECOM", channel_order_reference: null,
      free_stay_reason: null, free_stay_category_code: null, pricing_policy_version_id: "policy_1", member_id: null,
      member_contract_id: null, current_revision_id: "revision_1", current_contract_amount_minor: 30000, currency: "CNY",
      version: 1, created_at: `${day}T00:00:00Z`, updated_at: `${day}T00:00:00Z` },
    occupants: [{ id: "guest_1", orderId: "order_1", ordinal: 1, role: "PRIMARY", fullName: "张某", nickname: "山风",
      phone: null, documentNumber: null, createdAt: `${day}T00:00:00Z` }],
    occupantCorrections: [], stay: { id: "stay_1", status: status === "CHECKED_IN" ? "IN_HOUSE" : "PLANNED" },
    currentSegment: { id: "segment_1", sequence: 1, ...interval }, segments: [],
    originalArrangement: { arrivalDate: day, departureDate: "2026-09-23", intervals: [interval] },
    effectiveArrangement: { arrivalDate: day, departureDate: "2026-09-23", intervals: [interval], presentation: "CURRENT", businessDate: day },
    fulfillment: { state: status === "CHECKED_IN" ? "IN_HOUSE" : "NOT_CHECKED_IN", checkIn: null, checkOut: null, checkInRevocation: null },
    arrangementHistory: [], referencedInventoryUnits: [], amendments: [], pricingRevisions: [], membershipConversion: null,
    coverageSet: [], collectionFacts: [], cleaningTasks: [],
    amounts: { currentContractAmount: money(30000), netRecordedCollection: money(10000), collectionDifference: money(20000), refundReferenceAmount: money(0) }
  };
  const codes: OrderActionCode[] = status === "CHECKED_IN"
    ? ["CHECK_OUT", "SHORTEN_STAY", "EXTEND_STAY", "MOVE_UNIT", "RECORD_COLLECTION", "RECORD_REFUND"]
    : ["CHECK_IN", "RESCHEDULE_STAY", "MOVE_UNIT", "RECORD_COLLECTION", "RECORD_REFUND", "CANCEL_ORDER"];
  result.allowedActions = codes.map((code) => ({ code, enabled: true, disabledReason: null }));
  return result;
}

function memberStay(): OrderViewDto {
  const result = view("CHECKED_IN");
  result.order.member_id = "member_1";
  result.order.member_contract_id = "contract_used";
  result.amounts = { currentContractAmount: money(0), netRecordedCollection: money(0), collectionDifference: money(0), refundReferenceAmount: money(0) };
  result.coverageSet = ["2026-09-20", "2026-09-21", "2026-09-22"].map((service_date, index) => ({
    id: `coverage_${index}`, order_id: "order_1", contract_id: "contract_used", lot_id: "lot_used",
    inventory_unit_id: "room_1", service_date, unit_kind: "ROOM_NIGHT", status: "CONSUMED",
    held_by_revision_id: "revision_1", created_at: `${day}T00:00:00Z`, updated_at: `${day}T00:00:00Z`
  }));
  return result;
}

function memberView(): MemberViewDto {
  return {
    member: { id: "member_1", identity_card_number: null, nickname: "山风", full_name: "张某", phone: "", wechat: "", created_at: `${day}T00:00:00Z` },
    contracts: [{ id: "contract_used", property_id: "property_1", member_id: "member_1", member_name: "张某", status: "ACTIVE", valid_from: day, valid_until: "2027-09-19", version: 1, created_at: `${day}T00:00:00Z` }],
    lots: [{ id: "lot_used", contract_id: "contract_used", unit_kind: "ROOM_NIGHT", total_units: 30, expires_on: "2027-09-19", status: "ACTIVE", version: 1, created_at: `${day}T00:00:00Z` }],
    ledger: [], externalReferences: [], lotBalances: [{ lotId: "lot_other", unitKind: "BED_NIGHT", availableUnits: 999 }, { lotId: "lot_used", unitKind: "ROOM_NIGHT", availableUnits: 27 }],
    availableBalance: { ROOM_NIGHT: 888, BED_NIGHT: 999 }, balanceAsOfDate: day, membershipProducts: [],
    membershipOrders: [{ order: {
      id: "membership_order_used", property_id: "property_1", member_id: "member_1", product_id: "product_used", product_code: "ROOM_SINGLE",
      product_version: 1, product_name: "独卫单人间会员", listed_price_minor: 216000, agreed_price_minor: 216000, price_adjustment_minor: 0,
      price_adjustment_reason: null, currency: "CNY", entitlement_unit_kind: "ROOM_NIGHT", entitlement_units: 30, validity_period: "P1Y",
      allowed_room_type_code: "ROOM_SINGLE", allowed_inventory_kind: "ROOM", status: "ACTIVE", activated_at: `${day}T00:00:00Z`,
      valid_from: day, valid_until: "2027-09-19", contract_id: "contract_used", entitlement_lot_id: "lot_used", version: 1,
      created_by_command_id: "command_member", activated_by_command_id: "command_member", created_at: `${day}T00:00:00Z`, updated_at: `${day}T00:00:00Z`
    }, paymentFacts: [], paymentTotalMinor: 216000, paymentDifferenceMinor: 0 }],
    profileCorrections: [], effectiveDateCorrections: [], historicalMembershipBackfills: [], paymentReclassifications: [], voidReconversions: []
  };
}

describe("room-status quick order authorization and targeting", () => {
  it("does not attach another order, another stay, or an ambiguous reference to quick actions", () => {
    const current = view();
    expect(roomStatusMatchingQuickOrder(current, { kind: "READY", orders: [option] })).toBe(option);
    expect(roomStatusMatchingQuickOrder({ ...current, stay: { ...current.stay, id: "other_stay" } }, { kind: "READY", orders: [option] })).toBeUndefined();
    expect(roomStatusMatchingQuickOrder({ ...current, order: { ...current.order, id: "other_order" } }, { kind: "READY", orders: [option] })).toBeUndefined();
    expect(roomStatusMatchingQuickOrder(current, { kind: "READY", orders: [option, option] })).toBeUndefined();
    expect(roomStatusMatchingQuickOrder(current, { kind: "INVALID_REFERENCE" })).toBeUndefined();
  });

  it("starts a reservation at its authorized actions without inventing permissions from the state", () => {
    const current = view();
    expect(roomStatusQuickOrderActions(current).primary.map((item) => item.code)).toEqual(["CHECK_IN", "RECORD_COLLECTION", "RESCHEDULE_STAY", "MOVE_UNIT"]);
    current.allowedActions = [];
    expect(roomStatusQuickOrderActions(current).primary.map((item) => item.code)).toEqual(["VIEW_FUNDS"]);
    expect(roomStatusQuickOrderActions(current).more).toEqual([]);
  });

  it("keeps future check-in disabled with its reason while making permitted collection prominent", () => {
    const current = view();
    current.allowedActions[0] = { code: "CHECK_IN", enabled: false, disabledReason: "ARRIVAL_DATE_NOT_REACHED" };
    const actions = roomStatusQuickOrderActions(current).primary;
    expect(actions[0]).toMatchObject({ code: "CHECK_IN", enabled: false, disabledReason: "尚未到计划入住日。" });
    expect(actions.find((item) => item.primary)?.code).toBe("RECORD_COLLECTION");
  });

  it("reduces the prominence of collection at zero difference without prohibiting further authorized collection", () => {
    const current = view();
    current.amounts.netRecordedCollection = money(30000);
    current.amounts.collectionDifference = money(0);
    const actions = roomStatusQuickOrderActions(current);
    expect(actions.primary.map((item) => item.code)).toEqual(["CHECK_IN", "VIEW_FUNDS", "RESCHEDULE_STAY", "MOVE_UNIT"]);
    expect(actions.more.find((item) => item.code === "RECORD_COLLECTION")?.enabled).toBe(true);
    expect(roomStatusQuickOrderFundsFacts(current).map((item) => item.label)).toEqual(["住宿金额", "已记录净收款", "差额"]);
  });

  it("routes early checkout through authorized shortening and normal checkout only through CHECK_OUT", () => {
    const current = view("CHECKED_IN");
    current.allowedActions[0] = { code: "CHECK_OUT", enabled: false, disabledReason: "DEPARTURE_DATE_NOT_REACHED" };
    expect(roomStatusQuickOrderActions(current).primary[0]?.code).toBe("EARLY_CHECK_OUT");
    current.allowedActions[1] = { code: "SHORTEN_STAY", enabled: false, disabledReason: "入住当天不可提前退房" };
    expect(roomStatusQuickOrderActions(current).primary[0]).toMatchObject({ code: "EARLY_CHECK_OUT", enabled: false });
    current.effectiveArrangement.businessDate = "2026-09-23";
    current.allowedActions[0] = { code: "CHECK_OUT", enabled: true, disabledReason: null };
    expect(roomStatusQuickOrderActions(current).primary[0]).toMatchObject({ code: "CHECK_OUT", enabled: true });
  });

  it("blocks all writes during a refresh, a recovery gate, or read-only access, retaining read actions", () => {
    for (const state of ["refresh", "recovery", "read"] as const) {
      const current = view();
      if (state === "read") current.accessLevel = "READ";
      const actions = roomStatusQuickOrderActions(current, state === "recovery" ? { reason: "先查询原操作结果" } : undefined, state === "refresh");
      for (const item of [...actions.primary, ...actions.more]) expect(item.enabled).toBe(item.code === "VIEW_FUNDS");
    }
  });
});

describe("room-status membership and funds presentation", () => {
  it("does not manufacture a cash collection summary for free or external-channel stays", () => {
    for (const kind of ["FREE", "CTRIP"] as const) {
      const current = view();
      if (kind === "FREE") current.order.stay_type = "FREE";
      else current.order.booking_channel_code = kind;
      expect(roomStatusQuickOrderFundsFacts(current)).toEqual([]);
      expect([...roomStatusQuickOrderActions(current).primary, ...roomStatusQuickOrderActions(current).more].some((item) => item.code === "RECORD_COLLECTION" || item.code === "RECORD_REFUND")).toBe(false);
    }
  });

  it("shows external-channel contractual amounts without implying a per-order payment or settlement", () => {
    const current = view();
    current.order.booking_channel_code = "CTRIP";
    current.order.channel_order_reference = "CTRIP-2026-0920";
    expect(roomStatusQuickOrderChannelFacts(current)).toEqual([
      { label: "渠道订单号", value: "CTRIP-2026-0920" },
      { label: "本单渠道应结金额", value: "¥300.00" }
    ]);
    const html = renderToStaticMarkup(createElement(RoomStatusQuickOrderContent, { view: current, option, onAction: () => undefined }));
    expect(html).toContain("本单渠道应结金额");
    expect(html).not.toMatch(/已记录净收款|差额|已到账|已结清/);
  });

  it("uses membership as the second action for covered stays and distinguishes a cash remainder", () => {
    const current = memberStay();
    expect(roomStatusQuickOrderActions(current).primary[1]?.code).toBe("VIEW_MEMBERSHIP");
    expect(roomStatusQuickOrderFundsFacts(current)).toEqual([]);
    current.amounts.currentContractAmount = money(10000);
    current.amounts.collectionDifference = money(10000);
    const actions = roomStatusQuickOrderActions(current);
    expect(actions.primary[1]?.code).toBe("RECORD_COLLECTION");
    expect(actions.more.some((item) => item.code === "VIEW_MEMBERSHIP")).toBe(true);
    expect(roomStatusQuickOrderFundsFacts(current)[0]).toMatchObject({ label: "现金部分金额" });
  });

  it("reports the product and lot used by this stay, without mixing another product or member-wide balance", () => {
    const current = memberStay();
    const facts = roomStatusQuickOrderMembershipFacts(current, memberView());
    expect(facts).toContainEqual({ label: "使用产品", value: "独卫单人间会员" });
    expect(facts).toContainEqual({ label: "本次已核销", value: "3 间夜" });
    expect(facts).toContainEqual({ label: "本次产品可用", value: "27 间夜" });
    expect(JSON.stringify(facts)).not.toMatch(/888|999/);
    const stale = memberView();
    stale.balanceAsOfDate = "2026-09-19";
    expect(roomStatusQuickOrderMembershipFacts(current, stale).some((item) => item.label.includes("可用"))).toBe(false);
    stale.member.id = "other_member";
    expect(roomStatusQuickOrderMembershipFacts(current, stale)).toEqual([{ label: "本次已核销", value: "3 间夜" }]);
  });

  it("treats a member identity without actual coverage as a profile, not as entitlement use or a cash remainder", () => {
    const current = view();
    current.order.member_id = "member_1";
    current.order.member_contract_id = null;
    expect(roomStatusQuickOrderMembershipFacts(current, memberView())).toEqual([]);
    expect(roomStatusQuickOrderFundsFacts(current)[0]?.label).toBe("住宿金额");
    const actions = roomStatusQuickOrderActions(current);
    expect(actions.primary.some((item) => item.code === "VIEW_MEMBERSHIP")).toBe(false);
    expect(actions.more.find((item) => item.code === "VIEW_MEMBERSHIP")).toMatchObject({ label: "查看会员档案", enabled: true });
    const html = renderToStaticMarkup(createElement(RoomStatusQuickOrderContent, { view: current, memberView: memberView(), option: { ...option, source: { ...option.source, sourceCategory: "MEMBER" } }, onAction: () => undefined }));
    expect(html).toContain("会员住客");
    expect(html).not.toContain("会员权益");
    expect(html).not.toContain("现金部分金额");
    expect(html).not.toContain("本次已核销");
    expect(html).not.toContain("使用产品");
  });

  it("preserves actual coverage from multiple contracts without inventing a single contract or combined balance", () => {
    const current = memberStay();
    current.order.member_contract_id = null;
    current.coverageSet[2]!.contract_id = "contract_second";
    current.coverageSet[2]!.lot_id = "lot_second";
    const member = memberView();
    member.contracts.push({ ...member.contracts[0]!, id: "contract_second" });
    member.lots.push({ ...member.lots[0]!, id: "lot_second", contract_id: "contract_second" });
    member.lotBalances.push({ lotId: "lot_second", unitKind: "ROOM_NIGHT", availableUnits: 12 });
    member.membershipOrders.push({ ...member.membershipOrders[0]!, order: { ...member.membershipOrders[0]!.order,
      id: "membership_order_second", product_name: "独卫单人间续期会员", contract_id: "contract_second", entitlement_lot_id: "lot_second" } });
    const facts = roomStatusQuickOrderMembershipFacts(current, member);
    expect(facts).toContainEqual({ label: "本次已核销", value: "3 间夜" });
    expect(facts).toContainEqual({ label: "使用产品", value: "独卫单人间会员、独卫单人间续期会员" });
    expect(facts).toContainEqual({ label: "独卫单人间会员可用", value: "27 间夜" });
    expect(facts).toContainEqual({ label: "独卫单人间续期会员可用", value: "12 间夜" });
    expect(JSON.stringify(facts)).not.toContain("39 间夜");
  });

  it("leaves authorized reversal in more and keeps it gated until the original funds fact is chosen in details", () => {
    const current = view();
    current.allowedActions.push({ code: "REVERSE_FACT", enabled: true, disabledReason: null });
    expect(roomStatusQuickOrderActions(current).more.find((item) => item.code === "REVERSE_FACT")).toMatchObject({ label: "登记冲销", enabled: true });
    expect(roomStatusQuickOrderActions(current, { reason: "先查询原操作结果" }).more.find((item) => item.code === "REVERSE_FACT")?.enabled).toBe(false);
    expect(roomStatusQuickOrderActions(current).primary).toHaveLength(4);
  });

  it("uses recorded coverage status after shortening instead of promising a common return rule", () => {
    const current = memberStay();
    current.coverageSet[2]!.status = "RELEASED";
    expect(roomStatusQuickOrderMembershipFacts(current)).toEqual([{ label: "本次已核销", value: "2 间夜" }]);
    current.coverageSet[0]!.status = "HELD";
    expect(roomStatusQuickOrderMembershipFacts(current)).toEqual([{ label: "本次已核销", value: "1 间夜" }, { label: "本次已冻结", value: "1 间夜" }]);
  });

  it("keeps upgraded and cross-room stays on their supplied action list and does not collect original-stay funds again", () => {
    const current = memberStay();
    current.membershipConversion = { membershipOrderId: "membership_order_used", memberId: "member_1", contractId: "contract_used", entitlementLotId: "lot_used", commandId: "upgrade_1" };
    current.amendments = [{ id: "upgrade_1", order_id: "order_1", sequence: 2, amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      reason_code: "UPGRADE", reason_note: "临时安排", prior_version: 1, new_version: 2,
      payload: { crossRoomUpgrade: { kind: "TEMPORARY_OTHER_ROOM_UPGRADE" } }, command_id: "upgrade_1", actor: null, created_at: `${day}T00:00:00Z` }];
    current.allowedActions = current.allowedActions.filter((item) => item.code !== "EXTEND_STAY" && item.code !== "MOVE_UNIT");
    current.allowedActions.find((item) => item.code === "CHECK_OUT")!.enabled = false;
    const actions = roomStatusQuickOrderActions(current);
    expect(actions.primary.map((item) => item.code)).toEqual(["EARLY_CHECK_OUT", "VIEW_MEMBERSHIP", "ADJUST_DEPARTURE"]);
    expect([...actions.primary, ...actions.more].some((item) => item.code === "RECORD_COLLECTION" || item.code === "RECORD_REFUND")).toBe(false);
    expect(roomStatusQuickOrderNotices(current)).toEqual([
      "本次临时安排其他整房；增加日期或再次换房需另建符合现场安排的订单。",
      "已升级会员；后续会员收款在会员订单办理，原住宿不再追加收退款。"
    ]);
  });

  it("renders compact funds and accessible disabled reasons without details or secondary menus", () => {
    const current = view();
    current.allowedActions[0] = { code: "CHECK_IN", enabled: false, disabledReason: "ARRIVAL_DATE_NOT_REACHED" };
    const html = renderToStaticMarkup(createElement(RoomStatusQuickOrderContent, { view: current, option, onAction: () => undefined }));
    expect(html).toContain("住宿金额");
    expect(html).toContain("已记录净收款");
    expect(html).toContain("尚未到计划入住日");
    expect(html).toMatch(/disabled=""[^>]*data-room-status-quick-action="CHECK_IN"[^>]*aria-describedby=/);
    expect(html).not.toContain("查看订单详情");
    expect(html).not.toContain("<summary>");
    expect(html).not.toMatch(/已支付|已到账|已结清/);
  });
});
