import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Kysely } from "kysely";
import pg from "pg";
import type { AuthPrincipal } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview, type Database } from "@qintopia/db";
import { paymentAllocationReady } from "../../packages/db/src/payment-allocation-readiness.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const defaultDatabaseUrl = new URL(testDatabaseUrl);
defaultDatabaseUrl.pathname = "/qintopia_allocation_schema_test";
const databaseUrl = process.env.PAYMENT_ALLOCATION_SCHEMA_TEST_DATABASE_URL ?? defaultDatabaseUrl.toString();
let db: Kysely<Database>;
let writer: pg.Client;
let owner: pg.Client;
let sequence = 0;
let source: string;
let target: string;
let commandId: string;
const principal: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "allocation-schema-session", credentialType: "SESSION", displayName: "Schema regression", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
const meta = () => ({ idempotencyKey: `schema-${++sequence}`, correlationId: `schema-${sequence}` });

// Only order setup uses the application. Every financial mutation below is direct SQL,
// under the real runtime role, with all triggers and deferred constraints enabled.
async function order(day: number) {
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT", arrivalDate: `2028-12-${day}`, departureDate: `2028-12-${day + 1}`, pricingPolicyVersionId: demo.transientPolicyId });
  const envelope = { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: "数据库防线", nickname: "合成测试", phone: "13800000000" }, bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: 100000, manualPriceAdjustmentReason: "合成资金验收协议价" } } as const;
  const prepared = await createCommandPreview(db, principal, envelope, meta());
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, { propertyId: demo.propertyId, commandType: envelope.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, meta());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt.result!.orderId as string;
}
async function transaction(action: () => Promise<unknown>, client = writer) {
  await client.query("BEGIN");
  try { await action(); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function rejected(action: () => Promise<unknown>, message: RegExp, client = writer) {
  const before = await snapshot();
  await expect(transaction(action, client)).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(message) });
  expect(await snapshot()).toEqual(before);
}
async function snapshot() {
  const result = await owner.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY fact_id),'[]') FROM collection_facts f) facts,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM external_payment_allocations a) allocations,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM external_payment_allocation_releases r) releases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY id),'[]') FROM retained_funds h) retained,
    (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM retained_fund_entries e) entries`);
  return result.rows;
}
async function fact(id: string, amount: number, options: { orderId?: string; type?: string; bill?: string | null; reference?: string; parent?: string } = {}) {
  const type = options.type ?? "COLLECTION";
  const bill = options.bill === undefined ? "schema-bill" : options.bill;
  await writer.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,transaction_reference,references_fact_id,external_payment_bill_id)
    SELECT $1,id,$3,$4,$5,'CNY','WECOM','direct SQL regression',$6,current_revision_id,$7,$8,$9 FROM orders WHERE id=$2`,
  [id, options.orderId ?? source, type, amount, type === "REALLOCATION_OUT" ? -amount : amount, commandId, type === "COLLECTION" ? options.reference ?? "schema-reference" : null, options.parent ?? null, bill]);
}
async function allocation(id: string, factId: string, amount: number) {
  await writer.query(`INSERT INTO external_payment_allocations(id,bill_id,collection_fact_id,amount_minor,command_id,origin) VALUES($1,'schema-bill',$2,$3,$4,'CONFIRMED')`, [id, factId, amount, commandId]);
}
async function collect(amount = 100000) {
  await transaction(async () => { await fact("source-fact", amount); await allocation("source-allocation", "source-fact", amount); });
  // Retention requires a terminal order with surplus, not merely a paid reservation.
  const envelope = { commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: source } } as const;
  const prepared = await createCommandPreview(db, principal, envelope, meta());
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, { propertyId: demo.propertyId, commandType: envelope.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash, reason: { code: "SCHEMA_TEST", note: "取消订单后测试留存资金" } }, meta());
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
}
async function retain(id = "retained", amount = 60000) {
  await writer.query(`INSERT INTO retained_funds(id,property_id,source_order_id,source_fact_id,bill_id,owner_name,owner_contact,confirmation_note,amount_minor,command_id)
    VALUES($1,$2,$3,'source-fact','schema-bill','客户','13800000000','客户确认留存',$4,$5)`, [id, demo.propertyId, source, amount, commandId]);
}
async function use(amount = 40000, inAmount = amount) {
  await fact("out", amount, { type: "REALLOCATION_OUT", parent: "source-fact" });
  await fact("in", inAmount, { type: "REALLOCATION_IN", parent: "source-fact", orderId: target });
  await writer.query(`INSERT INTO retained_fund_entries(id,retained_fund_id,kind,amount_minor,target_order_id,source_out_fact_id,target_in_fact_id,authorization_note,command_id)
    VALUES('use','retained','USE',$1,$2,'out','in','客户授权跨订单使用',$3)`, [amount, target, commandId]);
}

