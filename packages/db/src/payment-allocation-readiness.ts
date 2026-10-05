import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

// Frozen only after exercising 069/070 against the isolated PostgreSQL fixture.
const expectedFingerprint = "d4d635134e75e362781d89d24f8f38bce28adc64dc6fcc52bd447ce313da75cc";
export async function paymentAllocationSchemaFingerprint(db: Kysely<Database>): Promise<string> {
  const row = (await sql<{ hash: string }>`WITH tables AS (
    SELECT c.oid,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname IN ('external_payment_allocations','external_payment_allocation_releases','retained_funds','retained_fund_entries') AND c.relkind='r'
  ), items AS (
    SELECT 'table:'||relname AS key,jsonb_build_array(relrowsecurity,relforcerowsecurity,relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text AS value FROM tables
    UNION ALL SELECT 'column:'||t.relname||':'||a.attname,jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))::text
      FROM tables t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    UNION ALL SELECT 'constraint:'||t.relname||':'||c.conname,jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid
    UNION ALL SELECT 'index:'||c.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)::text FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class c ON c.oid=i.indexrelid
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
        AND (t.tgname LIKE 'allocation_%' OR t.tgname IN ('retained_source_guard','external_payment_allocation_mirror') OR t.tgrelid IN (SELECT oid FROM tables))
    UNION ALL SELECT 'function:'||p.proname,jsonb_build_array(pg_get_functiondef(p.oid),p.proowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
        ('qintopia_allocation_immutable','qintopia_allocation_lock','qintopia_allocation_fact_guard','qintopia_assert_allocation_graph',
         'qintopia_mirror_external_payment_allocation','qintopia_retained_source_guard','qintopia_allocation_unassigned_refund_guard','qintopia_allocation_membership_guard')
    UNION ALL SELECT 'fact-column',jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull)::text FROM pg_attribute a
      WHERE a.attrelid='collection_facts'::regclass AND a.attname='external_payment_bill_id' AND NOT a.attisdropped
    UNION ALL SELECT 'fact-constraint:'||conname,jsonb_build_array(pg_get_constraintdef(oid),convalidated)::text FROM pg_constraint
      WHERE conrelid='collection_facts'::regclass AND conname IN ('collection_facts_fact_type_check','collection_facts_external_payment_bill_id_fkey')
  ) SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS hash FROM items`.execute(db)).rows[0];
  return row?.hash ?? "";
}
export async function paymentAllocationReady(db: Kysely<Database>): Promise<boolean> {
  if (await paymentAllocationSchemaFingerprint(db) !== expectedFingerprint) return false;
  const row = (await sql<{ ready: boolean }>`SELECT
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES')) privilege(name)
      WHERE n.nspname='public' AND c.relname IN ('external_payment_allocations','external_payment_allocation_releases','retained_funds','retained_fund_entries')
      AND ((has_table_privilege('qintopia_runtime',c.oid,privilege.name) OR CASE WHEN privilege.name IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('qintopia_runtime',c.oid,privilege.name) ELSE false END)
        IS DISTINCT FROM (privilege.name IN ('SELECT','INSERT'))
        OR has_table_privilege('public',c.oid,privilege.name)
        OR has_table_privilege('qintopia_payment_worker',c.oid,privilege.name)))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname IN ('qintopia_allocation_immutable','qintopia_allocation_lock','qintopia_allocation_fact_guard','qintopia_assert_allocation_graph',
        'qintopia_mirror_external_payment_allocation','qintopia_retained_source_guard','qintopia_allocation_unassigned_refund_guard','qintopia_allocation_membership_guard')
      AND (has_function_privilege('public',p.oid,'EXECUTE') OR has_function_privilege('qintopia_runtime',p.oid,'EXECUTE')))
    AS ready`.execute(db)).rows[0];
  return row?.ready === true;
}
