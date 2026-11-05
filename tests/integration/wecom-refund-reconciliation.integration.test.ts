import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
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
import { applyRefundReconciliation, type RefundReconciliationEffect } from "../../packages/db/src/wecom-refund-reconciliation.ts";
import { bindExternalPayments, type ExternalPaymentBasis } from "../../packages/db/src/external-payments.ts";
import { loadDashboardMoney } from "../../packages/db/src/dashboard-money.ts";
import { classifyDashboardMoney } from "@qintopia/domain";
import { authScope } from "../helpers/auth-principals.ts";

// Dedicated synthetic database on the same server as the existing test suite.
const defaultDatabaseUrl = new URL(testDatabaseUrl);
defaultDatabaseUrl.pathname = "/qintopia_refund_group_test";
const databaseUrl = process.env.REFUND_RECONCILIATION_TEST_DATABASE_URL ?? defaultDatabaseUrl.toString();
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
async function order(day: number, amount: number, unit: string = demo.roomId, phone = "13800000000") {
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: unit, stayType: "TRANSIENT", arrivalDate: `2028-12-${String(day).padStart(2, "0")}`, departureDate: `2028-12-${String(day + 1).padStart(2, "0")}`, pricingPolicyVersionId: unit === demo.roomId ? demo.transientPolicyId : demo.publicPricingPolicyId });
  return (await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: "分配测试客人", nickname: "合成测试", phone }, bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: amount, manualPriceAdjustmentReason: "合成资金验收协议价" } })).result!.orderId as string;
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
async function financialSnapshot() {
  return { facts: await facts(), allocations: await db.selectFrom("external_payment_allocations").selectAll().orderBy("id").execute(),
    proofs: (await sql`SELECT * FROM wecom_refund_reconciliations ORDER BY command_id`.execute(db)).rows };
}
async function historicalRegistration(action: () => Promise<unknown>) {
  // Exercise the real pre-sync manual command path, rather than inventing facts.
  await sql`UPDATE external_payment_sources SET enabled=false WHERE id='allocation-source'`.execute(db);
  try { await action(); }
  finally { await sql`UPDATE external_payment_sources SET enabled=true WHERE id='allocation-source'`.execute(db); }
}
async function legacyCollection(orderId: string, amountMinor: number, reference = "parent") {
  return execute({ commandType: "RECORD_COLLECTION", input: { propertyId: demo.propertyId, orderId,
    amountMinor, method: "WECOM", transactionReference: reference, note: "同步启用前的真实手录份额" } });
}
async function directGroup(prepared: Awaited<ReturnType<typeof prepare>>, commandId: string) {
  const preview = await db.selectFrom("command_previews").selectAll().where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
  return runtime.transaction().execute(async trx => {
    await trx.insertInto("command_executions").values({ id: commandId, subject_id: principal.subjectId, credential_id: principal.credentialId,
      property_id: demo.propertyId, command_type: "RECORD_REFUND", idempotency_key: commandId, request_hash: "a".repeat(64), correlation_id: commandId, state: "EXECUTING", completed_at: null }).execute();
    const applied = await applyRefundReconciliation(trx, prepared.preview.effect as RefundReconciliationEffect, commandId, prepared.preview.previewId);
    await bindExternalPayments(trx, commandId, (preview.basis_versions as { externalPayments: ExternalPaymentBasis[] }).externalPayments);
    await trx.updateTable("command_previews").set({ status: "USED", used_at: new Date() }).where("id", "=", preview.id).execute();
    await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", commandId).execute();
    await trx.insertInto("command_receipts").values({ id: `${commandId}-receipt`, command_id: commandId, execution_status: "EXECUTED", business_committed: true,
      result: { ...applied.persistedResult, effectHash: prepared.preview.effectHash }, error: null,
      resource_refs: JSON.stringify(applied.resourceRefs), fact_refs: JSON.stringify(applied.factRefs), committed_at: new Date() }).execute();
    await trx.insertInto("audit_entries").values({ id: `${commandId}-audit`, subject_id: principal.subjectId, credential_id: principal.credentialId,
      action: "RECORD_REFUND", decision: "ALLOWED", command_id: commandId, correlation_id: commandId, reason: null,
      target_refs: JSON.stringify(applied.resourceRefs), metadata: { previewId: preview.id, effectHash: prepared.preview.effectHash } }).execute();
  });
}
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

