import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, databaseReady, type Database } from "@qintopia/db";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { syncWecomSource } from "../../packages/db/src/wecom-sync.ts";
import { readExternalPaymentEvents } from "../../packages/db/src/external-payments.ts";
import { claimPaymentDelivery, deliverOnePayment, publishPaymentEvents } from "../../packages/db/src/payment-event-worker.ts";
import { eventSignature, finishDelivery, type IntegrationDeliveryConfig } from "../../packages/db/src/integration-worker.ts";
import { paymentDeliveryReady } from "../../packages/db/src/payment-delivery-readiness.ts";
import { integrationReady } from "../../packages/db/src/integration-readiness.ts";
import { externalPaymentsReady } from "../../packages/db/src/external-payments-readiness.ts";
let db: Kysely<Database>, worker: Kysely<Database>, runtime: Kysely<Database>;
const config: IntegrationDeliveryConfig = {endpoint: "https://receiver.invalid/api/v1/ingress/pms/events", sourceInstance: "simulation-pms",
  propertyIds: [demo.propertyId], keyId: "simulation", signingKey: "simulation-only-payment-key-32-bytes", timeoutMs: 1000, leaseMs: 10000};
const now = new Date("2026-09-10T02:00:00Z");
beforeEach(async () => {
  if (!new URL(testDatabaseUrl).pathname.startsWith("/qintopia_wecom_")) throw Error("Dedicated qintopia_wecom_ database required");
  db = await resetTestDatabase();
  runtime = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
  await sql`ALTER ROLE qintopia_payment_delivery_worker LOGIN`.execute(db);
  const url = new URL(testDatabaseUrl); url.username = "qintopia_payment_delivery_worker"; url.password = "";
  worker = createDatabase(url.toString());
  await sql`INSERT INTO payment_delivery_source(source_instance) VALUES(${config.sourceInstance})`.execute(db);
  await sql`INSERT INTO external_payment_sources(id,corp_id,enabled,matching_since,import_since,synced_until,baseline_complete)
    VALUES('source','corp',true,'2026-09-01Z','2026-09-01Z',${new Date(now.getTime()-120000)},true)`.execute(db);
  await sql`INSERT INTO external_payment_accounts VALUES('source','merchant',${demo.propertyId})`.execute(db);
});
afterEach(async () => { await worker?.destroy(); await runtime?.destroy(); await db?.destroy(); });
async function discover(reference = "payment") {
  await syncWecomSource(db, "source", {bills: async () => ({bills: [{kind: "COLLECTION", merchantId: "merchant", reference,
    originalTradeNo: reference, transactionId: reference, externalUserId: null, collectorId: null, amountMinor: 12000,
    occurredAt: new Date(now.getTime()-60000), state: "SUCCESS"}], nextCursor: null}), nickname: async () => null}, now);
}
async function resume() { await sql`SELECT qintopia_payment_delivery_control('RESUME','SIMULATION')`.execute(db); }
async function publish() { return publishPaymentEvents(worker, demo.propertyId, config.sourceInstance); }
async function due() { await sql`UPDATE payment_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='pending'`.execute(db); }
async function state() { return (await sql<{state: string; receipt_id: string | null; last_error_code: string | null}>`SELECT state,receipt_id,last_error_code FROM payment_deliveries ORDER BY event_id`.execute(db)).rows; }

