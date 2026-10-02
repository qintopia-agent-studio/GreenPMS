import { sql, type Kysely, type Transaction } from 'kysely';
import { DomainError, retainedFundsCommandTypes, type CommandType, type RetainedFundItem, type RetainedFundList } from '@qintopia/contracts';
import { newId } from '@qintopia/domain';
import type { Database } from './schema.ts';
import { fundingSource, assertNoUnassignedRefund, paymentAllocationEnabled, requirePaymentAllocationEnabled } from './payment-allocation.ts';

type Db=Kysely<Database>|Transaction<Database>;
type Input=Record<string,unknown>;
export const isRetainedFundsCommand=(command:string)=> (retainedFundsCommandTypes as readonly string[]).includes(command);
const text=(input:Input,key:string,max=2000):string=>{const value=input[key];if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new DomainError('VALIDATION_ERROR',`${key}不能为空或超长`);return value.trim();};
const amount=(input:Input):number=>{const n=input.amountMinor;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<=0||n>2147483647)throw new DomainError('VALIDATION_ERROR','金额必须为有效的正整数分');return n;};
export interface RetainedFundsQuery {query?:string;orderId?:string;status?:'AVAILABLE'|'ALL';limit?:number;beforeId?:string;retainedFundId?:string}
export async function listRetainedFunds(db:Db,propertyId:string,query:RetainedFundsQuery={}):Promise<RetainedFundList>{
  const limit=Math.max(1,Math.min(100,query.limit??50));
  const rows=(await sql<{id:string;property_id:string;source_order_id:string;source_fact_id:string;bill_id:string;owner_name:string;owner_contact:string;confirmation_note:string;amount_minor:number;used_minor:string;refunded_minor:string;released_minor:string;remaining_minor:string;created_at:Date}>`
    WITH items AS(SELECT l.*,
      COALESCE((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id AND kind='USE'),0)::text used_minor,
      COALESCE((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id AND kind='REFUND'),0)::text refunded_minor,
      COALESCE((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id AND kind='RELEASE'),0)::text released_minor,
      (l.amount_minor-COALESCE((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0))::text remaining_minor
      FROM retained_funds l WHERE property_id=${propertyId}
      AND (${query.orderId??null}::text IS NULL OR source_order_id=${query.orderId??null})
      AND (${query.retainedFundId??null}::text IS NULL OR id=${query.retainedFundId??null})
      AND (${query.query?.trim()||null}::text IS NULL OR owner_name ILIKE '%'||${query.query?.trim()||null}||'%' OR owner_contact ILIKE '%'||${query.query?.trim()||null}||'%' OR source_order_id ILIKE '%'||${query.query?.trim()||null}||'%'))
    SELECT * FROM items WHERE (${query.status??'AVAILABLE'}='ALL' OR remaining_minor::bigint>0)
      AND (${query.beforeId??null}::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM retained_funds WHERE id=${query.beforeId??null} AND property_id=${propertyId}))
    ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`.execute(db)).rows;
  const items:RetainedFundItem[]=rows.slice(0,limit).map(r=>({id:r.id,propertyId:r.property_id,sourceOrderId:r.source_order_id,sourceFactId:r.source_fact_id,billId:r.bill_id,
    ownerName:r.owner_name,ownerContact:r.owner_contact,confirmationNote:r.confirmation_note,amountMinor:r.amount_minor,usedMinor:Number(r.used_minor),refundedMinor:Number(r.refunded_minor),releasedMinor:Number(r.released_minor),remainingMinor:Number(r.remaining_minor),createdAt:r.created_at.toISOString()}));
  return {enabled:paymentAllocationEnabled(),items,hasMore:rows.length>limit,nextBeforeId:rows.length>limit?items.at(-1)?.id??null:null};
}
async function eligibleOrder(db:Db,propertyId:string,orderId:string){
  const row=(await sql<{id:string;status:string;version:number;currency:string;current_revision_id:string;current_contract_amount_minor:number;net_minor:string;reserved_minor:string}>`
    SELECT o.id,o.status,o.version,p.currency,o.current_revision_id,p.current_contract_amount_minor,
      COALESCE((SELECT sum(f.net_effect_minor) FROM collection_facts f WHERE f.order_id=o.id),0)::text net_minor,
      COALESCE((SELECT sum(l.amount_minor-COALESCE((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0)) FROM retained_funds l WHERE l.source_order_id=o.id),0)::text reserved_minor
    FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.id=${orderId} AND o.property_id=${propertyId}
      AND o.stay_type<>'FREE' AND (o.booking_channel_code IS NULL OR o.booking_channel_code='WECOM')
      AND o.member_contract_id IS NULL AND p.pricing_basis NOT IN ('CHANNEL_CONTRACT','MEMBER_ENTITLEMENT')
      AND NOT EXISTS(SELECT 1 FROM amendments a WHERE a.order_id=o.id AND a.amendment_type='CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP')`.execute(db)).rows[0];
  if(!row)throw new DomainError('VALIDATION_ERROR','订单不支持客户留存资金操作，请核对物业、渠道与会员状态');
  return row;
}
export async function buildRetainedFundsEffect(db:Db,command:CommandType,input:Input){
  requirePaymentAllocationEnabled();
  const propertyId=text(input,'propertyId'),orderId=text(input,'orderId'),amountMinor=amount(input);
  const order=await eligibleOrder(db,propertyId,orderId);
  if(command==='RETAIN_ORDER_FUNDS'){
    if(!['CANCELLED','NO_SHOW','CHECKED_OUT'].includes(order.status))throw new DomainError('INVALID_ORDER_STATE','仅取消、未到或已退房订单可以登记留存',409);
    const source=await fundingSource(db,propertyId,text(input,'sourceFactId'));
    if(source.order_id!==orderId||!source.bill_id||source.reversed)throw new DomainError('VALIDATION_ERROR','留存必须引用本订单有明确来源的有效收款份额');
    await assertNoUnassignedRefund(db,propertyId,source.bill_id);
    const ownerName=text(input,'ownerName',200),ownerContact=text(input,'ownerContact',200);
    if(source.fact_type==='REALLOCATION_IN'){
      const owner=(await sql<{owner_name:string;owner_contact:string}>`SELECT l.owner_name,l.owner_contact FROM retained_fund_entries e
        JOIN retained_funds l ON l.id=e.retained_fund_id WHERE e.target_in_fact_id=${source.fact_id} AND l.property_id=${propertyId}`.execute(db)).rows[0];
      if(!owner||owner.owner_name!==ownerName||owner.owner_contact!==ownerContact)throw new DomainError('VALIDATION_ERROR','再次留存必须保留原款项归属客户，代订不转移款项所有权');
    }
    const available=Math.min(source.remainingMinor-source.reservedMinor,Number(order.net_minor)-order.current_contract_amount_minor-Number(order.reserved_minor));
    if(amountMinor>available)throw new DomainError('VALIDATION_ERROR','留存金额超过本订单未占用的多余款项');
    return {effect:{operation:command,orderId,sourceOrderId:orderId,sourceFactId:source.fact_id,billId:source.bill_id,amountMinor,currency:source.currency,
      ownerName,ownerContact,confirmationNote:text(input,'confirmationNote'),remainingBefore:available},
      basis:{orderVersion:order.version,orderStatus:order.status,source,orderNet:order.net_minor,orderReserved:order.reserved_minor}};
  }
  const retainedFundId=text(input,'retainedFundId');
  const lot=(await listRetainedFunds(db,propertyId,{retainedFundId,status:'ALL'})).items[0];
  if(!lot)throw new DomainError('NOT_FOUND','客户留存记录不存在',404);
  if(amountMinor>lot.remainingMinor)throw new DomainError('VALIDATION_ERROR','金额超过留存剩余额度');
  const source=await fundingSource(db,propertyId,lot.sourceFactId);
  if(source.reversed||amountMinor>source.remainingMinor)throw new DomainError('AGGREGATE_VERSION_CONFLICT','来源资金已变化，请重新核对',409);
  const effect:Input={operation:command,orderId,sourceOrderId:lot.sourceOrderId,sourceFactId:lot.sourceFactId,billId:lot.billId,retainedFundId,amountMinor,currency:source.currency,
    ownerName:lot.ownerName,ownerContact:lot.ownerContact,remainingBefore:lot.remainingMinor};
  let sourceOrder=order;
  if(command==='APPLY_RETAINED_FUNDS'){
    if(orderId===lot.sourceOrderId||!['RESERVED','CHECKED_IN','CHECKED_OUT'].includes(order.status))throw new DomainError('INVALID_ORDER_STATE','请选择同物业可收款的其他住宿订单',409);
    sourceOrder=await eligibleOrder(db,propertyId,lot.sourceOrderId);
    effect.authorizationNote=text(input,'authorizationNote');
    await assertNoUnassignedRefund(db,propertyId,lot.billId);
  }else{
    if(orderId!==lot.sourceOrderId)throw new DomainError('VALIDATION_ERROR','必须在留存来源订单处理退款或解除');
    effect.note=text(input,'note');
    if(command==='REFUND_RETAINED_FUNDS'){
      effect.method='WECOM';effect.referencesFactId=lot.sourceFactId;effect.transactionReference=null;
      effect.externalPaymentBillId=text(input,'externalPaymentBillId');effect.refundReference=text(input,'refundReference',200);
    }else await assertNoUnassignedRefund(db,propertyId,lot.billId);
  }
  return {effect,basis:{orderVersion:order.version,orderStatus:order.status,sourceOrderVersion:sourceOrder.version,source,retainedFund:lot}};
}
export async function lockPaymentAllocationResources(trx:Transaction<Database>,command:CommandType,input:Input):Promise<void>{
  const moneyCommands=['RECORD_COLLECTION','RECORD_REFUND','REVERSE_FACT','CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP','RECORD_MEMBERSHIP_PAYMENT','CORRECT_MEMBERSHIP_PAYMENT',...retainedFundsCommandTypes];
  if(!moneyCommands.includes(command))return;
  const propertyId=text(input,'propertyId');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-allocation:${propertyId}`},0))`.execute(trx);
  if(!isRetainedFundsCommand(command))return;
  let sourceOrderId:string|null=null,billId:string|null=null;
  if(typeof input.retainedFundId==='string'){
    const lot=(await sql<{source_order_id:string;bill_id:string}>`SELECT source_order_id,bill_id FROM retained_funds WHERE id=${input.retainedFundId} AND property_id=${propertyId}`.execute(trx)).rows[0];
    sourceOrderId=lot?.source_order_id??null;billId=lot?.bill_id??null;
  }else if(typeof input.sourceFactId==='string'){
    const source=await fundingSource(trx,propertyId,input.sourceFactId);sourceOrderId=source.order_id;billId=source.bill_id;
  }
  const orders=[...new Set([text(input,'orderId'),...(sourceOrderId?[sourceOrderId]:[])])].sort();
  await sql`SELECT id FROM orders WHERE property_id=${propertyId} AND id IN (${sql.join(orders)}) ORDER BY id FOR UPDATE`.execute(trx);
  const bills=[...new Set([...(billId?[billId]:[]),...(typeof input.externalPaymentBillId==='string'?[input.externalPaymentBillId]:[])])].sort();
  if(bills.length)await sql`SELECT id FROM external_payment_bills WHERE property_id=${propertyId} AND id IN (${sql.join(bills)}) ORDER BY id FOR UPDATE`.execute(trx);
}
export async function applyRetainedFundsCommand(trx:Transaction<Database>,command:CommandType,effect:Input,commandId:string){
  const orderId=String(effect.orderId),sourceOrderId=String(effect.sourceOrderId),sourceFactId=String(effect.sourceFactId),billId=String(effect.billId),amountMinor=Number(effect.amountMinor);
  if(command==='RETAIN_ORDER_FUNDS'){
    const id=newId('retained');
    await sql`INSERT INTO retained_funds(id,property_id,source_order_id,source_fact_id,bill_id,owner_name,owner_contact,confirmation_note,amount_minor,command_id)
      SELECT ${id},o.property_id,${sourceOrderId},${sourceFactId},${billId},${String(effect.ownerName)},${String(effect.ownerContact)},${String(effect.confirmationNote)},${amountMinor},${commandId} FROM orders o WHERE o.id=${orderId}`.execute(trx);
    return {persistedResult:{operation:command,orderId,retainedFundId:id,amountMinor,remainingMinor:amountMinor},resourceRefs:[orderId,id],factRefs:[]};
  }
  const retainedFundId=String(effect.retainedFundId),entryId=newId('retained_entry');
  let outId:string|null=null,inId:string|null=null,refundId:string|null=null;
  const insertFact=async(id:string,target:string,kind:'REALLOCATION_IN'|'REALLOCATION_OUT'|'REFUND',externalBillId:string,note:string)=>{
    await sql`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,references_fact_id,reverses_fact_id,method,note,transaction_reference,refund_reference,pricing_revision_id,command_id,external_payment_bill_id)
      SELECT ${id},o.id,${kind},${amountMinor},${kind==='REALLOCATION_IN'?amountMinor:-amountMinor},${String(effect.currency)},${sourceFactId},NULL,'WECOM',${note},
        ${null},${kind==='REFUND'?String(effect.refundReference):null},o.current_revision_id,${commandId},${externalBillId} FROM orders o WHERE o.id=${target}`.execute(trx);
  };
  if(command==='APPLY_RETAINED_FUNDS'){
    outId=newId('fact');inId=newId('fact');
    await insertFact(outId,sourceOrderId,'REALLOCATION_OUT',billId,String(effect.authorizationNote));
    await insertFact(inId,orderId,'REALLOCATION_IN',billId,String(effect.authorizationNote));
  }else if(command==='REFUND_RETAINED_FUNDS'){
    refundId=newId('fact');await insertFact(refundId,sourceOrderId,'REFUND',String(effect.externalPaymentBillId),String(effect.note));
  }
  const kind=command==='APPLY_RETAINED_FUNDS'?'USE':command==='REFUND_RETAINED_FUNDS'?'REFUND':'RELEASE';
  await sql`INSERT INTO retained_fund_entries(id,retained_fund_id,kind,amount_minor,target_order_id,source_out_fact_id,target_in_fact_id,refund_fact_id,authorization_note,command_id)
    VALUES(${entryId},${retainedFundId},${kind},${amountMinor},${kind==='USE'?orderId:null},${outId},${inId},${refundId},${String(effect.authorizationNote??effect.note)},${commandId})`.execute(trx);
  return {persistedResult:{operation:command,orderId,retainedFundId,amountMinor,remainingMinor:Number(effect.remainingBefore)-amountMinor,...(refundId?{factId:refundId}:{}),...(inId?{factId:inId}:{})},
    resourceRefs:[orderId,sourceOrderId,retainedFundId],factRefs:[outId,inId,refundId].filter((id):id is string=>id!==null)};
}
