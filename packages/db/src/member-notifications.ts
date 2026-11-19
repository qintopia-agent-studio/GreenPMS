import { sql, type Insertable, type Transaction } from "kysely";
import { defaultNoticeRules, DomainError, type MemberNoticeRules } from "@qintopia/contracts";
import type { DbExecutor } from "./inventory.ts";
import type { Database } from "./schema.ts";

export async function memberRuleVersion(db: DbExecutor, property: string, defaults = defaultNoticeRules) {
  const row = await db
    .selectFrom("wechat_member_rule_versions as v")
    .innerJoin("subjects as s", "s.id", "v.updated_by")
    .select(["v.version", "v.settings", "v.created_at", "s.display_name"])
    .where("v.property_id", "=", property)
    .orderBy("v.version", "desc")
    .executeTakeFirst();
  return {
    rules: row ? (row.settings as MemberNoticeRules) : defaults,
    version: row?.version ?? 0,
    updatedBy: row?.display_name ?? null,
    updatedAt: row?.created_at.toISOString() ?? null
  };
}
export async function publishMemberRules(
  trx: Transaction<Database>,
  property: string,
  subject: string,
  expected: number,
  rules: MemberNoticeRules
) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${"wechat-member-rules:" + property},0))`.execute(trx);
  const { version } = await memberRuleVersion(trx, property);
  if (expected !== version)
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "其他管理员已更新设置，请重新读取后再发布。", 409);
  await trx
    .insertInto("wechat_member_rule_versions")
    .values({ property_id: property, version: version + 1, updated_by: subject, settings: JSON.stringify(rules) })
    .execute();
}
export function recordMemberInteraction(db: DbExecutor, event: Insertable<Database["wechat_member_interactions"]>) {
  return db
    .insertInto("wechat_member_interactions")
    .values(event)
    .onConflict((oc) => oc.column("event_key").doNothing())
    .execute();
}
export function setInteractionState(
  db: DbExecutor,
  key: string,
  state: Database["wechat_member_interactions"]["state"],
  detail: string
) {
  return db
    .updateTable("wechat_member_interactions")
    .set({ state, detail, updated_at: sql`clock_timestamp()` })
    .where("event_key", "=", key)
    .execute();
}
