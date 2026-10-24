import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { workbenchExceptionCodes, type WorkbenchExceptionsQuery } from '@qintopia/contracts';
import type { Database } from '@qintopia/db';
import { getWorkbenchExceptions } from '../../../packages/db/src/workbench-exceptions.ts';
import { requirePrincipal, requirePropertyAccess } from './auth.ts';
import { DateTime, ErrorResponse, Id, LocalDate, Money } from './schemas.ts';

const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
export const WorkbenchExceptionsQuerySchema = Type.Object({
  propertyId: Id,
  afterId: Type.Optional(Id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
}, { additionalProperties: false });
export const WorkbenchExceptionsResponseSchema = Type.Object({
  propertyId: Id,
  businessDate: LocalDate,
  asOf: DateTime,
  totalOrders: Type.Integer({ minimum: 0 }),
  nextCursor: nullable(Id),
  items: Type.Array(Type.Object({
    orderId: Id,
    orderStatus: Type.String(),
    stayStatus: nullable(Type.String()),
    guestName: Type.String(),
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    unitLabel: nullable(Type.String()),
    orderHref: Type.String({ pattern: '^/orders/[^/?#]+$' }),
    reasons: Type.Array(Type.Object({
      code: Type.Union(workbenchExceptionCodes.map(code => Type.Literal(code))),
      category: Type.Union(['FULFILLMENT', 'FUNDS', 'INVENTORY', 'DATA'].map(value => Type.Literal(value))),
      message: Type.String({ minLength: 1 }),
      amount: nullable(Money)
    }, { additionalProperties: false }), { minItems: 1 })
  }, { additionalProperties: false }), { maxItems: 100 })
}, { additionalProperties: false });

export function registerWorkbench(app: FastifyInstance, db: Kysely<Database>) {
  app.get('/api/v1/workbench/exceptions', {
    schema: {
      tags: ['queries'],
      summary: 'Read actionable order exceptions across dates; one count per order',
      querystring: WorkbenchExceptionsQuerySchema,
      response: { 200: WorkbenchExceptionsResponseSchema, 400: ErrorResponse, 401: ErrorResponse,
        403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse }
    }
  }, async (request, reply) => {
    const query = request.query as WorkbenchExceptionsQuery;
    requirePropertyAccess(await requirePrincipal(db, request), query.propertyId, 'READ');
    reply.header('Cache-Control', 'no-store');
    return getWorkbenchExceptions(db, query);
  });
}
