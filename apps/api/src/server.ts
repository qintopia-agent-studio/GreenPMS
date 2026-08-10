import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import {
  DomainError,
  type CommandEnvelope,
  type CreateQuoteCommandInputDto,
  type InventoryUnitKind,
  type RoomStatusBoardQueryDto,
  type HistoricalRecoverableCommandType
} from "@qintopia/contracts";
import { stableHash } from "@qintopia/domain";
import {
  createCommandPreview,
  databaseReady,
  executeQuoteCommand,
  findCommandResult,
  getCommand,
  getMemberView,
  getOrderView,
  getReceipt,
  getRoomStatusBoard,
  getHistoricalOrderArchive,
  listAvailability,
  listHistoricalOrderArchives,
  listMemberSummaries,
  loadReferenceCatalog,
  projectStoredPreviewForRead,
  resolveCommandResult,
  confirmCommandPreview,
  type ConfirmRequest,
  type Database
} from "@qintopia/db";
import { login, logout, requirePrincipal, requirePropertyAccess, requireScopedResourceAccess } from "./auth.ts";
import {
  AuditResponseSchema,
  AvailabilityUnitSchema,
  CommandEnvelopeSchema,
  HistoricalCommandPreviewResponseSchema,
  HistoricalCommandResultRecoverySchema,
  ConfirmSchema,
  ErrorResponse,
  FactResponseSchema,
  HistoricalCreateOrderReplayEnvelopeSchema,
  HistoricalOrderArchiveDetailResponseSchema,
  HistoricalOrderArchivesListResponseSchema,
  HistoricalOrderArchivesQuerySchema,
  Id,
  IdParams,
  LocalDate,
  LoginResponseSchema,
  LoginSchema,
  MaintenanceLocksQuerySchema,
  MaintenanceLocksResponseSchema,
  MeResponseSchema,
  MemberResponseSchema,
  MembersListResponseSchema,
  MembersQuerySchema,
  MetaResponseSchema,
  OrderDetailResponseSchema,
  OrderStatusSchema,
  OrdersListResponseSchema,
  PreviewParams,
  QuoteRequestSchema,
  QuoteCommandResponseSchema,
  ReferenceCatalogResponseSchema,
  HistoricalReceiptReadSchema,
  HistoricalRecoverableCommandTypeSchema,
  RoomStatusBoardSchema,
  RoomStatusQuerySchema,
  ResolveCommandResultSchema,
  HistoricalStoredPreviewResponseSchema,
  TokensResponseSchema,
  WriteHeaders
} from "./schemas.ts";

const InternalErrorResponses = { 500: ErrorResponse } as const;
const commandPreviewRequestBodies = new WeakMap<object, unknown>();

