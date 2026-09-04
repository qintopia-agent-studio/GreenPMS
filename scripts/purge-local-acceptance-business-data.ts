import { pathToFileURL } from "node:url";
import { sql, type Kysely } from "kysely";
import { createDatabase, currentMigrationNames } from "../packages/db/src/database.ts";
import type { Database } from "../packages/db/src/schema.ts";

export const QINTOPIA_LOCAL_DATABASE = {
  host: "127.0.0.1",
  port: "55432",
  database: "qintopia",
  propertyId: "prop_qintopia_demo",
  migrationCount: currentMigrationNames.length,
  latestMigration: currentMigrationNames[currentMigrationNames.length - 1]
} as const;

export const preservedBaseTables = [
  "schema_migrations",
  "properties",
  "catalog_import_batches",
  "inventory_catalog_entries",
  "reference_rate_entries",
  "reference_membership_products",
  "inventory_units",
  "pricing_policy_versions",
  "subjects",
  "subject_property_grants",
  "api_tokens",
  "web_sessions",
  "membership_products",
  "room_status_revisions"
] as const satisfies readonly (keyof Database)[];

export const acceptanceBusinessTables = [
  "member_profile_corrections",
  "membership_effective_date_corrections",
  "historical_membership_backfills",
  "membership_payment_reclassifications",
  "membership_void_reconversions",
  "historical_stay_arrangement_corrections",
  "admin_membership_payment_evidence_claims",
  "stay_collection_membership_transfers",
  "membership_payment_facts",
  "membership_orders",
  "member_external_references",
  "member_property_links",
  "entitlement_ledger",
  "coverage_items",
  "entitlement_lots",
  "member_contracts",
  "members",
  "order_occupant_corrections",
  "order_occupants",
  "collection_facts",
  "cleaning_tasks",
  "internal_use_blocks",
  "maintenance_locks",
  "inventory_claims",
  "inventory_bed_days",
  "inventory_room_days",
  "pricing_revisions",
  "stay_segments",
  "amendments",
  "stays",
  "orders",
  "quotes",
  "command_receipts",
  "command_previews",
  "command_executions",
  "audit_entries"
] as const satisfies readonly (keyof Database)[];

export interface PurgeArguments {
  execute: boolean;
  confirmedDatabase: string | null;
  writersStopped: boolean;
}

export interface PurgeResult {
  mode: "dry-run" | "executed";
  database: string;
  propertyId: string;
  migrationCount: number;
  businessCountsBefore: Record<string, number>;
  roomStatusRevisionBefore: string;
  roomStatusRevisionAfter: string;
}

export interface AcceptanceBusinessPurgeDetails {
  businessCountsBefore: Record<string, number>;
  roomStatusRevisionBefore: string;
  roomStatusRevisionAfter: string;
}

export interface AcceptanceBusinessTruncationOptions {
  allowBlockedProtocolSharedWriters?: boolean;
  afterCommitBeforeVerificationForTesting?: () => Promise<void>;
}

export class AcceptanceBusinessPurgeCommittedVerificationError extends Error {
  readonly purgeCommitted = true;

  constructor(
    readonly purgeDetails: AcceptanceBusinessPurgeDetails,
    verificationError: unknown
  ) {
    super(
      "Acceptance business-data purge committed, but post-commit verification failed; stop all writers and verify the business tables before retrying",
      { cause: verificationError }
    );
    this.name = "AcceptanceBusinessPurgeCommittedVerificationError";
  }
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

export function assertQintopiaLocalTarget(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Database URL is invalid");
  }
  if (!(["postgres:", "postgresql:"] as string[]).includes(parsed.protocol)
    || parsed.hostname !== QINTOPIA_LOCAL_DATABASE.host
    || parsed.port !== QINTOPIA_LOCAL_DATABASE.port
    || databaseName(parsed) !== QINTOPIA_LOCAL_DATABASE.database
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error(
      `Refusing purge: target must be postgres://...@${QINTOPIA_LOCAL_DATABASE.host}:${QINTOPIA_LOCAL_DATABASE.port}/${QINTOPIA_LOCAL_DATABASE.database}`
    );
  }
  return parsed;
}

export function parsePurgeArguments(argv: readonly string[]): PurgeArguments {
  const execute = argv.includes("--execute");
  const confirmation = argv.find((argument) => argument.startsWith("--confirm-database="));
  return {
    execute,
    confirmedDatabase: confirmation?.slice("--confirm-database=".length) ?? null,
    writersStopped: argv.includes("--confirm-writers-stopped")
  };
}

