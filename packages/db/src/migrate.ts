import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "./database.ts";

const migrationsDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl() });

function sameMigrationSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
}

await client.connect();
let transactionOpen = false;
let migrationLockHeld = false;
let protocolEpochLockHeld = false;
try {
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
    names_by_applied_at: string[];
    has_null_applied_at: boolean;
    applied_at_not_future: boolean;
  }>(`
    SELECT
      COALESCE(array_agg(name ORDER BY name), ARRAY[]::text[]) AS names_by_name,
      COALESCE(array_agg(name ORDER BY applied_at, name), ARRAY[]::text[]) AS names_by_applied_at,
      COALESCE(bool_or(applied_at IS NULL), false) AS has_null_applied_at,
      COALESCE(max(applied_at) <= statement_timestamp(), true) AS applied_at_not_future
    FROM schema_migrations
  `);
  const history = recordedHistory.rows[0];
  const namesByName = history?.names_by_name ?? [];
  const namesByAppliedAt = history?.names_by_applied_at ?? [];
  const expectedPrefix = migrationNames.slice(0, namesByName.length);
  if (!sameMigrationSequence(namesByName, expectedPrefix)
    || !sameMigrationSequence(namesByAppliedAt, expectedPrefix)
    || history?.has_null_applied_at !== false
    || history?.applied_at_not_future !== true) {
    throw new Error(
      "Refusing migration: schema_migrations must be an exact ordered prefix with non-null, non-future applied_at values"
    );
  }

  for (const migrationName of migrationNames) {
    if (migrationName === "028_stage11_move_unit_guards.sql") {
      await client.query("SELECT pg_advisory_lock(hashtextextended('qintopia:protocol-epoch', 0))");
      protocolEpochLockHeld = true;
    }
    await client.query("BEGIN");
    transactionOpen = true;
    try {
      const applied = await client.query<{ name: string }>("SELECT name FROM schema_migrations WHERE name = $1", [migrationName]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(`${migrationsDirectory}/${migrationName}`, "utf8"));
        const inserted = await client.query<{ name: string }>(`
          WITH migration_time AS (
            SELECT statement_timestamp() AS applied_at
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
        `, [migrationName]);
        if (inserted.rowCount !== 1) {
          throw new Error(
            "Refusing migration: the database clock would make schema_migrations.applied_at non-monotonic"
          );
        }
      }
      await client.query("COMMIT");
      transactionOpen = false;
      process.stdout.write(applied.rowCount === 0 ? `Applied ${migrationName}\n` : `${migrationName} already applied\n`);
      if (protocolEpochLockHeld) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:protocol-epoch', 0))");
        protocolEpochLockHeld = false;
      }
    } catch (error) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      throw error;
    }
  }
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK");
  throw error;
} finally {
  if (protocolEpochLockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:protocol-epoch', 0))");
  if (migrationLockHeld) await client.query("SELECT pg_advisory_unlock(hashtextextended('qintopia:migrate', 0))");
  await client.end();
}
