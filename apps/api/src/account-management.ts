import { createHmac, randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import {
  DomainError, type AccountManagementContext, type AccountManagementRequest,
  type AccountManagementResult, type AuthPrincipal, type MemberDeletionPreview, type StaffAccountDto
} from "@qintopia/contracts";
import { hashPassword, newId, stableHash, verifyPassword } from "@qintopia/domain";
import type { Database } from "@qintopia/db";
import { requirePrincipal, sessionCookieName } from "./auth.ts";
import { ErrorResponse, Id } from "./schemas.ts";

const base = {
  propertyId: Id, requestId: Id, confirmation: Type.Literal(true),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" })
};
const target = { targetId: Id, expectedVersion: Type.String({ minLength: 1, maxLength: 64 }) };
const newPassword = Type.String({ minLength: 12, maxLength: 128 });
const managementSchema = Type.Union([
  Type.Object({ ...base, action: Type.Literal("CREATE_STAFF"), username: Type.String({ pattern: "^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,63}$" }), displayName: Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" }), newPassword }, { additionalProperties: false }),
  Type.Object({ ...base, ...target, action: Type.Literal("CHANGE_PASSWORD"), currentPassword: Type.String({ minLength: 1, maxLength: 256 }), newPassword }, { additionalProperties: false }),
  Type.Object({ ...base, ...target, action: Type.Literal("RESET_PASSWORD"), newPassword }, { additionalProperties: false }),
  Type.Object({ ...base, ...target, action: Type.Literal("DELETE_MEMBER"), confirmErroneousPayments: Type.Optional(Type.Literal(true)) }, { additionalProperties: false }),
  ...(["DISABLE_STAFF", "ENABLE_STAFF", "REVOKE_SESSIONS", "DELETE_STAFF"] as const).map((action) =>
    Type.Object({ ...base, ...target, action: Type.Literal(action) }, { additionalProperties: false }))
]);
const resultSchema = Type.Object({ operationId: Id, action: Type.String(), targetId: Id, displayName: Type.String(), completedAt: Type.String() }, { additionalProperties: false });
const selfSchema = { id: Id, username: Type.String(), displayName: Type.String(), version: Type.String() };
const staffSchema = Type.Object({ ...selfSchema, status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("DISABLED")]), lastLoginAt: Type.Union([Type.String(), Type.Null()]), activeSessions: Type.Integer(), canDelete: Type.Boolean() }, { additionalProperties: false });
const contextSchema = Type.Object({ self: Type.Object(selfSchema, { additionalProperties: false }), canManageStaff: Type.Boolean(), canDeleteMember: Type.Boolean(), accounts: Type.Array(staffSchema), history: Type.Array(Type.Intersect([resultSchema, Type.Object({ reason: Type.String(), actorName: Type.String() })])) }, { additionalProperties: false });
const previewSchema = Type.Object({ memberId: Id, fullName: Type.String(), nickname: Type.String(), phone: Type.String(), version: Type.String(), canDelete: Type.Boolean(), blockedReason: Type.Union([Type.String(), Type.Null()]), membershipOrderCount: Type.Integer(), roomNights: Type.Integer(), bedNights: Type.Integer(), reversalAmountMinor: Type.Integer() }, { additionalProperties: false });
const failures = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse };

async function sessionContext(db: Kysely<Database>, principal: AuthPrincipal, propertyId: string) {
  if (principal.credentialType !== "SESSION") throw new DomainError("INSUFFICIENT_ACCESS", "账号管理仅支持网页登录", 403);
  const actor = await db.selectFrom("subjects")
    .innerJoin("web_sessions", "web_sessions.subject_id", "subjects.id")
    .innerJoin("subject_property_grants", "subject_property_grants.subject_id", "subjects.id")
    .innerJoin("staff_profile_assignments", (join) => join.onRef("staff_profile_assignments.subject_id", "=", "subjects.id").onRef("staff_profile_assignments.property_id", "=", "subject_property_grants.property_id"))
    .select(["subjects.id", "subjects.username", "subjects.display_name", "subjects.auth_version", "staff_profile_assignments.profile"])
    .where("subjects.id", "=", principal.subjectId).where("subjects.status", "=", "ACTIVE")
    .where("web_sessions.id", "=", principal.credentialId).where("web_sessions.revoked_at", "is", null)
    .where("web_sessions.expires_at", ">", sql<Date>`clock_timestamp()`)
    .where("subject_property_grants.property_id", "=", propertyId).where("subject_property_grants.access_level", "=", "WRITE")
    .executeTakeFirst();
  if (!actor) throw new DomainError("INSUFFICIENT_ACCESS", "当前账号无权管理此门店的账号", 403);
  return actor;
}

