import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

pg.types.setTypeParser(1082, (value) => value);

const currentMigrationNames = [
  "001_initial.sql",
  "002_immutability.sql",
  "003_active_coverage_uniqueness.sql",
  "004_security_identity_guards.sql",
  "005_core_identity_and_entitlement_guards.sql",
  "006_property_scoped_idempotency.sql",
  "007_reference_catalog.sql",
  "008_reference_catalog_sealing.sql",
  "009_booking_channels_and_transaction_references.sql",
  "010_qintopia_2026_catalog_pricing_and_free_stays.sql",
  "011_core_fact_shape_guards.sql",
  "012_legacy_demo_inventory_catalog_backfill.sql",
  "013_room_status_operations.sql",
  "014_new_order_primary_guest_nickname.sql",
  "015_generated_room_operational_codes.sql",
  "016_member_property_links.sql",
  "017_membership_orders.sql",
  "018_member_stay_identity_and_coverage_guards.sql",
  "019_member_stay_booking_channel_rules.sql",
  "020_whole_room_occupants.sql",
  "021_defer_internal_use.sql",
  "022_order_occupant_corrections.sql",
  "023_collection_fact_pricing_revision.sql",
  "024_free_stay_category_code.sql",
  "025_channel_order_atomic_pricing.sql",
  "026_stage9_stay_change_guards.sql",
  "027_stage10_stay_shortening_guards.sql",
  "028_stage11_move_unit_guards.sql",
  "029_stage12_terminal_order_guards.sql",
  "030_collection_fact_historical_pricing_revision.sql",
  "031_collection_fact_method_transaction_rules.sql",
  "032_wecom_refund_original_route.sql"
] as const;

