import { sql, type Kysely } from "kysely";
import type { FastifyInstance } from "fastify";
import { expiryLeadDays, propertyLocalToday, type Database } from "@qintopia/db";
import type { WechatMemberConfig, WechatService } from "./wechat-official-account.ts";

interface DueNotice {
  order_id: string;
  binding_id: string;
  open_id: string;
  product: string;
  expires_on: string;
  days: number;
}

function candidates(config: WechatMemberConfig, today: string) {
  return sql`from membership_orders o
    join member_contracts c on c.id=o.contract_id and c.membership_order_id=o.id and c.member_id=o.member_id and c.property_id=o.property_id
    join entitlement_lots l on l.id=o.entitlement_lot_id and l.contract_id=c.id and l.unit_kind=o.entitlement_unit_kind
    join members m on m.id=o.member_id and m.deleted_at is null
    join wechat_member_bindings b on b.member_id=m.id and b.property_id=o.property_id
    where o.property_id=${config.propertyId} and b.app_id=${config.appId} and b.revoked_at is null
      and b.subscription_template=${config.reminder!.template} and b.open_id is not null
      and o.status='ACTIVE' and c.status='ACTIVE' and l.status='ACTIVE' and c.valid_from <= ${today}::date
      and least(c.valid_until,l.expires_on) - ${today}::date in (${sql.join(expiryLeadDays)})`;
}

export async function runExpiryReminders(db: Kysely<Database>, config: WechatMemberConfig, service: WechatService) {
  if (!config.reminder) return;
  const today = await propertyLocalToday(db, config.propertyId);
  const due = await sql<DueNotice>`select o.id as order_id, b.id as binding_id, b.open_id, o.product_name as product,
    least(c.valid_until,l.expires_on)::text as expires_on, least(c.valid_until,l.expires_on) - ${today}::date as days
    ${candidates(config, today)}
    and not exists (select 1 from wechat_member_expiry_notices n where n.app_id=b.app_id and n.order_id=o.id
      and n.expires_on=least(c.valid_until,l.expires_on) and n.lead_days=least(c.valid_until,l.expires_on)-${today}::date
      and (n.state <> 'RETRY' or n.attempted_at > now() - interval '10 minutes'))
    order by o.id`.execute(db);
  let unavailable = 0;
  for (const item of due.rows) {
    // These calls cannot send a notification. A failure here leaves the notice eligible.
    let following: boolean;
    let token: string;
    try {
      following = await service.following(item.open_id);
      token = following ? await service.token() : "";
    } catch {
      unavailable++;
      continue;
    }
    if (!following) {
      await db.updateTable("wechat_member_bindings").set({ subscription_template: null }).where("id", "=", item.binding_id)
        .where("subscription_template", "=", config.reminder.template).execute();
      continue;
    }
    const key = { app_id: config.appId, order_id: item.order_id, expires_on: item.expires_on, lead_days: item.days };
    // Commit the reservation before calling a provider that offers no idempotency key.
    const claim = await db.insertInto("wechat_member_expiry_notices").values({ ...key, binding_id: item.binding_id, state: "UNKNOWN" })
      .onConflict(oc => oc.columns(["app_id","order_id","expires_on","lead_days"]).doUpdateSet({
        binding_id: item.binding_id, state: "UNKNOWN", attempted_at: sql`now()`, error_code: null
      }).where("wechat_member_expiry_notices.state", "=", "RETRY").where("wechat_member_expiry_notices.attempted_at", "<=", sql<Date>`now() - interval '10 minutes'`))
      .returning("order_id").executeTakeFirst();
    if (!claim) continue;
    await db.transaction().execute(async trx => {
      const currentDate = await propertyLocalToday(trx, config.propertyId);
      const current = await sql<{ product: string }>`select o.product_name as product ${candidates(config, currentDate)}
        and o.id=${item.order_id} and b.id=${item.binding_id} and b.open_id=${item.open_id}
        and least(c.valid_until,l.expires_on)=${item.expires_on}::date and ${currentDate}::date=${today}::date
        for share of b,o,c,l`.execute(trx);
      const update = trx.updateTable("wechat_member_expiry_notices").where("app_id", "=", key.app_id).where("order_id", "=", key.order_id)
        .where("expires_on", "=", key.expires_on).where("lead_days", "=", key.lead_days);
      if (!current.rows[0]) {
        await update.set({ state: "RETRY" }).execute();
        return;
      }
      let result: number;
      try { result = await service.send(token, item.open_id, current.rows[0].product, item.expires_on, item.days); }
      catch { return; } // Timeout or lost reply. Do not deliver again without conclusive evidence.
      if (result === 43101) await trx.updateTable("wechat_member_bindings").set({ subscription_template: null }).where("id", "=", item.binding_id).execute();
      const retry = [-1, 40014, 42001, 45009, 45011, 43101].includes(result);
      await update.set({ state: result === 0 ? "ACCEPTED" : retry ? "RETRY" : "REJECTED", error_code: result || null }).execute();
    });
  }
  if (unavailable > 0) throw new Error("部分会员的微信接收资格暂无法核实。");
}

export function startExpiryReminders(app: FastifyInstance, db: Kysely<Database>, cfg: WechatMemberConfig, service: WechatService) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (!running) running = runExpiryReminders(db, cfg, service)
      .catch(() => app.log.error("会员权益到期提醒检查未完成，下次继续。")).finally(() => { running = undefined; });
  };
  app.addHook("onListen", async () => { timer = setInterval(tick, 10 * 60_000); timer.unref(); tick(); });
  app.addHook("preClose", async () => { clearInterval(timer); await running; });
}