async function externalRefund(origin: "CONFIRMED" | "HISTORICAL_LINK") {
  await owner.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,transaction_id,amount_minor,occurred_at,state)
    VALUES('schema-refund-bill','schema-source','schema-merchant',$1,'REFUND','schema-refund-reference','schema-trade','schema-reference',30000,now(),'SUCCESS')`, [demo.propertyId]);
  await transaction(async () => {
    await writer.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,transaction_reference,references_fact_id,refund_reference,external_payment_bill_id)
      SELECT 'external-refund',id,'REFUND',30000,-30000,'CNY','WECOM','synthetic refund',$1,current_revision_id,NULL,'source-fact','schema-refund-reference',$3 FROM orders WHERE id=$2`,
    [commandId, source, origin === "CONFIRMED" ? "schema-refund-bill" : null]);
    if (origin === "CONFIRMED") {
      await writer.query(`INSERT INTO external_payment_allocations(id,bill_id,collection_fact_id,amount_minor,command_id,origin)
        VALUES('refund-allocation','schema-refund-bill','external-refund',30000,$1,'CONFIRMED')`, [commandId]);
    } else {
      await writer.query(`INSERT INTO external_payment_matches(bill_id,collection_fact_id,origin)
        VALUES('schema-refund-bill','external-refund','HISTORICAL_LINK')`);
    }
  });
}
async function reverseRefund() {
  await writer.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,reverses_fact_id)
    SELECT 'refund-reversal',order_id,'REVERSAL',amount_minor,-net_effect_minor,currency,method,'synthetic reversal',$1,pricing_revision_id,fact_id
    FROM collection_facts WHERE fact_id='external-refund'`, [commandId]);
}
async function releaseRefund() {
  await writer.query(`INSERT INTO external_payment_allocation_releases(id,allocation_id,reversal_fact_id,command_id)
    SELECT 'refund-release',id,'refund-reversal',$1 FROM external_payment_allocations WHERE collection_fact_id='external-refund'`, [commandId]);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
  owner = new pg.Client({ connectionString: databaseUrl }); await owner.connect();
  writer = new pg.Client({ connectionString: runtimeDatabaseUrlForTesting(databaseUrl) }); await writer.connect();
  await db.insertInto("web_sessions").values({ id: principal.credentialId, subject_id: principal.subjectId, secret_hash: "a".repeat(64), expires_at: new Date(Date.now() + 3600000), revoked_at: null }).execute();
  source = await order(10); target = await order(12);
  commandId = (await owner.query("SELECT id FROM command_executions WHERE command_type='CREATE_ORDER' ORDER BY created_at LIMIT 1")).rows[0].id;
  await owner.query(`INSERT INTO external_payment_sources(id,corp_id,enabled,import_since,baseline_complete) VALUES('schema-source','schema-corp',true,'2026-09-01',true)`);
  await owner.query(`INSERT INTO external_payment_accounts VALUES('schema-source','schema-merchant',$1)`, [demo.propertyId]);
  await owner.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,transaction_id,amount_minor,occurred_at,state)
    VALUES('schema-bill','schema-source','schema-merchant',$1,'COLLECTION','schema-reference','schema-trade','schema-reference',100000,now(),'SUCCESS')`, [demo.propertyId]);
});
afterEach(async () => { await writer?.end(); await owner?.end(); await db?.destroy(); });

