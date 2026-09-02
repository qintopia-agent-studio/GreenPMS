import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "./database.ts";
import { resolveStaffProfileManifest } from "./staff-profile-manifest.ts";

const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
const appliedAtClockSkewTolerance = "5 seconds";

const migrationPgFields = [
  "MIGRATION_PGHOST",
  "MIGRATION_PGPORT",
  "MIGRATION_PGDATABASE",
  "MIGRATION_PGUSER",
  "MIGRATION_PGPASSWORD"
] as const;

function hasMigrationPgConfiguration(): boolean {
  return migrationPgFields.some((name) => process.env[name]?.length);
}

function migrationPgDatabaseUrl(): string | undefined {
  if (!hasMigrationPgConfiguration()) return undefined;
  const missing = migrationPgFields.filter((name) => !process.env[name]?.length);
  if (missing.length > 0) {
    throw new Error(`Incomplete migration database configuration; missing ${missing.join(", ")}`);
  }

  const url = new URL("postgres://127.0.0.1");
  url.hostname = process.env.MIGRATION_PGHOST!;
  url.port = process.env.MIGRATION_PGPORT!;
  url.pathname = `/${process.env.MIGRATION_PGDATABASE!}`;
  url.username = process.env.MIGRATION_PGUSER!;
  url.password = process.env.MIGRATION_PGPASSWORD!;
  return url.toString();
}

function migrationDatabaseUrl(): string {
  return process.env.MIGRATION_DATABASE_URL?.trim() || migrationPgDatabaseUrl() || databaseUrl();
}

function connectionUsername(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).username || undefined;
  } catch {
    return undefined;
  }
}

function assertConfiguredOwnerIsSeparateFromRuntime(ownerUrl: string): void {
  const ownerConfigured = Boolean(process.env.MIGRATION_DATABASE_URL?.trim()) || hasMigrationPgConfiguration();
  if (!ownerConfigured) return;
  const runtimeConfigured = Boolean(process.env.DATABASE_URL?.trim())
    || process.env.PGUSER !== undefined
    || process.env.PGPASSWORD !== undefined
    || process.env.PGHOST !== undefined
    || process.env.PGPORT !== undefined
    || process.env.PGDATABASE !== undefined;
  if (!runtimeConfigured) return;

  const runtimeUrl = process.env.DATABASE_URL?.trim() || databaseUrl();
  if (ownerUrl === runtimeUrl) {
    throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL must use separate database identities");
  }
  const ownerUser = connectionUsername(ownerUrl);
  const runtimeUser = connectionUsername(runtimeUrl);
  if (ownerUser && runtimeUser && ownerUser === runtimeUser) {
    throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL must use different database users");
  }
}

async function configureRuntimePasswordIfRequested(client: pg.Client): Promise<void> {
  if (process.env.RUNTIME_DATABASE_PASSWORD === undefined) return;
  if (process.env.RUNTIME_DATABASE_PASSWORD.length === 0) {
    throw new Error("RUNTIME_DATABASE_PASSWORD must not be empty when configured");
  }
  const runtimeRole = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    ["qintopia_runtime"]
  );
  if (runtimeRole.rowCount !== 1) {
    throw new Error("RUNTIME_DATABASE_PASSWORD was configured but qintopia_runtime does not exist");
  }
  const quotedPassword = await client.query<{ password_literal: string }>(
    "SELECT quote_literal($1) AS password_literal",
    [process.env.RUNTIME_DATABASE_PASSWORD]
  );
  const passwordLiteral = quotedPassword.rows[0]?.password_literal;
  if (!passwordLiteral) throw new Error("Could not quote RUNTIME_DATABASE_PASSWORD");
  await client.query(`ALTER ROLE qintopia_runtime WITH PASSWORD ${passwordLiteral}`);
}

async function assertDirectMigrationOwner(client: pg.Client): Promise<void> {
  const identity = await client.query<{
    current_user: string;
    session_user: string;
    database_owner: string;
  }>(`
    SELECT current_user,
      session_user,
      pg_get_userbyid(database_row.datdba) AS database_owner
    FROM pg_database AS database_row
    WHERE database_row.datname = current_database()
  `);
  const row = identity.rows[0];
  if (!row
    || row.current_user !== row.session_user
    || row.current_user !== row.database_owner
    || row.current_user === "qintopia_runtime") {
    throw new Error(
      "Database migrations require the direct database-owner identity and must never run as or SET ROLE to qintopia_runtime"
    );
  }
}

async function reconcileReviewedStaffProfiles(client: pg.Client): Promise<void> {
  const manifest = resolveStaffProfileManifest(process.env.STAFF_PROFILE_MANIFEST_NAME);
  await client.query(
    "SELECT qintopia_reconcile_staff_profile_manifest($1, $2::jsonb)",
    [manifest.name, JSON.stringify(manifest.entries)]
  );
  process.stdout.write(`Reconciled reviewed staff profile manifest ${manifest.name}\n`);
}

