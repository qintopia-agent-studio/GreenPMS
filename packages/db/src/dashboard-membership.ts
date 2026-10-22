import type { Selectable, Transaction } from "kysely";
import type { CommunityMembershipEvidence } from "../../domain/src/community-metrics.ts";
import type { Database } from "./schema.ts";
import { loadDashboardConversionBindings, type DashboardConversionBinding } from "./dashboard-conversion-identity.ts";

type Member = Pick<Selectable<Database["members"]>, "id" | "identity_card_number"> & Partial<Pick<Selectable<Database["members"]>, "full_name" | "nickname" | "phone">>;
type Contract = Pick<Selectable<Database["member_contracts"]>, "id" | "member_id" | "status" | "valid_from" | "valid_until" | "membership_order_id">;
type Lot = Pick<Selectable<Database["entitlement_lots"]>, "id" | "contract_id" | "status" | "expires_on">;
type MembershipOrder = Pick<Selectable<Database["membership_orders"]>, "id" | "member_id" | "status" | "contract_id" | "entitlement_lot_id"> & Partial<Pick<Selectable<Database["membership_orders"]>, "created_by_command_id" | "activated_by_command_id">>;
export interface DashboardMembershipData {
  members: readonly Member[];
  contracts: readonly Contract[];
  lots: readonly Lot[];
  membershipOrders: readonly MembershipOrder[];
  conversionBindings?: ReadonlyMap<string, DashboardConversionBinding>;
}
type Guest = { documentNumber: string | null; id?: string; role?: string };
type Booking = { id?: string; member_id?: string | null; member_contract_id?: string | null };
const document = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const displayName = (member: Member | undefined) => {
  const nickname = member?.nickname?.trim(), name = member?.full_name?.trim();
  return nickname && name && nickname !== name ? `${nickname}（${name}）` : nickname || name;
};

