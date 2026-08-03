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
  "032_wecom_refund_original_route.sql",
  "033_stay_collection_membership_conversion.sql",
  "034_stay_conversion_reversal_bridge_guard.sql",
  "035_stage13_conversion_execution_state_guards.sql"
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
  if (!db.isTransaction) {
    try {
      return await db.transaction().execute(async (trx) => databaseReady(trx));
    } catch {
      return false;
    }
  }

  try {
    await sql`
      SELECT pg_advisory_xact_lock_shared(
        hashtextextended('qintopia:migrate', 0::bigint)
      )
    `.execute(db);

    const rows = await db.selectFrom("schema_migrations").select("name").orderBy("name").execute();
    const migrationsReady = rows.length === currentMigrationNames.length
      && rows.every((row, index) => row.name === currentMigrationNames[index]);
    if (!migrationsReady) return false;

    const foundationalObjects = await sql<{
      function_count: string;
      trigger_count: string;
      function_bodies_ready: boolean;
      membership_order_identity_body_ready: boolean;
      idempotency_constraint_ready: boolean;
      membership_payment_append_only_trigger_ready: boolean;
      membership_order_identity_trigger_ready: boolean;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_prevent_fact_mutation()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_order_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_command_execution_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_api_token_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_membership_order_identity()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_prevent_fact_mutation()')
                AND (trigger.tgrelid, trigger.tgname) IN (
                  (to_regclass('pricing_policy_versions'), 'pricing_policy_versions_append_only'),
                  (to_regclass('stay_segments'), 'stay_segments_append_only'),
                  (to_regclass('amendments'), 'amendments_append_only'),
                  (to_regclass('pricing_revisions'), 'pricing_revisions_append_only'),
                  (to_regclass('entitlement_ledger'), 'entitlement_ledger_append_only'),
                  (to_regclass('collection_facts'), 'collection_facts_append_only'),
                  (to_regclass('membership_payment_facts'), 'membership_payment_facts_append_only'),
                  (to_regclass('command_receipts'), 'command_receipts_append_only'),
                  (to_regclass('audit_entries'), 'audit_entries_append_only')
                ))
              OR (trigger.tgrelid = to_regclass('orders')
                AND trigger.tgname = 'orders_protect_identity'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_order_identity()'))
              OR (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_protect_identity'
                AND trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_command_execution_identity()'))
              OR (trigger.tgrelid = to_regclass('api_tokens')
                AND trigger.tgname = 'api_tokens_protect_identity'
                AND trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_api_token_identity()'))
              OR (trigger.tgrelid = to_regclass('membership_orders')
                AND trigger.tgname = 'membership_orders_protect_identity'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_membership_order_identity()'))
            )
        )::text AS trigger_count,
        (
          COALESCE((
            SELECT
              regexp_replace(
                btrim(procedure_row.prosrc),
                '[[:space:]]+',
                ' ',
                'g'
              ) = regexp_replace(
                btrim($readiness$
                  BEGIN
                    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
                  END;
                $readiness$),
                '[[:space:]]+',
                ' ',
                'g'
              )
            FROM pg_proc AS procedure_row
            WHERE procedure_row.oid = to_regprocedure('qintopia_prevent_fact_mutation()')
          ), false)
          AND COALESCE(position('NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_order_identity()'))) > 0, false)
          AND COALESCE(position('command execution state may only advance from EXECUTING to a completed state'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_command_execution_identity()'))) > 0, false)
          AND COALESCE(position('api token state may only advance once from active to revoked or rotated'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_api_token_identity()'))) > 0, false)
        ) AS function_bodies_ready,
        COALESCE((
          SELECT
            regexp_replace(
              btrim(procedure_row.prosrc),
              '[[:space:]]+',
              ' ',
              'g'
            ) = regexp_replace(
              btrim($readiness$
                BEGIN
                  IF NEW.property_id IS DISTINCT FROM OLD.property_id
                    OR NEW.member_id IS DISTINCT FROM OLD.member_id
                    OR NEW.product_id IS DISTINCT FROM OLD.product_id
                    OR NEW.product_code IS DISTINCT FROM OLD.product_code
                    OR NEW.product_version IS DISTINCT FROM OLD.product_version
                    OR NEW.product_name IS DISTINCT FROM OLD.product_name
                    OR NEW.listed_price_minor IS DISTINCT FROM OLD.listed_price_minor
                    OR NEW.agreed_price_minor IS DISTINCT FROM OLD.agreed_price_minor
                    OR NEW.price_adjustment_minor IS DISTINCT FROM OLD.price_adjustment_minor
                    OR NEW.price_adjustment_reason IS DISTINCT FROM OLD.price_adjustment_reason
                    OR NEW.currency IS DISTINCT FROM OLD.currency
                    OR NEW.entitlement_unit_kind IS DISTINCT FROM OLD.entitlement_unit_kind
                    OR NEW.entitlement_units IS DISTINCT FROM OLD.entitlement_units
                    OR NEW.allowed_room_type_code IS DISTINCT FROM OLD.allowed_room_type_code
                    OR NEW.allowed_inventory_kind IS DISTINCT FROM OLD.allowed_inventory_kind
                    OR NEW.created_by_command_id IS DISTINCT FROM OLD.created_by_command_id
                    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
                    RAISE EXCEPTION 'membership order ownership, product, and price snapshot are immutable'
                      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_identity_immutable';
                  END IF;
                  IF OLD.status = 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
                    RAISE EXCEPTION 'active membership orders are immutable'
                      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_active_immutable';
                  END IF;
                  RETURN NEW;
                END;
              $readiness$),
              '[[:space:]]+',
              ' ',
              'g'
            )
          FROM pg_proc AS procedure_row
          WHERE procedure_row.oid = to_regprocedure('qintopia_protect_membership_order_identity()')
        ), false) AS membership_order_identity_body_ready,
        EXISTS (
          SELECT 1
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('command_executions')
            AND constraint_row.conname = 'command_executions_idempotency_scope_key'
            AND constraint_row.contype = 'u'
            AND constraint_row.convalidated
            AND regexp_replace(
              btrim(pg_get_constraintdef(constraint_row.oid, false)),
              '[[:space:]]+',
              ' ',
              'g'
            ) = 'UNIQUE (subject_id, property_id, command_type, idempotency_key)'
        ) AS idempotency_constraint_ready,
        EXISTS (
          SELECT 1
          FROM pg_trigger AS exact_trigger
          WHERE exact_trigger.tgrelid = to_regclass('membership_payment_facts')
            AND exact_trigger.tgname = 'membership_payment_facts_append_only'
            AND NOT exact_trigger.tgisinternal
            AND NOT exact_trigger.tgdeferrable
            AND NOT exact_trigger.tginitdeferred
            AND exact_trigger.tgenabled IN ('O','A')
            AND exact_trigger.tgtype = 27
            AND exact_trigger.tgfoid = to_regprocedure('qintopia_prevent_fact_mutation()')
            AND exact_trigger.tgnargs = 0
            AND exact_trigger.tgattr::text = ''
            AND exact_trigger.tgqual IS NULL
        ) AS membership_payment_append_only_trigger_ready,
        EXISTS (
          SELECT 1
          FROM pg_trigger AS exact_trigger
          WHERE exact_trigger.tgrelid = to_regclass('membership_orders')
            AND exact_trigger.tgname = 'membership_orders_protect_identity'
            AND NOT exact_trigger.tgisinternal
            AND NOT exact_trigger.tgdeferrable
            AND NOT exact_trigger.tginitdeferred
            AND exact_trigger.tgenabled IN ('O','A')
            AND exact_trigger.tgtype = 19
            AND exact_trigger.tgfoid = to_regprocedure('qintopia_protect_membership_order_identity()')
            AND exact_trigger.tgnargs = 0
            AND exact_trigger.tgattr::text = ''
            AND exact_trigger.tgqual IS NULL
        ) AS membership_order_identity_trigger_ready
      FROM pg_trigger AS trigger
    `.execute(db);

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
    const collectionFactObjects = await sql<{
      function_count: string;
      trigger_count: string;
      historical_column_count: string;
      body_marker_count: string;
    }>`
      SELECT
        (to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()') IS NOT NULL)::integer::text
          AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgtype = 7
            AND trigger.tgrelid = to_regclass('collection_facts')
            AND trigger.tgname = 'collection_facts_validate_new_transaction_reference'
            AND trigger.tgfoid = to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()')
        )::text AS trigger_count,
        (
          SELECT count(*)::text
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = to_regclass('collection_facts')
            AND attribute.attname = 'pricing_revision_id'
            AND NOT attribute.attnotnull
            AND NOT attribute.attisdropped
        ) AS historical_column_count,
        (
          COALESCE(position('collection_facts_new_pricing_revision_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_method_transaction_reference_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('(NEW.fact_type = ''COLLECTION'' AND NEW.method = ''WECOM'')'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_cash_other_transaction_reference_null'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_wecom_refund_transaction_reference_null'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_wecom_refund_original_route'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_new_collection_fact_transaction_reference()'))) > 0, false)::integer
        )::text AS body_marker_count
      FROM pg_trigger AS trigger
    `.execute(db);
    const stage12Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
      status_constraint_count: string;
      restore_index_count: string;
      body_marker_count: string;
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
            AND (
              (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_stage12_validate_terminal'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_execution()')
                AND position('UPDATE OF state' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_stage12_validate_terminal'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_child()'))
              OR (trigger.tgrelid = to_regclass('orders')
                AND trigger.tgname = 'orders_stage12_validate_terminal_transition'
                AND trigger.tgtype = 17
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_order_terminal_transition()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('stays')
                AND trigger.tgname = 'stays_stage12_validate_terminal_transition'
                AND trigger.tgtype = 17
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_stay_terminal_transition()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_stage12_validate_terminal'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_amendment()'))
              OR (trigger.tgrelid = to_regclass('pricing_revisions')
                AND trigger.tgname = 'pricing_revisions_stage12_validate_terminal'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage12_terminal_revision()'))
              OR (trigger.tgrelid = to_regclass('orders')
                AND trigger.tgname = 'orders_stage12_protect_terminal_status'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_stage12_terminal_status()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('stays')
                AND trigger.tgname = 'stays_stage12_protect_terminal_status'
                AND trigger.tgtype = 19
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_stage12_terminal_status()')
                AND position('UPDATE OF status' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_validate_lifecycle_fact'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()'))
            )
        )::text AS immediate_trigger_count,
        (
          SELECT count(*)::text
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.contype = 'c'
            AND constraint_row.convalidated
            AND (
              (constraint_row.conrelid = to_regclass('orders')
                AND constraint_row.conname = 'orders_status_check'
                AND position('CHECK_IN_REVOKED' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('NO_SHOW' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('CANCELLED' IN pg_get_constraintdef(constraint_row.oid)) > 0)
              OR (constraint_row.conrelid = to_regclass('stays')
                AND constraint_row.conname = 'stays_status_check'
                AND position('CHECK_IN_REVOKED' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('NO_SHOW' IN pg_get_constraintdef(constraint_row.oid)) > 0
                AND position('CANCELLED' IN pg_get_constraintdef(constraint_row.oid)) > 0)
            )
        ) AS status_constraint_count,
        (
          SELECT count(*)::text
          FROM pg_index AS index
          JOIN pg_class AS index_relation ON index_relation.oid = index.indexrelid
          WHERE index.indrelid = to_regclass('entitlement_ledger')
            AND index_relation.relname = 'entitlement_ledger_one_restore_per_coverage_idx'
            AND index.indisunique
            AND index.indisvalid
            AND index.indisready
            AND position('(coverage_id)' IN pg_get_indexdef(index.indexrelid)) > 0
            AND position('RESTORE' IN pg_get_expr(index.indpred, index.indrelid)) > 0
        ) AS restore_index_count,
        (
          COALESCE(position('entitlement_ledger_restore_command'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_zero_revision'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage12_terminal_revision()'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_inventory_entitlement'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage12_terminal_command(text)'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_funds'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage12_terminal_command(text)'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_status_typed'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage12_order_terminal_transition()'))) > 0, false)::integer
          + COALESCE(position('stage12_terminal_status_typed'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage12_stay_terminal_transition()'))) > 0, false)::integer
        )::text AS body_marker_count
      FROM pg_trigger AS trigger
    `.execute(db);
    const stage13Objects = await sql<{
      function_count: string;
      deferred_trigger_count: string;
      immediate_trigger_count: string;
      table_count: string;
      source_column_count: string;
      critical_constraints_ready: boolean;
      index_count: string;
      body_marker_count: string;
      execution_wrapper_body_ready: boolean;
      child_wrapper_body_ready: boolean;
      membership_order_wrapper_body_ready: boolean;
      trigger_bindings_ready: boolean;
      function_bodies_ready: boolean;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_validate_membership_payment_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stay_collection_membership_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_require_transfer_membership_payment_bridge()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage13_stay_conversion_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage13_stay_conversion_child()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_require_stage13_conversion_reversal_bridge()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()') IS NOT NULL)::integer
        )::text AS function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_transfer_bridge_required'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_require_transfer_membership_payment_bridge()'))
              OR (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_stage13_validate_stay_conversion'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_execution()')
                AND position('UPDATE OF state' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('stay_collection_membership_transfers')
                AND trigger.tgname = 'transfers_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
              OR (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_facts_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()')
                AND trigger.tgqual IS NULL)
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_stage13_require_conversion_reversal_bridge'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_require_stage13_conversion_reversal_bridge()')
                AND position('REVERSAL' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_stage13_validate_stay_conversion'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_child()')
                AND position('command_id IS NOT NULL' IN pg_get_triggerdef(trigger.oid)) > 0)
              OR (trigger.tgrelid = to_regclass('membership_orders')
                AND trigger.tgname = 'membership_orders_stage13_validate_stay_conversion'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()')
                AND position('UPDATE OF activated_by_command_id' IN pg_get_triggerdef(trigger.oid)) > 0)
            )
        )::text AS deferred_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND (
              (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_validate_insert'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_membership_payment_fact()'))
              OR (trigger.tgrelid = to_regclass('stay_collection_membership_transfers')
                AND trigger.tgname = 'stay_collection_membership_transfers_validate_insert'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_stay_collection_membership_transfer()'))
              OR (trigger.tgrelid = to_regclass('stay_collection_membership_transfers')
                AND trigger.tgname = 'stay_collection_membership_transfers_append_only'
                AND trigger.tgtype = 27
                AND trigger.tgfoid = to_regprocedure('qintopia_prevent_fact_mutation()'))
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_stage13_reject_after_transfer'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()'))
              OR (trigger.tgrelid = to_regclass('membership_payment_facts')
                AND trigger.tgname = 'membership_payment_stage13_reject_after_transfer'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_validate_conversion_consume'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()'))
            )
        )::text AS immediate_trigger_count,
        (
          SELECT count(*)::text
          FROM pg_class AS relation
          WHERE relation.oid = to_regclass('stay_collection_membership_transfers')
            AND relation.relkind = 'r'
        ) AS table_count,
        (
          SELECT count(*)::text
          FROM pg_attribute AS attribute
          JOIN pg_attrdef AS default_value
            ON default_value.adrelid = attribute.attrelid
            AND default_value.adnum = attribute.attnum
          WHERE attribute.attrelid = to_regclass('membership_payment_facts')
            AND attribute.attname = 'source_type'
            AND attribute.attnotnull
            AND NOT attribute.attisdropped
            AND position('DIRECT_WECOM' IN pg_get_expr(default_value.adbin, default_value.adrelid)) > 0
        ) AS source_column_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('membership_payment_facts', 'membership_payment_facts_source_order_id_fkey', 'f',
                  'FOREIGN KEY (source_order_id) REFERENCES orders(id)'),
                ('membership_payment_facts', 'membership_payment_facts_source_collection_fact_id_fkey', 'f',
                  'FOREIGN KEY (source_collection_fact_id) REFERENCES collection_facts(fact_id)'),
                ('membership_payment_facts', 'membership_payment_source_type_check', 'c',
                  'CHECK ((source_type = ANY (ARRAY[''DIRECT_WECOM''::text, ''STAY_COLLECTION_TRANSFER''::text])))'),
                ('membership_payment_facts', 'membership_payment_direct_source_null', 'c',
                  'CHECK (((source_type <> ''DIRECT_WECOM''::text) OR ((source_order_id IS NULL) AND (source_collection_fact_id IS NULL))))'),
                ('membership_payment_facts', 'membership_payment_transfer_source_required', 'c',
                  'CHECK (((source_type <> ''STAY_COLLECTION_TRANSFER''::text) OR ((source_order_id IS NOT NULL) AND (source_collection_fact_id IS NOT NULL))))'),
                ('collection_facts', 'collection_facts_fact_id_order_id_unique', 'u',
                  'UNIQUE (fact_id, order_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_pkey', 'p',
                  'PRIMARY KEY (id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_property_id_fkey', 'f',
                  'FOREIGN KEY (property_id) REFERENCES properties(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_order_id_fkey', 'f',
                  'FOREIGN KEY (order_id) REFERENCES orders(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_trans_source_collection_fact_id_fkey', 'f',
                  'FOREIGN KEY (source_collection_fact_id) REFERENCES collection_facts(fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfe_source_reversal_fact_id_fkey', 'f',
                  'FOREIGN KEY (source_reversal_fact_id) REFERENCES collection_facts(fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_membership_order_id_fkey', 'f',
                  'FOREIGN KEY (membership_order_id) REFERENCES membership_orders(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_tran_membership_payment_fact_id_fkey', 'f',
                  'FOREIGN KEY (membership_payment_fact_id) REFERENCES membership_payment_facts(fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_command_id_fkey', 'f',
                  'FOREIGN KEY (command_id) REFERENCES command_executions(id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transf_source_collection_fact_id_key', 'u',
                  'UNIQUE (source_collection_fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfer_source_reversal_fact_id_key', 'u',
                  'UNIQUE (source_reversal_fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_trans_membership_payment_fact_id_key', 'u',
                  'UNIQUE (membership_payment_fact_id)'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_tr_source_collection_fact_id_or_fkey', 'f',
                  'FOREIGN KEY (source_collection_fact_id, order_id) REFERENCES collection_facts(fact_id, order_id)'),
                ('entitlement_ledger', 'entitlement_ledger_entry_type_check', 'c',
                  'CHECK ((entry_type = ANY (ARRAY[''ADJUST''::text, ''HOLD''::text, ''RELEASE''::text, ''CONSUME''::text, ''RESTORE''::text, ''EXPIRE''::text, ''CONVERSION_CONSUME''::text])))')
            ) AS expected(table_name, constraint_name, constraint_type, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_constraint AS constraint_row
              WHERE constraint_row.conrelid = to_regclass(expected.table_name)
                AND constraint_row.conname = expected.constraint_name
                AND constraint_row.contype::text = expected.constraint_type
                AND constraint_row.convalidated
                AND regexp_replace(
                  btrim(pg_get_constraintdef(constraint_row.oid, false)),
                  '[[:space:]]+',
                  ' ',
                  'g'
                ) = expected.definition
            )
          )
        ) AS critical_constraints_ready,
        (
          SELECT count(*)::text
          FROM pg_index AS index
          JOIN pg_class AS index_relation ON index_relation.oid = index.indexrelid
          WHERE index.indisvalid
            AND index.indisready
            AND (
              (index.indrelid = to_regclass('membership_payment_facts')
                AND index_relation.relname = 'membership_payment_source_collection_idx'
                AND NOT index.indisunique
                AND position('(source_order_id, source_collection_fact_id)'
                  IN pg_get_indexdef(index.indexrelid)) > 0
                AND position('STAY_COLLECTION_TRANSFER'
                  IN pg_get_expr(index.indpred, index.indrelid)) > 0)
              OR (index.indrelid = to_regclass('stay_collection_membership_transfers')
                AND index_relation.relname = 'stay_collection_membership_transfers_order_idx'
                AND NOT index.indisunique
                AND position('(order_id, created_at, id)' IN pg_get_indexdef(index.indexrelid)) > 0)
              OR (index.indrelid = to_regclass('stay_collection_membership_transfers')
                AND index_relation.relname = 'stay_collection_membership_transfers_membership_order_idx'
                AND NOT index.indisunique
                AND position('(membership_order_id, created_at, id)' IN pg_get_indexdef(index.indexrelid)) > 0)
              OR (index.indrelid = to_regclass('entitlement_ledger')
                AND index.indexrelid = to_regclass('entitlement_ledger_one_conversion_consume_per_lot_order_date_idx')
                AND index.indisunique
                AND position('(lot_id, order_id, service_date)' IN pg_get_indexdef(index.indexrelid)) > 0
                AND regexp_replace(
                  pg_get_expr(index.indpred, index.indrelid),
                  '[[:space:]()]',
                  '',
                  'g'
                ) = 'entry_type=''CONVERSION_CONSUME''::text')
            )
        ) AS index_count,
        (
          COALESCE(position('stage13_conversion_funds_conserved'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_direct_reference_new'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_one_per_order'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_entitlement'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_lodging_funds_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_membership_funds_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_reversal_bridge_exact'
            IN pg_get_functiondef(to_regprocedure('qintopia_require_stage13_conversion_reversal_bridge()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_execution_state'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_remaining_payment_binding'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)'))) > 0, false)::integer
          + COALESCE(position('qintopia_assert_stage13_stay_conversion_command_v033'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command(text)'))) > 0, false)::integer
          + COALESCE(position('transfer.command_id = NEW.command_id'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))) > 0, false)::integer
          + COALESCE(position('membership_payment_transfer_shape'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_membership_payment_fact()'))) > 0, false)::integer
          + COALESCE(position('stay_membership_transfer_payment'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stay_collection_membership_transfer()'))) > 0, false)::integer
        )::text AS body_marker_count,
        COALESCE(position(
          'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.id);'
          IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_execution()'))
        ) > 0, false) AS execution_wrapper_body_ready,
        COALESCE(position(
          'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.command_id);'
          IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_child()'))
        ) > 0, false) AS child_wrapper_body_ready,
        (
          COALESCE(position(
            'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.created_by_command_id);'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()'))
          ) > 0, false)
          AND COALESCE(position(
            'NEW.activated_by_command_id IS DISTINCT FROM NEW.created_by_command_id'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()'))
          ) > 0, false)
          AND COALESCE(position(
            'PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.activated_by_command_id);'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_stage13_stay_conversion_membership_order()'))
          ) > 0, false)
        ) AS membership_order_wrapper_body_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('membership_payment_facts', 'membership_payment_transfer_bridge_required',
                  'CREATE CONSTRAINT TRIGGER membership_payment_transfer_bridge_required AFTER INSERT ON public.membership_payment_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.source_type = ''STAY_COLLECTION_TRANSFER''::text)) EXECUTE FUNCTION qintopia_require_transfer_membership_payment_bridge()'),
                ('command_executions', 'command_executions_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER command_executions_stage13_validate_stay_conversion AFTER INSERT OR UPDATE OF state ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_execution()'),
                ('stay_collection_membership_transfers', 'transfers_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER transfers_stage13_validate_stay_conversion AFTER INSERT ON public.stay_collection_membership_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('collection_facts', 'collection_facts_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER collection_facts_stage13_validate_stay_conversion AFTER INSERT ON public.collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('membership_payment_facts', 'membership_payment_facts_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER membership_payment_facts_stage13_validate_stay_conversion AFTER INSERT ON public.membership_payment_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('entitlement_ledger', 'entitlement_ledger_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER entitlement_ledger_stage13_validate_stay_conversion AFTER INSERT ON public.entitlement_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('collection_facts', 'collection_facts_stage13_require_conversion_reversal_bridge',
                  'CREATE CONSTRAINT TRIGGER collection_facts_stage13_require_conversion_reversal_bridge AFTER INSERT ON public.collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.fact_type = ''REVERSAL''::text)) EXECUTE FUNCTION qintopia_require_stage13_conversion_reversal_bridge()'),
                ('amendments', 'amendments_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER amendments_stage13_validate_stay_conversion AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()'),
                ('membership_orders', 'membership_orders_stage13_validate_stay_conversion',
                  'CREATE CONSTRAINT TRIGGER membership_orders_stage13_validate_stay_conversion AFTER INSERT OR UPDATE OF activated_by_command_id ON public.membership_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_membership_order()'),
                ('membership_payment_facts', 'membership_payment_validate_insert',
                  'CREATE TRIGGER membership_payment_validate_insert BEFORE INSERT ON public.membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_payment_fact()'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_validate_insert',
                  'CREATE TRIGGER stay_collection_membership_transfers_validate_insert BEFORE INSERT ON public.stay_collection_membership_transfers FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stay_collection_membership_transfer()'),
                ('stay_collection_membership_transfers', 'stay_collection_membership_transfers_append_only',
                  'CREATE TRIGGER stay_collection_membership_transfers_append_only BEFORE DELETE OR UPDATE ON public.stay_collection_membership_transfers FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()'),
                ('collection_facts', 'collection_facts_stage13_reject_after_transfer',
                  'CREATE TRIGGER collection_facts_stage13_reject_after_transfer BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_reject_lodging_funds_after_membership_transfer()'),
                ('membership_payment_facts', 'membership_payment_stage13_reject_after_transfer',
                  'CREATE TRIGGER membership_payment_stage13_reject_after_transfer BEFORE INSERT ON public.membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()'),
                ('entitlement_ledger', 'entitlement_ledger_validate_conversion_consume',
                  'CREATE TRIGGER entitlement_ledger_validate_conversion_consume BEFORE INSERT ON public.entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_validate_conversion_consume_entitlement_fact()')
            ) AS expected(table_name, trigger_name, definition)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger AS exact_trigger
              WHERE exact_trigger.tgrelid = to_regclass(expected.table_name)
                AND exact_trigger.tgname = expected.trigger_name
                AND NOT exact_trigger.tgisinternal
                AND exact_trigger.tgenabled IN ('O','A')
                AND exact_trigger.tgnargs = 0
                AND pg_get_triggerdef(exact_trigger.oid, false) = expected.definition
            )
          )
        ) AS trigger_bindings_ready,
        (
          -- Hash complete stored bodies: marker-only checks can be satisfied from dead branches.
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_assert_stage13_stay_conversion_command(text)', '9f9d7311054a9c99b68999dcd799cd662996d0496573cdd783fc747ca1466459'),
                ('qintopia_assert_stage13_stay_conversion_command_v033(text)', '72e08c61c35d33b04001544771f0b3a3c3de51b6c531aa6aeed751d7bbf44f0b'),
                ('qintopia_reject_lodging_funds_after_membership_transfer()', 'b05cc0f8a8d15980d17a6188079afcd1dff96d4f14df7e7957c4a6c2f36005a6'),
                ('qintopia_reject_membership_funds_after_stay_transfer()', '4660b0b24df455e1ce047f8eeca3070216ca85ecf711df6bbcb98e9b2fbcd73d'),
                ('qintopia_require_stage13_conversion_reversal_bridge()', '5f73c20a3019cdc3810ae4484eec1a898e700e954c20d6c6a65fe8493b8f5c2e'),
                ('qintopia_require_transfer_membership_payment_bridge()', '1993430b9a865fa9ab62a4c88dab76e30dc0defc753016726bb1e21ed4920af2'),
                ('qintopia_validate_conversion_consume_entitlement_fact()', '5188d53c790586313970106f3e30f3229ae823fd2dd947baa4b756418e9f13b9'),
                ('qintopia_validate_membership_payment_fact()', '65d0dc1eb83a036c7fa658087105dca9584df028c4003901ec8b2c86db335864'),
                ('qintopia_validate_stage13_stay_conversion_child()', '4d0ef7b2821a7286c2e6bb87fa936b1e6c6fc194e759acf09afe0645d36095b0'),
                ('qintopia_validate_stage13_stay_conversion_execution()', '2b83d1f0c739a4bdc65e3114d0f6ddbcca1ac80a02ede73d687705da946d3f56'),
                ('qintopia_validate_stage13_stay_conversion_membership_order()', '1baf9a5240b34e396eed0aca2da6165adec38227ee672e63623d33a3ad1ecae2'),
                ('qintopia_validate_stay_collection_membership_transfer()', '9611a3ec85ebd0c7e95f9e8136fc89fcb0bd306ca4b0841979ecaae0ef82faf4')
            ) AS expected(signature, body_hash)
            WHERE NOT COALESCE((
              SELECT encode(
                  sha256(convert_to(procedure_row.prosrc, 'UTF8')),
                  'hex'
                ) = expected.body_hash
                AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                AND NOT procedure_row.prosecdef
                AND procedure_row.provolatile = 'v'
                AND procedure_row.proconfig IS NULL
                AND procedure_row.prokind = 'f'
              FROM pg_proc AS procedure_row
              WHERE procedure_row.oid = to_regprocedure(expected.signature)
            ), false)
          )
        ) AS function_bodies_ready
      FROM pg_trigger AS trigger
    `.execute(db);
    return foundationalObjects.rows[0]?.function_count === "5"
      && foundationalObjects.rows[0]?.trigger_count === "13"
      && foundationalObjects.rows[0]?.function_bodies_ready === true
      && foundationalObjects.rows[0]?.membership_order_identity_body_ready === true
      && foundationalObjects.rows[0]?.idempotency_constraint_ready === true
      && foundationalObjects.rows[0]?.membership_payment_append_only_trigger_ready === true
      && foundationalObjects.rows[0]?.membership_order_identity_trigger_ready === true
      && stage10Objects.rows[0]?.function_count === "3"
      && stage10Objects.rows[0]?.deferred_trigger_count === "2"
      && stage10Objects.rows[0]?.immediate_trigger_count === "3"
      && stage11Objects.rows[0]?.function_count === "14"
      && stage11Objects.rows[0]?.replacement_count === "2"
      && stage11Objects.rows[0]?.body_marker_count === "8"
      && stage11Objects.rows[0]?.deferred_trigger_count === "4"
      && stage11Objects.rows[0]?.immediate_trigger_count === "8"
      && collectionFactObjects.rows[0]?.function_count === "1"
      && collectionFactObjects.rows[0]?.trigger_count === "1"
      && collectionFactObjects.rows[0]?.historical_column_count === "1"
      && collectionFactObjects.rows[0]?.body_marker_count === "6"
      && stage12Objects.rows[0]?.function_count === "9"
      && stage12Objects.rows[0]?.deferred_trigger_count === "4"
      && stage12Objects.rows[0]?.immediate_trigger_count === "5"
      && stage12Objects.rows[0]?.status_constraint_count === "2"
      && stage12Objects.rows[0]?.restore_index_count === "1"
      && stage12Objects.rows[0]?.body_marker_count === "6"
      && stage13Objects.rows[0]?.function_count === "12"
      && stage13Objects.rows[0]?.deferred_trigger_count === "9"
      && stage13Objects.rows[0]?.immediate_trigger_count === "6"
      && stage13Objects.rows[0]?.table_count === "1"
      && stage13Objects.rows[0]?.source_column_count === "1"
      && stage13Objects.rows[0]?.critical_constraints_ready === true
      && stage13Objects.rows[0]?.index_count === "4"
      && stage13Objects.rows[0]?.body_marker_count === "13"
      && stage13Objects.rows[0]?.execution_wrapper_body_ready === true
      && stage13Objects.rows[0]?.child_wrapper_body_ready === true
      && stage13Objects.rows[0]?.membership_order_wrapper_body_ready === true
      && stage13Objects.rows[0]?.trigger_bindings_ready === true
      && stage13Objects.rows[0]?.function_bodies_ready === true;
  } catch {
    return false;
  }
}
