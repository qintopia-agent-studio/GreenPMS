import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, createDatabase, getOrderView, withPropertyClockForTesting, type Database } from "@qintopia/db";
import { newId, stableHash } from "@qintopia/domain";
import { applyCommand } from "../../packages/db/src/commands/apply.ts";
import { demo, seedDemo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { getWorkbenchExceptions } from "../../packages/db/src/workbench-exceptions.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import {
  HISTORICAL_RECONCILIATION_PLAN_ID,
  calculatePlanSha256,
  runHistoricalReconciliation,
  type HistoricalPaymentPlan,
  type HistoricalOrderPlan
} from "../../scripts/operations/historical-payment-reconciliation.ts";
import { testDatabaseUrl } from "../helpers/database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const defaultDatabaseUrl = new URL(testDatabaseUrl);
defaultDatabaseUrl.pathname = "/qintopia_historical_payment_reconciliation_test";
const databaseUrl = process.env.HISTORICAL_PAYMENT_RECONCILIATION_TEST_DATABASE_URL ?? defaultDatabaseUrl.toString();
const principal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "historical-reconciliation-session",
  credentialType: "SESSION",
  displayName: "历史合付款合成验收",
  ...authScope({ credentialType: "SESSION", profile: "administrator" })
};
let db: Kysely<Database>;
let sequence = 0;
const metadata = () => ({ idempotencyKey: `historical-fixture-${++sequence}`, correlationId: `historical-fixture-${sequence}` });

async function applyMigrations(client: pg.Client, historicalBaseline: boolean) {
  const directory = resolve(process.cwd(), "packages/db/src/migrations");
  const names = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of names.filter(name => (Number(name.slice(0, 3)) < 77) === historicalBaseline)) {
    await client.query(await readFile(resolve(directory, name), "utf8"));
    await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  }
}

async function resetHistoricalBaselineDatabase() {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  } finally { await admin.end(); }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try { await applyMigrations(client, true); } finally { await client.end(); }
  const connection = createDatabase(databaseUrl);
  await seedDemo(connection, { includeProtocolFixturePolicy: true });
  // Current readers include the new optional evidence relation. An empty view
  // lets them read pre-077 fixtures without inventing any maintenance evidence.
  await sql`CREATE VIEW owner_historical_payment_reprices AS SELECT NULL::text AS amendment_id,
    NULL::text AS command_id,NULL::text AS order_id WHERE false`.execute(connection);
  return connection;
}

async function execute(command: CommandEnvelope) {
  const prepared = await createCommandPreview(db, principal, command, metadata());
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: command.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: command.commandType === "CREATE_ORDER"
      ? command.input.backfill === true
        ? { code: "BACKFILL_STAY", note: "历史合付款合成夹具" }
        : { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "HISTORICAL_FIXTURE", note: "历史合付款合成夹具" }
  }, metadata());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}

