import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { sql, type Kysely } from "kysely";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createCommandPreview, confirmCommandPreview, createDatabase, type Database } from "@qintopia/db";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { listPaymentAllocations } from "../../packages/db/src/payment-allocation.ts";
import { listRetainedFunds } from "../../packages/db/src/retained-funds.ts";
import { syncWecomSource, type PaymentClient } from "../../packages/db/src/wecom-sync.ts";
import type { WecomBill } from "../../packages/db/src/wecom-client.ts";
import { resetDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";

// Derive the server from TEST_DATABASE_URL; the runner must supply PG 55439 locally.
// Never reset the main suite's database or use its shared fixture state.
const derivedUrl = new URL(testDatabaseUrl);
derivedUrl.pathname = "/qintopia_allocation_sync_race_test";
const databaseUrl = process.env.PAYMENT_ALLOCATION_SYNC_RACE_TEST_DATABASE_URL ?? derivedUrl.toString();
if (!new URL(databaseUrl).pathname.endsWith("/qintopia_allocation_sync_race_test")) {
  throw new Error("Sync race regression requires the dedicated qintopia_allocation_sync_race_test database");
}
const now = new Date("2026-10-02T02:00:00Z");
const sourceId = "synthetic-sync-race-source";
const barrierKey = "synthetic-allocation-sync-race-barrier";
const syncApp = "allocation-sync-race-sync";
const confirmApp = "allocation-sync-race-confirm";
const principal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId, credentialId: "sync-race-session",
  credentialType: "SESSION", displayName: "合成并发回归",
  ...authScope({ credentialType: "SESSION", profile: "administrator" })
};
let db: Kysely<Database>;
let runtime: Kysely<Database>;
let synchronizer: Kysely<Database>;
let observer: pg.Client;
let barrierHeld = false;
let controllerPid: number;
let sequence = 0;
let inFlight: Promise<unknown>[] = [];
function taggedUrl(url: string, name: string) {
  const tagged = new URL(url);
  tagged.searchParams.set("application_name", name);
  return tagged.toString();
}
function track<T>(promise: Promise<T>): Promise<T> {
  // Attach rejection handling immediately, even if a barrier assertion fails first.
  inFlight.push(promise);
  void promise.catch(() => undefined);
  return promise;
}
const meta = () => ({ idempotencyKey: `sync-race-${++sequence}`, correlationId: `sync-race-${sequence}` });
const prepare = (command: CommandEnvelope) => createCommandPreview(runtime, principal, command, meta());
function confirm(command: CommandEnvelope, prepared: Awaited<ReturnType<typeof prepare>>) {
  return confirmCommandPreview(runtime, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId, commandType: command.commandType, confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: command.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "ALLOCATION_TEST", note: "仅合成数据的同步并发回归" }
  }, meta());
}
async function execute(command: CommandEnvelope) {
  const receipt = await confirm(command, await prepare(command));
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}
async function order(day: number, amountMinor: number) {
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT",
    arrivalDate: `2028-12-${String(day).padStart(2, "0")}`,
    departureDate: `2028-12-${String(day + 1).padStart(2, "0")}`,
    pricingPolicyVersionId: demo.transientPolicyId
  });
  return (await execute({ commandType: "CREATE_ORDER", input: {
    propertyId: demo.propertyId, quoteId: quote.quoteId,
    primaryGuest: { fullName: "合成并发客人", nickname: "合成测试", phone: "13800001234" },
    bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: amountMinor,
    manualPriceAdjustmentReason: "合成并发回归协议价"
  } })).result!.orderId as string;
}
function bill(reference: string, amountMinor = 100000, overrides: Partial<WecomBill> = {}): WecomBill {
  return { kind: "COLLECTION", merchantId: "m1", reference, originalTradeNo: `trade-${reference}`,
    transactionId: reference, externalUserId: "synthetic-customer", collectorId: "synthetic-staff",
    amountMinor, occurredAt: new Date(now.getTime() - 60000), state: "SUCCESS", ...overrides };
}
function sync(rows: WecomBill[]) {
  // No external network client, refund endpoint, or payment worker is invoked.
  const client: PaymentClient = {
    bills: async (begin, end) => ({ bills: rows.filter(row => row.occurredAt >= begin && row.occurredAt <= end), nextCursor: null }),
    nickname: async () => "合成付款客户"
  };
  return syncWecomSource(synchronizer, sourceId, client, now);
}
async function payment(reference: string, kind: "COLLECTION" | "REFUND" = "COLLECTION") {
  const result = await listPaymentAllocations(runtime, demo.propertyId, { kind, status: "ALL" });
  const item = result.items.find(item => item.reference === reference);
  expect(item).toBeDefined();
  return item!;
}
const collect = (orderId: string, billId: string, amountMinor: number): CommandEnvelope => ({
  commandType: "RECORD_COLLECTION", input: { propertyId: demo.propertyId, orderId,
    externalPaymentBillId: billId, amountMinor, method: "WECOM", transactionReference: "P", note: "合成分配" }
});
const facts = () => db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute();

