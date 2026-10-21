import { sql } from "kysely";
import type { DashboardDetail } from "@qintopia/contracts";

export interface DashboardPaymentProof {
  count: number;
  verified: boolean | null;
  bill: {
    id: string; kind: "COLLECTION" | "REFUND"; reference: string; transactionId: string | null;
    occurredAt: string; discoveredAt: string; updatedAt: string;
  } | null;
}

const evidenceColumns = sql`count(*)::integer AS count,
  bool_and(b.state='SUCCESS' AND NOT b.needs_review AND b.amount_minor IS NOT NULL
    AND b.amount_minor>=abs(original.net_effect_minor) AND f.currency='CNY') AS verified,
  CASE WHEN count(*)=1 THEN jsonb_agg(jsonb_build_object('id',b.id,'kind',b.kind,'reference',b.reference,
    'transactionId',b.transaction_id,'occurredAt',b.occurred_at,'discoveredAt',b.discovered_at,'updatedAt',b.updated_at))->0
    ELSE NULL END AS bill`;

/** 优先事实的显式来源和分配账本，再兼容旧整笔匹配与历史流水号。冲销继承被冲销事实的凭据。 */
export function stayPaymentEvidence(propertyId: string) {
  return sql`LEFT JOIN collection_facts original ON original.fact_id=CASE WHEN f.fact_type='REVERSAL' THEN f.reverses_fact_id ELSE f.fact_id END
    LEFT JOIN LATERAL (SELECT ${evidenceColumns} FROM external_payment_bills b
      WHERE original.method='WECOM' AND b.property_id=${propertyId}
        AND b.kind=CASE WHEN original.fact_type='REFUND' THEN 'REFUND' ELSE 'COLLECTION' END
        AND CASE WHEN original.external_payment_bill_id IS NOT NULL THEN b.id=original.external_payment_bill_id
          WHEN EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=original.fact_id)
            THEN EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=original.fact_id AND a.bill_id=b.id)
          WHEN EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.collection_fact_id=original.fact_id)
            THEN EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.collection_fact_id=original.fact_id AND m.bill_id=b.id)
          ELSE b.reference=CASE WHEN original.fact_type='REFUND' THEN original.refund_reference ELSE original.transaction_reference END END
    ) proof ON true`;
}

export function memberPaymentEvidence(propertyId: string) {
  return sql`LEFT JOIN membership_payment_facts original ON original.fact_id=CASE WHEN f.fact_type='REVERSAL' THEN f.reverses_fact_id ELSE f.fact_id END
    LEFT JOIN LATERAL (SELECT ${evidenceColumns} FROM external_payment_bills b
      WHERE original.source_type='DIRECT_WECOM' AND b.property_id=${propertyId} AND b.kind='COLLECTION'
        AND b.amount_minor=abs(original.net_effect_minor)
        AND CASE WHEN EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.membership_payment_fact_id=original.fact_id)
          THEN EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.membership_payment_fact_id=original.fact_id AND m.bill_id=b.id)
          ELSE b.reference=original.transaction_reference END
    ) proof ON true`;
}

type EvidenceInput = Pick<DashboardDetail, "paymentMethod" | "transactionReference" | "refundReference" | "originalTransactionReference">;
export function paymentEvidenceTrace(fact: EvidenceInput, proof: DashboardPaymentProof): Pick<DashboardDetail,
  "externalBillId" | "transactionReference" | "refundReference" | "originalTransactionReference" | "sourceOccurredAt" | "sourceDiscoveredAt" | "sourceUpdatedAt" | "syncStatus" | "evidenceStatus"> & { registrationReview: boolean } {
  const bill = proof.count === 1 ? proof.bill : null;
  const complete = Boolean(bill && proof.verified);
  const wecom = fact.paymentMethod === "WECOM";
  // REVERSAL 只说明冲销动作，不能当作支付方式；缺原事实时不能跳过凭据门槛。
  const missingSource = !fact.paymentMethod || fact.paymentMethod === "REVERSAL";
  return {
    externalBillId: bill?.id ?? null,
    transactionReference: bill?.kind === "COLLECTION" ? bill.reference : fact.transactionReference ?? bill?.transactionId ?? null,
    refundReference: bill?.kind === "REFUND" ? bill.reference : fact.refundReference ?? null,
    originalTransactionReference: bill?.kind === "REFUND" ? bill.transactionId : fact.originalTransactionReference ?? null,
    sourceOccurredAt: bill ? new Date(bill.occurredAt).toISOString() : null,
    sourceDiscoveredAt: bill ? new Date(bill.discoveredAt).toISOString() : null,
    sourceUpdatedAt: bill ? new Date(bill.updatedAt).toISOString() : null,
    syncStatus: proof.count > 0 ? "WORKER_SYNCED" : wecom || missingSource ? "UNKNOWN" : "NOT_APPLICABLE",
    evidenceStatus: missingSource ? "MISSING" : wecom ? complete ? "COMPLETE" : proof.count ? "PARTIAL" : "MISSING" : "COMPLETE",
    registrationReview: missingSource || (wecom && !complete)
  };
}
