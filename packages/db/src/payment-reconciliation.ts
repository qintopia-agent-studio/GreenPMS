import { sql, type Kysely } from 'kysely';
import { DomainError, type PaymentReconciliationItem, type PaymentReconciliationQuery,
  type PaymentReconciliationResponse, type PaymentReconciliationTotals } from '@qintopia/contracts';
import type { Database } from './schema.ts';

export interface ReconciliationBill {
  id: string; sourceId: string; merchantId: string; kind: 'COLLECTION' | 'REFUND'; reference: string;
  originalReference: string | null; amountMinor: number | null; state: string; needsReview: boolean;
  nickname: string | null; occurredAt: string; discoveredAt: string; matchingEligible: boolean;
}
export interface ReconciliationFact {
  id: string; family: 'STAY' | 'MEMBER'; kind: 'COLLECTION' | 'REFUND'; amountMinor: number; currency: string;
  reference: string | null; originalReference: string | null; originalBillId: string | null;
  explicitBillId: string | null; orderId: string | null; membershipOrderId: string | null;
  predecessorId: string | null; createdAt: string; effective: boolean;
}
export interface ReconciliationClaim {
  billId: string; factId: string; family: 'STAY' | 'MEMBER'; amountMinor: number; released: boolean;
  allocation: boolean;
}
export interface ReconciliationSnapshot {
  bills: ReconciliationBill[]; facts: ReconciliationFact[]; claims: ReconciliationClaim[];
  matchingSince: string | null;
}
const positive = (value: bigint) => value > 0n ? value : 0n;
const factKey = (fact: Pick<ReconciliationFact, 'family' | 'id'>) => `${fact.family}:${fact.id}`;
const referenceKey = (kind: ReconciliationBill['kind'], reference: string) => JSON.stringify([kind, reference]);
const sourceKey = (sourceId: string, merchantId: string, reference: string | null) => JSON.stringify([sourceId, merchantId, reference]);
function append<T>(index: Map<string, T[]>, key: string, value: T): void {
  const group = index.get(key);
  if (group) group.push(value); else index.set(key, [value]);
}
const issue = (code: PaymentReconciliationItem['issues'][number]['code'], message: string) => ({ code, message });
const zeroTotals = (): PaymentReconciliationTotals => ({ externalMinor: '0', businessMinor: '0', unassignedMinor: '0', excessMinor: '0', unbackedMinor: '0', unknownCount: 0 });

