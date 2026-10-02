import { sql, type Kysely, type Transaction } from 'kysely';
import { DomainError, type PaymentAllocationItem, type PaymentAllocationList } from '@qintopia/contracts';
import type { Database } from './schema.ts';
import type { PaymentQuery, ExternalPaymentBasis } from './external-payments.ts';

type Db = Kysely<Database> | Transaction<Database>;
export type PaymentAllocationQuery = Omit<PaymentQuery, 'status'> & { status?: PaymentQuery['status'] | 'PARTIALLY_MATCHED' };
export function paymentAllocationEnabled(): boolean { return process.env.PMS_PAYMENT_ALLOCATION_ENABLED === 'true'; }
export function requirePaymentAllocationEnabled(): void {
  if (!paymentAllocationEnabled()) throw new DomainError('VALIDATION_ERROR', '收款分配与客户留存功能尚未启用');
}
export async function fundingSource(db: Db, propertyId: string, factId: string) {
  const row = (await sql<{ fact_id: string; order_id: string; fact_type: string; amount_minor: number; currency: string; bill_id: string | null; reversed: boolean; refunded_minor: string; transferred_minor: string; reserved_minor: string }>`
    SELECT f.fact_id,f.order_id,f.fact_type,f.amount_minor,f.currency,
      COALESCE(f.external_payment_bill_id,a.bill_id) bill_id,
      EXISTS(SELECT 1 FROM collection_facts r WHERE r.reverses_fact_id=f.fact_id) reversed,
      (SELECT COALESCE(sum(r.amount_minor),0)::text FROM collection_facts r WHERE r.references_fact_id=f.fact_id AND r.fact_type='REFUND'
        AND NOT EXISTS(SELECT 1 FROM collection_facts v WHERE v.reverses_fact_id=r.fact_id)) refunded_minor,
      (SELECT COALESCE(sum(r.amount_minor),0)::text FROM collection_facts r WHERE r.references_fact_id=f.fact_id AND r.fact_type='REALLOCATION_OUT') transferred_minor,
      (SELECT COALESCE(sum(l.amount_minor-(SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id)),0)::text
        FROM retained_funds l WHERE l.source_fact_id=f.fact_id) reserved_minor
    FROM collection_facts f JOIN orders o ON o.id=f.order_id
    LEFT JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id
    WHERE f.fact_id=${factId} AND o.property_id=${propertyId}`.execute(db)).rows[0];
  if (!row || !['COLLECTION','REALLOCATION_IN'].includes(row.fact_type)) throw new DomainError('NOT_FOUND','原收款份额不存在',404);
  return { ...row, refundedMinor: Number(row.refunded_minor), transferredMinor: Number(row.transferred_minor), reservedMinor: Number(row.reserved_minor),
    remainingMinor: row.reversed ? 0 : row.amount_minor-Number(row.refunded_minor)-Number(row.transferred_minor) };
}
export async function assertNoUnassignedRefund(db: Db, propertyId: string, billId: string): Promise<void> {
  const pending = (await sql<{ pending: boolean }>`SELECT EXISTS(
    SELECT 1 FROM external_payment_bills r JOIN external_payment_bills b ON b.id=${billId}
    WHERE b.property_id=${propertyId} AND r.property_id=b.property_id AND r.source_id=b.source_id AND r.merchant_id=b.merchant_id
      AND r.kind='REFUND' AND r.transaction_id=b.reference AND r.state='SUCCESS'
      AND (r.amount_minor IS NULL OR r.needs_review OR r.amount_minor > COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a
        WHERE a.bill_id=r.id AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)),0))
    ) pending`.execute(db)).rows[0]?.pending;
  if (pending) throw new DomainError('AGGREGATE_VERSION_CONFLICT','原收款存在尚未完成归属的退款，请先核对退款',409);
}
export async function listPaymentAllocations(db: Db, propertyId: string, query: PaymentAllocationQuery): Promise<PaymentAllocationList> {
  const source = (await sql<{enabled:boolean;last_synced_at:Date|null;has_error:boolean}>`SELECT bool_or(s.enabled) enabled,min(s.last_success_at) last_synced_at,
    bool_or(s.last_error_code IS NOT NULL) has_error FROM external_payment_sources s JOIN external_payment_accounts a ON a.source_id=s.id WHERE a.property_id=${propertyId}`.execute(db)).rows[0];
  const base = {enabled:paymentAllocationEnabled() && source?.enabled===true,lastSyncedAt:source?.last_synced_at?.toISOString()??null,synchronizationError:source?.has_error===true};
  if (source?.enabled !== true) return {...base,items:[],hasMore:false,nextBeforeId:null};
  let originalBillId: string|null=null;
  if(query.originalCollectionFactId) originalBillId=(await fundingSource(db,propertyId,query.originalCollectionFactId)).bill_id;
  const status=query.recommended?'AVAILABLE':query.status??'AVAILABLE';
  const limit=query.recommended?5:Math.max(1,Math.min(100,query.limit??50));
  const rows=(await sql<{id:string;kind:'COLLECTION'|'REFUND';reference:string;transaction_id:string|null;amount_minor:number|null;occurred_at:Date;nickname:string|null;allocated_minor:string;remaining_minor:string;status:PaymentAllocationItem['status'];membership_order_id:string|null}>`
    WITH balances AS (
      SELECT b.*,c.nickname,mf.membership_order_id,
        COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a WHERE a.bill_id=b.id
          AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)),0) allocated_minor,
        s.matching_since
      FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
      LEFT JOIN external_payment_contacts c ON c.source_id=b.source_id AND c.external_user_id=b.external_user_id
      LEFT JOIN external_payment_matches m ON m.bill_id=b.id
      LEFT JOIN membership_payment_facts mf ON mf.fact_id=m.membership_payment_fact_id
      WHERE b.property_id=${propertyId} AND s.enabled AND b.kind=${query.kind}
        AND (${query.billId??null}::text IS NULL OR b.id=${query.billId??null})
        AND (${query.begin??null}::timestamptz IS NULL OR b.occurred_at>=${query.begin??null})
        AND (${query.end??null}::timestamptz IS NULL OR b.occurred_at<${query.end??null})
        AND (${query.query?.trim()||null}::text IS NULL OR c.nickname ILIKE '%'||${query.query?.trim()||null}||'%' OR b.reference ILIKE '%'||${query.query?.trim()||null}||'%')
        AND (${originalBillId}::text IS NULL OR EXISTS(SELECT 1 FROM external_payment_bills parent WHERE parent.id=${originalBillId}
          AND parent.source_id=b.source_id AND parent.merchant_id=b.merchant_id AND parent.reference=b.transaction_id))
    ), candidates AS (
      SELECT *,GREATEST(0,COALESCE(amount_minor,0)-allocated_minor-CASE WHEN membership_order_id IS NOT NULL THEN COALESCE(amount_minor,0) ELSE 0 END)::text remaining_minor,
        CASE WHEN needs_review OR EXISTS(SELECT 1 FROM external_payment_bills d WHERE d.property_id=balances.property_id AND d.kind=balances.kind AND d.reference=balances.reference AND d.id<>balances.id) THEN 'REVIEW'
          WHEN membership_order_id IS NOT NULL THEN 'MATCHED'
          WHEN allocated_minor>=amount_minor THEN 'MATCHED'
          WHEN occurred_at<matching_since THEN 'HISTORICAL' WHEN state='PENDING' THEN 'PENDING'
          WHEN state<>'SUCCESS' OR amount_minor IS NULL THEN 'UNVERIFIED'
          WHEN allocated_minor>0 THEN 'PARTIALLY_MATCHED' ELSE 'AVAILABLE' END status
      FROM balances
    ) SELECT * FROM candidates
      WHERE (${status}='ALL' OR (${status}='AVAILABLE' AND status IN ('AVAILABLE','PARTIALLY_MATCHED')) OR status=${status})
        AND (${query.amountMinor??null}::integer IS NULL OR ${Boolean(query.recommended)} OR amount_minor=${query.amountMinor??null})
        AND (${query.beforeId??null}::text IS NULL OR (occurred_at,id)<(SELECT occurred_at,id FROM external_payment_bills WHERE id=${query.beforeId??null} AND property_id=${propertyId}))
      ORDER BY CASE WHEN ${Boolean(query.recommended)} AND remaining_minor::bigint>=${query.amountMinor??0} THEN 0 ELSE 1 END,occurred_at DESC,id DESC LIMIT ${limit+1}`.execute(db)).rows;
  const items:PaymentAllocationItem[]=[];
  for(const row of rows.slice(0,limit)) {
    const allocations=(await sql<{id:string;order_id:string;fact_id:string;amount_minor:number;released:boolean;created_at:Date}>`SELECT a.id,f.order_id,f.fact_id,a.amount_minor,
      EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id) released,a.created_at
      FROM external_payment_allocations a JOIN collection_facts f ON f.fact_id=a.collection_fact_id WHERE a.bill_id=${row.id} ORDER BY a.created_at,a.id`.execute(db)).rows;
    items.push({id:row.id,kind:row.kind,reference:row.reference,originalTransactionReference:row.transaction_id,amountMinor:row.amount_minor,
      occurredAt:row.occurred_at.toISOString(),nickname:row.nickname,status:row.status,orderId:allocations.length===1?allocations[0]!.order_id:null,
      membershipOrderId:row.membership_order_id,recommendationReasons:query.recommended?['可分配余额']:[],allocatedMinor:Number(row.allocated_minor),remainingMinor:Number(row.remaining_minor),
      allocations:allocations.map(a=>({id:a.id,orderId:a.order_id,factId:a.fact_id,amountMinor:a.amount_minor,released:a.released,createdAt:a.created_at.toISOString()}))});
  }
  return {...base,items,hasMore:rows.length>limit,nextBeforeId:rows.length>limit?items.at(-1)?.id??null:null};
}
export async function allocationPaymentBasis(db:Db,propertyId:string,effect:Record<string,unknown>,kind:'COLLECTION'|'REFUND',lock:boolean):Promise<ExternalPaymentBasis[]> {
  requirePaymentAllocationEnabled();
  const billId=String(effect.externalPaymentBillId);
  if(lock) await sql`SELECT id FROM external_payment_bills WHERE id=${billId} AND property_id=${propertyId} FOR UPDATE`.execute(db);
  const item=(await listPaymentAllocations(db,propertyId,{kind,status:'ALL',billId})).items[0];
  if(!item) throw new DomainError('NOT_FOUND','所选收退款流水不存在',404);
  if(!['AVAILABLE','PARTIALLY_MATCHED'].includes(item.status) || item.membershipOrderId) throw new DomainError('AGGREGATE_VERSION_CONFLICT','流水不可分配，请重新核对',409);
  if(!Number.isSafeInteger(effect.amountMinor) || Number(effect.amountMinor)<=0 || Number(effect.amountMinor)>item.remainingMinor) throw new DomainError('VALIDATION_ERROR','本次金额超过流水剩余可分配额度');
  if(effect.method!=='WECOM') throw new DomainError('VALIDATION_ERROR','只有企业微信流水支持分配');
  if(kind==='COLLECTION') {
    if(effect.transactionReference!==item.reference) throw new DomainError('VALIDATION_ERROR','收款编号与所选流水不一致');
    await assertNoUnassignedRefund(db,propertyId,billId);
  } else {
    if(effect.refundReference!==item.reference) throw new DomainError('VALIDATION_ERROR','退款编号与所选流水不一致');
    const source=await fundingSource(db,propertyId,String(effect.referencesFactId));
    if(source.order_id!==effect.orderId || !source.bill_id) throw new DomainError('VALIDATION_ERROR','退款必须引用本订单有来源的收款份额');
    const matches=(await sql<{valid:boolean}>`SELECT EXISTS(SELECT 1 FROM external_payment_bills parent JOIN external_payment_bills r
      ON r.id=${billId} AND r.property_id=parent.property_id AND r.source_id=parent.source_id AND r.merchant_id=parent.merchant_id AND r.transaction_id=parent.reference
      WHERE parent.id=${source.bill_id}) valid`.execute(db)).rows[0]?.valid;
    if(!matches) throw new DomainError('VALIDATION_ERROR','退款流水与原收款不对应');
  }
  return [{billId,kind,reference:item.reference,amountMinor:Number(effect.amountMinor),alreadyMatched:false,allocation:true,allocatedMinor:item.allocatedMinor}];
}
