import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, createCommandPreview, confirmCommandPreview, type Database } from "@qintopia/db";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { readPaymentAllocationEvents, readPaymentAllocationEventHead } from "../../packages/db/src/payment-allocation-events.ts";
import { publishPaymentAllocationEvents, claimPaymentAllocationDelivery, finishPaymentAllocationDelivery, allocationDeliveryReady, publishPaymentEvents, deliverOnePaymentAllocation } from "../../packages/db/src/payment-event-worker.ts";
import { eventSignature, type IntegrationDeliveryConfig } from "../../packages/db/src/integration-worker.ts";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { syncWecomSource } from "../../packages/db/src/wecom-sync.ts";
import { listPaymentAllocations } from "../../packages/db/src/payment-allocation.ts";
import { listRetainedFunds } from "../../packages/db/src/retained-funds.ts";
import { paymentDeliveryReady } from "../../packages/db/src/payment-delivery-readiness.ts";
import { buildServer } from "../../apps/api/src/server.ts";
let db: Kysely<Database>, runtime: Kysely<Database>, worker: Kysely<Database>;
const eventsDatabaseUrl = (() => {
 const url=new URL(process.env.PAYMENT_ALLOCATION_EVENTS_TEST_DATABASE_URL ?? testDatabaseUrl);
 if(!process.env.PAYMENT_ALLOCATION_EVENTS_TEST_DATABASE_URL) url.pathname='/qintopia_allocation_events_test';
 if(url.pathname!=='/qintopia_allocation_events_test') throw Error('Dedicated qintopia_allocation_events_test database required');
 return url.toString();
})();
let commandSequence = 0;
const now = new Date("2026-10-02T02:00:00Z");
const principal: AuthPrincipal = {subjectId:demo.administratorSubjectId,credentialId:"allocation-events-session",credentialType:"SESSION",displayName:"事件测试",...authScope({credentialType:"SESSION",profile:"administrator"})};
const metadata = () => ({idempotencyKey:`event-test-${++commandSequence}`,correlationId:`event-test-${commandSequence}`});
async function execute(command: CommandEnvelope) {
 const preview=await createCommandPreview(runtime,principal,command,metadata());
 const request={propertyId:demo.propertyId,commandType:command.commandType,confirmation:true as const,expectedEffectHash:preview.preview.effectHash,
 reason:{code:command.commandType==='CREATE_ORDER'?'CREATE_STANDARD_ORDER':'EVENT_TEST',note:command.commandType==='CREATE_ORDER'?'':'核对事件来源'}};
 const meta=metadata();
 const receipt=await confirmCommandPreview(runtime,principal,preview.preview.previewId,request,meta);
 expect(receipt.businessCommitted,JSON.stringify(receipt.error)).toBe(true);
 return {receipt,replay:()=>confirmCommandPreview(runtime,principal,preview.preview.previewId,request,meta)};
}
async function order(day:number) {
 const quote=await createQuoteForTesting(db,{propertyId:demo.propertyId,inventoryUnitId:demo.roomId,stayType:"TRANSIENT",arrivalDate:`2028-12-${String(day).padStart(2,'0')}`,departureDate:`2028-12-${String(day+1).padStart(2,'0')}`,pricingPolicyVersionId:demo.transientPolicyId});
 return (await execute({commandType:"CREATE_ORDER",input:{propertyId:demo.propertyId,quoteId:quote.quoteId,primaryGuest:{fullName:"事件测试",nickname:"事件测试",phone:"13800001234"},bookingChannelCode:"WECOM",targetCurrentContractAmountMinor:60000,manualPriceAdjustmentReason:"合付事件测试报价"}})).receipt.result!.orderId as string;
}
async function syncedBill() {
 await syncWecomSource(db,"events-source",{bills:async()=>({bills:[{kind:"COLLECTION",merchantId:"merchant",reference:"parent",originalTradeNo:"trade-parent",transactionId:"parent",externalUserId:null,collectorId:null,amountMinor:100000,occurredAt:new Date(now.getTime()-60000),state:"SUCCESS"}],nextCursor:null}),nickname:async()=>null},now);
 return (await listPaymentAllocations(runtime,demo.propertyId,{kind:"COLLECTION",status:"ALL"})).items.find(x=>x.reference==='parent')!;
}
const config: IntegrationDeliveryConfig = {endpoint:"https://receiver.invalid/api/v1/ingress/pms/events",sourceInstance:"allocation-simulation",propertyIds:[demo.propertyId],keyId:"test",signingKey:"simulation-only-signing-key-32-bytes",timeoutMs:1000,leaseMs:10000};
beforeEach(async () => {
  vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED","true");
  db=await resetDatabase(eventsDatabaseUrl);
  await db.insertInto('web_sessions').values({id:principal.credentialId,subject_id:principal.subjectId,secret_hash:'a'.repeat(64),expires_at:new Date('2035-01-01'),revoked_at:null}).execute();
  runtime=createDatabase(runtimeDatabaseUrlForTesting(eventsDatabaseUrl));
  await sql`ALTER ROLE qintopia_allocation_delivery_worker LOGIN`.execute(db);
  const workerUrl=new URL(eventsDatabaseUrl);workerUrl.username='qintopia_allocation_delivery_worker';workerUrl.password='';worker=createDatabase(workerUrl.toString());
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,import_since,matching_since,synced_until,baseline_complete) VALUES('events-source','events-corp',true,'2026-09-01Z','2026-09-01Z',${new Date(now.getTime()-120000)},true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('events-source','merchant',${demo.propertyId})`.execute(db);
});
afterEach(async()=>{await worker?.destroy();await runtime?.destroy();await db?.destroy();vi.unstubAllEnvs();});
const insertBill = (id:string)=>sql`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state)
 VALUES(${id},'events-source','merchant',${demo.propertyId},'COLLECTION',${id},${id},100000,now(),'SUCCESS')`;
describe("allocation v2 commit-order events",()=>{
 it("discovers once, preserves bigint precision, rollback and property isolation",async()=>{
  await insertBill('a').execute(db);
  expect((await readPaymentAllocationEvents(db,demo.propertyId)).events[0]?.eventType).toBe('DISCOVERED');
  await sql`UPDATE payment_allocation_heads SET last_sequence=9007199254740992 WHERE property_id=${demo.propertyId}`.execute(db);
  await insertBill('b').execute(db);
  expect((await readPaymentAllocationEventHead(db,demo.propertyId)).headCursor).toBe('9007199254740993');
  await expect(db.transaction().execute(async trx=>{await insertBill('rollback').execute(trx);throw Error('rollback');})).rejects.toThrow('rollback');
  expect((await readPaymentAllocationEventHead(db,demo.propertyId)).headCursor).toBe('9007199254740993');
  expect((await readPaymentAllocationEvents(db,'other')).events).toEqual([]);
  await expect(readPaymentAllocationEvents(db,demo.propertyId,'9223372036854775808')).rejects.toThrow();
 });
 it("holds property head until commit, with no cursor gap past pending transactions",async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
  const first=db.transaction().execute(async trx=>{await insertBill('first').execute(trx);entered();await gate;});
  await ready;
  const second=insertBill('second').execute(db);
  try {expect((await readPaymentAllocationEvents(db,demo.propertyId)).events).toEqual([]);} finally {release();}
  await Promise.all([first,second]);
  expect((await readPaymentAllocationEvents(db,demo.propertyId)).events.map(e=>e.billId)).toEqual(['first','second']);
 });
 it("deduplicates invalidations and materializes immutable opt-in v2 bytes independently",async()=>{
  await insertBill('a').execute(db);
  await sql`SELECT qintopia_allocation_emit('a','ALLOCATED','test-allocation')`.execute(db);
  await sql`SELECT qintopia_allocation_emit('a','ALLOCATED','test-allocation')`.execute(db);
  expect((await readPaymentAllocationEvents(db,demo.propertyId)).events.map(e=>e.eventType)).toEqual(['DISCOVERED','ALLOCATED']);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  expect(await publishPaymentAllocationEvents(db,demo.propertyId,config.sourceInstance)).toBe(2);
  expect(await publishPaymentAllocationEvents(db,demo.propertyId,config.sourceInstance)).toBe(0);
  expect(await claimPaymentAllocationDelivery(db,config)).toBeUndefined();
  await sql`SELECT qintopia_allocation_delivery_control('RESUME','TEST')`.execute(db);
  const claim=(await claimPaymentAllocationDelivery(db,config))!;
  expect(JSON.parse(claim.body).schemaVersion).toBe('pms.payments.v2');
  expect(await finishPaymentAllocationDelivery(db,claim,{kind:'accepted',receipt:'test-receipt'})).toBe(true);
  expect(await finishPaymentAllocationDelivery(db,claim,{kind:'retry',code:'LATE'})).toBe(false);
  expect((await sql<{n:string}>`SELECT count(*)::text AS n FROM payment_delivery_events`.execute(db)).rows[0]?.n).toBe('0');
  await expect(sql`UPDATE allocation_delivery_events SET body='{}'`.execute(db)).rejects.toThrow();
 });
 it("enforces runtime READ scope and refuses feed forgery or worker privilege expansion",async()=>{
  await insertBill('readable').execute(db);
  expect(await allocationDeliveryReady(worker)).toBe(true);
  expect(await paymentDeliveryReady(db)).toBe(true);
  expect((await readPaymentAllocationEvents(runtime,demo.propertyId)).events).toHaveLength(1);
  for(const connection of [runtime,worker]) {
   await expect(sql`SELECT qintopia_allocation_emit('readable','ALLOCATED','forged')`.execute(connection)).rejects.toMatchObject({code:'42501'});
   await expect(sql`UPDATE payment_allocation_heads SET last_sequence=99`.execute(connection)).rejects.toMatchObject({code:'42501'});
   await expect(sql`DELETE FROM payment_allocation_events`.execute(connection)).rejects.toMatchObject({code:'42501'});
  }
  await expect(sql`SELECT * FROM collection_facts`.execute(worker)).rejects.toMatchObject({code:'42501'});
  await expect(sql`SELECT qintopia_allocation_delivery_control('RESUME','UNAUTHORIZED')`.execute(worker)).rejects.toMatchObject({code:'42501'});
  await sql`GRANT DELETE ON allocation_deliveries TO qintopia_allocation_delivery_worker`.execute(db);
  try {expect(await allocationDeliveryReady(worker)).toBe(false);} finally {await sql`REVOKE DELETE ON allocation_deliveries FROM qintopia_allocation_delivery_worker`.execute(db);}
  await sql`ALTER TABLE external_payment_allocations DISABLE TRIGGER payment_allocation_capture`.execute(db);
  try {expect(await allocationDeliveryReady(worker)).toBe(false);} finally {await sql`ALTER TABLE external_payment_allocations ENABLE TRIGGER payment_allocation_capture`.execute(db);}
  expect(await allocationDeliveryReady(worker)).toBe(true);
  const app=await buildServer(runtime);
  try {
   const headers={authorization:`Bearer ${demo.readToken}`};
   for(const suffix of ['', '/head']) {
    const url=`/api/v2/external-payment-events${suffix}?propertyId=${demo.propertyId}`;
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
    const response=await app.inject({method:'GET',url,headers});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().schemaVersion).toBe('pms.payments.v2');
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject({method:'GET',url:`/api/v2/external-payment-events${suffix}?propertyId=foreign`,headers})).statusCode).toBe(403);
   }
   await db.deleteFrom('subject_property_grants').where('subject_id','=',demo.agentSubjectId).execute();
   expect((await app.inject({method:'GET',url:`/api/v2/external-payment-events?propertyId=${demo.propertyId}`,headers})).statusCode).toBe(403);
  } finally {await app.close();}
 });
 it("retries exact v2 bytes with fresh signatures, pauses authentication failures, and fences stale acknowledgements",async()=>{
  await insertBill('retry').execute(db);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  await publishPaymentAllocationEvents(worker,demo.propertyId,config.sourceInstance);
  await sql`SELECT qintopia_allocation_delivery_control('RESUME','TEST')`.execute(db);
  const bodies:string[]=[];const deliveryIds:string[]=[];
  expect(await deliverOnePaymentAllocation(worker,config,async(_url,body,headers)=>{
   bodies.push(body);deliveryIds.push(headers['X-QT-Delivery-Id']!);
   expect(headers['X-QT-Signature']).toBe(eventSignature(body,headers['X-QT-Sent-At']!,headers['X-QT-Delivery-Id']!,config.signingKey));
   return {status:503,body:'temporary',retryAfter:'60'};
  })).toBe(true);
  const pending=(await sql<{state:string;last_error_code:string;wait:boolean}>`SELECT state,last_error_code,next_attempt_at>clock_timestamp()+interval '50 seconds' AS wait FROM allocation_deliveries`.execute(db)).rows[0];
  expect(pending).toEqual({state:'pending',last_error_code:'HTTP_503',wait:true});
  await sql`UPDATE allocation_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second'`.execute(db);
  await deliverOnePaymentAllocation(worker,config,async(_url,body,headers)=>{
   bodies.push(body);deliveryIds.push(headers['X-QT-Delivery-Id']!);
   return {status:401,body:'unauthorized',retryAfter:null};
  });
  expect(bodies[1]).toBe(bodies[0]);expect(deliveryIds[1]).not.toBe(deliveryIds[0]);
  expect(await claimPaymentAllocationDelivery(worker,config)).toBeUndefined();
  expect((await sql<{paused:boolean}>`SELECT paused FROM allocation_delivery_source`.execute(db)).rows[0]?.paused).toBe(true);
  await sql`SELECT qintopia_allocation_delivery_control('RESUME','TEST')`.execute(db);
  await sql`UPDATE allocation_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second'`.execute(db);
  const old=(await claimPaymentAllocationDelivery(worker,config))!;
  await sql`UPDATE allocation_deliveries SET lease_until=clock_timestamp()-interval '1 second'`.execute(db);
  const fresh=(await claimPaymentAllocationDelivery(worker,config))!;
  expect(fresh.body).toBe(old.body);
  expect(BigInt(fresh.generation)).toBeGreaterThan(BigInt(old.generation));
  expect(await finishPaymentAllocationDelivery(worker,old,{kind:'accepted',receipt:'stale'})).toBe(false);
  expect(await finishPaymentAllocationDelivery(worker,fresh,{kind:'dead_letter',code:'HTTP_422'})).toBe(true);
  await sql`SELECT qintopia_allocation_delivery_control('REPLAY','TEST',${fresh.event_id})`.execute(db);
  const replay=(await claimPaymentAllocationDelivery(worker,config))!;
  expect(replay.body).toBe(fresh.body);
  expect(await finishPaymentAllocationDelivery(worker,replay,{kind:'accepted',receipt:'accepted'})).toBe(true);
 });
 it("leaves v1 persisted payloads and feed unchanged while v2 adds partial allocation invalidations",async()=>{
  const legacyBill=await syncedBill();
  await sql`INSERT INTO payment_delivery_source(source_instance) VALUES('legacy-source')`.execute(db);
  await publishPaymentEvents(db,demo.propertyId,'legacy-source');
  const legacy=await sql`SELECT * FROM payment_delivery_events ORDER BY sequence`.execute(db);
  expect(legacy.rows.length).toBeGreaterThan(0);
  const feed=await sql`SELECT * FROM external_payment_events ORDER BY sequence`.execute(db);
  await sql`SELECT qintopia_allocation_emit(${legacyBill.id},'ALLOCATED','partial')`.execute(db);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  await publishPaymentAllocationEvents(worker,demo.propertyId,config.sourceInstance);
  expect((await sql`SELECT * FROM payment_delivery_events ORDER BY sequence`.execute(db)).rows).toEqual(legacy.rows);
  expect((await sql`SELECT * FROM external_payment_events ORDER BY sequence`.execute(db)).rows).toEqual(feed.rows);
  expect(await paymentDeliveryReady(db)).toBe(true);
 });
 it("emits committed allocation and retention commands exactly once, including use and release",async()=>{
  const source=await order(1),target=await order(3),bill=await syncedBill();
  const collected=await execute({commandType:'RECORD_COLLECTION',input:{propertyId:demo.propertyId,orderId:source,externalPaymentBillId:bill.id,amountMinor:60000,method:'WECOM',transactionReference:'parent',note:'部分分配'}});
  const afterCollection=await readPaymentAllocationEvents(runtime,demo.propertyId);
  expect(afterCollection.events.map(x=>x.eventType)).toEqual(['DISCOVERED','ALLOCATED']);
  await collected.replay();
  expect(await readPaymentAllocationEvents(runtime,demo.propertyId)).toEqual(afterCollection);
  expect((await listPaymentAllocations(runtime,demo.propertyId,{kind:'COLLECTION',billId:bill.id,status:'ALL'})).items[0]).toMatchObject({remainingMinor:40000,status:'PARTIALLY_MATCHED'});
  await execute({commandType:'CANCEL_ORDER',input:{propertyId:demo.propertyId,orderId:source}});
  await execute({commandType:'RETAIN_ORDER_FUNDS',input:{propertyId:demo.propertyId,orderId:source,sourceFactId:collected.receipt.factRefs[0]!,amountMinor:60000,ownerName:'付款人',ownerContact:'13800001234',confirmationNote:'已核实留存'}});
  const retained=(await listRetainedFunds(runtime,demo.propertyId,{status:'AVAILABLE'})).items[0]!;
  await execute({commandType:'APPLY_RETAINED_FUNDS',input:{propertyId:demo.propertyId,orderId:target,retainedFundId:retained.id,amountMinor:40000,authorizationNote:'归属客户授权代订'}});
  await execute({commandType:'RELEASE_RETAINED_FUNDS',input:{propertyId:demo.propertyId,orderId:source,retainedFundId:retained.id,amountMinor:20000,note:'解除待核对'}});
  const events=(await readPaymentAllocationEvents(runtime,demo.propertyId)).events;
  expect(events.map(x=>x.eventType)).toEqual(['DISCOVERED','ALLOCATED','RETAINED','RETENTION_CHANGED','RETENTION_CHANGED']);
  expect(events.every(x=>x.billId===bill.id)).toBe(true);
  const versions=events.map(x=>BigInt(x.billVersion));
  expect(versions).toEqual([...versions].sort((a,b)=>a<b?-1:1));
  // A delayed older invalidation must not override a newer state version.
  const newest=events.at(-1)!;
  const retainedState=(await listRetainedFunds(runtime,demo.propertyId,{status:'ALL'})).items[0]!;
  expect(retainedState.remainingMinor).toBe(0);
  expect(BigInt(events[1]!.billVersion)<BigInt(newest.billVersion)).toBe(true);
 });

 it("emits release only when a real reversal confirms and supports exact replay",async()=>{
  const source=await order(1),bill=await syncedBill();
  const collection=await execute({commandType:'RECORD_COLLECTION',input:{propertyId:demo.propertyId,orderId:source,externalPaymentBillId:bill.id,amountMinor:60000,method:'WECOM',transactionReference:'parent',note:'撤销测试'}});
  const before=await readPaymentAllocationEvents(runtime,demo.propertyId);
  const reversed=await execute({commandType:'REVERSE_FACT',input:{propertyId:demo.propertyId,orderId:source,reversesFactId:collection.receipt.factRefs[0]!,releaseExternalPaymentAllocation:true,note:'核对分配错误'}});
  const after=await readPaymentAllocationEvents(runtime,demo.propertyId,before.nextCursor);
  expect(after.events.map(e=>e.eventType)).toEqual(['ALLOCATION_RELEASED']);
  expect(after.events[0]?.stateReference).toMatchObject({billId:bill.id,status:'ALL'});
  await reversed.replay();
  expect(await readPaymentAllocationEvents(runtime,demo.propertyId,before.nextCursor)).toEqual(after);
  expect((await listPaymentAllocations(runtime,demo.propertyId,{kind:'COLLECTION',billId:bill.id,status:'ALL'})).items[0]?.remainingMinor).toBe(100000);
 });
 it("rolls back publication and never makes uncommitted evidence deliverable",async()=>{
  await insertBill('rollback-publication').execute(db);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  await expect(db.transaction().execute(async trx=>{
   await publishPaymentAllocationEvents(trx,demo.propertyId,config.sourceInstance);
   throw Error('rollback-publication');
  })).rejects.toThrow('rollback-publication');
  expect((await sql<{n:string}>`SELECT count(*)::text n FROM allocation_deliveries`.execute(db)).rows[0]?.n).toBe('0');
  expect(await publishPaymentAllocationEvents(worker,demo.propertyId,config.sourceInstance)).toBe(1);
  await expect(publishPaymentAllocationEvents(worker,demo.propertyId,'wrong-source')).rejects.toThrow();
 });

 it("captures meaningful source changes but ignores polling timestamps and deduplicates repeated publication",async()=>{
  await insertBill('source-changes').execute(db);
  await sql`UPDATE external_payment_bills SET updated_at=clock_timestamp() WHERE id='source-changes'`.execute(db);
  expect((await readPaymentAllocationEvents(runtime,demo.propertyId)).events).toHaveLength(1);
  await sql`UPDATE external_payment_bills SET needs_review=true WHERE id='source-changes'`.execute(db);
  expect((await readPaymentAllocationEvents(runtime,demo.propertyId)).events.map(e=>e.eventType)).toEqual(['DISCOVERED','SOURCE_CHANGED']);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  expect((await Promise.all([publishPaymentAllocationEvents(worker,demo.propertyId,config.sourceInstance),publishPaymentAllocationEvents(worker,demo.propertyId,config.sourceInstance)])).reduce((a,b)=>a+b,0)).toBe(2);
  expect((await sql<{n:string}>`SELECT count(*)::text n FROM allocation_deliveries`.execute(db)).rows[0]?.n).toBe('2');
 });
 it("rejects mismatched acknowledgements and exhausts retries without modifying durable payload bytes",async()=>{
  await insertBill('ack').execute(db);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  await publishPaymentAllocationEvents(worker,demo.propertyId,config.sourceInstance);
  await sql`SELECT qintopia_allocation_delivery_control('RESUME','TEST')`.execute(db);
  await deliverOnePaymentAllocation(worker,config,async()=>({status:202,body:JSON.stringify({status:'accepted',event_id:'wrong',receipt_id:'wrong'}),retryAfter:null}));
  expect((await sql<{state:string;last_error_code:string}>`SELECT state,last_error_code FROM allocation_deliveries`.execute(db)).rows[0]).toEqual({state:'pending',last_error_code:'ACK_MISMATCH'});
  await sql`UPDATE allocation_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second',first_attempt_at=clock_timestamp()-interval '25 hours'`.execute(db);
  await deliverOnePaymentAllocation(worker,config,async()=>{throw Error('timeout');});
  expect((await sql<{state:string;last_error_code:string}>`SELECT state,last_error_code FROM allocation_deliveries`.execute(db)).rows[0]).toEqual({state:'dead_letter',last_error_code:'RETRY_EXHAUSTED'});
 });
 it("starts the opt-in v2 process under its dedicated identity and exits gracefully without touching v1",async()=>{
  await insertBill('process').execute(db);
  await sql`INSERT INTO allocation_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  const url=new URL(eventsDatabaseUrl);url.username='qintopia_allocation_delivery_worker';url.password='';
  const child=spawn(process.execPath,['--import','tsx','packages/db/src/payment-event-worker-main.ts'],{env:{...process.env,
   PMS_PAYMENT_DELIVERY_ENABLED:'true',PMS_PAYMENT_DELIVERY_SCHEMA_VERSION:'pms.payments.v2',PMS_PAYMENT_DELIVERY_DATABASE_URL:url.toString(),
   PMS_PAYMENT_DELIVERY_ENDPOINT:config.endpoint,PMS_PAYMENT_SOURCE_INSTANCE:config.sourceInstance,PMS_PAYMENT_PROPERTY_IDS:demo.propertyId,
   PMS_PAYMENT_KEY_ID:config.keyId,PMS_PAYMENT_SIGNING_KEY:config.signingKey},stdio:['ignore','pipe','pipe']});
  let output='';let sentStop=false;
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),12000);
  child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('PAYMENT_DELIVERY_TICK')&&!sentStop){sentStop=true;child.kill('SIGTERM');}});
  child.stderr.on('data',chunk=>{output+=String(chunk);});
  try {expect(await exited,output).toBe(0);expect(sentStop,output).toBe(true);} finally {clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  expect((await sql<{n:string}>`SELECT count(*)::text n FROM allocation_deliveries`.execute(db)).rows[0]?.n).toBe('1');
  expect((await sql<{n:string}>`SELECT count(*)::text n FROM payment_deliveries`.execute(db)).rows[0]?.n).toBe('0');
 },20000);

 it("applies 070 over already persisted v1 deliveries without changing their bytes or replaying history",async()=>{
  await syncedBill();
  await sql`INSERT INTO payment_delivery_source(source_instance) VALUES('pre-v2-source')`.execute(db);
  await publishPaymentEvents(db,demo.propertyId,'pre-v2-source');
  const bytes=(await sql`SELECT * FROM payment_delivery_events ORDER BY sequence`.execute(db)).rows;
  const feed=(await sql`SELECT * FROM external_payment_events ORDER BY sequence`.execute(db)).rows;
  expect(bytes.length).toBeGreaterThan(0);
  const migration=await readFile(new URL('../../packages/db/src/migrations/070_payment_allocation_events.sql',import.meta.url),'utf8');
  await db.transaction().execute(async trx=>{
   // Only remove this extension inside the dedicated fixture, recreating the 069-to-070 boundary.
   await sql`DROP FUNCTION qintopia_allocation_capture() CASCADE`.execute(trx);
   await sql`DROP FUNCTION qintopia_allocation_emit(text,text,text)`.execute(trx);
   await sql`DROP FUNCTION qintopia_allocation_delivery_immutable() CASCADE`.execute(trx);
   await sql`DROP FUNCTION qintopia_allocation_delivery_publish(text,text)`.execute(trx);
   await sql`DROP FUNCTION qintopia_allocation_delivery_control(text,text,text)`.execute(trx);
   await sql`DROP TABLE allocation_delivery_audit,allocation_deliveries,allocation_delivery_events,allocation_delivery_source,payment_allocation_events,payment_allocation_heads`.execute(trx);
   await sql.raw(migration).execute(trx);
   expect((await sql`SELECT * FROM payment_delivery_events ORDER BY sequence`.execute(trx)).rows).toEqual(bytes);
   expect((await sql`SELECT * FROM external_payment_events ORDER BY sequence`.execute(trx)).rows).toEqual(feed);
   expect((await readPaymentAllocationEvents(trx,demo.propertyId)).events).toEqual([]);
   expect(await allocationDeliveryReady(trx)).toBe(true);
   expect(await paymentDeliveryReady(trx)).toBe(true);
  });
 });

});