beforeEach(async () => {
  vi.stubEnv("PMS_PAYMENT_ALLOCATION_ENABLED", "true");
  inFlight = [];
  db = await resetDatabase(databaseUrl);
  await db.insertInto("web_sessions").values({ id: principal.credentialId, subject_id: principal.subjectId,
    secret_hash: "a".repeat(64), expires_at: new Date(Date.now() + 3600000), revoked_at: null }).execute();
  runtime = createDatabase(taggedUrl(runtimeDatabaseUrlForTesting(databaseUrl), confirmApp), { statement_timeout: 15000 });
  synchronizer = createDatabase(taggedUrl(databaseUrl, syncApp), { max: 1, statement_timeout: 15000 });
  observer = new pg.Client({ connectionString: databaseUrl, statement_timeout: 15000 });
  await observer.connect();
  controllerPid = (await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete,last_reconciliation_at)
    VALUES(${sourceId},'synthetic-corp',true,${new Date("2026-09-01T00:00:00Z")},${new Date("2026-09-01T00:00:00Z")},
      ${new Date(now.getTime() - 120000)},true,${now})`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES(${sourceId},'m1',${demo.propertyId})`.execute(db);
});
afterEach(async () => {
  try {
    if (barrierHeld) await releaseBarrier();
    await Promise.allSettled(inFlight);
    // Test-only DDL is removed even on failed assertions; next test resets this DB.
    if (observer) await observer.query(`DROP TRIGGER IF EXISTS zz_sync_race_barrier ON external_payment_bills;
      DROP FUNCTION IF EXISTS sync_race_barrier();`);
  } finally {
    await observer?.end();
    await synchronizer?.destroy();
    await runtime?.destroy();
    await db?.destroy();
    vi.unstubAllEnvs();
  }
});