describe("durable independent payment event delivery", () => {
  it("preserves old readiness and denies financial writes, forged bodies and source replacement", async () => {
    expect(await paymentDeliveryReady(worker)).toBe(true);
    expect(await integrationReady(db)).toBe(true);
    expect(await externalPaymentsReady(db)).toBe(true);
    expect(await databaseReady(runtime, {staffProfileManifestName: "demo"})).toBe(true);
    for (const query of [sql`SELECT * FROM collection_facts`, sql`INSERT INTO payment_delivery_events VALUES('x','x',1,'{}')`,
      sql`UPDATE payment_delivery_source SET source_instance='other'`, sql`SELECT qintopia_payment_delivery_control('RESUME','FORBIDDEN')`]) {
      await expect(query.execute(worker)).rejects.toMatchObject({code: "42501"});
    }
    await expect(sql`UPDATE payment_delivery_source SET source_instance='other'`.execute(db)).rejects.toMatchObject({code: "23514"});
    await expect(publishPaymentEvents(worker, demo.propertyId, "wrong-source")).rejects.toThrow();
    await sql`GRANT DELETE ON payment_deliveries TO qintopia_payment_delivery_worker`.execute(db);
    expect(await paymentDeliveryReady(worker)).toBe(false);
    await sql`REVOKE DELETE ON payment_deliveries FROM qintopia_payment_delivery_worker`.execute(db);
  });
  it("recovers committed discoveries after process loss and materializes immutable feed-equivalent bytes only once", async () => {
    await discover(); // A stopped worker leaves the event durable, without a queue yet.
    expect(await state()).toEqual([]);
    expect((await Promise.all([publish(), publish()])).sort()).toEqual([0, 1]);
    expect(await publish()).toBe(0);
    expect(await claimPaymentDelivery(worker, config)).toBeUndefined(); // default pause
    await resume();
    const claim = (await claimPaymentDelivery(worker, config))!;
    const {sourceInstance, schemaVersion, propertyId, ...event} = JSON.parse(claim.body);
    expect({sourceInstance, schemaVersion, propertyId}).toEqual({sourceInstance: config.sourceInstance, schemaVersion: "pms.payments.v1", propertyId: demo.propertyId});
    expect(event).toEqual((await readExternalPaymentEvents(runtime, demo.propertyId, "0")).events[0]);
    await expect(sql`UPDATE payment_delivery_events SET body='{}'`.execute(db)).rejects.toMatchObject({code: "23514"});
    expect(await claimPaymentDelivery(worker, {...config, propertyIds: ["foreign"]})).toBeUndefined();
    await expect(claimPaymentDelivery(worker, {...config, sourceInstance: "foreign"})).rejects.toThrow("SOURCE_MISMATCH");
  });
  it("never publishes an uncommitted or rolled back event and catches a late commit", async () => {
    await discover(); await publish();
    const event = (await readExternalPaymentEvents(runtime, demo.propertyId, "0")).events[0]!;
    await expect(db.transaction().execute(async trx => {
      await sql`SELECT qintopia_external_payment_event(${event.billId},'MATCHED')`.execute(trx);
      expect(await publish()).toBe(0);
      throw Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await publish()).toBe(0);
    await db.transaction().execute(async trx => {
      await sql`SELECT qintopia_external_payment_event(${event.billId},'MATCHED')`.execute(trx);
      expect(await publish()).toBe(0);
    });
    expect(await publish()).toBe(1);
    expect(await state()).toHaveLength(2);
  });
  it("fences expired leases, recovers a claim crash and permits out-of-order completion", async () => {
    await discover("one"); await discover("two"); await publish(); await resume();
    const first = (await claimPaymentDelivery(worker, config))!;
    const second = (await claimPaymentDelivery(worker, config))!;
    expect(second.event_id).not.toBe(first.event_id);
    expect(await finishDelivery(worker, second, {kind: "accepted", receipt: "second"}, Math.random, "payment")).toBe(true);
    await sql`UPDATE payment_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=${first.event_id}`.execute(db);
    const recovered = (await claimPaymentDelivery(worker, config))!;
    expect(recovered.body).toBe(first.body); expect(recovered.delivery_id).not.toBe(first.delivery_id);
    expect(BigInt(recovered.generation)).toBe(BigInt(first.generation)+1n);
    expect(await finishDelivery(worker, first, {kind: "accepted", receipt: "stale"}, Math.random, "payment")).toBe(false);
    expect(await finishDelivery(worker, recovered, {kind: "accepted", receipt: "first"}, Math.random, "payment")).toBe(true);
    expect((await state()).every(s => s.state === "accepted")).toBe(true);
  });
  it("retries lost receipts with the same body and verifies a persistent duplicate receipt", async () => {
    await discover(); await publish(); await resume();
    const received = new Map<string, string>(); const deliveries: string[] = []; const bodies: string[] = [];
    const receiver = vi.fn(async (_endpoint: string, body: string, headers: Record<string,string>) => {
      expect(headers["X-QT-Signature"]).toBe(eventSignature(body, headers["X-QT-Sent-At"]!, headers["X-QT-Delivery-Id"]!, config.signingKey));
      deliveries.push(headers["X-QT-Delivery-Id"]!); bodies.push(body);
      const event = JSON.parse(body); const duplicate = received.has(event.eventId);
      received.set(event.eventId, "durable-receipt");
      if (!duplicate) throw Error("response lost after persistence");
      return {status: 200, retryAfter: null, body: JSON.stringify({event_id: event.eventId, status: "duplicate", receipt_id: received.get(event.eventId)})};
    });
    expect(await deliverOnePayment(worker, config, receiver)).toBe(true);
    expect((await state())[0]?.state).toBe("pending"); await due();
    await deliverOnePayment(worker, config, receiver);
    expect(received.size).toBe(1); expect(bodies[1]).toBe(bodies[0]); expect(deliveries[1]).not.toBe(deliveries[0]);
    expect((await state())[0]).toMatchObject({state: "accepted", receipt_id: "durable-receipt"});
    expect(await deliverOnePayment(worker, config, receiver)).toBe(false);
  });
  it("pauses authentication failures, rejects mismatched ACK and retains replayable dead letters", async () => {
    await discover(); await publish(); await resume();
    await deliverOnePayment(worker, config, async () => ({status: 401, body: "", retryAfter: null}));
    await due(); expect(await claimPaymentDelivery(worker, config)).toBeUndefined();
    await resume();
    await deliverOnePayment(worker, config, async () => ({status: 202, body: '{"event_id":"wrong","status":"accepted","receipt_id":"r"}', retryAfter: null}));
    expect((await state())[0]).toMatchObject({state: "pending", last_error_code: "ACK_MISMATCH"});
    await due();
    await deliverOnePayment(worker, config, async () => ({status: 409, body: "", retryAfter: null}));
    expect((await state())[0]?.state).toBe("dead_letter");
    const event = (await readExternalPaymentEvents(runtime, demo.propertyId, "0")).events[0]!;
    await sql`SELECT qintopia_payment_delivery_control('REPLAY','RESOLVED',${event.eventId})`.execute(db);
    const retry = (await claimPaymentDelivery(worker, config))!;
    expect(retry.event_id).toBe(event.eventId); expect(retry.attempts).toBe(1);
  });
  it("starts the restricted payment process, stays paused and shuts down cleanly", async () => {
    await discover();
    const url = new URL(testDatabaseUrl); url.username = "qintopia_payment_delivery_worker"; url.password = "";
    const child = spawn(process.execPath, ["--import", "tsx", "packages/db/src/payment-event-worker-main.ts"], {
      env: {...process.env, PMS_PAYMENT_DELIVERY_ENABLED: "true", PMS_PAYMENT_DELIVERY_DATABASE_URL: url.toString(),
        PMS_PAYMENT_SOURCE_INSTANCE: config.sourceInstance, PMS_PAYMENT_PROPERTY_IDS: demo.propertyId,
        PMS_PAYMENT_DELIVERY_ENDPOINT: config.endpoint, PMS_PAYMENT_KEY_ID: config.keyId, PMS_PAYMENT_SIGNING_KEY: config.signingKey},
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise<void>((resolve, reject) => {
        child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("PAYMENT_DELIVERY_STATUS")) resolve(); });
        child.stderr.on("data", chunk => { output += String(chunk); });
        timer = setTimeout(() => reject(Error(`worker startup: ${output}`)), 30000);
      }), done.then(() => { throw Error(`worker exited: ${output}`); })]);
      expect(output).toContain('"paused":true');
      expect((await state())[0]?.state).toBe("pending");
    } finally {
      clearTimeout(timer); child.kill("SIGTERM");
      expect(await done).toBe(0);
    }
  });
  it("bounds retry lifetime without dropping the durable event", async () => {
    await discover(); await publish(); await resume();
    await sql`UPDATE payment_deliveries SET first_attempt_at=clock_timestamp()-interval '25 hours'`.execute(db);
    await deliverOnePayment(worker, config, async () => ({status: 503, body: "", retryAfter: "1"}));
    expect((await state())[0]).toMatchObject({state: "dead_letter", last_error_code: "RETRY_EXHAUSTED"});
    expect((await readExternalPaymentEvents(runtime, demo.propertyId, "0")).events).toHaveLength(1);
  });
});
