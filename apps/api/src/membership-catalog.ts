import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { DomainError } from "@qintopia/contracts";
import { Type } from "@sinclair/typebox";
import { readMembershipCatalog, membershipProductsForProperty } from "../../../packages/db/src/membership-catalog.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { MembershipCatalogViewSchema } from "./membership-catalog-schemas.ts";
import { ErrorResponse, MembershipProductRowSchema } from "./schemas.ts";
export function registerMembershipCatalog(app: FastifyInstance, db: Kysely<Database>) {
  app.get("/api/v1/properties/:id/membership-catalog", { schema: { tags: ["queries"],
    params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }),
    response: { 200: MembershipCatalogViewSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse,
      404: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse } } }, async request => {
    const { id } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "WRITE");
    const admin = await db.selectFrom("staff_profile_assignments").select("profile").where("subject_id", "=", principal.subjectId)
      .where("property_id", "=", id).where("profile", "=", "ADMIN").executeTakeFirst();
    const grant = await db.selectFrom("subject_command_grants").select("command_type").where("subject_id", "=", principal.subjectId)
      .where("property_id", "=", id).where("command_type", "=", "MANAGE_MEMBERSHIP_CATALOG").executeTakeFirst();
    if (principal.credentialType !== "SESSION" || !admin || !grant) throw new DomainError("INSUFFICIENT_ACCESS", "仅管理员登录后可管理会员产品", 403);
    return readMembershipCatalog(db, id);
  });
  app.get("/api/v1/properties/:id/membership-versions", { schema: { tags: ["queries"], params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }), response: { 200: Type.Array(MembershipProductRowSchema), 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse, 429: ErrorResponse, 503: ErrorResponse } } }, async request => {
    const { id } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "WRITE");
    const admin = await db.selectFrom("staff_profile_assignments").select("profile").where("subject_id", "=", principal.subjectId)
      .where("property_id", "=", id).where("profile", "=", "ADMIN").executeTakeFirst();
    const grant = await db.selectFrom("subject_command_grants").select("command_type").where("subject_id", "=", principal.subjectId)
      .where("property_id", "=", id).where("command_type", "=", "BACKFILL_HISTORICAL_MEMBERSHIP").executeTakeFirst();
    if (principal.credentialType !== "SESSION" || !admin || !grant) throw new DomainError("INSUFFICIENT_ACCESS", "仅获授权管理员可查询历史补录产品", 403);
    return membershipProductsForProperty(db, id, true);
  });

}
