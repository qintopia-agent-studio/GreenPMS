import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

pg.types.setTypeParser(1082, (value) => value);

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
}

export function createDatabase(url = databaseUrl()): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url, max: 20 })
    })
  });
}

type DatabaseReadyExecutor = Kysely<Database> | Transaction<Database>;

export async function databaseReady(db: DatabaseReadyExecutor): Promise<boolean> {
  try {
    const rows = await db.selectFrom("schema_migrations").select("name").execute();
    const applied = new Set(rows.map((row) => row.name));
    const migrationsReady = applied.has("001_initial.sql")
      && applied.has("002_immutability.sql")
      && applied.has("003_active_coverage_uniqueness.sql")
      && applied.has("004_security_identity_guards.sql")
      && applied.has("005_core_identity_and_entitlement_guards.sql")
      && applied.has("006_property_scoped_idempotency.sql")
      && applied.has("007_reference_catalog.sql")
      && applied.has("008_reference_catalog_sealing.sql")
      && applied.has("009_booking_channels_and_transaction_references.sql")
      && applied.has("010_qintopia_2026_catalog_pricing_and_free_stays.sql")
      && applied.has("011_core_fact_shape_guards.sql")
      && applied.has("012_legacy_demo_inventory_catalog_backfill.sql")
      && applied.has("013_room_status_operations.sql")
      && applied.has("014_new_order_primary_guest_nickname.sql")
      && applied.has("015_generated_room_operational_codes.sql")
      && applied.has("016_member_property_links.sql")
      && applied.has("017_membership_orders.sql")
      && applied.has("018_member_stay_identity_and_coverage_guards.sql")
      && applied.has("019_member_stay_booking_channel_rules.sql")
      && applied.has("020_whole_room_occupants.sql")
      && applied.has("021_defer_internal_use.sql")
      && applied.has("022_order_occupant_corrections.sql")
      && applied.has("023_collection_fact_pricing_revision.sql")
      && applied.has("024_free_stay_category_code.sql")
      && applied.has("025_channel_order_atomic_pricing.sql")
      && applied.has("026_stage9_stay_change_guards.sql")
      && applied.has("027_stage10_stay_shortening_guards.sql");
    if (!migrationsReady) return false;

    const stage10Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage10_shorten_combination()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage10_pricing_revision()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled <> 'D'
            AND (
              (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage10_validate_combination'
                AND handler.proname = 'qintopia_validate_stage10_shorten_combination')
              OR (relation.relname = 'command_executions'
                AND trigger.tgname = 'command_executions_stage10_validate_combination'
                AND handler.proname = 'qintopia_validate_stage10_shorten_execution')
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled <> 'D'
            AND trigger.tgtype = 7
            AND (
              (trigger.tgrelid = to_regclass('pricing_revisions')
                AND trigger.tgname = 'pricing_revisions_stage10_validate'
                AND handler.proname = 'qintopia_validate_stage10_pricing_revision')
              OR (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_stage10_reject_checkout_bypass'
                AND handler.proname = 'qintopia_reject_stage10_checkout_bypass')
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_stage10_reject_write'
                AND handler.proname = 'qintopia_reject_stage10_entitlement_write')
            )
        )::text AS immediate_trigger_count
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid
    `.execute(db);
    return stage10Objects.rows[0]?.function_count === "3"
      && stage10Objects.rows[0]?.deferred_trigger_count === "2"
      && stage10Objects.rows[0]?.immediate_trigger_count === "3";
  } catch {
    return false;
  }
}
