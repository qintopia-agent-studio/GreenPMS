import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { DomainError, mainlandMemberPhone } from "@qintopia/contracts";
import type { Database } from "@qintopia/db";
import { newId } from "@qintopia/domain";
import type { WechatMemberConfig } from "./wechat-official-account.ts";

type Trx = Transaction<Database>;
type Session = { secret_hash: string; open_id: string };

function mainlandNumber(raw: string) {
  const number = mainlandMemberPhone(raw);
  if (!number) throw new DomainError("VALIDATION_ERROR", "请输入办卡时预留的中国大陆手机号。", 400);
  return number;
}

function mac(config: WechatMemberConfig, ...fields: string[]) {
  return createHmac("sha256", config.secret).update(JSON.stringify(["member-sms-v1", config.appId, config.propertyId, ...fields])).digest("hex");
}

async function matchedMember(trx: Trx, property: string, number: string) {
  const rows = await trx.selectFrom("members as m").innerJoin("member_property_links as l", "l.member_id", "m.id")
    .where("l.property_id", "=", property).where("m.deleted_at", "is", null)
    .where(sql<string>`regexp_replace(m.phone, '[[:space:]()-]', '', 'g')`, "in", [number, "+86" + number, "0086" + number, "86" + number])
    .select("m.id").limit(2).forShare("m").execute();
  return rows.length === 1 ? rows[0]!.id : null;
}

const challenges = (trx: Trx, c: WechatMemberConfig) => trx.selectFrom("wechat_member_sms_challenges")
  .where("app_id", "=", c.appId).where("property_id", "=", c.propertyId);
const pending = (trx: Trx, c: WechatMemberConfig) => trx.updateTable("wechat_member_sms_challenges")
  .set({ attempts_left: 0 }).where("app_id", "=", c.appId).where("property_id", "=", c.propertyId).where("attempts_left", ">", 0);

export async function clearMemberCodes(trx: Trx, c: WechatMemberConfig, member: string) {
  await pending(trx, c).where("member_id", "=", member).execute();
}

// Call within the binding transaction, after acquiring the app/property lock.
export async function requestMemberCode(trx: Trx, c: WechatMemberConfig, session: Session, raw: string) {
  const number = mainlandNumber(raw);
  const phoneKey = mac(c, "phone", number), wechatKey = mac(c, "wechat", session.open_id);
  const recent = await challenges(trx, c).where("issued_at", ">", sql<Date>`clock_timestamp() - interval '24 hours'`)
    .where(eb => eb.or([eb("phone_key", "=", phoneKey), eb("wechat_key", "=", wechatKey)]))
    .select(["phone_key", "wechat_key", sql<boolean>`issued_at > clock_timestamp() - interval '60 seconds'`.as("cooldown")]).execute();
  if (recent.some(row => row.cooldown) || recent.filter(row => row.phone_key === phoneKey).length >= 5
    || recent.filter(row => row.wechat_key === wechatKey).length >= 5) return;

  const member = await matchedMember(trx, c.propertyId, number);
  const id = newId("wxsms"), code = String(randomInt(1_000_000)).padStart(6, "0");
  await pending(trx, c).where(eb => eb.or([eb("wechat_key", "=", wechatKey), eb("phone_key", "=", phoneKey)])).execute();
  await trx.insertInto("wechat_member_sms_challenges").values({ id, app_id: c.appId, property_id: c.propertyId,
    member_id: member, session_hash: session.secret_hash, wechat_key: wechatKey, phone_key: phoneKey,
    code_mac: mac(c, "code", id, session.secret_hash, phoneKey, code) }).execute();
  if (member) return { phone: "+86" + number, code };
}

export async function verifyMemberCode(trx: Trx, c: WechatMemberConfig, session: Session, raw: string, code: string) {
  const number = mainlandNumber(raw), phoneKey = mac(c, "phone", number);
  const row = await challenges(trx, c).select(["id", "code_mac", "member_id", "attempts_left"])
    .where("session_hash", "=", session.secret_hash).where("wechat_key", "=", mac(c, "wechat", session.open_id)).where("phone_key", "=", phoneKey)
    .where("issued_at", ">", sql<Date>`clock_timestamp() - interval '5 minutes'`).where("attempts_left", ">", 0).forUpdate().executeTakeFirst();
  if (!row) return "INVALID";
  const matches = timingSafeEqual(Buffer.from(row.code_mac, "hex"), Buffer.from(mac(c, "code", row.id, session.secret_hash, phoneKey, code), "hex"));
  await trx.updateTable("wechat_member_sms_challenges").set({ attempts_left: matches ? 0 : row.attempts_left - 1 }).where("id", "=", row.id).execute();
  const member = row.member_id;
  if (!matches || !member || await matchedMember(trx, c.propertyId, number) !== member) return "INVALID";

  const occupied = await trx.selectFrom("wechat_member_bindings").select("id").where("app_id", "=", c.appId)
    .where("property_id", "=", c.propertyId).where("revoked_at", "is", null)
    .where(eb => eb.or([eb("open_id", "=", session.open_id), eb("member_id", "=", member)])).executeTakeFirst();
  if (occupied) return "CONFLICT";
  await trx.insertInto("wechat_member_bindings").values({ id: newId("wxbind"), app_id: c.appId, property_id: c.propertyId,
    member_id: member, open_id: session.open_id, verified_by: null, verification: "SMS_OTP" }).execute();
  await clearMemberCodes(trx, c, member);
  return "BOUND";
}
