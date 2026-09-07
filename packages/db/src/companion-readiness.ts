import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function companionReady(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ ready: boolean }>`
    WITH expected(signature, body_hash, configured) AS (VALUES
      ('qintopia_assert_companion_command(text)', '8d5843d502124392c534b2e8d8cea90f56abe9c892c83246202575b045d7752c', true),
      ('qintopia_validate_companion_command()', '1b28ff1d906ed61d73add432250772e1c9b5d0dc98871db8b587881b8b2639d7', true),
      ('qintopia_validate_new_order_occupant()', 'e3fb234aef116677d291e947f8ad61001898111ed5605141f86bc03f0fc5812a', false),
      ('qintopia_validate_order_occupant_set()', '31380e38497609093662939942e2b2ce93edd40f387e7cc5e2beb021a2e207d1', false)
    )
    SELECT NOT EXISTS (
      SELECT 1 FROM expected LEFT JOIN pg_proc ON pg_proc.oid = to_regprocedure(expected.signature)
      WHERE pg_proc.oid IS NULL OR encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') <> body_hash
        OR prosecdef OR provolatile <> 'v' OR prokind <> 'f'
        OR proconfig IS DISTINCT FROM CASE WHEN configured THEN ARRAY['search_path=pg_catalog, public']::text[] ELSE NULL::text[] END
        OR proowner <> (SELECT datdba FROM pg_database WHERE datname = current_database())
    )
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('command_executions', 'command_executions_companion_guard', 'CREATE CONSTRAINT TRIGGER command_executions_companion_guard AFTER INSERT OR UPDATE ON public.command_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_companion_command()'),
        ('amendments', 'amendments_companion_guard', 'CREATE CONSTRAINT TRIGGER amendments_companion_guard AFTER INSERT ON public.amendments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.amendment_type = ''MANAGE_ORDER_OCCUPANTS''::text)) EXECUTE FUNCTION qintopia_validate_companion_command()'),
        ('order_occupants', 'order_occupants_companion_guard', 'CREATE CONSTRAINT TRIGGER order_occupants_companion_guard AFTER INSERT ON public.order_occupants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_companion_command()'),
        ('order_occupant_removals', 'order_occupant_removals_companion_guard', 'CREATE CONSTRAINT TRIGGER order_occupant_removals_companion_guard AFTER INSERT ON public.order_occupant_removals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_companion_command()'),
        ('order_occupant_removals', 'order_occupant_removals_append_only', 'CREATE TRIGGER order_occupant_removals_append_only BEFORE DELETE OR UPDATE ON public.order_occupant_removals FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()')
      ) AS expected_trigger(relation, name, definition)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(relation) AND tgname = name
        AND tgenabled IN ('O','A') AND pg_get_triggerdef(oid) = definition)
    )
    AND EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('active_order_occupants')
      AND relkind = 'v' AND reloptions = ARRAY['security_invoker=true']::text[]
      AND encode(sha256(convert_to(pg_get_viewdef(oid),'UTF8')),'hex') = '87846863b4d679912a12cae8bb643e8c0a7475358f638741704cfe2116b896ae')
    AND has_table_privilege('qintopia_runtime','order_occupant_removals','SELECT')
    AND has_table_privilege('qintopia_runtime','order_occupant_removals','INSERT')
    AND NOT has_table_privilege('qintopia_runtime','order_occupant_removals','UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND has_table_privilege('qintopia_runtime','active_order_occupants','SELECT')
    AND NOT has_table_privilege('qintopia_runtime','active_order_occupants','INSERT,UPDATE,DELETE')
    AND has_function_privilege('qintopia_runtime','qintopia_assert_companion_command(text)','EXECUTE')
    AND NOT has_function_privilege('public','qintopia_assert_companion_command(text)','EXECUTE')
    AND NOT has_function_privilege('public','qintopia_validate_companion_command()','EXECUTE')
    AS ready
  `.execute(db);
  return result.rows[0]?.ready === true;
}
