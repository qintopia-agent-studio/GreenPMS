import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import {
  administratorCommandGrants,
  commandFeatureEnabled,
  ordinaryStaffCommandGrants
} from "@qintopia/domain";
import type { Database } from "./schema.ts";
import { resolveStaffProfileManifest } from "./staff-profile-manifest.ts";

pg.types.setTypeParser(1082, (value) => value);

export const currentMigrationNames = [
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
  "035_stage13_conversion_execution_state_guards.sql",
  "036_qintopia_prelaunch_room_catalog_corrections.sql",
  "037_member_phone_identity_and_nickname.sql",
  "038_backfill_completed_stay_checkout_guard.sql",
  "039_inhouse_zero_collection_conversion.sql",
  "040_conversion_order_membership_link.sql",
  "041_completed_stay_backfill_atomicity.sql",
  "042_complete_overdue_reserved_stay.sql",
  "043_complete_stay_guard_hardening.sql",
  "044_inhouse_membership_fulfillment_guards.sql",
  "045_stay_membership_net_wecom_transfer.sql",
  "046_command_authorization.sql",
  "047_runtime_database_role.sql",
  "048_runtime_isolation_guards.sql"
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

export interface DatabaseReadyOptions {
  identity?: "runtime" | "maintenance-owner";
  staffProfileManifestName?: string;
}

const expectedStaffProfileCatalog = [
  ...ordinaryStaffCommandGrants.map((commandType) => ({
    profile: "STAFF" as const,
    command_type: commandType,
    token_default: true
  })),
  ...administratorCommandGrants.map((commandType) => ({
    profile: "ADMIN" as const,
    command_type: commandType,
    token_default: commandFeatureEnabled(commandType)
  }))
].sort((left, right) => {
  if (left.profile !== right.profile) return left.profile < right.profile ? -1 : 1;
  if (left.command_type === right.command_type) return 0;
  return left.command_type < right.command_type ? -1 : 1;
});

export async function databaseReady(
  db: DatabaseReadyExecutor,
  options: DatabaseReadyOptions = {}
): Promise<boolean> {
  if (!db.isTransaction) {
    try {
      return await db.transaction().execute(async (trx) => databaseReady(trx, options));
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

    const expectedStaffProfileManifest = resolveStaffProfileManifest(
      options.staffProfileManifestName ?? process.env.STAFF_PROFILE_MANIFEST_NAME
    );

    const reconciliationStates = await db.selectFrom("staff_profile_reconciliation_state")
      .select("singleton")
      .execute();
    if (reconciliationStates.length !== 1) return false;

    const profileCatalog = await db.selectFrom("staff_command_profile_catalog")
      .select(["profile", "command_type", "token_default"])
      .orderBy("profile")
      .orderBy("command_type")
      .execute();
    const profileCatalogReady = profileCatalog.length === expectedStaffProfileCatalog.length
      && profileCatalog.every((row, index) => {
        const expected = expectedStaffProfileCatalog[index];
        return row.profile === expected?.profile
          && row.command_type === expected.command_type
          && row.token_default === expected.token_default;
      });
    if (!profileCatalogReady) return false;

    const runtimeIsolation = await sql<{
      identity_ready: boolean;
      role_ready: boolean;
      memberships_ready: boolean;
      ownership_ready: boolean;
      capabilities_ready: boolean;
      update_privileges_ready: boolean;
      destructive_privileges_ready: boolean;
      profile_assignments_ready: boolean;
      profile_grants_ready: boolean;
      reviewed_manifest_ready: boolean;
      token_policy_ready: boolean;
      reconciliation_state_ready: boolean;
      isolation_objects_ready: boolean;
    }>`
      WITH RECURSIVE
      runtime_role AS (
        SELECT *
        FROM pg_roles
        WHERE rolname = 'qintopia_runtime'
      ),
      database_owner AS (
        SELECT database_row.oid,
          database_row.datdba,
          pg_get_userbyid(database_row.datdba) AS owner_name
        FROM pg_database AS database_row
        WHERE database_row.datname = current_database()
      ),
      inherited_roles(roleid) AS (
        SELECT membership.roleid
        FROM pg_auth_members AS membership
        JOIN runtime_role ON runtime_role.oid = membership.member
        UNION
        SELECT membership.roleid
        FROM pg_auth_members AS membership
        JOIN inherited_roles ON inherited_roles.roleid = membership.member
      ),
      expected_update_columns(table_name, column_name) AS (
        VALUES
          ('web_sessions', 'revoked_at'),
          ('command_executions', 'state'),
          ('command_executions', 'completed_at'),
          ('command_previews', 'status'),
          ('command_previews', 'used_at'),
          ('api_tokens', 'revoked_at'),
          ('api_tokens', 'replaced_by_id'),
          ('subjects', 'created_at'),
          ('subject_property_grants', 'created_at'),
          ('subject_command_grants', 'created_at'),
          ('token_command_ceilings', 'created_at'),
          ('order_occupants', 'created_at'),
          ('membership_orders', 'status'),
          ('membership_orders', 'activated_at'),
          ('membership_orders', 'valid_from'),
          ('membership_orders', 'valid_until'),
          ('membership_orders', 'contract_id'),
          ('membership_orders', 'entitlement_lot_id'),
          ('membership_orders', 'version'),
          ('membership_orders', 'activated_by_command_id'),
          ('membership_orders', 'updated_at'),
          ('member_contracts', 'version'),
          ('entitlement_lots', 'version'),
          ('orders', 'status'),
          ('orders', 'arrival_date'),
          ('orders', 'departure_date'),
          ('orders', 'current_revision_id'),
          ('orders', 'member_id'),
          ('orders', 'member_contract_id'),
          ('orders', 'version'),
          ('orders', 'updated_at'),
          ('stays', 'status'),
          ('coverage_items', 'status'),
          ('coverage_items', 'updated_at'),
          ('inventory_room_days', 'whole_claim_id'),
          ('inventory_room_days', 'version'),
          ('inventory_room_days', 'updated_at'),
          ('inventory_bed_days', 'bed_claim_id'),
          ('inventory_bed_days', 'version'),
          ('inventory_bed_days', 'updated_at'),
          ('inventory_claims', 'active'),
          ('inventory_claims', 'released_at'),
          ('maintenance_locks', 'status'),
          ('maintenance_locks', 'version'),
          ('maintenance_locks', 'released_by_command_id'),
          ('maintenance_locks', 'released_at'),
          ('cleaning_tasks', 'status'),
          ('cleaning_tasks', 'version'),
          ('cleaning_tasks', 'completed_by_command_id'),
          ('cleaning_tasks', 'completed_at'),
          ('room_status_revisions', 'revision'),
          ('room_status_revisions', 'updated_at')
      ),
      actual_update_columns AS (
        SELECT relation.relname::text AS table_name,
          attribute.attname::text AS column_name
        FROM runtime_role
        JOIN pg_class AS relation
          ON relation.relkind IN ('r', 'p')
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
          AND namespace.nspname = 'public'
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        WHERE has_column_privilege(
          runtime_role.oid,
          relation.oid,
          attribute.attnum,
          'UPDATE'
        )
      ),
      reviewed_manifest AS (
        SELECT item."subjectId" AS subject_id,
          item."propertyId" AS property_id,
          item.profile
        FROM jsonb_to_recordset(${JSON.stringify(expectedStaffProfileManifest.entries)}::jsonb)
          AS item("subjectId" text, "propertyId" text, profile text)
      ),
      canonical_manifest AS (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'subjectId', subject_id,
              'propertyId', property_id,
              'profile', profile
            )
            ORDER BY subject_id, property_id
          ),
          '[]'::jsonb
        ) AS value
        FROM reviewed_manifest
      ),
      expected_assignments AS (
        SELECT property_grant.subject_id,
          property_grant.property_id,
          COALESCE(reviewed_manifest.profile, 'STAFF') AS profile
        FROM subject_property_grants AS property_grant
        LEFT JOIN reviewed_manifest
          ON reviewed_manifest.subject_id = property_grant.subject_id
          AND reviewed_manifest.property_id = property_grant.property_id
        WHERE property_grant.access_level = 'WRITE'
      ),
      expected_profile_grants AS (
        SELECT assignment.subject_id,
          assignment.property_id,
          profile_command.command_type
        FROM expected_assignments AS assignment
        JOIN staff_command_profile_catalog AS profile_command
          ON profile_command.profile = assignment.profile
      ),
      expected_historical_grants AS (
        SELECT DISTINCT execution.subject_id,
          execution.property_id,
          regexp_replace(execution.command_type, '^PREVIEW:', '') AS command_type
        FROM command_executions AS execution
        JOIN expected_assignments AS assignment
          ON assignment.subject_id = execution.subject_id
          AND assignment.property_id = execution.property_id
        JOIN command_catalog AS catalog
          ON catalog.command_type = regexp_replace(execution.command_type, '^PREVIEW:', '')
          AND catalog.command_class = 'HISTORICAL_READ'
      ),
      expected_grants AS (
        SELECT * FROM expected_profile_grants
        UNION
        SELECT * FROM expected_historical_grants
      ),
      actual_projection AS (
        SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value
        FROM staff_profile_assignments
        UNION ALL
        SELECT format('G|%s|%s|%s', subject_id, property_id, command_type)
        FROM subject_command_grants
      ),
      actual_projection_hash AS (
        SELECT encode(
          sha256(convert_to(COALESCE(string_agg(row_value, E'\\n' ORDER BY row_value), ''), 'UTF8')),
          'hex'
        ) AS value
        FROM actual_projection
      )
      SELECT
        CASE ${options.identity ?? "runtime"}
          WHEN 'runtime' THEN current_user = 'qintopia_runtime'
            AND session_user = 'qintopia_runtime'
            AND current_setting('search_path') = 'public'
          WHEN 'maintenance-owner' THEN current_user = session_user
            AND current_user = (SELECT owner_name FROM database_owner)
            AND current_user <> 'qintopia_runtime'
          ELSE false
        END AS identity_ready,
        COALESCE((
          SELECT NOT runtime_role.rolsuper
            AND NOT runtime_role.rolinherit
            AND NOT runtime_role.rolcreaterole
            AND NOT runtime_role.rolcreatedb
            AND runtime_role.rolcanlogin
            AND NOT runtime_role.rolreplication
            AND NOT runtime_role.rolbypassrls
            AND COALESCE(runtime_role.rolconfig, ARRAY[]::text[]) = ARRAY['search_path=public']::text[]
            AND NOT EXISTS (
              SELECT 1
              FROM pg_db_role_setting AS role_setting
              JOIN database_owner ON database_owner.oid = role_setting.setdatabase
              WHERE role_setting.setrole = runtime_role.oid
            )
          FROM runtime_role
        ), false) AS role_ready,
        NOT EXISTS (SELECT 1 FROM inherited_roles) AS memberships_ready,
        COALESCE((
          SELECT NOT EXISTS (
            SELECT 1
            FROM pg_shdepend AS dependency
            JOIN database_owner
              ON dependency.dbid = database_owner.oid
              OR (
                dependency.dbid = 0
                AND dependency.classid = 'pg_database'::regclass
                AND dependency.objid = database_owner.oid
              )
            WHERE dependency.refclassid = 'pg_authid'::regclass
              AND dependency.refobjid = runtime_role.oid
              AND dependency.deptype = 'o'
          )
          FROM runtime_role
        ), false) AS ownership_ready,
        COALESCE((
          SELECT has_database_privilege(runtime_role.oid, current_database(), 'CONNECT')
            AND NOT has_database_privilege(runtime_role.oid, current_database(), 'CREATE')
            AND NOT has_database_privilege(runtime_role.oid, current_database(), 'TEMPORARY')
            AND has_schema_privilege(runtime_role.oid, 'public', 'USAGE')
            AND NOT has_schema_privilege(runtime_role.oid, 'public', 'CREATE')
            AND NOT has_parameter_privilege(runtime_role.oid, 'session_replication_role', 'SET')
            AND NOT has_parameter_privilege(runtime_role.oid, 'session_replication_role', 'ALTER SYSTEM')
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_reconcile_staff_profile_manifest(text,jsonb)'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_order_projection_update()'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_mutable_projection_update()'::regprocedure,
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              runtime_role.oid,
              'qintopia_guard_runtime_token_mutation()'::regprocedure,
              'EXECUTE'
            )
          FROM runtime_role
        ), false) AS capabilities_ready,
        NOT EXISTS (
          SELECT * FROM actual_update_columns
          EXCEPT
          SELECT * FROM expected_update_columns
        ) AND NOT EXISTS (
          SELECT * FROM expected_update_columns
          EXCEPT
          SELECT * FROM actual_update_columns
        ) AS update_privileges_ready,
        COALESCE((
          SELECT NOT EXISTS (
            SELECT 1
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
              AND namespace.nspname = 'public'
            WHERE relation.relkind IN ('r', 'p')
              AND (
                has_table_privilege(runtime_role.oid, relation.oid, 'DELETE')
                OR has_table_privilege(runtime_role.oid, relation.oid, 'TRUNCATE')
                OR has_table_privilege(runtime_role.oid, relation.oid, 'TRIGGER')
                OR has_table_privilege(runtime_role.oid, relation.oid, 'REFERENCES')
              )
          )
          FROM runtime_role
        ), false) AS destructive_privileges_ready,
        NOT EXISTS (
          SELECT subject_id, property_id, profile FROM staff_profile_assignments
          EXCEPT
          SELECT subject_id, property_id, profile FROM expected_assignments
        ) AND NOT EXISTS (
          SELECT subject_id, property_id, profile FROM expected_assignments
          EXCEPT
          SELECT subject_id, property_id, profile FROM staff_profile_assignments
        ) AS profile_assignments_ready,
        NOT EXISTS (
          SELECT subject_id, property_id, command_type FROM subject_command_grants
          EXCEPT
          SELECT subject_id, property_id, command_type FROM expected_grants
        ) AND NOT EXISTS (
          SELECT subject_id, property_id, command_type FROM expected_grants
          EXCEPT
          SELECT subject_id, property_id, command_type FROM subject_command_grants
        ) AS profile_grants_ready,
        NOT EXISTS (
          SELECT 1
          FROM reviewed_manifest
          LEFT JOIN expected_assignments
            ON expected_assignments.subject_id = reviewed_manifest.subject_id
            AND expected_assignments.property_id = reviewed_manifest.property_id
            AND expected_assignments.profile = reviewed_manifest.profile
          WHERE expected_assignments.subject_id IS NULL
        ) AS reviewed_manifest_ready,
        NOT EXISTS (
          SELECT 1
          FROM token_command_ceilings AS ceiling
          LEFT JOIN api_tokens AS token
            ON token.id = ceiling.token_id
            AND token.subject_id = ceiling.subject_id
            AND token.property_scope = ceiling.property_id
          LEFT JOIN subjects AS subject_row
            ON subject_row.id = ceiling.subject_id
          LEFT JOIN subject_property_grants AS property_grant
            ON property_grant.subject_id = ceiling.subject_id
            AND property_grant.property_id = ceiling.property_id
          LEFT JOIN command_catalog AS catalog
            ON catalog.command_type = ceiling.command_type
          WHERE token.id IS NULL
            OR subject_row.id IS NULL
            OR property_grant.subject_id IS NULL
            OR property_grant.access_level <> 'WRITE'
            OR catalog.command_type IS NULL
            OR token.access_ceiling <> 'WRITE'
            OR NOT (
              catalog.command_class = 'HISTORICAL_READ'
              OR (
                catalog.command_class = 'HUMAN_COMMAND'
                AND EXISTS (
                  SELECT 1
                  FROM staff_profile_assignments AS assignment
                  JOIN staff_command_profile_catalog AS profile_command
                    ON profile_command.profile = assignment.profile
                    AND profile_command.command_type = ceiling.command_type
                    AND profile_command.token_default
                  WHERE assignment.subject_id = ceiling.subject_id
                    AND assignment.property_id = ceiling.property_id
                )
              )
            )
            OR NOT EXISTS (
              SELECT 1
              FROM expected_grants
              WHERE expected_grants.subject_id = ceiling.subject_id
                AND expected_grants.property_id = ceiling.property_id
                AND expected_grants.command_type = ceiling.command_type
            )
        ) AS token_policy_ready,
        EXISTS (
          SELECT 1
          FROM staff_profile_reconciliation_state AS state
          CROSS JOIN canonical_manifest
          CROSS JOIN actual_projection_hash
          CROSS JOIN database_owner
          WHERE state.singleton
            AND state.manifest_name = ${expectedStaffProfileManifest.name}
            AND state.manifest_hash = encode(
              sha256(convert_to(canonical_manifest.value::text, 'UTF8')),
              'hex'
            )
            AND state.projection_hash = actual_projection_hash.value
            AND state.reconciled_by = database_owner.owner_name
        ) AS reconciliation_state_ready,
        (
          COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                'fe886ce2bf56de9b4b36b4931bded39e6fac66b89b3fe51d82d6150356fd52ee'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_reconcile_staff_profile_manifest(text,jsonb)')
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                '3e4349ac6cad620f37a0b03f16f14d283a3617226068f5f2a5b02f3827dcb39a'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_order_projection_update()')
          ), false)
          AND COALESCE((
            SELECT NOT trigger.tgisinternal
              AND trigger.tgenabled IN ('O', 'A')
              AND trigger.tgdeferrable
              AND trigger.tginitdeferred
              AND trigger.tgnargs = 0
              AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_order_projection_update()')
              AND pg_get_triggerdef(trigger.oid, false) =
                'CREATE CONSTRAINT TRIGGER orders_runtime_projection_guard AFTER UPDATE ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_order_projection_update()'
            FROM pg_trigger AS trigger
            WHERE trigger.tgrelid = to_regclass('orders')
              AND trigger.tgname = 'orders_runtime_projection_guard'
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                '092ae1bb31ab8cd2b854e26f76fd58ab896d29a8dfb3393bc73a43d80038d5fe'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_token_mutation()')
          ), false)
          AND COALESCE((
            SELECT NOT trigger.tgisinternal
              AND trigger.tgenabled IN ('O', 'A')
              AND trigger.tgdeferrable
              AND trigger.tginitdeferred
              AND trigger.tgnargs = 0
              AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_token_mutation()')
              AND pg_get_triggerdef(trigger.oid, false) =
                'CREATE CONSTRAINT TRIGGER api_tokens_runtime_token_mutation_guard AFTER INSERT OR UPDATE ON public.api_tokens DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()'
            FROM pg_trigger AS trigger
            WHERE trigger.tgrelid = to_regclass('api_tokens')
              AND trigger.tgname = 'api_tokens_runtime_token_mutation_guard'
          ), false)
          AND COALESCE((
            SELECT NOT trigger.tgisinternal
              AND trigger.tgenabled IN ('O', 'A')
              AND trigger.tgdeferrable
              AND trigger.tginitdeferred
              AND trigger.tgnargs = 0
              AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_token_mutation()')
              AND pg_get_triggerdef(trigger.oid, false) =
                'CREATE CONSTRAINT TRIGGER token_command_ceilings_runtime_token_mutation_guard AFTER INSERT ON public.token_command_ceilings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()'
            FROM pg_trigger AS trigger
            WHERE trigger.tgrelid = to_regclass('token_command_ceilings')
              AND trigger.tgname = 'token_command_ceilings_runtime_token_mutation_guard'
          ), false)
          AND COALESCE((
            SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex') =
                '336e30e78aa3518a116126f27dcaa5b0c943e85fa0903c42fbb96342e262954c'
              AND procedure_row.proowner = database_owner.datdba
              AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
              AND NOT procedure_row.prosecdef
              AND procedure_row.provolatile = 'v'
              AND procedure_row.prokind = 'f'
              AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
            FROM pg_proc AS procedure_row
            CROSS JOIN database_owner
            WHERE procedure_row.oid = to_regprocedure('qintopia_guard_runtime_mutable_projection_update()')
          ), false)
          AND COALESCE((
            SELECT count(*) = 11
              AND bool_and(
                NOT trigger.tgisinternal
                AND trigger.tgenabled IN ('O', 'A')
                AND trigger.tgdeferrable
                AND trigger.tginitdeferred
                AND trigger.tgnargs = 0
                AND trigger.tgfoid = to_regprocedure('qintopia_guard_runtime_mutable_projection_update()')
                AND pg_get_triggerdef(trigger.oid, false) = format(
                  'CREATE CONSTRAINT TRIGGER %s AFTER UPDATE ON public.%s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update()',
                  expected.trigger_name,
                  expected.table_name
                )
              )
            FROM (VALUES
              ('membership_orders', 'membership_orders_runtime_projection_guard'),
              ('member_contracts', 'member_contracts_runtime_projection_guard'),
              ('entitlement_lots', 'entitlement_lots_runtime_projection_guard'),
              ('stays', 'stays_runtime_projection_guard'),
              ('coverage_items', 'coverage_items_runtime_projection_guard'),
              ('inventory_room_days', 'inventory_room_days_runtime_projection_guard'),
              ('inventory_bed_days', 'inventory_bed_days_runtime_projection_guard'),
              ('inventory_claims', 'inventory_claims_runtime_projection_guard'),
              ('maintenance_locks', 'maintenance_locks_runtime_projection_guard'),
              ('cleaning_tasks', 'cleaning_tasks_runtime_projection_guard'),
              ('room_status_revisions', 'room_status_revisions_runtime_projection_guard')
            ) AS expected(table_name, trigger_name)
            JOIN pg_trigger AS trigger
              ON trigger.tgrelid = to_regclass(expected.table_name)
              AND trigger.tgname = expected.trigger_name
          ), false)
        ) AS isolation_objects_ready
    `.execute(db);

    const runtimeIsolationReady = runtimeIsolation.rows[0];
    if (!runtimeIsolationReady
      || !runtimeIsolationReady.identity_ready
      || !runtimeIsolationReady.role_ready
      || !runtimeIsolationReady.memberships_ready
      || !runtimeIsolationReady.ownership_ready
      || !runtimeIsolationReady.capabilities_ready
      || !runtimeIsolationReady.update_privileges_ready
      || !runtimeIsolationReady.destructive_privileges_ready
      || !runtimeIsolationReady.profile_assignments_ready
      || !runtimeIsolationReady.profile_grants_ready
      || !runtimeIsolationReady.reviewed_manifest_ready
      || !runtimeIsolationReady.token_policy_ready
      || !runtimeIsolationReady.reconciliation_state_ready
      || !runtimeIsolationReady.isolation_objects_ready) {
      return false;
    }

    const memberProfileObjects = await sql<{
      columns_ready: boolean;
      constraints_ready: boolean;
      trigger_ready: boolean;
      function_body_ready: boolean;
    }>`
      SELECT
        (
          COALESCE((
            SELECT NOT attribute.attnotnull
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('members')
              AND attribute.attname = 'identity_card_number'
          ), false)
          AND COALESCE((
            SELECT attribute.attnotnull
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('members')
              AND attribute.attname = 'nickname'
          ), false)
          AND COALESCE((
            SELECT attribute.attnotnull
              AND attribute.atttypid = 'text'::regtype
              AND NOT attribute.attisdropped
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('members')
              AND attribute.attname = 'phone'
          ), false)
        ) AS columns_ready,
        (
          COALESCE((
            SELECT constraint_row.contype = 'u'
              AND constraint_row.convalidated
              AND constraint_row.conkey = ARRAY[
                (SELECT attnum FROM pg_attribute
                  WHERE attrelid = to_regclass('members') AND attname = 'phone')
              ]::smallint[]
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.conname = 'members_phone_unique'
          ), false)
          AND NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.contype = 'u'
              AND constraint_row.conkey = ARRAY[
                (SELECT attnum FROM pg_attribute
                  WHERE attrelid = to_regclass('members') AND attname = 'identity_card_number')
              ]::smallint[]
          )
          AND COALESCE((
            SELECT constraint_row.contype = 'c'
              AND constraint_row.convalidated
              AND position('identity_card_number IS NULL' IN pg_get_constraintdef(constraint_row.oid, false)) > 0
              AND position('identity_card_number !~' IN pg_get_constraintdef(constraint_row.oid, false)) > 0
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.conname = 'members_identity_card_number_nonblank'
          ), false)
          AND COALESCE((
            SELECT constraint_row.contype = 'c'
              AND constraint_row.convalidated
              AND position('nickname !~' IN pg_get_constraintdef(constraint_row.oid, false)) > 0
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = to_regclass('members')
              AND constraint_row.conname = 'members_nickname_nonblank'
          ), false)
        ) AS constraints_ready,
        COALESCE((
          SELECT NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgnargs = 0
            AND trigger.tgfoid = to_regprocedure('qintopia_normalize_new_member_identity()')
            AND pg_get_triggerdef(trigger.oid, false) =
              'CREATE TRIGGER members_normalize_new_identity BEFORE INSERT OR UPDATE OF identity_card_number, phone, nickname ON public.members FOR EACH ROW EXECUTE FUNCTION qintopia_normalize_new_member_identity()'
          FROM pg_trigger AS trigger
          WHERE trigger.tgrelid = to_regclass('members')
            AND trigger.tgname = 'members_normalize_new_identity'
        ), false) AS trigger_ready,
        COALESCE((
          SELECT regexp_replace(
              btrim(procedure_row.prosrc),
              '[[:space:]]+',
              ' ',
              'g'
            ) = regexp_replace(
              btrim($readiness$
                BEGIN
                  IF NEW.identity_card_number IS NOT NULL THEN
                    NEW.identity_card_number := upper(btrim(NEW.identity_card_number));
                  END IF;
                  NEW.phone := regexp_replace(NEW.phone, '[[:space:]]+', '', 'g');
                  NEW.nickname := btrim(NEW.nickname);
                  RETURN NEW;
                END;
              $readiness$),
              '[[:space:]]+',
              ' ',
              'g'
            )
            AND procedure_row.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND NOT procedure_row.prosecdef
            AND procedure_row.provolatile = 'v'
            AND procedure_row.proconfig IS NULL
            AND procedure_row.prokind = 'f'
          FROM pg_proc AS procedure_row
          WHERE procedure_row.oid = to_regprocedure('qintopia_normalize_new_member_identity()')
        ), false) AS function_body_ready
    `.execute(db);

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
      trigger_bindings_ready: boolean;
      function_bodies_ready: boolean;
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
            AND trigger.tgnargs = 0
            AND trigger.tgqual IS NULL
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
        )::text AS body_marker_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES (
                'collection_facts',
                'collection_facts_validate_new_transaction_reference',
                'CREATE TRIGGER collection_facts_validate_new_transaction_reference BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_transaction_reference()'
              )
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
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_validate_new_collection_fact_transaction_reference()', '424dd22174300cf686be9422dd8b9b42ef4e7f48fa0266f504bf6f4316dabbe3')
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
    const completedStayBackfillObjects = await sql<{
      cash_column_count: string;
      cash_constraint_count: string;
      cash_function_count: string;
      cash_trigger_count: string;
      cash_body_marker_count: string;
      checkout_body_marker_count: string;
    }>`
      SELECT
        (
          SELECT count(*)::text
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = to_regclass('collection_facts')
            AND attribute.attname = 'cash_collector'
            AND attribute.atttypid = 'text'::regtype
            AND NOT attribute.attnotnull
            AND NOT attribute.attisdropped
        ) AS cash_column_count,
        (
          SELECT count(*)::text
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = to_regclass('collection_facts')
            AND constraint_row.conname = 'collection_facts_cash_collector_nonblank'
            AND constraint_row.contype = 'c'
            AND pg_get_constraintdef(constraint_row.oid, false)
              = 'CHECK (((cash_collector IS NULL) OR (btrim(cash_collector) <> ''''::text)))'
        ) AS cash_constraint_count,
        (to_regprocedure('qintopia_validate_backfill_cash_collection()') IS NOT NULL)::integer::text
          AS cash_function_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgenabled IN ('O','A')
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgtype = 7
            AND trigger.tgrelid = to_regclass('collection_facts')
            AND trigger.tgname = 'collection_facts_validate_backfill_cash'
            AND trigger.tgfoid = to_regprocedure('qintopia_validate_backfill_cash_collection()')
        )::text AS cash_trigger_count,
        (
          COALESCE(position('collection_facts_backfill_cash_collector_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_backfill_cash_collection()'))) > 0, false)::integer
          + COALESCE(position('collection_facts_backfill_cash_note_required'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_backfill_cash_collection()'))) > 0, false)::integer
        )::text AS cash_body_marker_count,
        (
          COALESCE(position('amendments_backfill_create_order_checkout_chain'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
          + COALESCE(position('execution_type = ''CREATE_ORDER'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
          + COALESCE(position('created.reason_code = ''BACKFILL_STAY'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
          + COALESCE(position('checked_in.amendment_type = ''CHECK_IN'''
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_checkout_bypass()'))) > 0, false)::integer
        )::text AS checkout_body_marker_count
      FROM pg_trigger AS trigger
    `.execute(db);
    const completeStayGuardObjects = await sql<{
      function_bodies_ready: boolean;
      fulfillment_index_ready: boolean;
      trigger_bindings_ready: boolean;
    }>`
      SELECT
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_reject_stage10_checkout_bypass()', '620a6560ed68e60617bd70e1a8581c65c94ce2ce098397f9af0110cecd086b33'),
                ('qintopia_validate_complete_stay_execution_chain()', '6e56cb43654dada83fa420d23370558fd22e877b868178d227630bd36640b639'),
                ('qintopia_validate_backfill_cash_collection()', '1c3ccea500c20ba6837d7222a7558a1d83fb65a85f56fcaa17a38e0c48e8dd5f')
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
        ) AS function_bodies_ready,
        EXISTS (
          SELECT 1
          FROM pg_index AS index_row
          WHERE index_row.indexrelid = to_regclass('amendments_one_fulfillment_type_per_command')
            AND index_row.indrelid = to_regclass('amendments')
            AND index_row.indisunique
            AND index_row.indimmediate
            AND index_row.indisvalid
            AND index_row.indisready
            AND pg_get_indexdef(index_row.indexrelid, 0, false)
              = 'CREATE UNIQUE INDEX amendments_one_fulfillment_type_per_command ON public.amendments USING btree (command_id, amendment_type) WHERE ((command_id IS NOT NULL) AND (amendment_type = ANY (ARRAY[''CHECK_IN''::text, ''CHECK_OUT''::text])))'
        ) AS fulfillment_index_ready,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('amendments', 'amendments_complete_stay_exact_pair',
                  'CREATE CONSTRAINT TRIGGER amendments_complete_stay_exact_pair AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain()'),
                ('command_executions', 'command_executions_complete_stay_exact_pair',
                  'CREATE CONSTRAINT TRIGGER command_executions_complete_stay_exact_pair AFTER INSERT OR UPDATE ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain()')
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
        ) AS trigger_bindings_ready
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
          + (to_regprocedure('qintopia_validate_new_collection_fact_shape()') IS NOT NULL)::integer
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
              OR (trigger.tgrelid = to_regclass('collection_facts')
                AND trigger.tgname = 'collection_facts_validate_new_write_shape'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_new_collection_fact_shape()'))
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
          + COALESCE(position('target_membership_order.created_by_command_id = NEW.command_id'
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
                  'CREATE TRIGGER entitlement_ledger_validate_conversion_consume BEFORE INSERT ON public.entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_validate_conversion_consume_entitlement_fact()'),
                ('collection_facts', 'collection_facts_validate_new_write_shape',
                  'CREATE TRIGGER collection_facts_validate_new_write_shape BEFORE INSERT ON public.collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_shape()')
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
                ('qintopia_assert_stage13_stay_conversion_command_v033(text)', '9d28e833682d7dd7a62b198b1f49a8760a3ca7b3ee4e916585550034fd5aba35'),
                ('qintopia_reject_lodging_funds_after_membership_transfer()', 'bf22eef1c8964fbe29e7bf5054b64b2fa85ce7cb2ae90bbf9e0102412669c3bd'),
                ('qintopia_reject_membership_funds_after_stay_transfer()', '99e9a57e0f4d7a9f48936eafd26dd809e892bbfc8c76d026a05871ccb23ffc24'),
                ('qintopia_require_stage13_conversion_reversal_bridge()', '5f73c20a3019cdc3810ae4484eec1a898e700e954c20d6c6a65fe8493b8f5c2e'),
                ('qintopia_require_transfer_membership_payment_bridge()', '1993430b9a865fa9ab62a4c88dab76e30dc0defc753016726bb1e21ed4920af2'),
                ('qintopia_validate_conversion_consume_entitlement_fact()', '1e8d4b1b3754ee3c4962c080d6a01d8299f1a7a8f2df89bb22487108c45adefd'),
                ('qintopia_validate_membership_payment_fact()', 'cce1edb6109475403047b936d164c8cb18b6577b9078c6c398c25ce0f22a41c1'),
                ('qintopia_validate_stage13_stay_conversion_child()', '4d0ef7b2821a7286c2e6bb87fa936b1e6c6fc194e759acf09afe0645d36095b0'),
                ('qintopia_validate_stage13_stay_conversion_execution()', '2b83d1f0c739a4bdc65e3114d0f6ddbcca1ac80a02ede73d687705da946d3f56'),
                ('qintopia_validate_stage13_stay_conversion_membership_order()', '1baf9a5240b34e396eed0aca2da6165adec38227ee672e63623d33a3ad1ecae2'),
                ('qintopia_validate_stay_collection_membership_transfer()', '1772cb165a798ee6dbf5d4c7c7a04c4b32e0bc40e27fb147235335f4c0c8b34b'),
                ('qintopia_validate_new_collection_fact_shape()', '0922bb880a362c3fa315ef44c9cb20f8edc855263bcc03d4fb537bad3e2d8977')
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
    const inHouseMembershipFulfillmentObjects = await sql<{
      function_count: string;
      index_ready: boolean;
      coverage_trigger_count: string;
      deferred_trigger_count: string;
      trigger_bindings_ready: boolean;
      body_marker_count: string;
      function_bodies_ready: boolean;
    }>`
      SELECT
        (
          (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_coverage_ownership()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_protect_coverage_identity()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_stage10_entitlement_write()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_coverage_lifecycle_state()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_converted_stay_fulfillment_execution()') IS NOT NULL)::integer
          + (to_regprocedure('qintopia_validate_converted_stay_fulfillment_child()') IS NOT NULL)::integer
        )::text AS function_count,
        EXISTS (
          SELECT 1
          FROM pg_index AS index_row
          WHERE index_row.indexrelid = to_regclass('amendments_one_membership_conversion_per_order_idx')
            AND index_row.indrelid = to_regclass('amendments')
            AND index_row.indisunique
            AND index_row.indimmediate
            AND index_row.indisvalid
            AND index_row.indisready
            AND index_row.indexprs IS NULL
            AND index_row.indnkeyatts = 1
            AND index_row.indnatts = 1
            AND position('(order_id)' IN pg_get_indexdef(index_row.indexrelid)) > 0
            AND regexp_replace(
              pg_get_expr(index_row.indpred, index_row.indrelid),
              '[[:space:]()]',
              '',
              'g'
            ) = 'amendment_type=''CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP''::text'
        ) AS index_ready,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND NOT trigger.tgdeferrable
            AND NOT trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgnargs = 0
            AND trigger.tgqual IS NULL
            AND (
              (trigger.tgrelid = to_regclass('coverage_items')
                AND trigger.tgname = 'coverage_items_protect_identity'
                AND trigger.tgtype = 31
                AND trigger.tgfoid = to_regprocedure('qintopia_protect_coverage_identity()'))
              OR (trigger.tgrelid = to_regclass('coverage_items')
                AND trigger.tgname = 'coverage_items_validate_ownership'
                AND trigger.tgtype = 7
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_coverage_ownership()'))
            )
        )::text AS coverage_trigger_count,
        count(*) FILTER (
          WHERE NOT trigger.tgisinternal
            AND trigger.tgdeferrable
            AND trigger.tginitdeferred
            AND trigger.tgenabled IN ('O','A')
            AND trigger.tgnargs = 0
            AND (
              (trigger.tgrelid = to_regclass('command_executions')
                AND trigger.tgname = 'command_executions_validate_converted_stay_fulfillment'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_converted_stay_fulfillment_execution()'))
              OR (trigger.tgrelid = to_regclass('coverage_items')
                AND trigger.tgname = 'coverage_items_validate_lifecycle_state'
                AND trigger.tgtype = 21
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_coverage_lifecycle_state()'))
              OR (trigger.tgrelid = to_regclass('amendments')
                AND trigger.tgname = 'amendments_validate_converted_stay_fulfillment'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_converted_stay_fulfillment_child()'))
              OR (trigger.tgrelid = to_regclass('entitlement_ledger')
                AND trigger.tgname = 'entitlement_ledger_validate_converted_stay_fulfillment'
                AND trigger.tgtype = 5
                AND trigger.tgfoid = to_regprocedure('qintopia_validate_converted_stay_fulfillment_child()'))
            )
        )::text AS deferred_trigger_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('command_executions', 'command_executions_validate_converted_stay_fulfillment',
                  'CREATE CONSTRAINT TRIGGER command_executions_validate_converted_stay_fulfillment AFTER INSERT OR UPDATE OF state ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_execution()'),
                ('coverage_items', 'coverage_items_validate_lifecycle_state',
                  'CREATE CONSTRAINT TRIGGER coverage_items_validate_lifecycle_state AFTER INSERT OR UPDATE OF status ON public.coverage_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_coverage_lifecycle_state()'),
                ('amendments', 'amendments_validate_converted_stay_fulfillment',
                  'CREATE CONSTRAINT TRIGGER amendments_validate_converted_stay_fulfillment AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_child()'),
                ('entitlement_ledger', 'entitlement_ledger_validate_converted_stay_fulfillment',
                  'CREATE CONSTRAINT TRIGGER entitlement_ledger_validate_converted_stay_fulfillment AFTER INSERT ON public.entitlement_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.command_id IS NOT NULL)) EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_child()')
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
          COALESCE(position('restoredFutureCoverageDates'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))) > 0, false)::integer
          + COALESCE(position('booking.current_revision_id = revision.id'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_ownership()'))) > 0, false)::integer
          + COALESCE(position('coverage_conversion_consumed_insert'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_coverage_identity()'))) > 0, false)::integer
          + COALESCE(position('coverage_status_typed_transition'
            IN pg_get_functiondef(to_regprocedure('qintopia_protect_coverage_identity()'))) > 0, false)::integer
          + COALESCE(position('convertedMembershipCoveragePreserved'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer
          + COALESCE(position('SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_stage10_entitlement_write()'))) > 0, false)::integer
          + COALESCE(position('entitlement_ledger_restore_command'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_entitlement_lifecycle_fact()'))) > 0, false)::integer
          + COALESCE(position('coverage_items_lifecycle_conserved'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_coverage_lifecycle_state()'))) > 0, false)::integer
          + COALESCE(position('typed future-stay restoration'
            IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_consumed_coverage()'))) > 0, false)::integer
          + COALESCE(position('entitlement_ledger_conversion_consume_shape'
            IN pg_get_functiondef(to_regprocedure('qintopia_validate_conversion_consume_entitlement_fact()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_initial_lodging_fund_shape'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_lodging_funds_after_membership_transfer()'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_membership_funds_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_reject_membership_funds_after_stay_transfer()'))) > 0, false)::integer
          + COALESCE(position('target_membership_order.agreed_price_minor <= 0'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_zero_transfer_funds'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('stage13_conversion_inhouse_coverage'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_membership_binding'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_entitlement_balance'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_extend_entitlement_graph'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_shorten_entitlement_graph'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_move_entitlement_graph'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_current_coverage'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_move_marker'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_shorten_marker'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('converted_stay_ordinary_action_closed'
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
          + COALESCE(position('coverage.status = ''HELD'''
            IN pg_get_functiondef(to_regprocedure('qintopia_assert_converted_stay_fulfillment_command(text)'))) > 0, false)::integer
        )::text AS body_marker_count,
        (
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              VALUES
                ('qintopia_assert_stage10_shorten_combination(text)', 'a9ea4fc40b6f4e204db8b9c9ec05869b493f5220c389bbd6443ee355cc30db4b'),
                ('qintopia_validate_coverage_ownership()', '4c4693e86174f88262a9ab6cefef660f0d09609abaf4ff096c0b7a5778d4b664'),
                ('qintopia_protect_coverage_identity()', 'b8eb365fa29712bfe2c26b9c8dfe17a87bdcd0091b012af88a5bb328b5af0750'),
                ('qintopia_reject_stage10_entitlement_write()', 'd3450f298724fa9df85d09cc89175acf4d4cccb837963839b61dddbaac22756f'),
                ('qintopia_validate_entitlement_lifecycle_fact()', 'c03dac8f3f8571b9908fb95929f91fa7ea6386b78af1e19aa7127c54ca65ab35'),
                ('qintopia_validate_coverage_lifecycle_state()', '5cf2df24f2cbd33405d7289b424c972a37140ddf2418660fbbf70527b0adbc5f'),
                ('qintopia_assert_stage11_move_combination(text)', 'c86f1de759ca3cef115c0e96bcffbe80aa9057c377b897088bc8ac286e6f12a3'),
                ('qintopia_preserve_stage11_consumed_coverage()', '7152466eed2e839a9be9e38464e0fef91d5e615246f21dd372c7d487295dde58'),
                ('qintopia_validate_conversion_consume_entitlement_fact()', '1e8d4b1b3754ee3c4962c080d6a01d8299f1a7a8f2df89bb22487108c45adefd'),
                ('qintopia_reject_lodging_funds_after_membership_transfer()', 'bf22eef1c8964fbe29e7bf5054b64b2fa85ce7cb2ae90bbf9e0102412669c3bd'),
                ('qintopia_reject_membership_funds_after_stay_transfer()', '99e9a57e0f4d7a9f48936eafd26dd809e892bbfc8c76d026a05871ccb23ffc24'),
                ('qintopia_assert_stage13_stay_conversion_command_v033(text)', '9d28e833682d7dd7a62b198b1f49a8760a3ca7b3ee4e916585550034fd5aba35'),
                ('qintopia_assert_converted_stay_fulfillment_command(text)', '7b22fe62a3610462c82a4a54f95d62e478996454dfc312ff8e90c189dfa222a0'),
                ('qintopia_validate_converted_stay_fulfillment_execution()', 'ed58ceb0d44795151d23b34912bf90809ca7f2e370b41d9f07b564a71c8404ce'),
                ('qintopia_validate_converted_stay_fulfillment_child()', 'a4a789b5bbb5ad99fd7b6fd8aa38528f6bcc6f4851ea0e7f550f7d28d965733c')
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
    return memberProfileObjects.rows[0]?.columns_ready === true
      && memberProfileObjects.rows[0]?.constraints_ready === true
      && memberProfileObjects.rows[0]?.trigger_ready === true
      && memberProfileObjects.rows[0]?.function_body_ready === true
      && foundationalObjects.rows[0]?.function_count === "5"
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
      && collectionFactObjects.rows[0]?.trigger_bindings_ready === true
      && collectionFactObjects.rows[0]?.function_bodies_ready === true
      && completedStayBackfillObjects.rows[0]?.cash_column_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_constraint_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_function_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_trigger_count === "1"
      && completedStayBackfillObjects.rows[0]?.cash_body_marker_count === "2"
      && completedStayBackfillObjects.rows[0]?.checkout_body_marker_count === "4"
      && completeStayGuardObjects.rows[0]?.function_bodies_ready === true
      && completeStayGuardObjects.rows[0]?.fulfillment_index_ready === true
      && completeStayGuardObjects.rows[0]?.trigger_bindings_ready === true
      && stage12Objects.rows[0]?.function_count === "9"
      && stage12Objects.rows[0]?.deferred_trigger_count === "4"
      && stage12Objects.rows[0]?.immediate_trigger_count === "5"
      && stage12Objects.rows[0]?.status_constraint_count === "2"
      && stage12Objects.rows[0]?.restore_index_count === "1"
      && stage12Objects.rows[0]?.body_marker_count === "6"
      && stage13Objects.rows[0]?.function_count === "13"
      && stage13Objects.rows[0]?.deferred_trigger_count === "9"
      && stage13Objects.rows[0]?.immediate_trigger_count === "7"
      && stage13Objects.rows[0]?.table_count === "1"
      && stage13Objects.rows[0]?.source_column_count === "1"
      && stage13Objects.rows[0]?.critical_constraints_ready === true
      && stage13Objects.rows[0]?.index_count === "4"
      && stage13Objects.rows[0]?.body_marker_count === "13"
      && stage13Objects.rows[0]?.execution_wrapper_body_ready === true
      && stage13Objects.rows[0]?.child_wrapper_body_ready === true
      && stage13Objects.rows[0]?.membership_order_wrapper_body_ready === true
      && stage13Objects.rows[0]?.trigger_bindings_ready === true
      && stage13Objects.rows[0]?.function_bodies_ready === true
      && inHouseMembershipFulfillmentObjects.rows[0]?.function_count === "15"
      && inHouseMembershipFulfillmentObjects.rows[0]?.index_ready === true
      && inHouseMembershipFulfillmentObjects.rows[0]?.coverage_trigger_count === "2"
      && inHouseMembershipFulfillmentObjects.rows[0]?.deferred_trigger_count === "4"
      && inHouseMembershipFulfillmentObjects.rows[0]?.trigger_bindings_ready === true
      && inHouseMembershipFulfillmentObjects.rows[0]?.body_marker_count === "25"
      && inHouseMembershipFulfillmentObjects.rows[0]?.function_bodies_ready === true;
  } catch {
    return false;
  }
}
