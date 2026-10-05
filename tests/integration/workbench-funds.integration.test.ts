import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview, createDatabase, withPropertyClockForTesting, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { listWorkbenchFundsExceptions } from "../../packages/db/src/workbench-funds.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { listPaymentAllocations } from "../../packages/db/src/payment-allocation.ts";
import { listRetainedFunds } from "../../packages/db/src/retained-funds.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";

// Reuse the existing guarded, synthetic allocation-test target; never the human acceptance DB.
const defaultUrl = new URL(testDatabaseUrl); defaultUrl.pathname = "/qintopia_payment_allocation_test";
const databaseUrl = process.env.PAYMENT_ALLOCATION_TEST_DATABASE_URL ?? defaultUrl.toString();
let db: Kysely<Database>, runtime: Kysely<Database>, sequence=0;
const now=new Date("2026-10-02T02:00:00Z");
const principal: AuthPrincipal={subjectId:demo.administratorSubjectId,credentialId:"workbench-session",credentialType:"SESSION",displayName:"合成资金验收",...authScope({credentialType:"SESSION",profile:"administrator"})};
const meta=()=>({idempotencyKey:`workbench-${++sequence}`,correlationId:`workbench-${sequence}`});
async function execute(command:CommandEnvelope) {
  const prepared=await createCommandPreview(runtime,principal,command,meta());
  const receipt=await confirmCommandPreview(runtime,principal,prepared.preview.previewId,{propertyId:demo.propertyId,commandType:command.commandType,
    confirmation:true,expectedEffectHash:prepared.preview.effectHash,reason:{code:command.commandType==="CREATE_ORDER"?"CREATE_STANDARD_ORDER":"ALLOCATION_TEST",note:command.commandType==="CREATE_ORDER"?"":"合成测试，核对实际来源"}},meta());
  expect(receipt.businessCommitted,JSON.stringify(receipt.error)).toBe(true); return receipt;
}
async function order(day:number,amountMinor:number) {
  const quote=await createQuoteForTesting(db,{propertyId:demo.propertyId,inventoryUnitId:demo.roomId,stayType:"TRANSIENT",
    arrivalDate:`2028-12-${String(day).padStart(2,"0")}`,departureDate:`2028-12-${String(day+1).padStart(2,"0")}`,pricingPolicyVersionId:demo.transientPolicyId});
  return (await execute({commandType:"CREATE_ORDER",input:{propertyId:demo.propertyId,quoteId:quote.quoteId,primaryGuest:{fullName:"历史余款客户",nickname:"合成客户",phone:"13800003333"},
    bookingChannelCode:"WECOM",targetCurrentContractAmountMinor:amountMinor,manualPriceAdjustmentReason:"合成协议价"}})).result!.orderId as string;
}
function bill(reference:string,amountMinor=100000,override:Partial<WecomBill>={}):WecomBill {
  return {kind:"COLLECTION",merchantId:"m1",reference,originalTradeNo:`trade-${reference}`,transactionId:reference,externalUserId:"customer",collectorId:"staff",amountMinor,
    occurredAt:new Date(now.getTime()-60000),state:"SUCCESS",...override};
}
async function sync(bills:WecomBill[]) {
  const client:PaymentClient={bills:async()=>({bills,nextCursor:null}),nickname:async()=>"付款人线索"};
  await syncWecomSource(db,"workbench-source",client,now);
}
async function payment(reference:string,kind:"COLLECTION"|"REFUND"="COLLECTION") {
  return (await listPaymentAllocations(runtime,demo.propertyId,{kind,status:"ALL"})).items.find(p=>p.reference===reference)!;
}
async function collect(orderId:string,reference:string,amountMinor:number) {
  const p=await payment(reference);
  return execute({commandType:"RECORD_COLLECTION",input:{propertyId:demo.propertyId,orderId,externalPaymentBillId:p.id,amountMinor,method:"WECOM",transactionReference:reference,note:"合付分配"}});
}
const query=(options:{limit?:number;cursor?:string;query?:string}={})=>listWorkbenchFundsExceptions(runtime,{propertyId:demo.propertyId,...options});
async function split() {
  const a=await order(1,40000), b=await order(3,60000); await sync([bill("parent")]);
  await collect(a,"parent",40000); const collected=await collect(b,"parent",60000);
  await execute({commandType:"CANCEL_ORDER",input:{propertyId:demo.propertyId,orderId:b}});
  return {a,b,fb:collected.factRefs[0]!,p:await payment("parent")};
}
async function retain(orderId:string,sourceFactId:string,amountMinor:number) {
  return execute({commandType:"RETAIN_ORDER_FUNDS",input:{propertyId:demo.propertyId,orderId,sourceFactId,amountMinor,
    ownerName:"核实后的款项客户",ownerContact:"13800003333",confirmationNote:"已核实并由客户确认留存"}});
}
beforeEach(async()=>{
  vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED","true");
  db=await resetDatabase(databaseUrl);
  await db.insertInto("web_sessions").values({id:principal.credentialId,subject_id:principal.subjectId,secret_hash:"a".repeat(64),expires_at:new Date(Date.now()+3600000),revoked_at:null}).execute();
  runtime=createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
    VALUES('workbench-source','corp',true,${new Date("2026-09-01")},${new Date("2026-09-01")},${new Date(now.getTime()-120000)},true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('workbench-source','m1',${demo.propertyId})`.execute(db);
});
afterEach(async()=>{await runtime?.destroy();await db?.destroy();vi.unstubAllEnvs();});

describe("workbench funds: read-only cross-date projection",()=>{
  it("shows 1000 then 600 unallocated; cancelling allocated B shows only B 600 across dates",async()=>{
    const a=await order(1,40000),b=await order(3,60000);await sync([bill("parent")]);
    expect((await query()).items).toEqual([expect.objectContaining({kind:"UNALLOCATED_COLLECTION",amountMinor:100000,orderId:null})]);
    await collect(a,"parent",40000);
    expect((await query()).items).toEqual([expect.objectContaining({kind:"UNALLOCATED_COLLECTION",amountMinor:60000})]);
    await collect(b,"parent",60000);expect((await query()).total).toBe(0);
    await execute({commandType:"CANCEL_ORDER",input:{propertyId:demo.propertyId,orderId:b}});
    const after=await withPropertyClockForTesting(new Date("2029-03-01T00:00:00Z"),()=>query());
    expect(after.total).toBe(1);expect(after.items[0]).toMatchObject({kind:"ORDER_EXCESS",orderId:b,amountMinor:60000});
    expect((await payment("parent")).remainingMinor).toBe(0);
    expect((await query({query:"历史余款客户"})).total).toBe(1);
  });
  it("shows checked-out historical excess without expanding administrator terminal repricing",async()=>{
    const id=await order(1,40000);await sync([bill("closed-order",60000)]);await collect(id,"closed-order",60000);
    await withPropertyClockForTesting(new Date("2028-12-01T02:00:00Z"),()=>execute({commandType:"CHECK_IN",input:{propertyId:demo.propertyId,orderId:id}}));
    await withPropertyClockForTesting(new Date("2028-12-02T02:00:00Z"),()=>execute({commandType:"CHECK_OUT",input:{propertyId:demo.propertyId,orderId:id}}));
    const result=await withPropertyClockForTesting(new Date("2029-03-01T02:00:00Z"),()=>query());
    expect(result.items).toEqual([expect.objectContaining({kind:"ORDER_EXCESS",orderId:id,amountMinor:20000})]);
    await expect(createCommandPreview(runtime,principal,{commandType:"REPRICE_ORDER",input:{propertyId:demo.propertyId,orderId:id,targetCurrentContractAmountMinor:60000}},meta())).rejects.toMatchObject({code:"INVALID_ORDER_STATE"});
  });
  it("partial retention only removes its amount, complete retention/use/refund stay out, release reappears",async()=>{
    const {b,fb}=await split();await retain(b,fb,20000);
    expect((await query()).items[0]).toMatchObject({orderId:b,amountMinor:40000});
    await retain(b,fb,40000);expect((await query()).total).toBe(0);
    const lots=(await listRetainedFunds(runtime,demo.propertyId)).items;
    const c=await order(5,40000),lot=lots.find(l=>l.amountMinor===40000)!;
    await execute({commandType:"APPLY_RETAINED_FUNDS",input:{propertyId:demo.propertyId,orderId:c,retainedFundId:lot.id,amountMinor:40000,authorizationNote:"原客户授权使用"}});
    expect((await query()).total).toBe(0);
    const remainder=lots.find(l=>l.amountMinor===20000)!;
    await execute({commandType:"RELEASE_RETAINED_FUNDS",input:{propertyId:demo.propertyId,orderId:b,retainedFundId:remainder.id,amountMinor:20000,note:"解除留存待核对"}});
    expect((await query()).items[0]).toMatchObject({orderId:b,amountMinor:20000});
    await sync([bill("refund-rest",20000,{kind:"REFUND",transactionId:"parent"})]);
    expect((await query()).items).toEqual([expect.objectContaining({kind:"UNASSIGNED_REFUND",amountMinor:20000})]);
    await execute({commandType:"RECORD_REFUND",input:{propertyId:demo.propertyId,orderId:b,referencesFactId:fb,externalPaymentBillId:(await payment("refund-rest","REFUND")).id,
      amountMinor:20000,method:"WECOM",refundReference:"refund-rest",note:"已发生的退款"}});
    expect((await query()).total).toBe(0);expect((await payment("parent")).remainingMinor).toBe(0);
  });
  it("successful unassigned refunds take priority without showing frozen funds as available; partial refund reveals remainder",async()=>{
    const {b,fb}=await split();await sync([bill("refund-part",20000,{kind:"REFUND",transactionId:"parent"})]);
    const pending=await query();expect(pending.total).toBe(1);
    expect(pending.items[0]).toMatchObject({kind:"UNASSIGNED_REFUND",amountMinor:20000,orderId:null});
    expect(pending.items[0]!.reason).toContain("冻结");
    await expect(retain(b,fb,60000)).rejects.toMatchObject({code:"AGGREGATE_VERSION_CONFLICT"});
    await execute({commandType:"RECORD_REFUND",input:{propertyId:demo.propertyId,orderId:b,referencesFactId:fb,externalPaymentBillId:(await payment("refund-part","REFUND")).id,
      amountMinor:20000,method:"WECOM",refundReference:"refund-part",note:"已发生部分退款"}});
    expect((await query()).items).toEqual([expect.objectContaining({kind:"ORDER_EXCESS",orderId:b,amountMinor:40000})]);
  });
  it("only freezes one receipt: another source on the same order remains visible",async()=>{
    const b=await order(3,60000);await sync([bill("source-x",60000),bill("source-y",40000)]);
    await collect(b,"source-x",60000);await collect(b,"source-y",40000);
    await execute({commandType:"CANCEL_ORDER",input:{propertyId:demo.propertyId,orderId:b}});
    await sync([bill("x-refund",20000,{kind:"REFUND",transactionId:"source-x"})]);
    const result=await query();expect(result.total).toBe(2);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:"ORDER_EXCESS",orderId:b,amountMinor:40000}),
      expect.objectContaining({kind:"UNASSIGNED_REFUND",amountMinor:20000})
    ]));
    expect(result.items.find(i=>i.kind==="ORDER_EXCESS")!.reason).toContain("未冻结来源");
  });
  it("also labels a frozen retained-fund incoming source without hiding an independent receipt",async()=>{
    const {b,fb}=await split();await retain(b,fb,60000);
    const lot=(await listRetainedFunds(runtime,demo.propertyId)).items[0]!,c=await order(5,40000);
    await execute({commandType:"APPLY_RETAINED_FUNDS",input:{propertyId:demo.propertyId,orderId:c,retainedFundId:lot.id,amountMinor:40000,authorizationNote:"客户授权代订"}});
    await sync([bill("independent-c",20000)]);await collect(c,"independent-c",20000);
    await execute({commandType:"CANCEL_ORDER",input:{propertyId:demo.propertyId,orderId:c}});
    await sync([bill("incoming-refund",10000,{kind:"REFUND",transactionId:"parent"})]);
    const result=await query(),remaining=result.items.find(i=>i.orderId===c)!;
    expect(remaining).toMatchObject({kind:"ORDER_EXCESS",amountMinor:20000});expect(remaining.reason).toContain("其他来源有成功退款");
    expect(result.items.filter(i=>i.kind==="UNASSIGNED_REFUND")).toHaveLength(1);
  });
  it("preserves microsecond cursors with reverse id ordering inside one millisecond",async()=>{
    await sync([bill("micro-a",1000),bill("micro-b",1000),bill("micro-c",1000)]);
    // Exact timestamp values are inserted as PostgreSQL values, never JS Dates.
    await sql`UPDATE external_payment_bills SET occurred_at=CASE reference
      WHEN 'micro-a' THEN '2026-10-02 01:59:00.123003+00'::timestamptz
      WHEN 'micro-b' THEN '2026-10-02 01:59:00.123002+00'::timestamptz
      ELSE '2026-10-02 01:59:00.123001+00'::timestamptz END`.execute(db);
    const visited=[];let cursor:string|undefined;
    do {const page=await query({limit:1,...(cursor?{cursor}:{})});visited.push(page.items[0]!.reference);cursor=page.nextCursor??undefined;}while(cursor);
    expect(visited).toEqual(["micro-a","micro-b","micro-c"]);
    expect((await query({limit:1})).items[0]!.occurredAt).toContain(".123003Z");
  });
  it("keeps two real stores separate with receipts in both stores",async()=>{
    await sync([bill("our-store",1000)]);
    await sql`INSERT INTO properties(id,code,name,timezone,currency) VALUES('workbench-other','OTHER','Other store','Asia/Shanghai','CNY')`.execute(db);
    await sql`INSERT INTO external_payment_accounts VALUES('workbench-source','m2','workbench-other')`.execute(db);
    await sql`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state)
      VALUES('other-bill','workbench-source','m2','workbench-other','COLLECTION','other-store','other',2000,${now},'SUCCESS')`.execute(db);
    expect((await query()).items.map(i=>i.reference)).toEqual(["our-store"]);
    expect((await listWorkbenchFundsExceptions(runtime,{propertyId:"workbench-other"})).items).toEqual([expect.objectContaining({reference:"other-store",amountMinor:2000})]);
  });
  it("excludes actually matched membership-only money and its refunds",async()=>{
    const member=await execute({commandType:"CREATE_MEMBER",input:{propertyId:demo.propertyId,fullName:"资金范围会员",nickname:"会员",phone:"13912349876",wechat:"test-member"}});
    const membership=await execute({commandType:"CREATE_MEMBERSHIP_ORDER",input:{propertyId:demo.propertyId,memberId:member.result!.memberId,
      membershipProductId:"membership_product_shared_bath_single_v1",agreedPriceMinor:162000}});
    await sync([bill("member-only",12000)]);
    await execute({commandType:"RECORD_MEMBERSHIP_PAYMENT",input:{propertyId:demo.propertyId,membershipOrderId:membership.result!.membershipOrderId,amountMinor:12000,transactionReference:"member-only"}});
    await sync([bill("member-refund",1000,{kind:"REFUND",transactionId:"member-only"})]);
    expect((await query()).total).toBe(0);
  });
  it("keeps external-platform orders outside funds and preserves per-order cash write guards",async()=>{
    const quote=await createQuoteForTesting(db,{propertyId:demo.propertyId,inventoryUnitId:demo.roomId,stayType:"TRANSIENT",arrivalDate:"2028-12-01",departureDate:"2028-12-02",pricingPolicyVersionId:demo.transientPolicyId});
    const id=(await execute({commandType:"CREATE_ORDER",input:{propertyId:demo.propertyId,quoteId:quote.quoteId,primaryGuest:{fullName:"平台测试",nickname:"合成平台"},bookingChannelCode:"CTRIP",channelOrderReference:"PLATFORM-1",targetCurrentContractAmountMinor:60000,channelPriceDifferenceReason:"合成平台协议价"}})).result!.orderId as string;
    // Existing manually recorded platform cash is not a new ordinary lodging receipt.
    // Synthetic legacy fixture: modern commands correctly reject platform cash writes.
    await expect(execute({commandType:"RECORD_COLLECTION",input:{propertyId:demo.propertyId,orderId:id,amountMinor:60000,method:"BANK_TRANSFER",transactionReference:"platform-paid",note:"历史平台回款"}})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(sql`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,transaction_reference,pricing_revision_id)
      SELECT 'legacy-platform-paid',id,'COLLECTION',60000,60000,'CNY','BANK_TRANSFER','合成历史平台回款','platform-paid',current_revision_id FROM orders WHERE id=${id}`.execute(db)).rejects.toThrow('external channel orders cannot record per-order collection or refund facts in PMS');
    await execute({commandType:"CANCEL_ORDER",input:{propertyId:demo.propertyId,orderId:id}});
    expect((await query()).total).toBe(0);
  });
  it("unknown successful refund amounts remain unknown, not zero; feature/source off cannot hide historical funds",async()=>{
    const {b}=await split();vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED","false");
    await sql`UPDATE external_payment_sources SET enabled=false WHERE id='workbench-source'`.execute(db);
    const historical=await query();expect(historical.enabled).toBe(false);expect(historical.items[0]).toMatchObject({orderId:b,amountMinor:60000});
    await sql`UPDATE external_payment_sources SET enabled=true WHERE id='workbench-source'`.execute(db);
    await sync([bill("unknown-refund",null as unknown as number,{kind:"REFUND",transactionId:"parent"})]);
    expect((await query()).items).toEqual([expect.objectContaining({kind:"UNASSIGNED_REFUND",amountMinor:null})]);
  });
  it("counts all pages, keyset survives a resolved cursor and preserves DB microseconds, searches literal text",async()=>{
    await sync(Array.from({length:5},(_,i)=>bill(`page-${i}`,1000,{occurredAt:new Date(now.getTime()-60000-i)})));
    const first=await query({limit:2});expect(first.total).toBe(5);expect(first.items).toHaveLength(2);expect(first.nextCursor).toBeTruthy();
    const next=await query({limit:2,cursor:first.nextCursor!});expect(next.total).toBe(5);expect(next.items).toHaveLength(2);
    const last=await query({limit:2,cursor:next.nextCursor!});expect(last.items).toHaveLength(1);expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items,...next.items,...last.items].map(i=>i.id)).size).toBe(5);
    const target=await order(1,1000),reference=first.items[1]!.reference!;
    await collect(target,reference,1000);
    expect((await query({limit:2,cursor:first.nextCursor!})).items.map(i=>i.id)).toEqual(next.items.map(i=>i.id));
    expect((await query({query:"%"})).total).toBe(0);
    await expect(query({cursor:"not-a-cursor"})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(query({limit:0})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    expect((await listWorkbenchFundsExceptions(runtime,{propertyId:"foreign"})).total).toBe(0);
  });
  it("does not turn normal unpaid reservations or unsupported receipts into excess",async()=>{
    await order(1,60000);
    await sync([bill("pending",1000,{state:"PENDING"}),bill("historic",1000,{occurredAt:new Date("2026-08-01")})]);
    expect((await query()).total).toBe(0);
  });
  it("API is read-only, no-store, enforces auth/property access, rejects malformed parameters",async()=>{
    await sync([bill("readable")]);const app=await buildServer(runtime);
    try {
      const url=`/api/v2/workbench-funds-exceptions?propertyId=${demo.propertyId}`,headers={authorization:`Bearer ${demo.readToken}`};
      expect((await app.inject({method:"GET",url})).statusCode).toBe(401);
      const response=await app.inject({method:"GET",url,headers});expect(response.statusCode,response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");expect(response.json().total).toBe(1);
      expect((await app.inject({method:"GET",url:"/api/v2/workbench-funds-exceptions?propertyId=foreign",headers})).statusCode).toBe(403);
      for(const suffix of ["&limit=0","&cursor=bad"]) expect((await app.inject({method:"GET",url:url+suffix,headers})).statusCode).toBe(400);
      expect((await app.inject({method:"POST",url,headers})).statusCode).toBe(404);
      await sql`REVOKE SELECT ON external_payment_allocations FROM qintopia_runtime`.execute(db);
      try {
        const failed=await app.inject({method:"GET",url,headers});expect(failed.statusCode,failed.body).toBe(500);
        expect(failed.json()).not.toHaveProperty("total");expect(failed.json()).not.toHaveProperty("items");
      } finally {await sql`GRANT SELECT ON external_payment_allocations TO qintopia_runtime`.execute(db);}
      await db.deleteFrom("subject_property_grants").where("subject_id","=",demo.agentSubjectId).execute();
      expect((await app.inject({method:"GET",url,headers})).statusCode).toBe(403);
    } finally {await app.close();}
  });
});
