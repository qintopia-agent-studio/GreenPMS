import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function checkoutReversalReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash) AS (VALUES
      ('qintopia_assert_checkout_reversal(text)', '49e5d4b1248e23c87c234f26af098e1731b85c5e2e783a0f79275b9a3ac4b198'),
      ('qintopia_validate_checkout_reversal_execution()', '3b15251506a3efe7924c0914d780146d5363377a4f08f3206d95035865acc1fd'),
      ('qintopia_validate_checkout_reversal_transition()', '1e6186643a1e2cb566c46782edd5e789451ecddb115d693ae75fe83f5f1546e6'),
      ('qintopia_validate_inventory_claim_source()', '41e0185bccc996cbae6586bc99f0594386be9dec86f36011c2b26f6525f7e553')
    )
    SELECT NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc ON pg_proc.oid = to_regprocedure(expected.signature)
      WHERE pg_proc.oid IS NULL OR encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') <> body_hash
        OR prosecdef OR provolatile <> 'v' OR prokind <> 'f'
        OR proconfig IS DISTINCT FROM CASE WHEN signature = 'qintopia_validate_inventory_claim_source()'
          THEN NULL::text[] ELSE ARRAY['search_path=pg_catalog, public']::text[] END
        OR proowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc, LATERAL aclexplode(COALESCE(proacl, acldefault('f', proowner))) AS acl
      WHERE proname IN ('qintopia_assert_checkout_reversal', 'qintopia_validate_checkout_reversal_execution', 'qintopia_validate_checkout_reversal_transition')
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    )
    AND has_function_privilege('qintopia_runtime', 'qintopia_assert_checkout_reversal(text)', 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('command_executions', 'command_executions_checkout_reversal', 'CREATE CONSTRAINT TRIGGER command_executions_checkout_reversal AFTER INSERT OR UPDATE ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_checkout_reversal_execution()'),
        ('amendments', 'amendments_checkout_reversal', 'CREATE CONSTRAINT TRIGGER amendments_checkout_reversal AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.amendment_type = ''REVOKE_CHECK_OUT''::text)) EXECUTE FUNCTION qintopia_validate_checkout_reversal_execution()'),
        ('orders', 'orders_checkout_reversal_transition', 'CREATE CONSTRAINT TRIGGER orders_checkout_reversal_transition AFTER UPDATE ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_checkout_reversal_transition()'),
        ('stays', 'stays_checkout_reversal_transition', 'CREATE CONSTRAINT TRIGGER stays_checkout_reversal_transition AFTER UPDATE ON public.stays DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_checkout_reversal_transition()')
      ) AS expected_trigger(relation, name, definition)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(relation) AND tgname = name
        AND tgenabled IN ('O','A') AND pg_get_triggerdef(oid) = definition)
    )
    AND EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('amendments_one_reversal_per_checkout')
      AND indisvalid AND indisready AND indisunique
      AND pg_get_indexdef(indexrelid) = 'CREATE UNIQUE INDEX amendments_one_reversal_per_checkout ON public.amendments USING btree (((payload ->> ''checkoutAmendmentId''::text))) WHERE (amendment_type = ''REVOKE_CHECK_OUT''::text)')
    AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
