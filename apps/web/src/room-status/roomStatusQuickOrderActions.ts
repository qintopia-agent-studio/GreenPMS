import type { OrderActionCode } from "@qintopia/contracts";
import { stayDateChangeActionState } from "../components/StayDateChangeDrawer";
import { stayMembershipUpgradeActionVisible } from "../stayMembershipUpgrade";
import type { MemberViewDto, OrderViewDto } from "../types";
import { formatDate, formatMoney, stayDateFundsAreOperatorFacing, temporaryOtherRoomArrangementPresentation } from "../ui";
import type { RoomStatusOrderOption, RoomStatusOrderOptionsResult } from "./roomStatusState";

export type RoomStatusQuickOrderAction = OrderActionCode
  | "VIEW_FUNDS" | "VIEW_MEMBERSHIP" | "ADJUST_DEPARTURE" | "EARLY_CHECK_OUT";

export interface RoomStatusQuickOrderActionItem {
  code: RoomStatusQuickOrderAction;
  label: string;
  enabled: boolean;
  primary?: boolean;
  disabledReason?: string;
}

export interface RoomStatusQuickOrderFact { label: string; value: string }

const labels: Record<OrderActionCode, string> = {
  CHECK_IN: "办理入住", CHECK_OUT: "办理退房", REVOKE_CHECK_OUT: "撤销退房",
  COMPLETE_STAY: "完成住宿", RESCHEDULE_STAY: "调整住宿日期", SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "延长住宿", MOVE_UNIT: "换房", CANCEL_ORDER: "取消预订",
  MARK_NO_SHOW: "标记未到", REVOKE_CHECK_IN: "撤销入住", RECORD_COLLECTION: "登记收款",
  RECORD_REFUND: "登记退款", REVERSE_FACT: "登记冲销", REPRICE_ORDER: "调整订单金额",
  MANAGE_ORDER_OCCUPANTS: "管理同住人", CORRECT_ORDER_OCCUPANT: "更正住宿人资料",
  CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP: "升级会员"
};

export function roomStatusMatchingQuickOrder(
  view: OrderViewDto | undefined,
  options: RoomStatusOrderOptionsResult
): RoomStatusOrderOption | undefined {
  if (!view || options.kind !== "READY") return undefined;
  const matches = options.orders.filter((option) => option.identity.orderId === view.order.id
    && option.identity.stayId === view.stay.id);
  return matches.length === 1 ? matches[0] : undefined;
}

export function roomStatusQuickOrderMemberId(view: OrderViewDto): string | undefined {
  if (view.membershipConversion) return view.membershipConversion.memberId;
  return view.order.member_id && membershipCoverage(view).length ? view.order.member_id : undefined;
}

function membershipCoverage(view: OrderViewDto) {
  const contractId = view.membershipConversion?.contractId ?? view.order.member_contract_id;
  return view.coverageSet.filter((item) => item.order_id === view.order.id
    && (item.status === "CONSUMED" || item.status === "HELD")
    && (!contractId || item.contract_id === contractId)
    && (!view.membershipConversion || item.lot_id === view.membershipConversion.entitlementLotId));
}

export function roomStatusQuickOrderFundsVisible(view: OrderViewDto): boolean {
  const revision = view.pricingRevisions.find((candidate) => candidate.id === view.order.current_revision_id);
  if (view.order.stay_type === "FREE"
    || !stayDateFundsAreOperatorFacing(view.order.booking_channel_code, revision?.pricing_basis)
    || view.membershipConversion) return false;
  return !roomStatusQuickOrderMemberId(view)
    || view.amounts.currentContractAmount.minorUnits !== 0
    || view.amounts.netRecordedCollection.minorUnits !== 0
    || view.collectionFacts.length > 0;
}

function actionDisabledReason(reason: string | null): string {
  if (reason?.includes("入住当天暂不办理缩短或提前退房")) return "入住当天暂不办理缩短或提前退房。";
  const descriptions: Record<string, string> = {
    ARRIVAL_DATE_NOT_REACHED: "尚未到计划入住日。",
    ARRIVAL_DATE_PASSED: "已超过计划入住日，请先核对住宿日期。",
    DEPARTURE_DATE_NOT_REACHED: "尚未到计划退房日。",
    ORDER_STATE_NOT_ALLOWED: "当前订单状态不可办理。",
    NO_REFUNDABLE_COLLECTION: "当前没有可退款的原收款。",
    NO_TRANSFERABLE_COLLECTION: "当前住宿收款不符合升级会员条件，请先核对资金记录。",
    STAY_MEMBERSHIP_UPGRADE_REPRICE_CLOSED: "升级会员后，原住宿金额不可再调整。",
    STAY_MEMBERSHIP_UPGRADE_REVOKE_CHECK_IN_CLOSED: "升级会员后，原住宿不可撤销入住。"
  };
  return reason ? descriptions[reason] ?? reason : "当前操作不可用。";
}

