import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

/** Shared scopes are write-critical: fail closed on missing or altered guards. */
export async function membershipScopeReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash, language, volatility) AS (VALUES
      ('qintopia_membership_scope_valid(text,text[])', '080ba287e99d0d0415b8d6405c02e53b2d27de30cb59a558231a90549acebc5a', 'sql', 'i'),
      ('qintopia_membership_room_matches(text,text[],text)', '266257ce3053d6d8182f576873ddc8ad91127264897a34e849f9c2d13238c78e', 'sql', 'i'),
      ('qintopia_guard_membership_scope_snapshot()', '031553b9a9aadfb03c6447a6d14f81dbb3ee50ea3214595458a34741763cee94', 'plpgsql', 'v'),
      ('qintopia_order_room_types_match(text,text,text)', '7dca938cc101be072b43c0034f3c8f784bbc656670d95c969992026a1ebab4db', 'sql', 's')
    ), scope_guards(signature, body_hash) AS (VALUES
      ('qintopia_validate_coverage_ownership()', 'e6233bbe4a50a4d6a9eea4311030750a57d3ab2f13e862a0125cae7ed7346a01'),
      ('qintopia_assert_stage11_move_combination(text)', '91cd98d47fc862dd91c8454a57ca497771d780f6bb7d9928fcceac6b908409b4'),
      ('qintopia_assert_stage11_date_change_combination(text)', 'ee528fb0a5ce5573c558f1ee05e8d3399b1d9bc35a0ded529ae020bacd891ebb'),
      ('qintopia_validate_conversion_consume_entitlement_fact()', '9da328e757d777ad7c36611a87a68d231d5f6fd6690f35c9d376d6517867dcaf'),
      ('qintopia_assert_stage13_stay_conversion_command_v033(text)', '36297eb71b15c6ca4ff887805d94112246492e5c6fd718fd6903315a33f759d3'),
      ('qintopia_assert_converted_stay_fulfillment_command(text)', '1ee7afb83a223322b49218cd666d45c0c24c14b887244232c5566119434e0304'),
      ('qintopia_validate_membership_effective_date_correction()', '9f2db7a819fa544de1dabf48f1abe8ac078866cf036ebcc39d91c28171e75b3b'),
      ('qintopia_validate_membership_void_reconversion()', 'ad6528158132840d9162e0d08d487a1cf4acb4646bb4bc22550d324fedf1969c'),
      ('qintopia_validate_temporary_other_room_create_order()', '164da03059d257973ee957a3465e1fd4c7d8520d54a04d1db043db9cb9d81b50'),
      ('qintopia_apply_room_catalog(text,jsonb,text)', 'b264c78496af279f37ca7c5a71bf950ef5cb678df0bb37ff8cea0e3762655676'),
      ('qintopia_cross_room_upgrade_matches(text,text,text,date)', '57dc896ff3bc7ac53b48ca78f7e144597b5347e35c8648bc1e3e1de75cce48f4')
    ) SELECT NOT EXISTS (
      SELECT 1 FROM scope_guards LEFT JOIN pg_proc p ON p.oid = to_regprocedure(signature)
      WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') <> body_hash
    ) AND NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc p ON p.oid = to_regprocedure(signature)
      LEFT JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') <> body_hash
        OR p.prosecdef OR p.prokind <> 'f' OR l.lanname <> language OR p.provolatile::text <> volatility
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        OR p.proowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
        OR has_function_privilege('public', p.oid, 'EXECUTE')
        OR has_function_privilege('qintopia_runtime', p.oid, 'EXECUTE') IS DISTINCT FROM (signature <> 'qintopia_guard_membership_scope_snapshot()')
    ) AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('membership_orders'), ('historical_membership_backfills')) AS tables(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(tables.name)
        AND tgname = tables.name || '_scope_snapshot' AND tgenabled IN ('O','A')
        AND pg_get_triggerdef(oid) = 'CREATE TRIGGER ' || tables.name || '_scope_snapshot BEFORE INSERT OR UPDATE ON public.' || tables.name || ' FOR EACH ROW EXECUTE FUNCTION qintopia_guard_membership_scope_snapshot()')
    ) AND NOT EXISTS (
      SELECT 1 FROM (VALUES ('membership_products'), ('membership_orders'), ('historical_membership_backfills')) AS tables(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(tables.name)
        AND conname = tables.name || '_scope_valid' AND convalidated
        AND pg_get_constraintdef(oid) = 'CHECK (qintopia_membership_scope_valid(allowed_room_type_code, allowed_room_type_codes))')
    ) AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