const reconcile = (orderId: string, source: string, amount: number, refunds: Array<[string, number]>): CommandEnvelope => ({
  commandType: "RECORD_REFUND", input: { propertyId: demo.propertyId, orderId,
    reconciliation: { source: { externalPaymentBillId: source, amountMinor: amount },
      refunds: refunds.map(([externalPaymentBillId, amountMinor]) => ({ externalPaymentBillId, amountMinor })), note: "按真实业务核对原款及退款份额" } }
});
const refundBill = (reference: string, amountMinor: number, overrides: Partial<WecomBill> = {}) =>
  bill(reference, amountMinor, { kind: "REFUND", transactionId: "parent", originalTradeNo: "trade-parent", ...overrides });
async function lodgingSnapshot(id: string) {
  return { order: await db.selectFrom("orders").selectAll().where("id", "=", id).execute(),
    stays: await db.selectFrom("stays").selectAll().where("order_id", "=", id).execute(),
    revisions: await db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", id).execute(),
    claims: await db.selectFrom("inventory_claims").selectAll().orderBy("id").execute() };
}

describe("真实收退已发生后的同事务补登记", () => {
  it("旧手录400+600已有业务登记但整笔链接器未分配，Preview拒绝再次补原款", async () => {
    const a = await order(1, 40000), b = await order(3, 60000);
    await historicalRegistration(async () => { await legacyCollection(a, 40000); await legacyCollection(b, 60000); });
    await sync([bill("parent"), refundBill("r", 100000)]);
    const p = await payment("parent"), r = await payment("r", "REFUND"), before = await financialSnapshot();
    expect(p).toMatchObject({ allocatedMinor: 0, remainingMinor: 100000 });
    expect(before.facts.map(fact => fact.amount_minor).sort()).toEqual([40000, 60000]);
    await expect(prepare(reconcile(a, p.id, 40000, [[r.id, 40000]]))).rejects.toThrow(/先核对历史归属/);
    expect(await financialSnapshot()).toEqual(before);
  });
  it("已选退款存在未分配的有效旧手录份额时拒绝成组追加", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent")]);
    const p = await payment("parent"), original = await execute(collect(id, p.id, 40000));
    await historicalRegistration(() => execute({ commandType: "RECORD_REFUND", input: { propertyId: demo.propertyId,
      orderId: id, referencesFactId: original.factRefs[0]!, amountMinor: 10000, method: "WECOM", refundReference: "r", note: "同步前已手录的退款份额" } }));
    await sync([refundBill("r", 30000)]);
    const r = await payment("r", "REFUND"), before = await financialSnapshot();
    expect(r).toMatchObject({ allocatedMinor: 0, remainingMinor: 30000 });
    await expect(prepare(reconcile(id, p.id, 60000, [[r.id, 20000]]))).rejects.toThrow(/先核对历史归属/);
    expect(await financialSnapshot()).toEqual(before);
  });
  it("DB独立拒绝绕过builder重复占用旧手录拆分原款，即使完整回执与审计均已构造", async () => {
    const a = await order(1, 40000), b = await order(3, 60000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const p = await payment("parent"), r = await payment("r", "REFUND");
    const prepared = await prepare(reconcile(a, p.id, 100000, [[r.id, 100000]]));
    await historicalRegistration(async () => { await legacyCollection(a, 40000); await legacyCollection(b, 60000); });
    const before = await financialSnapshot();
    await expect(directGroup(prepared, "duplicate-history-group")).rejects.toThrow(/refund reconciliation/);
    expect(await financialSnapshot()).toEqual(before);
  });
  it("DB既有退款唯一性守卫拒绝旧手录份额再次登记，保留已有资金图", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent")]);
    const p = await payment("parent"), original = await execute(collect(id, p.id, 40000));
    await sync([refundBill("r", 30000)]);
    const prepared = await prepare(reconcile(id, p.id, 60000, [[(await payment("r", "REFUND")).id, 30000]]));
    await historicalRegistration(() => execute({ commandType: "RECORD_REFUND", input: { propertyId: demo.propertyId,
      orderId: id, referencesFactId: original.factRefs[0]!, amountMinor: 10000, method: "WECOM", refundReference: "r", note: "旧手录退款" } }));
    const before = await financialSnapshot();
    await expect(directGroup(prepared, "duplicate-refund-history-group")).rejects.toThrow("wecom refund reference is already recorded for this property");
    expect(await financialSnapshot()).toEqual(before);
  });
  it("尚未匹配的会员更正后有效同号款不能再次当作住宿收款", async () => {
    const id = await order(1, 100000);
    await historicalRegistration(async () => {
      const member = await execute({ commandType: "CREATE_MEMBER", input: { propertyId: demo.propertyId, fullName: "历史会员", nickname: "历史会员", phone: "13912349876", wechat: "history-member" } });
      const membership = await execute({ commandType: "CREATE_MEMBERSHIP_ORDER", input: { propertyId: demo.propertyId, memberId: member.result!.memberId,
        membershipProductId: "membership_product_shared_bath_single_v1", agreedPriceMinor: 162000 } });
      const original = await execute({ commandType: "RECORD_MEMBERSHIP_PAYMENT", input: { propertyId: demo.propertyId,
        membershipOrderId: membership.result!.membershipOrderId, amountMinor: 40000, transactionReference: "parent" } });
      await execute({ commandType: "CORRECT_MEMBERSHIP_PAYMENT", input: { propertyId: demo.propertyId, membershipOrderId: membership.result!.membershipOrderId,
        originalPaymentFactId: original.result!.paymentFactId, correctedAmountMinor: 40000, correctedTransactionReference: "parent", note: "核对真实备注，保留来源" } });
    });
    await sync([bill("parent"), refundBill("r", 100000)]);
    const p = await payment("parent"), before = await financialSnapshot();
    expect(p.allocatedMinor).toBe(0);
    await expect(prepare(reconcile(id, p.id, 60000, [[(await payment("r", "REFUND")).id, 60000]]))).rejects.toThrow(/先核对历史归属/);
    expect(await financialSnapshot()).toEqual(before);
  });
  it("已内部转会员的旧住宿原款仍占现金来源，专用冲销不允许重复补款", async () => {
    const unit = await db.selectFrom("inventory_units").select("id").where("property_id", "=", demo.propertyId).where("code", "=", "D01").executeTakeFirstOrThrow();
    const sourceOrder = await order(1, 40000, unit.id, "13912349876"), targetOrder = await order(3, 60000);
    await withPropertyClockForTesting(new Date("2028-12-01T12:00:00Z"), () => execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: sourceOrder } }));
    await withPropertyClockForTesting(new Date("2028-12-02T12:00:00Z"), () => execute({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: sourceOrder } }));
    await historicalRegistration(async () => {
      const member = await execute({ commandType: "CREATE_MEMBER", input: { propertyId: demo.propertyId, fullName: "历史转会员", nickname: "历史转会员", phone: "13912349876", wechat: "history-transfer" } });
      const source = await legacyCollection(sourceOrder, 40000);
      await execute({ commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", input: { propertyId: demo.propertyId, orderId: sourceOrder,
        memberId: member.result!.memberId, membershipProductId: "membership_product_shared_bath_single_v1", collectionFactIds: source.factRefs,
        agreedPriceMinor: 40000, priceAdjustmentReason: "合成历史转换来源保护" } });
      expect(await db.selectFrom("stay_collection_membership_transfers").select("source_collection_fact_id")
        .where("source_collection_fact_id", "=", source.factRefs[0]!).execute()).toHaveLength(1);
    });
    await sync([bill("parent"), refundBill("r", 100000)]);
    const p = await payment("parent"), before = await financialSnapshot();
    expect(p.allocatedMinor).toBe(0);
    await expect(prepare(reconcile(targetOrder, p.id, 60000, [[(await payment("r", "REFUND")).id, 60000]]))).rejects.toThrow(/先核对历史归属/);
    expect(await financialSnapshot()).toEqual(before);
  });
  it("历史普通订单保留真实NULL渠道，仍可凭已核实企微收退款补记", async () => {
    const id = await order(1, 100000);
    // Owner-only fixture setup models the pre-009 nullable historical channel.
    // Re-enable identity protection before exercising any runtime command.
    await db.transaction().execute(async trx => {
      await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx);
      await sql`ALTER TABLE orders DISABLE TRIGGER orders_protect_identity`.execute(trx);
      await trx.updateTable("orders").set({ booking_channel_code: null }).where("id", "=", id).execute();
      await sql`ALTER TABLE orders ENABLE TRIGGER orders_protect_identity`.execute(trx);
    });
    await sync([bill("parent"), refundBill("r", 100000)]);
    const before = await lodgingSnapshot(id);
    await execute(reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]));
    expect(await lodgingSnapshot(id)).toEqual(before);
    expect((await db.selectFrom("orders").select("booking_channel_code").where("id", "=", id).executeTakeFirstOrThrow()).booking_channel_code).toBeNull();
  });
  it.each(["FREE", "MEMBER"])("NULL渠道%s订单不能被当作历史普通订单补登记", async kind => {
    const unit = kind === "MEMBER" ? await db.selectFrom("inventory_units").select("id")
      .where("property_id", "=", demo.propertyId).where("code", "=", "D01").executeTakeFirstOrThrow() : { id: demo.roomId };
    const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: unit.id,
      arrivalDate: "2028-12-01", departureDate: "2028-12-02", pricingPolicyVersionId: kind === "MEMBER" ? demo.publicPricingPolicyId : demo.freePolicyId,
      ...(kind === "MEMBER" ? { memberId: demo.memberId } : { stayType: "FREE" as const }) });
    const created = await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId,
      primaryGuest: { fullName: "边界合成客人", nickname: "补记范围测试" },
      ...(kind === "FREE" ? { freeStayReason: "免费住宿合成测试", freeStayCategoryCode: "VOLUNTEER" } : {}) } });
    const id = created.result!.orderId as string;
    expect((await db.selectFrom("orders").select("booking_channel_code").where("id", "=", id).executeTakeFirstOrThrow()).booking_channel_code).toBeNull();
    await sync([bill("parent"), refundBill("r", 100000)]);
    await expect(prepare(reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]))).rejects.toThrow(/不支持/);
    expect(await facts()).toEqual([]);
  });
  it("取消订单一次补原款和多笔退款，状态、计价及库存保持不变", async () => {
    const id = await order(1, 100000);
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: id } });
    await sync([bill("parent"), refundBill("r1", 40000), refundBill("r2", 60000)]);
    const before = await lodgingSnapshot(id);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r1", "REFUND")).id, 40000], [(await payment("r2", "REFUND")).id, 60000]]);
    const prepared = await prepare(command), receipt = await confirm(command, prepared);
    expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
    expect(receipt.result).toMatchObject({ operation: "RECONCILE_WECOM_REFUNDS", collectedMinor: 100000, refundedMinor: 100000, netEffectMinor: 0, effectHash: prepared.preview.effectHash });
    expect(receipt.factRefs).toEqual([receipt.result!.sourceFactId, ...(receipt.result!.refundFactIds as string[])]);
    expect((await facts()).map(row => row.fact_type).sort()).toEqual(["COLLECTION", "REFUND", "REFUND"]);
    expect((await facts()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    expect(await lodgingSnapshot(id)).toEqual(before);
    const money = await db.transaction().execute(trx => loadDashboardMoney(trx, demo.propertyId, "Asia/Shanghai", "1900-01-01", "2100-01-01"));
    expect(money.filter(row => row.orderId === id).map(classifyDashboardMoney).sort()).toEqual(["COLLECTION", "REFUND", "REFUND"]);
  });
  it("全退1000按A400/B600逐单补齐，间隙内原款仍被冻结", async () => {
    const a = await order(1, 40000), b = await order(3, 60000);
    await sync([bill("parent"), refundBill("full", 100000)]);
    const p = await payment("parent"), r = await payment("full", "REFUND");
    await execute(reconcile(a, p.id, 40000, [[r.id, 40000]]));
    expect(await payment("parent")).toMatchObject({ remainingMinor: 60000 });
    expect(await payment("full", "REFUND")).toMatchObject({ remainingMinor: 60000 });
    await expect(prepare(collect(b, p.id, 60000))).rejects.toThrow(/尚未完成归属/);
    await execute(reconcile(b, p.id, 60000, [[r.id, 60000]]));
    expect(await payment("parent")).toMatchObject({ remainingMinor: 0 });
    expect(await payment("full", "REFUND")).toMatchObject({ remainingMinor: 0 });
    expect((await facts()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    await expect(prepare(reconcile(a, p.id, 1, [[r.id, 1]]))).rejects.toThrow();
  });
  it("部分退款预留未归属退款，允许同单继续补剩余真实份额", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("part", 80000)]);
    const p = await payment("parent"), r = await payment("part", "REFUND");
    await expect(prepare(reconcile(id, p.id, 60000, [[r.id, 30000]]))).rejects.toThrow(/占用其他/);
    await execute(reconcile(id, p.id, 60000, [[r.id, 40000]]));
    await execute(reconcile(id, p.id, 40000, [[r.id, 40000]]));
    expect((await facts()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(20000);
  });
  it("已退房可成组补记；已有原款的普通退款保持旧契约", async () => {
    const id = await order(1, 100000);
    await withPropertyClockForTesting(new Date("2028-12-01T12:00:00Z"), () => execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: id } }));
    await withPropertyClockForTesting(new Date("2028-12-02T12:00:00Z"), () => execute({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: id } }));
    await sync([bill("parent"), refundBill("r1", 30000)]);
    const before = await lodgingSnapshot(id), p = await payment("parent"), r = await payment("r1", "REFUND");
    const receipt = await execute(reconcile(id, p.id, 100000, [[r.id, 30000]]));
    await sync([refundBill("r2", 20000)]);
    const single = await execute(refund(id, receipt.result!.sourceFactId as string, (await payment("r2", "REFUND")).id, 20000, "r2"));
    expect(single.result).toMatchObject({ factType: "REFUND", netEffectMinor: -20000 });
    expect(single.result).not.toHaveProperty("operation");
    expect(await lodgingSnapshot(id)).toEqual(before);
  });
  it("Preview之后同步新退款使预览失效，重试不留下半组", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r1", 30000)]);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r1", "REFUND")).id, 30000]]);
    const prepared = await prepare(command);
    await sync([refundBill("late", 10000)]);
    await rejected(() => confirm(command, prepared));
    expect(await facts()).toEqual([]);
    expect((await sql`SELECT * FROM wecom_refund_reconciliations`.execute(db)).rows).toEqual([]);
  });
  it("Preview后完全相同的同步轮询只更新观察时间，Confirm仍能成功", async () => {
    const id = await order(1, 100000), rows = [bill("parent"), refundBill("r", 100000)];
    await sync(rows);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]);
    const prepared = await prepare(command);
    const before = (await sql<{ id: string; updated_at: Date }>`SELECT id,updated_at FROM external_payment_bills ORDER BY id`.execute(db)).rows;
    await sync(rows);
    const after = (await sql<{ id: string; updated_at: Date }>`SELECT id,updated_at FROM external_payment_bills ORDER BY id`.execute(db)).rows;
    expect(after.some((row, index) => row.updated_at.getTime() > before[index]!.updated_at.getTime())).toBe(true);
    expect((await confirm(command, prepared)).businessCommitted).toBe(true);
  });
  it("同一Confirm幂等，另一旧预览失效", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]);
    const first = await prepare(command), second = await prepare(command), metadata = meta();
    const receipt = await confirm(command, first, metadata);
    expect(receipt.businessCommitted).toBe(true);
    expect((await confirm(command, first, metadata)).receiptId).toBe(receipt.receiptId);
    await rejected(() => confirm(command, second));
    expect(await facts()).toHaveLength(2);
  });
  it("不同订单以Promise.all真正竞争同一全额来源，最多一组提交", async () => {
    const a = await order(1, 100000), b = await order(3, 100000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const p = await payment("parent"), r = await payment("r", "REFUND");
    const commands = [reconcile(a, p.id, 100000, [[r.id, 100000]]), reconcile(b, p.id, 100000, [[r.id, 100000]])];
    const prepared = await Promise.all(commands.map(prepare));
    const results = await Promise.all(commands.map((command, index) => confirm(command, prepared[index]!)
      .then(receipt => ({ committed: receipt.businessCommitted }), error => ({ committed: false, error }))));
    expect(results.filter(result => result.committed)).toHaveLength(1);
    const snapshot = await financialSnapshot();
    expect(snapshot.facts).toHaveLength(2);
    expect(new Set(snapshot.facts.map(fact => fact.order_id)).size).toBe(1);
    expect(snapshot.allocations).toHaveLength(2);
    expect(snapshot.proofs).toHaveLength(1);
  });
  it("新退款同步持有门店资金锁时Confirm确定性等待，随后按新依据拒绝且不写半组", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r", 30000)]);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 30000]]);
    const prepared = await prepare(command), before = await financialSnapshot();
    const tagged = (url: string, name: string) => { const result = new URL(url); result.searchParams.set("application_name", name); return result.toString(); };
    const syncApp = "reconciliation-race-sync", confirmApp = "reconciliation-race-confirm", barrier = "reconciliation-race-barrier";
    const synchronizer = createDatabase(tagged(databaseUrl, syncApp), { max: 1, statement_timeout: 15000 });
    const confirmer = createDatabase(tagged(runtimeDatabaseUrlForTesting(databaseUrl), confirmApp), { max: 1, statement_timeout: 15000 });
    const observer = new pg.Client({ connectionString: databaseUrl, statement_timeout: 15000 });
    const pending: Promise<unknown>[] = [];
    let held = false;
    const track = <T,>(promise: Promise<T>) => { pending.push(promise); void promise.catch(() => undefined); return promise; };
    try {
      await observer.connect();
      const controller = (await observer.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]!.pid;
      await observer.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [barrier]); held = true;
      // Same deterministic post-discovery gate used by the existing sync race suite.
      await observer.query(`CREATE FUNCTION reconciliation_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.reference='late-race' AND NEW.kind='REFUND' THEN
            IF NOT EXISTS(SELECT 1 FROM payment_allocation_events WHERE bill_id=NEW.id AND event_type='DISCOVERED') THEN
              RAISE EXCEPTION 'refund discovery must precede the barrier';
            END IF;
            PERFORM pg_advisory_xact_lock(hashtextextended('reconciliation-race-barrier',0));
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER zz_reconciliation_race_barrier AFTER INSERT ON external_payment_bills
          FOR EACH ROW EXECUTE FUNCTION reconciliation_race_barrier();`);
      const waitForLock = async (application: string, blocker: number) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const waiting = await observer.query<{ pid: number; wait_event: string }>(`SELECT pid,wait_event FROM pg_stat_activity
            WHERE datname=current_database() AND application_name=$1 AND state='active' AND wait_event_type='Lock'
              AND $2=ANY(pg_blocking_pids(pid))`, [application, blocker]);
          if (waiting.rows[0]) return waiting.rows[0];
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(`Expected ${application} to wait behind ${blocker}`);
      };
      const client: PaymentClient = { bills: async (begin, end) => ({ bills: [refundBill("late-race", 10000)].filter(row => row.occurredAt >= begin && row.occurredAt <= end), nextCursor: null }), nickname: async () => "合成并发客户" };
      const syncing = track(syncWecomSource(synchronizer, "allocation-source", client, now));
      const syncWait = await waitForLock(syncApp, controller);
      expect(syncWait.wait_event).toBe("advisory");
      const confirming = track(confirmCommandPreview(confirmer, principal, prepared.preview.previewId, { propertyId: demo.propertyId,
        commandType: command.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "ALLOCATION_TEST", note: "确定性同步锁竞争" } }, meta()).then(value => ({ value }), error => ({ error })));
      const confirmWait = await waitForLock(confirmApp, syncWait.pid);
      expect(confirmWait.wait_event).toBe("advisory");
      const gate = await observer.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h
        ON h.locktype=w.locktype AND h.database=w.database AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
        WHERE w.pid=$1 AND NOT w.granted AND h.pid=$2 AND h.granted AND w.locktype='advisory' AND w.objsubid=1
          AND w.classid::bigint=((hashtextextended($3,0)>>32)&4294967295)
          AND w.objid::bigint=(hashtextextended($3,0)&4294967295)) waiting`, [confirmWait.pid, syncWait.pid, `payment-allocation:${demo.propertyId}`]);
      expect(gate.rows[0]!.waiting, "Confirm must wait on sync's exact property money lock").toBe(true);
      await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [barrier]); held = false;
      const [synced, result] = await Promise.all([syncing, confirming]);
      expect(synced.skipped).toBe(false);
      if ("value" in result) expect(result.value).toMatchObject({ businessCommitted: false, error: { code: "PREVIEW_STALE" } });
      else expect(result.error).toMatchObject({ code: "PREVIEW_STALE" });
      expect(await financialSnapshot()).toEqual(before);
      expect((await payment("late-race", "REFUND")).remainingMinor).toBe(10000);
    } finally {
      if (held) await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [barrier]);
      await Promise.allSettled(pending);
      await observer.query("DROP TRIGGER IF EXISTS zz_reconciliation_race_barrier ON external_payment_bills; DROP FUNCTION IF EXISTS reconciliation_race_barrier()");
      await observer.end(); await synchronizer.destroy(); await confirmer.destroy();
    }
  });
  it("处理中、跨原款及重复退款均拒绝且无事实写入", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("pending", 10000, { state: "PENDING" }), refundBill("other", 10000, { transactionId: "different", originalTradeNo: "trade-different" })]);
    const p = await payment("parent"), pending = await payment("pending", "REFUND"), other = await payment("other", "REFUND");
    await expect(prepare(reconcile(id, p.id, 100000, [[pending.id, 10000]]))).rejects.toThrow(/尚未核实/);
    await expect(prepare(reconcile(id, p.id, 100000, [[other.id, 10000]]))).rejects.toThrow(/不对应/);
    await expect(prepare(reconcile(id, p.id, 100000, [[pending.id, 10000], [pending.id, 10000]]))).rejects.toThrow(/重复/);
    expect(await facts()).toEqual([]);
  });
  it("只有退款能力的Token不能补原款，但仍可走既有单笔退款", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent")]);
    const original = await execute(collect(id, (await payment("parent")).id, 100000));
    await sync([refundBill("r", 100000)]);
    await db.deleteFrom("token_command_ceilings").where("token_id", "=", "token_demo_write").where("command_type", "=", "RECORD_COLLECTION").execute();
    const limited: AuthPrincipal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write", credentialType: "TOKEN", displayName: "仅退款令牌", ...authScope({ credentialType: "TOKEN" }) };
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]);
    await expect(createCommandPreview(runtime, limited, command, meta())).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    const single = refund(id, original.factRefs[0]!, (await payment("r", "REFUND")).id, 10000, "r");
    await expect(createCommandPreview(runtime, limited, single, meta())).resolves.toHaveProperty("preview");
  });
  it("合法Preview之后撤销Token收款权限，保留退款权限也不能Confirm成组", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const token: AuthPrincipal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write", credentialType: "TOKEN", displayName: "权限撤销令牌", ...authScope({ credentialType: "TOKEN" }) };
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]);
    const prepared = await createCommandPreview(runtime, token, command, meta()), before = await financialSnapshot();
    await db.deleteFrom("token_command_ceilings").where("token_id", "=", token.credentialId).where("command_type", "=", "RECORD_COLLECTION").execute();
    expect(await db.selectFrom("token_command_ceilings").select("command_type").where("token_id", "=", token.credentialId)
      .where("command_type", "=", "RECORD_REFUND").execute()).toHaveLength(1);
    const result = await confirmCommandPreview(runtime, token, prepared.preview.previewId, { propertyId: demo.propertyId,
      commandType: command.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "ALLOCATION_TEST", note: "预览后收款权限已撤销" } }, meta()).then(value => ({ value }), error => ({ error }));
    if ("value" in result) expect(result.value).toMatchObject({ businessCommitted: false, error: { code: "INSUFFICIENT_ACCESS" } });
    else expect(result.error).toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    expect(await financialSnapshot()).toEqual(before);
  });
  it("DB拒绝缺少已确认回执/审计的半组，即使事实及分配本身正确", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]);
    const prepared = await prepare(command);
    const preview = await db.selectFrom("command_previews").selectAll().where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
    await expect(runtime.transaction().execute(async trx => {
      await trx.insertInto("command_executions").values({ id: "incomplete-group", subject_id: principal.subjectId, credential_id: principal.credentialId,
        property_id: demo.propertyId, command_type: "RECORD_REFUND", idempotency_key: "incomplete-group", request_hash: "a".repeat(64), correlation_id: "incomplete-group", state: "EXECUTING", completed_at: null }).execute();
      await applyRefundReconciliation(trx, prepared.preview.effect as RefundReconciliationEffect, "incomplete-group", prepared.preview.previewId);
      await bindExternalPayments(trx, "incomplete-group", (preview.basis_versions as { externalPayments: ExternalPaymentBasis[] }).externalPayments);
    })).rejects.toThrow(/incomplete or inconsistent/);
    expect(await facts()).toEqual([]);
    expect((await sql`SELECT * FROM wecom_refund_reconciliations`.execute(db)).rows).toEqual([]);
  });
  it.each(["effect", "factRefs"])("DB拒绝%s与真实成组事实不符的成功回执，整组回滚", async tamper => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const command = reconcile(id, (await payment("parent")).id, 100000, [[(await payment("r", "REFUND")).id, 100000]]);
    const prepared = await prepare(command);
    const preview = await db.selectFrom("command_previews").selectAll().where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
    await expect(runtime.transaction().execute(async trx => {
      const commandId = "tampered-group";
      await trx.insertInto("command_executions").values({ id: commandId, subject_id: principal.subjectId, credential_id: principal.credentialId,
        property_id: demo.propertyId, command_type: "RECORD_REFUND", idempotency_key: commandId, request_hash: "a".repeat(64), correlation_id: commandId, state: "EXECUTING", completed_at: null }).execute();
      const applied = await applyRefundReconciliation(trx, prepared.preview.effect as RefundReconciliationEffect, commandId, prepared.preview.previewId);
      await bindExternalPayments(trx, commandId, (preview.basis_versions as { externalPayments: ExternalPaymentBasis[] }).externalPayments);
      await trx.updateTable("command_previews").set({ status: "USED", used_at: new Date() }).where("id", "=", preview.id).execute();
      await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", commandId).execute();
      await trx.insertInto("command_receipts").values({ id: "tampered-receipt", command_id: commandId, execution_status: "EXECUTED", business_committed: true,
        result: { ...applied.persistedResult, effectHash: prepared.preview.effectHash, ...(tamper === "effect" ? { netEffectMinor: 1 } : {}) }, error: null,
        resource_refs: JSON.stringify(applied.resourceRefs), fact_refs: JSON.stringify(tamper === "factRefs" ? applied.factRefs.slice(1) : applied.factRefs), committed_at: new Date() }).execute();
      await trx.insertInto("audit_entries").values({ id: "tampered-audit", subject_id: principal.subjectId, credential_id: principal.credentialId,
        action: "RECORD_REFUND", decision: "ALLOWED", command_id: commandId, correlation_id: commandId, reason: null,
        target_refs: JSON.stringify(applied.resourceRefs), metadata: { previewId: preview.id, effectHash: prepared.preview.effectHash } }).execute();
    })).rejects.toThrow(/refund reconciliation/);
    expect(await facts()).toEqual([]);
  });
  it("DB不接受伪造分组预览挤占尚未归属退款，普通冻结不能被operation标记绕过", async () => {
    const id = await order(1, 100000);
    await sync([bill("parent"), refundBill("r", 100000)]);
    const p = await payment("parent"), r = await payment("r", "REFUND");
    const prepared = await prepare(reconcile(id, p.id, 10000, [[r.id, 10000]]));
    const preview = await db.selectFrom("command_previews").selectAll().where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
    const unsafeEffect = { ...prepared.preview.effect, source: { ...(prepared.preview.effect as RefundReconciliationEffect).source, amountMinor: 100000 },
      collectedMinor: 100000, netEffectMinor: 90000 } as RefundReconciliationEffect;
    await expect(runtime.transaction().execute(async trx => {
      await trx.insertInto("command_previews").values({ ...preview, id: "unsafe-preview", normalized_input: reconcile(id, p.id, 100000, [[r.id, 10000]]).input, effect: unsafeEffect }).execute();
      await trx.insertInto("command_executions").values({ id: "unsafe-group", subject_id: principal.subjectId, credential_id: principal.credentialId,
        property_id: demo.propertyId, command_type: "RECORD_REFUND", idempotency_key: "unsafe-group", request_hash: "b".repeat(64), correlation_id: "unsafe-group", state: "EXECUTING", completed_at: null }).execute();
      await applyRefundReconciliation(trx, unsafeEffect, "unsafe-group", "unsafe-preview");
      const payments = (preview.basis_versions as { externalPayments: ExternalPaymentBasis[] }).externalPayments.map(row => row.kind === "COLLECTION" ? { ...row, amountMinor: 100000 } : row);
      await bindExternalPayments(trx, "unsafe-group", payments);
    })).rejects.toThrow(/unassigned successful refund/);
    expect(await facts()).toEqual([]);
  });
});
