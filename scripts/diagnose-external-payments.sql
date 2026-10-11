-- GreenPMS external-payment schema diagnostic, format 1; PostgreSQL 17/18.
-- Run the WHOLE file in a fresh connection to the GreenPMS database.
-- Prefer the existing qintopia_runtime login; an authorized DBA login also works.
-- Do not create users, grant privileges, migrate, or restart the application for this check.
-- This reads system catalogs only. Definitions are hashed, never returned verbatim.
-- Export the greenpms_diagnostic result as JSON. Do not share connection settings.
-- On error, stop and ROLLBACK or disconnect; do not rerun fragments outside this transaction.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

-- Keep this CTE identical to externalPaymentsSchemaFingerprint in
-- packages/db/src/external-payments-readiness.ts, including its native sort order.
-- Do not normalize definitions or change search_path: those differences are diagnostic evidence.
WITH tables AS (
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
  ), fingerprints AS (
    SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS runtime_sha256,
      encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key COLLATE "C", value COLLATE "C")::text,'UTF8')),'hex') AS c_order_sha256
    FROM items
  ), baseline AS (
    SELECT ARRAY[
      '8b914dd27b9f543815bf3890263d2342d2d7c619bd202877f9ce48325e5d015d',
      '705eeaf432a39efbb9611b4bab5be004b1dfeb7924ad52a3841280a41e403063',
      '0e14e25d9c534fe01032a239e60eec03ccf0385f616e0a4ebd529fafe8edc799'
    ]::text[] AS accepted_sha256
  )
SELECT jsonb_pretty(jsonb_build_object(
  'diagnostic', 'greenpms-external-payments-schema',
  'format_version', 1,
  'baseline', 'v1.10.0 externalPaymentsSchemaFingerprint; not a complete readiness check',
  'captured_at', statement_timestamp(),
  'environment', (
    SELECT jsonb_build_object(
      'server_version', current_setting('server_version'),
      'server_version_num', current_setting('server_version_num'),
      'server_encoding', current_setting('server_encoding'),
      'client_encoding', current_setting('client_encoding'),
      'database_encoding', pg_encoding_to_char(d.encoding),
      'database_collate', d.datcollate,
      'database_ctype', d.datctype,
      'locale_provider', to_jsonb(d)->>'datlocprovider',
      'locale', coalesce(to_jsonb(d)->>'datlocale', to_jsonb(d)->>'daticulocale'),
      'collation_version', to_jsonb(d)->>'datcollversion',
      'search_path', current_setting('search_path'),
      'timezone', current_setting('TimeZone'),
      'datestyle', current_setting('DateStyle'),
      'public_schema_visible', 'public'::name = ANY(current_schemas(false)),
      'standard_conforming_strings', current_setting('standard_conforming_strings'),
      'transaction_read_only', current_setting('transaction_read_only'),
      'transaction_isolation', current_setting('transaction_isolation'),
      'statement_timeout', current_setting('statement_timeout'),
      'lock_timeout', current_setting('lock_timeout'),
      'is_runtime_role', current_user = 'qintopia_runtime',
      'is_database_owner', d.datdba = (SELECT oid FROM pg_roles WHERE rolname=current_user),
      'is_superuser', (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    ) FROM pg_database d WHERE d.datname=current_database()
  ),
  'fingerprint', (
    SELECT jsonb_build_object(
      'runtime_sha256', f.runtime_sha256,
      'c_order_sha256', f.c_order_sha256,
      'accepted_sha256', b.accepted_sha256,
      'matches_v1_10_0_fingerprint_only', coalesce(f.runtime_sha256 = ANY(b.accepted_sha256), false),
      'object_count', (SELECT count(*) FROM items),
      'table_count', (SELECT count(*) FROM tables),
      'duplicate_keys', (SELECT coalesce(jsonb_agg(key ORDER BY key COLLATE "C"), '[]'::jsonb)
        FROM (SELECT key FROM items GROUP BY key HAVING count(*) > 1) duplicates)
    ) FROM fingerprints f CROSS JOIN baseline b
  ),
  'objects', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'key', key,
      'sha256', encode(sha256(convert_to(value,'UTF8')),'hex'),
      'utf8_bytes', octet_length(convert_to(value,'UTF8'))
    ) ORDER BY key COLLATE "C", value COLLATE "C"), '[]'::jsonb) FROM items
  ),
  'tables', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name', relname,
      'owner_is_database_owner', relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()),
      'row_security', relrowsecurity,
      'force_row_security', relforcerowsecurity
    ) ORDER BY relname COLLATE "C"), '[]'::jsonb) FROM tables
  ),
  'functions', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'identity_sha256', encode(sha256(convert_to(pg_get_function_identity_arguments(p.oid),'UTF8')),'hex'),
      'definition_sha256', encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
      'body_sha256', encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),
      'body_utf8_bytes', octet_length(convert_to(p.prosrc,'UTF8')),
      'body_cr_count', length(p.prosrc)-length(replace(p.prosrc,chr(13),'')),
      'owner_is_database_owner', p.proowner=(SELECT datdba FROM pg_database WHERE datname=current_database()),
      'security_definer', p.prosecdef
    ) ORDER BY p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"), '[]'::jsonb)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND (p.proname LIKE 'qintopia_%external_payment%' OR p.proname='qintopia_validate_wecom_refund_reference')
  )
)) AS greenpms_diagnostic;

ROLLBACK;
