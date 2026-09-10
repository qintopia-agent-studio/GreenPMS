import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import { PmsOrderProjectionSchema, PmsMemberProjectionSchema, PmsInventoryProjectionSchema, PmsOrdersScanSchema, PmsEventFeedSchema } from "../../../packages/contracts/src/pms-integration.ts";
import { readPmsOrder, readPmsMember, readPmsInventory, scanPmsOrders, readPmsEventFeed } from "../../../packages/db/src/integration-queries.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { ErrorResponse, Id, IdParams } from "./schemas.ts";
const failures = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 410: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse };
const scope = { propertyId: Id };
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 100 }));
export function registerPmsIntegration(app: FastifyInstance, db: Kysely<Database>) {
    const base = "/api/v1/integrations/agent-os";
    for (const [path, schema, read] of [
        ["orders", PmsOrderProjectionSchema, readPmsOrder],
        ["members", PmsMemberProjectionSchema, readPmsMember],
        ["inventory-units", PmsInventoryProjectionSchema, readPmsInventory]
    ] as const) {
        app.get(`${base}/${path}/:id`, { schema: { tags: ["queries"], params: IdParams, querystring: Type.Object(scope, { additionalProperties: false }), response: { 200: schema, ...failures } } }, async (request) => {
            const { propertyId } = request.query as {
                propertyId: string;
            };
            requirePropertyAccess(await requirePrincipal(db, request), propertyId, "READ");
            return read(db, propertyId, (request.params as {
                id: string;
            }).id);
        });
    }
    app.get(`${base}/orders`, { schema: { tags: ["queries"], querystring: Type.Object({ ...scope, afterId: Type.Optional(Id), limit }, { additionalProperties: false }), response: { 200: PmsOrdersScanSchema, ...failures } } }, async (request) => {
        const q = request.query as {
            propertyId: string;
            afterId?: string;
            limit?: number;
        };
        requirePropertyAccess(await requirePrincipal(db, request), q.propertyId, "READ");
        return scanPmsOrders(db, q.propertyId, q.afterId, q.limit);
    });
    app.get("/api/v1/integration-events", { schema: { tags: ["queries"], description: "Stored event JSON objects retain exactly the webhook bytes. Extract raw event slices before hashing.", querystring: Type.Object({ ...scope, cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })), limit }, { additionalProperties: false }), response: { 200: PmsEventFeedSchema, ...failures } } }, async (request, reply) => {
        const q = request.query as {
            propertyId: string;
            cursor?: string;
            limit?: number;
        };
        requirePropertyAccess(await requirePrincipal(db, request), q.propertyId, "READ");
        const raw = await readPmsEventFeed(db, q.propertyId, q.cursor, q.limit);
        return reply.type("application/json; charset=utf-8").serializer(value => value as string).send(raw);
    });
}
