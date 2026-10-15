import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError } from "@qintopia/contracts";
import { newId, parseLocalDate, stableHash } from "@qintopia/domain";
import { propertyLocalToday } from "./members.ts";
import type { Database } from "./schema.ts";

type Db = Kysely<Database> | Transaction<Database>;
export interface ChannelOperatingFact { id:string; kind:"SALE"|"CORRECTION"|"REFUND"|"REVERSAL"; amountMinor:number; businessDate:string; referencesFactId:string|null; refundReference:string|null; note:string; createdAt:string }
export interface ChannelOperatingSummary { initialized:boolean; businessDate:string; currency:string; originalSaleFactId:string|null; netMinor:string; openingRefundMinor:string; facts:ChannelOperatingFact[] }
export const externalChannel = (channel:unknown) => channel==="YOUMUDAO"||channel==="CTRIP"||channel==="MEITUAN";

export async function channelOperatingSummary(db:Db,propertyId:string,orderId:string):Promise<ChannelOperatingSummary|null> {
 const order=(await sql<{currency:string;channel:string}>`SELECT p.currency,o.booking_channel_code AS channel FROM orders o JOIN properties p ON p.id=o.property_id WHERE o.id=${orderId} AND o.property_id=${propertyId}`.execute(db)).rows[0];
 if(!order || !externalChannel(order.channel))return null;
 const rows=(await sql<{id:string;kind:ChannelOperatingFact['kind'];amount_minor:number;business_date:string;references_fact_id:string|null;refund_reference:string|null;note:string;created_at:Date}>`SELECT id,kind,amount_minor,business_date::text,references_fact_id,refund_reference,note,created_at FROM channel_operating_facts WHERE property_id=${propertyId} AND order_id=${orderId} ORDER BY created_at,id`.execute(db)).rows;
 const opening=(await sql<{amount:string}>`SELECT amount_minor::text AS amount FROM operating_sales_opening WHERE property_id=${propertyId} AND source_kind='CHANNEL_REFUND' AND source_id=${orderId}`.execute(db)).rows[0]?.amount??"0";
 const initialized=(await sql`SELECT 1 FROM operating_sales_baselines WHERE property_id=${propertyId} LIMIT 1`.execute(db)).rows.length>0;
 return {initialized,businessDate:await propertyLocalToday(db,propertyId),currency:order.currency,originalSaleFactId:rows.find(row=>row.kind==='SALE')?.id??null,netMinor:String(rows.reduce((n,row)=>n+BigInt(row.amount_minor),0n)-BigInt(opening)),openingRefundMinor:opening,
   facts:rows.map(row=>({id:row.id,kind:row.kind,amountMinor:row.amount_minor,businessDate:row.business_date,referencesFactId:row.references_fact_id,refundReference:row.refund_reference,note:row.note,createdAt:new Date(row.created_at).toISOString()}))};
}

/** 与计价修订在同一事务中执行。取消/未到不伪装成平台退款。 */
export async function recordChannelRevision(trx:Transaction<Database>,revisionId:string) {
 const row=(await sql<{order_id:string;property_id:string;currency:string;target:number;prior:number;revision_no:number;type:string;command_id:string|null;created_at:Date;date:string;channel:string;stay_type:string;member_id:string|null;member_contract_id:string|null}>`
 SELECT p.order_id,o.property_id,p.currency,p.current_contract_amount_minor AS target,p.revision_no,a.amendment_type AS type,a.command_id,p.created_at,
   COALESCE((SELECT prev.current_contract_amount_minor FROM pricing_revisions prev WHERE prev.order_id=p.order_id AND prev.revision_no<p.revision_no ORDER BY prev.revision_no DESC LIMIT 1),0) AS prior,
   to_char(p.created_at AT TIME ZONE prop.timezone,'YYYY-MM-DD') AS date,o.booking_channel_code AS channel,o.stay_type,o.member_id,o.member_contract_id
 FROM pricing_revisions p JOIN orders o ON o.id=p.order_id JOIN amendments a ON a.id=p.amendment_id JOIN properties prop ON prop.id=o.property_id WHERE p.id=${revisionId}`.execute(trx)).rows[0];
 if(!row || !externalChannel(row.channel)||row.stay_type==='FREE'||row.member_id||row.member_contract_id)return;
 const summary=await channelOperatingSummary(trx,row.property_id,row.order_id);
 const correction=row.type==='REPRICE_ORDER';
 const sale=row.revision_no===1||['RESCHEDULE_STAY','EXTEND_STAY','SHORTEN_STAY','MOVE_UNIT'].includes(row.type);
 const delta=correction?row.target-row.prior:sale?Math.max(0,row.target-Number(summary!.netMinor)):0;
 if(!delta)return;
 if(BigInt(summary!.netMinor)+BigInt(delta)<0n)throw new DomainError('VALIDATION_ERROR','更正后的渠道成交不能低于已登记退款，请先核对退款记录');
 const date=correction?summary!.facts.find(f=>f.kind==='SALE')?.businessDate??row.date:row.date;
 await sql`INSERT INTO channel_operating_facts(id,property_id,order_id,kind,amount_minor,currency,business_date,pricing_revision_id,command_id,note)
 VALUES(${newId('channel_fact')},${row.property_id},${row.order_id},${correction?'CORRECTION':'SALE'},${delta},${row.currency},${date}::date,${revisionId},${row.command_id},${correction?'更正原渠道成交金额，保留原事实':'渠道成交应结金额登记'})`.execute(trx);
}