function managementError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const value = error as { message?: string; code?: string; constraint?: string };
  const errors: Record<string, [string, number]> = {
    MANAGEMENT_SESSION: ["登录已失效，请重新登录", 401], MANAGEMENT_FORBIDDEN: ["无权执行此账号操作", 403],
    MANAGEMENT_NOT_FOUND: ["目标已不存在或不属于当前门店，请刷新", 404], MANAGEMENT_STALE: ["目标资料已变化，请刷新后重新核对", 409],
    MANAGEMENT_REUSED: ["本次请求已用于其他操作，请重新核对", 409], MANAGEMENT_MEMBER_LINKED: ["该会员存在未取消预订、已用权益或不支持的业务关联，请重新核对", 409],
    MANAGEMENT_PAYMENT_CONFIRMATION: ["请确认待冲销收款均为误录，本操作不办理真实退款", 400],
    MANAGEMENT_STAFF_USED: ["该员工已有登录、Token 或操作记录，请使用停用", 409], MANAGEMENT_PASSWORD: ["当前密码不正确，请重新输入", 400],
    MANAGEMENT_STAFF_INITIALIZED: ["初始化账号需要保留，请使用停用", 409],
    MANAGEMENT_USERNAME: ["该账号已存在，请使用其他账号名", 409], MANAGEMENT_INVALID: ["请核对必填内容并再次确认", 400]
  };
  const match = errors[value.message ?? ""];
  if (match) return new DomainError(match[1] === 401 ? "AUTHENTICATION_REQUIRED" : match[1] === 403 ? "INSUFFICIENT_ACCESS" : match[1] === 404 ? "NOT_FOUND" : match[1] === 409 ? "AGGREGATE_VERSION_CONFLICT" : "VALIDATION_ERROR", match[0], match[1]);
  if (value.code === "40001" || value.code === "40P01") return new DomainError("AGGREGATE_VERSION_CONFLICT", "目标正在被其他操作使用，请刷新后重试", 409, true);
  if (value.code === "23503") return new DomainError("VALIDATION_ERROR", "目标已有新的关联记录，不能删除", 409);
  if (value.code === "23505") return new DomainError("VALIDATION_ERROR", "账号或请求已存在，请刷新后核对", 409);
  // Database errors can include bound credential material. Never pass them to request logging.
  return new DomainError("INTERNAL_ERROR", "账号操作未完成，请刷新并核对记录", 500);
}

