import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { listExternalPayments, readExternalPaymentEvents } from "../../../packages/db/src/external-payments.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { ErrorResponse, Id } from "./schemas.ts";
const nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(s: T) => Type.Union([s, Type.Null()]);
const status = Type.Union(["AVAILABLE", "MATCHED", "HISTORICAL", "REVIEW", "PENDING", "UNVERIFIED"].map(v => Type.Literal(v)));
const item = Type.Object({ id: Id, kind: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND")]),
  reference: Type.String(), originalTransactionReference: nullable(Type.String()), amountMinor: nullable(Type.Integer()),
  occurredAt: Type.String({ format: "date-time" }), nickname: nullable(Type.String()), status,
  orderId: nullable(Id), membershipOrderId: nullable(Id), recommendationReasons: Type.Array(Type.String()) }, { additionalProperties: false });
export function registerExternalPayments(app: FastifyInstance, db: Kysely<Database>) {
  app.get("/api/v1/external-payments", { schema: { tags: ["queries"], querystring: Type.Object({
    propertyId: Id, kind: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND")]),
    recommended: Type.Optional(Type.Boolean()), amountMinor: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })),
    query: Type.Optional(Type.String({ maxLength: 200 })), status: Type.Optional(Type.Union(["AVAILABLE", "ALL", "MATCHED", "HISTORICAL"].map(v => Type.Literal(v)))),
    begin: Type.Optional(Type.String({ format: "date-time" })), end: Type.Optional(Type.String({ format: "date-time" })),
    beforeId: Type.Optional(Id), billId: Type.Optional(Id), originalCollectionFactId: Type.Optional(Id), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  }, { additionalProperties: false }), response: { 200: Type.Object({ enabled: Type.Boolean(), lastSyncedAt: nullable(Type.String()),
    synchronizationError: Type.Boolean(), items: Type.Array(item), hasMore: Type.Boolean(), nextBeforeId: nullable(Id) }),
    400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse } } }, async (request, reply) => {
    const q = request.query as { propertyId: string; kind: "COLLECTION" | "REFUND"; recommended?: boolean; amountMinor?: number;
      query?: string; status?: "AVAILABLE" | "ALL" | "MATCHED" | "HISTORICAL"; begin?: string; end?: string;
      beforeId?: string; billId?: string; originalCollectionFactId?: string; limit?: number };
    requirePropertyAccess(await requirePrincipal(db, request), q.propertyId, "READ");
    const { begin, end, ...query } = q;
    reply.header("Cache-Control", "no-store");
    return listExternalPayments(db, q.propertyId, { ...query, ...(begin ? { begin: new Date(begin) } : {}), ...(end ? { end: new Date(end) } : {}) });
  });
  app.get("/api/v1/external-payment-events", { schema: { tags: ["queries"], querystring: Type.Object({
    propertyId: Id, cursor: Type.Optional(Type.String({ pattern: "^(0|[1-9][0-9]{0,18})$" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  }, { additionalProperties: false }) } }, async request => {
    const q = request.query as { propertyId: string; cursor?: string; limit?: number };
    requirePropertyAccess(await requirePrincipal(db, request), q.propertyId, "READ");
    return readExternalPaymentEvents(db, q.propertyId, q.cursor ?? "0", q.limit);
  });
}
