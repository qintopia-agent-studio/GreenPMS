import pg from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal } from "@qintopia/contracts";
import { executeQuoteCommand } from "../../packages/db/src/commands/service.ts";
import { createDatabase, currentMigrationNames } from "../../packages/db/src/database.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { demo } from "../../packages/db/src/seed.ts";
import {
  AcceptanceBusinessPurgeCommittedVerificationError,
  assertBusinessTablesEmpty,
  assertExpectedLocalDatabaseIdentity,
  truncateAcceptanceBusinessDataWithinExclusiveGate,
  withPurgedIsolatedAcceptanceDatabase,
  withExclusiveAcceptanceWriterGate
} from "../../scripts/purge-local-acceptance-business-data.ts";
import { assertNoOtherDatabaseSessions } from "../e2e/setup-room-status-visual-acceptance.ts";
import { resetDatabase } from "../helpers/database.ts";

const adminUrl = process.env.ACCEPTANCE_PURGE_ADMIN_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
const databaseName = `qintopia_purge_acceptance_${process.pid}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

let db: Kysely<Database> | undefined;

const writerPrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Acceptance purge writer",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
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