async function fixture(legacyMatches = false): Promise<HistoricalPaymentPlan> {
  const orders: HistoricalOrderPlan[] = [];
  for (const key of ["303", "306", "D03", "D04"] as const) {
    const unit = await db.selectFrom("inventory_units").select("id").where("code", "=", key).executeTakeFirstOrThrow();
    const target = key === "D04" ? 13000 : 18000;
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: unit.id,
      stayType: "TRANSIENT",
      arrivalDate: "2026-10-02",
      departureDate: "2026-10-03",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    });
    const createEnvelope: CommandEnvelope = { commandType: "CREATE_ORDER", input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `历史合付款 ${key}`, nickname: `合成 ${key}` },
      bookingChannelCode: "WECOM",
      targetCurrentContractAmountMinor: target,
      ...(target === quote.currentContractAmount.minorUnits ? {} : { manualPriceAdjustmentReason: "合成历史协议价" }),
      ...(key === "D04" ? {} : { backfill: true, backfillReason: "历史合付款合成夹具" })
    } };
    const created = key === "D04"
      ? await withPropertyClockForTesting(new Date("2026-10-02T04:00:00Z"), () => execute(createEnvelope))
      : await execute(createEnvelope);
    const orderId = created.result!.orderId as string;
    if (key === "D04") await withPropertyClockForTesting(new Date("2026-10-02T04:00:00Z"), () => execute({
      commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId }
    }));
    const view = await getOrderView(db, orderId);
    expect(view.order.status).toBe(key === "D04" ? "CHECKED_IN" : "CHECKED_OUT");
    orders.push({ key, orderId, expectedVersion: view.order.version,
      expectedCurrentContractAmountMinor: key === "D04" ? 0 : target,
      targetCurrentContractAmountMinor: target,
      originalFactId: null, originalAmountMinor: key === "303" ? 36000 : key === "D03" ? 31000 : 0,
      billKey: key === "303" || key === "306" ? "xiaonian" : "liuguang" });
  }
  // Recreate the former zero-price result as an appended historical revision.
  // Keep the original 13000 revision and run all database guards normally.
  await db.transaction().execute(async trx => {
    const orderId = orders[3]!.orderId;
    const prior = await trx.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no", "desc").executeTakeFirstOrThrow();
    const input = { propertyId: demo.propertyId, orderId, targetCurrentContractAmountMinor: 0 };
    const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
    const effect = { orderId, inventoryUnitId: "unit_room_d_gen_04", bookingChannelCode: "WECOM",
      stayTimeline: [{ serviceDate: "2026-10-02", inventoryUnitId: "unit_room_d_gen_04" }],
      before: { currentContractAmount: money(13000) }, policyBaseAmount: money(prior.policy_base_amount_minor),
      targetCurrentContractAmount: money(0), manualAdjustmentMinor: -prior.policy_base_amount_minor,
      pricing: { coverageSet: prior.coverage_set, cashLines: prior.cash_lines,
        cashRemainder: money(prior.policy_base_amount_minor), currentContractAmount: money(0) } };
    const commandId = newId("command");
    const previewId = newId("preview");
    const reason = { code: "REPRICE_ORDER", note: "历史误操作：合付款已记在D03" };
    const effectHash = stableHash(effect);
    await trx.insertInto("command_executions").values({ id: commandId, subject_id: principal.subjectId,
      credential_id: principal.credentialId, property_id: demo.propertyId, command_type: "REPRICE_ORDER",
      idempotency_key: "legacy-d04-zero", request_hash: stableHash(input), correlation_id: "legacy-d04-zero",
      state: "EXECUTING", completed_at: null }).execute();
    await trx.insertInto("command_previews").values({ id: previewId, subject_id: principal.subjectId,
      property_id: demo.propertyId, command_type: "REPRICE_ORDER", normalized_input: input, input_hash: stableHash(input),
      effect, effect_hash: effectHash, basis_versions: {}, expires_at: new Date(Date.now() + 60000), status: "USED", used_at: new Date() }).execute();
    const applied = await applyCommand(trx, { commandType: "REPRICE_ORDER", input, effect, reason, commandId });
    await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() }).where("id", "=", commandId).execute();
    await trx.insertInto("command_receipts").values({ id: newId("receipt"), command_id: commandId,
      execution_status: "EXECUTED", business_committed: true, result: { ...applied.persistedResult, effectHash },
      error: null, resource_refs: JSON.stringify(applied.resourceRefs), fact_refs: JSON.stringify(applied.factRefs), committed_at: new Date() }).execute();
    await trx.insertInto("audit_entries").values({ id: newId("audit"), subject_id: principal.subjectId,
      credential_id: principal.credentialId, action: "REPRICE_ORDER", decision: "ALLOWED", command_id: commandId,
      correlation_id: "legacy-d04-zero", reason, target_refs: JSON.stringify(applied.resourceRefs), metadata: { previewId, effectHash } }).execute();
  });
  await withPropertyClockForTesting(new Date("2026-10-03T04:00:00Z"), () => execute({
    commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: orders[3]!.orderId }
  }));
  orders[3]!.expectedVersion = (await db.selectFrom("orders").select("version").where("id", "=", orders[3]!.orderId).executeTakeFirstOrThrow()).version;

  const now = new Date("2026-10-03T04:00:00Z");
  const bills: WecomBill[] = [
    { kind: "COLLECTION", merchantId: "m1", reference: "HISTORY-XIAONIAN-360", originalTradeNo: "history-xiaonian-trade", transactionId: "HISTORY-XIAONIAN-360", externalUserId: "synthetic-xiaonian", collectorId: "synthetic-staff", amountMinor: 36000, occurredAt: new Date(now.getTime() - 60000), state: "SUCCESS" },
    { kind: "COLLECTION", merchantId: "m1", reference: "HISTORY-LIUGUANG-310", originalTradeNo: "history-liuguang-trade", transactionId: "HISTORY-LIUGUANG-310", externalUserId: "synthetic-liuguang", collectorId: "synthetic-staff", amountMinor: 31000, occurredAt: new Date(now.getTime() - 60000), state: "SUCCESS" }
  ];
  const client: PaymentClient = { bills: async (begin, end) => ({ bills: bills.filter(bill => bill.occurredAt >= begin && bill.occurredAt <= end), nextCursor: null }), nickname: async () => "合成付款人" };
  await syncWecomSource(db, "historical-source", client, now);
  const planBills: HistoricalPaymentPlan["bills"] = [];
  for (const [index, key] of (["xiaonian", "liuguang"] as const).entries()) {
    const bill = (await sql<{ id: string }>`SELECT id FROM external_payment_bills WHERE reference=${bills[index]!.reference}`.execute(db)).rows[0]!;
    const original = orders.find(order => order.key === (key === "xiaonian" ? "303" : "D03"))!;
    if (legacyMatches) vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "false");
    original.originalFactId = (await execute({ commandType: "RECORD_COLLECTION", input: {
      propertyId: demo.propertyId, orderId: original.orderId, ...(!legacyMatches ? { externalPaymentBillId: bill.id } : {}),
      amountMinor: original.originalAmountMinor, method: "WECOM", transactionReference: bills[index]!.reference,
      note: "合付款功能前的整笔归属夹具"
    } })).factRefs[0]!;
    vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "true");
    planBills.push({ key, billId: bill.id, reference: bills[index]!.reference,
      amountMinor: key === "xiaonian" ? 36000 : 31000,
      allocations: key === "xiaonian"
        ? [{ orderKey: "303", amountMinor: 18000 }, { orderKey: "306", amountMinor: 18000 }]
        : [{ orderKey: "D03", amountMinor: 18000 }, { orderKey: "D04", amountMinor: 13000 }] });
  }
  // Apply the new guards and owner repair entry only after creating the actual
  // legacy shape on schema 076, so no guard is disabled to forge test data.
  await sql`DROP VIEW owner_historical_payment_reprices`.execute(db);
  const migrationClient = new pg.Client({ connectionString: databaseUrl });
  await migrationClient.connect();
  try { await applyMigrations(migrationClient, false); } finally { await migrationClient.end(); }
  const base: Omit<HistoricalPaymentPlan, "planSha256"> = { planId: HISTORICAL_RECONCILIATION_PLAN_ID, propertyId: demo.propertyId, orders, bills: planBills };
  return { ...base, planSha256: calculatePlanSha256(base) };
}

