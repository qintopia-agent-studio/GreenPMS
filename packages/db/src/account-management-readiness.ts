import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function accountManagementReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash, security_definer, volatility) AS (VALUES
      ('qintopia_manage_account(text,text,text,text,text,text,text,text,jsonb)', '2733c974f0f544fd3c4689d0e01777e262aa6007484f3d00d9b085016310736e', true, 'v'),
      ('qintopia_member_deletion_basis(text,text)', '41433184cb5e3731fd7b6287f971bb7359b80d4147370afa587b5ca36ee5ef50', false, 's'),
      ('qintopia_member_deletion_snapshot(text)', '3100563848e4ea9a03ea6b8fccb20350207c12305928561f4e9eae107077a802', false, 's'),
      ('qintopia_delete_member_business(text,text,text,text,text,text,jsonb)', 'd618293280752435bb74ee002bf621b67d8f0aacc918af4d984709714e095d80', false, 'v'),
      ('qintopia_require_live_membership_reference()', '82de0b2e6c1170d92edb07d41276fe7ac012291f7342b54f05beb83e1043c83c', false, 'v'),
      ('qintopia_validate_member_deletion()', 'cafebb7d5e21abbf245a945dbe471eca590b159b24ec49b03e9bcd6bffe0f367', false, 'v'),
      ('qintopia_protect_membership_order_identity()', '56ce58874289275ab7c1a3ae05b58109e9e9903caf480520db67e831392e49d5', false, 'v'),
      ('qintopia_require_active_member()', 'c0ee2080752c4defbb0e3bae97601cca5c5e2d50dfd7f96f97d357c3654473d1', false, 'v'),
      ('qintopia_require_new_active_member()', '35adc08b422a6db2fe3a1cec30f16ae344a257614395e0e4b84ee83903574c7d', false, 'v')
    )
    SELECT NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc ON pg_proc.oid = to_regprocedure(expected.signature)
      WHERE pg_proc.oid IS NULL OR encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') <> body_hash
        OR prosecdef <> security_definer OR provolatile::text <> volatility
        OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        OR proowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
    )
    AND has_function_privilege('qintopia_runtime', 'qintopia_manage_account(text,text,text,text,text,text,text,text,jsonb)', 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc, LATERAL aclexplode(COALESCE(proacl, acldefault('f', proowner))) AS acl
      WHERE pg_proc.oid = to_regprocedure('qintopia_manage_account(text,text,text,text,text,text,text,text,jsonb)')
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    )
    AND has_table_privilege('qintopia_runtime', 'account_management_operations', 'SELECT')
    AND NOT has_table_privilege('qintopia_runtime', 'account_management_operations', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_column_privilege('qintopia_runtime', 'members', 'deleted_at', 'UPDATE')
    AND NOT has_table_privilege('qintopia_runtime', 'member_deletions', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_function_privilege('qintopia_runtime', 'qintopia_delete_member_business(text,text,text,text,text,text,jsonb)', 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('membership_payment_facts','membership_payment_active_member'),
        ('entitlement_ledger','entitlement_ledger_active_member'),('coverage_items','coverage_items_active_member'),
        ('entitlement_lots','entitlement_lots_active_member')) AS expected_table(name,trigger_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(name) AND tgname=trigger_name
        AND tgenabled IN ('O','A') AND NOT tgisinternal AND tgfoid=to_regprocedure('qintopia_require_live_membership_reference()'))
    )
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='member_deletions'::regclass AND tgname='member_deletions_validate'
      AND tgenabled IN ('O','A') AND tgdeferrable AND tginitdeferred AND tgfoid=to_regprocedure('qintopia_validate_member_deletion()'))
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['membership_orders','member_contracts','orders','quotes',
        'member_property_links','member_external_references','member_profile_corrections',
        'membership_effective_date_corrections','historical_membership_backfills',
        'membership_payment_reclassifications','membership_void_reconversions']) AS expected_table(name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(name) AND tgname = name || '_active_member_guard'
          AND tgenabled IN ('O','A') AND NOT tgisinternal AND tgfoid = to_regprocedure('qintopia_require_active_member()')
          AND pg_get_triggerdef(oid) = format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF member_id ON public.%I FOR EACH ROW EXECUTE FUNCTION qintopia_require_active_member()', name || '_active_member_guard', name)
      )
    )
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'members'::regclass AND tgname = 'members_new_active_guard'
      AND tgenabled IN ('O','A') AND pg_get_triggerdef(oid) = 'CREATE TRIGGER members_new_active_guard BEFORE INSERT ON public.members FOR EACH ROW EXECUTE FUNCTION qintopia_require_new_active_member()')
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'account_management_operations'::regclass
      AND tgname = 'account_management_operations_append_only' AND tgenabled IN ('O','A')
      AND pg_get_triggerdef(oid) = 'CREATE TRIGGER account_management_operations_append_only BEFORE DELETE OR UPDATE ON public.account_management_operations FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()')
    AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
