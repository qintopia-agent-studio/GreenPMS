import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

const databaseUrl = process.env.ADMIN_MEMBERSHIP_CORRECTIONS_MIGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_admin_membership_corrections_migration";

async function withAdminDatabase(action: (client: pg.Client) => Promise<void>): Promise<void> {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/qintopia";
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName]
    );
    await action(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabaseThrough049(): Promise<void> {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  await withAdminDatabase(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  });

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const directory = resolve(process.cwd(), "packages/db/src/migrations");
    const migrations = (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 49)
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(resolve(directory, migration), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [migration]);
    }

    await client.query("SET session_replication_role = replica");
    try {
      await client.query(`
        INSERT INTO properties(id, code, name, timezone, currency)
        VALUES ('property_050_upgrade', 'M50', 'Migration 050 upgrade', 'Asia/Shanghai', 'CNY');

        INSERT INTO members(id, identity_card_number, nickname, full_name, phone, wechat)
        VALUES ('member_050_upgrade', 'M50-UPGRADE', '升级会员', '升级会员', '13900000500', 'm50-upgrade');

        INSERT INTO member_property_links(member_id, property_id)
        VALUES ('member_050_upgrade', 'property_050_upgrade');

        INSERT INTO membership_orders(
          id, property_id, member_id, product_id, product_code, product_version, product_name,
          listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
          currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code,
          allowed_inventory_kind, status, activated_at, valid_from, valid_until, contract_id,
          entitlement_lot_id, version, created_by_command_id, activated_by_command_id,
          created_at, updated_at
        ) VALUES (
          'membership_order_050_upgrade', 'property_050_upgrade', 'member_050_upgrade',
          'membership_product_shared_bath_quad_v1', 'SHARED_BATH_QUAD_30', 1, '公卫四人间会员',
          93600, 93600, 0, NULL, 'CNY', 'BED_NIGHT', 30, 'shared_bath_quad', 'BED',
          'DRAFT', NULL, NULL, NULL, NULL, NULL, 1, 'command_050_upgrade', NULL,
          '2026-08-01T04:00:00.123456Z', '2026-08-01T04:00:00.123456Z'
        );

        INSERT INTO membership_payment_facts(
          fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
          transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
          source_order_id, source_collection_fact_id, note, command_id, created_at
        ) VALUES (
          'membership_payment_050_upgrade', 'membership_order_050_upgrade', 'COLLECTION',
          93600, 93600, 'CNY', 'WECOM-M50-UPGRADE', NULL, NULL, 'DIRECT_WECOM',
          NULL, NULL, 'migration upgrade fixture', 'command_050_upgrade',
          '2026-08-01T04:00:00.123456Z'
        );
      `);
    } finally {
      await client.query("SET session_replication_role = origin");
    }
  } finally {
    await client.end();
  }
}

async function dropDatabase(): Promise<void> {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  await withAdminDatabase(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
  });
}