export function registerAccountManagement(app: FastifyInstance, db: Kysely<Database>) {
  app.get("/api/v1/account-management", { schema: { tags: ["auth"], querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: contextSchema, ...failures } } }, async (request): Promise<AccountManagementContext> => {
    const principal = await requirePrincipal(db, request);
    const { propertyId } = request.query as { propertyId: string };
    const actor = await sessionContext(db, principal, propertyId);
    const canManageStaff = actor.profile === "ADMIN";
    const accounts = canManageStaff ? (await sql<StaffAccountDto>`
      SELECT subject.id, subject.username, subject.display_name AS "displayName", subject.status,
        subject.auth_version::text AS version,
        (SELECT max(created_at) FROM web_sessions WHERE subject_id = subject.id)::text AS "lastLoginAt",
        (SELECT count(*)::integer FROM web_sessions WHERE subject_id = subject.id AND revoked_at IS NULL AND expires_at > clock_timestamp()) AS "activeSessions",
        EXISTS(SELECT 1 FROM account_management_operations WHERE action = 'CREATE_STAFF' AND target_id = subject.id AND property_id = ${propertyId})
          AND NOT EXISTS(SELECT 1 FROM web_sessions WHERE subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM api_tokens WHERE subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM command_executions WHERE subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM command_previews WHERE subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM audit_entries WHERE subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM security_audit_entries WHERE subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM quotes WHERE requester_subject_id = subject.id)
          AND NOT EXISTS(SELECT 1 FROM account_management_operations WHERE actor_subject_id = subject.id) AS "canDelete"
      FROM subjects AS subject JOIN staff_profile_assignments AS assignment ON assignment.subject_id = subject.id
      WHERE assignment.property_id = ${propertyId} AND assignment.profile = 'STAFF'
        AND NOT EXISTS(SELECT 1 FROM staff_profile_assignments WHERE subject_id = subject.id AND profile = 'ADMIN')
        AND NOT EXISTS(SELECT 1 FROM subject_property_grants WHERE subject_id = subject.id AND property_id <> ${propertyId})
      ORDER BY subject.created_at, subject.id
    `.execute(db)).rows : [];
    let historyQuery = db.selectFrom("account_management_operations")
      .innerJoin("subjects", "subjects.id", "account_management_operations.actor_subject_id")
      .select(["account_management_operations.result", "account_management_operations.reason", "subjects.display_name"])
      .where("property_id", "=", propertyId).orderBy("account_management_operations.created_at", "desc").limit(30);
    if (!canManageStaff) historyQuery = historyQuery.where("actor_subject_id", "=", actor.id);
    const history = (await historyQuery.execute()).map((row) => ({ ...(row.result as AccountManagementResult), reason: row.reason, actorName: row.display_name }));
    return { self: { id: actor.id, username: actor.username, displayName: actor.display_name, version: String(actor.auth_version) }, canManageStaff, canDeleteMember: canManageStaff, accounts, history };
  });

  app.get("/api/v1/members/:id/deletion-preview", { schema: { tags: ["auth"], params: Type.Object({ id: Id }), querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: previewSchema, ...failures } } }, async (request) => {
    const { propertyId } = request.query as { propertyId: string };
    const actor = await sessionContext(db, await requirePrincipal(db, request), propertyId);
    if (actor.profile !== "ADMIN") throw new DomainError("INSUFFICIENT_ACCESS", "仅管理员可删除会员", 403);
    const { id } = request.params as { id: string };
    const result = await sql<{ preview: MemberDeletionPreview | null }>`SELECT qintopia_member_deletion_basis(${id}, ${propertyId}) AS preview`.execute(db);
    if (!result.rows[0]?.preview) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
    return result.rows[0].preview;
  });

  app.post("/api/v1/account-management", {
    config: { rateLimit: { max: Number(process.env.ACCOUNT_MANAGEMENT_RATE_LIMIT_MAX ?? 20), timeWindow: "1 minute", groupId: "account-management" } },
    validatorCompiler: () => (data) => Value.Check(managementSchema, data)
      ? { value: data }
      : { error: new Error("请核对账号、密码、必填内容与二次确认；不接受额外字段") },
    schema: { tags: ["auth"], body: managementSchema, response: { 200: resultSchema, ...failures } }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const body = request.body as AccountManagementRequest;
    const sessionSecret = request.cookies[sessionCookieName];
    if (principal.credentialType !== "SESSION" || !sessionSecret) throw new DomainError("INSUFFICIENT_ACCESS", "账号管理仅支持网页登录", 403);
    try {
      const actor = await sessionContext(db, principal, body.propertyId);
      if (body.action !== "CHANGE_PASSWORD" && actor.profile !== "ADMIN") throw new DomainError("INSUFFICIENT_ACCESS", "无权执行此账号操作", 403);
      const { currentPassword, newPassword: password, ...publicInput } = body;
      let verifiedPasswordHash: string | undefined;
      if (body.action === "CHANGE_PASSWORD") {
        const own = await db.selectFrom("subjects").select(["password_salt", "password_hash"]).where("id", "=", principal.subjectId).executeTakeFirstOrThrow();
        if (!currentPassword || !await verifyPassword(currentPassword, own.password_salt, own.password_hash)) throw new DomainError("INVALID_CREDENTIALS", "当前密码不正确，请重新输入", 400);
        verifiedPasswordHash = own.password_hash;
      }
      const passwordSalt = password ? randomBytes(24).toString("hex") : undefined;
      const input = {
        ...publicInput, targetId: body.action === "CREATE_STAFF" ? newId("subject") : body.targetId,
        ...(password && passwordSalt ? { passwordSalt, passwordHash: hashPassword(password, passwordSalt) } : {}),
        ...(verifiedPasswordHash ? { verifiedPasswordHash } : {})
      };
      // Bind retries to the same session and complete request without persisting password digests.
      const requestHash = createHmac("sha256", sessionSecret).update(stableHash(body)).digest("hex");
      const result = await sql<{ result: AccountManagementResult }>`SELECT qintopia_manage_account(
        ${principal.subjectId}, ${principal.credentialId}, ${sessionSecret}, ${body.propertyId},
        ${newId("audit")}, ${body.requestId}, ${requestHash}, ${body.action}, ${JSON.stringify(input)}::jsonb
      ) AS result`.execute(db);
      return result.rows[0]!.result;
    } catch (error) {
      const safe = managementError(error);
      await db.insertInto("audit_entries").values({ id: newId("audit"), subject_id: principal.subjectId,
        credential_id: principal.credentialId, action: body.action, decision: "DENIED", command_id: null,
        correlation_id: body.requestId, reason: null, target_refs: JSON.stringify(body.targetId ? [body.targetId] : []), metadata: { code: safe.code }
      }).execute();
      throw safe;
    }
  });
}