describe("069 direct database allocation invariants", () => {
  it("accepts the verified allocation fingerprint and restricted privileges", async () => {
    expect(await paymentAllocationReady(db)).toBe(true);
  });
  it("runs financial SQL as the restricted runtime role and commits a valid split", async () => {
    expect((await writer.query("SELECT current_user")).rows[0].current_user).toBe("qintopia_runtime");
    await collect(40000);
    await transaction(async () => { await fact("second", 60000, { orderId: target }); await allocation("second-allocation", "second", 60000); });
    expect((await writer.query("SELECT sum(amount_minor)::int total,count(*)::int count FROM external_payment_allocations")).rows[0]).toEqual({ total: 100000, count: 2 });
  });
  it("rejects a source belonging to a different property", async () => {
    await owner.query(`INSERT INTO properties(id,code,name,timezone,currency) VALUES('schema-foreign','SCHEMA_FOREIGN','Other property','Asia/Shanghai','CNY')`);
    await owner.query(`INSERT INTO external_payment_accounts VALUES('schema-source','foreign-merchant','schema-foreign')`);
    await owner.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,amount_minor,occurred_at,state)
      VALUES('foreign-bill','schema-source','foreign-merchant','schema-foreign','COLLECTION','foreign-reference','foreign-trade',100000,now(),'SUCCESS')`);
    await rejected(() => fact("foreign", 1, { bill: "foreign-bill", reference: "foreign-reference" }), /cross-property/);
  });
  it("rejects aggregate allocation beyond the bill and rolls back its cash fact", async () => {
    await collect(60000);
    await rejected(async () => { await fact("overflow", 40001, { orderId: target }); await allocation("overflow-allocation", "overflow", 40001); }, /allocation exceeds/);
  });
  it("rejects an explicit cash fact without its allocation at commit", async () => {
    await rejected(() => fact("orphan-cash", 100), /requires matching allocation/);
  });
  it("rejects a mismatched allocation amount", async () => {
    await rejected(async () => { await fact("bad-amount", 100); await allocation("bad-allocation", "bad-amount", 99); }, /invalid allocation fact graph/);
  });
  it("rejects double reservation of the same collection", async () => {
    await collect(); await transaction(() => retain());
    await rejected(() => retain("duplicate", 40001), /retained|occupied|remaining|exceed|reserved/);
  });
  it.each(["REALLOCATION_IN", "REALLOCATION_OUT"])("rejects unpaired %s at commit", async type => {
    await collect(); await transaction(() => retain());
    await rejected(() => fact("unpaired", 100, { type, parent: "source-fact", orderId: type === "REALLOCATION_IN" ? target : source }), /paired atomically/);
  });
  it("commits matched IN/OUT atomically without increasing total money", async () => {
    await collect(); await transaction(() => retain()); await transaction(() => use());
    expect((await writer.query("SELECT sum(net_effect_minor)::int total FROM collection_facts")).rows[0].total).toBe(100000);
    expect((await writer.query("SELECT order_id,sum(net_effect_minor)::int total FROM collection_facts GROUP BY order_id ORDER BY total")).rows).toEqual([{ order_id: target, total: 40000 }, { order_id: source, total: 60000 }]);
  });
  it("rejects unequal IN/OUT even when a USE entry exists", async () => {
    await collect(); await transaction(() => retain());
    await rejected(() => use(40000, 39999), /entry graph mismatch/);
  });
  it("rejects spending more than the retained amount", async () => {
    await collect(); await transaction(() => retain());
    await rejected(() => use(60001), /retained funds overspent/);
  });
  it("does not let an ordinary refund spend money already reserved", async () => {
    await collect(); await transaction(() => retain());
    await rejected(() => writer.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,references_fact_id,refund_reference)
      SELECT 'bypass-refund',id,'REFUND',40001,-40001,'CNY','WECOM','cannot spend reserved funds',$1,current_revision_id,'source-fact','schema-refund' FROM orders WHERE id=$2`, [commandId, source]), /source funds overspent or reserved/);
  });
  it.each(["CONFIRMED", "HISTORICAL_LINK"] as const)("rejects a newly inserted %s external refund reversal without release at commit", async origin => {
    await collect(); await externalRefund(origin);
    // INSERT succeeds with constraints deferred; COMMIT must reject and roll back.
    let inserted = false;
    await rejected(async () => { await reverseRefund(); inserted = true; }, /external refund reversal requires attribution release/);
    expect(inserted).toBe(true);
    // A separate later transaction cannot release a reversal that failed to commit.
    await expect(transaction(releaseRefund)).rejects.toMatchObject({ code: "23503" });
    expect((await snapshot())[0].releases).toEqual([]);
  });
  it.each(["CONFIRMED", "HISTORICAL_LINK"] as const)("commits %s refund reversal and release together, but keeps the refunded source frozen", async origin => {
    await collect(); await externalRefund(origin);
    await transaction(async () => { await reverseRefund(); await releaseRefund(); });
    expect((await writer.query(`SELECT a.amount_minor FROM external_payment_allocations a
      WHERE a.bill_id='schema-refund-bill' AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id)`)).rows).toEqual([]);
    expect((await snapshot())[0].releases).toHaveLength(1);
    // Reversing the order fact does not undo the successful external refund.
    await rejected(() => retain(), /unassigned successful refund freezes source funds/);
  });
  it("rejects an invented historical allocation without a legacy match", async () => {
    await transaction(() => fact("unmatched-legacy", 100000, { bill: null }));
    await rejected(() => writer.query(`INSERT INTO external_payment_allocations(id,bill_id,collection_fact_id,amount_minor,origin)
      VALUES('fake-legacy','schema-bill','unmatched-legacy',100000,'HISTORICAL_LINK')`), /invalid allocation fact graph/);
  });
  it("releases retention to its order, not to public allocation capacity", async () => {
    await collect(); await transaction(() => retain());
    const before = (await snapshot())[0];
    await transaction(() => writer.query(`INSERT INTO retained_fund_entries(id,retained_fund_id,kind,amount_minor,authorization_note,command_id)
      VALUES('release-retention','retained','RELEASE',60000,'客户撤回留存',$1)`, [commandId]));
    const after = (await snapshot())[0];
    expect(after.facts).toEqual(before.facts);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.releases).toEqual([]);
    await rejected(async () => { await fact("reallocate-released", 1, { orderId: target }); await allocation("reallocate-released", "reallocate-released", 1); }, /allocation exceeds/);
  });
  it("keeps allocation release history append-only, even for the owner", async () => {
    await collect();
    await owner.query(`INSERT INTO command_executions(id,subject_id,credential_id,property_id,command_type,idempotency_key,request_hash,correlation_id,state)
      SELECT 'schema-reverse',subject_id,credential_id,property_id,'REVERSE_FACT','schema-reverse',request_hash,'schema-reverse','EXECUTING' FROM command_executions WHERE id=$1`, [commandId]);
    await transaction(async () => {
      await writer.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,reverses_fact_id)
        SELECT 'reversal',id,'REVERSAL',100000,-100000,'CNY','WECOM','误录冲销','schema-reverse',current_revision_id,'source-fact' FROM orders WHERE id=$1`, [source]);
      await writer.query(`INSERT INTO external_payment_allocation_releases(id,allocation_id,reversal_fact_id,command_id)
        VALUES('allocation-release','source-allocation','reversal','schema-reverse')`);
    });
    expect((await writer.query("SELECT count(*)::int count FROM external_payment_allocation_releases")).rows[0].count).toBe(1);
    for (const statement of ["UPDATE external_payment_allocation_releases SET id=id", "DELETE FROM external_payment_allocation_releases"]) {
      await expect(transaction(() => writer.query(statement))).rejects.toMatchObject({ code: "42501" });
      await rejected(() => owner.query(statement), /append-only/, owner);
    }
  });
  it("mirrors a legacy whole-bill match once without creating more cash", async () => {
    await transaction(() => fact("legacy-fact", 100000, { bill: null }));
    const cashBefore = (await snapshot())[0].facts;
    await transaction(() => writer.query(`INSERT INTO external_payment_matches(bill_id,collection_fact_id,origin) VALUES('schema-bill','legacy-fact','CONFIRMED')`));
    expect((await snapshot())[0].facts).toEqual(cashBefore);
    await transaction(() => writer.query(`INSERT INTO external_payment_matches(bill_id,collection_fact_id,origin) VALUES('schema-bill','legacy-fact','CONFIRMED') ON CONFLICT DO NOTHING`));
    expect((await snapshot())[0].facts).toEqual(cashBefore);
    expect((await writer.query("SELECT bill_id,collection_fact_id,amount_minor,origin,command_id FROM external_payment_allocations")).rows).toEqual([{ bill_id: "schema-bill", collection_fact_id: "legacy-fact", amount_minor: 100000, origin: "HISTORICAL_LINK", command_id: null }]);
  });
  it.each(["external_payment_allocations", "retained_funds", "retained_fund_entries"])("protects %s history through privileges and owner-side triggers", async table => {
    await collect(); await transaction(() => retain()); await transaction(() => use());
    for (const statement of [`UPDATE ${table} SET amount_minor=amount_minor`, `DELETE FROM ${table}`]) {
      await expect(transaction(() => writer.query(statement))).rejects.toMatchObject({ code: "42501" });
      await rejected(() => owner.query(statement), /append-only/, owner);
    }
  });
  it("migrates already reversed historical refunds without rewriting facts or releasing their occupancy", async () => {
    const fixtureTables = ["properties", "subjects", "inventory_units", "pricing_policy_versions", "command_executions", "orders", "order_occupants", "stays", "amendments", "pricing_revisions", "stay_segments"] as const;
    const fixtures = new Map<string, unknown[]>();
    for (const table of fixtureTables) {
      const rows = (await owner.query(`SELECT * FROM ${table}`)).rows;
      fixtures.set(table, table === "orders" ? rows.map(row => ({ ...row, current_revision_id: null })) : rows);
    }
    await owner.query("BEGIN");
    try {
      await owner.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      const directory = resolve(process.cwd(), "packages/db/src/migrations");
      for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 69).sort()) {
        await owner.query(await readFile(resolve(directory, name), "utf8"));
        await owner.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
      }
      await owner.query("SET CONSTRAINTS ALL DEFERRED");
      for (const table of fixtureTables) {
        await owner.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(fixtures.get(table))]);
      }
      await owner.query(`UPDATE orders o SET current_revision_id=(SELECT id FROM pricing_revisions WHERE order_id=o.id ORDER BY revision_no DESC LIMIT 1)`);
      await owner.query(`INSERT INTO external_payment_sources(id,corp_id,enabled,import_since,baseline_complete) VALUES('schema-source','schema-corp',true,'2026-09-01',true)`);
      await owner.query(`INSERT INTO external_payment_accounts VALUES('schema-source','schema-merchant',$1)`, [demo.propertyId]);
      await owner.query(`INSERT INTO external_payment_bills(id,source_id,merchant_id,property_id,kind,reference,original_trade_no,transaction_id,amount_minor,occurred_at,state)
        VALUES('schema-bill','schema-source','schema-merchant',$1,'COLLECTION','schema-reference','schema-trade','schema-reference',100000,now(),'SUCCESS'),
          ('schema-refund-bill','schema-source','schema-merchant',$1,'REFUND','schema-refund-reference','schema-trade','schema-reference',30000,now(),'SUCCESS')`, [demo.propertyId]);
      await owner.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,transaction_reference)
        SELECT 'source-fact',id,'COLLECTION',100000,100000,'CNY','WECOM','synthetic historical collection',$1,current_revision_id,'schema-reference' FROM orders WHERE id=$2`, [commandId, source]);
      await owner.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,transaction_reference,references_fact_id,refund_reference)
        SELECT 'external-refund',id,'REFUND',30000,-30000,'CNY','WECOM','synthetic historical refund',$1,current_revision_id,NULL,'source-fact','schema-refund-reference' FROM orders WHERE id=$2`, [commandId, source]);
      await owner.query(`INSERT INTO external_payment_matches(bill_id,collection_fact_id,origin)
        VALUES('schema-bill','source-fact','HISTORICAL_LINK'),('schema-refund-bill','external-refund','HISTORICAL_LINK')`);
      await owner.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,reverses_fact_id)
        SELECT 'historical-refund-reversal',order_id,'REVERSAL',amount_minor,-net_effect_minor,currency,method,'synthetic pre-migration reversal',$1,pricing_revision_id,fact_id
        FROM collection_facts WHERE fact_id='external-refund'`, [commandId]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      const before = (await owner.query("SELECT * FROM collection_facts ORDER BY fact_id")).rows;
      await owner.query(await readFile(resolve(directory, "069_payment_allocations_retained_funds.sql"), "utf8"));
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await owner.query("SELECT * FROM collection_facts ORDER BY fact_id")).rows).toEqual(before.map(row => ({ ...row, external_payment_bill_id: null })));
      expect((await owner.query("SELECT * FROM external_payment_allocation_releases")).rows).toEqual([]);
      expect((await owner.query(`SELECT bill_id,amount_minor,origin FROM external_payment_allocations a
        WHERE NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id) ORDER BY bill_id`)).rows).toEqual([
        { bill_id: "schema-bill", amount_minor: 100000, origin: "HISTORICAL_LINK" },
        { bill_id: "schema-refund-bill", amount_minor: 30000, origin: "HISTORICAL_LINK" }
      ]);
      // Fire the graph after migration: it must not retrospectively reject the old reversal.
      await owner.query(`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id)
        SELECT 'unrelated-cash',id,'COLLECTION',1,1,'CNY','CASH','synthetic unrelated write',$1,current_revision_id FROM orders WHERE id=$2`, [commandId, target]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await owner.query("SELECT * FROM external_payment_allocation_releases")).rows).toEqual([]);
    } finally { await owner.query("ROLLBACK"); }
  });
  it("upgrades old subject grants without widening any existing token ceiling", async () => {
    // Replay the pre-069 schema inside a rollback-only transaction in this suite's
    // dedicated database. No trigger disabling, fake migration, or second DB name.
    await owner.query("BEGIN");
    try {
      await owner.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      const directory = resolve(process.cwd(), "packages/db/src/migrations");
      for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 69).sort()) {
        await owner.query(await readFile(resolve(directory, name), "utf8"));
        await owner.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
      }
      await owner.query(`
        INSERT INTO properties(id,code,name,timezone,currency) VALUES('upgrade-property','UPGRADE','Upgrade','Asia/Shanghai','CNY');
        INSERT INTO subjects(id,username,display_name,password_salt,password_hash,status) VALUES('upgrade-subject','upgrade-user','Upgrade','salt','hash','ACTIVE');
        INSERT INTO subject_property_grants(subject_id,property_id,access_level) VALUES('upgrade-subject','upgrade-property','WRITE');
        INSERT INTO subject_command_grants(subject_id,property_id,command_type)
          SELECT 'upgrade-subject','upgrade-property',unnest(ARRAY['RECORD_COLLECTION','RECORD_REFUND','REVERSE_FACT']);
        INSERT INTO api_tokens(id,subject_id,label,secret_hash,access_ceiling,property_scope,expires_at)
          VALUES('upgrade-token','upgrade-subject','Old token',repeat('a',64),'WRITE','upgrade-property','2030-01-01');
        INSERT INTO token_command_ceilings(token_id,subject_id,property_id,command_type)
          SELECT 'upgrade-token',subject_id,property_id,command_type FROM subject_command_grants WHERE subject_id='upgrade-subject';
        SET CONSTRAINTS ALL IMMEDIATE;
      `);
      const before = (await owner.query("SELECT * FROM token_command_ceilings ORDER BY token_id,command_type")).rows;
      expect(before).toHaveLength(3);
      await owner.query(await readFile(resolve(directory, "069_payment_allocations_retained_funds.sql"), "utf8"));
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await owner.query("SELECT * FROM token_command_ceilings ORDER BY token_id,command_type")).rows).toEqual(before);
      const commands = ["RETAIN_ORDER_FUNDS", "APPLY_RETAINED_FUNDS", "RELEASE_RETAINED_FUNDS", "REFUND_RETAINED_FUNDS"];
      const grants = await owner.query("SELECT command_type FROM subject_command_grants WHERE subject_id='upgrade-subject' AND command_type=ANY($1::text[])", [commands]);
      expect(new Set(grants.rows.map(row => row.command_type))).toEqual(new Set(commands));
      const defaults = await owner.query("SELECT command_type,token_default FROM staff_command_profile_catalog WHERE command_type=ANY($1::text[])", [commands]);
      expect(new Set(defaults.rows.map(row => row.command_type))).toEqual(new Set(commands));
      // Defaults for newly issued tokens follow the staff profile; existing ceilings above stay unchanged.
      const mismatches = await owner.query(`SELECT added.profile,added.command_type FROM staff_command_profile_catalog added
        JOIN (VALUES ('RETAIN_ORDER_FUNDS','RECORD_COLLECTION'),('APPLY_RETAINED_FUNDS','RECORD_COLLECTION'),
          ('RELEASE_RETAINED_FUNDS','REVERSE_FACT'),('REFUND_RETAINED_FUNDS','RECORD_REFUND')) mapping(new_command,old_command)
          ON added.command_type=mapping.new_command
        JOIN staff_command_profile_catalog original ON original.profile=added.profile AND original.command_type=mapping.old_command
        WHERE added.token_default IS DISTINCT FROM original.token_default`);
      expect(mismatches.rows).toEqual([]);
    } finally { await owner.query("ROLLBACK"); }
  });
});
