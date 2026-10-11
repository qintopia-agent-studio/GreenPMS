import { sql, type Transaction } from "kysely";
import type { DashboardDetail } from "@qintopia/contracts";
import { classifyDashboardMoney, type DashboardMoneyFact } from "@qintopia/domain";
import type { Database } from "./schema.ts";

export interface LoadedDashboardMoney extends DashboardMoneyFact { orderId: string | null; memberId: string | null; registeredAt: string; businessDate: string | null }
export async function loadDashboardMoney(trx: Transaction<Database>, propertyId: string, timezone: string, from: string, until: string): Promise<LoadedDashboardMoney[]> {
  const bounds = sql`f.created_at >= (${from}::date::timestamp AT TIME ZONE ${timezone}) AND f.created_at < (${until}::date::timestamp AT TIME ZONE ${timezone})`;
  const stay = (await sql<LoadedDashboardMoney>`SELECT f.fact_id AS id, to_char(f.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS date,
    f.currency, f.net_effect_minor::text AS "netMinor", f.fact_type AS kind, c.command_type AS "commandType", 'STAY' AS family,
    EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.property_id=${propertyId} AND t.source_reversal_fact_id=f.fact_id) AS "linkedTransfer",
    false AS "transferSource", false AS "reclassifiedReversal", false AS "replacementCollection", false AS "correctsFact", false AS "deletionCorrection",
    f.order_id AS "orderId", NULL::text AS "memberId", f.created_at::text AS "registeredAt", NULL::text AS "businessDate"
    FROM collection_facts f JOIN orders o ON o.id=f.order_id LEFT JOIN command_executions c ON c.id=f.command_id AND c.property_id=o.property_id
    WHERE o.property_id=${propertyId} AND ${bounds} ORDER BY f.created_at,f.fact_id`.execute(trx)).rows;
  const member = (await sql<LoadedDashboardMoney>`SELECT f.fact_id AS id, to_char(f.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS date,
    f.currency, f.net_effect_minor::text AS "netMinor", f.fact_type AS kind, c.command_type AS "commandType", 'MEMBER' AS family,
    EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.property_id=${propertyId} AND t.membership_payment_fact_id=f.fact_id) AS "linkedTransfer",
    (f.source_type='STAY_COLLECTION_TRANSFER') AS "transferSource",
    EXISTS(SELECT 1 FROM membership_payment_reclassifications r JOIN membership_void_reconversions v ON v.command_id=r.command_id AND v.property_id=r.property_id
      WHERE r.property_id=${propertyId} AND r.old_reversal_fact_id=f.fact_id) AS "reclassifiedReversal",
    EXISTS(SELECT 1 FROM membership_void_reconversions v WHERE v.property_id=${propertyId} AND v.replacement_payment_fact_id=f.fact_id) AS "replacementCollection",
    (f.corrects_fact_id IS NOT NULL) AS "correctsFact", (f.deletion_operation_id IS NOT NULL) AS "deletionCorrection",
    NULL::text AS "orderId", o.member_id AS "memberId", f.created_at::text AS "registeredAt", f.business_date::text AS "businessDate"
    FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id LEFT JOIN command_executions c ON c.id=f.command_id AND c.property_id=o.property_id
    WHERE o.property_id=${propertyId} AND ${bounds} ORDER BY f.created_at,f.fact_id`.execute(trx)).rows;
  return [...stay, ...member].map(fact => ({ ...fact, registeredAt: new Date(fact.registeredAt).toISOString() }));
}
export function dashboardMoneyDetail(fact: LoadedDashboardMoney): DashboardDetail {
  const classification = classifyDashboardMoney(fact);
  const labels = { COLLECTION: "登记收款", REFUND: "登记退款", CORRECTION: "登记更正", INTERNAL: "内部资金归属转换", REVIEW: "资金来源待核对" };
  return { id: `money:${fact.family}:${fact.id}`, metric: classification === "REVIEW" ? "REVIEW" : "MONEY", date: fact.date,
    label: labels[classification], orderId: fact.orderId, memberId: fact.memberId, unitId: null, units: null,
    amountMinor: fact.netMinor, currency: fact.currency, registeredAt: fact.registeredAt, businessDate: fact.businessDate,
    reason: classification === "INTERNAL" ? "不计入门店新增收退款" : classification === "REVIEW" ? "缺少可核对的资金来源或关联链，不计入已知合计" : fact.reclassifiedReversal ? "管理员重建：冲销旧错误收款，属于更正而非退款" : fact.replacementCollection ? "管理员重建：仅计有独立证据的真实会员差额收款" : "按登记时间归组；金额为有符号资金影响，不代表财务收入" };
}
