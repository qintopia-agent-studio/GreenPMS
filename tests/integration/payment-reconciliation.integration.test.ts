import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { AuthPrincipal, CommandEnvelope } from '@qintopia/contracts';
import { confirmCommandPreview, createCommandPreview, createDatabase, type Database } from '@qintopia/db';
import { buildServer } from '../../apps/api/src/server.ts';
import { getPaymentReconciliation } from '../../packages/db/src/payment-reconciliation.ts';
import { listExternalPayments } from '../../packages/db/src/external-payments.ts';
import { listPaymentAllocations } from '../../packages/db/src/payment-allocation.ts';
import { createQuoteForTesting } from '../../packages/db/src/pricing-service.ts';
import { demo } from '../../packages/db/src/seed.ts';
import { authScope } from '../helpers/auth-principals.ts';
import { resetDatabase, testDatabaseUrl } from '../helpers/database.ts';
import { runtimeDatabaseUrlForTesting } from '../helpers/runtime-database.ts';

const url = new URL(testDatabaseUrl); url.pathname = '/qintopia_payment_reconciliation';
const principal: AuthPrincipal = { subjectId: demo.agentSubjectId, credentialId: 'token_demo_write', credentialType: 'TOKEN', displayName: '模拟核对', ...authScope() };
let owner: Kysely<Database>, runtime: Kysely<Database>, app: FastifyInstance, orderId: string;
let sequence = 0;
const headers = { authorization: `Bearer ${demo.readToken}` };
const path = `/api/v1/workbench/payment-reconciliation?propertyId=${demo.propertyId}`;
const meta = () => ({ idempotencyKey: `reconciliation-${++sequence}`, correlationId: `reconciliation-${sequence}` });
async function execute(command: CommandEnvelope) {
  const prepared = await createCommandPreview(runtime, principal, command, meta());
  const receipt = await confirmCommandPreview(runtime, principal, prepared.preview.previewId, { propertyId: demo.propertyId,
    commandType: command.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
    reason: { code: command.commandType === 'CREATE_ORDER' ? 'CREATE_STANDARD_ORDER' : 'PAYMENT_RECONCILIATION_TEST',
      note: command.commandType === 'CREATE_ORDER' ? '' : '独立合成核对' } }, meta());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true); return receipt;
}
async function raw(id: string, kind: 'COLLECTION' | 'REFUND', amount: number | null, parent: string | null, options: { merchant?: string; state?: string; occurred?: string } = {}) {
  await sql`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,transaction_id,
    amount_minor,occurred_at,state,discovered_at) VALUES(${id},'reconciliation-source',${options.merchant ?? 'm1'},${demo.propertyId},${kind},${id},
    ${`trade-${parent ?? id}`},${parent ?? id},${amount},${options.occurred ?? '2026-10-01T00:00:00Z'}::timestamptz,${options.state ?? 'SUCCESS'},'2026-10-02T00:00:00Z')`.execute(owner);
}
beforeAll(async () => {
  owner = await resetDatabase(url.toString()); runtime = createDatabase(runtimeDatabaseUrlForTesting(url.toString()));
  // seedDemo intentionally includes one direct WECOM member collection without an external bill.
  // Verify that fixture independently; it is part of this property's unbacked business baseline.
  expect(await owner.selectFrom('membership_payment_facts')
    .select(['fact_id', 'membership_order_id', 'fact_type', 'amount_minor', 'currency', 'transaction_reference', 'source_type'])
    .where('fact_id', '=', demo.membershipPaymentFactId).executeTakeFirst()).toEqual({
      fact_id: demo.membershipPaymentFactId, membership_order_id: demo.membershipOrderId, fact_type: 'COLLECTION',
      amount_minor: 162000, currency: 'CNY', transaction_reference: 'DEMO-WECOM-20260101-001', source_type: 'DIRECT_WECOM'
    });
  const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: 'TRANSIENT',
    arrivalDate: '2028-12-01', departureDate: '2028-12-02', pricingPolicyVersionId: demo.transientPolicyId });
  orderId = String((await execute({ commandType: 'CREATE_ORDER', input: { propertyId: demo.propertyId, quoteId: quote.quoteId,
    primaryGuest: { fullName: '核对模拟', nickname: '样例' }, bookingChannelCode: 'WECOM', targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits } })).result!.orderId);
  const receipt = await execute({ commandType: 'RECORD_COLLECTION', input: { propertyId: demo.propertyId, orderId,
    amountMinor: 12000, method: 'WECOM', transactionReference: 'matched-parent', note: '旧手录来源' } });
  await execute({ commandType: 'RECORD_REFUND', input: { propertyId: demo.propertyId, orderId, amountMinor: 2000, method: 'WECOM',
    referencesFactId: receipt.factRefs[0]!, refundReference: 'matched-refund', note: '旧退款来源' } });
  await execute({ commandType: 'RECORD_COLLECTION', input: { propertyId: demo.propertyId, orderId,
    amountMinor: 5000, method: 'WECOM', transactionReference: 'missing-source', note: '合成无来源对照' } });
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,baseline_complete,last_success_at)
    VALUES('reconciliation-source','synthetic-corp',true,'2026-09-01T00:00:00+08','2026-08-01T00:00:00+08',true,'2026-10-03T00:00:00Z')`.execute(owner);
  for (const merchant of ['m1', 'm2']) await sql`INSERT INTO external_payment_accounts(source_id,merchant_id,property_id)
    VALUES('reconciliation-source',${merchant},${demo.propertyId})`.execute(owner);
  await raw('matched-parent', 'COLLECTION', 12000, null);
  await raw('matched-refund', 'REFUND', 2000, 'matched-parent');
  await sql`SELECT qintopia_link_historical_external_payment('matched-parent')`.execute(owner);
  await sql`SELECT qintopia_link_historical_external_payment('matched-refund')`.execute(owner);
  await raw('unmatched-parent', 'COLLECTION', 10000, null);
  await raw('unmatched-refund', 'REFUND', 10000, 'unmatched-parent');
  await raw('pending-refund', 'REFUND', null, 'unmatched-parent', { state: 'UNKNOWN' });
  await raw('other-merchant-refund', 'REFUND', 1000, 'unmatched-parent', { merchant: 'm2' });
  await raw('historical-parent', 'COLLECTION', 3000, null, { occurred: '2026-08-01T00:00:00Z' });
  await raw('current-refund-old-parent', 'REFUND', 3000, 'historical-parent');
  app = await buildServer(runtime); await app.ready();
});
afterAll(async () => { await app?.close(); await runtime?.destroy(); await owner?.destroy(); });

describe('persistent payment reconciliation read contract', () => {
  it('requires authenticated property READ and validates pagination', async () => {
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/workbench/payment-reconciliation?propertyId=foreign-property', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${path}&limit=0`, headers })).statusCode).toBe(400);
  });
  it('keeps gross differences from old discovered dates and reports unbacked business without mutating anything', async () => {
    const before = await owner.selectFrom('collection_facts').selectAll().orderBy('fact_id').execute();
    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    const result = response.json();
    // 12000 matched lodging + 5000 unbacked lodging + 162000 seeded direct member collection.
    expect(result.summary.collections).toMatchObject({ externalMinor: '22000', businessMinor: '179000', unassignedMinor: '10000', unbackedMinor: '167000' });
    expect(result.items.find((row: { factId: string }) => row.factId === demo.membershipPaymentFactId)).toMatchObject({
      billId: null, membershipOrderId: demo.membershipOrderId, businessMinor: '162000',
      issues: [{ code: 'BUSINESS_WITHOUT_BILL', message: expect.any(String) }]
    });
    expect(result.summary.refunds).toMatchObject({ externalMinor: '16000', businessMinor: '2000', unassignedMinor: '14000', unknownCount: 1 });
    expect(result.items.find((row: { billId: string }) => row.billId === 'unmatched-refund')).toMatchObject({ unassignedMinor: '10000', occurredAt: '2026-10-01T00:00:00.000Z' });
    expect(result.items.some((row: { billId: string }) => row.billId === 'historical-parent')).toBe(false);
    expect(result.items.find((row: { billId: string }) => row.billId === 'current-refund-old-parent').issues).toEqual([{ code: 'UNASSIGNED', message: expect.any(String) }]);
    expect(await owner.selectFrom('collection_facts').selectAll().orderBy('fact_id').execute()).toEqual(before);
  });
  it('returns complete totals and stable unique cursors regardless of page size', async () => {
    const all = await getPaymentReconciliation(runtime, { propertyId: demo.propertyId });
    const ids: string[] = []; let afterId: string | undefined;
    do {
      const page = await getPaymentReconciliation(runtime, { propertyId: demo.propertyId, limit: 2, ...(afterId ? { afterId } : {}) });
      expect(page.totalItems).toBe(all.totalItems); expect(page.summary).toEqual(all.summary);
      ids.push(...page.items.map(row => row.id)); afterId = page.nextCursor ?? undefined;
    } while (afterId);
    expect(ids).toEqual(all.items.map(row => row.id)); expect(new Set(ids).size).toBe(ids.length);
    const order = await getPaymentReconciliation(runtime, { propertyId: demo.propertyId, orderId });
    expect(order.items.every(row => row.orderIds.includes(orderId))).toBe(true);
  });
  it('enriches both selector versions and limits refunds to the exact original source and merchant', async () => {
    for (const read of [listExternalPayments, listPaymentAllocations]) {
      const parent = (await read(runtime, demo.propertyId, { kind: 'COLLECTION', status: 'ALL', billId: 'unmatched-parent' })).items[0]!;
      expect(parent.refundSummary).toEqual({ succeededMinor: 10000, matchedMinor: 0, unassignedMinor: 10000, pendingCount: 0, reviewCount: 1 });
      expect(parent.relatedRefunds?.map(row => row.billId).sort()).toEqual(['pending-refund', 'unmatched-refund']);
      const refunds = await read(runtime, demo.propertyId, { kind: 'REFUND', status: 'ALL', originalCollectionBillId: 'unmatched-parent' });
      expect(refunds.items.map(row => row.id).sort()).toEqual(['pending-refund', 'unmatched-refund']);
      await expect(read(runtime, demo.propertyId, { kind: 'REFUND', originalCollectionBillId: 'missing-parent' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    for (const version of ['v1', 'v2']) {
      const response = await app.inject({ method: 'GET', url: `/api/${version}/external-payments?propertyId=${demo.propertyId}&kind=COLLECTION&status=ALL&billId=matched-parent`, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items[0].refundSummary).toMatchObject({ succeededMinor: 2000, matchedMinor: 2000, unassignedMinor: 0 });
    }
  });
});
