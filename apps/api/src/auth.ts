import type { FastifyReply, FastifyRequest } from "fastify";
import "@fastify/cookie";
import type { Kysely } from "kysely";
import { DomainError, type AccessLevel, type AuthPrincipal, type ErrorCode } from "@qintopia/contracts";
import { accessAllows, narrowAccess, newId, newOpaqueSecret, sha256, verifyPassword } from "@qintopia/domain";
import { loadPropertyCommandGrantSnapshot, loadTokenCommandCeilingSnapshot, type Database } from "@qintopia/db";

declare module "fastify" {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
}

export const sessionCookieName = "qintopia_session";
const dummyPasswordSalt = "qintopia-invalid-user-v1";
const dummyPasswordHash = "46e8117cd88797d6b77fd9f684286cbe8ce6c71c518105720fe73a743055ddf93af1ba16ed44dca786334f09c816ba00a8f1a8fc5138014379ccdff992e4ed57";

export class KnownCredentialAuthenticationError extends DomainError {
  readonly identity: Pick<AuthPrincipal, "subjectId" | "credentialId" | "credentialType">;
  readonly denialReason: string;

  constructor(options: {
    subjectId: string;
    credentialId: string;
    credentialType: AuthPrincipal["credentialType"];
    denialReason: string;
    code: ErrorCode;
    message: string;
    statusCode: number;
  }) {
    super(options.code, options.message, options.statusCode);
    this.name = "KnownCredentialAuthenticationError";
    this.identity = {
      subjectId: options.subjectId,
      credentialId: options.credentialId,
      credentialType: options.credentialType
    };
    this.denialReason = options.denialReason;
  }
}

export function isKnownCredentialAuthenticationError(error: unknown): error is KnownCredentialAuthenticationError {
  return error instanceof KnownCredentialAuthenticationError;
}

function denyKnownCredential(options: ConstructorParameters<typeof KnownCredentialAuthenticationError>[0]): never {
  throw new KnownCredentialAuthenticationError(options);
}

async function subjectGrants(db: Kysely<Database>, subjectId: string): Promise<Map<string, AccessLevel>> {
  const rows = await db.selectFrom("subject_property_grants").select(["property_id", "access_level"]).where("subject_id", "=", subjectId).execute();
  return new Map(rows.map((row) => [row.property_id, row.access_level]));
}

export async function authenticateRequest(db: Kysely<Database>, request: FastifyRequest): Promise<AuthPrincipal> {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const secret = authorization.slice(7).trim();
    const token = await db.selectFrom("api_tokens")
      .innerJoin("subjects", "subjects.id", "api_tokens.subject_id")
      .select([
        "api_tokens.id", "api_tokens.subject_id", "api_tokens.access_ceiling", "api_tokens.property_scope", "api_tokens.expires_at", "api_tokens.revoked_at",
        "subjects.display_name", "subjects.status"
      ])
      .where("api_tokens.secret_hash", "=", sha256(secret)).executeTakeFirst();
    if (!token) throw new DomainError("AUTHENTICATION_REQUIRED", "Bearer token is invalid", 401);
    const tokenIdentity = { subjectId: token.subject_id, credentialId: token.id, credentialType: "TOKEN" as const };
    if (token.revoked_at) return denyKnownCredential({
      ...tokenIdentity,
      denialReason: "TOKEN_REVOKED",
      code: "TOKEN_REVOKED",
      message: "Bearer token has been revoked",
      statusCode: 401
    });
    if (new Date(token.expires_at).getTime() <= Date.now()) return denyKnownCredential({
      ...tokenIdentity,
      denialReason: "TOKEN_EXPIRED",
      code: "TOKEN_EXPIRED",
      message: "Bearer token has expired",
      statusCode: 401
    });
    if (token.status !== "ACTIVE") return denyKnownCredential({
      ...tokenIdentity,
      denialReason: "SUBJECT_DISABLED",
      code: "SUBJECT_DISABLED",
      message: "Subject is disabled",
      statusCode: 403
    });
    const grants = await subjectGrants(db, token.subject_id);
    const subjectLevel = grants.get(token.property_scope);
    if (!subjectLevel) return denyKnownCredential({
      ...tokenIdentity,
      denialReason: "PROPERTY_SCOPE_MISSING",
      code: "RESOURCE_SCOPE_DENIED",
      message: "Token property scope is no longer granted",
      statusCode: 403
    });
    return {
      subjectId: token.subject_id,
      credentialId: token.id,
      credentialType: "TOKEN",
      displayName: token.display_name,
      propertyAccess: new Map([[token.property_scope, narrowAccess(subjectLevel, token.access_ceiling)]]),
      propertyCommandGrants: await loadPropertyCommandGrantSnapshot(db, token.subject_id),
      tokenCommandCeiling: await loadTokenCommandCeilingSnapshot(db, token.id)
    };
  }

  const sessionSecret = request.cookies[sessionCookieName];
  if (!sessionSecret) throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
  const session = await db.selectFrom("web_sessions")
    .innerJoin("subjects", "subjects.id", "web_sessions.subject_id")
    .select(["web_sessions.id", "web_sessions.subject_id", "web_sessions.expires_at", "web_sessions.revoked_at", "subjects.display_name", "subjects.status"])
    .where("web_sessions.secret_hash", "=", sha256(sessionSecret)).executeTakeFirst();
  if (!session) throw new DomainError("AUTHENTICATION_REQUIRED", "Session is invalid or expired", 401);
  const sessionIdentity = { subjectId: session.subject_id, credentialId: session.id, credentialType: "SESSION" as const };
  if (session.revoked_at) return denyKnownCredential({
    ...sessionIdentity,
    denialReason: "SESSION_REVOKED",
    code: "AUTHENTICATION_REQUIRED",
    message: "Session is invalid or expired",
    statusCode: 401
  });
  if (new Date(session.expires_at).getTime() <= Date.now()) return denyKnownCredential({
    ...sessionIdentity,
    denialReason: "SESSION_EXPIRED",
    code: "AUTHENTICATION_REQUIRED",
    message: "Session is invalid or expired",
    statusCode: 401
  });
  if (session.status !== "ACTIVE") return denyKnownCredential({
    ...sessionIdentity,
    denialReason: "SUBJECT_DISABLED",
    code: "SUBJECT_DISABLED",
    message: "Subject is disabled",
    statusCode: 403
  });
  return {
    subjectId: session.subject_id,
    credentialId: session.id,
    credentialType: "SESSION",
    displayName: session.display_name,
    propertyAccess: await subjectGrants(db, session.subject_id),
    propertyCommandGrants: await loadPropertyCommandGrantSnapshot(db, session.subject_id),
    tokenCommandCeiling: null
  };
}

