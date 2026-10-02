import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { readPaymentAllocationEventHead, readPaymentAllocationEvents } from "../../../packages/db/src/payment-allocation-events.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { Id, ErrorResponse } from "./schemas.ts";

const cursorSchema=Type.String({pattern:"^(0|[1-9][0-9]{0,18})$"});
const headSchema=Type.Object({schemaVersion:Type.Literal("pms.payments.v2"),propertyId:Id,headCursor:cursorSchema},{additionalProperties:false});
const eventSchema=Type.Object({eventId:Type.String({minLength:1,maxLength:256}),sequence:cursorSchema,billVersion:cursorSchema,billId:Id,
 eventType:Type.Union(["DISCOVERED","SOURCE_CHANGED","ALLOCATED","ALLOCATION_RELEASED","RETAINED","RETENTION_CHANGED"].map(value=>Type.Literal(value))),
 occurredAt:Type.String({format:"date-time"}),stateReference:Type.Object({path:Type.Literal("/api/v2/external-payments"),propertyId:Id,billId:Id,
 kind:Type.Union([Type.Literal("COLLECTION"),Type.Literal("REFUND")]),status:Type.Literal("ALL")},{additionalProperties:false})},{additionalProperties:false});
const pageSchema=Type.Object({schemaVersion:Type.Literal("pms.payments.v2"),propertyId:Id,events:Type.Array(eventSchema),nextCursor:cursorSchema},{additionalProperties:false});

export function registerPaymentAllocationEvents(app: FastifyInstance, db: Kysely<Database>) {
  app.get("/api/v2/external-payment-events/head", {schema: {tags: ["queries"], querystring: Type.Object({propertyId: Id}, {additionalProperties: false}), response: {200: headSchema,400: ErrorResponse,401: ErrorResponse,403: ErrorResponse,500: ErrorResponse}}}, async (request, reply) => {
    const {propertyId} = request.query as {propertyId: string};
    requirePropertyAccess(await requirePrincipal(db, request), propertyId, "READ");
    reply.header("Cache-Control", "no-store");
    return readPaymentAllocationEventHead(db, propertyId);
  });
  app.get("/api/v2/external-payment-events", {schema: {tags: ["queries"], querystring: Type.Object({propertyId: Id,
    cursor: Type.Optional(Type.String({pattern: "^(0|[1-9][0-9]{0,18})$"})), limit: Type.Optional(Type.Integer({minimum: 1,maximum: 100}))}, {additionalProperties: false}), response: {200: pageSchema,400: ErrorResponse,401: ErrorResponse,403: ErrorResponse,500: ErrorResponse}}}, async (request, reply) => {
    const q = request.query as {propertyId: string; cursor?: string; limit?: number};
    requirePropertyAccess(await requirePrincipal(db, request), q.propertyId, "READ");
    reply.header("Cache-Control", "no-store");
    return readPaymentAllocationEvents(db, q.propertyId, q.cursor, q.limit);
  });
}
