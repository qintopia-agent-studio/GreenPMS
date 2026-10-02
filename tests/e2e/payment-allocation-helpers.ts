import { createDatabase } from '../../packages/db/src/database.ts';
import { sql } from 'kysely';
import { syncWecomSource, type PaymentClient } from '../../packages/db/src/wecom-sync.ts';
import type { WecomBill } from '../../packages/db/src/wecom-client.ts';

export const acceptanceDatabaseName = 'qintopia_payment_allocation_acceptance';
export const propertyId = 'prop_qintopia_demo';
export const groups = ['desktop', 'mobile', '人工一', '人工二'] as const;
export type AcceptanceGroup = typeof groups[number];
export function acceptanceDatabaseUrl() {
  const value = process.env.PAYMENT_ALLOCATION_ACCEPTANCE_DATABASE_URL;
  if (!value) throw new Error('必须显式提供 PAYMENT_ALLOCATION_ACCEPTANCE_DATABASE_URL；不会使用 TEST/E2E 默认库');
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || u.port !== '55439' || u.username !== 'qintopia' || u.pathname !== `/${acceptanceDatabaseName}` || u.search || u.hash)
    throw new Error('仅允许 qintopia@127.0.0.1:55439/qintopia_payment_allocation_acceptance，禁止连接选项覆盖目标');
  return value;
}
export const sourceId = (group: AcceptanceGroup) => `synthetic-acceptance-${group}`;
export const paymentReference = (group: AcceptanceGroup) => `SYNTHETIC-合成验收-${group}-1000`;
export const refundReference = (group: AcceptanceGroup) => `SYNTHETIC-合成验收-${group}-退款200`;
export const guestName = (group: AcceptanceGroup, room: string) => `合成验收-${group}-${room}`;

// No HTTP client, credentials or real WeCom endpoints. Uses the actual ingestion pipeline.
export async function syncSyntheticPayment(group: AcceptanceGroup, kind: 'COLLECTION' | 'REFUND') {
  const db = createDatabase(acceptanceDatabaseUrl());
  try {
    const now = new Date();
    if (kind === 'COLLECTION') {
      await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
        VALUES(${sourceId(group)},${`synthetic-acceptance-corp-${group}`},true,${new Date(now.getTime()-3600000)},${new Date(now.getTime()-3600000)},${new Date(now.getTime()-120000)},true)`.execute(db);
      await sql`INSERT INTO external_payment_accounts(source_id,merchant_id,property_id) VALUES(${sourceId(group)},'synthetic-merchant',${propertyId})`.execute(db);
    }
    const row: WecomBill = { kind, merchantId: 'synthetic-merchant', reference: kind === 'COLLECTION' ? paymentReference(group) : refundReference(group), transactionId: paymentReference(group), originalTradeNo: `trade-${group}`, externalUserId: `synthetic-${group}`, collectorId: 'synthetic-staff', amountMinor: kind === 'COLLECTION' ? 100000 : 20000, occurredAt: new Date(now.getTime()-1000), state: 'SUCCESS' };
    const client: PaymentClient = { bills: async () => ({bills:[row], nextCursor:null}), nickname: async () => `合成验收-${group}` };
    await syncWecomSource(db, sourceId(group), client, now);
    const result = await sql<{id:string;reference:string}>`SELECT id,reference FROM external_payment_bills WHERE source_id=${sourceId(group)} AND reference=${row.reference}`.execute(db);
    if (result.rows.length !== 1) throw new Error('模拟流水同步未返回唯一记录');
    return result.rows[0]!;
  } finally { await db.destroy(); }
}