export function assertPurgeExecutionAuthorized(arguments_: PurgeArguments): void {
  if (!arguments_.execute) return;
  if (arguments_.confirmedDatabase !== QINTOPIA_LOCAL_DATABASE.database || !arguments_.writersStopped) {
    throw new Error(
      `Executing the purge requires --execute, --confirm-database=${QINTOPIA_LOCAL_DATABASE.database}, and --confirm-writers-stopped`
    );
  }
}

async function countTable(db: Kysely<Database>, table: keyof Database): Promise<number> {
  const row = await db.selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function snapshotCounts(
  db: Kysely<Database>,
  tables: readonly (keyof Database)[]
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = await countTable(db, table);
  return counts;
}

export async function assertExpectedLocalDatabaseIdentity(db: Kysely<Database>): Promise<void> {
  const [properties, migrations] = await Promise.all([
    db.selectFrom("properties").select("id").orderBy("id").execute(),
    db.selectFrom("schema_migrations").select("name").orderBy("name").execute()
  ]);
  if (properties.length !== 1 || properties[0]?.id !== QINTOPIA_LOCAL_DATABASE.propertyId) {
    throw new Error(
      `Refusing purge: expected only property ${QINTOPIA_LOCAL_DATABASE.propertyId}, found ${properties.map((row) => row.id).join(", ") || "none"}`
    );
  }
  const migrationIdentityMatches = migrations.length === currentMigrationNames.length
    && migrations.every((migration, index) => migration.name === currentMigrationNames[index]);
  if (!migrationIdentityMatches) {
    throw new Error(
      `Refusing purge: migration identity must exactly match ${currentMigrationNames.join(", ")}`
    );
  }
}

export async function businessTableCounts(db: Kysely<Database>): Promise<Record<string, number>> {
  return snapshotCounts(db, acceptanceBusinessTables);
}

export async function assertBusinessTablesEmpty(db: Kysely<Database>): Promise<void> {
  const counts = await businessTableCounts(db);
  const nonEmpty = Object.entries(counts).filter(([, count]) => count !== 0);
  if (nonEmpty.length > 0) {
    throw new Error(`Business tables must be empty: ${nonEmpty.map(([table, count]) => `${table}=${count}`).join(", ")}`);
  }
}

export async function assertNoOtherDatabaseSessions(
  db: Kysely<Database>,
  options: Pick<AcceptanceBusinessTruncationOptions, "allowBlockedProtocolSharedWriters"> = {}
): Promise<void> {
  await sql`select pg_stat_clear_snapshot()`.execute(db);
  const sessions = await sql<{
    pid: number;
    backend_type: string;
    application_name: string;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    blocked_protocol_shared_writer: boolean;
  }>`
    select
      activity.pid::integer as pid,
      activity.backend_type,
      activity.application_name,
      activity.state,
      activity.wait_event_type,
      activity.wait_event,
      (
        activity.wait_event_type = 'Lock'
        and activity.wait_event = 'advisory'
        and pg_backend_pid() = any(pg_blocking_pids(activity.pid))
        and exists (
          select 1
          from pg_locks as waiting_lock
          where waiting_lock.pid = activity.pid
            and waiting_lock.locktype = 'advisory'
            and waiting_lock.mode = 'ShareLock'
            and not waiting_lock.granted
        )
      ) as blocked_protocol_shared_writer
    from pg_stat_activity as activity
    where activity.datname = current_database()
      and activity.pid <> pg_backend_pid()
      and activity.backend_type not in ('autovacuum worker', 'parallel worker')
  `.execute(db);
  const unsafeSessions = options.allowBlockedProtocolSharedWriters
    ? sessions.rows.filter((session) => !session.blocked_protocol_shared_writer)
    : sessions.rows;
  if (unsafeSessions.length > 0) {
    throw new Error(
      `Refusing purge: database still has ${unsafeSessions.length} other session${unsafeSessions.length === 1 ? "" : "s"} (${unsafeSessions.map((session) => (
        `${session.pid}:${session.backend_type}:${session.application_name || "unnamed"}:${session.state ?? "unknown"}:${session.wait_event_type ?? "none"}/${session.wait_event ?? "none"}`
      )).join(", ")}); stop all writers and database clients before retrying`
    );
  }
}

export async function withExclusiveAcceptanceWriterGate<T>(
  db: Kysely<Database>,
  operation: (connection: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.connection().execute(async (connection) => {
    await sql`
      select pg_advisory_lock(
        hashtextextended('qintopia:protocol-epoch', 0::bigint)
      )
    `.execute(connection);
    try {
      return await operation(connection);
    } finally {
      const released = await sql<{ unlocked: boolean }>`
        select pg_advisory_unlock(
          hashtextextended('qintopia:protocol-epoch', 0::bigint)
        ) as unlocked
      `.execute(connection);
      if (released.rows[0]?.unlocked !== true) {
        throw new Error("Acceptance writer gate was not held by the locked database connection");
      }
    }
  });
}

async function acquireAcceptancePurgeLocks(db: Kysely<Database>): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended('qintopia:protocol-epoch', 0::bigint)
    )
  `.execute(db);

  const quotedTables = acceptanceBusinessTables.map((table) => `"${table}"`).join(", ");
  await sql.raw(`LOCK TABLE ${quotedTables} IN ACCESS EXCLUSIVE MODE`).execute(db);
}

async function verifyAcceptanceBusinessDataRemainsEmpty(
  db: Kysely<Database>,
  options: AcceptanceBusinessTruncationOptions
): Promise<void> {
  await assertNoOtherDatabaseSessions(db, options);
  await db.transaction().execute(async (trx) => {
    await assertNoOtherDatabaseSessions(trx, options);
    await acquireAcceptancePurgeLocks(trx);
    await assertNoOtherDatabaseSessions(trx, options);
    await assertBusinessTablesEmpty(trx);
    await assertNoOtherDatabaseSessions(trx, options);
  });
  await assertNoOtherDatabaseSessions(db, options);
  await assertBusinessTablesEmpty(db);
  await assertNoOtherDatabaseSessions(db, options);
}

export async function truncateAcceptanceBusinessDataWithinExclusiveGate(
  db: Kysely<Database>,
  expectedOnlyPropertyId: string,
  options: AcceptanceBusinessTruncationOptions = {}
): Promise<AcceptanceBusinessPurgeDetails> {
  if (expectedOnlyPropertyId !== QINTOPIA_LOCAL_DATABASE.propertyId) {
    throw new Error(`Business truncation requires the single expected property ${expectedOnlyPropertyId}`);
  }
  if (options.afterCommitBeforeVerificationForTesting && process.env.NODE_ENV !== "test") {
    throw new Error("The post-commit verification hook is available only while running tests");
  }

  await assertNoOtherDatabaseSessions(db, options);
  const result = await db.transaction().execute(async (trx) => {
    await assertNoOtherDatabaseSessions(trx, options);
    await acquireAcceptancePurgeLocks(trx);
    await assertNoOtherDatabaseSessions(trx, options);
    await assertExpectedLocalDatabaseIdentity(trx);

    const quotedTables = acceptanceBusinessTables.map((table) => `"${table}"`).join(", ");
    const baseCountsBefore = await snapshotCounts(trx, preservedBaseTables);
    const businessCountsBefore = await businessTableCounts(trx);
    const revisionBefore = await trx.selectFrom("room_status_revisions")
      .select("revision")
      .where("property_id", "=", QINTOPIA_LOCAL_DATABASE.propertyId)
      .executeTakeFirstOrThrow();

    await sql.raw(`TRUNCATE TABLE ${quotedTables}`).execute(trx);
    const revisionAfter = await trx.updateTable("room_status_revisions")
      .set({
        revision: sql`room_status_revisions.revision + 1`,
        updated_at: new Date()
      })
      .where("property_id", "=", QINTOPIA_LOCAL_DATABASE.propertyId)
      .returning("revision")
      .executeTakeFirstOrThrow();

    const baseCountsAfter = await snapshotCounts(trx, preservedBaseTables);
    const businessCountsAfter = await businessTableCounts(trx);
    for (const table of preservedBaseTables) {
      if (baseCountsAfter[table] !== baseCountsBefore[table]) {
        throw new Error(`Base table ${table} changed during purge`);
      }
    }
    const remaining = Object.entries(businessCountsAfter).filter(([, count]) => count !== 0);
    if (remaining.length > 0) {
      throw new Error(`Business purge verification failed: ${remaining.map(([table, count]) => `${table}=${count}`).join(", ")}`);
    }
    const expectedRevision = BigInt(String(revisionBefore.revision)) + 1n;
    if (BigInt(String(revisionAfter.revision)) !== expectedRevision) {
      throw new Error("Room-status revision did not advance exactly once");
    }
    await assertNoOtherDatabaseSessions(trx, options);
    return {
      businessCountsBefore,
      roomStatusRevisionBefore: String(revisionBefore.revision),
      roomStatusRevisionAfter: String(revisionAfter.revision)
    };
  });

  try {
    await options.afterCommitBeforeVerificationForTesting?.();
    await verifyAcceptanceBusinessDataRemainsEmpty(db, options);
  } catch (verificationError) {
    throw new AcceptanceBusinessPurgeCommittedVerificationError(result, verificationError);
  }
  return result;
}

async function truncateAcceptanceBusinessData(
  db: Kysely<Database>,
  expectedOnlyPropertyId: string
): Promise<AcceptanceBusinessPurgeDetails> {
  return withExclusiveAcceptanceWriterGate(db, (connection) => (
    truncateAcceptanceBusinessDataWithinExclusiveGate(connection, expectedOnlyPropertyId)
  ));
}

function assertIsolatedAcceptanceTarget(databaseUrl: string): URL {
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error("Isolated acceptance database URL is invalid");
  }
  const database = databaseName(target);
  const allowedDatabase = database === "qintopia_e2e"
    || /^qintopia_purge_acceptance_[0-9]+$/.test(database);
  const queryKeys = [...target.searchParams.keys()];
  const allowedQuery = queryKeys.every((key) => key === "application_name")
    && target.searchParams.getAll("application_name").length <= 1;
  if (!(["postgres:", "postgresql:"] as string[]).includes(target.protocol)
    || target.hostname !== QINTOPIA_LOCAL_DATABASE.host
    || target.port !== QINTOPIA_LOCAL_DATABASE.port
    || database === QINTOPIA_LOCAL_DATABASE.database
    || !allowedDatabase
    || !allowedQuery
    || target.hash !== "") {
    throw new Error(
      "Refusing isolated acceptance purge: target must be the exact local qintopia_e2e or qintopia_purge_acceptance_<pid> database, never qintopia"
    );
  }
  return target;
}

export async function withPurgedIsolatedAcceptanceDatabase<T>(
  databaseUrl: string,
  expectedOnlyPropertyId: string,
  plan: {
    prepare?: () => Promise<void>;
    initialize?: (connection: Kysely<Database>) => Promise<void>;
    run: (
      connection: Kysely<Database>,
      initialPurge: AcceptanceBusinessPurgeDetails
    ) => Promise<T>;
  }
): Promise<T> {
  const target = assertIsolatedAcceptanceTarget(databaseUrl);
  const db = createDatabase(target.toString());
  try {
    return await withExclusiveAcceptanceWriterGate(db, async (connection) => {
      if (plan.prepare) await plan.prepare();
      if (plan.initialize) await plan.initialize(connection);
      const initialPurge = await truncateAcceptanceBusinessDataWithinExclusiveGate(connection, expectedOnlyPropertyId);
      try {
        return await plan.run(connection, initialPurge);
      } catch (operationError) {
        try {
          await truncateAcceptanceBusinessDataWithinExclusiveGate(connection, expectedOnlyPropertyId);
        } catch (cleanupError) {
          throw new AggregateError(
            [operationError, cleanupError],
            "Isolated acceptance operation failed and its business-data cleanup also failed"
          );
        }
        throw operationError;
      }
    });
  } finally {
    await db.destroy();
  }
}

export async function purgeLocalAcceptanceBusinessData(
  databaseUrl: string,
  arguments_: PurgeArguments
): Promise<PurgeResult> {
  const target = assertQintopiaLocalTarget(databaseUrl);
  assertPurgeExecutionAuthorized(arguments_);
  const db = createDatabase(target.toString());
  try {
    if (arguments_.execute) {
      const result = await truncateAcceptanceBusinessData(db, QINTOPIA_LOCAL_DATABASE.propertyId);
      return {
        mode: "executed",
        database: databaseName(target),
        propertyId: QINTOPIA_LOCAL_DATABASE.propertyId,
        migrationCount: QINTOPIA_LOCAL_DATABASE.migrationCount,
        ...result
      };
    }

    await assertExpectedLocalDatabaseIdentity(db);
    const businessCountsBefore = await businessTableCounts(db);
    const revision = await db.selectFrom("room_status_revisions")
      .select("revision")
      .where("property_id", "=", QINTOPIA_LOCAL_DATABASE.propertyId)
      .executeTakeFirstOrThrow();
    return {
      mode: "dry-run",
      database: databaseName(target),
      propertyId: QINTOPIA_LOCAL_DATABASE.propertyId,
      migrationCount: QINTOPIA_LOCAL_DATABASE.migrationCount,
      businessCountsBefore,
      roomStatusRevisionBefore: String(revision.revision),
      roomStatusRevisionAfter: String(revision.revision)
    };
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.PURGE_LOCAL_ACCEPTANCE_DATABASE_URL
    ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
  const result = await purgeLocalAcceptanceBusinessData(databaseUrl, parsePurgeArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.mode === "dry-run") {
    process.stdout.write(
      `Dry run only. Stop all writers, then execute with --execute --confirm-database=${QINTOPIA_LOCAL_DATABASE.database} --confirm-writers-stopped after reviewing the counts.\n`
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
