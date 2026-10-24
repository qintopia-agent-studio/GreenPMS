import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { AuthPrincipal, CommandEnvelope } from '@qintopia/contracts';
import { createCommandPreview, confirmCommandPreview, createDatabase, listOrders, withPropertyClockForTesting, type Database } from '@qintopia/db';
import { getWorkbenchExceptions } from '../../packages/db/src/workbench-exceptions.ts';
import { createQuoteForTesting } from '../../packages/db/src/pricing-service.ts';
import { demo } from '../../packages/db/src/seed.ts';
import { syncWecomSource, type PaymentClient } from '../../packages/db/src/wecom-sync.ts';
import type { WecomBill } from '../../packages/db/src/wecom-client.ts';
import { listPaymentAllocations } from '../../packages/db/src/payment-allocation.ts';
import { channelOperatingSummary } from '../../packages/db/src/channel-operating.ts';
import { resetDatabase, testDatabaseUrl } from '../helpers/database.ts';
import { runtimeDatabaseUrlForTesting } from '../helpers/runtime-database.ts';
import { authScope } from '../helpers/auth-principals.ts';

// This suite only resets its own explicit synthetic database, never the shared test database.
const url = new URL(testDatabaseUrl);
url.pathname = '/qintopia_workbench_exceptions_test';
const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL ?? url.toString();
if (!new URL(databaseUrl).pathname.endsWith('_workbench_exceptions_test')) throw new Error('Workbench suite requires its dedicated synthetic database');
let db: Kysely<Database>, runtime: Kysely<Database>;
let sequence = 0, day = 0;
const now = new Date('2026-10-24T02:00:00Z');
const principal: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: 'token_demo_admin_write', credentialType: 'TOKEN', displayName: '工作台合成验收', ...authScope({ profile: 'administrator' }) };
const meta = () => ({ idempotencyKey: `workbench-${++sequence}`, correlationId: `workbench-${sequence}` });
async function execute(command: CommandEnvelope) {
  const preview = await createCommandPreview(runtime, principal, command, meta());
  const receipt = await confirmCommandPreview(runtime, principal, preview.preview.previewId, {
    propertyId: demo.propertyId, commandType: command.commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash,
    reason: command.commandType === 'CREATE_ORDER' ? { code: 'CREATE_STANDARD_ORDER', note: '' } : { code: 'WORKBENCH_TEST', note: '独立合成库工作台核查' }
  }, meta());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}
async function order(amount = 60000, channel: 'WECOM' | 'MEITUAN' = 'WECOM', free = false) {
  const d = ++day;
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId,
    stayType: free ? 'FREE' : 'TRANSIENT', arrivalDate: `2028-12-${String(d).padStart(2, '0')}`, departureDate: `2028-12-${String(d + 1).padStart(2, '0')}`,
    pricingPolicyVersionId: free ? demo.freePolicyId : demo.transientPolicyId });
  const input = { propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: '合成工作台住客', nickname: `合成 ${d}` }, ...(free ? {} : { bookingChannelCode: channel }),
    ...(free ? { freeStayReason: '合成免费住宿', freeStayCategoryCode: 'VOLUNTEER' } : { targetCurrentContractAmountMinor: amount, ...(channel === 'WECOM' ? { manualPriceAdjustmentReason: '合成协议价' } : {}) }),
    ...(channel === 'MEITUAN' ? { channelOrderReference: `WORKBENCH-CHANNEL-${d}`, channelPriceDifferenceReason: '合成渠道应结价' } : {}) };
  return (await execute({ commandType: 'CREATE_ORDER', input })).result!.orderId as string;
}
const cancel = (orderId: string) => execute({ commandType: 'CANCEL_ORDER', input: { propertyId: demo.propertyId, orderId } });
async function sync(rows: WecomBill[]) {
  const client: PaymentClient = { bills: async (begin, end) => ({ bills: rows.filter(row => row.occurredAt >= begin && row.occurredAt <= end), nextCursor: null }), nickname: async () => '合成付款人' };
  await syncWecomSource(db, 'workbench-source', client, now);
}
const bill = (reference: string, amountMinor: number, overrides: Partial<WecomBill> = {}): WecomBill => ({ kind: 'COLLECTION', merchantId: 'workbench-merchant', reference, originalTradeNo: `trade-${reference}`, transactionId: reference, externalUserId: 'synthetic-customer', collectorId: 'synthetic-staff', amountMinor, occurredAt: new Date(now.getTime() - 60_000), state: 'SUCCESS', ...overrides });
async function collect(orderId: string, amountMinor = 60000) {
  const reference = `workbench-collection-${++sequence}`;
  await sync([bill(reference, amountMinor)]);
  const item = (await listPaymentAllocations(runtime, demo.propertyId, { kind: 'COLLECTION', status: 'ALL' })).items.find(item => item.reference === reference)!;
  return execute({ commandType: 'RECORD_COLLECTION', input: { propertyId: demo.propertyId, orderId, externalPaymentBillId: item.id, amountMinor, method: 'WECOM', transactionReference: reference, note: '合成收款' } });
}
const read = () => getWorkbenchExceptions(runtime, { propertyId: demo.propertyId, limit: 100 });
const item = async (id: string) => (await read()).items.find(row => row.orderId === id);