function text(input:Record<string,unknown>,key:string):string {const value=input[key];if(typeof value!=='string'||!value.trim()||value.trim().length>1000)throw new DomainError('VALIDATION_ERROR',`${key}必填且不能过长`);return value.trim()}
export async function buildChannelFundsEffect(db:Db,propertyId:string,orderId:string,command:'RECORD_REFUND'|'REVERSE_FACT',input:Record<string,unknown>) {
 const summary=await channelOperatingSummary(db,propertyId,orderId);
 if(!summary)throw new DomainError('VALIDATION_ERROR','只有外部渠道订单支持渠道退款登记');
 if(!summary.initialized)throw new DomainError('VALIDATION_ERROR','历史已计收入尚未承接，渠道退款登记暂未开放');
 const today=await propertyLocalToday(db,propertyId);
 const contract=(await sql<{amount:number}>`SELECT p.current_contract_amount_minor AS amount FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.id=${orderId} AND o.property_id=${propertyId}`.execute(db)).rows[0]!.amount;
 const note=text(input,'note');
 if(command==='REVERSE_FACT') {
   const original=summary.facts.find(f=>f.id===input.reversesFactId&&f.kind==='REFUND');
   if(!original)throw new DomainError('NOT_FOUND','渠道退款记录不存在',404);
   if(summary.facts.some(f=>f.kind==='REVERSAL'&&f.referencesFactId===original.id))throw new DomainError('FACT_ALREADY_REVERSED','此渠道退款已经撤销误录',409);
   if(summary.facts.some(f=>['SALE','CORRECTION'].includes(f.kind)&&f.createdAt>original.createdAt))throw new DomainError('AGGREGATE_VERSION_CONFLICT','此退款之后已有渠道成交或金额更正，请先核对后续记录再处理误录',409);
   const originalContract=(await sql<{delta:number;command_id:string}>`SELECT contract_effect_minor AS delta,command_id FROM channel_operating_facts WHERE id=${original.id}`.execute(db)).rows[0]!;
   const laterPricing=(await sql`SELECT p.id FROM pricing_revisions p JOIN amendments a ON a.id=p.amendment_id WHERE p.order_id=${orderId} AND p.created_at>${original.createdAt}::timestamptz AND a.amendment_type NOT IN ('RECORD_REFUND','REVERSE_FACT') LIMIT 1`.execute(db)).rows[0];
   if(laterPricing)throw new DomainError('AGGREGATE_VERSION_CONFLICT','此退款之后已有新的渠道定价，请先核对后续金额记录',409);
   const contractTarget=contract-originalContract.delta;
   if(contractTarget>2147483600)throw new DomainError('VALIDATION_ERROR','恢复后的渠道应结金额超出范围');
   if(input.releaseExternalPaymentAllocation)throw new DomainError('VALIDATION_ERROR','渠道退款不释放企业微信流水');
   return {effect:{orderId,channelOperating:true,reversesFactId:original.id,amountMinor:-original.amountMinor,netEffectMinor:-original.amountMinor,currency:summary.currency,note,businessDate:original.businessDate,contractBeforeMinor:contract,contractTargetMinor:contractTarget},basis:{channelFactsHash:stableHash(summary)}};
 }
 if(input.method!=='CHANNEL'||input.externalPaymentBillId||input.transactionReference)throw new DomainError('VALIDATION_ERROR','渠道退款必须使用平台退款凭据，不能套用企微流水');
 const amount=input.amountMinor;
 if(!Number.isSafeInteger(amount)||(amount as number)<=0||(amount as number)>2147483600||BigInt(amount as number)>BigInt(summary.netMinor))throw new DomainError('VALIDATION_ERROR','渠道退款金额必须大于0且不超过尚未退款的已确认成交金额');
 if(input.referencesFactId!==summary.originalSaleFactId)throw new DomainError('VALIDATION_ERROR','渠道退款必须关联本订单的原成交记录');
 const refundReference=text(input,'refundReference');
 const duplicate=(await sql`SELECT f.id FROM channel_operating_facts f JOIN orders existing ON existing.id=f.order_id JOIN orders target ON target.id=${orderId}
 WHERE f.property_id=${propertyId} AND f.kind='REFUND' AND f.refund_reference=${refundReference} AND existing.booking_channel_code=target.booking_channel_code
 AND NOT EXISTS(SELECT 1 FROM channel_operating_facts reversed WHERE reversed.references_fact_id=f.id AND reversed.kind='REVERSAL') LIMIT 1`.execute(db)).rows[0];
 if(duplicate)throw new DomainError('AGGREGATE_VERSION_CONFLICT','该平台退款单号已经登记',409);
 const date=input.businessDate===undefined?today:text(input,'businessDate');parseLocalDate(date);
 const saleDate=summary.facts.find(f=>f.id===summary.originalSaleFactId)?.businessDate;
 if(date>today||!saleDate||date<saleDate)throw new DomainError('VALIDATION_ERROR','退款业务日期不得晚于今天或早于原成交');
 const closed=(await sql`SELECT month FROM operating_sales_baselines WHERE property_id=${propertyId} AND month=date_trunc('month',${date}::date)::date`.execute(db)).rows[0];
 if(closed)throw new DomainError('VALIDATION_ERROR','该月已经按确认基准封账；历史退款应通过期初承接处理，不能重复登记');
 return {effect:{orderId,channelOperating:true,amountMinor:amount as number,currency:summary.currency,referencesFactId:summary.originalSaleFactId!,method:'CHANNEL',transactionReference:null,refundReference,note,businessDate:date,contractBeforeMinor:contract,contractTargetMinor:Math.min(contract,Number(summary.netMinor)-(amount as number))},basis:{channelFactsHash:stableHash(summary),businessDate:today}};
}

