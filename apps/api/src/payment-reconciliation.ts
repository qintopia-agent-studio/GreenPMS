import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { paymentReconciliationIssueCodes, type PaymentReconciliationQuery } from '@qintopia/contracts';
import type { Database } from '@qintopia/db';
import { getPaymentReconciliation } from '../../../packages/db/src/payment-reconciliation.ts';
import { requirePrincipal, requirePropertyAccess } from './auth.ts';
import { DateTime, ErrorResponse, Id } from './schemas.ts';
const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
const amount = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const nonnegative = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const paymentRefundContextSchemas = {
  refundSummary: Type.Optional(Type.Object({ succeededMinor: nonnegative, matchedMinor: nonnegative, unassignedMinor: nonnegative,
    pendingCount: nonnegative, reviewCount: nonnegative }, { additionalProperties: false })),
  relatedRefunds: Type.Optional(Type.Array(Type.Object({ billId: Id, refundReference: Type.String(), amountMinor: nullable(nonnegative),
    state: Type.String(), matchedMinor: nonnegative, unassignedMinor: nullable(nonnegative), needsReview: Type.Boolean() }, { additionalProperties: false })))
};
const totals = Type.Object({ externalMinor: amount, businessMinor: amount, unassignedMinor: amount, excessMinor: amount,
  unbackedMinor: amount, unknownCount: nonnegative }, { additionalProperties: false });
export const PaymentReconciliationResponseSchema = Type.Object({ propertyId: Id, asOf: DateTime,
  sync: Type.Object({ enabled: Type.Boolean(), lastSyncedAt: nullable(DateTime), hasError: Type.Boolean() }, { additionalProperties: false }),
  summary: Type.Object({ collections: totals, refunds: totals }, { additionalProperties: false }),
  totalItems: nonnegative, totalOpenItems: nonnegative, nextCursor: nullable(Type.String({ minLength: 1, maxLength: 220 })),
  items: Type.Array(Type.Object({ id: Type.String(), kind: Type.Union([Type.Literal('COLLECTION'), Type.Literal('REFUND')]),
    billId: nullable(Id), factId: nullable(Id), orderId: nullable(Id), membershipOrderId: nullable(Id), orderIds: Type.Array(Id),
    reference: nullable(Type.String()), originalTransactionReference: nullable(Type.String()), nickname: nullable(Type.String()), currency: Type.String(),
    amountMinor: nullable(nonnegative), allocatedMinor: amount, businessMinor: amount, unassignedMinor: nullable(amount), excessMinor: amount,
    occurredAt: DateTime, discoveredAt: nullable(DateTime),
    issues: Type.Array(Type.Object({ code: Type.Union(paymentReconciliationIssueCodes.map(code => Type.Literal(code))), message: Type.String() }, { additionalProperties: false }))
  }, { additionalProperties: false }), { maxItems: 100 })
}, { additionalProperties: false });
export function registerPaymentReconciliation(app: FastifyInstance, db: Kysely<Database>) {
  app.get('/api/v1/workbench/payment-reconciliation', { schema: {
    tags: ['queries'], summary: 'Persistent per-payment collection and refund reconciliation',
    querystring: Type.Object({ propertyId: Id,
      kind: Type.Optional(Type.Union(['ALL', 'COLLECTION', 'REFUND'].map(value => Type.Literal(value)))),
      status: Type.Optional(Type.Union(['OPEN', 'ALL'].map(value => Type.Literal(value)))),
      afterId: Type.Optional(Type.String({ minLength: 1, maxLength: 220 })), orderId: Type.Optional(Id),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    response: { 200: PaymentReconciliationResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse }
  } }, async (request, reply) => {
    const query = request.query as PaymentReconciliationQuery;
    requirePropertyAccess(await requirePrincipal(db, request), query.propertyId, 'READ');
    reply.header('Cache-Control', 'no-store');
    return getPaymentReconciliation(db, query);
  });
}
