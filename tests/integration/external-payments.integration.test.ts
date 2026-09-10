import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview, createDatabase, databaseReady, type Database } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { externalPaymentBasis, listExternalPayments, readExternalPaymentEvents } from "../../packages/db/src/external-payments.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import { type WecomBill } from "../../packages/db/src/wecom-client.ts";
import { externalPaymentsReady } from "../../packages/db/src/external-payments-readiness.ts";
import { buildServer } from "../../apps/api/src/server.ts";

let db: Kysely<Database>;
let runtime: Kysely<Database>;
let sequence = 0;
const principal: AuthPrincipal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write", credentialType: "TOKEN", displayName: "Test", ...authScope() };
const now = new Date("2026-09-10T02:00:00Z");
const boundary = new Date("2026-08-31T16:00:00Z");
const meta = () => ({ idempotencyKey: `wecom-${++sequence}`, correlationId: `wecom-${sequence}` });
function bill(reference: string, overrides: Partial<WecomBill> = {}): WecomBill {
  return { kind: "COLLECTION", merchantId: "m1", reference, originalTradeNo: `trade-${reference}`, transactionId: reference,
    externalUserId: "customer1", collectorId: "staff1", amountMinor: 12000, occurredAt: new Date(now.getTime()-60000), state: "SUCCESS", ...overrides };
}
function fakeClient(rows: WecomBill[]): PaymentClient {
  return { bills: vi.fn(async (begin,end) => ({ bills: rows.filter(r=>r.occurredAt>=begin && r.occurredAt<=end), nextCursor: null })),
    nickname: vi.fn(async () => "小秦") };
}
async function configure(baseline = true) {
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
    VALUES('source','corp',true,${boundary},${new Date("2026-08-30T16:00:00Z")},${baseline ? new Date(now.getTime()-120000) : null},${baseline})`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('source','m1',${demo.propertyId})`.execute(db);
}
async function prepare(command: CommandEnvelope) { return createCommandPreview(runtime, principal, command, meta()); }
async function confirm(command: CommandEnvelope, prepared: Awaited<ReturnType<typeof prepare>>) {
  return confirmCommandPreview(runtime, principal, prepared.preview.previewId, { propertyId: demo.propertyId,
    commandType: command.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
    reason: command.commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : { code: "WECOM_TEST", note: "核对企微流水" } }, meta());
}
async function execute(command: CommandEnvelope) {
  const receipt = await confirm(command, await prepare(command));
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}
async function order(day: number) {
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT",
    arrivalDate: `2028-12-${String(day).padStart(2,"0")}`, departureDate: `2028-12-${String(day+1).padStart(2,"0")}`, pricingPolicyVersionId: demo.transientPolicyId });
  const result = await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId,
    primaryGuest: { fullName: "同步测试客人", nickname: "小秦" }, bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits } });
  return result.result!.orderId as string;
}
const collection = (orderId: string, reference: string, amountMinor = 12000): CommandEnvelope => ({ commandType: "RECORD_COLLECTION",
  input: { propertyId: demo.propertyId, orderId, amountMinor, method: "WECOM", transactionReference: reference, note: "测试收款" } });

beforeEach(async () => {
  if (!new URL(testDatabaseUrl).pathname.startsWith("/qintopia_wecom_")) throw Error("Use a dedicated qintopia_wecom_ TEST_DATABASE_URL");
  db = await resetTestDatabase(); runtime = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
});
afterEach(async () => { await runtime?.destroy(); await db?.destroy(); });

