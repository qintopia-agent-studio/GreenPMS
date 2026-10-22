import type { Selectable } from "kysely";
import type { CommunityMembershipEvidence } from "../../domain/src/community-metrics.ts";
import type { Database } from "./schema.ts";

type Row<T extends keyof Database> = Selectable<Database[T]>;
export interface DashboardMemberUsageData {
  members: ReadonlyArray<Pick<Row<"members">, "id" | "full_name" | "nickname">>;
  contracts: ReadonlyArray<Pick<Row<"member_contracts">, "id" | "member_id" | "membership_order_id" | "status"> & Partial<Pick<Row<"member_contracts">, "member_name">>>;
  lots: ReadonlyArray<Pick<Row<"entitlement_lots">, "id" | "contract_id" | "status">>;
  membershipOrders: ReadonlyArray<Pick<Row<"membership_orders">, "id" | "member_id" | "contract_id" | "entitlement_lot_id" | "status" | "created_by_command_id" | "activated_by_command_id">>;
  orders: ReadonlyArray<Pick<Row<"orders">, "id" | "member_id" | "member_contract_id">>;
  coverage: ReadonlyArray<Pick<Row<"coverage_items">, "id" | "order_id" | "contract_id" | "lot_id" | "service_date" | "status">>;
  ledger: ReadonlyArray<Pick<Row<"entitlement_ledger">, "fact_id" | "order_id" | "lot_id" | "service_date" | "coverage_id" | "entry_type" | "quantity_delta" | "command_id"> & {
    command_type?: string | null; command_state?: string | null;
  }>;
}
export const usageKey = (orderId: string, date: string) => `${orderId}:${date}`;
const unknown = (memberId: string | null, reason: string): CommunityMembershipEvidence => ({ status: "UNKNOWN", memberId, reasonLabel: "权益使用记录待核对", reason });

/** 每订单每服务日的实际净核销。会员ID仅表示权益来源，不证明任何住客身份。 */
export function dashboardMemberUsage(data: DashboardMemberUsageData): ReadonlyMap<string, CommunityMembershipEvidence> {
  const contracts = new Map(data.contracts.map(row => [row.id, row]));
  const lots = new Map(data.lots.map(row => [row.id, row]));
  const orders = new Map(data.orders.map(row => [row.id, row]));
  const membershipOrders = new Map(data.membershipOrders.map(row => [row.id, row]));
  const ledger = [...new Map(data.ledger.map(row => [row.fact_id, row])).values()];
  const byCoverage = new Map<string, typeof ledger>();
  for (const fact of ledger) if (fact.coverage_id) {
    const rows = byCoverage.get(fact.coverage_id) ?? []; rows.push(fact); byCoverage.set(fact.coverage_id, rows);
  }
  const result = new Map<string, CommunityMembershipEvidence>();
  function add(orderId: string, date: string, evidence: CommunityMembershipEvidence) {
    const key = usageKey(orderId, date), previous = result.get(key);
    if (previous?.status === "UNKNOWN") return;
    if (previous && previous.memberId !== evidence.memberId) {
      result.set(key, unknown(null, "同一住宿日期的权益来源不一致，不能重复计数或猜测会员来源。")); return;
    }
    result.set(key, evidence);
  }
  function owner(orderId: string, lotId: string, contractId?: string, historicalConversion?: string): CommunityMembershipEvidence {
    const order = orders.get(orderId), lot = lots.get(lotId), contract = lot ? contracts.get(lot.contract_id) : undefined;
    const memberId = contract?.member_id ?? order?.member_id ?? null;
    const membership = contract?.membership_order_id ? membershipOrders.get(contract.membership_order_id) : undefined;
    if (!order || !lot || !contract
      || (contractId !== undefined && contract.id !== contractId)
      || (order.member_id ? order.member_id !== contract.member_id : !historicalConversion && order.member_contract_id !== contract.id)
      || (historicalConversion && order.member_contract_id && order.member_contract_id !== contract.id)
      || (contract.membership_order_id && (!membership || membership.member_id !== memberId
        || membership.contract_id !== contract.id || membership.entitlement_lot_id !== lot.id))
      || (historicalConversion && (!membership || membership.created_by_command_id !== historicalConversion || membership.activated_by_command_id !== historicalConversion))) {
      return unknown(memberId, "权益使用与住宿订单、会员合同或权益批次的关联不完整，需核对原业务记录。");
    }
    if (contract.status === "VOIDED" || lot.status === "VOIDED" || membership?.status === "VOIDED" || membership?.status === "DRAFT") {
      return unknown(memberId, "存在已核销权益，但关联合同或权益已作废或未生效，需核对核销与作废依据。");
    }
    // 已核销服务日就是业务依据：不以今天过期状态或转换的较晚生效日抹掉历史使用。
    const memberName = contract.member_name?.trim();
    return { status: "CONFIRMED", memberId, basis: "MEMBER_ENTITLEMENT", ...(memberName ? { memberName } : {}) };
  }
  for (const coverage of new Map(data.coverage.map(row => [row.id, row])).values()) {
    if (coverage.status !== "CONSUMED") continue;
    const facts = byCoverage.get(coverage.id) ?? [];
    const consumed = facts.filter(row => row.entry_type === "CONSUME" || row.entry_type === "CONVERSION_CONSUME");
    const restored = facts.filter(row => row.entry_type === "RESTORE");
    const validShape = facts.every(row => row.order_id === coverage.order_id && row.lot_id === coverage.lot_id && row.service_date === coverage.service_date)
      && consumed.length === 1 && restored.length <= 1
      && consumed.every(row => row.quantity_delta === (row.entry_type === "CONSUME" ? 0 : -1))
      && restored.every(row => row.quantity_delta === 1);
    if (!validShape) {
      add(coverage.order_id, coverage.service_date, unknown(orders.get(coverage.order_id)?.member_id ?? null, "权益覆盖缺少唯一有效核销，或核销与返还记录不一致。")); continue;
    }
    if (restored.length) continue;
    add(coverage.order_id, coverage.service_date, owner(coverage.order_id, coverage.lot_id, coverage.contract_id));
  }
  // 已完成住宿的旧转换没有coverage行，但有按服务日追加的受控转换核销事实。
  for (const fact of ledger) {
    if (fact.coverage_id !== null || fact.entry_type !== "CONVERSION_CONSUME" || !fact.order_id || !fact.service_date) continue;
    const validCommand = fact.quantity_delta === -1 && fact.command_id && fact.command_state === "APPLIED"
      && ["CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"].includes(fact.command_type ?? "");
    add(fact.order_id, fact.service_date, validCommand
      ? owner(fact.order_id, fact.lot_id, undefined, fact.command_id!)
      : unknown(orders.get(fact.order_id)?.member_id ?? null, "历史转换核销缺少已提交的受控业务命令，需核对原业务记录。"));
  }
  return result;
}