async function snapshot() {
  const rows = await sql<{ snapshot: unknown }>`SELECT jsonb_build_object(
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM orders o),
    'revisions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM pricing_revisions p),
    'amendments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM amendments a),
    'facts',(SELECT jsonb_agg(to_jsonb(f) ORDER BY fact_id) FROM collection_facts f),
    'allocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM external_payment_allocations a),
    'releases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM external_payment_allocation_releases r),
    'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM command_executions c),
    'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM command_receipts r),
    'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_entries a),
    'ownerEvidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY command_id) FROM owner_historical_payment_reprices e),
    'channelOperatingFacts',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM channel_operating_facts f),
    'operatingSalesOpening',(SELECT jsonb_agg(to_jsonb(o) ORDER BY to_jsonb(o)::text) FROM operating_sales_opening o),
    'operatingSalesBaselines',(SELECT jsonb_agg(to_jsonb(b) ORDER BY to_jsonb(b)::text) FROM operating_sales_baselines b),
    'entitlementLedger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY fact_id) FROM entitlement_ledger l),
    'retainedFunds',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM retained_funds f),
    'retainedFundEntries',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM retained_fund_entries e),
    'allocationEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text) FROM payment_allocation_events e),
    'paymentDeliveryEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text) FROM payment_delivery_events e),
    'integrationOutbox',(SELECT jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text) FROM integration_outbox e)
  ) AS snapshot`.execute(db);
  return rows.rows[0]!.snapshot;
}

