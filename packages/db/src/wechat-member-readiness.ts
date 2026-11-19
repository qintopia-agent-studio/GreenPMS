import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

export async function wechatMemberReady(db: Kysely<Database>) {
  const result = await sql<{ ready: boolean }>`
    select
      (select count(*) = 3 and bool_and(
        has_table_privilege('qintopia_runtime', c.oid, 'SELECT')
        and has_table_privilege('qintopia_runtime', c.oid, 'INSERT')
        and not has_any_column_privilege('qintopia_ai_analytics_reader', c.oid, 'SELECT')
      ) from pg_class c where c.oid in (
        to_regclass('public.wechat_member_sessions'), to_regclass('public.wechat_member_bindings'),
        to_regclass('public.wechat_member_expiry_notices')))
      and (select count(*) = 3 and bool_and(i.indisunique and i.indisvalid and i.indisready)
        from pg_index i where i.indexrelid in (to_regclass('public.wechat_member_bindings_member'),
          to_regclass('public.wechat_member_bindings_wechat'), to_regclass('public.wechat_member_expiry_notices_pkey')))
      and (select count(*) = 2 from pg_trigger t where t.tgenabled in ('O','A') and (
        (t.tgrelid = to_regclass('public.members') and t.tgname = 'wechat_member_profile_deleted'
          and t.tgfoid = to_regprocedure('public.qintopia_unlink_deleted_wechat_member()')) or
        (t.tgrelid = to_regclass('public.wechat_member_bindings') and t.tgname = 'wechat_member_active_profile'
          and t.tgfoid = to_regprocedure('public.qintopia_require_active_member()'))))
      and (select p.prosecdef and p.proowner <> 'qintopia_runtime'::regrole
        and has_function_privilege('qintopia_runtime', p.oid, 'EXECUTE')
        and not has_function_privilege('public', p.oid, 'EXECUTE')
        from pg_proc p where p.oid = to_regprocedure('public.qintopia_prune_wechat_member_sessions()'))
      as ready`.execute(db);
  return result.rows[0]?.ready === true;
}
