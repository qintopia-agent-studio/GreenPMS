import { MemberSmsRejected } from "./tencent-member-sms.ts";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type MemberCenterState, type MemberNoticeRules } from "@qintopia/contracts";
import { sha256 } from "@qintopia/domain";
import { authorizeCommandAccess, memberCenterView, withCommandAuthorizationAudit, memberRuleVersion, memberBookingRooms, propertyLocalToday, currentMemberBooking, submitMemberBooking, recordMemberInteraction, setInteractionState, type Database } from "@qintopia/db";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { type WechatMemberConfig, type WechatService } from "./wechat-official-account.ts";
import { startExpiryReminders } from "./wechat-member-reminders.ts";
import { accountDefaults, registerWechatOperations, smsAvailable } from "./wechat-member-operations.ts";
import type { MemberSms } from "./tencent-member-sms.ts";
import { clearMemberCodes, requestMemberCode, verifyMemberCode } from "./wechat-sms-binding.ts";

const sessionName = "__Host-greenpms-member", stateName = "__Host-greenpms-member-state";
const cookieOptions = { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" };
const publicRoot = "/api/wechat/member";
const privateResponse = (reply: FastifyReply) => reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
const hidden = { hide: true };
const denied = () => new DomainError("RESOURCE_SCOPE_DENIED", "请在本服务号内重新打开我的权益。", 403);
const conflict = () => new DomainError("VALIDATION_ERROR", "绑定状态已变化，请重新查看。", 409);
const chars = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const staffParams = Type.Object({ property: chars(160), member: chars(160) });
type StaffTarget = { property: string; member: string };
type StaffChange = { action: "REVOKE"; bindingId: string };

function safeEqual(a: string, b: string) {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function registerWechatMemberCenter(app: FastifyInstance, db: Kysely<Database>, config?: WechatMemberConfig, service?: WechatService, sms?: MemberSms) {
  registerWechatOperations(app,db,config,sms,service);
  const rulesFor = async (trx: Kysely<Database>) => (await memberRuleVersion(trx,available().propertyId,accountDefaults(config,sms))).rules;
  const sending = new Set<Promise<void>>();
  app.addHook("onClose", async () => { await Promise.all(sending); });
  const available = () => {
    if (!config || !service) throw new DomainError("NOT_FOUND", "服务号会员权益尚未开通。", 404);
    return config;
  };
  const identity = async (trx: Kysely<Database>, req: FastifyRequest) => {
    const c = available(), cookie = req.cookies[sessionName];
    if (!cookie) return;
    return trx.selectFrom("wechat_member_sessions").select(["secret_hash", "open_id"])
      .where("secret_hash", "=", sha256(cookie)).where("app_id", "=", c.appId).where("property_id", "=", c.propertyId)
      .where("expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
  };
  const bindings = (trx: Kysely<Database>) => trx.selectFrom("wechat_member_bindings as b")
    .innerJoin("members as m", "m.id", "b.member_id").where("m.deleted_at", "is", null)
    .where("b.app_id", "=", available().appId).where("b.property_id", "=", available().propertyId).where("b.revoked_at", "is", null);
  async function lockBindingChanges(trx: Transaction<Database>) {
    const c = available();
    await sql`select pg_advisory_xact_lock(hashtextextended(${"wechat-members:" + c.appId + ":" + c.propertyId}, 0))`.execute(trx);
  }
  async function newSession(trx: Transaction<Database>, c: WechatMemberConfig, openId: string) {
    const secret = randomBytes(32).toString("hex"), expires = new Date(Date.now() + 24 * 3600_000);
    await trx.insertInto("wechat_member_sessions").values({ app_id: c.appId, property_id: c.propertyId, open_id: openId, secret_hash: sha256(secret), expires_at: expires }).execute();
    return { secret, expires };
  }
  async function retireSessions(trx: Transaction<Database>, c: WechatMemberConfig, openId: string) {
    await trx.updateTable("wechat_member_sessions").set({ expires_at: new Date() })
      .where("app_id", "=", c.appId).where("property_id", "=", c.propertyId).where("open_id", "=", openId).execute();
  }
  async function revoke(trx: Transaction<Database>, id: string, member: string, openId: string, actor: string | null) {
    const c = available();
    await trx.updateTable("wechat_member_bindings").set({ open_id: null, revoked_at: new Date(), revoked_by: actor, subscription_template: null, booking_template: null })
      .where("id", "=", id).where("open_id", "=", openId).execute();
    await recordMemberInteraction(trx,{event_key:"unlink:"+id,app_id:c.appId,property_id:c.propertyId,member_id:member,binding_id:id,kind:"解除微信绑定",
      state:"RECORDED",detail:actor?"员工核实后解绑":"会员主动解绑",content:"{}"});
    await clearMemberCodes(trx, c, member);
    await retireSessions(trx, c, openId);
  }
  function sameOrigin(req: FastifyRequest) {
    if (req.headers.origin !== available().origin) throw denied();
  }
  app.get(publicRoot + "/login", { schema: hidden, logLevel: "silent", config: { rateLimit: { max: 25, timeWindow: "1 minute" } } }, async (_req, reply) => {
    privateResponse(reply);
    const c = available(), nonce = randomBytes(18).toString("hex") + Date.now();
    const state = nonce + createHmac("sha256", c.secret).update("oauth:" + nonce).digest("hex");
    reply.setCookie(stateName, state, { ...cookieOptions, maxAge: 600 });
    const query = new URLSearchParams({ appid: c.appId, redirect_uri: c.origin + publicRoot + "/callback", response_type: "code", scope: "snsapi_base", state });
    return reply.redirect("https://open.weixin.qq.com/connect/oauth2/authorize?" + query.toString() + "#wechat_redirect");
  });
  app.get<{ Querystring: { code?: string; state?: string } }>(publicRoot + "/callback", { schema: hidden, logLevel: "silent" }, async (req, reply) => {
    privateResponse(reply);
    const c = available(), { code, state } = req.query;
    reply.clearCookie(stateName, cookieOptions);
    if (typeof state !== "string" || !/^[a-f0-9]{36}\d{13}[a-f0-9]{64}$/.test(state) || !safeEqual(state, req.cookies[stateName] ?? "")
      || typeof code !== "string" || code.length > 256 || !code) return reply.redirect("/member-center#auth-failed");
    const nonce = state.slice(0, 49), mac = state.slice(49);
    const age = Date.now() - Number(nonce.slice(36));
    if (age < 0 || age > 600_000 || !safeEqual(mac, createHmac("sha256", c.secret).update("oauth:" + nonce).digest("hex"))) return reply.redirect("/member-center#auth-failed");
    let openId: string;
    try { openId = await service!.recognize(code); } catch { return reply.redirect("/member-center#auth-failed"); }
    const { secret, expires } = await db.transaction().execute(async trx => {
      await sql`select qintopia_prune_wechat_member_sessions()`.execute(trx);
      return newSession(trx, c, openId);
    });
    reply.setCookie(sessionName, secret, { ...cookieOptions, expires });
    return reply.redirect("/member-center");
  });
  app.get<{ Querystring: { cursor?: string } }>(publicRoot, { schema: { ...hidden, querystring: Type.Object({ cursor: Type.Optional(chars(500)) }, { additionalProperties: false }) } }, async (req, reply): Promise<MemberCenterState> => {
    privateResponse(reply);
    if (!config) return { status: "DISABLED" };
    return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      const session = await identity(trx, req);
      if (!session) return { status: "SIGNED_OUT" } as const;
      const rules = await rulesFor(trx);
      const binding = await bindings(trx).select(["b.member_id", "b.subscription_template","b.booking_template"]).where("b.open_id", "=", session.open_id).executeTakeFirst();
      if (!binding) return { status: "UNBOUND", smsAvailable: smsAvailable(sms,rules) } as const;
      return { status: "BOUND", view: await memberCenterView(trx, config.propertyId, binding.member_id, req.query.cursor,rules.expiryEnabled ? rules.leadDays : []),
        remindersEnabled: Boolean(rules.expiryEnabled && rules.expiry), subscribed: Boolean(rules.expiry && rules.expiry.template === binding.subscription_template),
        bookingNoticeEnabled: Boolean(rules.bookingEnabled && rules.booking), bookingSubscribed: Boolean(rules.booking && rules.booking.template === binding.booking_template),
        leadDays:rules.expiryEnabled?rules.leadDays:[] } as const;
    });
  });
  const smsRoutes = { rateLimit: { max: 30, timeWindow: "1 minute" } };
  const phone = Type.String({ minLength: 1, maxLength: 32 });
  app.post<{ Body: { phone: string } }>(publicRoot + "/sms/request", { logLevel: "silent", config: smsRoutes,
    schema: { ...hidden, body: Type.Object({ phone }, { additionalProperties: false }) } }, async (req, reply) => {
    privateResponse(reply); sameOrigin(req);
    const c = available(), sender = sms;
    const delivery = await db.transaction().execute(async trx => {
      await lockBindingChanges(trx);
      const session = await identity(trx, req);
      if (!session) throw denied();
      const rules = await rulesFor(trx);
      if (!smsAvailable(sender,rules)) throw new DomainError("SERVICE_NOT_READY", "本店尚未开通短信验证。", 503);
      if (await bindings(trx).select("b.id").where("b.open_id", "=", session.open_id).executeTakeFirst()) throw conflict();
      const issued = await requestMemberCode(trx, c, session, req.body.phone);
      if (!issued) return;
      await recordMemberInteraction(trx,{event_key:issued.id,app_id:c.appId,property_id:c.propertyId,member_id:issued.member,kind:"绑定验证码",state:"UNKNOWN",
        detail:"短信受理结果待确认",template_id:rules.smsTemplate||null,content:JSON.stringify({签名:rules.smsSign,验证码:"******"})});
      return {...issued, settings:rules.smsSign&&rules.smsTemplate?{sign:rules.smsSign,template:rules.smsTemplate}:undefined};
    });
    if (delivery && sender) {
      // Send once after commit. The HTTP response is the same for a missing or ambiguous member.
      const job = Promise.resolve().then(() => sender.sendCode(delivery.phone, delivery.code, delivery.settings))
        .then(() => setInteractionState(db,delivery.id,"ACCEPTED","腾讯云已受理")).then(()=>{})
        .catch(async error => {
          if (error instanceof MemberSmsRejected) await setInteractionState(db,delivery.id,"REJECTED","腾讯云拒绝本次发送");
          else app.log.warn("会员绑定验证码未获短信服务确认");
        }).catch(() => app.log.warn("短信受理状态暂未更新"));
      sending.add(job);
      void job.finally(() => sending.delete(job));
    }
    return reply.code(202).send({ retryAfterSeconds: 60 });
  });
  app.post<{ Body: { phone: string; code: string } }>(publicRoot + "/sms/verify", { logLevel: "silent", config: smsRoutes,
    schema: { ...hidden, body: Type.Object({ phone, code: Type.String({ pattern: "^[0-9]{6}$" }) }, { additionalProperties: false }) } }, async (req, reply) => {
    privateResponse(reply); sameOrigin(req);
    const c = available();
    const result = await db.transaction().execute(async trx => {
      await lockBindingChanges(trx);
      const session = await identity(trx, req);
      if (!session) throw denied();
      if (!smsAvailable(sms,await rulesFor(trx))) throw new DomainError("SERVICE_NOT_READY", "本店尚未开通短信验证。", 503);
      const status = await verifyMemberCode(trx, c, session, req.body.phone, req.body.code);
      if (status !== "BOUND") return { status } as const;
      await retireSessions(trx, c, session.open_id);
      return { status, ...await newSession(trx, c, session.open_id) } as const;
    });
    if (result.status === "BOUND") {
      reply.setCookie(sessionName, result.secret, { ...cookieOptions, expires: result.expires });
      return { ok: true };
    }
    if (result.status === "CONFLICT") throw new DomainError("VALIDATION_ERROR", "该微信或会员档案已有绑定。换绑请先用原微信解除绑定。", 409);
    throw new DomainError("VALIDATION_ERROR", "手机号或验证码不正确，或验证码已失效。请核对后重试。", 400);
  });
  app.post(publicRoot + "/unlink", { schema: hidden }, async (req, reply) => {
    privateResponse(reply); sameOrigin(req);
    await db.transaction().execute(async trx => {
      await lockBindingChanges(trx);
      const session = await identity(trx, req);
      if (!session) throw denied();
      const binding = await bindings(trx).select(["b.id", "b.member_id"]).where("b.open_id", "=", session.open_id).forUpdate("b").executeTakeFirst();
      if (binding) await revoke(trx, binding.id, binding.member_id, session.open_id, null);
    });
    reply.clearCookie(sessionName, cookieOptions);
    return { ok: true };
  });
  async function currentBinding(trx: Kysely<Database>, req: FastifyRequest, lock = false) {
    const session = await identity(trx,req);
    if (!session) throw denied();
    const q = bindings(trx).select(["b.id","b.member_id"]).where("b.open_id","=",session.open_id);
    const bound = await (lock ? q.forShare("b") : q).executeTakeFirst();
    if (!bound) throw denied();
    return bound;
  }
  const noticeKind = Type.Union([Type.Literal("expiry"),Type.Literal("booking")]);
  const templateFor = (r:MemberNoticeRules,kind:"expiry"|"booking") => kind==="booking" ? r.bookingEnabled && r.booking : r.expiryEnabled && r.expiry;
  app.get<{Querystring:{kind?:"expiry"|"booking"}}>(publicRoot + "/subscription", { schema: {...hidden,querystring:Type.Object({kind:Type.Optional(noticeKind)})} }, async (req, reply) => {
    privateResponse(reply); available();
    await currentBinding(db,req);
    const template=templateFor(await rulesFor(db),req.query.kind??"expiry");
    if(!template) throw denied();
    return {template:template.template,...await service!.subscriptionSignature()};
  });
  app.post<{ Body: { enabled:boolean; template:string; kind?:"expiry"|"booking" } }>(publicRoot + "/subscription", {schema:{...hidden,
    body:Type.Object({enabled:Type.Boolean(),template:chars(160),kind:Type.Optional(noticeKind)},{additionalProperties:false})}}, async(req,reply)=>{
    privateResponse(reply); sameOrigin(req);
    const c=available(), kind=req.body.kind??"expiry";
    await db.transaction().execute(async trx=>{
      await lockBindingChanges(trx);
      const b=await currentBinding(trx,req);
      const template=templateFor(await rulesFor(trx),kind);
      if(!template || template.template!==req.body.template) throw denied();
      const value=req.body.enabled?template.template:null;
      await trx.updateTable("wechat_member_bindings").set(kind==="expiry"?{subscription_template:value}:{booking_template:value}).where("id","=",b.id).execute();
      await recordMemberInteraction(trx,{event_key:randomUUID(),app_id:c.appId,property_id:c.propertyId,member_id:b.member_id,binding_id:b.id,
        kind:kind==="booking"?"预订通知授权":"到期通知授权",state:"RECORDED",detail:value?"会员同意本次接收":"会员关闭接收",template_id:template.template,content:"{}"});
    });
    return {ok:true};
  });
  app.get<{Querystring:{offset?:number;id?:string}}>(publicRoot+"/bookings",{schema:{...hidden,querystring:Type.Object({
    offset:Type.Optional(Type.Integer({minimum:0,maximum:1000000})),id:Type.Optional(chars(64))},{additionalProperties:false})}},async(req,reply)=>{
    privateResponse(reply);
    const c=available();
    return db.transaction().setIsolationLevel("repeatable read").execute(async trx=>{
      const b=await currentBinding(trx,req);
      let q=trx.selectFrom("wechat_member_bookings as w").leftJoin("orders as o","o.id","w.order_id").selectAll("w")
        .select(["o.status as stay_status","o.arrival_date as stay_arrival","o.departure_date as stay_departure"])
        .where("w.app_id","=",c.appId).where("w.property_id","=",c.propertyId).where("w.member_id","=",b.member_id);
      if(req.query.id) q=q.where("w.id","=",req.query.id);
      const offset=req.query.offset??0, rows=await q.orderBy("w.created_at","desc").orderBy("w.id","desc").limit(21).offset(offset).execute();
      const today=await propertyLocalToday(trx,c.propertyId);
      const bookings=[];
      for(const row of rows.slice(0,20)) bookings.push(await currentMemberBooking(trx,row,today));
      return {bookings,rooms:await memberBookingRooms(trx,c.propertyId,b.member_id),today,next:rows.length>20?String(offset+20):null};
    });
  });
  app.post<{Body:{arrival:string;departure:string;roomType:string;kind:"ROOM"|"BED";requestKey:string}}>(publicRoot+"/bookings",{logLevel:"silent",config:{rateLimit:{max:25,timeWindow:"1 minute"}},schema:{...hidden,
    body:Type.Object({arrival:Type.String({format:"date"}),departure:Type.String({format:"date"}),roomType:chars(160),kind:Type.Union([Type.Literal("ROOM"),Type.Literal("BED")]),requestKey:Type.String({format:"uuid"})},{additionalProperties:false})}},async(req,reply)=>{
    privateResponse(reply);sameOrigin(req);const c=available();
    return db.transaction().execute(async trx=>{
      const b=await currentBinding(trx,req,true);
      return submitMemberBooking(trx,{appId:c.appId,propertyId:c.propertyId,memberId:b.member_id,bindingId:b.id},req.body);
    });
  });

  const staffPath = "/api/v1/wechat-member-bindings/:property/:member";
  async function staff<T>(req: FastifyRequest, target: StaffTarget, handle: (trx: Transaction<Database>, subject: string) => Promise<T>) {
    const principal = await requirePrincipal(db, req);
    requirePropertyAccess(principal, target.property, "WRITE");
    if (principal.credentialType !== "SESSION") throw denied();
    return withCommandAuthorizationAudit(db, () => db.transaction().execute(async trx => {
      await authorizeCommandAccess(db, trx, principal, { propertyId: target.property, commandType: "CREATE_MEMBER", stage: "COMMAND", mode: "EXECUTE" });
      return handle(trx, principal.subjectId);
    }));
  }
  app.get<{ Params: StaffTarget }>(staffPath, { schema: { ...hidden, params: staffParams } }, async (req, reply) => {
    privateResponse(reply);
    return staff(req, req.params, async trx => {
      if (!config || req.params.property !== config.propertyId) return { enabled: false };
      const bound = await bindings(trx).select("b.id").where("b.member_id", "=", req.params.member).executeTakeFirst();
      return { enabled: true, bindingId: bound?.id ?? null };
    });
  });
  app.post<{ Params: StaffTarget; Body: StaffChange }>(staffPath, { schema: { ...hidden, params: staffParams, body:
    Type.Object({ action: Type.Literal("REVOKE"), bindingId: chars(160) }, { additionalProperties: false }) }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    privateResponse(reply);
    const c = available(), { member, property } = req.params;
    if (property !== c.propertyId) throw denied();
    return staff(req, req.params, async (trx, subject) => {
      await lockBindingChanges(trx);
      const exists = await trx.selectFrom("members as m").innerJoin("member_property_links as link", "m.id", "link.member_id")
        .select("m.id").where("link.property_id", "=", property).where("m.id", "=", member).where("m.deleted_at", "is", null).forShare("m").executeTakeFirst();
      if (!exists) throw denied();
      const current = await bindings(trx).select(["b.id", "b.open_id"]).where("b.member_id", "=", member).forUpdate("b").executeTakeFirst();
      if (!current?.open_id || current.id !== req.body.bindingId) throw conflict();
      await revoke(trx, current.id, member, current.open_id, subject);
      return { bindingId: null };
    });
  });
  if (config && service) startExpiryReminders(app, db, config, service);
}