async function stayAndInventorySnapshot(orderIds: string[]) {
  return (await sql<{ snapshot: unknown }>`SELECT jsonb_build_object(
    'lifecycle',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'arrivalDate',arrival_date,'departureDate',departure_date) ORDER BY id)
      FROM orders WHERE id=ANY(${orderIds}::text[])),
    'stays',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM stays s WHERE order_id=ANY(${orderIds}::text[])),
    'segments',(SELECT jsonb_agg(to_jsonb(seg) ORDER BY seg.id) FROM stay_segments seg JOIN stays s ON s.id=seg.stay_id WHERE s.order_id=ANY(${orderIds}::text[])),
    'claims',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM inventory_claims c JOIN stay_segments seg ON seg.id=c.source_id
      JOIN stays s ON s.id=seg.stay_id WHERE c.source_type='ORDER_SEGMENT' AND s.order_id=ANY(${orderIds}::text[])),
    'roomDays',(SELECT jsonb_agg(to_jsonb(d) ORDER BY to_jsonb(d)::text) FROM inventory_room_days d),
    'bedDays',(SELECT jsonb_agg(to_jsonb(d) ORDER BY to_jsonb(d)::text) FROM inventory_bed_days d)
  ) AS snapshot`.execute(db)).rows[0]!.snapshot;
}

const run = (plan: HistoricalPaymentPlan, dryRun = false) => runHistoricalReconciliation(db, plan, { principal, dryRun, approvedPlanSha256: plan.planSha256 });