const ownerUrl = migrationDatabaseUrl();
assertConfiguredOwnerIsSeparateFromRuntime(ownerUrl);
const client = new pg.Client({ connectionString: ownerUrl });

function sameMigrationSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
}

await client.connect();
let transactionOpen = false;
let migrationLockHeld = false;
let protocolEpochLockHeld = false;
let holdProtocolEpochThroughReconciliation = false;
try {
  await assertDirectMigrationOwner(client);
  await client.query("SELECT pg_advisory_lock(hashtextextended('qintopia:migrate', 0))");
  migrationLockHeld = true;

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  await client.query("COMMIT");
  transactionOpen = false;

  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const recordedHistory = await client.query<{
    names_by_name: string[];
    has_null_applied_at: boolean;
    applied_at_not_future: boolean;
    applied_at_not_reordered: boolean;
  }>(`
    WITH ordered_migrations AS (
      SELECT name,
        applied_at,
        lag(applied_at) OVER (ORDER BY name) AS previous_applied_at
      FROM schema_migrations
    )
    SELECT
      COALESCE(array_agg(name ORDER BY name), ARRAY[]::text[]) AS names_by_name,
      COALESCE(bool_or(applied_at IS NULL), false) AS has_null_applied_at,
      COALESCE(max(applied_at) <= statement_timestamp() + $1::interval, true) AS applied_at_not_future,
      COALESCE(bool_and(
        previous_applied_at IS NULL
          OR previous_applied_at <= applied_at + $1::interval
      ), true) AS applied_at_not_reordered
    FROM ordered_migrations
  `, [appliedAtClockSkewTolerance]);
  const history = recordedHistory.rows[0];
  const namesByName = history?.names_by_name ?? [];
  const expectedPrefix = migrationNames.slice(0, namesByName.length);
  if (!sameMigrationSequence(namesByName, expectedPrefix)
    || history?.has_null_applied_at !== false
    || history?.applied_at_not_future !== true
    || history?.applied_at_not_reordered !== true) {
    throw new Error(
      "Refusing migration: schema_migrations must be an exact ordered prefix with non-null, non-future applied_at values"
    );
  }

  for (const migrationName of migrationNames) {
    if (migrationName === "028_stage11_move_unit_guards.sql"
      || migrationName === "044_inhouse_membership_fulfillment_guards.sql"
      || migrationName === "046_command_authorization.sql") {
      await client.query("SELECT pg_advisory_lock(hashtextextended('qintopia:protocol-epoch', 0))");
      protocolEpochLockHeld = true;
      if (migrationName === "046_command_authorization.sql") {
        holdProtocolEpochThroughReconciliation = true;
      }
    }
    await client.query("BEGIN");
    transactionOpen = true;
    try {
      const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations WHERE name = $1", [migrationName]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(`${migrationsDirectory}/${migrationName}`, "utf8"));
        const inserted = await client.query<{ name: string }>(`
          WITH latest_migration AS (
            SELECT max(applied_at) AS applied_at
            FROM schema_migrations
          ),
          migration_time AS (
            SELECT CASE
              WHEN latest_migration.applied_at > statement_timestamp()
                AND latest_migration.applied_at <= statement_timestamp() + $2::interval
                THEN latest_migration.applied_at
              ELSE statement_timestamp()
            END AS applied_at
            FROM latest_migration
          )
          INSERT INTO schema_migrations(name, applied_at)
          SELECT $1, migration_time.applied_at
          FROM migration_time
          WHERE NOT EXISTS (
              SELECT 1 FROM schema_migrations WHERE applied_at IS NULL
            )
            AND COALESCE((
              SELECT max(applied_at) <= migration_time.applied_at
              FROM schema_migrations
            ), true)
          RETURNING name
        `, [migrationName, appliedAtClockSkewTolerance]);
        if (inserted.rowCount !== 1) {
          throw new Error(
            "Refusing migration: the database clock would make schema_migrations.applied_at non-monotonic"
          );
        }
      }
      await client.query("COMMIT");
      transactionOpen = false;
      process.stdout.write(applied.rowCount === 0 ? `Applied ${migrationName}\n` : `${migrationName} already applied\n`);
      if (protocolEpochLockHeld && !holdProtocolEpochThroughReconciliation) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:protocol-epoch', 0))");
        protocolEpochLockHeld = false;
      }
    } catch (error) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      throw error;
    }
  }
  await configureRuntimePasswordIfRequested(client);
  await reconcileReviewedStaffProfiles(client);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK");
  throw error;
} finally {
  if (protocolEpochLockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:protocol-epoch', 0))");
  if (migrationLockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:migrate', 0))");
  await client.end();
}
