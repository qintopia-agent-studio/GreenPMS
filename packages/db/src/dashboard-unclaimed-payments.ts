import { sql, type Transaction } from "kysely";
import type { DashboardBalance, DashboardDetail, DashboardResponse } from "@qintopia/contracts";
import type { Database } from "./schema.ts";

export interface DashboardUnclaimedBill {
  id: string; date: string; kind: "COLLECTION" | "REFUND"; reference: string; originalTransactionReference: string | null;
  amountMinor: string | null; allocatedMinor: string; legacyClaimedMinor: string; memberClaimed: boolean;
  state: string; needsReview: boolean; duplicate: boolean; matchingEligible: boolean;
  occurredAt: string; discoveredAt: string; updatedAt: string;
}

/** 原始流水只展示剩余归属，不会创建资金事实，也不进入正式登记合计。 */
export function unclaimedPaymentDetails(bills: DashboardUnclaimedBill[]): DashboardDetail[] {
  return [...new Map(bills.map(bill => [bill.id, bill])).values()].flatMap(bill => {
    const amount = bill.amountMinor === null ? null : BigInt(bill.amountMinor);
    const claimed = BigInt(bill.allocatedMinor) + BigInt(bill.legacyClaimedMinor) + (bill.memberClaimed ? amount ?? 0n : 0n);
    const remaining = amount === null ? null : amount - claimed;
    const overclaimed = remaining !== null && remaining < 0n;
    if (remaining === 0n || bill.state === "CLOSED") return [];
    const verified = bill.state === "SUCCESS" && amount !== null && amount > 0n && !bill.needsReview && !bill.duplicate && bill.matchingEligible && !overclaimed;
    const reason = overclaimed ? "流水关联份额超过原金额，需核对归属链；不计入正式登记合计"
      : bill.duplicate ? "同号企微流水存在多份来源，未确认唯一凭据；不计入正式登记合计"
        : !bill.matchingEligible ? "流水属于自动认领起始日前的历史来源，需核对历史归属；不计入正式登记合计"
          : !verified ? "企微原始流水状态、金额或来源证据尚未核实；不计入正式登记合计"
            : claimed > 0n ? "企微流水已部分认领，此处仅显示尚未分配的余额；不计入已确认登记合计"
              : "worker 已同步的企微流水尚未关联业务；不计入经营销售额或已确认登记合计";
    return [{ id: `unclaimed:${bill.id}`, date: bill.date, metric: "MONEY" as const,
      label: verified ? bill.kind === "REFUND" ? "企微退款待认领" : "企微收款待认领" : "企微来源待核对",
      orderId: null, memberId: null, unitId: null, units: null,
      amountMinor: remaining !== null && remaining > 0n && bill.state === "SUCCESS" ? String(bill.kind === "REFUND" ? -remaining : remaining) : null,
      currency: "CNY", registeredAt: new Date(bill.discoveredAt).toISOString(), businessDate: null,
      sourceType: "WECOM" as const, claimStatus: verified ? "UNCLAIMED" as const : "PENDING_REVIEW" as const,
      sourceFactId: null, externalBillId: bill.id,
      transactionReference: bill.kind === "COLLECTION" ? bill.reference : bill.originalTransactionReference,
      refundReference: bill.kind === "REFUND" ? bill.reference : null,
      originalTransactionReference: bill.originalTransactionReference,
      sourceOccurredAt: new Date(bill.occurredAt).toISOString(), sourceDiscoveredAt: new Date(bill.discoveredAt).toISOString(), sourceUpdatedAt: new Date(bill.updatedAt).toISOString(),
      paymentMethod: "WECOM", financialKind: bill.kind, syncStatus: "WORKER_SYNCED" as const,
      evidenceStatus: verified ? "COMPLETE" as const : amount === null ? "MISSING" as const : "PARTIAL" as const, reason }];
  });
}

export function summarizeUnclaimedPayments(details: DashboardDetail[], currency: string): DashboardBalance[] {
  const grouped = new Map<string, DashboardBalance>([[currency, { currency, amountMinor: "0", count: 0 }]]);
  for (const row of details) {
    if (row.claimStatus !== "UNCLAIMED" || row.amountMinor === null || row.currency === null) continue;
    const total = grouped.get(row.currency) ?? { currency: row.currency, amountMinor: "0", count: 0 };
    total.amountMinor = String(BigInt(total.amountMinor) + BigInt(row.amountMinor)); total.count++;
    grouped.set(row.currency, total);
  }
  return [...grouped.values()];
}

