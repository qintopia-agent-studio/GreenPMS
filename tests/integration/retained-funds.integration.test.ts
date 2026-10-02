import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview, createDatabase, type Database } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { listRetainedFunds } from "../../packages/db/src/retained-funds.ts";
import { listPaymentAllocations } from "../../packages/db/src/payment-allocation.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";

// Dedicated synthetic database on the same server as the existing test suite.
const defaultDatabaseUrl = new URL(testDatabaseUrl);
defaultDatabaseUrl.pathname = "/qintopia_retained_funds_test";
const databaseUrl = process.env.RETAINED_FUNDS_TEST_DATABASE_URL ?? defaultDatabaseUrl.toString();
let db: Kysely<Database>;
let runtime: Kysely<Database>;
let sequence = 0;
const principal: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "retained-session", credentialType: "SESSION", displayName: "资金验收", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
const now = new Date("2026-10-02T02:00:00Z");
const meta = () => ({ idempotencyKey: `retained-${++sequence}`, correlationId: `retained-${sequence}` });
const prepare = (command: CommandEnvelope) => createCommandPreview(runtime, principal, command, meta());
function confirm(command: CommandEnvelope, prepared: Awaited<ReturnType<typeof prepare>>, metadata = meta()) {
  return confirmCommandPreview(runtime, principal, prepared.preview.previewId, { propertyId: demo.propertyId, commandType: command.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
    reason: command.commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : { code: "ALLOCATION_TEST", note: "核对真实同步来源" } }, metadata);
}
async function execute(command: CommandEnvelope) {
  const receipt = await confirm(command, await prepare(command));
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}
async function rejected(action: () => Promise<Awaited<ReturnType<typeof confirm>>>) {
  // Both preview rejection and a noncommitted confirmation receipt are supported errors.
  const result = await action().then(value => ({ value }), error => ({ error }));
  if ("value" in result) expect(result.value.businessCommitted).toBe(false);
  else expect(result.error).toBeTruthy();
}
async function order(day: number, amount: number, unit: string = demo.roomId) {
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: unit, stayType: "TRANSIENT", arrivalDate: `2028-12-${String(day).padStart(2, "0")}`, departureDate: `2028-12-${String(day + 1).padStart(2, "0")}`, pricingPolicyVersionId: demo.transientPolicyId });
  return (await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: "分配测试客人", nickname: "合成测试", phone: "13800001234" }, bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: amount, manualPriceAdjustmentReason: "合成资金验收协议价" } })).result!.orderId as string;
}
function bill(reference: string, amountMinor = 100000, overrides: Partial<WecomBill> = {}): WecomBill {
  return { kind: "COLLECTION", merchantId: "m1", reference, originalTradeNo: `trade-${reference}`, transactionId: reference, externalUserId: "customer", collectorId: "staff", amountMinor, occurredAt: new Date(now.getTime() - 60000), state: "SUCCESS", ...overrides };
}
async function sync(rows: WecomBill[]) {
  const client: PaymentClient = { bills: async (begin, end) => ({ bills: rows.filter(row => row.occurredAt >= begin && row.occurredAt <= end), nextCursor: null }), nickname: async () => "付款客户" };
  await syncWecomSource(db, "allocation-source", client, now);
}
async function payment(reference: string, kind: "COLLECTION" | "REFUND" = "COLLECTION") {
  const result = await listPaymentAllocations(runtime, demo.propertyId, { kind, status: "ALL" });
  const item = result.items.find(item => item.reference === reference);
  expect(item).toBeDefined();
  return item!;
}
const collect = (orderId: string, billId: string, amountMinor: number): CommandEnvelope => ({ commandType: "RECORD_COLLECTION", input: { propertyId: demo.propertyId, orderId, externalPaymentBillId: billId, amountMinor, method: "WECOM", transactionReference: "parent", note: "合付分配" } });
async function facts() { return db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute(); }
async function split() {
  const a = await order(1, 40000), b = await order(3, 60000);
  await sync([bill("parent")]);
  const p = await payment("parent");
  const ca = await execute(collect(a, p.id, 40000));
  const cb = await execute(collect(b, p.id, 60000));
  return { a, b, p, fa: ca.factRefs[0]!, fb: cb.factRefs[0]! };
}

