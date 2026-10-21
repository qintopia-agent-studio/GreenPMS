import { sql, type Transaction } from "kysely";
import type { DashboardDetail, DashboardDetailEvidenceStatus, DashboardDetailSyncStatus } from "@qintopia/contracts";
import { classifyDashboardMoney, type DashboardMoneyFact } from "@qintopia/domain";
import type { Database } from "./schema.ts";
import { memberPaymentEvidence, paymentEvidenceTrace, stayPaymentEvidence, type DashboardPaymentProof } from "./dashboard-payment-evidence.ts";

export interface LoadedDashboardMoney extends DashboardMoneyFact {
  orderId: string | null;
  memberId: string | null;
  registeredAt: string;
  businessDate: string | null;
  referencesFactId?: string | null;
  reversesFactId?: string | null;
  correctsFactId?: string | null;
  transactionReference?: string | null;
  workerMatched?: boolean;
  syncStatus?: DashboardDetailSyncStatus;
  evidenceStatus?: DashboardDetailEvidenceStatus;
  externalBillId?: string | null;
  refundReference?: string | null;
  originalTransactionReference?: string | null;
  sourceOccurredAt?: string | null;
  sourceDiscoveredAt?: string | null;
  sourceUpdatedAt?: string | null;
  membershipOrderId?: string | null;
  channelCode?: string | null;
  channelOrderReference?: string | null;
  paymentMethod?: string | null;
  financialKind?: string | null;
  paymentProof?: DashboardPaymentProof;
}
type LoadedPmsDashboardMoney = Omit<LoadedDashboardMoney, "family"> & { family: "STAY" | "MEMBER" };
export function loadDashboardMoney(trx: Transaction<Database>, propertyId: string, timezone: string, from: string, until: string): Promise<LoadedPmsDashboardMoney[]>;
export function loadDashboardMoney(trx: Transaction<Database>, propertyId: string, timezone: string, from: string, until: string, options: { includeChannel: false }): Promise<LoadedPmsDashboardMoney[]>;
export function loadDashboardMoney(trx: Transaction<Database>, propertyId: string, timezone: string, from: string, until: string, options: { includeChannel: true }): Promise<LoadedDashboardMoney[]>;
export async function loadDashboardMoney(trx: Transaction<Database>, propertyId: string, timezone: string, from: string, until: string, options: { includeChannel?: boolean } = {}): Promise<LoadedDashboardMoney[]> {
  const bounds = sql`f.created_at >= (${from}::date::timestamp AT TIME ZONE ${timezone}) AND f.created_at < (${until}::date::timestamp AT TIME ZONE ${timezone})`;
  const stay = (await sql<LoadedDashboardMoney>`SELECT f.fact_id AS id, to_char(f.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS date,
    f.currency, f.net_effect_minor::text AS "netMinor", f.fact_type AS kind, c.command_type AS "commandType", 'STAY' AS family,
    EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.property_id=${propertyId} AND t.source_reversal_fact_id=f.fact_id) AS "linkedTransfer",
    false AS "transferSource", false AS "reclassifiedReversal", false AS "replacementCollection", false AS "correctsFact", false AS "deletionCorrection",
    f.order_id AS "orderId", NULL::text AS "memberId", f.created_at::text AS "registeredAt", NULL::text AS "businessDate",
    f.references_fact_id AS "referencesFactId", f.reverses_fact_id AS "reversesFactId", NULL::text AS "correctsFactId",
    COALESCE(f.transaction_reference,original.transaction_reference) AS "transactionReference",
    COALESCE(f.refund_reference,original.refund_reference) AS "refundReference",
    CASE WHEN original.fact_type='REFUND' THEN original.transaction_reference ELSE NULL END AS "originalTransactionReference",
    CASE WHEN f.fact_type='REVERSAL' THEN original.method ELSE f.method END AS "paymentMethod", f.fact_type AS "financialKind",
    NULL::text AS "membershipOrderId",o.booking_channel_code AS "channelCode",o.channel_order_reference AS "channelOrderReference",
    to_jsonb(proof) AS "paymentProof"
    FROM collection_facts f JOIN orders o ON o.id=f.order_id LEFT JOIN command_executions c ON c.id=f.command_id AND c.property_id=o.property_id
    ${stayPaymentEvidence(propertyId)}
    WHERE o.property_id=${propertyId} AND ${bounds} ORDER BY f.created_at,f.fact_id`.execute(trx)).rows;
  const member = (await sql<LoadedDashboardMoney>`SELECT f.fact_id AS id, to_char(f.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS date,
    f.currency, f.net_effect_minor::text AS "netMinor", f.fact_type AS kind, c.command_type AS "commandType", 'MEMBER' AS family,
    EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.property_id=${propertyId} AND t.membership_payment_fact_id=f.fact_id) AS "linkedTransfer",
    (f.source_type='STAY_COLLECTION_TRANSFER') AS "transferSource",
    EXISTS(SELECT 1 FROM membership_payment_reclassifications r JOIN membership_void_reconversions v ON v.command_id=r.command_id AND v.property_id=r.property_id
      WHERE r.property_id=${propertyId} AND r.old_reversal_fact_id=f.fact_id) AS "reclassifiedReversal",
    EXISTS(SELECT 1 FROM membership_void_reconversions v WHERE v.property_id=${propertyId} AND v.replacement_payment_fact_id=f.fact_id) AS "replacementCollection",
    (f.corrects_fact_id IS NOT NULL) AS "correctsFact", (f.deletion_operation_id IS NOT NULL) AS "deletionCorrection",
    NULL::text AS "orderId", o.member_id AS "memberId", f.created_at::text AS "registeredAt", f.business_date::text AS "businessDate",
    f.source_collection_fact_id AS "referencesFactId", f.reverses_fact_id AS "reversesFactId", f.corrects_fact_id AS "correctsFactId",
    COALESCE(f.transaction_reference,original.transaction_reference) AS "transactionReference",
    f.membership_order_id AS "membershipOrderId",NULL::text AS "channelCode",NULL::text AS "channelOrderReference",
    CASE WHEN original.source_type='DIRECT_WECOM' THEN 'WECOM' ELSE original.source_type END AS "paymentMethod",
    f.fact_type AS "financialKind",to_jsonb(proof) AS "paymentProof"
    FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id LEFT JOIN command_executions c ON c.id=f.command_id AND c.property_id=o.property_id
    ${memberPaymentEvidence(propertyId)}
    WHERE o.property_id=${propertyId} AND ${bounds} ORDER BY f.created_at,f.fact_id`.execute(trx)).rows;
  const channel = options.includeChannel ? (await sql<LoadedDashboardMoney>`SELECT f.id AS id, to_char(f.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS date,
    f.currency, f.amount_minor::text AS "netMinor", f.kind AS kind, c.command_type AS "commandType", 'CHANNEL' AS family,
    false AS "linkedTransfer", false AS "transferSource", false AS "reclassifiedReversal", false AS "replacementCollection",
    false AS "correctsFact", false AS "deletionCorrection", f.order_id AS "orderId", NULL::text AS "memberId",
    f.created_at::text AS "registeredAt", f.business_date::text AS "businessDate",
    CASE WHEN f.kind='REVERSAL' THEN NULL::text ELSE f.references_fact_id END AS "referencesFactId",
    CASE WHEN f.kind='REVERSAL' THEN f.references_fact_id ELSE NULL::text END AS "reversesFactId",
    NULL::text AS "correctsFactId", NULL::text AS "transactionReference", false AS "workerMatched",
    'MANUAL_ENTRY' AS "syncStatus", 'COMPLETE' AS "evidenceStatus",
    NULL::text AS "membershipOrderId",o.booking_channel_code AS "channelCode",o.channel_order_reference AS "channelOrderReference",
    'CHANNEL_SETTLEMENT' AS "paymentMethod",f.kind AS "financialKind"
    FROM channel_operating_facts f JOIN orders o ON o.id=f.order_id
    LEFT JOIN command_executions c ON c.id=f.command_id AND c.property_id=o.property_id
    WHERE o.property_id=${propertyId} AND ${bounds} ORDER BY f.created_at,f.id`.execute(trx)).rows : [];
  return [...stay, ...member, ...channel].map(({ paymentProof, ...fact }) => ({ ...fact,
    ...(paymentProof ? paymentEvidenceTrace(fact, paymentProof) : {}), registeredAt: new Date(fact.registeredAt).toISOString() }));
}
export function dashboardMoneyDetail(fact: LoadedDashboardMoney): DashboardDetail {
  const classification = classifyDashboardMoney(fact);
  const labels = { COLLECTION: "登记收款", REFUND: "登记退款", CORRECTION: "登记更正", INTERNAL: "内部资金归属转换", REVIEW: "资金来源待核对" };
  const label = fact.family === "CHANNEL"
    ? classification === "REFUND" ? "渠道登记退款" : classification === "CORRECTION" ? "渠道登记更正" : classification === "COLLECTION" ? "渠道应结登记" : labels[classification]
    : labels[classification];
  const trace = {
    ...(fact.referencesFactId !== undefined ? { referencesFactId: fact.referencesFactId } : {}),
    ...(fact.reversesFactId !== undefined ? { reversesFactId: fact.reversesFactId } : {}),
    ...(fact.correctsFactId !== undefined ? { correctsFactId: fact.correctsFactId } : {}),
    ...(fact.syncStatus !== undefined ? { syncStatus: fact.syncStatus } : {}),
    ...(fact.evidenceStatus !== undefined ? { evidenceStatus: classification === "REVIEW" && fact.evidenceStatus === "COMPLETE" ? "PARTIAL" as const : fact.evidenceStatus } : {})
  };
  const evidence: Partial<DashboardDetail> = {};
  for (const key of ["externalBillId", "transactionReference", "refundReference", "originalTransactionReference", "sourceOccurredAt", "sourceDiscoveredAt", "sourceUpdatedAt", "membershipOrderId", "channelCode", "channelOrderReference", "paymentMethod", "financialKind"] as const) {
    if (fact[key] !== undefined) evidence[key] = fact[key];
  }
  return { id: `money:${fact.family}:${fact.id}`, metric: classification === "REVIEW" ? "REVIEW" : "MONEY", date: fact.date,
    label, orderId: fact.orderId, memberId: fact.memberId, unitId: null, units: null,
    amountMinor: fact.netMinor, currency: fact.currency, registeredAt: fact.registeredAt, businessDate: fact.businessDate,
    sourceType: fact.family === "STAY" ? "LODGING" : fact.family === "MEMBER" ? "MEMBERSHIP" : "CHANNEL",
    claimStatus: classification === "INTERNAL" ? "INTERNAL" : classification === "REVIEW" ? "PENDING_REVIEW" : "CONFIRMED",
    sourceFactId: fact.id, ...trace, ...evidence,
    reason: classification === "INTERNAL" ? "不计入门店新增收退款" : classification === "REVIEW" ? "缺少可核对的资金来源或关联链，不计入已知合计" : fact.family === "CHANNEL" ? "按渠道事实登记时间归组；业务日期保留供对账；金额是渠道应结影响，不代表现金到账" : fact.reclassifiedReversal ? "管理员重建：冲销旧错误收款，属于更正而非退款" : fact.replacementCollection ? "管理员重建：仅计有独立证据的真实会员差额收款" : "按登记时间归组；金额为有符号资金影响，不代表财务收入" };
}