/** This projection never matches names or shared phones, or writes a guest/member link. */
export function dashboardMembershipProjection(data: DashboardMembershipData, dates: readonly string[], today: string) {
  const members = new Map(data.members.map(member => [member.id, member]));
  const byDocument = new Map<string, Member[]>();
  for (const member of data.members) {
    const key = document(member.identity_card_number);
    if (key) byDocument.set(key, [...(byDocument.get(key) ?? []), member]);
  }
  const contractsByMember = new Map<string, Contract[]>();
  const contractsById = new Map(data.contracts.map(contract => [contract.id, contract]));
  for (const contract of data.contracts) if (contract.member_id) {
    contractsByMember.set(contract.member_id, [...(contractsByMember.get(contract.member_id) ?? []), contract]);
  }
  const lotsByContract = new Map<string, Lot[]>();
  for (const lot of data.lots) lotsByContract.set(lot.contract_id, [...(lotsByContract.get(lot.contract_id) ?? []), lot]);
  const membershipOrders = new Map(data.membershipOrders.map(order => [order.id, order]));
  const validityCache = new Map<string, CommunityMembershipEvidence>();
  const notMember = (memberId: string | null): CommunityMembershipEvidence => ({ status: "NOT_MEMBER", memberId });
  const unknown = (memberId: string | null, reason: string): CommunityMembershipEvidence => ({ status: "UNKNOWN", memberId, reason });
  function validity(memberId: string, date: string): CommunityMembershipEvidence {
    const cacheKey = `${memberId}:${date}`;
    const cached = validityCache.get(cacheKey);
    if (cached) return cached;
    let result = notMember(memberId);
    for (const contract of contractsByMember.get(memberId) ?? []) {
      if (date < contract.valid_from || date > contract.valid_until) continue;
      const lots = lotsByContract.get(contract.id) ?? [];
      const order = contract.membership_order_id ? membershipOrders.get(contract.membership_order_id) : undefined;
      const voided = contract.status === "VOIDED" || order?.status === "VOIDED";
      if (voided) {
        if (date < today) result = unknown(memberId, "会员已作废，但缺少可明确适用于统计日的作废依据，历史会员资格待核对。");
        continue;
      }
      if (contract.membership_order_id && (!order || order.member_id !== memberId || order.contract_id !== contract.id)) {
        result = unknown(memberId, "会员合同与售卡记录的关联不完整，会员有效性待核对。");
        continue;
      }
      if (order?.status === "DRAFT") continue;
      if (!lots.length) {
        result = unknown(memberId, "会员合同缺少权益有效期依据，会员有效性待核对。");
        continue;
      }
      if (order && !lots.some(lot => lot.id === order.entitlement_lot_id)) {
        result = unknown(memberId, "会员售卡记录与权益批次的关联不完整，会员有效性待核对。");
        continue;
      }
      for (const lot of lots) {
        if (order && lot.id !== order.entitlement_lot_id) continue;
        if (date > lot.expires_on) continue;
        if (lot.status === "VOIDED") {
          if (date < today) result = unknown(memberId, "会员权益已作废，但缺少可明确适用于统计日的作废依据，历史会员资格待核对。");
          continue;
        }
        // EXPIRED today must not erase membership on its earlier valid dates.
        if (date === today && contract.status === "EXPIRED") continue;
        result = { status: "CONFIRMED", memberId };
        validityCache.set(cacheKey, result);
        return result;
      }
    }
    validityCache.set(cacheKey, result);
    return result;
  }
  return (guest: Guest | null, booking: Booking): Readonly<Record<string, CommunityMembershipEvidence>> => {
    const key = document(guest?.documentNumber);
    const matches = key ? byDocument.get(key) ?? [] : [];
    const linkedContract = booking.member_contract_id ? contractsById.get(booking.member_contract_id) : undefined;
    const linkedId = booking.member_id ?? linkedContract?.member_id ?? null;
    const candidate = guest?.id && guest.role === "PRIMARY" ? data.conversionBindings?.get(guest.id) : undefined;
    const binding = candidate && candidate.orderId === booking.id && candidate.memberId === linkedId ? candidate : undefined;
    return Object.fromEntries(dates.map(date => {
      let evidence: CommunityMembershipEvidence;
      if (binding && (binding.reasonLabel === "住客与会员证件不一致" || (binding.verified && ((matches.length === 1 && matches[0]!.id !== binding.memberId)
        || (key && document(members.get(binding.memberId)?.identity_card_number) && key !== document(members.get(binding.memberId)?.identity_card_number)))))) {
        evidence = { ...unknown(binding.memberId, "住客证件与升级事件关联的会员冲突，不能以升级关系覆盖证件身份。"), reasonLabel: "住客与会员证件不一致" };
      } else if (matches.length === 1) {
        // An ordinary lodging booking can contain a member, regardless of payer.
        evidence = { ...validity(matches[0]!.id, date), identityBasis: "DOCUMENT" };
      } else if (matches.length > 1) {
        evidence = { ...unknown(null, "同一证件对应多份会员档案，实际会员身份待核对。"), reasonLabel: "证件对应多份会员档案" };
      } else if (binding?.verified) {
        evidence = { ...validity(binding.memberId, date), identityBasis: "STAY_CONVERSION" };
      } else if (binding) {
        // 升级后更正留下的是身份冲突，不能降成普通权益订单的确定非会员。
        // 前面的唯一证件匹配仍可独立证明实际住客自己的会员身份。
        evidence = { ...unknown(binding.memberId, binding.reason ?? "原住宿升级身份依据尚未核实。"),
          reasonLabel: binding.reasonLabel ?? "升级身份依据待核对" };
      } else if (linkedId || booking.member_contract_id) {
        const linkedMember = linkedId ? members.get(linkedId) : undefined;
        const linkedValidity = linkedId && linkedMember ? validity(linkedId, date) : null;
        if (linkedValidity?.status === "NOT_MEMBER") evidence = linkedValidity;
        else if (key && linkedMember && document(linkedMember.identity_card_number)) {
          // A different verified document disproves this payer/guest identity.
          evidence = notMember(null);
        } else {
          evidence = { ...unknown(linkedId, linkedValidity?.status === "UNKNOWN" ? linkedValidity.reason!
            : !guest ? "订单缺少实际住宿人，无法核对订单会员主体是否在住。"
              : !linkedMember ? "订单关联的会员资料缺失，实际住客会员身份待核对。"
                : "尚未记录该住客与会员的本人入住关系；缺少唯一证件或已确认升级事件依据，不能用订单会员主体、同名或手机号代替身份核对。"),
            reasonLabel: linkedValidity?.status === "UNKNOWN" ? "会员有效性待核对" : !guest ? "缺少实际住客登记" : !linkedMember ? "会员资料缺失" : "未记录本人入住关系" };
        }
      } else evidence = notMember(null);
      const memberName = displayName(evidence.memberId ? members.get(evidence.memberId) : undefined);
      if (memberName) evidence = { ...evidence, memberName };
      return [date, evidence];
    }));
  };
}

export async function loadDashboardMembership(trx: Transaction<Database>, propertyId: string, dates: readonly string[], today: string) {
  // Member corrections update the canonical members row; guest corrections are
  // applied by projectCurrentOrderOccupants before this projection is called.
  const members = await trx.selectFrom("members as m")
    .innerJoin("member_property_links as mpl", "mpl.member_id", "m.id")
    .select(["m.id", "m.identity_card_number", "m.full_name", "m.nickname", "m.phone"])
    .where("mpl.property_id", "=", propertyId).where("m.deleted_at", "is", null).execute();
  const ids = members.map(member => member.id);
  const [contracts, membershipOrders] = ids.length ? await Promise.all([
    trx.selectFrom("member_contracts").selectAll().where("property_id", "=", propertyId).where("member_id", "in", ids).execute(),
    trx.selectFrom("membership_orders").selectAll().where("property_id", "=", propertyId).where("member_id", "in", ids).execute()
  ]) : [[], []];
  const lots = contracts.length ? await trx.selectFrom("entitlement_lots").selectAll().where("contract_id", "in", contracts.map(contract => contract.id)).execute() : [];
  const base = { members, contracts, lots, membershipOrders };
  const conversionBindings = await loadDashboardConversionBindings(trx, propertyId, base);
  return dashboardMembershipProjection({ ...base, conversionBindings }, dates, today);
}
