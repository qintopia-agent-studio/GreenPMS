import { sql, type Transaction } from "kysely";
import { aggregateOperatingSales, classifyDashboardMoney, dashboardDate, recognizedMatchedSales, type MatchedSaleFact, type OperatingSaleEvent, type SalesBaseline, type SalesOpening } from "@qintopia/domain";
import type { DashboardDetail, DashboardRange } from "@qintopia/contracts";
import type { Database } from "./schema.ts";
import { dashboardMoneyDetail, loadDashboardMoney } from "./dashboard-money.ts";

interface Proof { id:string;channel_order:boolean;method:string;reversed:boolean;reversed_at:Date|null;bill_id:string|null;bill_amount:string|null;bill_count:number;verified:boolean;original_date:string|null }
export async function loadOperatingSales(trx:Transaction<Database>,propertyId:string,timezone:string,currency:string,range:DashboardRange,today:string) {
 const baselines=(await sql<SalesBaseline>`SELECT month::text,currency,amount_minor::text AS "amountMinor",recognition_from::text AS "recognitionFrom",evidence_note AS note FROM operating_sales_baselines WHERE property_id=${propertyId} ORDER BY month`.execute(trx)).rows;
 if(!baselines.length){const result=aggregateOperatingSales({from:range.from,to:range.to,currency,events:[],reviews:[],baselines});return {...result,todaySummary:result.summary,details:[] as DashboardDetail[]};}
 const opening=(await sql<SalesOpening>`SELECT source_kind||':'||source_id AS key,amount_minor::text AS "amountMinor" FROM operating_sales_opening WHERE property_id=${propertyId} AND source_kind<>'CHANNEL_REFUND'`.execute(trx)).rows;
 const until=dashboardDate(range.to>today?range.to:today,1);
 const money=await loadDashboardMoney(trx,propertyId,timezone,'1900-01-01',until);
 const stayProof=(await sql<Proof>`SELECT f.fact_id AS id,(o.booking_channel_code IN ('YOUMUDAO','CTRIP','MEITUAN')) AS channel_order,f.method,
 EXISTS(SELECT 1 FROM collection_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.fact_type='REVERSAL' AND NOT EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.source_reversal_fact_id=rev.fact_id AND t.source_collection_fact_id=f.fact_id AND t.property_id=o.property_id)) AS reversed,
 (SELECT min(rev.created_at) FROM collection_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.fact_type='REVERSAL' AND NOT EXISTS(SELECT 1 FROM stay_collection_membership_transfers t WHERE t.source_reversal_fact_id=rev.fact_id AND t.source_collection_fact_id=f.fact_id AND t.property_id=o.property_id)) AS reversed_at,
 proof.bill_id,proof.bill_amount,proof.bill_count,proof.verified,NULL::text AS original_date
 FROM collection_facts f JOIN orders o ON o.id=f.order_id
 LEFT JOIN LATERAL(SELECT min(b.id) AS bill_id,min(b.amount_minor)::text AS bill_amount,count(*)::integer AS bill_count,
 bool_and(b.state='SUCCESS' AND NOT b.needs_review) AS verified FROM external_payment_bills b
 WHERE f.method='WECOM' AND b.property_id=o.property_id AND b.kind=CASE WHEN f.fact_type='REFUND' THEN 'REFUND' ELSE 'COLLECTION' END
 AND CASE WHEN f.external_payment_bill_id IS NOT NULL THEN b.id=f.external_payment_bill_id
 WHEN EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=f.fact_id)
 THEN EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.bill_id=b.id AND a.collection_fact_id=f.fact_id)
 ELSE b.reference=CASE WHEN f.fact_type='REFUND' THEN f.refund_reference ELSE f.transaction_reference END END)proof ON true
 WHERE o.property_id=${propertyId}`.execute(trx)).rows;
 const memberProof=(await sql<Proof>`SELECT f.fact_id AS id,false AS channel_order,'WECOM'::text AS method,
 EXISTS(SELECT 1 FROM membership_payment_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.fact_type='REVERSAL') AS reversed,
 (SELECT min(rev.created_at) FROM membership_payment_facts rev WHERE rev.reverses_fact_id=f.fact_id AND rev.fact_type='REVERSAL') AS reversed_at,
 proof.bill_id,proof.bill_amount,proof.bill_count,proof.verified,
 (WITH RECURSIVE lineage AS (
    SELECT first.fact_id,first.command_id,first.membership_order_id,first.created_at FROM membership_payment_facts first
      WHERE first.fact_id=f.fact_id AND first.fact_type='COLLECTION' AND first.transaction_reference=f.transaction_reference
    UNION
    SELECT previous.fact_id,previous.command_id,previous.membership_order_id,previous.created_at FROM lineage current
      JOIN membership_payment_facts reversal ON reversal.command_id=current.command_id AND reversal.fact_type='REVERSAL'
      JOIN membership_payment_facts previous ON previous.fact_id=reversal.reverses_fact_id
      WHERE previous.membership_order_id=current.membership_order_id AND previous.fact_type='COLLECTION' AND previous.transaction_reference=f.transaction_reference
  ) SELECT to_char(min(lineage.created_at) AT TIME ZONE ${timezone},'YYYY-MM-DD') FROM lineage
    JOIN external_payment_matches matched ON matched.membership_payment_fact_id=lineage.fact_id AND matched.bill_id=proof.bill_id) AS original_date
 FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id
 LEFT JOIN LATERAL(SELECT min(b.id) AS bill_id,min(b.amount_minor)::text AS bill_amount,count(*)::integer AS bill_count,
 bool_and(b.state='SUCCESS' AND NOT b.needs_review) AS verified FROM external_payment_bills b
 WHERE b.property_id=o.property_id AND b.kind='COLLECTION' AND CASE WHEN EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.membership_payment_fact_id=f.fact_id) THEN EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.membership_payment_fact_id=f.fact_id AND m.bill_id=b.id) ELSE b.reference=f.transaction_reference END)proof ON true
 WHERE o.property_id=${propertyId}`.execute(trx)).rows;
 const proofs=new Map([...stayProof.map(p=>[`STAY:${p.id}`,p] as const),...memberProof.map(p=>[`MEMBER:${p.id}`,p] as const)]);
 const facts:MatchedSaleFact[]=[];
 const uncertain:DashboardDetail[]=[];
 const review=(f:typeof money[number],reason:string):DashboardDetail=>({...dashboardMoneyDetail(f),id:`sales-review:${f.family}:${f.id}`,metric:'REVIEW',label:'经营来源待核实',amountMinor:null,units:null,reason});
 for(const f of money){
  const p=proofs.get(`${f.family}:${f.id}`);
  // 同一渠道订单的到账不是第二次销售；历史普通退款需要核对渠道事实，不能自动双扣。
  if(p?.channel_order&&f.kind==='COLLECTION')continue;
  if(p?.channel_order&&f.kind==='REFUND'){if(!p.reversed)uncertain.push(review(f,'渠道订单存在普通退款记录，需要核对是否与平台退款重复；未直接扣减经营销售额'));continue;}
  const classification=classifyDashboardMoney(f);
  const correctedCollection=f.family==='MEMBER'&&f.kind==='COLLECTION'&&f.correctsFact&&f.commandType==='CORRECT_MEMBERSHIP_PAYMENT';
  if(classification==='REVIEW'){if(!p?.reversed)uncertain.push(review(f,'资金来源或内部转换关系未能确认，请到原业务记录核对；未计入经营销售额'));continue;}
  if(!['COLLECTION','REFUND'].includes(classification)&&!correctedCollection)continue;
  const refund=classification==='REFUND';
  facts.push({id:`${f.family}:${f.id}`,source:f.family==='STAY'?'DIRECT':'MEMBERSHIP',date:p?.original_date??f.date,currency:f.currency,amountMinor:String(BigInt(f.netMinor)<0n?-BigInt(f.netMinor):BigInt(f.netMinor)),registeredAt:f.registeredAt,
    orderId:f.orderId,memberId:f.memberId,billId:p?.bill_id??null,billAmountMinor:p?.bill_amount??null,
    verified:Boolean(p&&(p.method!=='WECOM'||(f.currency==='CNY'&&p.bill_count===1&&p.verified))),reversed:p?.reversed??false,reversedAt:p?.reversed_at?new Date(p.reversed_at).toISOString():null,refund,sourceKey:`${f.family==='STAY'?'STAY_FACT':'MEMBER_FACT'}:${f.id}`});
 }
 const sourceLinks=money.filter(f=>f.kind==='COLLECTION'&&f.currency==='CNY').flatMap(f=>{
   const p=proofs.get(`${f.family}:${f.id}`);
   return p?.bill_id&&p.bill_count===1&&p.verified?[{sourceKey:`${f.family==='STAY'?'STAY_FACT':'MEMBER_FACT'}:${f.id}`,billId:p.bill_id,reversedAt:p.reversed_at?new Date(p.reversed_at).toISOString():null}]:[];
 });
 const matched=recognizedMatchedSales(facts,opening,baselines[0]!.recognitionFrom,sourceLinks);
 const channel=(await sql<{id:string;order_id:string;kind:string;amount:string;currency:string;business_date:string;created_at:Date;note:string;references_fact_id:string|null}>`SELECT id,order_id,kind,amount_minor::text AS amount,currency,business_date::text,created_at,note,references_fact_id FROM channel_operating_facts WHERE property_id=${propertyId} ORDER BY created_at,id`.execute(trx)).rows;
 const reversedChannelRefunds=new Set(channel.filter(f=>f.kind==='REVERSAL').map(f=>f.references_fact_id));
 const channelEvents:OperatingSaleEvent[]=channel.filter(f=>f.kind!=='REVERSAL'&&!reversedChannelRefunds.has(f.id)).map(f=>({id:f.id,source:'CHANNEL',date:f.business_date,currency:f.currency,kind:f.kind==='SALE'?'SALE':f.kind==='REFUND'?'REFUND':'CORRECTION',amountMinor:f.amount,orderId:f.order_id,memberId:null,registeredAt:new Date(f.created_at).toISOString(),reason:f.note}));
 const result=aggregateOperatingSales({from:range.from,to:range.to,currency,events:[...matched.events,...channelEvents],reviews:[...matched.reviews,...uncertain],baselines});
 const todayResult=aggregateOperatingSales({from:today,to:today,currency,events:[...matched.events,...channelEvents],reviews:[...matched.reviews,...uncertain],baselines});
 const details:DashboardDetail[]=result.events.map(e=>({id:`sales:${e.id}`,date:e.date,metric:'SALES',label:e.source==='BASELINE'?'已确认封账合计':e.source==='CHANNEL'?'渠道应结业务':e.source==='MEMBERSHIP'?'会员售卡收款':'已匹配住宿收款',orderId:e.orderId,memberId:e.memberId,unitId:null,units:null,amountMinor:e.amountMinor,currency:e.currency,registeredAt:e.registeredAt,businessDate:e.date,reason:e.reason}));
 const sourceReviews:DashboardDetail[]=[...uncertain,...matched.reviews.map(f=>({id:`sales-review:${f.id}`,date:f.date,metric:'REVIEW' as const,label:'经营来源待核实',orderId:f.orderId,memberId:f.memberId,unitId:null,units:null,amountMinor:null,currency:f.currency,registeredAt:f.registeredAt,businessDate:f.date,reason:f.reason}))].filter(f=>f.date>=baselines[0]!.recognitionFrom);
 const periodReviews=sourceReviews.filter(f=>f.date>=range.from&&f.date<=range.to);
 const reviewDetails=[...periodReviews,...periodReviews.map(f=>({...f,id:`sales:${f.id}`,metric:'SALES' as const})),...sourceReviews.filter(f=>f.date===today).map(f=>({...f,id:`today-sales:${f.id}`,metric:'TODAY_SALES' as const}))];
 const todayDetails:DashboardDetail[]=todayResult.events.map(e=>({id:`today-sales:${e.id}`,date:e.date,metric:'TODAY_SALES',label:'今日经营销售额',orderId:e.orderId,memberId:e.memberId,unitId:null,units:null,amountMinor:e.amountMinor,currency:e.currency,registeredAt:e.registeredAt,businessDate:e.date,reason:e.reason}));
 return {...result,todaySummary:todayResult.summary,details:[...details,...todayDetails,...reviewDetails]};
}