describe("external payment synchronization and atomic matching", () => {
  it("passes readiness and limits the worker to synchronized data", async () => {
    expect(await externalPaymentsReady(db)).toBe(true);
    expect(await databaseReady(db, { identity: "maintenance-owner", staffProfileManifestName: "demo" })).toBe(true);
    await configure();
    await db.connection().execute(async c => {
      await sql`SET ROLE qintopia_payment_worker`.execute(c);
      try {
        await syncWecomSource(c, "source", fakeClient([bill("worker")] ), now);
        await expect(sql`SELECT * FROM collection_facts`.execute(c)).rejects.toMatchObject({ code: "42501" });
        await expect(sql`INSERT INTO external_payment_matches(bill_id,origin) VALUES('x','CONFIRMED')`.execute(c)).rejects.toMatchObject({ code: "42501" });
      } finally { await sql`RESET ROLE`.execute(c); }
    });
    await sql`ALTER TABLE external_payment_matches DISABLE TRIGGER external_payment_match_guard`.execute(db);
    expect(await externalPaymentsReady(db)).toBe(false);
  });
  it("imports the baseline without alerts and keeps older money out of candidates", async () => {
    await configure(false);
    const client = fakeClient([bill("history", { occurredAt: new Date("2026-08-31T15:59:59Z") }),
      bill("boundary", { occurredAt: boundary }), bill("baseline")]);
    await syncWecomSource(db, "source", client, now); // bounded catch-up
    await syncWecomSource(db, "source", client, now);
    await syncWecomSource(db, "source", client, now);
    expect((await readExternalPaymentEvents(runtime,demo.propertyId,"0")).events).toHaveLength(0);
    const all = await listExternalPayments(runtime,demo.propertyId,{kind:"COLLECTION",status:"ALL"});
    expect(all.items.find(i=>i.reference==="history")?.status).toBe("HISTORICAL");
    expect(all.items.find(i=>i.reference==="boundary")?.status).toBe("AVAILABLE");
    expect(await db.selectFrom("collection_facts").selectAll().execute()).toHaveLength(0);
  });
  it("follows cursors even with an empty page, retries a failed window and deduplicates events", async () => {
    await configure();
    const fetchPage = vi.fn<PaymentClient["bills"]>().mockResolvedValueOnce({bills:[],nextCursor:"page2"})
      .mockRejectedValueOnce(new Error("network"));
    const client = { bills: fetchPage, nickname: vi.fn(async()=>{throw Error("not a contact")}) };
    await expect(syncWecomSource(db,"source",client,now)).rejects.toThrow();
    expect((await sql<{synced_until:Date}>`SELECT synced_until FROM external_payment_sources`.execute(db)).rows[0]?.synced_until)
      .toEqual(new Date(now.getTime()-120000));
    fetchPage.mockImplementation(async (_a,_b,cursor)=>cursor ? {bills:[bill("paged")],nextCursor:null} : {bills:[],nextCursor:"page2"});
    await syncWecomSource(db,"source",client,now); await syncWecomSource(db,"source",client,now);
    expect((await listExternalPayments(runtime,demo.propertyId,{kind:"COLLECTION"})).items).toHaveLength(1);
    expect((await readExternalPaymentEvents(runtime,demo.propertyId,"0")).events).toHaveLength(1);
  });
  it("serializes source synchronization across processes", async () => {
    await configure();
    await db.connection().execute(async c => {
      await sql`SELECT pg_advisory_lock(hashtextextended('wecom:source',0))`.execute(c);
      try { expect((await syncWecomSource(db,"source",fakeClient([]),now)).skipped).toBe(true); }
      finally { await sql`SELECT pg_advisory_unlock(hashtextextended('wecom:source',0))`.execute(c); }
    });
  });
  it("keeps selection unreserved and allows only one concurrent financial match", async () => {
    const a = await order(1), b = await order(3);
    await configure(); await syncWecomSource(db,"source",fakeClient([bill("race")]),now);
    const ca=collection(a,"race"), cb=collection(b,"race");
    const pa=await prepare(ca), pb=await prepare(cb);
    expect((await listExternalPayments(runtime,demo.propertyId,{kind:"COLLECTION"})).items).toHaveLength(1);
    const results=await Promise.allSettled([confirm(ca,pa),confirm(cb,pb)]);
    expect(results.filter(r=>r.status==="fulfilled" && r.value.businessCommitted)).toHaveLength(1);
    expect(await db.selectFrom("collection_facts").selectAll().execute()).toHaveLength(1);
    expect((await listExternalPayments(runtime,demo.propertyId,{kind:"COLLECTION"})).items).toHaveLength(0);
    expect((await readExternalPaymentEvents(runtime,demo.propertyId,"0")).events.map(e=>e.eventType)).toEqual(["DISCOVERED","MATCHED"]);
  });
  it("rejects changed amounts and rolls back both facts and matching on failure", async () => {
    const id=await order(1); await configure(); await syncWecomSource(db,"source",fakeClient([bill("atomic")]),now);
    await expect(prepare(collection(id,"atomic",100))).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    const cmd=collection(id,"atomic"), prepared=await prepare(cmd);
    await sql`CREATE FUNCTION test_reject_payment_match() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test failure''; END;'`.execute(db);
    await sql`CREATE TRIGGER test_reject BEFORE INSERT ON external_payment_matches FOR EACH ROW EXECUTE FUNCTION test_reject_payment_match()`.execute(db);
    await confirm(cmd,prepared).catch(()=>{});
    expect(await db.selectFrom("collection_facts").selectAll().execute()).toHaveLength(0);
    expect((await sql`SELECT * FROM external_payment_matches`.execute(db)).rows).toHaveLength(0);
  });
  it("stores distinct refund IDs and rejects a refund against a different original payment", async () => {
    const id=await order(1); await configure();
    await syncWecomSource(db,"source",fakeClient([bill("parent")]),now);
    const original=await execute(collection(id,"parent"));
    const refund=bill("refund1",{kind:"REFUND",transactionId:"parent",originalTradeNo:"trade-parent",amountMinor:3000});
    await syncWecomSource(db,"source",fakeClient([refund,bill("refund2",{...refund,reference:"refund2",amountMinor:2000}),
      bill("wrong",{...refund,reference:"wrong",transactionId:"different"})]),now);
    const input={propertyId:demo.propertyId,orderId:id,amountMinor:3000,method:"WECOM",referencesFactId:original.factRefs[0],note:"退还差额"};
    await expect(prepare({commandType:"RECORD_REFUND",input})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(prepare({commandType:"RECORD_REFUND",input:{...input,refundReference:"wrong"}})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    const r=await execute({commandType:"RECORD_REFUND",input:{...input,refundReference:"refund1"}});
    expect(r.result).toMatchObject({refundReference:"refund1",transactionReference:null});
    await execute({commandType:"RECORD_REFUND",input:{...input,amountMinor:2000,refundReference:"refund2"}});
    const refunds=await db.selectFrom("collection_facts").selectAll().where("fact_type","=","REFUND").execute();
    expect(refunds.map(r=>r.refund_reference).sort()).toEqual(["refund1","refund2"]);
    expect(refunds.every(r=>r.references_fact_id===original.factRefs[0])).toBe(true);
    await expect(prepare({commandType:"RECORD_REFUND",input:{...input,refundReference:"refund1"}})).rejects.toMatchObject({code:"AGGREGATE_VERSION_CONFLICT"});
    const app=await buildServer(runtime);
    try {
      const response=await app.inject({method:"GET",url:`/api/v1/facts/${r.factRefs[0]}`,headers:{authorization:`Bearer ${demo.readToken}`}});
      expect(response.statusCode,response.body).toBe(200);
      expect(response.json()).toMatchObject({refund_reference:"refund1",references_fact_id:original.factRefs[0],order_id:id});
    } finally {await app.close();}
  });
  it("does not let a standalone placeholder overwrite a verified refund", async () => {
    await configure();
    const verified=bill("r",{kind:"REFUND",transactionId:"parent",amountMinor:3000});
    const placeholder={...verified,transactionId:null,amountMinor:null,state:"UNKNOWN" as const};
    await syncWecomSource(db,"source",fakeClient([verified,placeholder]),now);
    expect((await listExternalPayments(runtime,demo.propertyId,{kind:"REFUND"})).items[0]).toMatchObject({reference:"r",amountMinor:3000,status:"AVAILABLE"});
  });
  it("links existing manual records without creating another financial fact or reminder", async () => {
    const id=await order(1); await execute(collection(id,"manual"));
    await configure(); await syncWecomSource(db,"source",fakeClient([bill("manual")]),now);
    expect(await db.selectFrom("collection_facts").selectAll().execute()).toHaveLength(1);
    expect((await listExternalPayments(runtime,demo.propertyId,{kind:"COLLECTION",status:"ALL"})).items[0]?.status).toBe("MATCHED");
    expect((await readExternalPaymentEvents(runtime,demo.propertyId,"0")).events).toHaveLength(0);
  });
  it("marks legacy refunds without IDs for review without guessing a match", async () => {
    const id=await order(1); const original=await execute(collection(id,"legacy-parent"));
    // Recreate an already existing pre-059 fact; the new-write guard stays active afterwards.
    await sql`ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_validate_refund_reference`.execute(db);
    const refund=await execute({commandType:"RECORD_REFUND",input:{propertyId:demo.propertyId,orderId:id,amountMinor:3000,
      method:"WECOM",refundReference:"old-refund",referencesFactId:original.factRefs[0],note:"原有退款"}});
    // A maintenance-only fixture bypass preserves the old append-only semantics in production.
    await db.transaction().execute(async trx=>{
      await sql`SET LOCAL session_replication_role=replica`.execute(trx);
      await sql`UPDATE collection_facts SET refund_reference=NULL WHERE fact_id=${refund.factRefs[0]}`.execute(trx);
    });
    await sql`ALTER TABLE collection_facts ENABLE TRIGGER collection_facts_validate_refund_reference`.execute(db);
    await configure(); await syncWecomSource(db,"source",fakeClient([bill("legacy-refund",{kind:"REFUND",transactionId:"legacy-parent",amountMinor:3000})]),now);
    expect((await listExternalPayments(runtime,demo.propertyId,{kind:"REFUND",status:"ALL"})).items[0]?.status).toBe("REVIEW");
    expect((await readExternalPaymentEvents(runtime,demo.propertyId,"0")).events).toHaveLength(0);
    expect(await db.selectFrom("collection_facts").selectAll().execute()).toHaveLength(2);
  });
  it("matches member payments and prevents reuse as lodging money", async () => {
    const id=await order(1);
    const member=await execute({commandType:"CREATE_MEMBER",input:{propertyId:demo.propertyId,fullName:"会员测试",nickname:"小秦",phone:"13912349876",wechat:"test-member"}});
    const membership=await execute({commandType:"CREATE_MEMBERSHIP_ORDER",input:{propertyId:demo.propertyId,memberId:member.result!.memberId,
      membershipProductId:"membership_product_shared_bath_single_v1",agreedPriceMinor:162000}});
    await configure(); await syncWecomSource(db,"source",fakeClient([bill("member")]),now);
    const recorded=await execute({commandType:"RECORD_MEMBERSHIP_PAYMENT",input:{propertyId:demo.propertyId,membershipOrderId:membership.result!.membershipOrderId,amountMinor:12000,transactionReference:"member"}});
    let paymentFactId=recorded.result!.paymentFactId;
    for(const note of ["第一次核对备注","第二次核对备注"]){
      const corrected=await execute({commandType:"CORRECT_MEMBERSHIP_PAYMENT",input:{propertyId:demo.propertyId,membershipOrderId:membership.result!.membershipOrderId,
        originalPaymentFactId:paymentFactId,correctedAmountMinor:12000,correctedTransactionReference:"member",note}});
      paymentFactId=corrected.result!.replacementFactId;
    }
    await expect(prepare(collection(id,"member"))).rejects.toMatchObject({code:"AGGREGATE_VERSION_CONFLICT"});
    const matched=(await listExternalPayments(runtime,demo.propertyId,{kind:"COLLECTION",status:"MATCHED"})).items[0];
    expect(matched?.membershipOrderId).toBe(membership.result!.membershipOrderId);
  });
  it("enforces API authentication and property scope for both people and agents", async () => {
    await configure(); await syncWecomSource(db,"source",fakeClient([bill("api")]),now);
    const app=await buildServer(runtime);
    try {
      const path=`/api/v1/external-payments?propertyId=${demo.propertyId}&kind=COLLECTION`;
      expect((await app.inject({method:"GET",url:path})).statusCode).toBe(401);
      const headers={authorization:`Bearer ${demo.readToken}`};
      const response=await app.inject({method:"GET",url:path,headers});
      expect(response.statusCode,response.body).toBe(200); expect(response.json().items).toHaveLength(1);
      expect((await app.inject({method:"GET",url:"/api/v1/external-payments?propertyId=foreign&kind=COLLECTION",headers})).statusCode).toBe(403);
      expect((await app.inject({method:"GET",url:`/api/v1/external-payment-events?propertyId=${demo.propertyId}`,headers})).json().schemaVersion).toBe("pms.payments.v1");
    } finally {await app.close();}
  });
  it("covers the embedded collection command shapes without treating transfer bridges as new payments", async () => {
    await configure(); await syncWecomSource(db,"source",fakeClient([bill("nested")]),now);
    for (const [command,effect] of [
      ["CREATE_ORDER",{backfill:{collection:{method:"WECOM",transactionReference:"nested",amountMinor:12000}}}],
      ["BACKFILL_HISTORICAL_MEMBERSHIP",{payment:{transactionReference:"nested",amount:{minorUnits:12000}}}],
      ["CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",{remainingPayment:{transactionReference:"nested",amount:{minorUnits:12000}}}],
      ["VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",{funds:{replacementDirectPayment:{transactionReference:"nested",amount:{minorUnits:12000}}}}]
    ] as const) expect(await externalPaymentBasis(runtime,demo.propertyId,command,effect)).toHaveLength(1);
    expect(await externalPaymentBasis(runtime,demo.propertyId,"CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",{remainingPayment:null})).toHaveLength(0);
  });
});
