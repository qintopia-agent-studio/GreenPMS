import { staffSessionContext } from "./account-management.ts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  DomainError,
  defaultNoticeRules,
  validNoticeTemplate,
  type AuthPrincipal,
  type MemberNoticeRules
} from "@qintopia/contracts";
import {
  authorizeCommandAccess,
  withCommandAuthorizationAudit,
  createCommandPreview,
  confirmCommandPreview,
  bookingView,
  bookingUnitOptions,
  prepareBookingQuote,
  decideMemberBooking,
  pendingMemberBooking,
  publishMemberRules,
  memberRuleVersion,
  type Database
} from "@qintopia/db";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import type { WechatMemberConfig, WechatService } from "./wechat-official-account.ts";
import type { MemberSms } from "./tencent-member-sms.ts";
import { deliverBookingResults } from "./wechat-booking-delivery.ts";

export function accountDefaults(cfg?: WechatMemberConfig, sms?: MemberSms): MemberNoticeRules {
  return {
    ...defaultNoticeRules,
    expiry: cfg?.reminder ?? null,
    smsSign: sms?.defaults?.sign ?? "",
    smsTemplate: sms?.defaults?.template ?? ""
  };
}
export const smsAvailable = (sender: MemberSms | undefined, r: MemberNoticeRules) =>
  Boolean(sender && r.smsEnabled && (!sender.defaults || (r.smsSign && r.smsTemplate)));
const str = Type.String({ minLength: 1, maxLength: 160 }),
  optional = Type.Optional(str);
const obj = { additionalProperties: false } as const;
const propertyParams = Type.Object({ property: str }, obj),
  bookingParams = Type.Object({ property: str, id: str }, obj);
