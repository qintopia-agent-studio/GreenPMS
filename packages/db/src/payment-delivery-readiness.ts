import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
// Frozen from migration 067 in the isolated PostgreSQL 18 fixture. Includes columns,
// keys, checks, indexes, trigger definitions/modes and function bodies/configuration.
const expectedFingerprint = "5f1c4489cba9e4b8554153656ad19f2c34256ef910088173ff9d73250c17b77c";
export async function paymentDeliverySchemaFingerprint(db: Kysely<Database>): Promise<string> {
    const row = (await sql<{
        hash: string;
    }> `WITH tables AS (
    SELECT c.oid,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'payment_deliver%' AND c.relkind='r'
  ), items AS (
    SELECT 'table:'||relname AS key, jsonb_build_array(relrowsecurity,relforcerowsecurity,relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text AS value FROM tables
    UNION ALL SELECT 'column:'||t.relname||':'||a.attname,jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))::text
      FROM tables t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    UNION ALL SELECT 'constraint:'||t.relname||':'||c.conname,jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid
    UNION ALL SELECT 'index:'||c.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)::text FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class c ON c.oid=i.indexrelid
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND (t.tgname LIKE 'payment_deliver%' OR t.tgrelid IN (SELECT oid FROM tables))
    UNION ALL SELECT 'function:'||p.proname, jsonb_build_array(pg_get_functiondef(p.oid),p.proowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'qintopia_payment_deliver%'
  ) SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS hash FROM items`.execute(db)).rows[0];
    return row?.hash ?? "";
}
export async function paymentDeliveryReady(db: Kysely<Database>): Promise<boolean> {
  if (await paymentDeliverySchemaFingerprint(db) !== expectedFingerprint) return false;
  const row = (await sql<{ready: boolean}>`SELECT
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qintopia_payment_delivery_worker' AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='qintopia_payment_delivery_worker'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES')) privilege(name)
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v') AND (
        (has_table_privilege('qintopia_payment_delivery_worker',c.oid,privilege.name) OR
          CASE WHEN privilege.name IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('qintopia_payment_delivery_worker',c.oid,privilege.name) ELSE false END)
        IS DISTINCT FROM (
          (privilege.name='SELECT' AND c.relname IN ('payment_delivery_source','payment_delivery_events','payment_deliveries')) OR
          (privilege.name='UPDATE' AND c.relname IN ('payment_delivery_source','payment_deliveries')) OR
          (privilege.name='INSERT' AND c.relname='payment_delivery_audit'))))
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND
        ((c.relname='payment_delivery_source' AND has_column_privilege('qintopia_payment_delivery_worker',c.oid,a.attnum,'UPDATE') IS DISTINCT FROM (a.attname IN ('paused','reason_code')))
        OR (c.relname='payment_deliveries' AND has_column_privilege('qintopia_payment_delivery_worker',c.oid,a.attnum,'UPDATE') IS DISTINCT FROM (a.attname<>'event_id'))))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'qintopia_payment_delivery_%' AND
        (has_function_privilege('public',p.oid,'EXECUTE') OR has_function_privilege('qintopia_runtime',p.oid,'EXECUTE') OR
          has_function_privilege('qintopia_payment_delivery_worker',p.oid,'EXECUTE') IS DISTINCT FROM (p.proname='qintopia_payment_delivery_publish')))
    AS ready`.execute(db)).rows[0];
  return row?.ready === true;
}