beforeEach(async () => {
  vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "true");
  db = await resetHistoricalBaselineDatabase();
  await db.insertInto("web_sessions").values({ id: principal.credentialId, subject_id: principal.subjectId, secret_hash: "a".repeat(64), expires_at: new Date(Date.now() + 3600000), revoked_at: null }).execute();
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
    VALUES('historical-source','synthetic-corp',true,'2026-09-01','2026-09-01','2026-10-03 03:58:00+00',true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('historical-source','m1',${demo.propertyId})`.execute(db);
});
afterEach(async () => { await db?.destroy(); vi.unstubAllEnvs(); });

describe.sequential("fixed historical payment runner on PostgreSQL", () => {
  it("defaults to dry-run and reports fixed targets without any writes", async () => {
    const plan = await fixture();
    const before = await snapshot();
    const report = await runHistoricalReconciliation(db, plan, { principal });
    expect(report).toMatchObject({ mode: "dry-run", cashBeforeMinor: 67000, cashAfterMinor: 67000 });
    expect(report.orders.map(order => [order.key, order.beforeMinor, order.afterMinor])).toEqual([
      ["303", 18000, 18000], ["306", 18000, 18000], ["D03", 18000, 18000], ["D04", 0, 13000]
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it("restores D04 to 13000 and commits the exact four shares with receipt evidence", async () => {
    const plan = await fixture();
    const d04 = plan.orders.find(order => order.key === "D04")!;
    const controlQuote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT", arrivalDate: "2026-10-04", departureDate: "2026-10-05", pricingPolicyVersionId: demo.publicPricingPolicyId });
    const control = await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: controlQuote.quoteId,
      primaryGuest: { fullName: "未参与修复的欠款对照单", nickname: "欠款对照" }, bookingChannelCode: "WECOM",
      targetCurrentContractAmountMinor: controlQuote.currentContractAmount.minorUnits, backfill: true, backfillReason: "历史合付款合成夹具" } });
    const controlOrderId = control.result!.orderId as string;
    const beforeExceptions = await getWorkbenchExceptions(db, { propertyId: demo.propertyId, limit: 100 });
    const expectedPriorReasons = { "303": "OVERPAYMENT", "306": "BALANCE_DUE", D03: "OVERPAYMENT" } as const;
    for (const [key, code] of Object.entries(expectedPriorReasons)) {
      const orderId = plan.orders.find(order => order.key === key)!.orderId;
      expect(beforeExceptions.items.find(item => item.orderId === orderId)?.reasons.some(reason => reason.code === code)).toBe(true);
    }
    const controlBefore = beforeExceptions.items.find(item => item.orderId === controlOrderId);
    expect(controlBefore?.reasons).toEqual([expect.objectContaining({ code: "BALANCE_DUE" })]);
    const orderIds = plan.orders.map(order => order.orderId);
    const originalStayAndInventory = await stayAndInventorySnapshot(orderIds);
    const oldRevisions = await db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", d04.orderId).orderBy("revision_no").execute();
    expect(await run(plan)).toMatchObject({ mode: "execute", cashBeforeMinor: 67000, cashAfterMinor: 67000 });
    expect(await stayAndInventorySnapshot(orderIds)).toEqual(originalStayAndInventory);
    for (const item of plan.orders) {
      const view = await getOrderView(db, item.orderId);
      expect(view.amounts.currentContractAmount.minorUnits).toBe(item.targetCurrentContractAmountMinor);
      expect(view.amounts.netRecordedCollection.minorUnits).toBe(item.targetCurrentContractAmountMinor);
    }
    const revisions = await db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", d04.orderId).orderBy("revision_no").execute();
    expect(revisions.slice(0, -1)).toEqual(oldRevisions);
    expect(revisions.at(-1)).toMatchObject({ current_contract_amount_minor: 13000 });
    const shares = (await sql<{ order_id: string; amount_minor: number }>`SELECT f.order_id,a.amount_minor FROM external_payment_allocations a
      JOIN collection_facts f ON f.fact_id=a.collection_fact_id WHERE NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id)
      ORDER BY f.order_id`.execute(db)).rows;
    expect(shares).toEqual(plan.orders.map(order => ({ order_id: order.orderId, amount_minor: order.targetCurrentContractAmountMinor })).sort((a,b) => a.order_id.localeCompare(b.order_id)));
    const receipts = await db.selectFrom("command_receipts").innerJoin("command_executions", "command_executions.id", "command_receipts.command_id")
      .select(["command_receipts.result", "command_receipts.business_committed", "command_executions.command_type"])
      .where("command_executions.correlation_id", "like", `${plan.planId}%`).execute();
    expect(receipts.length).toBeGreaterThanOrEqual(7);
    expect(receipts.every(receipt => receipt.business_committed)).toBe(true);
    const repriced = receipts.find(receipt => receipt.command_type === "REPRICE_ORDER");
    expect(repriced?.result).toMatchObject({
      orderId: d04.orderId,
      pricingRevisionId: revisions.at(-1)!.id,
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 13000 },
      manualAdjustmentMinor: 13000 - revisions.at(-1)!.policy_base_amount_minor
    });
    const runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      const runtimeView = await getOrderView(runtime, d04.orderId);
      expect(runtimeView.amounts.currentContractAmount.minorUnits).toBe(13000);
      const exceptions = await getWorkbenchExceptions(runtime, { propertyId: demo.propertyId, limit: 100 });
      expect(exceptions.items.filter(item => orderIds.includes(item.orderId))
        .flatMap(item => item.reasons.filter(reason => reason.code === "BALANCE_DUE" || reason.code === "OVERPAYMENT"))).toEqual([]);
      expect(exceptions.items.find(item => item.orderId === controlOrderId)).toEqual(controlBefore);
      expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM owner_historical_payment_reprices
        WHERE order_id=${d04.orderId} AND pricing_revision_id=${revisions.at(-1)!.id}`.execute(runtime)).rows[0]?.count).toBe("1");
    } finally { await runtime.destroy(); }
    for (const original of plan.orders.filter(order => order.originalFactId)) {
      expect(await db.selectFrom("collection_facts").select("fact_id").where("fact_id", "=", original.originalFactId!).execute()).toHaveLength(1);
      expect(await db.selectFrom("collection_facts").select("fact_id").where("reverses_fact_id", "=", original.originalFactId!).execute()).toHaveLength(1);
    }
  });

  it("reconciles legacy external matches and their mirrored allocations without changing the old facts", async () => {
    const plan = await fixture(true);
    const originalIds = plan.orders.flatMap(order => order.originalFactId ? [order.originalFactId] : []);
    const originals = await db.selectFrom("collection_facts").selectAll().where("fact_id", "in", originalIds).orderBy("fact_id").execute();
    expect(originals.every(fact => fact.external_payment_bill_id === null)).toBe(true);
    const matches = (await sql`SELECT * FROM external_payment_matches ORDER BY bill_id`.execute(db)).rows;
    expect(matches).toHaveLength(2);
    expect((await sql<{ origin: string }>`SELECT origin FROM external_payment_allocations ORDER BY id`.execute(db)).rows)
      .toEqual([{ origin: "HISTORICAL_LINK" }, { origin: "HISTORICAL_LINK" }]);
    expect(await run(plan)).toMatchObject({ cashBeforeMinor: 67000, cashAfterMinor: 67000 });
    expect(await db.selectFrom("collection_facts").selectAll().where("fact_id", "in", originalIds).orderBy("fact_id").execute()).toEqual(originals);
    expect((await sql`SELECT * FROM external_payment_matches ORDER BY bill_id`.execute(db)).rows).toEqual(matches);
    expect((await sql`SELECT id FROM external_payment_allocation_releases`.execute(db)).rows).toHaveLength(2);
  });

  it("rolls the whole repair back if the final allocation write fails", async () => {
    const plan = await fixture();
    const before = await snapshot();
    await sql.raw(`CREATE FUNCTION fail_historical_final_share() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.fact_type='COLLECTION' AND NEW.amount_minor=13000 THEN RAISE EXCEPTION 'forced final historical allocation failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER fail_historical_final_share BEFORE INSERT ON collection_facts FOR EACH ROW EXECUTE FUNCTION fail_historical_final_share()`).execute(db);
    await expect(run(plan)).rejects.toThrow(/forced final historical allocation failure/);
    expect(await snapshot()).toEqual(before);
    expect((await sql`SELECT command_id FROM owner_historical_payment_reprices`.execute(db)).rows).toHaveLength(0);
  });

  it("rejects changed order versions before producing any repair writes", async () => {
    const plan = await fixture();
    plan.orders[0]!.expectedVersion += 1;
    const { planSha256: _sha, ...body } = plan;
    plan.planSha256 = calculatePlanSha256(body);
    const before = await snapshot();
    await expect(run(plan)).rejects.toThrow(/版本|漂移/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects an unapproved plan or missing external bill without any writes", async () => {
    const plan = await fixture();
    const before = await snapshot();
    await expect(runHistoricalReconciliation(db, plan, { principal, dryRun: false, approvedPlanSha256: "0".repeat(64) }))
      .rejects.toThrow(/已审阅|SHA/);
    expect(await snapshot()).toEqual(before);
    plan.bills[1]!.billId = "missing-historical-bill";
    const { planSha256: _sha, ...body } = plan;
    plan.planSha256 = calculatePlanSha256(body);
    await expect(run(plan)).rejects.toThrow(/账单|事实漂移/);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a second execution without appending any duplicate facts", async () => {
    const plan = await fixture();
    await run(plan);
    const afterFirst = await snapshot();
    await expect(run(plan)).rejects.toThrow();
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("allows only one of two concurrent executions to commit", async () => {
    const plan = await fixture();
    const results = await Promise.allSettled([run(plan), run(plan)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const facts = await db.selectFrom("collection_facts").select(["fact_type", "net_effect_minor"]).execute();
    expect(facts.filter(fact => fact.fact_type === "REVERSAL")).toHaveLength(2);
    expect(facts.filter(fact => fact.fact_type === "COLLECTION")).toHaveLength(6);
    expect(facts.reduce((sum, fact) => sum + fact.net_effect_minor, 0)).toBe(67000);
  });
});