async function installBarrier(reference: string, kind: "REFUND" | "COLLECTION") {
  await observer.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [barrierKey]);
  barrierHeld = true;
  // PostgreSQL executes same-kind triggers alphabetically: zz runs AFTER the
  // real payment_allocation_discovery trigger has written and locked event head.
  // The predicate is evaluated INSIDE sync's transaction, not via dirty reads.
  const literal = (await observer.query<{ value: string }>("SELECT quote_literal($1) AS value", [reference])).rows[0]!.value;
  await observer.query(`CREATE FUNCTION sync_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.reference=${literal} AND NEW.kind='${kind}' AND NEW.state='SUCCESS' THEN
        IF NOT EXISTS(SELECT 1 FROM payment_allocation_events WHERE bill_id=NEW.id AND event_type='DISCOVERED')
          OR EXISTS(SELECT 1 FROM external_payment_allocations WHERE bill_id=NEW.id) THEN
          RAISE EXCEPTION 'barrier requires persisted discovery and unassigned bill';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('${barrierKey}',0));
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_sync_race_barrier AFTER INSERT ON external_payment_bills
      FOR EACH ROW EXECUTE FUNCTION sync_race_barrier();`);
}
async function releaseBarrier() {
  await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [barrierKey]);
  barrierHeld = false;
}
type Waiting = { pid: number; wait_event: string; query: string; blockers: number[] };
async function waitForLock(applicationName: string, blockerPid: number): Promise<Waiting> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await observer.query<Waiting>(`SELECT pid,wait_event,query,pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1
        AND state='active' AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))`, [applicationName, blockerPid]);
    if (result.rows[0]) return result.rows[0];
    // Poll cadence only: progression depends on observed DB lock state, never elapsed sleep.
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const snapshot = await observer.query(`SELECT pid,application_name,state,wait_event_type,wait_event,query,
    pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database()`);
  throw new Error(`No ${applicationName} lock wait behind PID ${blockerPid}: ${JSON.stringify(snapshot.rows)}`);
}
async function assertSyncGate(pid: number) {
  const locks = await observer.query<{ held: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks
    WHERE pid=$1 AND locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1
      AND classid::bigint=((hashtextextended($2,0)>>32)&4294967295)
      AND objid::bigint=(hashtextextended($2,0)&4294967295)) AS held`, [pid, `payment-allocation:${demo.propertyId}`]);
  expect(locks.rows[0]!.held, "sync must own the exact property money gate before the test barrier").toBe(true);
}
async function assertConfirmWaiting(syncPid: number) {
  const waiting = await waitForLock(confirmApp, syncPid);
  expect(waiting.wait_event).toBe("advisory");
  expect(waiting.query).toContain("pg_advisory_xact_lock");
  // pg_stat_activity exposes parameterized SQL, not $1's value. Match the
  // ungranted lock identity against sync's exact property gate instead.
  const gateWait = await observer.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks w
    JOIN pg_locks h ON h.locktype=w.locktype AND h.database=w.database
      AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
    WHERE w.pid=$1 AND NOT w.granted AND h.pid=$2 AND h.granted
      AND w.locktype='advisory' AND w.objsubid=1
      AND w.classid::bigint=((hashtextextended($3,0)>>32)&4294967295)
      AND w.objid::bigint=(hashtextextended($3,0)&4294967295)) AS waiting`,
    [waiting.pid, syncPid, `payment-allocation:${demo.propertyId}`]);
  expect(gateWait.rows[0]!.waiting, "Confirm must wait on sync's exact property gate").toBe(true);
  return waiting;
}