beforeEach(async () => {
  vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "true");
  db = await resetDatabase(databaseUrl);
  await db.insertInto("web_sessions").values({ id: principal.credentialId, subject_id: principal.subjectId, secret_hash: "a".repeat(64), expires_at: new Date(Date.now() + 3600000), revoked_at: null }).execute();
  runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete) VALUES('allocation-source','corp',true,${new Date("2026-09-01T00:00:00Z")},${new Date("2026-09-01T00:00:00Z")},${new Date(now.getTime()-120000)},true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('allocation-source','m1',${demo.propertyId})`.execute(db);
});
afterEach(async () => { await runtime?.destroy(); await db?.destroy(); vi.unstubAllEnvs(); });

async function available(status: "AVAILABLE" | "ALL" = "AVAILABLE") {
  return listRetainedFunds(runtime, demo.propertyId, { status });
}
async function fixture() {
  const splitResult = await split();
  await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: splitResult.b } });
  const before = await facts();
  await execute({ commandType: "RETAIN_ORDER_FUNDS", input: { propertyId: demo.propertyId, orderId: splitResult.b, sourceFactId: splitResult.fb, amountMinor: 60000, ownerName: "付款归属客户", ownerContact: "13800001234", confirmationNote: "已向原付款人核实，客户要求保留用于下次住宿" } });
  expect(await facts()).toEqual(before); // Retaining funds is not a fresh receipt or refund.
  const items = (await available()).items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ sourceOrderId: splitResult.b, sourceFactId: splitResult.fb, billId: splitResult.p.id, amountMinor: 60000, remainingMinor: 60000, usedMinor: 0, refundedMinor: 0, releasedMinor: 0 });
  const c = await order(5, 40000);
  return { ...splitResult, c, retainedId: items[0]!.id };
}
const use = (orderId: string, retainedFundId: string, amountMinor = 40000, authorizationNote = "原付款人已确认授权为另一入住人代订并使用此款"): CommandEnvelope => ({ commandType: "APPLY_RETAINED_FUNDS", input: { propertyId: demo.propertyId, orderId, retainedFundId, amountMinor, authorizationNote } });
async function ledger() {
  return (await sql<{ fact_type: string; amount_minor: number; net_effect_minor: number; order_id: string; command_id: string; references_fact_id: string | null }>`SELECT fact_type,amount_minor,net_effect_minor,order_id,command_id,references_fact_id FROM collection_facts ORDER BY fact_id`.execute(db)).rows;
}
async function assertUsed(retainedId: string, b: string, c: string, sourceFactId: string) {
  expect((await available()).items.find(item => item.id === retainedId)).toMatchObject({ amountMinor: 60000, usedMinor: 40000, remainingMinor: 20000 });
  const rows = await ledger();
  expect(rows.filter(row => row.fact_type === "COLLECTION").reduce((sum, row) => sum + row.amount_minor, 0)).toBe(100000);
  expect(rows.filter(row => row.fact_type === "REFUND")).toHaveLength(0);
  const out = rows.filter(row => row.fact_type === "REALLOCATION_OUT"), incoming = rows.filter(row => row.fact_type === "REALLOCATION_IN");
  expect(out).toHaveLength(1); expect(incoming).toHaveLength(1);
  expect(out[0]).toMatchObject({ order_id: b, amount_minor: 40000, net_effect_minor: -40000, references_fact_id: sourceFactId });
  expect(incoming[0]).toMatchObject({ order_id: c, amount_minor: 40000, net_effect_minor: 40000, command_id: out[0]!.command_id, references_fact_id: sourceFactId });
  expect(rows.reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(100000);
  expect(rows.filter(row => row.order_id === b).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(20000);
  expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
}

describe("retained funds through real Preview/Confirm", () => {
  it("lists cancelled B's 60000 and uses 40000 for an authorized new booking without duplicating cash", async () => {
    const { b, c, fb, retainedId } = await fixture();
    expect((await listRetainedFunds(runtime, demo.propertyId, { status: "AVAILABLE", query: "13800001234", orderId: b })).items.map(item => item.id)).toContain(retainedId);
    await execute(use(c, retainedId));
    await assertUsed(retainedId, b, c, fb);
    const entries = (await sql<{ authorization_note: string }>`SELECT authorization_note FROM retained_fund_entries WHERE retained_fund_id=${retainedId} AND kind='USE'`.execute(db)).rows;
    expect(entries).toEqual([{ authorization_note: "原付款人已确认授权为另一入住人代订并使用此款" }]);
  });
  it("refunds the remaining 20000, keeps C's 40000 and removes only the available-list entry", async () => {
    const { b, c, retainedId } = await fixture();
    await execute(use(c, retainedId));
    await sync([bill("retained-refund", 20000, { kind: "REFUND", transactionId: "parent", originalTradeNo: "trade-parent" })]);
    await execute({ commandType: "REFUND_RETAINED_FUNDS", input: { propertyId: demo.propertyId, orderId: b, retainedFundId: retainedId, amountMinor: 20000, externalPaymentBillId: (await payment("retained-refund", "REFUND")).id, refundReference: "retained-refund", note: "原付款人要求退回剩余留存" } });
    expect((await available()).items).toHaveLength(0);
    expect((await available("ALL")).items.find(item => item.id === retainedId)).toMatchObject({ usedMinor: 40000, refundedMinor: 20000, remainingMinor: 0 });
    const rows = await ledger();
    expect(rows.filter(row => row.order_id === c).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(40000);
    expect(rows.filter(row => row.order_id === b).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    expect(rows.reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(80000);
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
  });
  it("releases unused retention back to B's pending funds, not to public allocation capacity", async () => {
    const { b, c, retainedId } = await fixture(); await execute(use(c, retainedId));
    const before = await facts();
    await execute({ commandType: "RELEASE_RETAINED_FUNDS", input: { propertyId: demo.propertyId, orderId: b, retainedFundId: retainedId, amountMinor: 20000, note: "客户不再留存，等待另行退款核对" } });
    expect(await facts()).toEqual(before);
    expect((await available()).items).toHaveLength(0);
    expect((await available("ALL")).items.find(item => item.id === retainedId)).toMatchObject({ usedMinor: 40000, releasedMinor: 20000, remainingMinor: 0 });
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
  });
  it("requires nonblank authorizationNote before moving funds", async () => {
    const { c, retainedId } = await fixture();
    const before = await facts();
    for (const note of ["", "   "]) {
      const command = use(c, retainedId, 40000, note);
      await expect(prepare(command)).rejects.toBeTruthy();
    }
    expect(await facts()).toEqual(before);
    expect((await available()).items[0]).toMatchObject({ remainingMinor: 60000, usedMinor: 0 });
    expect((await sql`SELECT * FROM retained_fund_entries`.execute(db)).rows).toHaveLength(0);
  });
  it("is idempotent and permits only one of two concurrent 40000 uses", async () => {
    const { c, retainedId } = await fixture(), d = await order(7, 40000);
    const ca = use(c, retainedId), cb = use(d, retainedId);
    const pa = await prepare(ca), pb = await prepare(cb), ma = meta(), mb = meta();
    const results = await Promise.allSettled([confirm(ca, pa, ma), confirm(cb, pb, mb)]);
    const committed = results.map((r, index) => ({ r, index })).filter(({ r }) => r.status === "fulfilled" && r.value.businessCommitted);
    expect(committed).toHaveLength(1);
    const winner = committed[0]!.index;
    const replay = await confirm(winner === 0 ? ca : cb, winner === 0 ? pa : pb, winner === 0 ? ma : mb);
    expect(replay.businessCommitted).toBe(true);
    expect((await available()).items[0]).toMatchObject({ usedMinor: 40000, remainingMinor: 20000 });
    expect((await sql`SELECT * FROM retained_fund_entries WHERE kind='USE'`.execute(db)).rows).toHaveLength(1);
    expect((await ledger()).filter(row => row.fact_type === "REALLOCATION_IN")).toHaveLength(1);
    expect((await ledger()).filter(row => row.fact_type === "REALLOCATION_OUT")).toHaveLength(1);
  });
  it("rejects stale use after release and leaves no unilateral transfer", async () => {
    const { b, c, retainedId } = await fixture();
    const command = use(c, retainedId), preview = await prepare(command);
    await execute({ commandType: "RELEASE_RETAINED_FUNDS", input: { propertyId: demo.propertyId, orderId: b, retainedFundId: retainedId, amountMinor: 60000, note: "撤销误标" } });
    const before = await facts();
    await rejected(() => confirm(command, preview));
    expect(await facts()).toEqual(before);
    expect((await available("ALL")).items[0]).toMatchObject({ remainingMinor: 0, releasedMinor: 60000, usedMinor: 0 });
  });
  it("keeps reads and reservations when new writes are disabled", async () => {
    const { b, c, retainedId } = await fixture();
    vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "false");
    expect(await available()).toMatchObject({ enabled: false, items: [{ id: retainedId, remainingMinor: 60000 }] });
    await expect(prepare(use(c, retainedId))).rejects.toThrow(/启用/);
    expect((await facts()).filter(f => f.order_id === b).reduce((sum, f) => sum + f.net_effect_minor, 0)).toBe(60000);
  });
  it("preserves the original owner after the destination cancels and retains its share again", async () => {
    const { b, c, retainedId } = await fixture();
    const used = await execute(use(c, retainedId));
    const incoming = (await facts()).find(f => f.order_id === c && f.fact_type === "REALLOCATION_IN")!;
    expect(used.factRefs).toContain(incoming.fact_id);
    await execute({commandType:"CANCEL_ORDER",input:{propertyId:demo.propertyId,orderId:c}});
    const retain: CommandEnvelope = {commandType:"RETAIN_ORDER_FUNDS",input:{propertyId:demo.propertyId,orderId:c,sourceFactId:incoming.fact_id,amountMinor:40000,
      ownerName:"付款归属客户",ownerContact:"13800001234",confirmationNote:"代订取消，原归属人要求再次留存"}};
    await expect(prepare({...retain,input:{...retain.input as Record<string,unknown>,ownerName:"代订入住人"}})).rejects.toThrow(/原款项归属/);
    await execute(retain);
    const lots=(await available()).items;
    expect(lots.find(l => l.id === retainedId)).toMatchObject({sourceOrderId:b,usedMinor:40000,remainingMinor:20000});
    expect(lots.find(l => l.sourceOrderId === c)).toMatchObject({ownerName:"付款归属客户",amountMinor:40000,remainingMinor:40000});
    expect((await facts()).filter(f=>f.fact_type==="COLLECTION").reduce((sum,f)=>sum+f.amount_minor,0)).toBe(100000);
  });
  it("fully releasing an unused retention permits explicit allocation correction without erasing history", async () => {
    const { b, fb, retainedId } = await fixture();
    await execute({commandType:"RELEASE_RETAINED_FUNDS",input:{propertyId:demo.propertyId,orderId:b,retainedFundId:retainedId,amountMinor:60000,note:"误标留存，核对后解除"}});
    await execute({commandType:"REVERSE_FACT",input:{propertyId:demo.propertyId,orderId:b,reversesFactId:fb,releaseExternalPaymentAllocation:true,note:"纠正原订单归属"}});
    expect(await payment("parent")).toMatchObject({remainingMinor:60000});
    expect((await available("ALL")).items[0]).toMatchObject({remainingMinor:0,releasedMinor:60000});
  });
  it("cannot double-reserve, bypass retention via ordinary refund or expose another property's retained funds", async () => {
    const { b, c, fb, retainedId } = await fixture();
    const before = await facts();
    const duplicate: CommandEnvelope = { commandType: "RETAIN_ORDER_FUNDS", input: { propertyId: demo.propertyId, orderId: b, sourceFactId: fb, amountMinor: 1, ownerName: "付款归属客户", ownerContact: "13800001234", confirmationNote: "重复预留应拒绝" } };
    await expect(prepare(duplicate)).rejects.toBeTruthy();
    expect((await listRetainedFunds(runtime, "foreign-property", { status: "ALL" })).items).toEqual([]);
    const foreign = { ...principal, subjectId: "foreign-subject", ...authScope({ propertyId: "foreign-property", credentialType: "SESSION", profile: "administrator" }) };
    await expect(createCommandPreview(runtime, foreign, use(c, retainedId), meta())).rejects.toBeTruthy();
    await sync([bill("ordinary-refund", 60000, { kind: "REFUND", transactionId: "parent", originalTradeNo: "trade-parent" })]);
    const direct: CommandEnvelope = { commandType: "RECORD_REFUND", input: { propertyId: demo.propertyId, orderId: b, referencesFactId: fb, externalPaymentBillId: (await payment("ordinary-refund", "REFUND")).id, amountMinor: 60000, method: "WECOM", refundReference: "ordinary-refund", note: "不能绕过留存占用" } };
    await expect(prepare(direct)).rejects.toBeTruthy();
    expect(await facts()).toEqual(before);
    expect((await available("ALL")).items[0]).toMatchObject({ amountMinor: 60000, usedMinor: 0, remainingMinor: 60000 });
  });
});
