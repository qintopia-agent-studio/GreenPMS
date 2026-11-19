import { defaultNoticeRules, memberFacingLabel, renderNoticeFields, type MemberNoticeRules } from "@qintopia/contracts";
import { deliverBookingResults } from "./wechat-booking-delivery.ts";
import { sql, type Kysely } from "kysely";
import type { FastifyInstance } from "fastify";
import {
  memberRuleVersion,
  recordMemberInteraction,
  setInteractionState,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import type { WechatMemberConfig, WechatService } from "./wechat-official-account.ts";

interface DueNotice {
  order_id: string;
  binding_id: string;
  member_id: string;
  open_id: string;
  product: string;
  expires_on: string;
  days: number;
}

function candidates(config: WechatMemberConfig, today: string, rules: MemberNoticeRules) {
  return sql`from membership_orders o
    join member_contracts c on c.id=o.contract_id and c.membership_order_id=o.id and c.member_id=o.member_id and c.property_id=o.property_id
    join entitlement_lots l on l.id=o.entitlement_lot_id and l.contract_id=c.id and l.unit_kind=o.entitlement_unit_kind
    join members m on m.id=o.member_id and m.deleted_at is null
    join wechat_member_bindings b on b.member_id=m.id and b.property_id=o.property_id
    where o.property_id=${config.propertyId} and b.app_id=${config.appId} and b.revoked_at is null
      and b.subscription_template=${rules.expiry!.template} and b.open_id is not null
      and o.status='ACTIVE' and c.status='ACTIVE' and l.status='ACTIVE' and c.valid_from <= ${today}::date
      and least(c.valid_until,l.expires_on) - ${today}::date in (${sql.join(rules.leadDays)})`;
}

export async function runExpiryReminders(db: Kysely<Database>, config: WechatMemberConfig, service: WechatService) {
  const defaults = { ...defaultNoticeRules, expiry: config.reminder ?? null };
  const { rules } = await memberRuleVersion(db, config.propertyId, defaults);
  if (!rules.expiryEnabled) return;
  const today = await propertyLocalToday(db, config.propertyId);
  const eventKey = (order: string, date: string, days: number) =>
    JSON.stringify(["expiry", config.appId, order, date, days]);
  const skipped = await sql<{
    order_id: string;
    member_id: string;
    binding_id: string | null;
    expires_on: string;
    days: number;
    product: string;
  }>`
    select o.id order_id,o.member_id,b.id binding_id,least(c.valid_until,l.expires_on)::text expires_on,
      least(c.valid_until,l.expires_on)-${today}::date days,o.product_name product
    from membership_orders o join member_contracts c on c.id=o.contract_id join entitlement_lots l on l.id=o.entitlement_lot_id
    join members m on m.id=o.member_id and m.deleted_at is null
    left join wechat_member_bindings b on b.app_id=${config.appId} and b.property_id=o.property_id and b.member_id=o.member_id and b.revoked_at is null
    where o.property_id=${config.propertyId} and o.status='ACTIVE' and c.status='ACTIVE' and l.status='ACTIVE' and c.valid_from<=${today}::date
      and least(c.valid_until,l.expires_on)-${today}::date in (${sql.join(rules.leadDays)})
      and (b.id is null or ${rules.expiry?.template ?? null}::text is null or b.subscription_template is distinct from ${rules.expiry?.template ?? null})`.execute(
    db
  );
  for (const item of skipped.rows) {
    await recordMemberInteraction(db, {
      event_key: eventKey(item.order_id, item.expires_on, item.days),
      app_id: config.appId,
      property_id: config.propertyId,
      member_id: item.member_id,
      binding_id: item.binding_id,
      kind: "权益到期",
      state: "SKIPPED",
      detail: !rules.expiry ? "到期模板未配置" : !item.binding_id ? "会员未绑定微信" : "未记录当前模板授权",
      template_id: rules.expiry?.template,
      content: JSON.stringify({
        权益: memberFacingLabel(item.product),
        到期日: item.expires_on,
        提前天数: String(item.days)
      })
    });
  }
  if (!rules.expiry) return;
  const due =
    await sql<DueNotice>`select o.id as order_id, o.member_id,b.id as binding_id, b.open_id, o.product_name as product,
    least(c.valid_until,l.expires_on)::text as expires_on, least(c.valid_until,l.expires_on) - ${today}::date as days
    ${candidates(config, today, rules)}
    and not exists (select 1 from wechat_member_expiry_notices n where n.app_id=b.app_id and n.order_id=o.id
      and n.expires_on=least(c.valid_until,l.expires_on) and n.lead_days=least(c.valid_until,l.expires_on)-${today}::date
      and (n.state <> 'RETRY' or n.attempted_at > now() - interval '10 minutes'))
    order by o.id`.execute(db);
  async function waiting(item: DueNotice, state: "PENDING" | "SKIPPED", detail: string) {
    await db
      .insertInto("wechat_member_interactions")
      .values({
        event_key: eventKey(item.order_id, item.expires_on, item.days),
        app_id: config.appId,
        property_id: config.propertyId,
        member_id: item.member_id,
        binding_id: item.binding_id,
        kind: "权益到期",
        state,
        detail,
        template_id: rules.expiry!.template
      })
      .onConflict((oc) =>
        oc
          .column("event_key")
          .doUpdateSet({ state, detail, updated_at: new Date() })
          .where("wechat_member_interactions.state", "in", ["SKIPPED", "PENDING"])
      )
      .execute();
  }
  let unavailable = 0;
  for (const item of due.rows) {
    // These calls cannot send a notification. A failure here leaves the notice eligible.
    let following: boolean;
    let token: string;
    try {
      following = await service.following(item.open_id);
      token = following ? await service.token() : "";
    } catch {
      await waiting(item, "PENDING", "等待微信恢复接口，尚未发送");
      unavailable++;
      continue;
    }
    if (!following) {
      await waiting(item, "SKIPPED", "会员当前未关注服务号");
      await db
        .updateTable("wechat_member_bindings")
        .set({ subscription_template: null })
        .where("id", "=", item.binding_id)
        .where("subscription_template", "=", rules.expiry.template)
        .execute();
      continue;
    }
    const key = { app_id: config.appId, order_id: item.order_id, expires_on: item.expires_on, lead_days: item.days };
    // Commit the reservation before calling a provider that offers no idempotency key.
    const ekey = eventKey(item.order_id, item.expires_on, item.days);
    const raw = renderNoticeFields(rules.expiry, {
      product: memberFacingLabel(item.product),
      expiry: item.expires_on,
      days: String(item.days)
    });
    const content = JSON.stringify(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.value])));
    const claim = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("wechat_member_expiry_notices")
        .values({ ...key, binding_id: item.binding_id, state: "UNKNOWN" })
        .onConflict((oc) =>
          oc
            .columns(["app_id", "order_id", "expires_on", "lead_days"])
            .doUpdateSet({
              binding_id: item.binding_id,
              state: "UNKNOWN",
              attempted_at: sql`now()`,
              error_code: null
            })
            .where("wechat_member_expiry_notices.state", "=", "RETRY")
            .where("wechat_member_expiry_notices.attempted_at", "<=", sql<Date>`now() - interval '10 minutes'`)
        )
        .returning("order_id")
        .executeTakeFirst();
      if (!row) return false;
      // Preserve the previous provider rejection and its exact payload when an eligible attempt is retried.
      const previous = await trx
        .selectFrom("wechat_member_interactions")
        .selectAll()
        .where("event_key", "=", ekey)
        .where("state", "=", "REJECTED")
        .forUpdate()
        .executeTakeFirst();
      if (previous)
        await trx
          .insertInto("wechat_member_interactions")
          .values({
            ...previous,
            event_key: ekey + ":" + previous.updated_at.toISOString(),
            content: JSON.stringify(previous.content)
          })
          .execute();
      await trx
        .insertInto("wechat_member_interactions")
        .values({
          event_key: ekey,
          app_id: config.appId,
          property_id: config.propertyId,
          member_id: item.member_id,
          binding_id: item.binding_id,
          kind: "权益到期",
          state: "UNKNOWN",
          detail: "微信受理结果待确认",
          template_id: rules.expiry!.template,
          content
        })
        .onConflict((oc) =>
          oc
            .column("event_key")
            .doUpdateSet({
              state: "UNKNOWN",
              detail: "微信受理结果待确认",
              template_id: rules.expiry!.template,
              content,
              updated_at: new Date()
            })
        )
        .execute();
      return true;
    });
    if (!claim) continue;
    await db.transaction().execute(async (trx) => {
      const currentDate = await propertyLocalToday(trx, config.propertyId);
      const current = await sql<{
        product: string;
      }>`select o.product_name as product ${candidates(config, currentDate, rules)}
        and o.id=${item.order_id} and b.id=${item.binding_id} and b.open_id=${item.open_id}
        and least(c.valid_until,l.expires_on)=${item.expires_on}::date and ${currentDate}::date=${today}::date
        for share of b,o,c,l`.execute(trx);
      const update = trx
        .updateTable("wechat_member_expiry_notices")
        .where("app_id", "=", key.app_id)
        .where("order_id", "=", key.order_id)
        .where("expires_on", "=", key.expires_on)
        .where("lead_days", "=", key.lead_days);
      const live = (await memberRuleVersion(trx, config.propertyId, defaults)).rules;
      if (
        !current.rows[0] ||
        !live.expiryEnabled ||
        !live.leadDays.includes(item.days) ||
        live.expiry?.template !== rules.expiry?.template
      ) {
        await setInteractionState(trx, ekey, "SKIPPED", "当前绑定、规则或到期日期已变化");
        await update.set({ state: "RETRY" }).execute();
        return;
      }
      let result: number;
      try {
        result = await service.send(token, item.open_id, item.product, item.expires_on, item.days, rules.expiry!);
      } catch {
        return;
      } // Timeout or lost reply. Do not deliver again without conclusive evidence.
      if (result === 43101)
        await trx
          .updateTable("wechat_member_bindings")
          .set({ subscription_template: null })
          .where("id", "=", item.binding_id)
          .execute();
      await setInteractionState(
        trx,
        ekey,
        result === 0 ? "ACCEPTED" : "REJECTED",
        result === 0 ? "微信已受理" : result === 43101 ? "微信未取得本次授权" : "微信拒绝，代码 " + result
      );
      const retry = [-1, 40014, 42001, 45009, 45011, 43101].includes(result);
      await update
        .set({ state: result === 0 ? "ACCEPTED" : retry ? "RETRY" : "REJECTED", error_code: result || null })
        .execute();
    });
  }
  if (unavailable > 0) throw new Error("部分会员的微信接收资格暂无法核实。");
}

export function startExpiryReminders(
  app: FastifyInstance,
  db: Kysely<Database>,
  cfg: WechatMemberConfig,
  service: WechatService
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (!running)
      running = Promise.allSettled([runExpiryReminders(db, cfg, service), deliverBookingResults(db, cfg, service)])
        .then((results) => {
          if (results.some((result) => result.status === "rejected"))
            app.log.error("部分服务号通知未完成检查，下次继续。");
        })
        .finally(() => {
          running = undefined;
        });
  };
  app.addHook("onListen", async () => {
    timer = setInterval(tick, 10 * 60_000);
    timer.unref();
    tick();
  });
  app.addHook("preClose", async () => {
    clearInterval(timer);
    await running;
  });
}
