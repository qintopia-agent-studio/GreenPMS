import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type MemberCenterState } from "@qintopia/contracts";
import { newId, sha256 } from "@qintopia/domain";
import { authorizeCommandAccess, memberCenterView, withCommandAuthorizationAudit, type Database } from "@qintopia/db";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { type WechatMemberConfig, type WechatService } from "./wechat-official-account.ts";
import { startExpiryReminders } from "./wechat-member-reminders.ts";

const sessionName = "__Host-greenpms-member", stateName = "__Host-greenpms-member-state";
const cookieOptions = { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" };
const publicRoot = "/api/wechat/member";
const privateResponse = (reply: FastifyReply) => reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
const hidden = { hide: true };
const denied = () => new DomainError("RESOURCE_SCOPE_DENIED", "请在本服务号内重新打开我的权益。", 403);
const conflict = () => new DomainError("VALIDATION_ERROR", "请核对当前绑定状态和最新绑定码，再试一次。", 409);
const chars = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const staffParams = Type.Object({ property: chars(160), member: chars(160) });
type StaffTarget = { property: string; member: string };
type StaffChange = { action: "BIND"; code: string; method: "IN_PERSON" | "REGISTERED_PHONE" } | { action: "REVOKE"; bindingId: string };

function safeEqual(a: string, b: string) {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function registerWechatMemberCenter(app: FastifyInstance, db: Kysely<Database>, config?: WechatMemberConfig, service?: WechatService) {
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
  async function revoke(trx: Transaction<Database>, id: string, openId: string, actor: string | null) {
    const c = available();
    await trx.updateTable("wechat_member_bindings").set({ open_id: null, revoked_at: new Date(), revoked_by: actor, subscription_template: null })
      .where("id", "=", id).where("open_id", "=", openId).execute();
    await trx.updateTable("wechat_member_sessions").set({ expires_at: new Date(), pairing_hash: null, pairing_expires_at: null })
      .where("app_id", "=", c.appId).where("property_id", "=", c.propertyId).where("open_id", "=", openId).execute();
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
    const secret = randomBytes(32).toString("hex"), expires = new Date(Date.now() + 24 * 3600_000);
    await db.transaction().execute(async trx => {
      await sql`select qintopia_prune_wechat_member_sessions()`.execute(trx);
      await trx.insertInto("wechat_member_sessions").values({ app_id: c.appId, property_id: c.propertyId, open_id: openId, secret_hash: sha256(secret), expires_at: expires }).execute();
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
      const binding = await bindings(trx).select(["b.member_id", "b.subscription_template"]).where("b.open_id", "=", session.open_id).executeTakeFirst();
      if (!binding) return { status: "UNBOUND" } as const;
      return { status: "BOUND", view: await memberCenterView(trx, config.propertyId, binding.member_id, req.query.cursor),
        remindersEnabled: Boolean(config.reminder), subscribed: Boolean(config.reminder && config.reminder.template === binding.subscription_template) } as const;
    });
  });
  app.post(publicRoot + "/pair", { schema: hidden, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    privateResponse(reply); sameOrigin(req);
    return db.transaction().execute(async trx => {
      await lockBindingChanges(trx);
      const session = await identity(trx, req);
      if (!session) throw denied();
      if (await bindings(trx).select("b.id").where("b.open_id", "=", session.open_id).executeTakeFirst()) throw conflict();
      const code = randomBytes(5).toString("hex").toUpperCase(), expires = new Date(Date.now() + 600_000);
      await trx.updateTable("wechat_member_sessions").set({ pairing_hash: null, pairing_expires_at: null })
        .where("app_id", "=", config!.appId).where("property_id", "=", config!.propertyId).where("open_id", "=", session.open_id).execute();
      await trx.updateTable("wechat_member_sessions").set({ pairing_hash: sha256(code), pairing_expires_at: expires }).where("secret_hash", "=", session.secret_hash).execute();
      return { code, expiresAt: expires.toISOString() };
    });
  });
  app.post(publicRoot + "/unlink", { schema: hidden }, async (req, reply) => {
    privateResponse(reply); sameOrigin(req);
    await db.transaction().execute(async trx => {
      await lockBindingChanges(trx);
      const session = await identity(trx, req);
      if (!session) throw denied();
      const binding = await bindings(trx).select("b.id").where("b.open_id", "=", session.open_id).forUpdate("b").executeTakeFirst();
      if (binding) await revoke(trx, binding.id, session.open_id, null);
    });
    reply.clearCookie(sessionName, cookieOptions);
    return { ok: true };
  });
  app.get(publicRoot + "/subscription", { schema: hidden }, async (req, reply) => {
    privateResponse(reply);
    const c = available(), session = await identity(db, req);
    if (!session || !c.reminder || !await bindings(db).select("b.id").where("b.open_id", "=", session.open_id).executeTakeFirst()) throw denied();
    return { template: c.reminder.template, ...await service!.subscriptionSignature() };
  });
  app.post<{ Body: { enabled: boolean; template: string } }>(publicRoot + "/subscription", { schema: { ...hidden, body: Type.Object({ enabled: Type.Boolean(), template: chars(160) }, { additionalProperties: false }) } }, async (req, reply) => {
    privateResponse(reply); sameOrigin(req);
    const c = available();
    if (!c.reminder || req.body.template !== c.reminder.template) throw denied();
    await db.transaction().execute(async trx => {
      const session = await identity(trx, req);
      if (!session) throw denied();
      const binding = await bindings(trx).select("b.id").where("b.open_id", "=", session.open_id).forUpdate("b").executeTakeFirst();
      if (!binding) throw denied();
      await trx.updateTable("wechat_member_bindings").set({ subscription_template: req.body.enabled ? c.reminder!.template : null }).where("id", "=", binding.id).execute();
    });
    return { ok: true };
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
  app.post<{ Params: StaffTarget; Body: StaffChange }>(staffPath, { schema: { ...hidden, params: staffParams, body: Type.Union([
    Type.Object({ action: Type.Literal("BIND"), code: Type.String({ pattern: "^[A-Fa-f0-9]{10}$" }), method: Type.Union([Type.Literal("IN_PERSON"), Type.Literal("REGISTERED_PHONE")]) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("REVOKE"), bindingId: chars(160) }, { additionalProperties: false })
  ]) }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    privateResponse(reply);
    const c = available(), { member, property } = req.params;
    if (property !== c.propertyId) throw denied();
    return staff(req, req.params, async (trx, subject) => {
      await lockBindingChanges(trx);
      const exists = await trx.selectFrom("members as m").innerJoin("member_property_links as link", "m.id", "link.member_id")
        .select("m.id").where("link.property_id", "=", property).where("m.id", "=", member).where("m.deleted_at", "is", null).forShare("m").executeTakeFirst();
      if (!exists) throw denied();
      const current = await bindings(trx).select(["b.id", "b.open_id"]).where("b.member_id", "=", member).forUpdate("b").executeTakeFirst();
      if (req.body.action === "REVOKE") {
        if (!current?.open_id || current.id !== req.body.bindingId) throw conflict();
        await revoke(trx, current.id, current.open_id, subject);
        return { bindingId: null };
      }
      if (current) throw conflict();
      const candidate = await trx.selectFrom("wechat_member_sessions").select(["secret_hash", "open_id"])
        .where("app_id", "=", c.appId).where("property_id", "=", property).where("pairing_hash", "=", sha256(req.body.code.toUpperCase()))
        .where("pairing_expires_at", ">", sql<Date>`clock_timestamp()`).where("expires_at", ">", sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
      if (!candidate || await bindings(trx).select("b.id").where("b.open_id", "=", candidate.open_id).executeTakeFirst()) throw conflict();
      const id = newId("wxbind");
      await trx.insertInto("wechat_member_bindings").values({ id, app_id: c.appId, property_id: property, member_id: member, open_id: candidate.open_id,
        verified_by: subject, verification: req.body.method }).execute();
      await trx.updateTable("wechat_member_sessions").set({ pairing_hash: null, pairing_expires_at: null }).where("secret_hash", "=", candidate.secret_hash).execute();
      return { bindingId: id };
    });
  });
  if (config?.reminder && service) startExpiryReminders(app, db, config, service);
}
