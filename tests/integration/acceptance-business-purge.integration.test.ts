import pg from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, executeQuoteCommand } from "../../packages/db/src/commands/service.ts";
import { createDatabase, currentMigrationNames } from "../../packages/db/src/database.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { readRoomCatalog, resolveCatalogPolicyId } from "../../packages/db/src/room-catalog.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import {
  AcceptanceBusinessPurgeCommittedVerificationError,
  acceptanceBusinessTables,
  preservedBaseTables,
  assertBusinessTablesEmpty,
  assertQintopiaLocalTarget,
  assertExpectedLocalDatabaseIdentity,
  truncateAcceptanceBusinessDataWithinExclusiveGate,
  withPurgedIsolatedAcceptanceDatabase,
  withExclusiveAcceptanceWriterGate
} from "../../scripts/purge-local-acceptance-business-data.ts";
import { assertNoOtherDatabaseSessions } from "../e2e/setup-room-status-visual-acceptance.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const adminUrl = process.env.ACCEPTANCE_PURGE_ADMIN_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
const databaseName = `qintopia_purge_acceptance_${process.pid}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

// Source transactions and durable v1/v2 event/delivery history are not booking facts.
const preservedPaymentHistoryTables = [
  "external_payment_sources", "external_payment_accounts", "external_payment_bills",
  "external_payment_contacts", "external_payment_event_heads", "external_payment_events",
  "payment_delivery_source", "payment_delivery_events", "payment_deliveries", "payment_delivery_audit",
  "payment_allocation_heads", "payment_allocation_events", "allocation_delivery_source",
  "allocation_delivery_events", "allocation_deliveries", "allocation_delivery_audit"
] as const;

let db: Kysely<Database> | undefined;

const writerPrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Acceptance purge writer",
  ...authScope()
};

function withApplicationName(value: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", value);
  return url.toString();
}

async function dropDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function eventually(assertion: () => Promise<boolean>, description: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForNoTargetSessions(description: string): Promise<void> {
  const observer = new pg.Client({ connectionString: adminUrl });
  await observer.connect();
  try {
    await eventually(async () => {
      const result = await observer.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1",
        [databaseName]
      );
      return result.rows[0]?.count === "0";
    }, description);
  } finally {
    await observer.end();
  }
}

async function insertTestQuote(currentDb: Kysely<Database>, id: string): Promise<void> {
  await currentDb.insertInto("quotes").values({
    id,
    property_id: demo.propertyId,
    inventory_unit_id: demo.roomId,
    stay_type: "TRANSIENT",
    arrival_date: "2026-09-10",
    departure_date: "2026-09-11",
    policy_version_id: demo.publicPricingPolicyId,
    requester_subject_id: demo.agentSubjectId,
    input_hash: "a".repeat(64),
    coverage_set: [],
    cash_lines: [],
    cash_remainder_minor: 10_000,
    current_contract_amount_minor: 10_000,
    currency: "CNY",
    expires_at: new Date("2026-09-10T12:00:00.000Z")
  }).execute();
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl.toString());
  await db.insertInto("room_status_revisions")
    .values({ property_id: demo.propertyId, revision: 0 })
    .onConflict((conflict) => conflict.column("property_id").doNothing())
    .execute();
});

afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

afterAll(dropDatabase);

describe("acceptance business-data purge isolation", () => {
  it("keeps the CLI target fixed to 55432 even when synthetic tests run on another port", () => {
    expect(assertQintopiaLocalTarget("postgres://qintopia:qintopia@127.0.0.1:55432/qintopia").port).toBe("55432");
    for (const target of [
      "postgres://qintopia:qintopia@127.0.0.1:55439/qintopia",
      "postgres://qintopia:qintopia@localhost:55432/qintopia",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_purge_acceptance_123"
    ]) {
      expect(() => assertQintopiaLocalTarget(target)).toThrow("Refusing purge: target must be");
    }
  });

  it("explicitly includes the complete inbound FK closure without external payment history", async () => {
    const closure = await sql<{ table_name: string }>`
      with recursive purge_closure(table_oid) as (
        select to_regclass(table_name)::oid
        from unnest(${[...acceptanceBusinessTables]}::text[]) as tables(table_name)
        union
        select constraint_.conrelid
        from pg_constraint as constraint_
        join purge_closure on constraint_.confrelid = purge_closure.table_oid
        where constraint_.contype = 'f'
      )
      select relation.relname as table_name
      from purge_closure
      join pg_class as relation on relation.oid = purge_closure.table_oid
      order by relation.relname
    `.execute(db!);
    const missing = closure.rows.map((row) => row.table_name)
      .filter((table) => !(acceptanceBusinessTables as readonly string[]).includes(table));
    expect(missing).toEqual([]);
    for (const table of preservedPaymentHistoryTables) {
      expect(closure.rows.map((row) => row.table_name)).not.toContain(table);
    }
  });

  it("purges populated payment attribution and retained funds while preserving source and event bytes", async () => {
    const currentDb = db!;
    const principal: AuthPrincipal = {
      subjectId: demo.administratorSubjectId,
      credentialId: "purge-funds-session",
      credentialType: "SESSION",
      displayName: "Synthetic purge regression",
      ...authScope({ credentialType: "SESSION", profile: "administrator" })
    };
    await currentDb.insertInto("web_sessions").values({
      id: principal.credentialId, subject_id: principal.subjectId,
      secret_hash: "a".repeat(64), expires_at: new Date(Date.now() + 3_600_000), revoked_at: null
    }).execute();
    let sequence = 0;
    async function command(envelope: CommandEnvelope) {
      const metadata = { idempotencyKey: `purge-funds-${++sequence}`, correlationId: `purge-funds-${sequence}` };
      const prepared = await createCommandPreview(currentDb, principal, envelope, metadata);
      const receipt = await confirmCommandPreview(currentDb, principal, prepared.preview.previewId, {
        propertyId: demo.propertyId, commandType: envelope.commandType, confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: envelope.commandType === "CREATE_ORDER"
          ? { code: "CREATE_STANDARD_ORDER", note: "" }
          : { code: "PURGE_REGRESSION", note: "合成数据清理回归" }
      }, metadata);
      expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
      return receipt;
    }
    const quote = await createQuoteForTesting(currentDb, {
      propertyId: demo.propertyId, inventoryUnitId: demo.roomId, stayType: "TRANSIENT",
      arrivalDate: "2028-12-10", departureDate: "2028-12-11",
      pricingPolicyVersionId: demo.transientPolicyId
    });
    const created = await command({ commandType: "CREATE_ORDER", input: {
      propertyId: demo.propertyId, quoteId: quote.quoteId,
      primaryGuest: { fullName: "清理合成客户", nickname: "合成", phone: "13800000000" },
      bookingChannelCode: "WECOM", targetCurrentContractAmountMinor: 100_000,
      manualPriceAdjustmentReason: "合成资金清理测试"
    } });
    const orderId = created.result!.orderId as string;
    const execution = await currentDb.selectFrom("command_executions").select("id")
      .where("idempotency_key", "=", "purge-funds-1").executeTakeFirstOrThrow();
    await sql`insert into external_payment_sources(id,corp_id,enabled,import_since,baseline_complete)
      values('purge-source','purge-corp',true,'2026-09-01',true)`.execute(currentDb);
    await sql`insert into external_payment_accounts values('purge-source','purge-merchant',${demo.propertyId})`.execute(currentDb);
    await sql`insert into external_payment_contacts values('purge-source','purge-contact','合成客户',now())`.execute(currentDb);
    await sql`insert into external_payment_bills(
      id,source_id,merchant_id,property_id,kind,reference,original_trade_no,transaction_id,amount_minor,occurred_at,state
    ) values('purge-bill','purge-source','purge-merchant',${demo.propertyId},'COLLECTION',
      'purge-reference','purge-trade','purge-reference',100000,now(),'SUCCESS')`.execute(currentDb);
    // v1 discovery is emitted by the sync worker, not the bill INSERT trigger.
    await sql`select qintopia_external_payment_event('purge-bill','DISCOVERED')`.execute(currentDb);
    // Real guards stay enabled. A legacy match mirrors an allocation in the same transaction.
    await currentDb.transaction().execute(async (trx) => {
      await sql`insert into collection_facts(
        fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,transaction_reference
      ) select 'purge-fact',id,'COLLECTION',100000,100000,'CNY','WECOM','合成历史关联',
        ${execution.id},current_revision_id,'purge-reference' from orders where id=${orderId}`.execute(trx);
      await sql`insert into external_payment_matches(bill_id,collection_fact_id,origin)
        values('purge-bill','purge-fact','HISTORICAL_LINK')`.execute(trx);
    });
    await command({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } });
    await sql`insert into retained_funds(
      id,property_id,source_order_id,source_fact_id,bill_id,owner_name,owner_contact,confirmation_note,amount_minor,command_id
    ) values('purge-retained',${demo.propertyId},${orderId},'purge-fact','purge-bill',
      '合成客户','13800000000','客户确认留存',60000,${execution.id})`.execute(currentDb);
    await sql`insert into retained_fund_entries(id,retained_fund_id,kind,amount_minor,authorization_note,command_id)
      values('purge-retained-release','purge-retained','RELEASE',60000,'客户撤回留存',${execution.id})`.execute(currentDb);
    await sql`insert into command_executions(
      id,subject_id,credential_id,property_id,command_type,idempotency_key,request_hash,correlation_id,state
    ) select 'purge-reverse',subject_id,credential_id,property_id,'REVERSE_FACT','purge-reverse',
      request_hash,'purge-reverse','EXECUTING' from command_executions where id=${execution.id}`.execute(currentDb);
    await currentDb.transaction().execute(async (trx) => {
      await sql`insert into collection_facts(
        fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,method,note,command_id,pricing_revision_id,reverses_fact_id
      ) select 'purge-reversal',id,'REVERSAL',100000,-100000,'CNY','WECOM','误录冲销',
        'purge-reverse',current_revision_id,'purge-fact' from orders where id=${orderId}`.execute(trx);
      await sql`insert into external_payment_allocation_releases(id,allocation_id,reversal_fact_id,command_id)
        values('purge-allocation-release','legacy:purge-bill','purge-reversal','purge-reverse')`.execute(trx);
    });
    for (const prefix of ["payment", "allocation"] as const) {
      await sql`insert into ${sql.table(`${prefix}_delivery_source`)}(source_instance)
        values('purge-synthetic')`.execute(currentDb);
      await sql`select ${sql.ref(`qintopia_${prefix}_delivery_publish`)}(${demo.propertyId},'purge-synthetic')`.execute(currentDb);
      await sql`select ${sql.ref(`qintopia_${prefix}_delivery_control`)}('PAUSE','PURGE_REGRESSION')`.execute(currentDb);
    }
    const preservedTables = [
      ...preservedBaseTables.filter((table) => table !== "room_status_revisions"),
      ...preservedPaymentHistoryTables
    ];
    async function snapshot() {
      const rows: Record<string, unknown> = {};
      for (const table of preservedTables) {
        const result = await sql<{ rows: unknown }>`select coalesce(
          jsonb_agg(to_jsonb(row_) order by to_jsonb(row_)::text), '[]'::jsonb
        ) as rows from ${sql.table(table)} as row_`.execute(currentDb);
        rows[table] = result.rows[0]!.rows;
      }
      return rows;
    }
    const before = await snapshot();
    for (const table of preservedPaymentHistoryTables) {
      expect(before[table], table).not.toEqual([]);
    }
    const result = await withExclusiveAcceptanceWriterGate(currentDb, (connection) => (
      truncateAcceptanceBusinessDataWithinExclusiveGate(connection, demo.propertyId)
    ));
    for (const table of ["external_payment_matches", "external_payment_allocations",
      "external_payment_allocation_releases", "retained_funds", "retained_fund_entries"]) {
      expect(result.businessCountsBefore[table], table).toBe(1);
    }
    await expect(assertBusinessTablesEmpty(currentDb)).resolves.toBeUndefined();
    expect(await snapshot()).toEqual(before);
    expect(BigInt(result.roomStatusRevisionAfter)).toBe(BigInt(result.roomStatusRevisionBefore) + 1n);
  });

  it("preserves maintained room configuration and prices while resetting only its command history", async () => {
    const currentDb = db!;
    const principal: AuthPrincipal = {
      subjectId: demo.administratorSubjectId, credentialId: "purge-catalog-session",
      credentialType: "SESSION", displayName: "Synthetic catalog purge regression",
      ...authScope({ credentialType: "SESSION", profile: "administrator" })
    };
    await currentDb.insertInto("web_sessions").values({
      id: principal.credentialId, subject_id: principal.subjectId,
      secret_hash: "b".repeat(64), expires_at: new Date(Date.now() + 3_600_000), revoked_at: null
    }).execute();
    let sequence = 0;
    async function change(input: Record<string, unknown>) {
      const catalog = await readRoomCatalog(currentDb, demo.propertyId);
      const metadata = { idempotencyKey: `purge-catalog-${++sequence}`, correlationId: `purge-catalog-${sequence}` };
      const prepared = await createCommandPreview(currentDb, principal, {
        commandType: "MANAGE_ROOM_CATALOG",
        input: { propertyId: demo.propertyId, expectedVersion: catalog.version, ...input }
      }, metadata);
      const receipt = await confirmCommandPreview(currentDb, principal, prepared.preview.previewId, {
        propertyId: demo.propertyId, commandType: "MANAGE_ROOM_CATALOG", confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "ROOM_CATALOG_CHANGE", note: "经营配置保留合成回归" }
      }, metadata);
      expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
    }
    await change({ action: "SAVE_TYPE", name: "清理后保留经营房型", bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 2, capacity: 2 });
    const type = (await readRoomCatalog(currentDb, demo.propertyId)).types.find((item) => item.name === "清理后保留经营房型")!;
    await change({ action: "PUBLISH_RATES", typeCode: type.code, effectiveFrom: (await readRoomCatalog(currentDb, demo.propertyId)).businessDate,
      anchors: { "1": 8800, "7": 44000, "14": 66000, "30": 110000 } });
    await change({ action: "SAVE_ROOM", typeCode: type.code, code: "PURGE-CATALOG-ROOM",
      buildingCode: "合成楼", bedCount: 2, capacity: 2 });
    const before = await readRoomCatalog(currentDb, demo.propertyId);
    expect(before.history).toHaveLength(3);
    const room = before.rooms.find((item) => item.code === "PURGE-CATALOG-ROOM")!;
    const policyId = (await resolveCatalogPolicyId(currentDb, demo.propertyId, "2028-12-10"))!;
    const quoteRequest = {
      propertyId: demo.propertyId, inventoryUnitId: room.unitId,
      arrivalDate: "2028-12-10", departureDate: "2028-12-11", pricingPolicyVersionId: policyId
    };
    expect((await createQuoteForTesting(currentDb, quoteRequest)).currentContractAmount.minorUnits).toBe(8800);
    const configurationTables = ["inventory_units", "pricing_policy_versions", "room_catalog_state",
      "room_catalog_links", "room_catalog_heads"] as const;
    async function configurationRows() {
      const rows: Record<string, unknown> = {};
      for (const table of configurationTables) {
        const result = await sql<{ rows: unknown }>`select coalesce(
          jsonb_agg(to_jsonb(row_) order by to_jsonb(row_)::text), '[]'::jsonb
        ) as rows from ${sql.table(table)} as row_`.execute(currentDb);
        rows[table] = result.rows[0]!.rows;
        expect(rows[table], table).not.toEqual([]);
      }
      return rows;
    }
    const persistedBefore = await configurationRows();
    const result = await withExclusiveAcceptanceWriterGate(currentDb, (connection) => (
      truncateAcceptanceBusinessDataWithinExclusiveGate(connection, demo.propertyId)
    ));
    expect(result.businessCountsBefore.room_catalog_changes).toBe(3);
    await expect(assertBusinessTablesEmpty(currentDb)).resolves.toBeUndefined();
    expect(await configurationRows()).toEqual(persistedBefore);
    expect(await readRoomCatalog(currentDb, demo.propertyId)).toEqual({ ...before, history: [] });
    expect(await resolveCatalogPolicyId(currentDb, demo.propertyId, "2028-12-10")).toBe(policyId);
    expect((await createQuoteForTesting(currentDb, quoteRequest)).currentContractAmount.minorUnits).toBe(8800);
    // The preserved version remains the next write's basis; no old change row is required.
    await change({ action: "SAVE_TYPE", typeCode: type.code, name: "清理后继续维护经营房型",
      bathroom: "PRIVATE", saleMode: "ROOM", bedCount: 2, capacity: 2 });
    const after = await readRoomCatalog(currentDb, demo.propertyId);
    expect(after.version).toBe(before.version + 1);
    expect(after.history).toHaveLength(1);
    expect(after.rates).toEqual(before.rates);
    expect(after.rooms).toEqual(before.rooms);
    expect(after.types.find((item) => item.code === type.code)?.name).toBe("清理后继续维护经营房型");
  });

  it("holds the protocol writer lock for the entire guarded operation", async () => {
    await db!.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the writer-gate test");

    const gateDb = createDatabase(withApplicationName(`acceptance-writer-gate-${process.pid}`));
    let releaseGate!: () => void;
    let markGateEntered!: () => void;
    const gateEntered = new Promise<void>((resolve) => {
      markGateEntered = resolve;
    });
    const gateRelease = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const guarded = withExclusiveAcceptanceWriterGate(gateDb, async () => {
      markGateEntered();
      await gateRelease;
    });
    await gateEntered;

    const competitor = new pg.Client({
      connectionString: databaseUrl.toString(),
      application_name: "acceptance-writer-gate-competitor"
    });
    await competitor.connect();
    try {
      const whileGuarded = await competitor.query<{ acquired: boolean }>(`
        select pg_try_advisory_lock(
          hashtextextended('qintopia:protocol-epoch', 0::bigint)
        ) as acquired
      `);
      expect(whileGuarded.rows[0]?.acquired).toBe(false);

      releaseGate();
      await guarded;

      const afterRelease = await competitor.query<{ acquired: boolean }>(`
        select pg_try_advisory_lock(
          hashtextextended('qintopia:protocol-epoch', 0::bigint)
        ) as acquired
      `);
      expect(afterRelease.rows[0]?.acquired).toBe(true);
      await competitor.query(`
        select pg_advisory_unlock(
          hashtextextended('qintopia:protocol-epoch', 0::bigint)
        )
      `);
    } finally {
      releaseGate();
      await Promise.allSettled([guarded]);
      await competitor.end();
      await gateDb.destroy();
    }
  });

  it("rejects a numbered migration whose exact identity differs from the authoritative list", async () => {
    const currentDb = db!;
    await expect(assertExpectedLocalDatabaseIdentity(currentDb)).resolves.toBeUndefined();
    const originalName = currentMigrationNames[9];
    expect(originalName).toBe("010_qintopia_2026_catalog_pricing_and_free_stays.sql");
    await currentDb.updateTable("schema_migrations")
      .set({ name: "010_tampered_but_still_numbered.sql" })
      .where("name", "=", originalName)
      .executeTakeFirstOrThrow();
    await expect(assertExpectedLocalDatabaseIdentity(currentDb)).rejects.toThrow(
      "migration identity must exactly match"
    );
  });

  it("refuses a pre-existing database session before changing any business table", async () => {
    const currentDb = db!;
    const protectedQuoteId = `quote_before_session_guard_${process.pid}`;
    await insertTestQuote(currentDb, protectedQuoteId);
    await currentDb.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the session-guard test");

    const competitor = new pg.Client({
      connectionString: databaseUrl.toString(),
      application_name: "acceptance-purge-test-existing-session"
    });
    await competitor.connect();
    const purgeApplicationName = `acceptance-purge-test-session-guard-${process.pid}`;
    try {
      await expect(withPurgedIsolatedAcceptanceDatabase(
        withApplicationName(purgeApplicationName),
        demo.propertyId,
        { run: async () => undefined }
      ))
        .rejects.toThrow("database still has 1 other session");
      await expect(competitor.query("SELECT id FROM quotes WHERE id = $1", [protectedQuoteId]))
        .resolves.toMatchObject({ rows: [{ id: protectedQuoteId }] });
    } finally {
      await competitor.end();
    }
  });

  it("rolls back when a database session arrives after the purge has acquired table locks", async () => {
    const currentDb = db!;
    const protectedQuoteId = `quote_before_late_session_${process.pid}`;
    await insertTestQuote(currentDb, protectedQuoteId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_pause_acceptance_purge()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(5);
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_pause_acceptance_purge
      BEFORE UPDATE ON room_status_revisions
      FOR EACH ROW EXECUTE FUNCTION qintopia_test_pause_acceptance_purge();
    `).execute(currentDb);
    await currentDb.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the late-session test");

    const observer = new pg.Client({
      connectionString: adminUrl,
      application_name: "acceptance-purge-test-observer"
    });
    const competitor = new pg.Client({
      connectionString: databaseUrl.toString(),
      application_name: "acceptance-purge-test-late-session"
    });
    await observer.connect();

    const purgeApplicationName = `acceptance-purge-test-purge-${process.pid}`;
    const purge = withPurgedIsolatedAcceptanceDatabase(
      withApplicationName(purgeApplicationName),
      demo.propertyId,
      { run: async () => undefined }
    );
    void purge.catch(() => undefined);
    let competitorConnected = false;
    try {
      await eventually(async () => {
        const result = await observer.query<{ pid: number }>(`
          select pid::integer as pid
          from pg_stat_activity
          where datname = $1
            and application_name = $2
            and wait_event_type = 'Timeout'
            and wait_event = 'PgSleep'
        `, [databaseName, purgeApplicationName]);
        return result.rows.length === 1;
      }, "purge to hold table locks while paused at the revision update");

      const purgePid = await observer.query<{ pid: number }>(`
        select pid::integer as pid from pg_stat_activity
        where datname = $1 and application_name = $2
      `, [databaseName, purgeApplicationName]).then((result) => result.rows[0]?.pid);
      expect(purgePid).toBeTypeOf("number");
      const heldLocks = await observer.query<{ access_exclusive: boolean; advisory_exclusive: boolean }>(`
        select
          exists (
            select 1 from pg_locks
            where pid = $1
              and locktype = 'relation'
              and mode = 'AccessExclusiveLock'
              and granted
          ) as access_exclusive,
          exists (
            select 1 from pg_locks
            where pid = $1
              and locktype = 'advisory'
              and mode = 'ExclusiveLock'
              and granted
          ) as advisory_exclusive
      `, [purgePid!]);
      expect(heldLocks.rows[0]).toEqual({ access_exclusive: true, advisory_exclusive: true });

      await competitor.connect();
      competitorConnected = true;

      await expect(purge).rejects.toThrow("database still has 1 other session");
      await expect(competitor.query("SELECT id FROM quotes WHERE id = $1", [protectedQuoteId]))
        .resolves.toMatchObject({ rows: [{ id: protectedQuoteId }] });
    } finally {
      await Promise.allSettled([purge]);
      if (competitorConnected) await competitor.end();
      await observer.end();
    }
  });

  it("returns success only after a sole-session purge and post-commit empty verification", async () => {
    const currentDb = db!;
    const quoteId = `quote_for_successful_purge_${process.pid}`;
    await insertTestQuote(currentDb, quoteId);
    const propertyCountBefore = await currentDb.selectFrom("properties")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    await currentDb.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the successful purge");

    const result = await withPurgedIsolatedAcceptanceDatabase(
      withApplicationName(`acceptance-purge-test-success-${process.pid}`),
      demo.propertyId,
      { run: async (_connection, initialPurge) => initialPurge }
    );

    const verificationDb = createDatabase(databaseUrl.toString());
    db = verificationDb;
    await expect(assertBusinessTablesEmpty(verificationDb)).resolves.toBeUndefined();
    await expect(verificationDb.selectFrom("properties")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()).resolves.toEqual(propertyCountBefore);
    expect(result.businessCountsBefore.quotes).toBeGreaterThan(0);
    expect(BigInt(result.roomStatusRevisionAfter)).toBe(BigInt(result.roomStatusRevisionBefore) + 1n);
  });

  it("refuses the real qintopia database and non-local lookalikes at the isolated destructive boundary", async () => {
    const run = { run: async () => undefined };
    await expect(withPurgedIsolatedAcceptanceDatabase(adminUrl, demo.propertyId, run))
      .rejects.toThrow("never qintopia");

    const remoteLookalike = new URL(databaseUrl);
    remoteLookalike.hostname = "localhost";
    await expect(withPurgedIsolatedAcceptanceDatabase(remoteLookalike.toString(), demo.propertyId, run))
      .rejects.toThrow("exact local");

    const wrongLocalDatabase = new URL(databaseUrl);
    wrongLocalDatabase.pathname = "/qintopia_visual_acceptance";
    await expect(withPurgedIsolatedAcceptanceDatabase(wrongLocalDatabase.toString(), demo.propertyId, run))
      .rejects.toThrow("exact local");
  });

  it("cleans a partially written isolated fixture under the same gate and permits a clean retry", async () => {
    const currentDb = db!;
    await currentDb.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the fixture cleanup test");

    const failureUrl = withApplicationName(`acceptance-fixture-failure-${process.pid}`);
    await expect(withPurgedIsolatedAcceptanceDatabase(failureUrl, demo.propertyId, {
      run: async (connection) => {
        await insertTestQuote(connection, `quote_partial_fixture_${process.pid}`);
        throw new Error("simulated late fixture failure");
      }
    })).rejects.toThrow("simulated late fixture failure");

    const verificationDb = createDatabase(databaseUrl.toString());
    await expect(assertBusinessTablesEmpty(verificationDb)).resolves.toBeUndefined();
    await verificationDb.destroy();
    await waitForNoTargetSessions("the verification connection to close before the fixture retry");

    const retry = await withPurgedIsolatedAcceptanceDatabase(
      withApplicationName(`acceptance-fixture-retry-${process.pid}`),
      demo.propertyId,
      { run: async (_connection, initialPurge) => initialPurge }
    );
    expect(Object.values(retry.businessCountsBefore).every((count) => count === 0)).toBe(true);
  });

  it("keeps the production quote writer blocked through failed-fixture cleanup and preserves its later commit", async () => {
    await db!.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the failed-fixture writer race test");

    const gateDb = createDatabase(withApplicationName(`acceptance-fixture-race-gate-${process.pid}`));
    const writerDb = createDatabase(withApplicationName(`acceptance-fixture-race-writer-${process.pid}`));
    const observer = new pg.Client({
      connectionString: adminUrl,
      application_name: "acceptance-fixture-race-observer"
    });
    await observer.connect();

    const partialFixtureQuoteId = `quote_failed_fixture_${process.pid}`;
    const writerIdempotencyKey = `quote-waiting-writer-${process.pid}`;
    let writerCommitted = false;
    let writerCommit: ReturnType<typeof executeQuoteCommand> | undefined;
    const setup = withExclusiveAcceptanceWriterGate(gateDb, async (connection) => {
      await insertTestQuote(connection, partialFixtureQuoteId);
      writerCommit = executeQuoteCommand(writerDb, writerPrincipal, {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        arrivalDate: "2028-09-10",
        departureDate: "2028-09-11",
        pricingPolicyVersionId: demo.transientPolicyId
      }, {
        idempotencyKey: writerIdempotencyKey,
        correlationId: `correlation-${writerIdempotencyKey}`
      }).then((result) => {
        writerCommitted = true;
        return result;
      });
      void writerCommit.catch(() => undefined);

      await eventually(async () => {
        const result = await observer.query<{ waiting: boolean }>(`
          select exists (
            select 1
            from pg_stat_activity as activity
            where activity.datname = $1
              and activity.wait_event_type = 'Lock'
              and activity.wait_event = 'advisory'
              and exists (
                select 1
                from pg_locks as waiting_lock
                where waiting_lock.pid = activity.pid
                  and waiting_lock.locktype = 'advisory'
                  and waiting_lock.mode = 'ShareLock'
                  and not waiting_lock.granted
              )
          ) as waiting
        `, [databaseName]);
        return result.rows[0]?.waiting === true;
      }, "the shared writer to wait on the failed fixture's exclusive protocol gate");

      const setupError = new Error("simulated qintopia fixture build failure");
      try {
        throw setupError;
      } catch (operationError) {
        await truncateAcceptanceBusinessDataWithinExclusiveGate(connection, demo.propertyId, {
          allowBlockedProtocolSharedWriters: true
        });
        expect(writerCommitted).toBe(false);
        throw operationError;
      }
    });

    try {
      await expect(setup).rejects.toThrow("simulated qintopia fixture build failure");
      const writerResult = await writerCommit;
      expect(writerCommitted).toBe(true);

      const verificationDb = createDatabase(databaseUrl.toString());
      db = verificationDb;
      await expect(verificationDb.selectFrom("quotes")
        .select("id")
        .where("id", "in", [partialFixtureQuoteId, writerResult!.quote.quoteId])
        .orderBy("id")
        .execute()).resolves.toEqual([{ id: writerResult!.quote.quoteId }]);
      const execution = await verificationDb.selectFrom("command_executions")
        .select(["id", "state"])
        .where("command_type", "=", "CREATE_QUOTE")
        .where("idempotency_key", "=", writerIdempotencyKey)
        .executeTakeFirstOrThrow();
      const [receipts, audits] = await Promise.all([
        verificationDb.selectFrom("command_receipts")
          .select("id")
          .where("command_id", "=", execution.id)
          .execute(),
        verificationDb.selectFrom("audit_entries")
          .select("id")
          .where("command_id", "=", execution.id)
          .execute()
      ]);
      expect(execution.state).toBe("APPLIED");
      expect(receipts).toHaveLength(1);
      expect(audits).toHaveLength(1);
    } finally {
      await Promise.allSettled([setup, ...(writerCommit ? [writerCommit] : [])]);
      await writerDb.destroy();
      await gateDb.destroy();
      await observer.end();
    }
  });

  it("reports that truncation committed when sole-session post-commit verification fails", async () => {
    const currentDb = db!;
    const removedQuoteId = `quote_committed_before_verification_failure_${process.pid}`;
    await insertTestQuote(currentDb, removedQuoteId);
    await currentDb.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the committed-verification test");

    const gateDb = createDatabase(withApplicationName(`acceptance-committed-verification-${process.pid}`));
    let lateSession: pg.Client | undefined;
    try {
      const error = await withExclusiveAcceptanceWriterGate(gateDb, (connection) => (
        truncateAcceptanceBusinessDataWithinExclusiveGate(connection, demo.propertyId, {
          afterCommitBeforeVerificationForTesting: async () => {
            lateSession = new pg.Client({
              connectionString: databaseUrl.toString(),
              application_name: "acceptance-post-commit-verification-competitor"
            });
            await lateSession.connect();
          }
        })
      )).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AcceptanceBusinessPurgeCommittedVerificationError);
      expect(error).toMatchObject({
        purgeCommitted: true,
        message: expect.stringContaining("purge committed")
      });
      await expect(lateSession!.query("SELECT id FROM quotes WHERE id = $1", [removedQuoteId]))
        .resolves.toMatchObject({ rows: [] });
    } finally {
      await lateSession?.end();
      await gateDb.destroy();
    }
  });

  it("detects another database session while allowing the fixture's own application", async () => {
    await db!.destroy();
    db = undefined;
    await waitForNoTargetSessions("the setup connection to close before the fixture-session test");
    const ownApplicationName = `acceptance-fixture-self-${process.pid}`;
    const ownDb = createDatabase(withApplicationName(ownApplicationName));
    const competitor = new pg.Client({
      connectionString: databaseUrl.toString(),
      application_name: "acceptance-fixture-competing-writer"
    });
    await competitor.connect();
    try {
      await expect(assertNoOtherDatabaseSessions(ownDb, databaseName, ownApplicationName))
        .rejects.toThrow("still has other sessions");
    } finally {
      await competitor.end();
    }
    await expect(assertNoOtherDatabaseSessions(ownDb, databaseName, ownApplicationName))
      .resolves.toBeUndefined();
    await ownDb.destroy();
  });
});
