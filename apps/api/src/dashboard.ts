import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { dashboardMetrics, dashboardSources, type DashboardQuery, type DashboardMetric } from "@qintopia/contracts";
import type { Database } from "@qintopia/db";
import { getDashboard, getDashboardDetails } from "../../../packages/db/src/dashboard.ts";
import { requirePrincipal, requirePropertyAccess } from "./auth.ts";
import { ErrorResponse, Id, LocalDate } from "./schemas.ts";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const amount = Type.String({ pattern: "^-?[0-9]+$" });
const quality = Type.Union([Type.Literal("COMPLETE"), Type.Literal("PARTIAL"), Type.Literal("UNAVAILABLE")]);
const range = Type.Object({ from: LocalDate, to: LocalDate });
const totals = { paidUnitNights: count, freeUnitNights: count, capacityUnitNights: nullable(count), occupancyRate: nullable(Type.Number()), quality, reviewCount: count, reason: Type.String() };
const money = Type.Object({ currency: Type.String(), collectedMinor: amount, refundedMinor: amount, correctedMinor: amount, netMinor: nullable(amount), reviewCount: count, reviewMinor: amount });
const balance = Type.Object({ currency: Type.String(), amountMinor: amount, count });
const source = Type.Union(dashboardSources.map(value => Type.Literal(value)));
const metric = Type.Union(dashboardMetrics.map(value => Type.Literal(value)));
const queryProperties = { from: Type.Optional(LocalDate), to: Type.Optional(LocalDate), futureDays: Type.Optional(Type.Union([Type.Literal(14), Type.Literal(30)])), building: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), roomType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), source: Type.Optional(source) };
export const DashboardResponseSchema = Type.Object({ propertyId: Id, asOf: Type.String({ format: "date-time" }), businessDate: LocalDate, timezone: Type.String(), currency: Type.String(), definitionVersion: Type.String(), range, previousRange: range,
  history: Type.Object(totals), previous: Type.Object(totals), occupancyChangePoints: nullable(Type.Number()),
  stayTrend: Type.Array(Type.Object({ date: LocalDate, paid: count, free: count, capacity: nullable(count), quality })),
  breakdown: Type.Array(Type.Object({ building: Type.String(), roomType: Type.String(), ...totals })), sources: Type.Array(Type.Object({ source, unitNights: count })),
  money: Type.Array(money), previousMoney: Type.Array(money), moneyTrend: Type.Array(Type.Object({ date: LocalDate, money: Type.Array(money) })),
  current: Type.Object({ paidGuests: count, freeGuests: count, guestReviewOrders: count, arrivals: count, departures: count, overdue: count, debts: Type.Array(balance), retained: Type.Array(balance) }),
  future: Type.Array(Type.Object({ date: LocalDate, paid: count, free: count, maintenance: count, review: count, availableRooms: nullable(count), availableBeds: nullable(count), capacity: count, quality })),
  filters: Type.Object({ buildings: Type.Array(Type.String()), roomTypes: Type.Array(Type.String()) }), warnings: Type.Array(Type.String()) });
export const DashboardDetailsResponseSchema = Type.Object({ asOf: Type.String({ format: "date-time" }), definitionVersion: Type.String(), range, changedSinceSummary: Type.Boolean(), page: count, pageSize: count, total: count,
  items: Type.Array(Type.Object({ id: Type.String(), date: LocalDate, metric, label: Type.String(), orderId: nullable(Id), memberId: nullable(Id), unitId: nullable(Id), units: nullable(count), amountMinor: nullable(amount), currency: nullable(Type.String()), registeredAt: nullable(Type.String({ format: "date-time" })), businessDate: nullable(LocalDate), reason: Type.String() })) });
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, 500: ErrorResponse };
export function registerDashboard(app: FastifyInstance, db: Kysely<Database>) {
  app.get("/api/v1/properties/:id/dashboard", { schema: { tags: ["queries"], params: Type.Object({ id: Id }), querystring: Type.Object(queryProperties, { additionalProperties: false }), response: { 200: DashboardResponseSchema, ...errors } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requirePropertyAccess(await requirePrincipal(db, request), id, "READ");
    reply.header("Cache-Control", "no-store");
    return getDashboard(db, id, request.query as DashboardQuery);
  });
  app.get("/api/v1/properties/:id/dashboard/details", { schema: { tags: ["queries"], params: Type.Object({ id: Id }), querystring: Type.Object({ ...queryProperties, metric, page: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })), asOf: Type.Optional(Type.String({ format: "date-time" })) }, { additionalProperties: false }), response: { 200: DashboardDetailsResponseSchema, ...errors } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requirePropertyAccess(await requirePrincipal(db, request), id, "READ");
    reply.header("Cache-Control", "no-store");
    return getDashboardDetails(db, id, request.query as DashboardQuery & { metric: DashboardMetric; page?: number; asOf?: string });
  });
}
