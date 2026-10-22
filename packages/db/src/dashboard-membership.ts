import type { Transaction } from "kysely";
import type { CommunityMembershipEvidence } from "../../domain/src/community-metrics.ts";
import type { Database } from "./schema.ts";
import { dashboardMemberUsage, usageKey, type DashboardMemberUsageData } from "./dashboard-member-usage.ts";

export type DashboardMembershipData = DashboardMemberUsageData;
type Guest = { id?: string; role?: string; documentNumber?: string | null };
type Booking = { id?: string; member_id?: string | null; member_contract_id?: string | null };
const displayName = (member: DashboardMembershipData["members"][number] | undefined) => {
  const nickname = member?.nickname?.trim(), name = member?.full_name?.trim();
  return nickname && name && nickname !== name ? `${nickname}（${name}）` : nickname || name;
};

/** 每笔实际使用权益的住宿由PRIMARY承接一个统计份额，不识别会员本人。 */
export function dashboardMembershipProjection(data: DashboardMembershipData, dates: readonly string[], _today: string) {
  const usage = dashboardMemberUsage(data);
  const members = new Map(data.members.map(member => [member.id, member]));
  return (guest: Guest | null, booking: Booking): Readonly<Record<string, CommunityMembershipEvidence>> => Object.fromEntries(dates.map(date => {
    let evidence: CommunityMembershipEvidence = { status: "NOT_MEMBER", memberId: null };
    const source = booking.id ? usage.get(usageKey(booking.id, date)) : undefined;
    if (source && guest?.role !== "ADDITIONAL") {
      evidence = guest?.id && guest.role === "PRIMARY" ? source : { status: "UNKNOWN", memberId: source.memberId,
        reasonLabel: "缺少唯一主要住客", reason: "当天有会员权益使用，但缺少可承接这一统计份额的唯一主要住客登记。" };
      const memberName = displayName(evidence.memberId ? members.get(evidence.memberId) : undefined) ?? source.memberName;
      if (memberName) evidence = { ...evidence, memberName };
    }
    return [date, evidence];
  }));
}

export async function loadDashboardMembership(trx: Transaction<Database>, propertyId: string, dates: readonly string[], today: string) {
  const members = await trx.selectFrom("members as m").innerJoin("member_property_links as mpl", "mpl.member_id", "m.id")
    .select(["m.id", "m.full_name", "m.nickname"]).where("mpl.property_id", "=", propertyId).where("m.deleted_at", "is", null).execute();
  const [contracts, membershipOrders, orders] = await Promise.all([
    trx.selectFrom("member_contracts").selectAll().where("property_id", "=", propertyId).execute(),
    trx.selectFrom("membership_orders").selectAll().where("property_id", "=", propertyId).execute(),
    trx.selectFrom("orders").select(["id", "member_id", "member_contract_id"]).where("property_id", "=", propertyId).execute()
  ]);
  const lots = contracts.length ? await trx.selectFrom("entitlement_lots").selectAll().where("contract_id", "in", contracts.map(contract => contract.id)).execute() : [];
  const uniqueDates = [...new Set(dates)];
  const [coverage, ledger] = uniqueDates.length ? await Promise.all([
    trx.selectFrom("coverage_items as c").innerJoin("orders as o", "o.id", "c.order_id")
      .selectAll("c").where("o.property_id", "=", propertyId).where("c.service_date", "in", uniqueDates).execute(),
    trx.selectFrom("entitlement_ledger as l").innerJoin("orders as o", "o.id", "l.order_id")
      .leftJoin("command_executions as e", join => join.onRef("e.id", "=", "l.command_id").on("e.property_id", "=", propertyId))
      .selectAll("l").select(["e.command_type", "e.state as command_state"])
      .where("o.property_id", "=", propertyId).where("l.service_date", "in", uniqueDates)
      .where("l.entry_type", "in", ["HOLD", "CONSUME", "CONVERSION_CONSUME", "RESTORE"]).execute()
  ]) : [[], []];
  return dashboardMembershipProjection({ members, contracts, lots, membershipOrders, orders, coverage, ledger }, dates, today);
}