beforeAll(async () => {
  vi.stubEnv('PMS_PAYMENT_ALLOCATION_ENABLED', 'true');
  db = await resetDatabase(databaseUrl);
  runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
    VALUES('workbench-source','synthetic-corp',true,${new Date('2026-09-01T00:00:00Z')},${new Date('2026-09-01T00:00:00Z')},${new Date(now.getTime()-120000)},true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('workbench-source','workbench-merchant',${demo.propertyId})`.execute(db);
});
afterAll(async () => { await runtime?.destroy(); await db?.destroy(); vi.unstubAllEnvs(); });

describe('workbench exceptions property-wide read model', () => {
  it('keeps zero-balance cancellations out and paginates all remaining orders with a stable total', async () => {
    const cancelled = await order(), first = await order(), second = await order(), freeCancelled = await order(0, 'WECOM', true);
    await cancel(cancelled);
    await cancel(freeCancelled);
    const all = await read();
    expect(all.items.map(row => row.orderId)).not.toContain(cancelled);
    expect(all.items.map(row => row.orderId)).not.toContain(freeCancelled);
    for (const workDate of ['2028-12-01', '2028-12-04']) {
      const daily = await withPropertyClockForTesting(new Date(`${workDate}T02:00:00Z`), () => listOrders(runtime, { propertyId: demo.propertyId, workDate }));
      expect(daily.orders.map(row => row.id)).not.toContain(cancelled);
      expect(daily.orders.map(row => row.id)).not.toContain(freeCancelled);
    }
    expect(all.items.filter(row => [first, second].includes(row.orderId)).every(row => row.reasons.some(reason => reason.code === 'BALANCE_DUE'))).toBe(true);
    const pages = [];
    let afterId: string | undefined;
    do {
      const page = await getWorkbenchExceptions(runtime, { propertyId: demo.propertyId, limit: 1, ...(afterId ? { afterId } : {}) });
      expect(page.totalOrders).toBe(all.totalOrders);
      pages.push(...page.items.map(row => row.orderId));
      afterId = page.nextCursor ?? undefined;
    } while (afterId);
    expect(pages).toEqual(all.items.map(row => row.orderId));
    expect(new Set(pages).size).toBe(pages.length);
  });
  it('recomputes cancellation refunds, partial/all retention, use and release without multiplying fact families', async () => {
    const source = await order(), target = await order(40000);
    const collected = await collect(source);
    await cancel(source);
    expect((await item(source))?.reasons).toEqual([expect.objectContaining({ code: 'REFUND_DUE', amount: { currency: 'CNY', minorUnits: 60000 } })]);
    const retain = async (amountMinor: number) => execute({ commandType: 'RETAIN_ORDER_FUNDS', input: { propertyId: demo.propertyId, orderId: source, sourceFactId: collected.factRefs[0]!, amountMinor, ownerName: '合成资金归属人', ownerContact: 'synthetic-reference', confirmationNote: '已核实客户留存意向' } });
    const first = await retain(20000);
    expect((await item(source))?.reasons[0]?.amount?.minorUnits).toBe(40000);
    const second = await retain(40000);
    expect(await item(source)).toBeUndefined();
    await execute({ commandType: 'APPLY_RETAINED_FUNDS', input: { propertyId: demo.propertyId, orderId: target, retainedFundId: second.result!.retainedFundId as string, amountMinor: 40000, authorizationNote: '合成客户授权使用' } });
    expect(await item(source)).toBeUndefined();
    expect(await item(target)).toBeUndefined();
    await execute({ commandType: 'RELEASE_RETAINED_FUNDS', input: { propertyId: demo.propertyId, orderId: source, retainedFundId: first.result!.retainedFundId as string, amountMinor: 20000, note: '合成解除后待退款' } });
    expect((await item(source))?.reasons).toEqual([expect.objectContaining({ code: 'REFUND_DUE', amount: { currency: 'CNY', minorUnits: 20000 } })]);
    const future = await withPropertyClockForTesting(new Date('2029-01-10T02:00:00Z'), read);
    expect(future.businessDate).toBe('2029-01-10');
    expect(future.items.find(row => row.orderId === source)?.reasons[0]?.code).toBe('REFUND_DUE');
  });
  it('reduces a real ordinary cancellation refund from partial refund to full settlement', async () => {
    const source = await order();
    const collected = await collect(source);
    const sourceFactId = collected.factRefs[0]!;
    const sourceFact = await db.selectFrom('collection_facts').select(['transaction_reference']).where('fact_id', '=', sourceFactId).executeTakeFirstOrThrow();
    await cancel(source);
    const originalReference = sourceFact.transaction_reference!;
    const refund = async (amountMinor: number) => {
      const refundReference = `workbench-refund-${++sequence}`;
      await sync([bill(refundReference, amountMinor, { kind: 'REFUND', transactionId: originalReference, originalTradeNo: `trade-${originalReference}` })]);
      const refundBill = (await listPaymentAllocations(runtime, demo.propertyId, { kind: 'REFUND', status: 'ALL', originalCollectionFactId: sourceFactId })).items.find(row => row.reference === refundReference)!;
      expect(refundBill).toBeDefined();
      await execute({ commandType: 'RECORD_REFUND', input: { propertyId: demo.propertyId, orderId: source, referencesFactId: sourceFactId,
        externalPaymentBillId: refundBill.id, amountMinor, method: 'WECOM', refundReference, note: '合成已发生退款' } });
    };
    expect((await item(source))?.reasons[0]?.amount?.minorUnits).toBe(60000);
    await refund(20000);
    expect((await item(source))?.reasons).toEqual([expect.objectContaining({ code: 'REFUND_DUE', amount: { currency: 'CNY', minorUnits: 40000 } })]);
    await refund(40000);
    expect(await item(source)).toBeUndefined();
  });
  it('uses channel refunds and opening balances rather than empty ordinary cash records', async () => {
    const id = await order(27720, 'MEITUAN');
    await cancel(id);
    expect((await item(id))?.reasons.some(reason => reason.code === 'CHANNEL_DATA_REVIEW')).toBe(true);
    await sql`INSERT INTO operating_sales_baselines(property_id,month,amount_minor,currency,recognition_from,evidence_note,evidence_sha256)
      VALUES(${demo.propertyId},'2026-09-01',0,'CNY','2026-10-01','合成期初承接',${'b'.repeat(64)})`.execute(db);
    expect((await item(id))?.reasons).toEqual([expect.objectContaining({ code: 'CHANNEL_REFUND_DUE', amount: { currency: 'CNY', minorUnits: 27720 } })]);
    const channel = (await channelOperatingSummary(runtime, demo.propertyId, id))!;
    await execute({ commandType: 'RECORD_REFUND', input: { propertyId: demo.propertyId, orderId: id, method: 'CHANNEL', referencesFactId: channel.originalSaleFactId!, amountMinor: 17720, refundReference: 'WORKBENCH-SYNTHETIC-CHANNEL-REFUND', note: '合成部分渠道退款' } });
    expect((await item(id))?.reasons[0]?.amount?.minorUnits).toBe(10000);
    await sql`INSERT INTO operating_sales_opening(property_id,source_kind,source_id,amount_minor,currency,evidence_note)
      VALUES(${demo.propertyId},'CHANNEL_REFUND',${id},10000,'CNY','合成已发生退款承接')`.execute(db);
    expect(await item(id)).toBeUndefined();
  });
  it('scopes queries and validates limits without returning another property or hiding failures', async () => {
    const other = 'property_workbench_other';
    await db.insertInto('properties').values({ id: other, code: 'WB-OTHER', name: '合成其他门店', timezone: 'Asia/Shanghai', currency: 'CNY' }).execute();
    expect(await getWorkbenchExceptions(runtime, { propertyId: other })).toMatchObject({ propertyId: other, totalOrders: 0, items: [], nextCursor: null });
    await expect(getWorkbenchExceptions(runtime, { propertyId: 'property_missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getWorkbenchExceptions(runtime, { propertyId: demo.propertyId, limit: 101 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
