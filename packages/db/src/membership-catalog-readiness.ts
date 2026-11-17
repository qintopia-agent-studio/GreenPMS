import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
/** Verify the privileged write boundary and immutable snapshots against migration 083. */
export async function membershipCatalogReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, hash, definer, volatility, runtime) AS (VALUES
      ('qintopia_membership_version_catalog_guard()', '93a63b1407f61adb4e00feeda66144d630515c00a78db069280168c41067273f',false,'v',false),
      ('qintopia_initialize_membership_catalog(text)', '02a8c19d9a6dfa76548e8a3e3a95cd6e1a7a0c33137a874d89f481485575dac9',false,'v',false),
      ('qintopia_membership_valid_until(date,text)', 'c7c5120c951bd545a8b4c2d6b1e945f003b4dc202202c1273beb1304ac977be3',false,'i',true),
      ('qintopia_membership_catalog_identity()', '8080a94f9cfe49618e918398895ea3c0a1c9091a29401c31bd0e4381f5559ed8',false,'v',false),
      ('qintopia_membership_validity_snapshot_guard()', '5f301a7bce0621ea4eb0ce8f3a31d3834657384a83155b9e029747f085e9c6f4',false,'v',false),
      ('qintopia_membership_validity_valid(text)', '90a80e9988ef906f6641d3ef8fc403ca9476746b682c647ceae54ccd34815a67',false,'i',true),
      ('qintopia_apply_membership_catalog(text,jsonb,text)', 'bdac43627f76b7d3836ab38ba7fda35214963d87b79d1d3fb9b3ac2c09c3ad7c',true,'v',true),
      ('qintopia_membership_catalog_commit_guard()', '93650ec399af471655fa4f7a039b1d8bf8078a76c1ab8512048f0690a8d101cd',false,'v',false)
    ) SELECT NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc p ON p.oid=to_regprocedure(signature)
      WHERE p.oid IS NULL OR encode(sha256(convert_to(prosrc,'UTF8')),'hex') <> hash
        OR prosecdef IS DISTINCT FROM definer OR provolatile::text <> volatility OR prokind <> 'f'
        OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        OR proowner <> (SELECT datdba FROM pg_database WHERE datname=current_database())
        OR has_function_privilege('public',p.oid,'EXECUTE')
        OR has_function_privilege('qintopia_runtime',p.oid,'EXECUTE') IS DISTINCT FROM runtime
    ) AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('membership_product_catalog'),('membership_catalog_changes')) t(name)
      WHERE NOT has_table_privilege('qintopia_runtime',name,'SELECT')
        OR has_table_privilege('qintopia_runtime',name,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    ) AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('membership_products','membership_version_catalog_guard','qintopia_membership_version_catalog_guard()',true),
        ('membership_product_catalog','membership_catalog_identity','qintopia_membership_catalog_identity()',false),
        ('membership_orders','membership_orders_validity_snapshot','qintopia_membership_validity_snapshot_guard()',false),
        ('historical_membership_backfills','historical_membership_backfills_validity_snapshot','qintopia_membership_validity_snapshot_guard()',false),
        ('membership_catalog_changes','membership_catalog_changes_append_only','qintopia_prevent_fact_mutation()',false),
        ('membership_catalog_changes','membership_catalog_changes_commit_guard','qintopia_membership_catalog_commit_guard()',true),
        ('command_executions','command_executions_membership_catalog_guard','qintopia_membership_catalog_commit_guard()',true)
      ) expected(relation,name,routine,deferred)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(relation) AND tgname=name
        AND tgfoid=to_regprocedure(routine) AND tgenabled IN ('O','A') AND tgdeferrable=deferred AND tginitdeferred=deferred
        AND tgtype = CASE WHEN name='command_executions_membership_catalog_guard' THEN 21
          WHEN name IN ('membership_version_catalog_guard','membership_catalog_changes_commit_guard') THEN 5
          WHEN name IN ('membership_catalog_identity','membership_catalog_changes_append_only') THEN 27 ELSE 23 END)
    ) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='membership_orders'
      AND column_name='validity_period' AND is_nullable='NO' AND column_default='''P1Y''::text')
    AND NOT EXISTS (SELECT 1 FROM (VALUES ('membership_orders'),('membership_products'),('historical_membership_backfills')) t(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(t.name) AND conname=t.name||'_validity_period_check'
        AND convalidated AND pg_get_constraintdef(oid)='CHECK (qintopia_membership_validity_valid(validity_period))'))
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='membership_product_catalog'::regclass AND contype='f' AND convalidated
      AND pg_get_constraintdef(oid)='FOREIGN KEY (current_product_id, code) REFERENCES membership_products(id, code)')
    AND EXISTS (SELECT 1 FROM command_catalog WHERE command_type='MANAGE_MEMBERSHIP_CATALOG' AND command_class='HUMAN_COMMAND')
    AND EXISTS (SELECT 1 FROM staff_command_profile_catalog WHERE profile='ADMIN' AND command_type='MANAGE_MEMBERSHIP_CATALOG' AND NOT token_default)
    AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
