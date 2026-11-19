import { type Kysely } from "kysely";
import { memberRuleVersion, setInteractionState, type Database } from "@qintopia/db";
import type { WechatMemberConfig, WechatService } from "./wechat-official-account.ts";

export async function deliverBookingResults(
  db: Kysely<Database>,
  cfg: WechatMemberConfig,
  service: WechatService,
  id?: string
) {
  let pending = db
    .selectFrom("wechat_member_interactions")
    .select(["event_key", "binding_id", "template_id", "booking_id", "content"])
    .where("app_id", "=", cfg.appId)
    .where("property_id", "=", cfg.propertyId)
    .where("state", "=", "PENDING")
    .where("booking_id", "is not", null);
  if (id) pending = pending.where("booking_id", "=", id);
  for (const event of await pending.orderBy("created_at").limit(100).execute()) {
    let token: string;
    try {
      token = await service.token();
    } catch {
      continue;
    }
    // Commit the claim before a call whose outcome can be lost. Only the winning worker may submit.
    const claim = await db
      .updateTable("wechat_member_interactions")
      .set({ state: "UNKNOWN", detail: "微信受理结果待确认", updated_at: new Date() })
      .where("event_key", "=", event.event_key)
      .where("state", "=", "PENDING")
      .returning("event_key")
      .executeTakeFirst();
    if (!claim) continue;
    await db.transaction().execute(async (trx) => {
      const { rules } = await memberRuleVersion(trx, cfg.propertyId);
      const b = await trx
        .selectFrom("wechat_member_bindings")
        .select(["id", "open_id", "booking_template"])
        .where("id", "=", event.binding_id!)
        .where("app_id", "=", cfg.appId)
        .where("property_id", "=", cfg.propertyId)
        .where("revoked_at", "is", null)
        .forShare()
        .executeTakeFirst();
      if (
        !rules.bookingEnabled ||
        !event.template_id ||
        rules.booking?.template !== event.template_id ||
        !b?.open_id ||
        b.booking_template !== event.template_id
      ) {
        await setInteractionState(trx, event.event_key, "SKIPPED", "通知规则、绑定或接收授权已变化");
        return;
      }
      let result: number;
      try {
        const data = Object.fromEntries(
          Object.entries(event.content as Record<string, string>).map(([key, value]) => [key, { value }])
        );
        result = await service.sendFields(
          token,
          b.open_id,
          event.template_id,
          data,
          cfg.origin + "/member-center#booking=" + event.booking_id
        );
      } catch {
        return;
      }
      if (result === 43101)
        await trx
          .updateTable("wechat_member_bindings")
          .set({ booking_template: null })
          .where("id", "=", b.id)
          .execute();
      await setInteractionState(
        trx,
        event.event_key,
        result === 0 ? "ACCEPTED" : "REJECTED",
        result === 0 ? "微信已受理" : result === 43101 ? "微信未取得本次授权" : "微信拒绝，代码 " + result
      );
    });
  }
}
