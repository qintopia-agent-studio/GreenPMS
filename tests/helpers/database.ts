import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { createDatabase, type Database } from "@qintopia/db";
import { seedDemo } from "../../packages/db/src/seed.ts";
import type { Kysely } from "kysely";
import { runtimeDatabaseTestPassword } from "./runtime-database.ts";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_test";

async function migrateAndSeedDatabase(databaseUrl: string): Promise<Kysely<Database>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const directory = resolve(process.cwd(), "packages/db/src/migrations");
    const migrations = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const migration of migrations) {
      await client.query(await readFile(resolve(directory, migration), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [migration]);
    }
    const password = await client.query<{ literal: string }>(
      "SELECT quote_literal($1) AS literal",
      [runtimeDatabaseTestPassword]
    );
    await client.query(`ALTER ROLE qintopia_runtime PASSWORD ${password.rows[0]!.literal}`);
  } finally {
    await client.end();
  }
  const db = createDatabase(databaseUrl);
  await seedDemo(db, { includeProtocolFixturePolicy: true });
  return db;
}

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
  return migrateAndSeedDatabase(databaseUrl);
}

export async function resetDatabaseInPlace(databaseUrl: string): Promise<Kysely<Database>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  return migrateAndSeedDatabase(databaseUrl);
}

export async function resetTestDatabase(): Promise<Kysely<Database>> {
  return resetDatabase(testDatabaseUrl);
}
