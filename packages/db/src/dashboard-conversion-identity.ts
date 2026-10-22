import type { Selectable, Transaction } from "kysely";
import type { Database } from "./schema.ts";

type Row<T extends keyof Database> = Selectable<Database[T]>;
type Member = Pick<Row<"members">, "id" | "identity_card_number"> & Partial<Pick<Row<"members">, "full_name" | "nickname" | "phone">>;
type MembershipOrder = Pick<Row<"membership_orders">, "id" | "member_id" | "contract_id" | "entitlement_lot_id" | "status"> & Partial<Pick<Row<"membership_orders">, "created_by_command_id" | "activated_by_command_id">>;
type Contract = Pick<Row<"member_contracts">, "id" | "member_id" | "membership_order_id">;
type Lot = Pick<Row<"entitlement_lots">, "id" | "contract_id">;
type Occupant = Pick<Row<"order_occupants">, "id" | "order_id" | "ordinal" | "role" | "full_name" | "nickname" | "phone" | "document_number" | "created_at">;
type Correction = Pick<Row<"order_occupant_corrections">, "occupant_id" | "order_id" | "sequence" | "prior_full_name" | "prior_nickname" | "prior_phone" | "prior_document_number" | "corrected_full_name" | "corrected_nickname" | "corrected_phone" | "corrected_document_number"> & { amendment_sequence: number };
type ProfileCorrection = Pick<Row<"member_profile_corrections">, "member_id" | "created_at" | "prior_full_name" | "prior_phone" | "prior_identity_card_number" | "corrected_full_name" | "corrected_phone" | "corrected_identity_card_number">;
export interface DashboardConversionEvent {
  id: string; order_id: string; command_id: string; sequence: number; created_at: Date | string; payload: unknown;
  command_type: string; command_state: string; command_property_id: string;
  execution_status: string; business_committed: boolean;
}
export interface DashboardConversionIdentityData {
  members: readonly Member[]; membershipOrders: readonly MembershipOrder[]; contracts: readonly Contract[]; lots: readonly Lot[];
  events: readonly DashboardConversionEvent[];
  orders: ReadonlyArray<{ id: string; property_id: string; member_id: string | null; member_contract_id: string | null }>;
  occupants: readonly Occupant[]; corrections: readonly Correction[]; memberCorrections: readonly ProfileCorrection[];
}
export interface DashboardConversionBinding {
  orderId: string; occupantId: string; memberId: string; verified: boolean;
  reason?: string; reasonLabel?: string;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const phone = (value: unknown) => text(value).replace(/\s+/g, "");
const document = (value: unknown) => text(value).toUpperCase();
const timestamp = (value: Date | string) => new Date(value).getTime();

/** 从已提交的升级事件恢复同一原始主住客的身份关系，不按当前姓名或电话查找会员。 */
export function dashboardConversionBindings(data: DashboardConversionIdentityData, propertyId: string): ReadonlyMap<string, DashboardConversionBinding> {
  const result = new Map<string, DashboardConversionBinding>();
  for (const order of data.orders) {
    if (order.property_id !== propertyId || !order.member_id) continue;
    const events = data.events.filter(event => event.order_id === order.id);
    if (!events.length) continue;
    const primary = data.occupants.filter(person => person.order_id === order.id && person.role === "PRIMARY");
    if (primary.length !== 1 || primary[0]?.ordinal !== 1) continue;
    const person = primary[0]!;
    const binding: DashboardConversionBinding = { orderId: order.id, occupantId: person.id, memberId: order.member_id, verified: false,
      reasonLabel: "升级身份依据待核对", reason: "住宿升级事件与原始主要住客、会员合同或权益依据尚未完整对应。" };
    result.set(person.id, binding);
    if (events.length !== 1) continue;
    const event = events[0]!;
    const payload = record(event.payload), frozenGuest = record(payload.primaryOccupant), frozenMember = record(payload.member);
    const member = data.members.find(row => row.id === order.member_id);
    const membershipOrders = data.membershipOrders.filter(row => row.created_by_command_id === event.command_id && row.activated_by_command_id === event.command_id);
    const membershipOrder = membershipOrders[0];
    const contract = data.contracts.find(row => row.id === order.member_contract_id);
    const lot = data.lots.find(row => row.id === membershipOrder?.entitlement_lot_id);
    const eventTime = timestamp(event.created_at);
    if (event.command_type !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" || event.command_state !== "APPLIED"
      || event.command_property_id !== propertyId || event.execution_status !== "EXECUTED" || !event.business_committed
      || payload.operation !== event.command_type || payload.orderId !== order.id || frozenMember.memberId !== order.member_id
      || !Number.isFinite(eventTime) || timestamp(person.created_at) > eventTime || !Number.isFinite(timestamp(person.created_at))
      || !member || membershipOrders.length !== 1 || !membershipOrder || membershipOrder.status === "DRAFT"
      || membershipOrder.member_id !== order.member_id || membershipOrder.contract_id !== order.member_contract_id
      || !contract || contract.member_id !== order.member_id || contract.membership_order_id !== membershipOrder.id
      || !lot || lot.contract_id !== contract.id) continue;

    // 同一订单的变更序号有事务顺序保证；不能靠墙上时间猜测先后。
    const corrections = data.corrections.filter(row => row.occupant_id === person.id).sort((a, b) => a.sequence - b.sequence);
    let snapshot = { fullName: person.full_name, nickname: person.nickname, phone: person.phone, document: person.document_number };
    let frozenSnapshot = snapshot;
    let invalid = false, changedAfter = false;
    for (const [index, correction] of corrections.entries()) {
      if (correction.order_id !== order.id || correction.sequence !== index + 1 || !Number.isInteger(correction.amendment_sequence)
        || correction.amendment_sequence <= (corrections[index - 1]?.amendment_sequence ?? 0) || correction.amendment_sequence === event.sequence
        || correction.prior_full_name !== snapshot.fullName || correction.prior_nickname !== snapshot.nickname
        || correction.prior_phone !== snapshot.phone || correction.prior_document_number !== snapshot.document) { invalid = true; break; }
      const after = { fullName: correction.corrected_full_name, nickname: correction.corrected_nickname, phone: correction.corrected_phone, document: correction.corrected_document_number };
      if (correction.amendment_sequence < event.sequence) frozenSnapshot = after;
      else if (text(snapshot.fullName) !== text(after.fullName) || phone(snapshot.phone) !== phone(after.phone) || document(snapshot.document) !== document(after.document)) changedAfter = true;
      snapshot = after;
    }
    if (invalid || !phone(frozenGuest.phone) || phone(frozenGuest.phone) !== phone(frozenSnapshot.phone)
      || text(frozenGuest.fullName) !== text(frozenSnapshot.fullName) || text(frozenGuest.nickname) !== text(frozenSnapshot.nickname)
      || phone(frozenMember.phone) !== phone(frozenGuest.phone)) continue;
    if (changedAfter || data.memberCorrections.some(row => row.member_id === member.id && timestamp(row.created_at) >= eventTime
      && (text(row.prior_full_name) !== text(row.corrected_full_name) || phone(row.prior_phone) !== phone(row.corrected_phone)
        || document(row.prior_identity_card_number) !== document(row.corrected_identity_card_number)))) {
      binding.reasonLabel = "升级后身份资料已更正";
      binding.reason = "升级后主要住客或会员的姓名、电话或证件发生实质更正，原升级关系不能直接作为当前身份依据。";
      continue;
    }
    if (!phone(member.phone) || phone(frozenMember.phone) !== phone(member.phone) || text(frozenMember.fullName) !== text(member.full_name)) continue;
    if (document(snapshot.document) && document(member.identity_card_number) && document(snapshot.document) !== document(member.identity_card_number)) {
      binding.reasonLabel = "住客与会员证件不一致";
      binding.reason = "升级记录关联的会员与实际住客证件存在冲突，不能以升级关系覆盖证件冲突。";
      continue;
    }
    result.set(person.id, { orderId: order.id, occupantId: person.id, memberId: member.id, verified: true });
  }
  return result;
}

export async function loadDashboardConversionBindings(trx: Transaction<Database>, propertyId: string,
  base: Pick<DashboardConversionIdentityData, "members" | "membershipOrders" | "contracts" | "lots">) {
  const events = await trx.selectFrom("amendments as a")
    .innerJoin("command_executions as e", "e.id", "a.command_id")
    .innerJoin("command_receipts as r", "r.command_id", "e.id")
    .select(["a.id", "a.order_id", "a.command_id", "a.sequence", "a.created_at", "a.payload", "e.command_type", "e.state as command_state", "e.property_id as command_property_id", "r.execution_status", "r.business_committed"])
    .where("e.property_id", "=", propertyId).where("a.amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
    .where("e.state", "=", "APPLIED").execute();
  if (!events.length) return new Map<string, DashboardConversionBinding>();
  const ids = [...new Set(events.map(event => event.order_id))];
  const [orders, occupants, corrections, memberCorrections] = await Promise.all([
    trx.selectFrom("orders").select(["id", "property_id", "member_id", "member_contract_id"]).where("property_id", "=", propertyId).where("id", "in", ids).execute(),
    trx.selectFrom("order_occupants").selectAll().where("order_id", "in", ids).execute(),
    trx.selectFrom("order_occupant_corrections as c").innerJoin("amendments as a", "a.id", "c.amendment_id")
      .selectAll("c").select("a.sequence as amendment_sequence").where("c.order_id", "in", ids).execute(),
    trx.selectFrom("member_profile_corrections").selectAll().where("property_id", "=", propertyId).execute()
  ]);
  // nullable command_id is rejected by the join and the event contract explicitly.
  return dashboardConversionBindings({ ...base, events: events.filter((event): event is typeof event & { command_id: string } => event.command_id !== null), orders, occupants, corrections, memberCorrections }, propertyId);
}