export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const url = new URL("postgres://127.0.0.1");
  url.username = process.env.PGUSER ?? "qintopia";
  url.password = process.env.PGPASSWORD ?? "qintopia";
  url.hostname = process.env.PGHOST ?? "127.0.0.1";
  url.port = process.env.PGPORT ?? "55432";
  url.pathname = `/${process.env.PGDATABASE ?? "qintopia"}`;
  return url.toString();
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
    const rows = await db.selectFrom("schema_migrations").select("name").orderBy("name").execute();
    const migrationsReady = rows.length === currentMigrationNames.length
      && rows.every((row, index) => row.name === currentMigrationNames[index]);
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
            AND trigger.tgenabled IN ('O','A')
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
            AND trigger.tgenabled IN ('O','A')
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
    const stage11Objects = await sql<{
      function_count: string;
      replacement_count: string;
      body_marker_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_assert_stage11_shorten_before_timeline(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_shorten_before_timeline()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_inventory_claim_source()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_date_change_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_combination()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_revision()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_amendment()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage11_move_ledger()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_stage11_move_collection()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_preserve_stage11_preview_evidence()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)') IS NOT NULL)::integer
        )::text AS function_count,
        (
          COALESCE(
            position(
              'stage10_shorten_future_move_boundary'
              IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))
            ) = 0,
            false
          )::integer
          + COALESCE(
            position(
              'reschedule_pair_valid'
              IN pg_get_functiondef(to_regprocedure('qintopia_validate_inventory_claim_source()'))
            ) > 0,
            false
          )::integer
        )::text AS replacement_count,
        (
          COALESCE(position('stage11_move_order_command_chain'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('stage11_move_inventory_diff'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('ledger.service_date < effective_date'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('stage11_date_change_order_command_chain'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer
          + COALESCE(position('stage11_date_change_plan_b'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer
          + COALESCE(position('target_preview.effect IS DISTINCT FROM target_amendment.payload'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer
          + COALESCE(position('target_receipt.result ->> ''effectHash'' IS DISTINCT FROM target_preview.effect_hash'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer
          + COALESCE(position('stage11_preview_evidence_immutable'
            IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_preview_evidence()'))) > 0, false)::integer
        )::text AS body_marker_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND (
              (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage11_validate_shorten_before_timeline'
                AND trigger.tgtype = 5
                AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline')
              OR (relation.relname = 'command_executions'
                AND trigger.tgname = 'command_executions_stage11_validate_shorten_before_timeline'
                AND trigger.tgtype = 21
                AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline')
              OR (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage11_validate_move_combination'
                AND trigger.tgtype = 5
                AND handler.proname = 'qintopia_validate_stage11_move_combination')
              OR (relation.relname = 'command_executions'
                AND trigger.tgname = 'command_executions_stage11_validate_move_combination'
                AND trigger.tgtype = 21
                AND handler.proname = 'qintopia_validate_stage11_move_execution')
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND (
              (relation.relname = 'pricing_revisions'
                AND trigger.tgname = 'pricing_revisions_stage11_validate_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_validate_stage11_move_revision')
              OR (relation.relname = 'amendments'
                AND trigger.tgname = 'amendments_stage11_validate_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_validate_stage11_move_amendment')
              OR (relation.relname = 'coverage_items'
                AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_update'
                AND trigger.tgtype = 19
                AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage')
              OR (relation.relname = 'coverage_items'
                AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_delete'
                AND trigger.tgtype = 11
                AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage')
              OR (relation.relname = 'entitlement_ledger'
                AND trigger.tgname = 'entitlement_ledger_stage11_validate_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_validate_stage11_move_ledger')
              OR (relation.relname = 'collection_facts'
                AND trigger.tgname = 'collection_facts_stage11_reject_move'
                AND trigger.tgtype = 7
                AND handler.proname = 'qintopia_reject_stage11_move_collection')
              OR (relation.relname = 'inventory_claims'
                AND trigger.tgname = 'inventory_claims_validate_source'
                AND trigger.tgtype = 23
                AND handler.proname = 'qintopia_validate_inventory_claim_source')
              OR (relation.relname = 'command_previews'
                AND trigger.tgname = 'command_previews_stage11_preserve_evidence'
                AND trigger.tgtype = 19
                AND handler.proname = 'qintopia_preserve_stage11_preview_evidence')
            )
        )::text AS immediate_trigger_count
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid
    `.execute(db);
    const stage12Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
      restore_index_count: string;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_amendment()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_revision()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage12_terminal_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_terminal_child()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_stage12_terminal_status()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_order_terminal_transition()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage12_stay_terminal_transition()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgname IN (
              'command_executions_stage12_validate_terminal',
              'entitlement_ledger_stage12_validate_terminal',
              'orders_stage12_validate_terminal_transition',
              'stays_stage12_validate_terminal_transition'
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgname IN (
              'amendments_stage12_validate_terminal',
              'pricing_revisions_stage12_validate_terminal',
              'orders_stage12_protect_terminal_status',
              'stays_stage12_protect_terminal_status'
            )
        )::text AS immediate_trigger_count,
        (
          SELECT count(*)::text FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'entitlement_ledger_one_restore_per_coverage_idx'
        ) AS restore_index_count
      FROM pg_trigger AS trigger
    `.execute(db);
    return stage10Objects.rows[0]?.function_count === "3"
      && stage10Objects.rows[0]?.deferred_trigger_count === "2"
      && stage10Objects.rows[0]?.immediate_trigger_count === "3"
      && stage11Objects.rows[0]?.function_count === "14"
      && stage11Objects.rows[0]?.replacement_count === "2"
      && stage11Objects.rows[0]?.body_marker_count === "8"
      && stage11Objects.rows[0]?.deferred_trigger_count === "4"
      && stage11Objects.rows[0]?.immediate_trigger_count === "8"
      && stage12Objects.rows[0]?.function_count === "9"
      && stage12Objects.rows[0]?.deferred_trigger_count === "4"
      && stage12Objects.rows[0]?.immediate_trigger_count === "4"
      && stage12Objects.rows[0]?.restore_index_count === "1";
  } catch {
    return false;
  }
}