export async function loadDashboardUnclaimedPayments(trx: Transaction<Database>, propertyId: string, timezone: string, from: string, until: string) {
  const bills = (await sql<DashboardUnclaimedBill>`SELECT b.id,
    to_char(b.discovered_at AT TIME ZONE ${timezone},'YYYY-MM-DD') AS date,b.kind,b.reference,
    b.transaction_id AS "originalTransactionReference",b.amount_minor::text AS "amountMinor",b.state,b.needs_review AS "needsReview",
    b.occurred_at::text AS "occurredAt",b.discovered_at::text AS "discoveredAt",b.updated_at::text AS "updatedAt",
    (b.occurred_at>=s.matching_since) AS "matchingEligible",
    EXISTS(SELECT 1 FROM external_payment_bills duplicate WHERE duplicate.property_id=b.property_id AND duplicate.kind=b.kind
      AND duplicate.reference=b.reference AND duplicate.id<>b.id) AS duplicate,
    COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a WHERE a.bill_id=b.id
      AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases released WHERE released.allocation_id=a.id)),0)::text AS "allocatedMinor",
    COALESCE((SELECT sum(f.amount_minor) FROM collection_facts f JOIN orders o ON o.id=f.order_id
      WHERE o.property_id=b.property_id AND f.method='WECOM' AND f.currency='CNY' AND f.fact_type=b.kind
        AND NOT EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=f.fact_id)
        AND (EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.collection_fact_id=f.fact_id AND m.bill_id=b.id)
          OR (NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.collection_fact_id=f.fact_id)
            AND NOT EXISTS(SELECT 1 FROM collection_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.fact_type='REVERSAL')
            AND CASE WHEN f.external_payment_bill_id IS NOT NULL THEN f.external_payment_bill_id=b.id
              ELSE CASE WHEN f.fact_type='REFUND' THEN f.refund_reference ELSE f.transaction_reference END=b.reference END))),0)::text AS "legacyClaimedMinor",
    (EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=b.id AND m.membership_payment_fact_id IS NOT NULL)
      OR (b.kind='COLLECTION' AND EXISTS(SELECT 1 FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id
        WHERE o.property_id=b.property_id AND f.source_type='DIRECT_WECOM' AND f.fact_type='COLLECTION' AND f.currency='CNY'
          AND f.transaction_reference=b.reference AND f.amount_minor=b.amount_minor
          AND NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.membership_payment_fact_id=f.fact_id)
          AND NOT EXISTS(SELECT 1 FROM membership_payment_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.fact_type='REVERSAL')))) AS "memberClaimed"
    FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
    WHERE b.property_id=${propertyId} AND b.discovered_at>=(${from}::date::timestamp AT TIME ZONE ${timezone})
      AND b.discovered_at<(${until}::date::timestamp AT TIME ZONE ${timezone}) ORDER BY b.discovered_at,b.id`.execute(trx)).rows;
  return unclaimedPaymentDetails(bills);
}

export async function loadDashboardPaymentSync(trx: Transaction<Database>, propertyId: string): Promise<NonNullable<DashboardResponse["current"]["paymentSync"]>> {
  const state = (await sql<{ enabled: boolean | null; lastSyncedAt: string | null; hasError: boolean | null }>`
    SELECT bool_or(s.enabled) AS enabled,
      CASE WHEN count(*) FILTER (WHERE s.enabled AND s.last_success_at IS NULL)>0 THEN NULL
        ELSE min(s.last_success_at) FILTER (WHERE s.enabled) END::text AS "lastSyncedAt",
      bool_or(s.enabled AND s.last_error_code IS NOT NULL) AS "hasError"
    FROM external_payment_sources s WHERE EXISTS(SELECT 1 FROM external_payment_accounts a WHERE a.source_id=s.id AND a.property_id=${propertyId})`.execute(trx)).rows[0];
  return { enabled: state?.enabled === true, lastSyncedAt: state?.lastSyncedAt ? new Date(state.lastSyncedAt).toISOString() : null, hasError: state?.hasError === true };
}
