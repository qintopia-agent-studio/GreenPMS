import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
// 固定 PostgreSQL 18 迁移 074 的表、列、约束、索引、触发器及函数；漂移时拒绝就绪。
const expectedFingerprint = "2ba34fd40e696275e7eb9b9b5758a3c6bde1e09595eb3e645f3002a2ae8b39e1";
export async function membershipCancellationSchemaFingerprint(db: Kysely<Database>): Promise<string> {
    const row = (await sql<{
        hash: string;
    }> `WITH tables AS (
    SELECT c.oid,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname = 'membership_order_cancellations' AND c.relkind='r'
  ), items AS (
    SELECT 'table:'||relname AS key, jsonb_build_array(relrowsecurity,relforcerowsecurity,relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text AS value FROM tables
    UNION ALL SELECT 'column:'||t.relname||':'||a.attname,jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))::text
      FROM tables t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    UNION ALL SELECT 'constraint:'||t.relname||':'||c.conname,jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid
    UNION ALL SELECT 'index:'||c.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)::text FROM tables t JOIN pg_index i ON i.indrelid=t.oid JOIN pg_class c ON c.oid=i.indexrelid
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND (t.tgname LIKE 'membership_order_cancellation%' OR t.tgrelid IN (SELECT oid FROM tables))
    UNION ALL SELECT 'function:'||p.proname, jsonb_build_array(pg_get_functiondef(p.oid),p.proowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('qintopia_validate_membership_order_cancellation','qintopia_validate_membership_order_cancellation_completion')
  ) SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS hash FROM items`.execute(db)).rows[0];
    return row?.hash ?? "";
}
export async function membershipCancellationReady(db: Kysely<Database>): Promise<boolean> {
  if (await membershipCancellationSchemaFingerprint(db) !== expectedFingerprint) return false;
  const row = (await sql<{ ready: boolean }>`SELECT
    has_table_privilege('qintopia_runtime','membership_order_cancellations','SELECT')
    AND has_table_privilege('qintopia_runtime','membership_order_cancellations','INSERT')
    AND NOT has_table_privilege('qintopia_runtime','membership_order_cancellations','UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    AND NOT has_any_column_privilege('qintopia_runtime','membership_order_cancellations','UPDATE,REFERENCES')
    AND NOT has_function_privilege('qintopia_runtime','qintopia_validate_membership_order_cancellation()','EXECUTE')
    AND NOT has_function_privilege('qintopia_runtime','qintopia_validate_membership_order_cancellation_completion()','EXECUTE')
    AS ready`.execute(db)).rows[0];
  return row?.ready === true;
}