describe.sequential("migration 050 existing membership payment compatibility", () => {
  beforeEach(recreateDatabaseThrough049);
  afterEach(dropDatabase);

  it("preserves an existing payment and derives its property-local business date before restoring append-only protection", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migration050 = await readFile(
        resolve(process.cwd(), "packages/db/src/migrations/050_admin_membership_corrections.sql"),
        "utf8"
      );
      await client.query(migration050);

      const payment = await client.query<{
        amount_minor: number;
        created_at: Date;
        business_date: string;
      }>(`
        SELECT amount_minor, created_at, business_date::text
        FROM membership_payment_facts
        WHERE fact_id = 'membership_payment_050_upgrade'
      `);
      expect(payment.rows).toHaveLength(1);
      expect(payment.rows[0]!.amount_minor).toBe(93600);
      expect(payment.rows[0]!.business_date).toBe("2026-08-01");

      await expect(client.query(`
        UPDATE membership_payment_facts
        SET business_date = business_date + 1
        WHERE fact_id = 'membership_payment_050_upgrade'
      `)).rejects.toThrow(/append-only/);
    } finally {
      await client.end();
    }
  });

  it("preserves same-table and cross-table historical duplicate references without claiming them", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("SET session_replication_role = replica");
      try {
        await client.query(`
          INSERT INTO membership_payment_facts(
            fact_id, membership_order_id, fact_type, amount_minor, net_effect_minor, currency,
            transaction_reference, corrects_fact_id, reverses_fact_id, source_type,
            source_order_id, source_collection_fact_id, note, command_id, created_at
          ) VALUES (
            'membership_payment_050_duplicate_reference', 'membership_order_050_upgrade', 'COLLECTION',
            1, 1, 'CNY', 'WECOM-M50-UPGRADE', NULL, NULL, 'DIRECT_WECOM',
            NULL, NULL, 'historical duplicate reference preserved during migration', 'command_050_upgrade',
            '2026-08-01T04:00:01.123456Z'
          );

          INSERT INTO collection_facts(
            fact_id, order_id, fact_type, amount_minor, net_effect_minor, currency,
            references_fact_id, reverses_fact_id, method, note, command_id, created_at,
            transaction_reference, pricing_revision_id, cash_collector
          ) VALUES
          (
            'collection_fact_050_duplicate_reference_1', 'legacy_order_050_1', 'COLLECTION',
            1, 1, 'CNY', NULL, NULL, 'WECOM', 'cross-table duplicate one',
            'legacy_command_050_1', '2026-08-01T04:00:02.123456Z',
            'WECOM-M50-UPGRADE', 'legacy_revision_050_1', NULL
          ),
          (
            'collection_fact_050_duplicate_reference_2', 'legacy_order_050_2', 'COLLECTION',
            1, 1, 'CNY', NULL, NULL, 'WECOM', 'cross-table duplicate two',
            'legacy_command_050_2', '2026-08-01T04:00:03.123456Z',
            'WECOM-M50-UPGRADE', 'legacy_revision_050_2', NULL
          );
        `);
      } finally {
        await client.query("SET session_replication_role = origin");
      }

      const migration050 = await readFile(
        resolve(process.cwd(), "packages/db/src/migrations/050_admin_membership_corrections.sql"),
        "utf8"
      );
      await client.query(migration050);

      const claims = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM admin_membership_payment_evidence_claims
        WHERE normalized_reference = 'WECOM-M50-UPGRADE'
      `);
      expect(claims.rows[0]?.count).toBe("0");

      const duplicateFacts = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM membership_payment_facts
        WHERE transaction_reference = 'WECOM-M50-UPGRADE'
      `);
      expect(duplicateFacts.rows[0]?.count).toBe("2");

      const duplicateLodgingFacts = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM collection_facts
        WHERE transaction_reference = 'WECOM-M50-UPGRADE'
      `);
      expect(duplicateLodgingFacts.rows[0]?.count).toBe("2");

      const reverseForeignKeys = await client.query<{
        conname: string;
        convalidated: boolean;
      }>(`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conname IN (
          'collection_facts_transaction_reference_registry_fk',
          'membership_payment_facts_transaction_reference_registry_fk'
        )
        ORDER BY conname
      `);
      expect(reverseForeignKeys.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("adds only the typed 9.5 command to the owner-controlled runtime room-status allowlist", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migration050 = await readFile(
        resolve(process.cwd(), "packages/db/src/migrations/050_admin_membership_corrections.sql"),
        "utf8"
      );
      await client.query(migration050);

      const functionEvidence = await client.query<{
        body_hash: string;
        definition: string;
        runtime_can_execute: boolean;
      }>(`
        SELECT
          encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') AS body_hash,
          pg_get_functiondef(procedure_row.oid) AS definition,
          has_function_privilege(
            'qintopia_runtime',
            procedure_row.oid,
            'EXECUTE'
          ) AS runtime_can_execute
        FROM pg_proc AS procedure_row
        WHERE procedure_row.oid =
          to_regprocedure('qintopia_guard_runtime_mutable_projection_update()')
      `);

      expect(functionEvidence.rows).toHaveLength(1);
      expect(functionEvidence.rows[0]).toMatchObject({
        body_hash: "1fdd5635bc4790c0468412f736f083df9dc16c46e8b8d495eb7880be664883e1",
        runtime_can_execute: false
      });
      expect(functionEvidence.rows[0]!.definition).toContain(`
      'RELEASE_MAINTENANCE', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
`);
    } finally {
      await client.end();
    }
  });

  it("revalidates every coverage lifecycle delta during an effective-date correction", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migration050 = await readFile(
        resolve(process.cwd(), "packages/db/src/migrations/050_admin_membership_corrections.sql"),
        "utf8"
      );
      await client.query(migration050);

      const functionEvidence = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(procedure_row.oid) AS definition
        FROM pg_proc AS procedure_row
        WHERE procedure_row.oid =
          to_regprocedure('qintopia_validate_membership_effective_date_correction()')
      `);
      expect(functionEvidence.rows).toHaveLength(1);
      const normalizedDefinition = functionEvidence.rows[0]!.definition.replace(/\s+/g, " ");
      for (const [entryType, quantityDelta] of [
        ["HOLD", -1],
        ["RELEASE", 1],
        ["CONSUME", 0],
        ["RESTORE", 1],
        ["CONVERSION_CONSUME", -1]
      ] as const) {
        expect(normalizedDefinition).toContain(
          `(ledger.entry_type = '${entryType}' AND ledger.quantity_delta IS DISTINCT FROM ${quantityDelta})`
        );
      }
    } finally {
      await client.end();
    }
  });

  it("requires a matching source-stay phone and treats documents only as an additional conflict check", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migration050 = await readFile(
        resolve(process.cwd(), "packages/db/src/migrations/050_admin_membership_corrections.sql"),
        "utf8"
      );
      await client.query(migration050);

      const functionEvidence = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(procedure_row.oid) AS definition
        FROM pg_proc AS procedure_row
        WHERE procedure_row.oid =
          to_regprocedure('qintopia_validate_membership_void_reconversion()')
      `);
      expect(functionEvidence.rows).toHaveLength(1);
      const normalizedDefinition = functionEvidence.rows[0]!.definition.replace(/\s+/g, " ");
      expect(normalizedDefinition).toContain("OR NOT identity_phone_matched OR identity_conflict_count <> 0");
      expect(normalizedDefinition).not.toContain("OR (NOT identity_phone_matched AND NOT identity_document_matched)");
    } finally {
      await client.end();
    }
  });
});
