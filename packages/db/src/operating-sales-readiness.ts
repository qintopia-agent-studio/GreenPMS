import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

/** 与072迁移同版本检查，缺少事实表或约束时不继续运行新统计。 */
export async function operatingSalesReady(db:Kysely<Database>):Promise<boolean>{
 const row=(await sql<{ready:boolean}>`SELECT
 (SELECT count(*)=4 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines','channel_refund_claims') AND c.relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()))
 AND (SELECT count(*)=33 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('channel_operating_facts','operating_sales_opening','operating_sales_baselines','channel_refund_claims'))
 AND (SELECT count(*)=14 FROM pg_constraint WHERE contype='c' AND conrelid IN (to_regclass('channel_operating_facts'),to_regclass('operating_sales_opening'),to_regclass('operating_sales_baselines'),to_regclass('channel_refund_claims')))
 AND COALESCE((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')='c0bb745fc891ec81ab64aea27e44f0acfeefb2ba51687696e3e5a4ea9b513b3e' AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[] FROM pg_proc WHERE oid=to_regprocedure('qintopia_guard_channel_operating_fact()')),false)
 AND COALESCE((SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b6e8c3c341f4b9500c7cf393b39017b5eee6fb946ed1b4c952f979d3e73cda62' FROM pg_proc WHERE oid=to_regprocedure('qintopia_assert_channel_operating_commit()')),false)
 AND (SELECT count(*)=5 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgenabled='O' AND
 ((c.relname='channel_operating_facts' AND t.tgname='channel_operating_commit' AND t.tgdeferrable AND t.tginitdeferred AND t.tgfoid=to_regprocedure('qintopia_assert_channel_operating_commit()')) OR
 (c.relname='channel_operating_facts' AND t.tgname='channel_operating_guard' AND t.tgfoid=to_regprocedure('qintopia_guard_channel_operating_fact()')) OR
 (c.relname='channel_operating_facts' AND t.tgname='channel_operating_immutable' AND t.tgfoid=to_regprocedure('qintopia_allocation_immutable()')) OR
 (c.relname='operating_sales_opening' AND t.tgname='opening_sales_immutable' AND t.tgfoid=to_regprocedure('qintopia_allocation_immutable()')) OR
 (c.relname='operating_sales_baselines' AND t.tgname='baseline_sales_immutable' AND t.tgfoid=to_regprocedure('qintopia_allocation_immutable()'))))
 AND COALESCE(has_table_privilege('qintopia_runtime',to_regclass('channel_operating_facts'),'SELECT'),false)
 AND COALESCE(has_table_privilege('qintopia_runtime',to_regclass('channel_operating_facts'),'INSERT'),false)
 AND NOT COALESCE(has_table_privilege('qintopia_runtime',to_regclass('channel_operating_facts'),'UPDATE,DELETE'),true)
 AND COALESCE(has_table_privilege('qintopia_runtime',to_regclass('operating_sales_opening'),'SELECT'),false)
 AND NOT COALESCE(has_table_privilege('qintopia_runtime',to_regclass('operating_sales_opening'),'INSERT,UPDATE,DELETE'),true)
 AND COALESCE(has_table_privilege('qintopia_runtime',to_regclass('operating_sales_baselines'),'SELECT'),false)
 AND NOT COALESCE(has_table_privilege('qintopia_runtime',to_regclass('operating_sales_baselines'),'INSERT,UPDATE,DELETE'),true)
 AND NOT COALESCE(has_table_privilege('qintopia_runtime',to_regclass('channel_refund_claims'),'INSERT,UPDATE,DELETE'),true)
 AS ready`.execute(db)).rows[0];return row?.ready===true;
}
