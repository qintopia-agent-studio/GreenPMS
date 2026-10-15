import type { OperatingSalesAmount, OperatingSalesSource, OperatingSalesSummary } from "@qintopia/contracts";
export interface OperatingSaleEvent { id:string;source:OperatingSalesSource;date:string;currency:string;kind:"SALE"|"REFUND"|"CORRECTION"|"BASELINE";amountMinor:string;orderId:string|null;memberId:string|null;registeredAt:string|null;reason:string }
export interface MatchedSaleFact {id:string;source:"DIRECT"|"MEMBERSHIP";date:string;currency:string;amountMinor:string;registeredAt:string;orderId:string|null;memberId:string|null;billId:string|null;billAmountMinor:string|null;verified:boolean;reversed:boolean;reversedAt?:string|null;refund:boolean;sourceKey:string}
export interface SalesOpening {key:string;amountMinor:string}
export interface SalesBaseline {month:string;currency:string;amountMinor:string;recognitionFrom:string;note?:string}

/** 每笔有效款项按匹配份额及匹配日期计入；期初已计金额优先覆盖历史关联份额。 */
export function recognizedMatchedSales(facts:MatchedSaleFact[],opening:SalesOpening[],recognitionFrom:string,sourceLinks:Array<{sourceKey:string;billId:string;reversedAt?:string|null}>=[]) {
 const available=new Map(opening.map(row=>[row.key,BigInt(row.amountMinor)]));
 const unique=[...new Map(facts.map(f=>[f.id,f])).values()];
 const released=new Map<string,Array<{amount:bigint;at:string}>>();
 const release=(bill:string,amount:bigint,at:string)=>{const rows=released.get(bill)??[];rows.push({amount,at});released.set(bill,rows);};
 // 未进入有效收入列表的原事实，仍须有明确冲销时间才能把旧额度交给后续匹配。
 for(const link of sourceLinks){
  if(!link.reversedAt||unique.some(f=>f.sourceKey===link.sourceKey)||available.has(`PAYMENT_BILL:${link.billId}`))continue;
  const amount=available.get(link.sourceKey)??0n;if(amount){release(link.billId,amount,link.reversedAt);available.set(link.sourceKey,0n);}
 }
 const billTotals=new Map<string,bigint>();
 for(const f of unique)if(!f.reversed&&f.verified&&f.billId)billTotals.set(f.billId,(billTotals.get(f.billId)??0n)+BigInt(f.amountMinor));
 const events:OperatingSaleEvent[]=[];const reviews:Array<MatchedSaleFact & {reason:string}>=[];
 // 包含已冲销原事实：它在冲销前占用自己的期初额度，不能让另一张订单抢走。
 for(const fact of unique.sort((a,b)=>a.registeredAt.localeCompare(b.registeredAt)||a.date.localeCompare(b.date)||a.id.localeCompare(b.id))) {
  if(!fact.verified || (!fact.reversed&&fact.billId&&fact.billAmountMinor!==null&&(billTotals.get(fact.billId)??0n)>BigInt(fact.billAmountMinor))) {if(!fact.reversed&&fact.date>=recognitionFrom)reviews.push({...fact,reason:fact.verified?'同一账单的有效关联金额超过流水金额，请核对重复关联；未计入经营销售额':'缺少唯一成功的收款依据，请回原订单核对流水；未计入经营销售额'});continue;}
  let amount=BigInt(fact.amountMinor);
  if(!fact.refund){
   const billKey=fact.billId?`PAYMENT_BILL:${fact.billId}`:null;
   const key=billKey&&available.has(billKey)?billKey:fact.sourceKey;
   const carry=available.get(key)??0n;const used=carry<amount?carry:amount;available.set(key,carry-used);amount-=used;
   for(const bucket of fact.billId?released.get(fact.billId)??[]:[]){
    if(bucket.at>fact.registeredAt)continue;
    const take=bucket.amount<amount?bucket.amount:amount;bucket.amount-=take;amount-=take;
   }
   if(fact.reversed&&fact.billId&&fact.reversedAt){const carried=BigInt(fact.amountMinor)-amount;if(carried>0n)release(fact.billId,carried,fact.reversedAt);}
  }
  if(fact.reversed||fact.date<recognitionFrom||amount===0n)continue;
  events.push({id:fact.id,source:fact.source,date:fact.date,currency:fact.currency,kind:fact.refund?'REFUND':'SALE',amountMinor:String(fact.refund?-amount:amount),orderId:fact.orderId,memberId:fact.memberId,registeredAt:fact.registeredAt,reason:fact.refund?'已登记实际退款':'真实款项已关联业务；已扣除期初已计份额'});
 }
 return {events,reviews};
}
function totals(events:OperatingSaleEvent[],currency:string):OperatingSalesAmount[]{
 const grouped=new Map<string,{sales:bigint;refunds:bigint;corrections:bigint;baseline:bigint;hasBaseline:boolean}>([[currency,{sales:0n,refunds:0n,corrections:0n,baseline:0n,hasBaseline:false}]]);
 for(const e of events){const v=grouped.get(e.currency)??{sales:0n,refunds:0n,corrections:0n,baseline:0n,hasBaseline:false};const amount=BigInt(e.amountMinor);
  if(e.kind==='SALE')v.sales+=amount;else if(e.kind==='REFUND')v.refunds-=amount;else if(e.kind==='BASELINE'){v.baseline+=amount;v.hasBaseline=true}else v.corrections+=amount;
  grouped.set(e.currency,v);
 }
 return [...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([currency,v])=>({currency,salesMinor:v.hasBaseline?null:String(v.sales),refundsMinor:v.hasBaseline?null:String(v.refunds),correctedMinor:String(v.corrections),netMinor:String(v.sales-v.refunds+v.corrections+v.baseline)}));
}
export function aggregateOperatingSales(input:{from:string;to:string;currency:string;events:OperatingSaleEvent[];reviews:Array<{date:string}>;baselines:SalesBaseline[]}):{summary:OperatingSalesSummary;events:OperatingSaleEvent[]} {
 const {from,to,currency,baselines}=input;
 if(!baselines.length)return {summary:{enabled:false,complete:false,reason:'历史已计收入来源尚未承接，暂不显示经营销售额',reviewCount:0,totals:[],breakdown:[],trend:[],sealedMonths:[]},events:[]};
 const start=baselines[0]!.recognitionFrom;
 const closed=new Set(baselines.map(b=>b.month.slice(0,7)));
 const events=[...new Map(input.events.filter(e=>e.date>=from&&e.date<=to&&e.date>=start&&!closed.has(e.date.slice(0,7))).map(e=>[e.id,e])).values()];
 const sealedMonths:string[]=[];let partialSealed=false;
 for(const b of baselines){const last=new Date(Date.UTC(Number(b.month.slice(0,4)),Number(b.month.slice(5,7)),0)).toISOString().slice(0,10);
  if(to<b.month||from>last)continue;
  if(from>b.month||to<last){partialSealed=true;continue;}
  sealedMonths.push(b.month.slice(0,7));events.push({id:`baseline:${b.month}:${b.currency}`,source:'BASELINE',date:last,currency:b.currency,kind:'BASELINE',amountMinor:b.amountMinor,orderId:null,memberId:null,registeredAt:null,reason:`${b.month.slice(0,7)}已确认封账合计，不代表月末单日发生额。${b.note??""}`});
 }
 const reviews=input.reviews.filter(f=>f.date>=from&&f.date<=to&&f.date>=start);
 let historicalCursor=from;
 for(const b of [...baselines].sort((a,b)=>a.month.localeCompare(b.month))){const next=new Date(Date.UTC(Number(b.month.slice(0,4)),Number(b.month.slice(5,7)),1)).toISOString().slice(0,10);if(b.month<=historicalCursor&&historicalCursor<next)historicalCursor=next;}
 const historyCovered=from>=start||historicalCursor>to||historicalCursor>=start;
 const complete=!partialSealed&&reviews.length===0&&historyCovered;
 const summary:OperatingSalesSummary={enabled:true,complete,reason:partialSealed?'封账月份只有月度基准，不能按部分日期拆分；请选择整月或新口径起始日之后':reviews.length?'部分款项缺少可核实的收款或关联证据，暂不显示完整合计':!complete?'所选区间包含未承接的历史范围':'按已确认业务统计；未匹配收银不计收入，渠道按应结金额，内部转款不重复计',reviewCount:reviews.length,totals:totals(events,currency),breakdown:[],trend:[],sealedMonths};
 for(const source of ['DIRECT','MEMBERSHIP','CHANNEL','BASELINE'] as const){const selected=events.filter(e=>e.source===source);if(selected.length)summary.breakdown.push(...totals(selected,currency).map(t=>({...t,source})));}
 for(const date of [...new Set(events.filter(e=>e.kind!=='BASELINE').map(e=>e.date))].sort())summary.trend.push({date,totals:totals(events.filter(e=>e.date===date&&e.kind!=='BASELINE'),currency)});
 return {summary,events};
}
