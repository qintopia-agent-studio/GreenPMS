import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, databaseReady, getRoomStatusBoard, listAvailability } from "@qintopia/db";
import { demo, seedDemo } from "../../packages/db/src/seed.ts";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.MIGRATION_CONCURRENCY_ADMIN_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
const databaseName = `qintopia_migration_concurrency_${process.pid}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

async function dropDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function recreateDatabase(): Promise<void> {
  await dropDatabase();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

function runMigration() {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", "packages/db/src/migrate.ts"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl.toString() } }
  );
}

beforeAll(async () => {
  await recreateDatabase();
});

afterAll(dropDatabase);

describe("database migration concurrency", () => {
  it("serializes two fresh-database migrators and applies every migration once", async () => {
    const outcomes = await Promise.allSettled([runMigration(), runMigration()]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);

    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      const expectedMigrations = (await readdir("packages/db/src/migrations"))
        .filter((name) => /^\d+.*\.sql$/.test(name))
        .sort();
      const rows = await client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      expect(rows.rows.map((row) => row.name)).toEqual(expectedMigrations);
      expect(expectedMigrations).toHaveLength(28);
      expect(expectedMigrations).toContain("015_generated_room_operational_codes.sql");
      expect(expectedMigrations).toContain("016_member_property_links.sql");
      expect(expectedMigrations).toContain("017_membership_orders.sql");
      expect(expectedMigrations).toContain("018_member_stay_identity_and_coverage_guards.sql");
      expect(expectedMigrations).toContain("019_member_stay_booking_channel_rules.sql");
      expect(expectedMigrations).toContain("020_whole_room_occupants.sql");
      expect(expectedMigrations).toContain("021_defer_internal_use.sql");
      expect(expectedMigrations).toContain("022_order_occupant_corrections.sql");
      expect(expectedMigrations).toContain("023_collection_fact_pricing_revision.sql");
      expect(expectedMigrations).toContain("024_free_stay_category_code.sql");
      expect(expectedMigrations).toContain("025_channel_order_atomic_pricing.sql");
      expect(expectedMigrations).toContain("026_stage9_stay_change_guards.sql");
      expect(expectedMigrations).toContain("027_stage10_stay_shortening_guards.sql");
      expect(expectedMigrations).toContain("028_stage11_move_unit_guards.sql");

      const readyDatabase = createDatabase(databaseUrl.toString());
      try {
        expect(await databaseReady(readyDatabase)).toBe(true);
        await client.query(`
          CREATE OR REPLACE FUNCTION qintopia_assert_stage11_move_combination(target_command_id text)
          RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$
        `);
        expect(await databaseReady(readyDatabase)).toBe(false);
      } finally {
        await readyDatabase.destroy();
      }
    } finally {
      await client.end();
    }
  });

  it("upgrades a populated revision-010 database with a historical maintenance lock longer than 90 nights", async () => {
    await recreateDatabase();
    const migrationNames = (await readdir("packages/db/src/migrations"))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      for (const migrationName of migrationNames.slice(0, 10)) {
        await client.query(await readFile(`packages/db/src/migrations/${migrationName}`, "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [migrationName]);
      }
    } finally {
      await client.end();
    }

    const seeded = createDatabase(databaseUrl.toString());
    try {
      await seedDemo(seeded);
    } finally {
      await seeded.destroy();
    }

    let historicalFactsBefore: { contracts: number; lots: number; ledger: number } | undefined;
    const legacy = new pg.Client({ connectionString: databaseUrl.toString() });
    await legacy.connect();
    try {
      await legacy.query("ALTER TABLE inventory_units DISABLE TRIGGER inventory_units_protect_identity");
      await legacy.query(`
        UPDATE inventory_units
        SET name = CASE id
              WHEN 'unit_room_101' THEN 'Room 101'
              WHEN 'unit_room_102' THEN 'Room 102'
              WHEN 'unit_room_101_bed_a' THEN 'Room 101 / Bed A'
              WHEN 'unit_room_101_bed_b' THEN 'Room 101 / Bed B'
            END,
            catalog_version = NULL,
            building_code = NULL,
            room_type_code = NULL,
            pricing_product_code = NULL,
            inventory_basis = NULL,
            code_provenance = NULL,
            physical_bed_count = NULL
        WHERE id IN ('unit_room_101', 'unit_room_102', 'unit_room_101_bed_a', 'unit_room_101_bed_b')
      `);
      await legacy.query("ALTER TABLE inventory_units ENABLE TRIGGER inventory_units_protect_identity");
      await legacy.query(`
        INSERT INTO maintenance_locks (
          id, property_id, inventory_unit_id, arrival_date, departure_date, reason, status, version, released_at
        ) VALUES (
          'maint_legacy_long_interval', 'prop_qintopia_demo', 'unit_room_102',
          '2030-01-01', '2030-07-01', 'Historical long maintenance interval', 'ACTIVE', 1, NULL
        )
      `);
      await legacy.query(`
        INSERT INTO members (id, identity_card_number, full_name, phone, wechat)
        VALUES ('member_external_only_legacy', 'EXTERNAL-ONLY-LEGACY', 'External only legacy', '13900009991', 'external-only-legacy')
      `);
      await legacy.query(`
        INSERT INTO member_external_references (
          id, member_id, property_id, provider, source_container_id, source_table_id, external_record_id
        ) VALUES (
          'memberref_external_only_legacy', 'member_external_only_legacy', 'prop_qintopia_demo',
          'FEISHU_BASE', 'legacy-container', 'legacy-table', 'legacy-external-only-record'
        )
      `);
      historicalFactsBefore = (await legacy.query<{ contracts: number; lots: number; ledger: number }>(`
        SELECT
          (SELECT count(*)::int FROM member_contracts) AS contracts,
          (SELECT count(*)::int FROM entitlement_lots) AS lots,
          (SELECT count(*)::int FROM entitlement_ledger) AS ledger
      `)).rows[0];
    } finally {
      await legacy.end();
    }

    const outcome = await runMigration();
    expect(outcome.stderr).toBe("");

    const upgraded = new pg.Client({ connectionString: databaseUrl.toString() });
    await upgraded.connect();
    try {
      const rows = await upgraded.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      expect(rows.rows.map((row) => row.name)).toEqual(migrationNames);
      const catalog = await upgraded.query<{ catalog_version: string | null }>(
        "SELECT catalog_version FROM inventory_units WHERE id = 'unit_room_101'"
      );
      expect(catalog.rows[0]?.catalog_version).not.toBeNull();
      expect((await upgraded.query("SELECT 1 FROM room_status_revisions LIMIT 1")).rowCount).toBe(1);
      const memberLinks = await upgraded.query<{ member_id: string; property_id: string }>(
        "SELECT member_id, property_id FROM member_property_links WHERE member_id = $1 AND property_id = $2",
        [demo.memberId, demo.propertyId]
      );
      expect(memberLinks.rows).toEqual([{ member_id: demo.memberId, property_id: demo.propertyId }]);
      const externalOnlyLinks = await upgraded.query<{ member_id: string; property_id: string }>(
        "SELECT member_id, property_id FROM member_property_links WHERE member_id = 'member_external_only_legacy'"
      );
      expect(externalOnlyLinks.rows).toEqual([{ member_id: "member_external_only_legacy", property_id: demo.propertyId }]);
      const historicalFactsAfter = (await upgraded.query<{ contracts: number; lots: number; ledger: number }>(`
        SELECT
          (SELECT count(*)::int FROM member_contracts) AS contracts,
          (SELECT count(*)::int FROM entitlement_lots) AS lots,
          (SELECT count(*)::int FROM entitlement_ledger) AS ledger
      `)).rows[0];
      expect(historicalFactsAfter).toEqual(historicalFactsBefore);

      await upgraded.query(`
        INSERT INTO members (id, identity_card_number, full_name, phone, wechat) VALUES
          ('member_contract_during_cutover', 'CONTRACT-DURING-CUTOVER', 'Contract cutover', '13900009992', 'contract-cutover'),
          ('member_reference_during_cutover', 'REFERENCE-DURING-CUTOVER', 'Reference cutover', '13900009993', 'reference-cutover')
      `);
      await upgraded.query(`
        INSERT INTO member_contracts (
          id, property_id, member_id, member_name, status, valid_from, valid_until, version
        ) VALUES (
          'contract_during_cutover', 'prop_qintopia_demo', 'member_contract_during_cutover',
          'Contract cutover', 'ACTIVE', '2026-01-01', '2026-12-31', 1
        )
      `);
      await upgraded.query(`
        INSERT INTO member_external_references (
          id, member_id, property_id, provider, source_container_id, source_table_id, external_record_id
        ) VALUES (
          'memberref_during_cutover', 'member_reference_during_cutover', 'prop_qintopia_demo',
          'FEISHU_BASE', 'cutover-container', 'cutover-table', 'cutover-record'
        )
      `);
      const cutoverLinks = await upgraded.query<{ member_id: string }>(`
        SELECT member_id FROM member_property_links
        WHERE member_id IN ('member_contract_during_cutover', 'member_reference_during_cutover')
        ORDER BY member_id
      `);
      expect(cutoverLinks.rows).toEqual([
        { member_id: "member_contract_during_cutover" },
        { member_id: "member_reference_during_cutover" }
      ]);
      const longMaintenance = await upgraded.query<{ nights: number }>(
        "SELECT departure_date - arrival_date AS nights FROM maintenance_locks WHERE id = 'maint_legacy_long_interval'"
      );
      expect(longMaintenance.rows[0]?.nights).toBeGreaterThan(90);
    } finally {
      await upgraded.end();
    }
  });

  it("preserves historical internal-use rows while migration 021 rejects every new Block and Claim", async () => {
    await recreateDatabase();
    const migrationNames = (await readdir("packages/db/src/migrations"))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      for (const migrationName of migrationNames.slice(0, 20)) {
        await client.query(await readFile(`packages/db/src/migrations/${migrationName}`, "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [migrationName]);
      }

      const seeded = createDatabase(databaseUrl.toString());
      try {
        await seedDemo(seeded);
      } finally {
        await seeded.destroy();
      }

      await client.query(`
        INSERT INTO command_executions(
          id, subject_id, credential_id, property_id, command_type,
          idempotency_key, request_hash, correlation_id, state, completed_at
        ) VALUES (
          'command_historical_internal_use', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}',
          'PLACE_INTERNAL_USE', 'historical-internal-use', repeat('a', 64), 'historical-internal-use', 'APPLIED', now()
        );
        INSERT INTO internal_use_blocks(
          id, property_id, inventory_unit_id, room_id, arrival_date, departure_date,
          reason, status, version, created_by_command_id, released_by_command_id, released_at
        ) VALUES (
          'block_historical_internal_use', '${demo.propertyId}', '${demo.bedAId}', '${demo.roomId}',
          '2030-01-01', '2030-01-03', 'Historical internal-use fact', 'ACTIVE', 1,
          'command_historical_internal_use', NULL, NULL
        );
        INSERT INTO inventory_claims(
          id, property_id, room_id, inventory_unit_id, service_date,
          source_type, source_id, active, released_at
        ) VALUES (
          'claim_historical_internal_use', '${demo.propertyId}', '${demo.roomId}', '${demo.bedAId}',
          '2030-01-01', 'INTERNAL_USE', 'block_historical_internal_use', true, NULL
        );
      `);
      const before = await client.query(`
        SELECT block.id, block.status, block.version, block.reason,
               claim.id AS claim_id, claim.active, claim.released_at
        FROM internal_use_blocks AS block
        JOIN inventory_claims AS claim
          ON claim.source_type = 'INTERNAL_USE' AND claim.source_id = block.id
        WHERE block.id = 'block_historical_internal_use'
      `);

      const migration021 = await readFile("packages/db/src/migrations/021_defer_internal_use.sql", "utf8");
      await client.query(migration021);
      await client.query("INSERT INTO schema_migrations(name) VALUES ('021_defer_internal_use.sql')");

      expect((await client.query(`
        SELECT block.id, block.status, block.version, block.reason,
               claim.id AS claim_id, claim.active, claim.released_at
        FROM internal_use_blocks AS block
        JOIN inventory_claims AS claim
          ON claim.source_type = 'INTERNAL_USE' AND claim.source_id = block.id
        WHERE block.id = 'block_historical_internal_use'
      `)).rows).toEqual(before.rows);

      const projectedDb = createDatabase(databaseUrl.toString());
      try {
        const board = await getRoomStatusBoard(projectedDb, {
          propertyId: demo.propertyId,
          arrivalDate: "2030-01-01",
          departureDate: "2030-01-03",
          accessLevel: "READ",
          requestingSubjectId: demo.agentSubjectId
        });
        const legacyInterval = board.rooms
          .flatMap((room) => [room, ...room.children])
          .flatMap((unit) => unit.intervals)
          .find((interval) => interval.actualInventoryUnitId === demo.bedAId
            && interval.startDate === "2030-01-01"
            && interval.sourceKind === "UNIT_UNSELLABLE");
        expect(legacyInterval).toMatchObject({
          sourceKind: "UNIT_UNSELLABLE",
          status: "UNKNOWN",
          reason: null,
          claimIds: [],
          allowedActions: []
        });
        expect(JSON.stringify(legacyInterval)).not.toMatch(/INTERNAL_USE|内部占用|internal use/i);
        const secondDay = board.rooms
          .flatMap((room) => [room, ...room.children])
          .find((unit) => unit.id === demo.bedAId)!
          .days.find((day) => day.serviceDate === "2030-01-02");
        expect(secondDay).toMatchObject({ status: "UNKNOWN", available: false });
        expect(secondDay?.conflicts).toEqual(expect.arrayContaining([
          expect.objectContaining({ blockingFactKind: "UNIT_UNSELLABLE", claimIds: [] })
        ]));
        expect(board.projectionState).toBe("READY");
        const availability = (await listAvailability(
          projectedDb,
          demo.propertyId,
          "2030-01-02",
          "2030-01-03",
          "BED"
        )).find((unit) => unit.id === demo.bedAId);
        expect(availability?.nights).toEqual([expect.objectContaining({ serviceDate: "2030-01-02", available: false })]);
      } finally {
        await projectedDb.destroy();
      }

      await expect(client.query(`
        INSERT INTO internal_use_blocks(
          id, property_id, inventory_unit_id, room_id, arrival_date, departure_date,
          reason, status, version, created_by_command_id, released_by_command_id, released_at
        ) VALUES (
          'block_new_internal_use', '${demo.propertyId}', '${demo.bedAId}', '${demo.roomId}',
          '2030-02-01', '2030-02-02', 'Must be rejected', 'ACTIVE', 1,
          'command_historical_internal_use', NULL, NULL
        )
      `)).rejects.toMatchObject({ constraint: "internal_use_deferred" });
      await expect(client.query(`
        UPDATE internal_use_blocks
        SET status = 'RELEASED', version = 2,
            released_by_command_id = 'command_historical_internal_use', released_at = now()
        WHERE id = 'block_historical_internal_use'
      `)).rejects.toMatchObject({ constraint: "internal_use_deferred" });
      await expect(client.query(`
        UPDATE inventory_claims
        SET active = false, released_at = now()
        WHERE id = 'claim_historical_internal_use'
      `)).rejects.toMatchObject({ constraint: "internal_use_deferred" });
      await client.query(`
        INSERT INTO maintenance_locks(
          id, property_id, inventory_unit_id, arrival_date, departure_date,
          reason, status, version, created_by_command_id, released_by_command_id, released_at
        ) VALUES (
          'maint_overlapping_history', '${demo.propertyId}', '${demo.bedAId}',
          '2030-01-02', '2030-01-03', 'Must remain blocked', 'ACTIVE', 1,
          NULL, NULL, NULL
        )
      `);
      await expect(client.query(`
        INSERT INTO inventory_claims(
          id, property_id, room_id, inventory_unit_id, service_date,
          source_type, source_id, active, released_at
        ) VALUES (
          'claim_overlapping_history', '${demo.propertyId}', '${demo.roomId}', '${demo.bedAId}',
          '2030-01-02', 'MAINTENANCE', 'maint_overlapping_history', true, NULL
        )
      `)).rejects.toMatchObject({ constraint: "deferred_unavailable_inventory_conflict" });
      await expect(client.query(`
        INSERT INTO inventory_claims(
          id, property_id, room_id, inventory_unit_id, service_date,
          source_type, source_id, active, released_at
        ) VALUES (
          'claim_new_internal_use', '${demo.propertyId}', '${demo.roomId}', '${demo.bedAId}',
          '2030-01-02', 'INTERNAL_USE', 'block_historical_internal_use', true, NULL
        )
      `)).rejects.toMatchObject({ constraint: "internal_use_deferred" });
      expect((await client.query("SELECT id FROM internal_use_blocks WHERE id LIKE 'block_%internal_use'")).rows)
        .toEqual([{ id: "block_historical_internal_use" }]);
      expect((await client.query("SELECT id FROM inventory_claims WHERE source_type = 'INTERNAL_USE'")).rows)
        .toEqual([{ id: "claim_historical_internal_use" }]);
    } finally {
      await client.end();
    }
  });

  it("fails migration 020 closed for an unknown room type instead of inventing occupancy capacity", async () => {
    await recreateDatabase();
    const migrationNames = (await readdir("packages/db/src/migrations"))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    try {
      for (const migrationName of migrationNames.slice(0, 19)) {
        await client.query(await readFile(`packages/db/src/migrations/${migrationName}`, "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [migrationName]);
      }
      await client.query(`
        INSERT INTO properties(id, code, name, timezone, currency)
        VALUES ('prop_unknown_capacity', 'UNKNOWN-CAPACITY', 'Unknown capacity fixture', 'Asia/Shanghai', 'CNY');
        INSERT INTO inventory_units(
          id, property_id, kind, parent_room_id, code, name, active,
          room_type_code, physical_bed_count
        ) VALUES (
          'unit_unknown_capacity', 'prop_unknown_capacity', 'ROOM', NULL,
          'UNKNOWN-1', 'Unknown room type fixture', true, 'future_room_type', 1
        );
      `);
      const migration020 = await readFile("packages/db/src/migrations/020_whole_room_occupants.sql", "utf8");
      await expect(client.query(migration020)).rejects.toMatchObject({
        constraint: "inventory_units_occupancy_capacity_room_type_known"
      });
      const column = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inventory_units'
          AND column_name = 'occupancy_capacity'
      `);
      expect(column.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
