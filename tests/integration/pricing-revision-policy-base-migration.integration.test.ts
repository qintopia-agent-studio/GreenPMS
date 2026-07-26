import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const databaseUrl = process.env.PRICING_REVISION_MIGRATION_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_pricing_revision_migration";

async function recreateDatabaseThrough024(): Promise<void> {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const directory = resolve(process.cwd(), "packages/db/src/migrations");
    const migrations = (await readdir(directory))
      .filter((name) => /^0(?:0[1-9]|1\d|2[0-4])_.*\.sql$/.test(name))
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(resolve(directory, migration), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [migration]);
    }

    await client.query(`
      INSERT INTO properties(id, code, name, timezone, currency)
      VALUES ('property_policy_base_migration', 'PBM', 'Policy base migration', 'Asia/Shanghai', 'CNY');

      INSERT INTO inventory_units(id, property_id, kind, parent_room_id, code, name, active)
      VALUES ('room_policy_base_migration', 'property_policy_base_migration', 'ROOM', NULL, 'PBM-101', 'Migration room', true);

      INSERT INTO pricing_policy_versions(id, property_id, code, version, stay_type, calculation_kind, nightly_rate_minor, currency, status)
      VALUES ('policy_policy_base_migration', 'property_policy_base_migration', 'TRANSIENT', 1, 'TRANSIENT', 'FLAT_NIGHTLY', 12000, 'CNY', 'PUBLISHED');

      INSERT INTO subjects(id, username, display_name, password_salt, password_hash, status, auth_version)
      VALUES ('subject_policy_base_migration', 'policy-base-migration', 'Policy base migration', 'salt', 'hash', 'ACTIVE', 1);

      INSERT INTO command_executions(
        id, subject_id, credential_id, property_id, command_type,
        idempotency_key, request_hash, correlation_id, state, completed_at
      ) VALUES (
        'command_policy_base_migration', 'subject_policy_base_migration', 'historical-fixture',
        'property_policy_base_migration', 'CREATE_ORDER', 'policy-base-migration', repeat('a', 64),
        'policy-base-migration', 'APPLIED', now()
      );

      INSERT INTO orders(
        id, property_id, status, stay_type, arrival_date, departure_date,
        primary_guest_snapshot, pricing_policy_version_id, member_id, member_contract_id,
        current_revision_id, version, booking_channel_code, channel_order_reference,
        free_stay_reason, free_stay_category_code
      ) VALUES (
        'order_policy_base_migration', 'property_policy_base_migration', 'RESERVED', 'TRANSIENT',
        '2029-03-01', '2029-03-02', '{"fullName":"Historical pricing guest","nickname":"Historical"}'::jsonb,
        'policy_policy_base_migration', NULL, NULL, NULL, 1, 'CTRIP', 'CTRIP-HISTORICAL-001', NULL, NULL
      );

      INSERT INTO order_occupants(
        id, order_id, ordinal, role, full_name, nickname, phone, document_number, created_by_command_id
      ) VALUES (
        'occupant_policy_base_migration', 'order_policy_base_migration', 1, 'PRIMARY',
        'Historical pricing guest', 'Historical', NULL, NULL, 'command_policy_base_migration'
      );

      INSERT INTO amendments(
        id, order_id, sequence, amendment_type, reason_code, reason_note,
        prior_version, new_version, payload, command_id
      ) VALUES (
        'amendment_policy_base_migration', 'order_policy_base_migration', 1,
        'CREATE_ORDER', 'HISTORICAL', 'Historical adjusted contract amount',
        0, 1, '{}'::jsonb, 'command_policy_base_migration'
      );

      INSERT INTO stays(id, order_id, status)
      VALUES ('stay_policy_base_migration', 'order_policy_base_migration', 'PLANNED');

      INSERT INTO stay_segments(
        id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date,
        segment_type, supersedes_segment_id, amendment_id
      ) VALUES (
        'segment_policy_base_migration', 'stay_policy_base_migration', 1,
        'room_policy_base_migration', '2029-03-01', '2029-03-02',
        'INITIAL', NULL, 'amendment_policy_base_migration'
      );

      INSERT INTO pricing_revisions(
        id, order_id, revision_no, amendment_id, policy_version_id,
        arrival_date, departure_date, coverage_set, cash_lines,
        manual_adjustment_minor, current_contract_amount_minor, currency
      ) VALUES (
        'revision_policy_base_migration', 'order_policy_base_migration', 1,
        'amendment_policy_base_migration', 'policy_policy_base_migration',
        '2029-03-01', '2029-03-02', '[]'::jsonb, '[]'::jsonb,
        -1800, 10200, 'CNY'
      );

      UPDATE orders
      SET current_revision_id = 'revision_policy_base_migration'
      WHERE id = 'order_policy_base_migration';
    `);
  } finally {
    await client.end();
  }
}

