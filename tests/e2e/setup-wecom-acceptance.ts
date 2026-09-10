import { sql } from "kysely";
import { createCommandPreview, confirmCommandPreview } from "@qintopia/db";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { syncWecomSource } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import { resetDatabase } from "../helpers/database.ts";
import { authScope } from "../helpers/auth-principals.ts";
async function main() {
const url=process.env.WECOM_ACCEPTANCE_DATABASE_URL;
if (!url || new URL(url).pathname !== "/qintopia_wecom_acceptance_20260910") throw Error("Dedicated synthetic acceptance database required");
const db=await resetDatabase(url);
const principal: AuthPrincipal={subjectId:demo.agentSubjectId,credentialId:"token_demo_write",credentialType:"TOKEN",displayName:"Synthetic acceptance",...authScope()};
let seq=0;
const meta=()=>({idempotencyKey:`wecom-acceptance-${++seq}`,correlationId:`wecom-acceptance-${seq}`});
async function execute(command:CommandEnvelope){
  const p=await createCommandPreview(db,principal,command,meta());
  const r=await confirmCommandPreview(db,principal,p.preview.previewId,{propertyId:demo.propertyId,commandType:command.commandType,
    confirmation:true,expectedEffectHash:p.preview.effectHash,reason:command.commandType==="CREATE_ORDER"?{code:"CREATE_STANDARD_ORDER",note:""}:{code:"WECOM_ACCEPTANCE",note:"合成本地验收"}},meta());
  if(!r.businessCommitted)throw Error(JSON.stringify(r.error));return r;
}
try {
  const orders:string[]=[];
  for(const day of [1,3]){
    const q=await createQuoteForTesting(db,{propertyId:demo.propertyId,inventoryUnitId:demo.roomId,stayType:"TRANSIENT",arrivalDate:`2028-12-0${day}`,
      departureDate:`2028-12-0${day+1}`,pricingPolicyVersionId:demo.transientPolicyId});
    const r=await execute({commandType:"CREATE_ORDER",input:{propertyId:demo.propertyId,quoteId:q.quoteId,
      primaryGuest:{fullName:day===1?"收款选择验收":"退款选择验收",nickname:"小秦"},bookingChannelCode:"WECOM",targetCurrentContractAmountMinor:q.currentContractAmount.minorUnits}});
    orders.push(r.result!.orderId as string);
  }
  await execute({commandType:"RECORD_COLLECTION",input:{propertyId:demo.propertyId,orderId:orders[1],amountMinor:12000,method:"WECOM",transactionReference:"SYNTHETIC-PAID",note:"已有手录收款"}});
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since)
    VALUES('acceptance','synthetic-corp',true,'2026-09-01 00:00:00+08','2026-08-30 00:00:00+08')`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('acceptance','synthetic-merchant',${demo.propertyId})`.execute(db);
  const now=new Date();
  const base:WecomBill={kind:"COLLECTION",merchantId:"synthetic-merchant",reference:"SYNTHETIC-PAID",transactionId:"SYNTHETIC-PAID",originalTradeNo:"trade-paid",
    externalUserId:"customer-1",collectorId:"staff",amountMinor:12000,occurredAt:new Date(now.getTime()-600000),state:"SUCCESS"};
  const rows:WecomBill[]=[base,...Array.from({length:7},(_,i)=>({...base,reference:`SYNTHETIC-PAY-${i+1}`,transactionId:`SYNTHETIC-PAY-${i+1}`,
    originalTradeNo:`trade-${i+1}`,externalUserId:`customer-${i+1}`,occurredAt:new Date(now.getTime()-(i+1)*60000)})),
    {...base,reference:"SYNTHETIC-HISTORY",transactionId:"SYNTHETIC-HISTORY",occurredAt:new Date("2026-08-31T15:59:00Z")},
    {...base,kind:"REFUND",reference:"SYNTHETIC-REFUND-1",amountMinor:3000,occurredAt:new Date(now.getTime()-60000)}];
  const client={bills:async(begin:Date,end:Date)=>({bills:rows.filter(r=>r.occurredAt>=begin&&r.occurredAt<=end),nextCursor:null}),
    nickname:async(id:string)=>["小秦","山间晚风","旅途中的小林","小秦","周末来住","南方有雨","阿泽"][Number(id.split("-")[1])-1]??null};
  for(let i=0;i<4;i++)await syncWecomSource(db,"acceptance",client,now);
  console.log(JSON.stringify({propertyId:demo.propertyId,collectionOrderId:orders[0],refundOrderId:orders[1],data:"synthetic only"}));
}finally{await db.destroy()}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