export async function requirePrincipal(db: Kysely<Database>, request: FastifyRequest): Promise<AuthPrincipal> {
  if (!request.principal) request.principal = await authenticateRequest(db, request);
  return request.principal;
}

export function requirePropertyAccess(principal: AuthPrincipal, propertyId: string, required: AccessLevel): void {
  const actual = principal.propertyAccess.get(propertyId);
  if (!actual) throw new DomainError("RESOURCE_SCOPE_DENIED", "Property is outside the credential scope", 403);
  if (!accessAllows(actual, required)) throw new DomainError("INSUFFICIENT_ACCESS", `${required} access is required`, 403);
}

export function requireScopedResourceAccess(principal: AuthPrincipal, propertyId: string): void {
  const actual = principal.propertyAccess.get(propertyId);
  if (!actual) throw new DomainError("NOT_FOUND", "Resource not found", 404);
  if (!accessAllows(actual, "READ")) throw new DomainError("NOT_FOUND", "Resource not found", 404);
}

export async function login(db: Kysely<Database>, username: string, password: string, reply: FastifyReply) {
  const subject = await db.selectFrom("subjects").selectAll().where("username", "=", username).executeTakeFirst();
  const passwordMatches = await verifyPassword(password, subject?.password_salt ?? dummyPasswordSalt, subject?.password_hash ?? dummyPasswordHash);
  if (!subject || subject.status !== "ACTIVE" || !passwordMatches) {
    throw new DomainError("INVALID_CREDENTIALS", "Username or password is incorrect", 401);
  }
  const secret = newOpaqueSecret("qts");
  const sessionId = newId("session");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60_000);
  await db.insertInto("web_sessions").values({
    id: sessionId, subject_id: subject.id, secret_hash: sha256(secret), expires_at: expiresAt, revoked_at: null
  }).execute();
  reply.setCookie(sessionCookieName, secret, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.SESSION_COOKIE_SECURE === "true",
    expires: expiresAt
  });
  return { subjectId: subject.id, displayName: subject.display_name, expiresAt: expiresAt.toISOString() };
}

export async function logout(db: Kysely<Database>, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const principal = await requirePrincipal(db, request);
  if (principal.credentialType !== "SESSION") {
    throw new DomainError("INSUFFICIENT_ACCESS", "Bearer tokens must be revoked through the REVOKE_TOKEN command", 403);
  }
  await db.updateTable("web_sessions").set({ revoked_at: new Date() }).where("id", "=", principal.credentialId).execute();
  reply.clearCookie(sessionCookieName, { path: "/" });
}
