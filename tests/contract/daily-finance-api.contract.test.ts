import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { CommandType, PaymentAllocationList, RetainedFundList } from "@qintopia/contracts";
import { createDatabase, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import { createBusinessApi } from "../helpers/business-api.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

let db: Kysely<Database>;
let app: FastifyInstance;
let api: ReturnType<typeof createBusinessApi>;
let sequence = 0;
const synchronizedAt = new Date("2026-11-06T02:00:00Z");

// These are business facts and reservations, excluding protocol/audit records.
async function snapshot() {
  return Promise.all([
    db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute(),
    db.selectFrom("orders").select(["id", "status", "version", "current_revision_id"]).orderBy("id").execute(),
    db.selectFrom("inventory_claims").selectAll().orderBy("id").execute(),
    sql`SELECT * FROM external_payment_allocations ORDER BY id`.execute(db).then(result => result.rows),
    sql`SELECT * FROM external_payment_allocation_releases ORDER BY id`.execute(db).then(result => result.rows),
    sql`SELECT * FROM retained_funds ORDER BY id`.execute(db).then(result => result.rows),
    sql`SELECT * FROM retained_fund_entries ORDER BY id`.execute(db).then(result => result.rows)
  ]);
}
const execute = (commandType: CommandType, input: Record<string, unknown>, key: string) =>
  api.execute(commandType, input, `finance-${key}`, { snapshot });

async function order(day: number, amountMinor = 100000) {
  const key = `finance-order-${++sequence}`;
  const response = await app.inject({ method: "POST", url: "/api/v1/quotes",
    headers: { ...api.headers, "idempotency-key": `${key}-quote`, "x-correlation-id": key },
    payload: { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT",
      arrivalDate: `2028-12-${String(day).padStart(2, "0")}`, departureDate: `2028-12-${String(day + 1).padStart(2, "0")}`,
      pricingPolicyVersionId: demo.transientPolicyId } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().receipt.commandType).toBe("CREATE_QUOTE");
  const receipt = await execute("CREATE_ORDER", { quoteId: response.json().quote.quoteId,
    primaryGuest: { fullName: "合成资金客户", nickname: key, phone: "13800001234" }, bookingChannelCode: "WECOM",
    targetCurrentContractAmountMinor: amountMinor, manualPriceAdjustmentReason: "合成资金 API 验证协议价" }, key);
  return receipt.result!.orderId as string;
}

function bill(reference: string, amountMinor: number, overrides: Partial<WecomBill> = {}): WecomBill {
  return { kind: "COLLECTION", merchantId: "daily-finance-merchant", reference,
    originalTradeNo: `trade-${reference}`, transactionId: reference, externalUserId: "synthetic-customer", collectorId: "synthetic-staff",
    amountMinor, occurredAt: new Date(synchronizedAt.getTime() - 60000), state: "SUCCESS", ...overrides };
}
async function sync(rows: WecomBill[]) {
  // The production importer receives an in-memory client; no external payment service is called.
  const client: PaymentClient = {
    bills: async (begin, end) => ({ bills: rows.filter(row => row.occurredAt >= begin && row.occurredAt <= end), nextCursor: null }),
    nickname: async () => "合成付款客户"
  };
  await syncWecomSource(db, "daily-finance-source", client, synchronizedAt);
}
async function payment(reference: string, kind: "COLLECTION" | "REFUND" = "COLLECTION") {
  const result = await api.get<PaymentAllocationList>(`/api/v2/external-payments?propertyId=${demo.propertyId}&kind=${kind}&status=ALL`);
  expect(result.enabled).toBe(true);
  const item = result.items.find(row => row.reference === reference);
  expect(item, reference).toBeDefined();
  return item!;
}
async function retained(status: "AVAILABLE" | "ALL" = "ALL") {
  return api.get<RetainedFundList>(`/api/v2/retained-funds?propertyId=${demo.propertyId}&status=${status}`);
}
const collect = async (orderId: string, reference: string, amountMinor: number) => execute("RECORD_COLLECTION", {
  orderId, externalPaymentBillId: (await payment(reference)).id, amountMinor, method: "WECOM", transactionReference: reference,
  note: "核实企微来源和本单份额"
}, `collect-${reference}-${orderId}`);
const ledger = () => db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute();
async function rejectPreview(commandType: CommandType, input: Record<string, unknown>, status: number, code: string, token: string = demo.writeToken) {
  const before = await snapshot();
  const response = await app.inject({ method: "POST", url: "/api/v1/command-previews",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": `finance-rejected-${++sequence}`, "x-correlation-id": "finance-rejected" },
    payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ code });
  expect(await snapshot()).toEqual(before);
}
async function retentionFixture() {
  const sourceOrderId = await order(1), targetOrderId = await order(3, 40000);
  await sync([bill("retained-source", 100000)]);
  const collected = await collect(sourceOrderId, "retained-source", 100000);
  await execute("CANCEL_ORDER", { orderId: sourceOrderId }, "cancel-retention-source");
  const beforeFacts = await ledger();
  const receipt = await execute("RETAIN_ORDER_FUNDS", { orderId: sourceOrderId, sourceFactId: collected.factRefs[0], amountMinor: 100000,
    ownerName: "原付款归属人", ownerContact: "13800001234", confirmationNote: "已核实款项归属，客户要求留存后续使用" }, "retain");
  expect(await ledger()).toEqual(beforeFacts);
  const retainedFundId = receipt.result!.retainedFundId as string;
  expect(receipt.factRefs).toEqual([]); // A successful reservation creates no new cash fact.
  expect((await retained()).items).toEqual([expect.objectContaining({ id: retainedFundId, sourceOrderId,
    sourceFactId: collected.factRefs[0], amountMinor: 100000, remainingMinor: 100000, usedMinor: 0, refundedMinor: 0, releasedMinor: 0 })]);
  return { sourceOrderId, targetOrderId, retainedFundId, sourceFactId: collected.factRefs[0]! };
}

beforeEach(async () => {
  vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "true");
  db = await resetTestDatabase();
  app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
  await app.ready();
  api = createBusinessApi(app);
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
    VALUES('daily-finance-source','synthetic-corp',true,${new Date("2026-11-05T00:00:00Z")},${new Date("2026-11-05T00:00:00Z")},${new Date(synchronizedAt.getTime()-120000)},true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('daily-finance-source','daily-finance-merchant',${demo.propertyId})`.execute(db);
});
afterEach(async () => { await app?.close(); await db?.destroy(); vi.unstubAllEnvs(); });

describe("daily funds through the public token API", () => {
  it("records split collections and a source-linked refund exactly once with authoritative readback", async () => {
    const firstOrder = await order(1, 40000), secondOrder = await order(3, 60000);
    await sync([bill("split-source", 100000)]);
    const first = await collect(firstOrder, "split-source", 40000);
    expect(await payment("split-source")).toMatchObject({ allocatedMinor: 40000, remainingMinor: 60000, status: "PARTIALLY_MATCHED" });
    const second = await collect(secondOrder, "split-source", 60000);
    expect(await payment("split-source")).toMatchObject({ allocatedMinor: 100000, remainingMinor: 0, status: "MATCHED" });

    await sync([bill("split-refund", 20000, { kind: "REFUND", transactionId: "split-source", originalTradeNo: "trade-split-source" })]);
    const refunded = await execute("RECORD_REFUND", { orderId: secondOrder, referencesFactId: second.factRefs[0], amountMinor: 20000,
      externalPaymentBillId: (await payment("split-refund", "REFUND")).id, method: "WECOM", refundReference: "split-refund", note: "核实成功部分退款" }, "refund");
    expect(await api.get(`/api/v1/facts/${refunded.factRefs[0]}`)).toMatchObject({ order_id: secondOrder, fact_type: "REFUND",
      amount_minor: 20000, net_effect_minor: -20000, references_fact_id: second.factRefs[0], refund_reference: "split-refund" });
    const firstRead = await api.get(`/api/v1/orders/${firstOrder}`), secondRead = await api.get(`/api/v1/orders/${secondOrder}`);
    expect(firstRead.collectionFacts.map((row: { fact_id: string }) => row.fact_id)).toEqual([first.factRefs[0]]);
    expect(secondRead.collectionFacts).toHaveLength(2);
    expect((await ledger()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(80000);
    expect(await payment("split-source")).toMatchObject({ remainingMinor: 0 });
    expect(await payment("split-refund", "REFUND")).toMatchObject({ remainingMinor: 0, allocatedMinor: 20000 });
    await rejectPreview("RECORD_REFUND", { orderId: secondOrder, referencesFactId: second.factRefs[0], amountMinor: 40001,
      method: "WECOM", refundReference: "too-much", note: "超额退款应拒绝" }, 409, "REFUND_LIMIT_EXCEEDED");
    await rejectPreview("RECORD_COLLECTION", { orderId: firstOrder, amountMinor: 100, method: "BANK_TRANSFER", transactionReference: "readonly" },
      403, "INSUFFICIENT_ACCESS", demo.readToken);
  });

  it("reverses a mistaken allocation explicitly and preserves its immutable correction history", async () => {
    const orderId = await order(1, 40000);
    await sync([bill("correct-source", 40000)]);
    const original = await collect(orderId, "correct-source", 40000);
    const receipt = await execute("REVERSE_FACT", { orderId, reversesFactId: original.factRefs[0],
      releaseExternalPaymentAllocation: true, note: "核对后纠正流水归属" }, "reverse");
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.fact_id === receipt.factRefs[0])).toMatchObject({ fact_type: "REVERSAL",
      reverses_fact_id: original.factRefs[0], net_effect_minor: -40000 });
    expect(rows.reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    expect(await payment("correct-source")).toMatchObject({ allocatedMinor: 0, remainingMinor: 40000,
      allocations: [expect.objectContaining({ factId: original.factRefs[0], released: true })] });
    await rejectPreview("REVERSE_FACT", { orderId, reversesFactId: original.factRefs[0], note: "重复冲正" }, 409, "FACT_ALREADY_REVERSED");
  });

  it("retains, applies, releases and refunds funds without creating cash for an internal transfer", async () => {
    const { sourceOrderId, targetOrderId, retainedFundId, sourceFactId } = await retentionFixture();
    const useInput = { orderId: targetOrderId, retainedFundId, amountMinor: 40000, authorizationNote: "原付款人已明确授权为另一入住人代订" };
    await rejectPreview("APPLY_RETAINED_FUNDS", { ...useInput, authorizationNote: "   " }, 400, "VALIDATION_ERROR");
    const used = await execute("APPLY_RETAINED_FUNDS", useInput, "use-retention");
    const transferred = (await ledger()).filter(row => row.command_id === used.commandId);
    expect(transferred).toHaveLength(2);
    expect(transferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ order_id: sourceOrderId, fact_type: "REALLOCATION_OUT", net_effect_minor: -40000, references_fact_id: sourceFactId }),
      expect.objectContaining({ order_id: targetOrderId, fact_type: "REALLOCATION_IN", net_effect_minor: 40000, references_fact_id: sourceFactId })
    ]));
    expect((await ledger()).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(100000);
    const beforeRelease = await ledger();
    await execute("RELEASE_RETAINED_FUNDS", { orderId: sourceOrderId, retainedFundId, amountMinor: 20000,
      note: "解除未使用部分，留在来源订单等待核对" }, "release-retention");
    expect(await ledger()).toEqual(beforeRelease);
    expect(await payment("retained-source")).toMatchObject({ remainingMinor: 0 });
    await sync([bill("retained-refund", 40000, { kind: "REFUND", transactionId: "retained-source", originalTradeNo: "trade-retained-source" })]);
    await execute("REFUND_RETAINED_FUNDS", { orderId: sourceOrderId, retainedFundId, amountMinor: 40000,
      externalPaymentBillId: (await payment("retained-refund", "REFUND")).id, refundReference: "retained-refund", note: "核实已成功退还剩余留存" }, "refund-retention");
    expect((await retained("AVAILABLE")).items).toEqual([]);
    expect((await retained()).items).toEqual([expect.objectContaining({ id: retainedFundId, remainingMinor: 0,
      usedMinor: 40000, releasedMinor: 20000, refundedMinor: 40000 })]);
    const rows = await ledger();
    expect(rows.filter(row => row.fact_type === "COLLECTION")).toHaveLength(1);
    expect(rows.filter(row => row.fact_type === "REFUND")).toHaveLength(1);
    expect(rows.filter(row => row.order_id === sourceOrderId).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(20000);
    expect(rows.filter(row => row.order_id === targetOrderId).reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(40000);
    expect((await api.get(`/api/v1/orders/${sourceOrderId}`)).order.status).toBe("CANCELLED");
    expect((await api.get(`/api/v1/orders/${targetOrderId}`)).collectionFacts).toHaveLength(1);
  });

  it("rejects stale retained-fund confirmation after another command consumes its reservation", async () => {
    const { sourceOrderId, targetOrderId, retainedFundId } = await retentionFixture();
    const prepared = await api.preview("APPLY_RETAINED_FUNDS", { orderId: targetOrderId, retainedFundId,
      amountMinor: 40000, authorizationNote: "已向款项归属人确认使用" }, "finance-stale-preview");
    await execute("RELEASE_RETAINED_FUNDS", { orderId: sourceOrderId, retainedFundId, amountMinor: 100000, note: "随后核对撤销留存" }, "release-all");
    const before = await snapshot();
    const failed = await api.confirm(prepared.preview, "finance-stale-confirm", undefined, 409);
    expect(failed).toMatchObject({ commandType: "APPLY_RETAINED_FUNDS", executionStatus: "NOT_EXECUTED", businessCommitted: false });
    expect(await api.get(`/api/v1/command-results?propertyId=${demo.propertyId}&commandType=APPLY_RETAINED_FUNDS&idempotencyKey=finance-stale-confirm`)).toEqual(failed);
    expect(await snapshot()).toEqual(before);
    expect((await retained()).items).toEqual([expect.objectContaining({ remainingMinor: 0, releasedMinor: 100000, usedMinor: 0 })]);
    expect((await api.get(`/api/v1/orders/${targetOrderId}`)).collectionFacts).toEqual([]);
  });

  it("reconciles missing collection and refund together without changing a cancelled stay", async () => {
    const orderId = await order(1);
    await execute("CANCEL_ORDER", { orderId }, "cancel-reconciliation");
    const before = await api.get(`/api/v1/orders/${orderId}`);
    await sync([bill("reconcile-source", 100000), bill("reconcile-refund", 100000,
      { kind: "REFUND", transactionId: "reconcile-source", originalTradeNo: "trade-reconcile-source" })]);
    const receipt = await execute("RECORD_REFUND", { orderId, reconciliation: {
      source: { externalPaymentBillId: (await payment("reconcile-source")).id, amountMinor: 100000 },
      refunds: [{ externalPaymentBillId: (await payment("reconcile-refund", "REFUND")).id, amountMinor: 100000 }],
      note: "核实原收款和成功退款均漏记，按本单真实份额一次补齐"
    } }, "reconcile");
    expect(receipt.result).toMatchObject({ operation: "RECONCILE_WECOM_REFUNDS", orderId });
    const after = await api.get(`/api/v1/orders/${orderId}`);
    expect(after.order.status).toBe("CANCELLED");
    expect(after.stay).toEqual(before.stay);
    expect(after.pricingRevisions).toEqual(before.pricingRevisions);
    expect(after.segments).toEqual(before.segments);
    expect(after.collectionFacts).toHaveLength(2);
    const rows = await ledger();
    expect(rows.map(row => row.fact_type).sort()).toEqual(["COLLECTION", "REFUND"]);
    expect(rows.reduce((sum, row) => sum + row.net_effect_minor, 0)).toBe(0);
    expect(await payment("reconcile-source")).toMatchObject({ remainingMinor: 0, allocatedMinor: 100000 });
    expect(await payment("reconcile-refund", "REFUND")).toMatchObject({ remainingMinor: 0, allocatedMinor: 100000 });
  });
});
