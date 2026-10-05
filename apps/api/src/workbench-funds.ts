import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { listWorkbenchFundsExceptions, type WorkbenchFundsQuery } from "../../../packages/db/src/workbench-funds.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { ErrorResponse, Id } from "./schemas.ts";
const nullable = (type: ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>) => Type.Union([type,Type.Null()]);

export function registerWorkbenchFunds(app: FastifyInstance, db: Kysely<Database>) {
  app.get("/api/v2/workbench-funds-exceptions", { schema: {
    tags: ["queries"],
    querystring: Type.Object({propertyId:Id,query:Type.Optional(Type.String({maxLength:200})),
      cursor:Type.Optional(Type.String({minLength:1,maxLength:1000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),
    response: {200:Type.Object({enabled:Type.Boolean(),total:Type.Integer({minimum:0}),nextCursor:nullable(Type.String()),items:Type.Array(Type.Object({
      id:Type.String(),kind:Type.Union([Type.Literal("UNALLOCATED_COLLECTION"),Type.Literal("ORDER_EXCESS"),Type.Literal("UNASSIGNED_REFUND")]),
      orderId:nullable(Id),billId:nullable(Id),reference:nullable(Type.String()),customerLabel:nullable(Type.String()),roomLabel:nullable(Type.String()),
      amountMinor:nullable(Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER})),occurredAt:Type.String(),reason:Type.String()
    },{additionalProperties:false}))},{additionalProperties:false}),400:ErrorResponse,401:ErrorResponse,403:ErrorResponse,500:ErrorResponse}
  } }, async (request,reply) => {
    const query=request.query as WorkbenchFundsQuery;
    requirePropertyAccess(await requirePrincipal(db,request),query.propertyId,"READ");
    reply.header("Cache-Control","no-store");
    return listWorkbenchFundsExceptions(db,query);
  });
}