describe("wecom sync / allocation Confirm deterministic transaction races", () => {
  it("waits for an uncommitted successful unassigned refund, then rejects retained use with zero transfers", async () => {
    const sourceOrderId = await order(1, 100000);
    const destinationOrderId = await order(3, 40000);
    await sync([bill("P")]);
    const parent = await payment("P");
    const collection = await execute(collect(sourceOrderId, parent.id, 100000));
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: sourceOrderId } });
    await execute({ commandType: "RETAIN_ORDER_FUNDS", input: { propertyId: demo.propertyId, orderId: sourceOrderId,
      sourceFactId: collection.factRefs[0]!, amountMinor: 100000, ownerName: "合成款项归属人",
      ownerContact: "13800001234", confirmationNote: "合成客户要求留存下次住宿使用" } });
    const retainedBefore = await listRetainedFunds(runtime, demo.propertyId, { status: "ALL" });
    expect(retainedBefore.items).toHaveLength(1);
    const retainedId = retainedBefore.items[0]!.id;
    const command: CommandEnvelope = { commandType: "APPLY_RETAINED_FUNDS", input: {
      propertyId: demo.propertyId, orderId: destinationOrderId, retainedFundId: retainedId, amountMinor: 40000,
      authorizationNote: "合成原付款人已授权代订使用留存款" } };
    const preview = await prepare(command);
    const before = await facts();
    const entriesBefore = await db.selectFrom("retained_fund_entries").selectAll().orderBy("id").execute();
    await installBarrier("synthetic-refund", "REFUND");
    const syncing = track(sync([bill("synthetic-refund", 40000, {
      kind: "REFUND", transactionId: "P", originalTradeNo: "trade-P"
    })]));
    const paused = await waitForLock(syncApp, controllerPid);
    expect(paused.wait_event).toBe("advisory");
    await assertSyncGate(paused.pid);
    // Other sessions cannot see the successful refund until sync commits.
    expect((await observer.query("SELECT id FROM external_payment_bills WHERE reference='synthetic-refund'")).rows).toEqual([]);
    const confirming = track(confirm(command, preview));
    await assertConfirmWaiting(paused.pid);
    expect(await facts()).toEqual(before);
    await releaseBarrier();
    expect(await syncing).toMatchObject({ skipped: false, windows: 1 });
    const receipt = await confirming;
    expect(receipt.businessCommitted).toBe(false);
    expect(receipt.error).toMatchObject({ code: "PREVIEW_STALE", details: { causeCode: "AGGREGATE_VERSION_CONFLICT" } });
    // A new Preview also fails specifically for the now-visible unassigned refund.
    await expect(prepare(command)).rejects.toThrow("尚未完成归属的退款");
    expect(await facts()).toEqual(before);
    expect((await facts()).filter(row => ["REALLOCATION_OUT", "REALLOCATION_IN"].includes(row.fact_type))).toEqual([]);
    expect(await db.selectFrom("retained_fund_entries").selectAll().orderBy("id").execute()).toEqual(entriesBefore);
    expect(await listRetainedFunds(runtime, demo.propertyId, { status: "ALL" })).toEqual(retainedBefore);
    const refund = await payment("synthetic-refund", "REFUND");
    expect(refund).toMatchObject({ remainingMinor: 40000 });
    const persistedRefund = await sql<{ state: string; transaction_id: string; original_trade_no: string }>`
      SELECT state,transaction_id,original_trade_no FROM external_payment_bills WHERE id=${refund.id}`.execute(db);
    expect(persistedRefund.rows).toEqual([{ state: "SUCCESS", transaction_id: "P", original_trade_no: "trade-P" }]);
    expect(await db.selectFrom("external_payment_allocations").selectAll().where("bill_id", "=", refund.id).execute()).toEqual([]);
  });

  it("serializes sync [X new, P existing] against P Confirm without an event-head/bill deadlock", async () => {
    const orderId = await order(1, 60000);
    await sync([bill("P")]);
    const parent = await payment("P");
    const command = collect(orderId, parent.id, 60000);
    const preview = await prepare(command);
    const before = await facts();
    await installBarrier("X", "COLLECTION");
    // X's real discovery trigger owns event head before sync tries existing P.
    const syncing = track(sync([bill("X", 25000), bill("P")]));
    const paused = await waitForLock(syncApp, controllerPid);
    await assertSyncGate(paused.pid);
    const headLocks = await observer.query<{ held: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE pid=$1 AND granted AND relation='payment_allocation_heads'::regclass AND mode='RowExclusiveLock') AS held`, [paused.pid]);
    expect(headLocks.rows[0]!.held).toBe(true);
    expect((await observer.query("SELECT id FROM external_payment_bills WHERE reference='X'")).rows).toEqual([]);
    const confirming = track(confirm(command, preview));
    const waiting = await assertConfirmWaiting(paused.pid);
    // Confirm must not take P FOR UPDATE first and later wait on sync's head.
    const billLocks = await observer.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND granted
      AND relation='external_payment_bills'::regclass AND mode IN ('RowShareLock','RowExclusiveLock')`, [waiting.pid]);
    expect(billLocks.rows).toEqual([]);
    expect(await facts()).toEqual(before);
    await releaseBarrier();
    const [syncResult, receipt] = await Promise.all([syncing, confirming]);
    expect(syncResult).toMatchObject({ skipped: false, windows: 1 });
    expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
    expect(await payment("P")).toMatchObject({ allocatedMinor: 60000, remainingMinor: 40000 });
    expect(await payment("X")).toMatchObject({ remainingMinor: 25000 });
    const allocations = await db.selectFrom("external_payment_allocations").selectAll().where("bill_id", "=", parent.id).execute();
    expect(allocations).toHaveLength(1);
    expect((await facts()).filter(row => row.order_id === orderId && row.fact_type === "COLLECTION"))
      .toMatchObject([{ amount_minor: 60000, net_effect_minor: 60000 }]);
    const events = await observer.query<{ reference: string; event_type: string; sequence: string }>(`SELECT b.reference,e.event_type,e.sequence::text
      FROM payment_allocation_events e JOIN external_payment_bills b ON b.id=e.bill_id
      WHERE e.property_id=$1 ORDER BY e.sequence`, [demo.propertyId]);
    const discovered = events.rows.filter(row => row.reference === "X" && row.event_type === "DISCOVERED");
    const allocated = events.rows.filter(row => row.reference === "P" && row.event_type === "ALLOCATED");
    expect(discovered).toHaveLength(1);
    expect(allocated).toHaveLength(1);
    expect(BigInt(allocated[0]!.sequence)).toBeGreaterThan(BigInt(discovered[0]!.sequence));
  });
});