/** Project both directions. Source reservations are not proof of a live business entry. */
export function projectPaymentReconciliation(snapshot: ReconciliationSnapshot): PaymentReconciliationItem[] {
  // Index the snapshot once. Each fact/source lookup must not rescan every bill.
  const billsById = new Map(snapshot.bills.map(bill => [bill.id, bill]));
  const billsByReference = new Map<string, ReconciliationBill[]>();
  const collectionsBySource = new Map<string, ReconciliationBill[]>();
  for (const bill of snapshot.bills) {
    append(billsByReference, referenceKey(bill.kind, bill.reference), bill);
    if (bill.kind === 'COLLECTION') append(collectionsBySource, sourceKey(bill.sourceId, bill.merchantId, bill.reference), bill);
  }
  const facts = new Map(snapshot.facts.map(fact => [factKey(fact), fact]));
  const factsWithClaims = new Set<string>();
  const claimsByFact = new Map<string, ReconciliationClaim[]>();
  const factsWithAllocations = new Set<string>();
  for (const claim of snapshot.claims) {
    const key = `${claim.family}:${claim.factId}`;
    append(claimsByFact, key, claim);
    if (claim.allocation) factsWithAllocations.add(key);
  }
  const reservations = new Map<string, bigint>();
  const reservedFactsByBill = new Map<string, ReconciliationFact[]>();
  for (const claim of snapshot.claims) {
    // Migration 069 keeps the legacy match as well as the backfilled allocation.
    if (claim.released || !claim.allocation && factsWithAllocations.has(`${claim.family}:${claim.factId}`)) continue;
    reservations.set(claim.billId, (reservations.get(claim.billId) ?? 0n) + BigInt(claim.amountMinor));
    const reservedFact = facts.get(`${claim.family}:${claim.factId}`);
    if (reservedFact) append(reservedFactsByBill, claim.billId, reservedFact);
  }
  const evidence = (fact: ReconciliationFact): ReconciliationBill[] => {
    if (fact.explicitBillId) {
      const bill = billsById.get(fact.explicitBillId);
      return bill?.kind === fact.kind ? [bill] : [];
    }
    const lineage: ReconciliationFact[] = [fact];
    const seen = new Set([fact.id]);
    let current = fact;
    while (current.family === 'MEMBER' && current.predecessorId && !seen.has(current.predecessorId)) {
      const previous = facts.get(`MEMBER:${current.predecessorId}`);
      if (!previous || previous.reference !== fact.reference || previous.currency !== fact.currency) break;
      seen.add(previous.id); lineage.push(previous); current = previous;
    }
    const linked = lineage.flatMap(item => claimsByFact.get(factKey(item)) ?? []);
    const allocations = linked.filter(claim => claim.allocation);
    const selected = allocations.length ? allocations : linked;
    if (selected.length) {
      factsWithClaims.add(factKey(fact));
      const ids = new Set(selected.map(claim => claim.billId));
      return [...ids].flatMap(id => {
        const bill = billsById.get(id);
        return bill?.kind === fact.kind ? [bill] : [];
      });
    }
    return fact.reference ? billsByReference.get(referenceKey(fact.kind, fact.reference)) ?? [] : [];
  };
  const businessByBill = new Map<string, ReconciliationFact[]>();
  const orphanFacts: { fact: ReconciliationFact; ambiguous: boolean }[] = [];
  for (const fact of snapshot.facts) {
    if (!fact.effective) continue;
    const candidates = evidence(fact);
    if (candidates.length === 1) {
      const bill = candidates[0]!;
      append(businessByBill, bill.id, fact);
      // Compatible manual records without a persisted match are evidence, not a new registration.
      if (!(claimsByFact.get(factKey(fact))?.length) && !factsWithClaims.has(factKey(fact))) {
        reservations.set(bill.id, (reservations.get(bill.id) ?? 0n) + BigInt(fact.amountMinor));
      }
    } else {
      let first = fact;
      const seen = new Set([fact.id]);
      while (first.predecessorId && !seen.has(first.predecessorId)) {
        const previous = facts.get(`${fact.family}:${first.predecessorId}`);
        if (!previous || previous.reference !== fact.reference) break;
        seen.add(previous.id); first = previous;
      }
      if (snapshot.matchingSince && first.createdAt >= snapshot.matchingSince) orphanFacts.push({ fact, ambiguous: candidates.length > 1 });
    }
  }
  const items: PaymentReconciliationItem[] = [];
  for (const bill of snapshot.bills) {
    if (!bill.matchingEligible) continue;
    const linked = businessByBill.get(bill.id) ?? [];
    const allocated = reservations.get(bill.id) ?? 0n;
    const business = linked.filter(fact => fact.currency === 'CNY').reduce((sum, fact) => sum + BigInt(fact.amountMinor), 0n);
    if (bill.state === 'CLOSED' && allocated === 0n && business === 0n) continue;
    const duplicate = (billsByReference.get(referenceKey(bill.kind, bill.reference))?.length ?? 0) > 1;
    const verified = bill.state === 'SUCCESS' && bill.amountMinor !== null && bill.amountMinor > 0 && !bill.needsReview && !duplicate;
    const external = bill.amountMinor === null ? null : BigInt(bill.amountMinor);
    const issues: PaymentReconciliationItem['issues'] = [];
    if (!verified) issues.push(issue('UNVERIFIED', bill.state === 'PENDING' ? '退款仍在处理中，尚不能核实成功' : '流水状态、金额或来源尚未核实，不能认定已对平'));
    if (bill.needsReview || duplicate) issues.push(issue('SOURCE_REVIEW', '原始来源有变更或同号来源不唯一，请核对凭据'));
    if (external !== null && business > external || external !== null && allocated > external) issues.push(issue('OVERCLAIMED', '登记或来源占用超过外部流水金额'));
    if (verified && external !== null && business < external) issues.push(issue('UNASSIGNED', bill.kind === 'REFUND' ? '外部已成功退款，仍有金额未完成业务登记' : '外部已成功收款，仍有金额未完成业务登记'));
    if (allocated !== business) issues.push(issue('BUSINESS_MISMATCH', '来源占用与有效业务登记不一致，需核对冲销或归属记录'));
    if (linked.some(fact => fact.currency !== 'CNY')) issues.push(issue('SOURCE_REVIEW', '业务币种与企微来源不一致，金额不能混合核对'));
    if (bill.kind === 'REFUND') {
      const parents = collectionsBySource.get(sourceKey(bill.sourceId, bill.merchantId, bill.originalReference)) ?? [];
      const parentIds = new Set(parents.map(parent => parent.id));
      if (parents.length !== 1) issues.push(issue('MISSING_ORIGINAL', '尚无唯一可核对的原收款流水'));
      if (linked.some(fact => fact.originalBillId ? !parentIds.has(fact.originalBillId)
        : !fact.originalReference || fact.originalReference !== bill.originalReference)) {
        issues.push(issue('SOURCE_REVIEW', '退款业务的原收款与外部退款来源不一致'));
      }
    }
    // A reversed entry may still occupy its source. Preserve that known order
    // as a correction destination without counting it as effective business.
    const reservedFacts = reservedFactsByBill.get(bill.id) ?? [];
    const orderIds = [...new Set([...linked, ...reservedFacts].flatMap(fact => fact.orderId ? [fact.orderId] : []))].sort();
    const activeMemberFacts = linked.filter(fact => fact.membershipOrderId);
    const memberIds = [...new Set((activeMemberFacts.length ? activeMemberFacts : reservedFacts).flatMap(fact => fact.membershipOrderId ? [fact.membershipOrderId] : []))];
    items.push({ id: `bill:${bill.id}`, kind: bill.kind, billId: bill.id, factId: null, orderIds,
      orderId: orderIds.length === 1 ? orderIds[0]! : null, membershipOrderId: memberIds.length === 1 ? memberIds[0]! : null,
      reference: bill.reference, originalTransactionReference: bill.originalReference, nickname: bill.nickname, currency: 'CNY',
      amountMinor: bill.amountMinor, allocatedMinor: String(allocated), businessMinor: String(business),
      unassignedMinor: external === null ? null : String(positive(external - business)),
      excessMinor: external === null ? '0' : String(positive((business > allocated ? business : allocated) - external)),
      occurredAt: bill.occurredAt, discoveredAt: bill.discoveredAt, issues });
  }
  for (const { fact, ambiguous } of orphanFacts) {
    items.push({ id: `fact:${fact.family}:${fact.id}`, kind: fact.kind, billId: null, factId: fact.id,
      orderId: fact.orderId, membershipOrderId: fact.membershipOrderId, orderIds: fact.orderId ? [fact.orderId] : [],
      reference: fact.reference, originalTransactionReference: fact.originalReference, nickname: null, currency: fact.currency,
      amountMinor: null, allocatedMinor: '0', businessMinor: String(fact.amountMinor), unassignedMinor: null, excessMinor: '0',
      occurredAt: fact.createdAt, discoveredAt: null, issues: [issue(ambiguous ? 'SOURCE_REVIEW' : 'BUSINESS_WITHOUT_BILL',
        ambiguous ? '业务单号对应多笔外部来源，不能自动认定归属' : '已有业务登记，但没有可核对的企微流水')] });
  }
  return items.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function summarizePaymentReconciliation(items: PaymentReconciliationItem[]): PaymentReconciliationResponse['summary'] {
  const summary = { collections: zeroTotals(), refunds: zeroTotals() };
  for (const item of items) {
    const total = item.kind === 'COLLECTION' ? summary.collections : summary.refunds;
    const verified = item.billId !== null && !item.issues.some(reason => reason.code === 'UNVERIFIED');
    if (verified && item.amountMinor !== null) total.externalMinor = String(BigInt(total.externalMinor) + BigInt(item.amountMinor));
    if (item.currency === 'CNY') {
      total.businessMinor = String(BigInt(total.businessMinor) + BigInt(item.businessMinor));
      if (!item.billId) total.unbackedMinor = String(BigInt(total.unbackedMinor) + BigInt(item.businessMinor));
    }
    if (verified) total.unassignedMinor = String(BigInt(total.unassignedMinor) + BigInt(item.unassignedMinor ?? '0'));
    total.excessMinor = String(BigInt(total.excessMinor) + BigInt(item.excessMinor));
    if (!verified) total.unknownCount++;
  }
  return summary;
}

export async function getPaymentReconciliation(db: Kysely<Database>, query: PaymentReconciliationQuery): Promise<PaymentReconciliationResponse> {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('VALIDATION_ERROR', '每页数量必须在 1 至 100 之间');
  return db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const property = await trx.selectFrom('properties').select(['id', sql<Date>`transaction_timestamp()`.as('asOf')]).where('id', '=', query.propertyId).executeTakeFirst();
    if (!property) throw new DomainError('NOT_FOUND', '门店不存在', 404);
    const sync = (await sql<{ enabled: boolean; lastSyncedAt: Date | null; hasError: boolean; matchingSince: Date | null }>`SELECT
      COALESCE(bool_or(s.enabled),false) enabled,
      CASE WHEN count(*) FILTER(WHERE s.enabled AND s.last_success_at IS NULL)>0 THEN NULL ELSE min(s.last_success_at) FILTER(WHERE s.enabled) END AS "lastSyncedAt",
      COALESCE(bool_or(s.enabled AND s.last_error_code IS NOT NULL),false) AS "hasError",min(s.matching_since) AS "matchingSince"
      FROM external_payment_sources s WHERE EXISTS(SELECT 1 FROM external_payment_accounts a WHERE a.source_id=s.id AND a.property_id=${query.propertyId})`.execute(trx)).rows[0]!;
    const bills = (await sql<ReconciliationBill>`SELECT b.id,b.source_id AS "sourceId",b.merchant_id AS "merchantId",b.kind,b.reference,
      b.transaction_id AS "originalReference",b.amount_minor AS "amountMinor",b.state,b.needs_review AS "needsReview",c.nickname,
      b.occurred_at::text AS "occurredAt",b.discovered_at::text AS "discoveredAt",(b.occurred_at>=s.matching_since) AS "matchingEligible"
      FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
      LEFT JOIN external_payment_contacts c ON c.source_id=b.source_id AND c.external_user_id=b.external_user_id
      WHERE b.property_id=${query.propertyId}`.execute(trx)).rows;
    const facts = (await sql<ReconciliationFact>`SELECT f.fact_id AS id,'STAY'::text AS family,f.fact_type AS kind,f.amount_minor AS "amountMinor",f.currency,
      CASE WHEN f.fact_type='REFUND' THEN f.refund_reference ELSE f.transaction_reference END AS reference,
      original.transaction_reference AS "originalReference",COALESCE(original.external_payment_bill_id,
        (SELECT a.bill_id FROM external_payment_allocations a WHERE a.collection_fact_id=original.fact_id),
        (SELECT m.bill_id FROM external_payment_matches m WHERE m.collection_fact_id=original.fact_id)) AS "originalBillId",
      f.external_payment_bill_id AS "explicitBillId",f.order_id AS "orderId",NULL::text AS "membershipOrderId",NULL::text AS "predecessorId",f.created_at::text AS "createdAt",
      NOT EXISTS(SELECT 1 FROM collection_facts r WHERE r.reverses_fact_id=f.fact_id
        AND NOT EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.property_id=o.property_id
          AND t.source_collection_fact_id=f.fact_id AND t.source_reversal_fact_id=r.fact_id)) AS effective
      FROM collection_facts f JOIN orders o ON o.id=f.order_id LEFT JOIN collection_facts original ON original.fact_id=f.references_fact_id
      WHERE o.property_id=${query.propertyId} AND f.method='WECOM' AND f.fact_type IN ('COLLECTION','REFUND')
      UNION ALL
      SELECT f.fact_id,'MEMBER','COLLECTION',f.amount_minor,f.currency,f.transaction_reference,NULL::text,NULL::text,NULL::text,NULL::text,
        f.membership_order_id,COALESCE(f.corrects_fact_id,(SELECT r.old_payment_fact_id FROM membership_payment_reclassifications r
          WHERE r.property_id=o.property_id AND r.new_payment_fact_id=f.fact_id)),f.created_at::text,
        NOT EXISTS(SELECT 1 FROM membership_payment_facts r WHERE r.reverses_fact_id=f.fact_id)
      FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id
      WHERE o.property_id=${query.propertyId} AND f.fact_type='COLLECTION' AND f.source_type='DIRECT_WECOM'`.execute(trx)).rows;
    const claims = (await sql<ReconciliationClaim>`SELECT a.bill_id AS "billId",a.collection_fact_id AS "factId",'STAY'::text AS family,
      a.amount_minor AS "amountMinor",EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id) AS released,true AS allocation
      FROM external_payment_allocations a JOIN external_payment_bills b ON b.id=a.bill_id WHERE b.property_id=${query.propertyId}
      UNION ALL
      SELECT m.bill_id,COALESCE(m.collection_fact_id,m.membership_payment_fact_id),CASE WHEN m.collection_fact_id IS NOT NULL THEN 'STAY' ELSE 'MEMBER' END,
        COALESCE(f.amount_minor,mf.amount_minor),false,false
      FROM external_payment_matches m JOIN external_payment_bills b ON b.id=m.bill_id
      LEFT JOIN collection_facts f ON f.fact_id=m.collection_fact_id LEFT JOIN membership_payment_facts mf ON mf.fact_id=m.membership_payment_fact_id
      WHERE b.property_id=${query.propertyId}`.execute(trx)).rows;
    // Normalize timestamps before comparisons; SQL text may use offsets or spaces.
    bills.forEach(bill => { bill.occurredAt = new Date(bill.occurredAt).toISOString(); bill.discoveredAt = new Date(bill.discoveredAt).toISOString(); });
    facts.forEach(fact => { fact.createdAt = new Date(fact.createdAt).toISOString(); });
    const all = projectPaymentReconciliation({ bills, facts, claims, matchingSince: sync.matchingSince?.toISOString() ?? null })
      .filter(item => (!query.kind || query.kind === 'ALL' || item.kind === query.kind) && (!query.orderId || item.orderIds.includes(query.orderId)));
    const open = query.status === 'ALL' ? all : all.filter(item => item.issues.length > 0);
    const remaining = query.afterId ? open.filter(item => item.id > query.afterId!) : open;
    const items = remaining.slice(0, limit);
    return { propertyId: query.propertyId, asOf: property.asOf.toISOString(),
      sync: { enabled: sync.enabled, lastSyncedAt: sync.lastSyncedAt?.toISOString() ?? null, hasError: sync.hasError },
      summary: summarizePaymentReconciliation(all), totalItems: open.length, items,
      nextCursor: remaining.length > limit ? items.at(-1)!.id : null };
  });
}