export function roomStatusQuickOrderActions(
  view: OrderViewDto,
  writeBlock?: { reason: string },
  loading = false
): { primary: RoomStatusQuickOrderActionItem[]; more: RoomStatusQuickOrderActionItem[] } {
  const blockedReason = writeBlock?.reason ?? (loading ? "正在更新订单，请稍候。"
    : view.accessLevel !== "WRITE" ? "当前账号只有查看权限。" : undefined);
  const action = (code: OrderActionCode): RoomStatusQuickOrderActionItem | undefined => {
    const authoritative = view.allowedActions.find((candidate) => candidate.code === code);
    if (!authoritative || authoritative.disabledReason === "ORDER_STATE_NOT_ALLOWED") return undefined;
    const dateState = code === "RESCHEDULE_STAY" || code === "SHORTEN_STAY" || code === "EXTEND_STAY"
      ? stayDateChangeActionState(view, code) : undefined;
    if ((code === "RESCHEDULE_STAY" || code === "SHORTEN_STAY" || code === "EXTEND_STAY") && !dateState) return undefined;
    const enabled = authoritative.enabled && !blockedReason && (dateState?.enabled ?? true);
    return {
      code, label: labels[code], enabled,
      ...(!enabled ? { disabledReason: blockedReason ?? actionDisabledReason(dateState?.reason ?? authoritative.disabledReason) } : {})
    };
  };
  const primary: RoomStatusQuickOrderActionItem[] = [];
  const more: RoomStatusQuickOrderActionItem[] = [];
  const member = Boolean(roomStatusQuickOrderMemberId(view));
  const fundsVisible = roomStatusQuickOrderFundsVisible(view);
  const collection = fundsVisible ? action("RECORD_COLLECTION") : undefined;
  const funds: RoomStatusQuickOrderActionItem = { code: "VIEW_FUNDS", label: "查看账务", enabled: true };
  const membership: RoomStatusQuickOrderActionItem = { code: "VIEW_MEMBERSHIP", label: member ? "查看会员权益" : "查看会员档案", enabled: true };
  const add = (item: RoomStatusQuickOrderActionItem | undefined) => { if (item) primary.push(item); };

  if (view.order.status === "RESERVED") add(action("CHECK_IN"));
  if (view.order.status === "CHECKED_IN") {
    const checkout = action("CHECK_OUT");
    const early = action("SHORTEN_STAY");
    const departureReached = view.effectiveArrangement.businessDate >= view.effectiveArrangement.departureDate;
    if (departureReached || checkout?.enabled) add(checkout);
    else if (early) add({ ...early, code: "EARLY_CHECK_OUT", label: "提前退房" });
    else add(checkout);
  }
  // This changes the prominence of existing actions, never payment state or authorization.
  if (fundsVisible) add(collection && view.amounts.collectionDifference.minorUnits > 0 ? collection : funds);
  else if (member) add(membership);

  if (view.order.status === "RESERVED") add(action("RESCHEDULE_STAY"));
  if (view.order.status === "CHECKED_IN") {
    const extension = action("EXTEND_STAY");
    const shortening = action("SHORTEN_STAY");
    const departure = extension?.enabled ? extension : shortening?.enabled ? shortening : extension ?? shortening;
    if (departure) add({ ...departure, code: "ADJUST_DEPARTURE", label: "调整退房日期" });
  }
  if (view.order.status === "RESERVED" || view.order.status === "CHECKED_IN") add(action("MOVE_UNIT"));
  const primaryWriteAction = primary.find((item) => item.enabled && item.code !== "VIEW_FUNDS" && item.code !== "VIEW_MEMBERSHIP");
  if (primaryWriteAction) primaryWriteAction.primary = true;

  if ((member || view.order.member_id) && !primary.some((item) => item.code === "VIEW_MEMBERSHIP")) more.push(membership);
  if (fundsVisible && !primary.some((item) => item.code === "VIEW_FUNDS")) more.push(funds);
  for (const code of ["RECORD_COLLECTION", "RECORD_REFUND", "REVERSE_FACT", "CANCEL_ORDER", "MARK_NO_SHOW", "COMPLETE_STAY",
    "MANAGE_ORDER_OCCUPANTS", "CORRECT_ORDER_OCCUPANT", "REPRICE_ORDER", "REVOKE_CHECK_IN", "REVOKE_CHECK_OUT",
    "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"] as const) {
    if (primary.some((item) => item.code === code)) continue;
    if ((code === "RECORD_COLLECTION" || code === "RECORD_REFUND" || code === "REVERSE_FACT" || code === "REPRICE_ORDER") && !fundsVisible) continue;
    const item = action(code);
    if (!item) continue;
    if (code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
      && !stayMembershipUpgradeActionVisible(view, view.allowedActions.find((candidate) => candidate.code === code))) continue;
    more.push(item);
  }
  return { primary: primary.slice(0, 4), more };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function roomStatusQuickOrderNotices(view: OrderViewDto): string[] {
  const crossRoom = view.amendments.some((amendment) => amendment.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    && record(record(amendment.payload)?.crossRoomUpgrade)?.kind === "TEMPORARY_OTHER_ROOM_UPGRADE");
  const temporaryRoom = view.amendments.some((amendment) => amendment.amendment_type === "CREATE_ORDER"
    && amendment.reason_code === "TEMPORARY_OTHER_ROOM"
    && temporaryOtherRoomArrangementPresentation(record(amendment.payload)?.temporaryOtherRoomArrangement));
  const notices: string[] = [];
  if (crossRoom || temporaryRoom) notices.push("本次临时安排其他整房；增加日期或再次换房需另建符合现场安排的订单。");
  if (view.membershipConversion) notices.push("已升级会员；后续会员收款在会员订单办理，原住宿不再追加收退款。");
  return notices;
}

export function roomStatusQuickOrderFundsFacts(view: OrderViewDto): RoomStatusQuickOrderFact[] {
  if (!roomStatusQuickOrderFundsVisible(view)) return [];
  const member = Boolean(roomStatusQuickOrderMemberId(view));
  return [
    { label: member ? "现金部分金额" : "住宿金额", value: formatMoney(view.amounts.currentContractAmount) },
    { label: "已记录净收款", value: formatMoney(view.amounts.netRecordedCollection) },
    { label: "差额", value: formatMoney(view.amounts.collectionDifference) },
    ...(view.amounts.refundReferenceAmount.minorUnits > 0
      ? [{ label: "退款参考", value: formatMoney(view.amounts.refundReferenceAmount) }] : [])
  ];
}

export function roomStatusQuickOrderChannelFacts(view: OrderViewDto): RoomStatusQuickOrderFact[] {
  if (!view.order.booking_channel_code || !["YOUMUDAO", "CTRIP", "MEITUAN"].includes(view.order.booking_channel_code)
    || view.order.stay_type === "FREE" || roomStatusQuickOrderMemberId(view)) return [];
  return [
    ...(view.order.channel_order_reference ? [{ label: "渠道订单号", value: view.order.channel_order_reference }] : []),
    { label: "本单渠道应结金额", value: formatMoney(view.amounts.currentContractAmount) }
  ];
}

export function roomStatusQuickOrderMembershipFacts(view: OrderViewDto, memberView?: MemberViewDto): RoomStatusQuickOrderFact[] {
  const memberId = roomStatusQuickOrderMemberId(view);
  if (!memberId) return [];
  const coverage = membershipCoverage(view);
  const facts: RoomStatusQuickOrderFact[] = [];
  for (const status of ["CONSUMED", "HELD"] as const) {
    const matching = coverage.filter((item) => item.status === status);
    const quantities = (["ROOM_NIGHT", "BED_NIGHT"] as const).map((kind) => {
      const count = matching.filter((item) => item.unit_kind === kind).length;
      return count ? `${count} ${kind === "ROOM_NIGHT" ? "间夜" : "床夜"}` : null;
    }).filter(Boolean);
    if (quantities.length) facts.push({ label: status === "CONSUMED" ? "本次已核销" : "本次已冻结", value: quantities.join(" · ") });
  }
  if (!memberView || memberView.member.id !== memberId) return facts;
  const contractIds = new Set(coverage.map((item) => item.contract_id));
  if (view.membershipConversion) contractIds.add(view.membershipConversion.contractId);
  const matchingContracts = memberView.contracts.filter((item) => contractIds.has(item.id)
    && item.property_id === view.order.property_id && item.member_id === memberId);
  const matchingContractIds = new Set(matchingContracts.map((item) => item.id));
  const lotIds = new Set(coverage.map((item) => item.lot_id));
  if (view.membershipConversion) lotIds.add(view.membershipConversion.entitlementLotId);
  const orders = memberView.membershipOrders.filter(({ order }) => order.contract_id && matchingContractIds.has(order.contract_id)
    && order.member_id === memberId && order.property_id === view.order.property_id
    && order.entitlement_lot_id && lotIds.has(order.entitlement_lot_id));
  if (orders.length) facts.unshift({ label: "使用产品", value: [...new Set(orders.map(({ order }) => order.product_name))].join("、") });
  for (const lotId of lotIds) {
    const lot = memberView.lots.find((item) => item.id === lotId && matchingContractIds.has(item.contract_id));
    const balance = memberView.lotBalances.find((item) => item.lotId === lotId && item.unitKind === lot?.unit_kind);
    const product = orders.find(({ order }) => order.entitlement_lot_id === lotId)?.order.product_name;
    if (lot && balance && memberView.balanceAsOfDate === view.effectiveArrangement.businessDate) {
      facts.push({ label: lotIds.size > 1 ? `${product ?? "本次权益"}可用` : "本次产品可用", value: `${balance.availableUnits} ${balance.unitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}` });
    }
    if (lot) facts.push({ label: lotIds.size > 1 ? `${product ?? "本次权益"}有效至` : "权益有效至", value: formatDate(lot.expires_on) });
  }
  return facts;
}