export async function applyChannelFunds(trx:Transaction<Database>,command:'RECORD_REFUND'|'REVERSE_FACT',commandId:string,propertyId:string,effect:Record<string,unknown>) {
 const id=newId('channel_fact');const amount=Number(effect.amountMinor);const reversal=command==='REVERSE_FACT';
 await sql`INSERT INTO channel_operating_facts(id,property_id,order_id,kind,amount_minor,currency,business_date,references_fact_id,refund_reference,command_id,note,contract_effect_minor)
 VALUES(${id},${propertyId},${String(effect.orderId)},${reversal?'REVERSAL':'REFUND'},${reversal?amount:-amount},${String(effect.currency)},${String(effect.businessDate)}::date,
 ${String(reversal?effect.reversesFactId:effect.referencesFactId)},${reversal?null:String(effect.refundReference)},${commandId},${String(effect.note)},${Number(effect.contractTargetMinor)-Number(effect.contractBeforeMinor)})`.execute(trx);
 return {persistedResult:{orderId:String(effect.orderId),factId:id,factType:reversal?'REVERSAL':'REFUND',netEffectMinor:reversal?amount:-amount,transactionReference:null,...(!reversal?{refundReference:String(effect.refundReference)}:{})},resourceRefs:[String(effect.orderId),id],factRefs:[id]};
}
