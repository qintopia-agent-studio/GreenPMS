import { sql, type Kysely, type Transaction } from 'kysely';
import type { ExternalPaymentItem, ExternalPaymentRelatedRefund } from '../../contracts/src/external-payments.ts';
import type { Database } from './schema.ts';

type Db = Kysely<Database> | Transaction<Database>;
interface RefundRow {
  parentId: string; billId: string; refundReference: string; amountMinor: number | null;
  state: string; matchedMinor: string; needsReview: boolean;
}
/** Read-only context: refunds retain their own identity and never become available collection money. */
export async function enrichPaymentRefundContext<T extends Pick<ExternalPaymentItem, 'id' | 'kind'>>(db: Db, propertyId: string, items: T[]): Promise<T[]> {
  const parents = items.filter(item => item.kind === 'COLLECTION').map(item => item.id);
  if (!parents.length) return items;
  const rows = (await sql<RefundRow>`SELECT p.id AS "parentId", r.id AS "billId", r.reference AS "refundReference",
    r.amount_minor AS "amountMinor", r.state,
    (r.needs_review OR EXISTS(SELECT 1 FROM external_payment_bills d WHERE d.property_id=r.property_id
      AND d.kind=r.kind AND d.reference=r.reference AND d.id<>r.id)) AS "needsReview",
    (COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a WHERE a.bill_id=r.id
      AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)),0)
     + COALESCE((SELECT sum(f.amount_minor) FROM collection_facts f JOIN orders o ON o.id=f.order_id
        WHERE o.property_id=r.property_id AND f.method='WECOM' AND f.currency='CNY' AND f.fact_type='REFUND'
          AND NOT EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=f.fact_id)
          AND (EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.collection_fact_id=f.fact_id AND m.bill_id=r.id)
            OR (NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.collection_fact_id=f.fact_id)
              AND NOT EXISTS(SELECT 1 FROM collection_facts rev WHERE rev.reverses_fact_id=f.fact_id)
              AND CASE WHEN f.external_payment_bill_id IS NOT NULL THEN f.external_payment_bill_id=r.id
                ELSE f.refund_reference=r.reference AND NOT EXISTS(SELECT 1 FROM external_payment_bills d
                  WHERE d.property_id=r.property_id AND d.kind='REFUND' AND d.reference=r.reference AND d.id<>r.id) END))),0))::text AS "matchedMinor"
    FROM external_payment_bills p JOIN external_payment_bills r ON r.source_id=p.source_id AND r.merchant_id=p.merchant_id
      AND r.property_id=p.property_id AND r.kind='REFUND' AND r.transaction_id=p.reference
    WHERE p.property_id=${propertyId} AND p.kind='COLLECTION' AND p.id IN (${sql.join(parents)})
    ORDER BY r.occurred_at,r.id`.execute(db)).rows;
  const groups = new Map<string, ExternalPaymentRelatedRefund[]>();
  for (const row of rows) {
    const matchedMinor = Number(row.matchedMinor);
    const needsReview = row.needsReview || !Number.isSafeInteger(matchedMinor)
      || row.amountMinor !== null && matchedMinor > row.amountMinor;
    const item: ExternalPaymentRelatedRefund = { billId: row.billId, refundReference: row.refundReference,
      amountMinor: row.amountMinor, state: row.state, matchedMinor,
      unassignedMinor: row.amountMinor === null ? null : Math.max(0, row.amountMinor - matchedMinor), needsReview };
    const group = groups.get(row.parentId);
    if (group) group.push(item); else groups.set(row.parentId, [item]);
  }
  return items.map(item => {
    if (item.kind !== 'COLLECTION') return item;
    const relatedRefunds = groups.get(item.id) ?? [];
    const succeeded = relatedRefunds.filter(refund => refund.state === 'SUCCESS' && refund.amountMinor !== null);
    return { ...item, relatedRefunds, refundSummary: {
      succeededMinor: succeeded.reduce((sum, refund) => sum + refund.amountMinor!, 0),
      matchedMinor: succeeded.reduce((sum, refund) => sum + refund.matchedMinor, 0),
      unassignedMinor: succeeded.reduce((sum, refund) => sum + (refund.unassignedMinor ?? 0), 0),
      pendingCount: relatedRefunds.filter(refund => refund.state === 'PENDING').length,
      reviewCount: relatedRefunds.filter(refund => refund.needsReview || refund.amountMinor === null || refund.state === 'UNKNOWN').length
    } };
  });
}