const template = Type.Union([
  Type.Null(),
  Type.Object({ template: str, fields: Type.Record(Type.String(), str, { maxProperties: 12 }) }, obj)
]);
const rulesBody = Type.Object(
  {
    version: Type.Integer({ minimum: 0 }),
    rules: Type.Object(
      {
        leadDays: Type.Array(Type.Integer({ minimum: 0, maximum: 3650 }), {
          uniqueItems: true,
          maxItems: 32,
          minItems: 1
        }),
        expiryEnabled: Type.Boolean(),
        bookingEnabled: Type.Boolean(),
        smsEnabled: Type.Boolean(),
        expiry: template,
        booking: template,
        smsSign: Type.String({ maxLength: 64 }),
        smsTemplate: Type.String({ pattern: "^[0-9]{0,30}$" })
      },
      obj
    )
  },
  obj
);
const listQuery = Type.Object(
  { offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), memberId: optional, state: optional },
  obj
);
type Params = { property: string; id: string };
type Filters = { offset?: number; memberId?: string; state?: string };
const denied = () => new DomainError("RESOURCE_SCOPE_DENIED", "当前账号无权访问本店服务号设置或预订。", 403);
export function registerWechatOperations(
  app: FastifyInstance,
  db: Kysely<Database>,
  cfg?: WechatMemberConfig,
  sender?: MemberSms,
  wx?: WechatService
) {
  const base = "/api/v1/properties/:property/member-";
  async function access<T>(
    req: FastifyRequest,
    property: string,
    admin: boolean,
    work: (trx: Transaction<Database>, p: AuthPrincipal) => Promise<T>
  ) {
    const principal = await requirePrincipal(db, req);
    requirePropertyAccess(principal, property, "WRITE");
    if (principal.credentialType !== "SESSION") throw denied();
    return withCommandAuthorizationAudit(db, () =>
      db.transaction().execute(async (trx) => {
        if (admin) {
          const actor = await staffSessionContext(trx, principal, property, true);
          if (actor.profile !== "ADMIN") throw denied();
        } else
          await authorizeCommandAccess(db, trx, principal, {
            propertyId: property,
            commandType: "CREATE_ORDER",
            stage: "COMMAND",
            mode: "EXECUTE"
          });
        return work(trx, principal);
      })
    );
  }
  function settings(trx: Transaction<Database>, property: string) {
    const active = cfg?.propertyId === property ? cfg : undefined;
    return memberRuleVersion(trx, property, accountDefaults(active, active ? sender : undefined)).then((version) => ({
      ...version,
      wechatReady: Boolean(active),
      smsReady: Boolean(active && sender),
      entry: active ? active.origin + "/member-center" : null
    }));
  }
  app.get<{ Params: Params }>(
    base + "notifications",
    { schema: { hide: true, params: propertyParams } },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      return access(req, req.params.property, true, (trx) => settings(trx, req.params.property));
    }
  );
  app.post<{ Params: Params; Body: { version: number; rules: MemberNoticeRules } }>(
    base + "notifications",
    { schema: { hide: true, params: propertyParams, body: rulesBody } },
    async (req) => {
      const { rules, version } = req.body;
      if (
        (rules.expiry && !validNoticeTemplate(rules.expiry, "expiry")) ||
        (rules.booking && !validNoticeTemplate(rules.booking, "booking")) ||
        Boolean(rules.smsSign.trim()) !== Boolean(rules.smsTemplate)
      ) {
        throw new DomainError("VALIDATION_ERROR", "请核对平台审核的模板、场景字段和短信签名。");
      }
      return access(req, req.params.property, true, async (trx, p) => {
        await publishMemberRules(trx, req.params.property, p.subjectId, version, {
          ...rules,
          smsSign: rules.smsSign.trim(),
          leadDays: [...rules.leadDays].sort((a, b) => b - a)
        });
        return settings(trx, req.params.property);
      });
    }
  );
  app.get<{ Params: Params; Querystring: Filters }>(
    base + "bookings",
    { schema: { hide: true, params: propertyParams, querystring: listQuery } },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      return access(req, req.params.property, false, async (trx) => {
        let query = trx
          .selectFrom("wechat_member_bookings as b")
          .innerJoin("members as m", "m.id", "b.member_id")
          .leftJoin("subjects as actor", "actor.id", "b.decided_by")
          .leftJoin("wechat_member_interactions as n", (join) =>
            join.on(sql<boolean>`n.event_key = 'booking:' || b.id`)
          )
          .selectAll("b")
          .select(["m.full_name", "n.detail", "actor.display_name as operator"])
          .where("b.property_id", "=", req.params.property);
        if (req.query.memberId) query = query.where("b.member_id", "=", req.query.memberId);
        const state = req.query.state;
        if (state === "PENDING" || state === "CONFIRMED" || state === "DECLINED")
          query = query.where("b.status", "=", state);
        const rows = await query
          .orderBy("b.created_at", "desc")
          .orderBy("b.id", "desc")
          .offset(req.query.offset ?? 0)
          .limit(31)
          .execute();
        return {
          items: rows.slice(0, 30).map((b) => ({
            ...bookingView(b),
            member: b.full_name,
            memberId: b.member_id,
            orderId: b.order_id,
            operator: b.operator,
            notice: b.detail
          })),
          more: rows.length > 30
        };
      });
    }
  );
  app.get<{ Params: Params; Querystring: Filters }>(
    base + "interactions",
    { schema: { hide: true, params: propertyParams, querystring: listQuery } },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      return access(req, req.params.property, false, async (trx) => {
        let q = trx
          .selectFrom("wechat_member_interactions as i")
          .leftJoin("members as m", "m.id", "i.member_id")
          .selectAll("i")
          .select("m.full_name")
          .where("i.property_id", "=", req.params.property);
        if (req.query.memberId) q = q.where("i.member_id", "=", req.query.memberId);
        if (req.query.state) q = q.where(sql<string>`i.state`, "=", req.query.state);
        const rows = await q
          .orderBy("i.created_at", "desc")
          .orderBy("i.event_key", "desc")
          .offset(req.query.offset ?? 0)
          .limit(31)
          .execute();
        return {
          items: rows.slice(0, 30).map((r) => ({
            id: r.event_key,
            member: r.full_name,
            kind: r.kind,
            state: r.state,
            detail: r.detail,
            template: r.template_id,
            content: r.content,
            created: r.created_at.toISOString(),
            updated: r.updated_at.toISOString()
          })),
          more: rows.length > 30
        };
      });
    }
  );
  app.get<{ Params: Params }>(
    base + "bookings/:id/units",
    { schema: { hide: true, params: bookingParams } },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      return access(req, req.params.property, false, async (trx) =>
        bookingUnitOptions(trx, await pendingMemberBooking(trx, req.params.property, req.params.id))
      );
    }
  );
  app.post<{ Params: Params; Body: { action: "CONFIRM" | "DECLINE"; unitId?: string } }>(
    base + "bookings/:id/decision",
    {
      schema: {
        hide: true,
        params: bookingParams,
        body: Type.Union([
          Type.Object({ action: Type.Literal("CONFIRM"), unitId: str }, obj),
          Type.Object({ action: Type.Literal("DECLINE") }, obj)
        ])
      }
    },
    async (req) => {
      const { property, id } = req.params;
      async function notify() {
        if (cfg?.propertyId === property && wx)
          await deliverBookingResults(db, cfg, wx, id).catch(() => app.log.warn("预订通知等待后台处理"));
      }
      const prepared = await access(req, property, false, async (trx, p) => {
        const b = await trx
          .selectFrom("wechat_member_bookings")
          .selectAll()
          .where("property_id", "=", property)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (!b) throw denied();
        if (b.status !== "PENDING") {
          if ((req.body.action === "DECLINE") !== (b.status === "DECLINED"))
            throw new DomainError("AGGREGATE_VERSION_CONFLICT", "申请已由其他操作处理，请刷新查看结果。", 409);
          if (b.order_id && req.body.action === "CONFIRM") {
            const initial = await trx
              .selectFrom("pricing_revisions")
              .select(sql<string>`coverage_set->0->>'inventoryUnitId'`.as("unit"))
              .where("order_id", "=", b.order_id)
              .where("revision_no", "=", 1)
              .executeTakeFirst();
            if (initial?.unit !== req.body.unitId)
              throw new DomainError("AGGREGATE_VERSION_CONFLICT", "该申请已确认其他房源，请查看已有住宿订单。", 409);
          }
          return { status: b.status, orderId: b.order_id };
        }
        if (req.body.action === "DECLINE") {
          await decideMemberBooking(trx, b, p.subjectId, null);
          return { status: "DECLINED", orderId: null };
        }
        return { quote: await prepareBookingQuote(trx, property, id, req.body.unitId!, p.subjectId), principal: p };
      });
      if (!prepared.quote) {
        await notify();
        return { status: prepared.status, orderId: prepared.orderId };
      }
      const { quote, principal } = prepared,
        metadata = (stage: string) => ({ idempotencyKey: quote.quoteId + stage, correlationId: id });
      const result = await createCommandPreview(
        db,
        principal,
        { commandType: "CREATE_ORDER", input: { propertyId: property, ...quote } },
        metadata("preview")
      );
      const receipt = await confirmCommandPreview(
        db,
        principal,
        result.preview.previewId,
        {
          commandType: "CREATE_ORDER",
          propertyId: property,
          confirmation: true,
          expectedEffectHash: result.preview.effectHash,
          reason: { code: "CREATE_STANDARD_ORDER", note: "" }
        },
        metadata("confirm")
      );
      if (!receipt.businessCommitted)
        throw new DomainError("AGGREGATE_VERSION_CONFLICT", "房态或权益已变化，请重新核对后排房。", 409);
      await notify();
      return { status: "CONFIRMED", orderId: receipt.result?.orderId };
    }
  );
}