async function dropDatabase(): Promise<void> {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
}

describe.sequential("pricing revision policy-base migration on PostgreSQL", () => {
  beforeAll(recreateDatabaseThrough024);
  afterAll(dropDatabase);

  it("backfills the stored policy base, restores append-only protection, and enforces channel references", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migration025 = await readFile(
        resolve(process.cwd(), "packages/db/src/migrations/025_channel_order_atomic_pricing.sql"),
        "utf8"
      );
      await client.query(migration025);

      const revision = await client.query<{
        policy_base_amount_minor: number;
        pricing_basis: string;
      }>(`
        SELECT policy_base_amount_minor, pricing_basis
        FROM pricing_revisions
        WHERE id = 'revision_policy_base_migration'
      `);
      expect(revision.rows).toEqual([{
        policy_base_amount_minor: 12000,
        pricing_basis: "MANUAL_ADJUSTMENT"
      }]);

      await expect(client.query(`
        UPDATE pricing_revisions
        SET policy_base_amount_minor = 11999
        WHERE id = 'revision_policy_base_migration'
      `)).rejects.toThrow(/pricing_revisions is append-only/);

      await expect(client.query(`
        INSERT INTO pricing_revisions(
          id, order_id, revision_no, amendment_id, policy_version_id,
          arrival_date, departure_date, coverage_set, cash_lines,
          policy_base_amount_minor, pricing_basis, manual_adjustment_minor,
          current_contract_amount_minor, currency
        ) VALUES (
          'revision_negative_policy_base', 'order_policy_base_migration', 2,
          'amendment_policy_base_migration', 'policy_policy_base_migration',
          '2029-03-01', '2029-03-02', '[]'::jsonb, '[]'::jsonb,
          -1, 'CHANNEL_CONTRACT', 0, 1, 'CNY'
        )
      `)).rejects.toMatchObject({ constraint: "pricing_revisions_policy_base_nonnegative" });

      await expect(client.query(`
        INSERT INTO orders(
          id, property_id, status, stay_type, arrival_date, departure_date,
          primary_guest_snapshot, pricing_policy_version_id, member_id, member_contract_id,
          current_revision_id, version, booking_channel_code, channel_order_reference,
          free_stay_reason, free_stay_category_code
        ) VALUES (
          'order_external_missing_reference', 'property_policy_base_migration', 'RESERVED', 'TRANSIENT',
          '2029-03-03', '2029-03-04', '{"fullName":"Missing ref","nickname":"Missing ref"}'::jsonb,
          'policy_policy_base_migration', NULL, NULL, NULL, 1, 'MEITUAN', '   ', NULL, NULL
        )
      `)).rejects.toMatchObject({ constraint: "orders_new_channel_order_reference_required" });

      await expect(client.query(`
        INSERT INTO orders(
          id, property_id, status, stay_type, arrival_date, departure_date,
          primary_guest_snapshot, pricing_policy_version_id, member_id, member_contract_id,
          current_revision_id, version, booking_channel_code, channel_order_reference,
          free_stay_reason, free_stay_category_code
        ) VALUES (
          'order_wecom_with_reference', 'property_policy_base_migration', 'RESERVED', 'TRANSIENT',
          '2029-03-05', '2029-03-06', '{"fullName":"WECOM ref","nickname":"WECOM ref"}'::jsonb,
          'policy_policy_base_migration', NULL, NULL, NULL, 1, 'WECOM', 'WECOM-MUST-BE-NULL', NULL, NULL
        )
      `)).rejects.toMatchObject({ constraint: "orders_wecom_has_no_channel_order_reference" });

      await client.query("BEGIN");
      try {
        await client.query(`
          INSERT INTO orders(
            id, property_id, status, stay_type, arrival_date, departure_date,
            primary_guest_snapshot, pricing_policy_version_id, member_id, member_contract_id,
            current_revision_id, version, booking_channel_code, channel_order_reference,
            free_stay_reason, free_stay_category_code
          ) VALUES (
            'order_wecom_without_reference', 'property_policy_base_migration', 'RESERVED', 'TRANSIENT',
            '2029-03-07', '2029-03-08', '{"fullName":"WECOM direct","nickname":"WECOM direct"}'::jsonb,
            'policy_policy_base_migration', NULL, NULL, NULL, 1, 'WECOM', NULL, NULL, NULL
          )
        `);
        const directOrder = await client.query<{ channel_order_reference: string | null }>(`
          SELECT channel_order_reference
          FROM orders
          WHERE id = 'order_wecom_without_reference'
        `);
        expect(directOrder.rows).toEqual([{ channel_order_reference: null }]);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  });
});
