import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview, createDatabase, withPropertyClockForTesting, type Database } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { listPaymentAllocations } from "../../packages/db/src/payment-allocation.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";

// Dedicated synthetic database on the same server as the existing test suite.
const defaultDatabaseUrl = new URL(testDatabaseUrl);
defaultDatabaseUrl.pathname = "/qintopia_payment_allocation_test";
const databaseUrl = process.env.PAYMENT_ALLOCATION_TEST_DATABASE_URL ?? defaultDatabaseUrl.toString();
let db: Kysely<Database>;
let runtime: Kysely<Database>;
let sequence = 0;
const principal: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "allocation-session", credentialType: "SESSION", displayName: "资金验收", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
const now = new Date("2026-10-02T02:00:00Z");
const meta = () => ({ idempotencyKey: `allocation-${++sequence}`, correlationId: `allocation-${sequence}` });
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
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: unit, stayType: "TRANSIENT", arrivalDate: `2028-12-${String(day).padStart(2, "0")}`, departureDate: `2028-12-${String(day + 1).padStart(2, "0")}`, pricingPolicyVersionId: unit === demo.roomId ? demo.transientPolicyId : demo.publicPricingPolicyId });
  return (await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: "分配测试客人", nickname: "合成测试", phone: "13800000000" }, bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: amount, manualPriceAdjustmentReason: "合成资金验收协议价" } })).result!.orderId as string;
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
const refund = (orderId: string, referencesFactId: string, billId: string, amountMinor: number, reference: string): CommandEnvelope => ({ commandType: "RECORD_REFUND", input: { propertyId: demo.propertyId, orderId, referencesFactId, externalPaymentBillId: billId, amountMinor, method: "WECOM", refundReference: reference, note: "实际退款分配" } });
async function facts() { return db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute(); }
async function split(unit: string = demo.roomId) {
  const a = await order(1, 40000, unit), b = await order(3, 60000);
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

describe("payment allocation through real Preview/Confirm", () => {
  it("allocates 100000 as 40000/60000 and keeps the partial bill discoverable", async () => {
    const a = await order(1, 40000), b = await order(3, 60000);
    await sync([bill("parent")]);
    const p = await payment("parent");
    await execute(collect(a, p.id, 40000));
    expect(await payment("parent")).toMatchObject({ allocatedMinor: 40000, remainingMinor: 60000, status: "PARTIALLY_MATCHED" });
    expect((await listPaymentAllocations(runtime, demo.propertyId, { kind: "COLLECTION" })).items.map(item => item.id)).toContain(p.id);
    await execute(collect(b, p.id, 60000));
    const full = await payment("parent");
    expect(full).toMatchObject({ allocatedMinor: 100000, remainingMinor: 0 });
    expect(full.allocations).toHaveLength(2);
    expect(full.allocations).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: a, amountMinor: 40000 }), expect.objectContaining({ orderId: b, amountMinor: 60000 })]));
    expect((await facts()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(100000);
  });
  it("cancels B without releasing cash, then refunds only B's 60000", async () => {
    const { a, b, fb } = await split();
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: b } });
    expect((await facts()).filter(row => row.order_id === b).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(60000);
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
    await sync([bill("refund-b", 60000, { kind: "REFUND", transactionId: "parent", originalTradeNo: "trade-parent" })]);
    await execute(refund(b, fb, (await payment("refund-b", "REFUND")).id, 60000, "refund-b"));
    const rows = await facts();
    expect(rows.filter(row => row.order_id === a).map(row => row.net_effect_minor)).toEqual([40000]);
    expect(rows.filter(row => row.order_id === b).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    expect(rows.reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(40000);
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
  });
  it("splits one successful refund across its original order shares, rejecting cross-order references", async () => {
    const { a, b, fa, fb } = await split();
    await sync([bill("combined", 100000, { kind: "REFUND", transactionId: "parent", originalTradeNo: "trade-parent" })]);
    const r = await payment("combined", "REFUND");
    const before = await facts();
    await rejected(async () => confirm(refund(b, fa, r.id, 40000, "combined"), await prepare(refund(b, fa, r.id, 40000, "combined"))));
    expect(await facts()).toEqual(before);
    await execute(refund(a, fa, r.id, 40000, "combined"));
    expect(await payment("combined", "REFUND")).toMatchObject({ allocatedMinor: 40000, remainingMinor: 60000 });
    await execute(refund(b, fb, r.id, 60000, "combined"));
    expect((await facts()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
  });
  it("releasing a refund attribution returns only the refund to pending and freezes parent reuse", async () => {
    const { b, fb } = await split();
    await sync([bill("refund-correction", 60000, { kind: "REFUND", transactionId: "parent", originalTradeNo: "trade-parent" })]);
    const r = await payment("refund-correction", "REFUND");
    const receipt = await execute(refund(b, fb, r.id, 60000, "refund-correction"));
    await expect(prepare({ commandType: "REVERSE_FACT", input: { propertyId: demo.propertyId, orderId: b,
      reversesFactId: receipt.factRefs[0]!, note: "不能通过普通冲销恢复实际退款" } })).rejects.toThrow(/受控撤销归属/);
    await execute({ commandType: "REVERSE_FACT", input: { propertyId: demo.propertyId, orderId: b,
      reversesFactId: receipt.factRefs[0]!, releaseExternalPaymentAllocation: true, note: "更正退款归属，不撤回实际退款" } });
    expect(await payment("refund-correction", "REFUND")).toMatchObject({ allocatedMinor: 0, remainingMinor: 60000 });
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
    await expect(prepare({ commandType: "REVERSE_FACT", input: { propertyId: demo.propertyId, orderId: b,
      reversesFactId: fb, releaseExternalPaymentAllocation: true, note: "不应释放已有实际退款的收款" } })).rejects.toThrow();
    await execute(refund(b, fb, r.id, 60000, "refund-correction"));
    expect(await payment("refund-correction", "REFUND")).toMatchObject({ remainingMinor: 0 });
    expect((await facts()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(40000);
  });
  it("replays the same confirmation without a second allocation", async () => {
    const a = await order(1, 40000); await sync([bill("parent")]);
    const command = collect(a, (await payment("parent")).id, 40000), preview = await prepare(command), metadata = meta();
    const first = await confirm(command, preview, metadata), replay = await confirm(command, preview, metadata);
    expect(first.businessCommitted).toBe(true); expect(replay.businessCommitted).toBe(true);
    expect(replay.factRefs).toEqual(first.factRefs);
    expect(await facts()).toHaveLength(1);
    expect((await payment("parent")).allocations).toHaveLength(1);
  });
  it("rejects stale previews after another order spends the source balance", async () => {
    const a = await order(1, 60000), b = await order(3, 60000); await sync([bill("parent")]);
    const p = await payment("parent"), staleCommand = collect(b, p.id, 60000), stale = await prepare(staleCommand);
    await execute(collect(a, p.id, 60000));
    await rejected(() => confirm(staleCommand, stale));
    expect(await facts()).toHaveLength(1);
    expect(await payment("parent")).toMatchObject({ allocatedMinor: 60000, remainingMinor: 40000 });
  });
  it("serializes concurrent confirmations so two 60000 allocations cannot spend 100000", async () => {
    const a = await order(1, 60000), b = await order(3, 60000); await sync([bill("parent")]);
    const p = await payment("parent"), ca = collect(a, p.id, 60000), cb = collect(b, p.id, 60000);
    const pa = await prepare(ca), pb = await prepare(cb);
    const results = await Promise.allSettled([confirm(ca, pa), confirm(cb, pb)]);
    expect(results.filter(r => r.status === "fulfilled" && r.value.businessCommitted)).toHaveLength(1);
    expect(await facts()).toHaveLength(1);
    expect(await payment("parent")).toMatchObject({ allocatedMinor: 60000, remainingMinor: 40000 });
  });
  it("does not expose or allocate another property's bill", async () => {
    const a = await order(1, 40000); await sync([bill("parent")]);
    const p = await payment("parent"), command = collect(a, p.id, 40000);
    expect((await listPaymentAllocations(runtime, "foreign-property", { kind: "COLLECTION", status: "ALL" })).items).toEqual([]);
    const foreign = { ...principal, subjectId: "foreign-subject", ...authScope({ propertyId: "foreign-property", credentialType: "SESSION", profile: "administrator" }) };
    await expect(createCommandPreview(runtime, foreign, command, meta())).rejects.toBeTruthy();
    expect(await facts()).toHaveLength(0);
    expect(await payment("parent")).toMatchObject({ remainingMinor: 100000 });
  });
  it("rejects membership conversion of a split source without creating membership money", async () => {
    const { a, fa } = await split("unit_room_d_gen_01");
    await withPropertyClockForTesting(new Date("2028-12-01T12:00:00Z"), () => execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: a } }));
    await withPropertyClockForTesting(new Date("2028-12-02T12:00:00Z"), () => execute({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: a } }));
    const before = await facts();
    const cmd: CommandEnvelope = { commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", input: { propertyId: demo.propertyId, orderId: a, memberId: demo.memberId, membershipProductId: "membership_product_shared_bath_single_v1", collectionFactIds: [fa], agreedPriceMinor: 40000, priceAdjustmentReason: "拆分来源不得转会员" } };
    // Require a split/allocation-specific rejection, not an unrelated lifecycle validation failure.
    await expect(withPropertyClockForTesting(new Date("2028-12-02T12:00:00Z"), () => prepare(cmd))).rejects.toThrow(/拆分|分配|split|allocat/i);
    expect(await facts()).toEqual(before);
    expect(await db.selectFrom("membership_payment_facts").selectAll().where("source_collection_fact_id", "=", fa).execute()).toHaveLength(0);
  });
});
