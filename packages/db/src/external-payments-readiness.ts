import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function externalPaymentsSchemaFingerprint(db: Kysely<Database>): Promise<string> {
  const row = (await sql<{ hash: string }>`WITH tables AS (
    SELECT c.oid,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'external_payment_%' AND c.relkind='r'
  ), items AS (
    SELECT 'table:'||relname AS key,jsonb_build_array(relrowsecurity,relforcerowsecurity,relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text AS value FROM tables
    UNION ALL SELECT 'column:'||t.relname||':'||a.attname,jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))::text
      FROM tables t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    UNION ALL SELECT 'constraint:'||t.relname||':'||c.conname,jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid
    UNION ALL SELECT 'index:'||c.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)::text FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class c ON c.oid=i.indexrelid
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND (t.tgrelid IN (SELECT oid FROM tables) OR t.tgname='collection_facts_validate_refund_reference')
    UNION ALL SELECT 'function:'||p.proname,jsonb_build_array(pg_get_functiondef(p.oid),p.proowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND (p.proname LIKE 'qintopia_%external_payment%' OR p.proname='qintopia_validate_wecom_refund_reference')
  ) SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS hash FROM items`.execute(db)).rows[0];
  return row?.hash ?? "";
}

export async function externalPaymentsReady(db: Kysely<Database>): Promise<boolean> {
  // Frozen from migrations 059/060 on PostgreSQL 18, matching the event module.
  if (await externalPaymentsSchemaFingerprint(db) !== "705eeaf432a39efbb9611b4bab5be004b1dfeb7924ad52a3841280a41e403063") return false;
  const row = (await sql<{ ready: boolean }>`SELECT
    NOT EXISTS(SELECT 1 FROM (VALUES ('external_payment_sources'),('external_payment_accounts'),
      ('external_payment_bills'),('external_payment_contacts'),('external_payment_matches'),
      ('external_payment_events'),('external_payment_event_heads')) t(name) WHERE to_regclass(t.name) IS NULL)
    AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qintopia_payment_worker' AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='qintopia_payment_worker'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES')) privilege(name)
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'external_payment_%' AND (
        (has_table_privilege('qintopia_runtime',c.oid,privilege.name) OR CASE WHEN privilege.name IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('qintopia_runtime',c.oid,privilege.name) ELSE false END)
          IS DISTINCT FROM (privilege.name='SELECT' OR (privilege.name='INSERT' AND c.relname='external_payment_matches') OR (privilege.name='UPDATE' AND c.relname='external_payment_bills'))
        OR (has_table_privilege('qintopia_payment_worker',c.oid,privilege.name) OR CASE WHEN privilege.name IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('qintopia_payment_worker',c.oid,privilege.name) ELSE false END)
          IS DISTINCT FROM ((privilege.name='SELECT' AND c.relname<>'external_payment_event_heads')
            OR (privilege.name IN ('INSERT','UPDATE') AND c.relname IN ('external_payment_bills','external_payment_contacts'))
            OR (privilege.name='UPDATE' AND c.relname='external_payment_sources'))))
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('external_payment_matches','external_payment_match_guard','qintopia_validate_external_payment_match()'),
      ('external_payment_matches','external_payment_match_immutable','qintopia_keep_external_payment_match()'),
      ('external_payment_matches','external_payment_matched_event','qintopia_external_payment_matched_event()'),
      ('external_payment_bills','external_payment_bill_identity','qintopia_keep_external_payment_bill_id()')) required(tab,trig,fn)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(required.tab)
        AND t.tgname=required.trig AND t.tgenabled IN ('O','A') AND t.tgfoid=to_regprocedure(required.fn)))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) privilege(name)
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT LIKE 'external_payment_%'
        AND (has_table_privilege('qintopia_payment_worker',c.oid,privilege.name)
          OR CASE WHEN privilege.name IN ('INSERT','UPDATE') THEN has_any_column_privilege('qintopia_payment_worker',c.oid,privilege.name) ELSE false END))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'external_payment_%'
        AND (has_table_privilege('qintopia_runtime',c.oid,'DELETE,TRUNCATE')
          OR has_table_privilege('qintopia_payment_worker',c.oid,'DELETE,TRUNCATE')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND (p.proname LIKE 'qintopia_%external_payment%') AND has_function_privilege('public',p.oid,'EXECUTE'))
    AS ready`.execute(db)).rows[0];
  return row?.ready === true;
}
