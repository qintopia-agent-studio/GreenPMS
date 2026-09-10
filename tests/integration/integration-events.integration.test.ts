import pg from "pg";
import { spawn } from "node:child_process";
import { integrationReady } from "../../packages/db/src/integration-readiness.ts";
import { readPmsEventFeed, readPmsOrder, readPmsMember, readPmsInventory, scanPmsOrders } from "../../packages/db/src/integration-queries.ts";
import { claimDelivery, finishDelivery, deliverOne, type IntegrationDeliveryConfig } from "../../packages/db/src/integration-worker.ts";
import { buildServer } from "../../apps/api/src/server.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, createCommandPreview, confirmCommandPreview, databaseReady, withPropertyClockForTesting, type Database } from "@qintopia/db";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { authScope } from "../helpers/auth-principals.ts";
import type { AuthPrincipal, CommandType } from "@qintopia/contracts";
let owner: Kysely<Database>;
let runtime: Kysely<Database>;
let worker: Kysely<Database>;
let sequence = 0;
let bookingId: string;
const actor: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "token_demo_admin_write", credentialType: "TOKEN", displayName: "Synthetic operator", ...authScope({ profile: "administrator" }) };
const meta = () => ({ idempotencyKey: `integration-events-${++sequence}`, correlationId: `integration-events-${sequence}` });
async function command(type: CommandType, input: Record<string, unknown>, reason = { code: type as string, note: "合成事件验证" }) {
    const p = await createCommandPreview(runtime, actor, { commandType: type, input: { propertyId: demo.propertyId, ...input } }, meta());
    const confirmation = { propertyId: demo.propertyId, commandType: type, confirmation: true as const, expectedEffectHash: p.preview.effectHash, reason };
    const metadata = meta();
    const receipt = await confirmCommandPreview(runtime, actor, p.preview.previewId, confirmation, metadata);
    expect(receipt.businessCommitted, receipt.error?.code).toBe(true);
    return { receipt, replay: () => confirmCommandPreview(runtime, actor, p.preview.previewId, confirmation, metadata) };
}
async function createBooking() {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const end = new Date(`${day}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 3);
    const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, arrivalDate: day, departureDate: end.toISOString().slice(0, 10), pricingPolicyVersionId: demo.publicPricingPolicyId });
    return command("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "合成住客", nickname: "事务测试" }, bookingChannelCode: "WECOM", channelOrderReference: null }, { code: "CREATE_STANDARD_ORDER", note: "" });
}
async function events() { return (await sql<{
    event_type: string;
    aggregate_revision: string;
    aggregate_id: string;
    origin: string;
    source_fact_ref: string;
}> `SELECT event_type,aggregate_revision::text,aggregate_id,origin,source_fact_ref FROM integration_outbox ORDER BY created_at,event_id`.execute(owner)).rows; }
beforeAll(async () => {
    owner = await resetTestDatabase();
    runtime = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
    await sql `ALTER ROLE qintopia_integration_worker LOGIN`.execute(owner);
    const workerUrl = new URL(testDatabaseUrl);
    workerUrl.username = "qintopia_integration_worker";
    workerUrl.password = "";
    worker = createDatabase(workerUrl.toString());
});
afterAll(async () => { await worker?.destroy(); await sql `ALTER ROLE qintopia_integration_worker NOLOGIN`.execute(owner); await runtime?.destroy(); await owner?.destroy(); });
describe("transactional PMS integration events", () => {
    it("is inert before configuration and preserves database readiness", async () => {
        expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
        expect(await events()).toEqual([]);
    });
    it("initializes revisions as baseline and keeps publication and delivery separate", async () => {
        await sql `SELECT qintopia_integration_configure('synthetic-pms','baseline')`.execute(owner);
        expect((await events()).every(e => e.origin === 'baseline')).toBe(true);
        const result = await sql<{
            count: number;
        }> `SELECT qintopia_integration_publish(${demo.propertyId},100) AS count`.execute(owner);
        expect(result.rows[0]!.count).toBeGreaterThan(0);
        expect((await sql<{
            paused: boolean;
        }> `SELECT paused FROM integration_subscription_state`.execute(owner)).rows[0]!.paused).toBe(true);
        await sql `SELECT qintopia_integration_configure('synthetic-pms','live')`.execute(owner);
    });
    it("captures committed create/check-in and replays without another event", async () => {
        const { receipt, replay } = await createBooking();
        const id = receipt.result!.orderId as string;
        bookingId = id;
        expect((await events()).filter(e => e.aggregate_id === id)).toMatchObject([{ event_type: 'pms.order.created', aggregate_revision: '1', origin: 'live' }]);
        await replay();
        expect((await events()).filter(e => e.aggregate_id === id)).toHaveLength(1);
        await command('CHECK_IN', { orderId: id });
        expect((await events()).filter(e => e.aggregate_id === id)).toHaveLength(2);
        await expect(command('CHECK_OUT', { orderId: id })).rejects.toBeDefined(); // early checkout is rejected and must not emit
        expect((await events()).filter(e => e.aggregate_id === id)).toHaveLength(2);
    });
    it("rolls back captured context with the source transaction", async () => {
        const before = (await events()).length;
        await expect(owner.transaction().execute(async (trx) => {
            await sql `SET LOCAL qintopia.integration_maintenance_ref='migration:synthetic-rollback'`.execute(trx);
            await sql `UPDATE inventory_units SET active=false WHERE id=${demo.roomId}`.execute(trx);
            await sql `SET CONSTRAINTS integration_context_capture IMMEDIATE`.execute(trx);
            throw new Error('injected');
        })).rejects.toThrow('injected');
        expect((await events()).length).toBe(before);
    });
    it("does not grant business runtime event mutation or source control", async () => {
        await expect(sql `SELECT qintopia_integration_configure('bad','live')`.execute(runtime)).rejects.toMatchObject({ code: '42501' });
        await expect(sql `DELETE FROM integration_published_events`.execute(runtime)).rejects.toMatchObject({ code: '42501' });
    });
});
const deliveryConfig: IntegrationDeliveryConfig = { endpoint: "https://receiver.invalid/api/v1/ingress/pms/events", sourceInstance: "synthetic-pms", propertyIds: [demo.propertyId], keyId: "fixture", signingKey: "synthetic-test-only-key-material-32", timeoutMs: 1000, leaseMs: 10000 };
async function maintenance(id: string, ref: string, active: boolean) {
    return owner.transaction().execute(async (trx) => {
        await sql `SELECT set_config('qintopia.integration_maintenance_ref',${ref},true)`.execute(trx);
        await sql `UPDATE inventory_units SET active=${active} WHERE id=${id}`.execute(trx);
    });
}
async function publish() { await sql `SELECT qintopia_integration_publish(${demo.propertyId},100)`.execute(worker); }
describe.sequential("minimal projections, feed and recovery", () => {
    it("returns whitelist projections and consistent scan positions", async () => {
        const p = await readPmsOrder(runtime, demo.propertyId, bookingId);
        expect(p).toMatchObject({ order_revision: "2", stay_status: "IN_HOUSE", checked_in_at: null, read_context: { temporal_state: "IN_HOUSE_TODAY" } });
        expect(p.effective_arrangement.intervals[0]).toMatchObject({ room_id: demo.roomId, bed_id: null });
        expect(Object.keys(p.occupants[0]!).sort()).toEqual(["occupant_id", "registration_state", "role"]);
        const again = await readPmsOrder(runtime, demo.propertyId, bookingId);
        expect(again.projection_hash).toBe(p.projection_hash);
        const scan = await scanPmsOrders(runtime, demo.propertyId, undefined, 1);
        expect(scan.orders[0]!.order_id).toBe(bookingId);
        expect(await scanPmsOrders(runtime, demo.propertyId, bookingId, 1)).toMatchObject({ orders: [], next_after_id: bookingId, has_more: false });
        const member = await readPmsMember(runtime, demo.propertyId, demo.memberId);
        expect(member.resource_state).toBe("active");
        expect(JSON.stringify(member)).not.toMatch(/full_name|phone|document_number|nickname/);
    });
    it("preserves removed occupant references and maps REMOVE as correction", async () => {
        const added = await command("MANAGE_ORDER_OCCUPANTS", { orderId: bookingId, action: "ADD", guest: { fullName: "合成同住", nickname: "测试", phone: null, documentNumber: null } });
        const occupantId = added.receipt.result!.occupantId as string;
        await command("MANAGE_ORDER_OCCUPANTS", { orderId: bookingId, action: "REMOVE", occupantId });
        const projection = await readPmsOrder(runtime, demo.propertyId, bookingId);
        expect(projection.occupants).toContainEqual({ occupant_id: occupantId, role: "ADDITIONAL", registration_state: "removed" });
        expect((await events()).filter(e => e.aggregate_id === bookingId && e.event_type === 'pms.order.occupants_changed').map(e => e.origin).sort()).toEqual(["historical_correction", "live"]);
    });
    it("versions invalidation and recovery, requiring unique maintenance facts", async () => {
        const before = await readPmsInventory(runtime, demo.propertyId, demo.secondRoomId);
        await maintenance(demo.secondRoomId, "migration:fixture-disable", false);
        const tomb = await readPmsInventory(runtime, demo.propertyId, demo.secondRoomId);
        expect(tomb).toMatchObject({ resource_state: "tombstone", invalidation_kind: "INACTIVE", source_fact_ref: "migration:fixture-disable" });
        expect(BigInt(tomb.inventory_revision)).toBe(BigInt(before.inventory_revision) + 1n);
        await expect(maintenance(demo.secondRoomId, "migration:fixture-disable", true)).rejects.toMatchObject({ message: "INTEGRATION_MAINTENANCE_REFERENCE_REUSED" });
        await maintenance(demo.secondRoomId, "migration:fixture-enable", true);
        expect((await readPmsInventory(runtime, demo.propertyId, demo.secondRoomId)).resource_state).toBe("active");
        await expect(readPmsInventory(runtime, "missing-property", demo.secondRoomId)).rejects.toMatchObject({ statusCode: 404 });
    });
    it("publishes late commits after an already consumed head and serializes two publishers", async () => {
        await publish();
        const connection = new pg.Client({ connectionString: testDatabaseUrl });
        await connection.connect();
        try {
            await connection.query("BEGIN");
            await connection.query("SET LOCAL qintopia.integration_maintenance_ref='migration:late-commit'");
            await connection.query("UPDATE inventory_units SET active=false WHERE id=$1", [demo.secondRoomId]);
            await connection.query("SET CONSTRAINTS integration_context_capture IMMEDIATE");
            await maintenance(demo.bedAId, "migration:early-commit", false);
            await publish();
            const earlier = JSON.parse(await readPmsEventFeed(runtime, demo.propertyId));
            await connection.query("COMMIT");
            await Promise.all([publish(), publish()]);
            const later = JSON.parse(await readPmsEventFeed(runtime, demo.propertyId, earlier.head_cursor));
            expect(later.events).toHaveLength(1);
            expect(later.events[0].source_fact_ref).toBe("migration:late-commit");
            const checks = (await sql<{
                contiguous: boolean;
            }> `SELECT count(*)=max(publish_seq) AND count(*)=count(DISTINCT publish_seq) AS contiguous FROM integration_published_events WHERE property_id=${demo.propertyId}`.execute(owner)).rows[0];
            expect(checks?.contiguous).toBe(true);
        }
        finally {
            await connection.query("ROLLBACK");
            await connection.end();
        }
    });
    it("keeps exact raw event JSON in feed and rejects bad cursors", async () => {
        const raw = await readPmsEventFeed(runtime, demo.propertyId, undefined, 1), page = JSON.parse(raw);
        const stored = (await sql<{
            body: string;
        }> `SELECT body FROM integration_published_events WHERE event_id=${page.events[0].event_id}`.execute(owner)).rows[0]!.body;
        expect(raw).toContain(`"events":[${stored}]`);
        expect(page.has_more).toBe(true);
        expect(JSON.parse(await readPmsEventFeed(runtime, demo.propertyId, page.next_cursor, 1)).events[0].event_id).not.toBe(page.events[0].event_id);
        await expect(readPmsEventFeed(runtime, demo.propertyId, "invalid")).rejects.toMatchObject({ statusCode: 400 });
        expect(JSON.parse(await readPmsEventFeed(runtime, demo.propertyId, page.head_cursor)).events).toEqual([]);
    });
    it("enforces READ property scope before returning any object through HTTP", async () => {
        const oldLog = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = "silent";
        const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
        try {
            const headers = { authorization: `Bearer ${demo.readToken}` };
            const base = `/api/v1/integrations/agent-os/orders/${bookingId}`;
            expect((await app.inject({ url: `${base}?propertyId=ungranted`, headers })).statusCode).toBe(403);
            const response = await app.inject({ url: `${base}?propertyId=${demo.propertyId}`, headers });
            expect(response.statusCode).toBe(200);
            expect(response.json().order_id).toBe(bookingId);
            expect(response.body).not.toMatch(/full_name|phone|document_number|reason_note/);
            const feed = await app.inject({ url: `/api/v1/integration-events?propertyId=${demo.propertyId}&limit=1`, headers });
            expect(feed.statusCode).toBe(200);
            expect(feed.body).toBe(await readPmsEventFeed(runtime, demo.propertyId, undefined, 1));
            expect((await app.inject({ url: `${base}?propertyId=${demo.propertyId}` })).statusCode).toBe(401);
        }
        finally {
            await app.close();
            if (oldLog === undefined)
                delete process.env.LOG_LEVEL;
            else
                process.env.LOG_LEVEL = oldLog;
        }
    });
    it("keeps capture epochs ordered while an old writer is still open", async () => {
        await sql `SELECT qintopia_integration_configure('synthetic-pms','baseline')`.execute(owner);
        const connection = new pg.Client({ connectionString: testDatabaseUrl });
        await connection.connect();
        try {
            await connection.query("BEGIN");
            await connection.query("UPDATE inventory_units SET active=false WHERE id=$1", [demo.bedBId]);
            // Nonblocking exclusive control cannot queue ahead of later shared
            // requests and create a cycle with existing business row locks.
            await expect(sql`SELECT qintopia_integration_configure('synthetic-pms','live')`.execute(owner)).rejects.toMatchObject({code:'55P03',message:'INTEGRATION_CAPTURE_BUSY'});
            expect((await sql<{capture_mode:string}>`SELECT capture_mode FROM integration_source`.execute(owner)).rows[0]!.capture_mode).toBe('baseline');
            await connection.query("COMMIT");
            await sql`SELECT qintopia_integration_configure('synthetic-pms','live')`.execute(owner);
            const captured = (await events()).filter(e => e.aggregate_id === demo.bedBId);
            expect(captured.at(-1)!.origin).toBe("baseline");
        }
        finally {
            await connection.query("ROLLBACK");
            await connection.end();
        }
    });
    it("fences stale workers, retries unknown delivery, and pauses on authorization failure", async () => {
        await publish();
        await sql `SELECT qintopia_integration_control('RESUME','fixture-v1','TEST_ACTIVATE')`.execute(owner);
        const first = await claimDelivery(worker, deliveryConfig);
        expect(first).toBeDefined();
        await sql `UPDATE integration_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=${first!.event_id}`.execute(owner);
        const reclaimed = await claimDelivery(worker, deliveryConfig);
        expect(reclaimed!.event_id).toBe(first!.event_id);
        expect(await finishDelivery(worker, first!, { kind: "accepted", receipt: "stale" })).toBe(false);
        expect(await finishDelivery(worker, reclaimed!, { kind: "retry", code: "ACK_MISMATCH" }, () => 0)).toBe(true);
        await deliverOne(worker, deliveryConfig, async () => ({ status: 403, body: "", retryAfter: null }));
        expect((await sql<{
            paused: boolean;
        }> `SELECT paused FROM integration_subscription_state`.execute(owner)).rows[0]!.paused).toBe(true);
        expect(await claimDelivery(worker, deliveryConfig)).toBeUndefined();
    });
    it("rolls back a publication batch without leaving a head gap", async () => {
        await maintenance(demo.bedCId, "migration:publish-rollback", false);
        const before = (await sql<{
            head: string;
        }> `SELECT head::text FROM integration_publish_state WHERE property_id=${demo.propertyId}`.execute(owner)).rows[0]!.head;
        await expect(owner.transaction().execute(async (trx) => { await sql `SELECT qintopia_integration_publish(${demo.propertyId},100)`.execute(trx); throw Error("publish-fault"); })).rejects.toThrow("publish-fault");
        expect((await sql<{
            head: string;
        }> `SELECT head::text FROM integration_publish_state WHERE property_id=${demo.propertyId}`.execute(owner)).rows[0]!.head).toBe(before);
        await publish();
    });
    it("advances retention floor only through accepted old events and never republishes cleaned facts", async () => {
        const original = JSON.parse(await readPmsEventFeed(runtime, demo.propertyId, undefined, 1));
        // Test-only clock aging: owner temporarily disables immutability inside the isolated fixture transaction.
        await owner.transaction().execute(async (trx) => {
            await sql `ALTER TABLE integration_published_events DISABLE TRIGGER integration_published_immutable`.execute(trx);
            await sql `UPDATE integration_published_events SET published_at=clock_timestamp()-interval '31 days'`.execute(trx);
            await sql `ALTER TABLE integration_published_events ENABLE TRIGGER integration_published_immutable`.execute(trx);
            await sql `UPDATE integration_deliveries SET state='accepted'`.execute(trx);
        });
        await sql `SELECT qintopia_integration_prune(${demo.propertyId},30)`.execute(owner);
        await expect(readPmsEventFeed(runtime, demo.propertyId, original.next_cursor)).rejects.toMatchObject({ statusCode: 410, code: "CURSOR_EXPIRED" });
        const now = JSON.parse(await readPmsEventFeed(runtime, demo.propertyId));
        expect(now.events).toEqual([]);
        expect(JSON.parse(await readPmsEventFeed(runtime, demo.propertyId, now.retention_floor_cursor)).events).toEqual([]);
        expect((await sql<{
            count: number;
        }> `SELECT qintopia_integration_publish(${demo.propertyId},100) AS count`.execute(owner)).rows[0]!.count).toBe(0);
    });
    it("supports big integer cursors and rejects future, foreign-property and tampered positions", async () => {
        await sql `UPDATE integration_publish_state SET head=9007199254740993,floor=9007199254740993 WHERE property_id=${demo.propertyId}`.execute(owner);
        const page = JSON.parse(await readPmsEventFeed(runtime, demo.propertyId));
        expect(JSON.parse(await readPmsEventFeed(runtime, demo.propertyId, page.head_cursor)).events).toEqual([]);
        const [payload, signature] = page.head_cursor.split('.');
        const values = JSON.parse(Buffer.from(payload, 'base64url').toString());
        values[2] = 'other-property';
        const other = Buffer.from(JSON.stringify(values)).toString('base64url') + '.' + signature;
        await expect(readPmsEventFeed(runtime, demo.propertyId, other)).rejects.toMatchObject({ statusCode: 403 });
        await expect(readPmsEventFeed(runtime, demo.propertyId, page.head_cursor.slice(0, -3) + 'bad')).rejects.toMatchObject({ statusCode: 400 });
        const { createHmac } = await import('node:crypto');
        const epoch = (await sql<{
            cursor_epoch: string;
        }> `SELECT cursor_epoch FROM integration_publish_state WHERE property_id=${demo.propertyId}`.execute(owner)).rows[0]!.cursor_epoch;
        const future = Buffer.from(JSON.stringify(['pms.events.v1', 'synthetic-pms', demo.propertyId, '9007199254740994'])).toString('base64url');
        await expect(readPmsEventFeed(runtime, demo.propertyId, future + '.' + createHmac('sha256', epoch).update(future).digest('base64url'))).rejects.toMatchObject({ statusCode: 400 });
    });
    it("rejects trigger drift and worker access to business data", async () => {
        await expect(sql `SELECT id FROM members LIMIT 1`.execute(worker)).rejects.toMatchObject({ code: '42501' });
        await expect(sql `SELECT qintopia_integration_control('RESUME','bad','BAD')`.execute(worker)).rejects.toMatchObject({ code: '42501' });
        await owner.transaction().execute(async (trx) => {
            await sql `ALTER TABLE amendments DISABLE TRIGGER integration_order_capture`.execute(trx);
            expect(await databaseReady(trx, { identity: 'maintenance-owner', staffProfileManifestName: 'demo' })).toBe(false);
            await sql `ALTER TABLE amendments ENABLE TRIGGER integration_order_capture`.execute(trx);
        });
        await owner.transaction().execute(async trx => {
            await sql`GRANT SELECT(id) ON members TO qintopia_integration_worker`.execute(trx);
            expect(await integrationReady(trx)).toBe(false);
            await sql`REVOKE SELECT(id) ON members FROM qintopia_integration_worker`.execute(trx);
        });
        expect(await databaseReady(runtime, { staffProfileManifestName: 'demo' })).toBe(true);
    });
    it("rolls back a real command when Outbox insertion fails", async () => {
        const count = await owner.selectFrom('members').select(sql<number> `count(*)::integer`.as('count')).executeTakeFirstOrThrow();
        await sql `CREATE FUNCTION test_integration_reject() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST_OUTBOX_FAULT'; END$$`.execute(owner);
        await sql `CREATE TRIGGER test_integration_reject BEFORE INSERT ON integration_outbox FOR EACH ROW EXECUTE FUNCTION test_integration_reject()`.execute(owner);
        try {
            await expect(command('CREATE_MEMBER', { fullName: '合成回滚', nickname: '测试', phone: '19900009901', wechat: 'synthetic' })).rejects.toBeDefined();
            expect((await owner.selectFrom('members').select(sql<number> `count(*)::integer`.as('count')).executeTakeFirstOrThrow()).count).toBe(count.count);
        }
        finally {
            await sql `DROP TRIGGER test_integration_reject ON integration_outbox`.execute(owner);
            await sql `DROP FUNCTION test_integration_reject()`.execute(owner);
        }
    });
    it("captures the SQL member-deletion path and replays one versioned tombstone", async () => {
        const member = await command('CREATE_MEMBER', { fullName: '合成删除', nickname: '测试', phone: '19900009902', wechat: 'synthetic' });
        const id = member.receipt.result!.memberId as string;
        const before = await readPmsMember(runtime, demo.propertyId, id);
        const oldLog = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'silent';
        const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
        try {
            const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'demo-pass-2026' } });
            expect(login.statusCode).toBe(200);
            const cookie = login.cookies.find(c => c.name === 'qintopia_session')!.value;
            const preview = await app.inject({ url: `/api/v1/members/${id}/deletion-preview?propertyId=${demo.propertyId}`, cookies: { qintopia_session: cookie } });
            expect(preview.statusCode).toBe(200);
            const request = { method: 'POST' as const, url: '/api/v1/account-management', cookies: { qintopia_session: cookie }, payload: { action: 'DELETE_MEMBER', propertyId: demo.propertyId, requestId: 'synthetic-deletion-event', reason: '合成删除', confirmation: true, targetId: id, expectedVersion: preview.json().version } };
            expect((await app.inject(request)).statusCode).toBe(200);
            expect((await app.inject(request)).statusCode).toBe(200);
            const tomb = await readPmsMember(runtime, demo.propertyId, id);
            expect(tomb.resource_state).toBe('tombstone');
            expect(BigInt(tomb.member_revision)).toBe(BigInt(before.member_revision) + 1n);
            expect((await events()).filter(e => e.aggregate_id === id && e.event_type === 'pms.entity.invalidated')).toHaveLength(1);
            expect((await events()).find(e => e.aggregate_id === id && e.event_type === 'pms.entity.invalidated')!.source_fact_ref).toMatch(/^account_management_operation:/);
        }
        finally {
            await app.close();
            if (oldLog === undefined)
                delete process.env.LOG_LEVEL;
            else
                process.env.LOG_LEVEL = oldLog;
        }
    });
    it("keeps arrangement hash stable across a future move boundary and never fabricates overdue occupancy", async () => {
        await maintenance(demo.secondRoomId, 'migration:projection-target-enable', true);
        const initial = await readPmsOrder(runtime, demo.propertyId, bookingId);
        const day = initial.read_context.business_date;
        const nextDate = new Date(`${day}T00:00:00Z`);
        nextDate.setUTCDate(nextDate.getUTCDate() + 1);
        const next = nextDate.toISOString().slice(0, 10);
        await command('MOVE_UNIT', { orderId: bookingId, newInventoryUnitId: demo.secondRoomId, effectiveDate: next });
        const now = await readPmsOrder(runtime, demo.propertyId, bookingId);
        const tomorrow = await withPropertyClockForTesting(new Date(`${next}T04:00:00Z`), () => readPmsOrder(runtime, demo.propertyId, bookingId));
        expect(now.read_context.current_interval?.inventory_unit_id).toBe(demo.roomId);
        expect(tomorrow.read_context.current_interval?.inventory_unit_id).toBe(demo.secondRoomId);
        expect(tomorrow.projection_hash).toBe(now.projection_hash);
        expect(new Set(now.effective_arrangement.intervals.map(i => i.segment_id)).size).toBeGreaterThan(0);
        const departure = now.effective_arrangement.departure_date;
        const due = await withPropertyClockForTesting(new Date(`${departure}T04:00:00Z`), () => readPmsOrder(runtime, demo.propertyId, bookingId));
        expect(due.read_context).toMatchObject({ temporal_state: 'DUE_OUT', current_interval: null });
        expect(due.projection_hash).toBe(now.projection_hash);
        const lateDate = new Date(`${departure}T04:00:00Z`);
        lateDate.setUTCDate(lateDate.getUTCDate() + 1);
        const late = await withPropertyClockForTesting(lateDate, () => readPmsOrder(runtime, demo.propertyId, bookingId));
        expect(late.read_context).toMatchObject({ temporal_state: 'OVERDUE_IN_HOUSE', current_interval: null });
    });
    it("emits composite backfill facts with one final order version and historical origin", async () => {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        const end = new Date(`${day}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() - 1);
        const start = new Date(end);
        start.setUTCDate(start.getUTCDate() - 2);
        const quote = await createQuoteForTesting(owner, { propertyId: demo.propertyId, inventoryUnitId: demo.secondRoomId, arrivalDate: start.toISOString().slice(0, 10), departureDate: end.toISOString().slice(0, 10), pricingPolicyVersionId: demo.publicPricingPolicyId });
        const made = await command('CREATE_ORDER', { quoteId: quote.quoteId, primaryGuest: { fullName: '合成补录', nickname: '测试' }, bookingChannelCode: 'WECOM', backfill: true, backfillReason: '合成历史住宿' }, { code: 'BACKFILL_STAY', note: '合成历史住宿' });
        const id = made.receipt.result!.orderId as string;
        const facts = (await events()).filter(e => e.aggregate_id === id);
        expect(facts).toHaveLength(3);
        expect(facts.every(e => e.aggregate_revision === '3' && e.origin === 'historical_correction')).toBe(true);
        expect(new Set(facts.map(e => e.source_fact_ref)).size).toBe(3);
        expect((await readPmsOrder(runtime, demo.propertyId, id)).read_context).toMatchObject({ temporal_state: 'TERMINAL', current_interval: null });
    });
    it("retains and explicitly replays a dead letter with the same event body", async () => {
        await publish();
        await sql `SELECT qintopia_integration_control('RESUME','fixture-v2','TEST_RESUME')`.execute(owner);
        const captured = await claimDelivery(worker, deliveryConfig);
        expect(captured).toBeDefined();
        captured!.first_attempt_at = new Date(Date.now() - 86400001);
        expect(await finishDelivery(worker, captured!, { kind: 'retry', code: 'TRANSPORT_UNCONFIRMED' })).toBe(true);
        expect((await sql<{
            state: string;
        }> `SELECT state FROM integration_deliveries WHERE event_id=${captured!.event_id}`.execute(owner)).rows[0]!.state).toBe('dead_letter');
        await sql `SELECT qintopia_integration_control('REPLAY','fixture-v2','TEST_REPLAY',${captured!.event_id})`.execute(owner);
        const row = (await sql<{
            body: string;
        }> `SELECT body FROM integration_published_events WHERE event_id=${captured!.event_id}`.execute(worker)).rows[0]!;
        expect(row.body).toBe(captured!.body);
    });
    it("starts the dedicated publisher with its restricted identity and stops on SIGTERM without network delivery", async () => {
        const workerUrl = new URL(testDatabaseUrl);
        workerUrl.username = "qintopia_integration_worker";
        workerUrl.password = "";
        const child = spawn(process.execPath, ["--import", "tsx", "packages/db/src/integration-worker-main.ts"], {
            env: {...process.env, PMS_INTEGRATION_PUBLISH_ENABLED:"true", PMS_INTEGRATION_DELIVERY_ENABLED:"false", PMS_INTEGRATION_PRUNE_ENABLED:"false",
                PMS_INTEGRATION_WORKER_DATABASE_URL:workerUrl.toString(), PMS_INTEGRATION_SOURCE_INSTANCE:"synthetic-pms", PMS_INTEGRATION_PROPERTY_IDS:demo.propertyId},
            stdio:["ignore","pipe","pipe"]
        });
        let output="";
        const exited=new Promise<number|null>(resolve=>child.once("exit",code=>resolve(code)));
        try {
            await new Promise<void>((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error("PUBLISHER_START_TIMEOUT")),10000);
                child.stdout.on("data",chunk=>{output+=String(chunk);if(output.includes("INTEGRATION_STATUS")){clearTimeout(timer);resolve();}});
                child.once("error",()=>{clearTimeout(timer);reject(Error("PUBLISHER_START_FAILED"));});
                child.once("exit",()=>{clearTimeout(timer);if(!output.includes("INTEGRATION_STATUS"))reject(Error("PUBLISHER_START_FAILED"));});
            });
            child.kill("SIGTERM");
            expect(await exited).toBe(0);
            expect(output).not.toContain('"attempted":1');
        } finally {if(child.exitCode===null)child.kill("SIGKILL");}
    });

});