function correlationId(request: { headers: Record<string, unknown>; id: string }): string {
  const header = request.headers["x-correlation-id"];
  return typeof header === "string" && header ? header : request.id;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function missingWriteHeaderError(error: unknown): { code: "IDEMPOTENCY_KEY_REQUIRED" | "CORRELATION_ID_REQUIRED"; message: string } | undefined {
  const validation = (error as { validation?: Array<{ keyword?: string; params?: { missingProperty?: string } }> }).validation;
  const missing = validation?.find((item) => item.keyword === "required")?.params?.missingProperty?.toLowerCase();
  if (missing === "idempotency-key") return { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required" };
  if (missing === "x-correlation-id") return { code: "CORRELATION_ID_REQUIRED", message: "X-Correlation-ID header is required" };
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function replayHistoricalCreateOrderPreview(
  db: Kysely<Database>,
  principal: Awaited<ReturnType<typeof requirePrincipal>>,
  envelope: unknown,
  headers: Record<string, unknown>
) {
  if (!Value.Check(HistoricalCreateOrderReplayEnvelopeSchema, envelope)
    || !Value.Check(WriteHeaders, headers)) return undefined;

  const idempotencyKey = typeof headers["idempotency-key"] === "string"
    ? headers["idempotency-key"].trim()
    : "";
  const correlation = typeof headers["x-correlation-id"] === "string"
    ? headers["x-correlation-id"].trim()
    : "";
  if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", 400);
  if (!correlation) throw new DomainError("CORRELATION_ID_REQUIRED", "X-Correlation-ID header is required", 400);

  const propertyId = envelope.input.propertyId;
  requirePropertyAccess(principal, propertyId, "WRITE");
  const execution = await db.selectFrom("command_executions as execution")
    .leftJoin("command_receipts as receipt", "receipt.command_id", "execution.id")
    .select(["execution.id", "execution.request_hash", "receipt.id as receipt_id"])
    .where("execution.subject_id", "=", principal.subjectId)
    .where("execution.property_id", "=", propertyId)
    .where("execution.command_type", "=", "PREVIEW:CREATE_ORDER")
    .where("execution.idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  if (!execution || execution.request_hash !== stableHash(envelope)) return undefined;
  if (!execution.receipt_id) {
    throw new DomainError(
      "COMMAND_STATUS_UNKNOWN",
      "The historical Preview command is still executing or its final state is unknown",
      409,
      true,
      { commandId: execution.id }
    );
  }

  const receipt = await getReceipt(db, principal, execution.receipt_id);
  const preview = record(receipt.result)?.preview;
  if (!record(preview)) throw new DomainError("INTERNAL_ERROR", "Historical Preview receipt is malformed", 500);
  return { preview, receipt };
}

export async function buildServer(db: Kysely<Database>) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, genReqId: () => crypto.randomUUID() });
  await app.register(compress, { global: true, threshold: 1_024 });
  await app.register(cookie);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:4173", credentials: true });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => new DomainError("RATE_LIMITED", `Rate limit exceeded; retry after ${context.after}`, 429, true)
  });
  const checkBearerAuthenticationRate = app.createRateLimit({
    max: positiveIntegerEnv("BEARER_AUTH_RATE_LIMIT_MAX", 600),
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "QinTopia PMS Core Operations API", version: "1.0.0" },
      servers: [{ url: "/" }],
      tags: [
        { name: "auth" }, { name: "queries" }, { name: "commands" }, { name: "receipts" }, { name: "operations" }
      ],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" }, sessionCookie: { type: "apiKey", in: "cookie", name: "qintopia_session" } } },
      security: [{ bearerAuth: [] }, { sessionCookie: [] }]
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: true } });

  app.addHook("onRequest", async (request, reply) => {
    if (request.raw.url?.startsWith("/api/v1/")
      && request.raw.url !== "/api/v1/auth/login"
      && request.raw.url !== "/api/v1/openapi.json"
      && request.headers.authorization?.startsWith("Bearer ")) {
      const rate = await checkBearerAuthenticationRate(request);
      if (!rate.isAllowed && rate.isExceeded) {
        reply.header("retry-after", rate.ttlInSeconds);
        throw new DomainError("RATE_LIMITED", `Bearer authentication rate limit exceeded; retry after ${rate.ttlInSeconds} seconds`, 429, true);
      }
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.cookies.qintopia_session) {
      const origin = request.headers.origin;
      const allowed = process.env.WEB_ORIGIN ?? "http://127.0.0.1:4173";
      if (origin && origin !== allowed) {
        throw new DomainError("RESOURCE_SCOPE_DENIED", "Cross-origin session write is not allowed", 403);
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof DomainError ? error : undefined;
    const generic = error as { statusCode?: unknown; message?: unknown };
    const missingHeader = known ? undefined : missingWriteHeaderError(error);
    const statusCode = known?.statusCode ?? (typeof generic.statusCode === "number" ? generic.statusCode : 500);
    const requestCorrelationId = correlationId(request);
    if (statusCode >= 500) {
      request.log.error({ err: error, correlationId: requestCorrelationId }, "Request failed");
      return reply.code(statusCode).send({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        correlationId: requestCorrelationId,
        retryable: known?.retryable ?? false
      });
    }
    const code = known?.code ?? missingHeader?.code ?? (statusCode < 500 ? "VALIDATION_ERROR" : "INTERNAL_ERROR");
    reply.code(statusCode).send({
      code,
      message: known?.message ?? missingHeader?.message ?? (statusCode < 500 && typeof generic.message === "string" ? generic.message : "Internal server error"),
      correlationId: requestCorrelationId,
      retryable: known?.retryable ?? false,
      ...(known?.details ? { details: known.details } : {})
    });
  });

  app.get("/health/live", { schema: { tags: ["operations"], security: [], response: { 200: Type.Object({ status: Type.Literal("ok") }) } } }, async () => ({ status: "ok" as const }));
  app.get("/health/ready", { schema: { tags: ["operations"], security: [], response: { 200: Type.Object({ status: Type.Literal("ready") }), 503: ErrorResponse } } }, async (_request, reply) => {
    if (!(await databaseReady(db))) {
      reply.code(503);
      throw new DomainError("SERVICE_NOT_READY", "Database migration is not ready", 503, true);
    }
    return { status: "ready" as const };
  });

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: positiveIntegerEnv("LOGIN_RATE_LIMIT_MAX", 8), timeWindow: "1 minute", groupId: "login" } },
    schema: { tags: ["auth"], security: [], body: LoginSchema, response: { 200: LoginResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request, reply) => {
    const body = request.body as { username: string; password: string };
    return login(db, body.username, body.password, reply);
  });
  app.post("/api/v1/auth/logout", { schema: { tags: ["auth"], response: { 204: Type.Null(), 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request, reply) => {
    await logout(db, request, reply);
    return reply.code(204).send();
  });
  app.get("/api/v1/me", { schema: { tags: ["auth"], response: { 200: MeResponseSchema, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return { subjectId: principal.subjectId, displayName: principal.displayName, credentialType: principal.credentialType, propertyAccess: Object.fromEntries(principal.propertyAccess) };
  });

  app.get("/api/v1/meta", { schema: { tags: ["queries"], response: { 200: MetaResponseSchema, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const propertyIds = [...principal.propertyAccess.keys()];
    const [properties, units, policies, members, memberContracts, membershipProducts] = await Promise.all([
      propertyIds.length ? db.selectFrom("properties").selectAll().where("id", "in", propertyIds).orderBy("code").execute() : [],
      propertyIds.length ? db.selectFrom("inventory_units").selectAll().where("property_id", "in", propertyIds).where("active", "=", true).orderBy("code").execute() : [],
      propertyIds.length ? db.selectFrom("pricing_policy_versions").selectAll().where("property_id", "in", propertyIds).orderBy("code").execute() : [],
      propertyIds.length ? db.selectFrom("members")
        .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
        .selectAll("members")
        .distinct()
        .where("member_property_links.property_id", "in", propertyIds)
        .orderBy("members.full_name")
        .execute() : [],
      propertyIds.length ? db.selectFrom("member_contracts").selectAll().where("property_id", "in", propertyIds).orderBy("member_name").execute() : [],
      propertyIds.length ? db.selectFrom("membership_products").selectAll().where("status", "=", "PUBLISHED").orderBy("code").execute() : []
    ]);
    return { properties, inventoryUnits: units, pricingPolicyVersions: policies, members, memberContracts, membershipProducts };
  });

  app.get("/api/v1/properties/:id/availability", {
    schema: {
      tags: ["queries"], params: IdParams,
      querystring: Type.Object({
        arrivalDate: LocalDate,
        departureDate: LocalDate,
        unitKind: Type.Optional(Type.Union([Type.Literal("ROOM"), Type.Literal("BED")])),
        excludeOrderId: Type.Optional(Id)
      }, { additionalProperties: false }),
      response: { 200: Type.Object({ propertyId: Type.String(), units: Type.Array(AvailabilityUnitSchema) }, { additionalProperties: false }), 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { arrivalDate: string; departureDate: string; unitKind?: InventoryUnitKind; excludeOrderId?: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    return {
      propertyId: id,
      units: await listAvailability(db, id, query.arrivalDate, query.departureDate, query.unitKind, query.excludeOrderId)
    };
  });

  app.get("/api/v1/properties/:id/room-status", {
    schema: {
      tags: ["queries"],
      summary: "Read the authoritative room and bed status projection",
      params: IdParams,
      querystring: RoomStatusQuerySchema,
      response: {
        200: RoomStatusBoardSchema,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        429: ErrorResponse,
        ...InternalErrorResponses
      }
    }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as RoomStatusBoardQueryDto;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    return getRoomStatusBoard(db, {
      propertyId: id,
      arrivalDate: query.arrivalDate,
      departureDate: query.departureDate,
      accessLevel: principal.propertyAccess.get(id)!,
      requestingSubjectId: principal.subjectId,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.roomType !== undefined ? { roomType: query.roomType } : {}),
      ...(query.salesMode !== undefined ? { salesMode: query.salesMode } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.minCapacity !== undefined ? { minCapacity: query.minCapacity } : {}),
      ...(query.unitKind !== undefined ? { unitKind: query.unitKind } : {})
    });
  });

  app.get("/api/v1/properties/:id/reference-catalog", {
    schema: {
      tags: ["queries"],
      params: IdParams,
      response: {
        200: ReferenceCatalogResponseSchema,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        429: ErrorResponse,
        ...InternalErrorResponses
      }
    }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    const catalog = await loadReferenceCatalog(db, id);
    if (!catalog) throw new DomainError("NOT_FOUND", "Reference catalog not found", 404);
    return catalog;
  });

  app.post("/api/v1/quotes", {
    config: { rateLimit: { max: positiveIntegerEnv("QUOTE_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "quotes" } },
    schema: {
      tags: ["commands"],
      summary: "Create a recoverable quote",
      description: "Low-risk single-stage command. READ access is sufficient; Preview and Confirm do not apply.",
      headers: WriteHeaders,
      body: QuoteRequestSchema,
      response: { 200: QuoteCommandResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const body = request.body as CreateQuoteCommandInputDto;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, body.propertyId, "READ");
    return executeQuoteCommand(db, principal, body, {
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      correlationId: request.headers["x-correlation-id"] as string | undefined
    });
  });

  app.get("/api/v1/orders", {
    schema: { tags: ["queries"], querystring: Type.Object({ propertyId: Id, status: Type.Optional(OrderStatusSchema) }, { additionalProperties: false }), response: { 200: OrdersListResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const query = request.query as { propertyId: string; status?: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    let selection = db.selectFrom("orders")
      .leftJoin("pricing_revisions as current_revision", "current_revision.id", "orders.current_revision_id")
      .leftJoin("stays", "stays.order_id", "orders.id")
      .leftJoin(
        (qb) => qb.selectFrom("stay_segments")
          .select(["stay_id", "inventory_unit_id"])
          .distinctOn("stay_id")
          .orderBy("stay_id")
          .orderBy("sequence", "desc")
          .as("current_segment"),
        (join) => join.onRef("current_segment.stay_id", "=", "stays.id")
      )
      .leftJoin("inventory_units as current_unit", "current_unit.id", "current_segment.inventory_unit_id")
      .selectAll("orders")
      .select([
        "current_revision.current_contract_amount_minor as current_contract_amount_minor",
        "current_revision.currency as currency",
        "current_unit.name as current_unit_name",
        "current_unit.code as current_unit_code"
      ])
      .where("orders.property_id", "=", query.propertyId);
    if (query.status) selection = selection.where("orders.status", "=", query.status);
    return { orders: await selection.orderBy("orders.created_at", "desc").execute() };
  });

  app.get("/api/v1/orders/:id", { schema: { tags: ["queries"], params: IdParams, response: { 200: OrderDetailResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const orderId = (request.params as { id: string }).id;
    const order = await db.selectFrom("orders").select("property_id").where("id", "=", orderId).executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "Order not found", 404);
    requireScopedResourceAccess(principal, order.property_id);
    return getOrderView(db, orderId, principal.propertyAccess.get(order.property_id)!);
  });

  app.post("/api/v1/historical-order-archives", {
    schema: { tags: ["queries"], body: HistoricalOrderArchivesQuerySchema, response: { 200: HistoricalOrderArchivesListResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request, reply) => {
    const query = request.body as { propertyId: string; query?: string; recordKind?: "MIGRATED_ARCHIVE" | "NON_ACCOMMODATION_ARCHIVE"; channelCode?: "YOUMUDAO" | "CTRIP" | "MEITUAN" | "WECOM"; sourceStatus?: string; arrivalDate?: string; departureDate?: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    reply.header("cache-control", "private, no-store");
    return listHistoricalOrderArchives(db, query.propertyId, query);
  });

  app.get("/api/v1/historical-order-archives/:id", {
    schema: { tags: ["queries"], params: IdParams, querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: HistoricalOrderArchiveDetailResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request, reply) => {
    const archiveId = (request.params as { id: string }).id;
    const propertyId = (request.query as { propertyId: string }).propertyId;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, propertyId, "READ");
    reply.header("cache-control", "private, no-store");
    return getHistoricalOrderArchive(db, propertyId, archiveId);
  });

  app.get("/api/v1/members", { schema: { tags: ["queries"], querystring: MembersQuerySchema, response: { 200: MembersListResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const query = request.query as { propertyId: string; query?: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    return { members: await listMemberSummaries(db, query.propertyId, query.query) };
  });

  app.get("/api/v1/members/:id", { schema: { tags: ["queries"], params: IdParams, querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: MemberResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const id = (request.params as { id: string }).id;
    const propertyId = (request.query as { propertyId: string }).propertyId;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, propertyId, "READ");
    return getMemberView(db, propertyId, id);
  });

  app.get("/api/v1/tokens", {
    schema: { tags: ["queries"], querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: TokensResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const propertyId = (request.query as { propertyId: string }).propertyId;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, propertyId, "READ");
    const tokens = await db.selectFrom("api_tokens")
      .select(["id", "label", "access_ceiling", "property_scope", "expires_at", "revoked_at", "rotated_from_id", "replaced_by_id", "created_at"])
      .where("subject_id", "=", principal.subjectId).where("property_scope", "=", propertyId).orderBy("created_at", "desc").execute();
    return { tokens };
  });

  app.get("/api/v1/maintenance-locks", {
    schema: {
      tags: ["queries"],
      querystring: MaintenanceLocksQuerySchema,
      response: { 200: MaintenanceLocksResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const query = request.query as { propertyId: string; status?: "ACTIVE" | "RELEASED" };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    let selection = db.selectFrom("maintenance_locks").selectAll().where("property_id", "=", query.propertyId);
    if (query.status) selection = selection.where("status", "=", query.status);
    const maintenanceLocks = await selection
      .orderBy("property_id")
      .orderBy("status")
      .orderBy("arrival_date")
      .orderBy("id")
      .execute();
    return { maintenanceLocks };
  });

  app.get("/api/v1/facts/:id", { schema: { tags: ["queries"], params: IdParams, response: { 200: FactResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const factId = (request.params as { id: string }).id;
    const principal = await requirePrincipal(db, request);
    const collection = await db.selectFrom("collection_facts").innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select(["collection_facts.fact_id", "collection_facts.order_id", "collection_facts.fact_type", "collection_facts.amount_minor", "collection_facts.net_effect_minor", "collection_facts.currency", "collection_facts.references_fact_id", "collection_facts.reverses_fact_id", "collection_facts.method", "collection_facts.note", "collection_facts.transaction_reference", "collection_facts.pricing_revision_id", "collection_facts.created_at", "orders.property_id"])
      .where("collection_facts.fact_id", "=", factId).executeTakeFirst();
    if (collection) {
      requireScopedResourceAccess(principal, collection.property_id);
      return collection;
    }
    const entitlement = await db.selectFrom("entitlement_ledger").innerJoin("entitlement_lots", "entitlement_lots.id", "entitlement_ledger.lot_id")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id").selectAll("entitlement_ledger")
      .select("member_contracts.property_id").where("entitlement_ledger.fact_id", "=", factId).executeTakeFirst();
    if (!entitlement) throw new DomainError("NOT_FOUND", "Fact not found", 404);
    requireScopedResourceAccess(principal, entitlement.property_id);
    return entitlement;
  });

  app.post("/api/v1/command-previews", {
    attachValidation: true,
    preValidation: async (request) => {
      commandPreviewRequestBodies.set(request, structuredClone(request.body));
    },
    config: { rateLimit: { max: positiveIntegerEnv("COMMAND_PREVIEW_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "command-previews" } },
    schema: { tags: ["commands"], headers: WriteHeaders, body: CommandEnvelopeSchema, response: { 200: HistoricalCommandPreviewResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    if (request.validationError) {
      const historicalEnvelope = commandPreviewRequestBodies.get(request);
      if (!Value.Check(HistoricalCreateOrderReplayEnvelopeSchema, historicalEnvelope)
        || !Value.Check(WriteHeaders, request.headers)) {
        throw request.validationError;
      }
      const principal = await requirePrincipal(db, request);
      const replay = await replayHistoricalCreateOrderPreview(
        db,
        principal,
        historicalEnvelope,
        request.headers
      );
      if (replay) return replay;
      throw request.validationError;
    }
    const principal = await requirePrincipal(db, request);
    const envelope = request.body as CommandEnvelope;
    return createCommandPreview(db, principal, envelope, {
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      correlationId: request.headers["x-correlation-id"] as string | undefined
    });
  });

  app.get("/api/v1/command-previews/:previewId", {
    schema: { tags: ["commands"], params: PreviewParams, response: { 200: HistoricalStoredPreviewResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const preview = await db.selectFrom("command_previews").selectAll()
      .where("id", "=", (request.params as { previewId: string }).previewId)
      .where("subject_id", "=", principal.subjectId).executeTakeFirst();
    if (!preview) throw new DomainError("PREVIEW_NOT_FOUND", "Preview not found", 404);
    requireScopedResourceAccess(principal, preview.property_id);
    return projectStoredPreviewForRead(db, preview);
  });

  app.post("/api/v1/command-previews/:previewId/confirm", {
    config: { rateLimit: { max: positiveIntegerEnv("COMMAND_CONFIRM_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "command-confirms" } },
    schema: { tags: ["commands"], headers: WriteHeaders, params: PreviewParams, body: ConfirmSchema, response: { 200: HistoricalReceiptReadSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: Type.Union([HistoricalReceiptReadSchema, ErrorResponse]), 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request, reply) => {
    const principal = await requirePrincipal(db, request);
    const previewId = (request.params as { previewId: string }).previewId;
    const receipt = await confirmCommandPreview(db, principal, previewId, request.body as ConfirmRequest, {
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      correlationId: request.headers["x-correlation-id"] as string | undefined
    });
    if (!receipt.businessCommitted) reply.code(409);
    return receipt;
  });

  app.get("/api/v1/receipts/:id", { schema: { tags: ["receipts"], params: IdParams, response: { 200: HistoricalReceiptReadSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return getReceipt(db, principal, (request.params as { id: string }).id);
  });
  app.get("/api/v1/commands/:id", { schema: { tags: ["receipts"], params: IdParams, response: { 200: HistoricalCommandResultRecoverySchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return getCommand(db, principal, (request.params as { id: string }).id);
  });
  app.get("/api/v1/command-results", {
    schema: { tags: ["receipts"], querystring: Type.Object({ propertyId: Id, commandType: HistoricalRecoverableCommandTypeSchema, idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }), response: { 200: HistoricalCommandResultRecoverySchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const query = request.query as { propertyId: string; commandType: HistoricalRecoverableCommandType; idempotencyKey: string };
    return findCommandResult(db, principal, query.propertyId, query.commandType, query.idempotencyKey);
  });

  app.post("/api/v1/command-results/resolve", {
    config: { rateLimit: { max: positiveIntegerEnv("COMMAND_RESULT_RESOLVE_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "command-result-resolutions" } },
    schema: {
      tags: ["receipts"],
      headers: WriteHeaders,
      body: ResolveCommandResultSchema,
      response: {
        200: HistoricalCommandResultRecoverySchema,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        409: ErrorResponse,
        429: ErrorResponse,
        ...InternalErrorResponses
      }
    }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return resolveCommandResult(
      db,
      principal,
      request.body as {
        propertyId: string;
        commandType: HistoricalRecoverableCommandType;
        idempotencyKey: string;
      },
      {
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        correlationId: request.headers["x-correlation-id"] as string | undefined
      }
    );
  });

  app.get("/api/v1/audit", {
    schema: {
      tags: ["receipts"],
      querystring: Type.Object({ propertyId: Id, correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
      response: { 200: AuditResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const query = request.query as { propertyId: string; correlationId?: string; limit?: number };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    let selection = db.selectFrom("audit_entries")
      .innerJoin("command_executions", "command_executions.id", "audit_entries.command_id")
      .select([
        "audit_entries.id", "audit_entries.subject_id", "audit_entries.credential_id", "audit_entries.action", "audit_entries.decision",
        "audit_entries.command_id", "audit_entries.correlation_id", "audit_entries.reason", "audit_entries.target_refs", "audit_entries.metadata", "audit_entries.created_at"
      ])
      .where("command_executions.property_id", "=", query.propertyId);
    if (query.correlationId) selection = selection.where("audit_entries.correlation_id", "=", query.correlationId);
    return { entries: await selection.orderBy("audit_entries.created_at", "desc").limit(query.limit ?? 100).execute() };
  });

  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(async (webApp) => {
      await webApp.register(fastifyStatic, { root: webRoot });
      webApp.setNotFoundHandler(async (request, reply) => {
        if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/health/")) {
          return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found", correlationId: request.id, retryable: false });
        }
        return reply.sendFile("index.html");
      });
    });
  }

  app.addHook("onClose", async () => db.destroy());
  return app;
}
