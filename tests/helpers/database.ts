import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { createDatabase, type Database } from "@qintopia/db";
import { seedDemo } from "../../packages/db/src/seed.ts";
import type { Kysely } from "kysely";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_test";

export async function resetDatabase(databaseUrl: string): Promise<Kysely<Database>> {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    let activeSessions = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName]
      );
      activeSessions = Number(result.rows[0]?.count ?? 0);
      if (activeSessions === 0) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    if (activeSessions > 0) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    }
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const directory = resolve(process.cwd(), "packages/db/src/migrations");
    const migrations = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const migration of migrations) {
      await client.query(await readFile(resolve(directory, migration), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [migration]);
    }
  } finally {
    await client.end();
  }
  const db = createDatabase(databaseUrl);
  await seedDemo(db, { includeProtocolFixturePolicy: true });
  return db;
}

export async function resetTestDatabase(): Promise<Kysely<Database>> {
  return resetDatabase(testDatabaseUrl);
}
