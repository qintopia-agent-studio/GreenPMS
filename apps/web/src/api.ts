import type { CommandEnvelope, CommandReason, CommandType, HistoricalCommandType, ReceiptDto, RoomStatusBoardDto, RoomStatusBoardQueryDto } from "@qintopia/contracts";
import type {
  AvailabilityDto,
  ClientCommandMetadata,
  CommandPreviewResponse,
  CreateQuoteCommandResponseDto,
  MaintenanceLockDto,
  MemberSummaryDto,
  MemberViewDto,
  MetaDto,
  OrderRowDto,
  PrincipalDto,
  HistoricalRecoverableCommandType,
  TokenDto,
  TokenTargetDto
} from "./types";
import { parseOrderView } from "./orderViewValidation";
import { parseAvailability } from "./availabilityValidation";

interface ErrorPayload {
  code?: unknown;
  message?: unknown;
  correlationId?: unknown;
  retryable?: unknown;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(status: number, payload: ErrorPayload) {
    super(typeof payload.message === "string" ? payload.message : `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof payload.code === "string" ? payload.code : "REQUEST_FAILED";
    this.correlationId = typeof payload.correlationId === "string" ? payload.correlationId : "";
    this.retryable = payload.retryable === true;
    this.details = payload.details;
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  return text ? { message: text } : undefined;
}

function isReceipt(value: unknown): value is ReceiptDto {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.executionStatus === "string" && typeof record.businessCommitted === "boolean";
}

async function request<T>(path: string, init: RequestInit = {}, acceptRejectedReceipt = false): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  const body = await parseBody(response);
  if (!response.ok && !(acceptRejectedReceipt && isReceipt(body))) {
    throw new ApiError(response.status, (body ?? {}) as ErrorPayload);
  }
  return body as T;
}

function commandHeaders(scope: string) {
  const nonce = crypto.randomUUID();
  return {
    "Idempotency-Key": `web-${scope}-${nonce}`,
    "X-Correlation-ID": `web-${nonce}`
  };
}

function metadataHeaders(metadata: ClientCommandMetadata) {
  return {
    "Idempotency-Key": metadata.idempotencyKey,
    "X-Correlation-ID": metadata.correlationId
  };
}

function normalizeCommandResult(
  result: Partial<ReceiptDto> & Pick<ReceiptDto, "executionStatus" | "businessCommitted">
): ReceiptDto {
  return {
    receiptId: result.receiptId ?? "",
    commandId: result.commandId ?? "",
    executionStatus: result.executionStatus,
    businessCommitted: result.businessCommitted,
    correlationId: result.correlationId ?? "",
    ...(result.result ? { result: result.result } : {}),
    ...(result.error ? { error: result.error } : {}),
    resourceRefs: result.resourceRefs ?? [],
    factRefs: result.factRefs ?? [],
    ...(result.committedAt ? { committedAt: result.committedAt } : {})
  };
}

export const api = {
  commandMetadata: (scope: string): ClientCommandMetadata => {
    const headers = commandHeaders(scope);
    return { idempotencyKey: headers["Idempotency-Key"], correlationId: headers["X-Correlation-ID"] };
  },
  me: () => request<PrincipalDto>("/api/v1/me"),
  login: async (username: string, password: string) => {
    await request<unknown>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    return request<PrincipalDto>("/api/v1/me");
  },
  logout: () => request<void>("/api/v1/auth/logout", { method: "POST" }),
  meta: () => request<MetaDto>("/api/v1/meta"),
  availability: (
    propertyId: string,
    arrivalDate: string,
    departureDate: string,
    unitKind?: "ROOM" | "BED",
    excludeOrderId?: string
  ) => {
    const query = new URLSearchParams({ arrivalDate, departureDate });
    if (unitKind) query.set("unitKind", unitKind);
    if (excludeOrderId) query.set("excludeOrderId", excludeOrderId);
    return request<unknown>(`/api/v1/properties/${encodeURIComponent(propertyId)}/availability?${query.toString()}`)
      .then((value) => parseAvailability(value, { propertyId, arrivalDate, departureDate, ...(unitKind ? { unitKind } : {}) }));
  },
  roomStatus: (
    propertyId: string,
    input: RoomStatusBoardQueryDto,
    signal?: AbortSignal
  ) => {
    const query = new URLSearchParams({
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      page: String(input.page ?? 0),
      pageSize: String(input.pageSize ?? 40)
    });
    if (input.search) query.set("search", input.search);
    if (input.roomType) query.set("roomType", input.roomType);
    if (input.salesMode) query.set("salesMode", input.salesMode);
    if (input.status) query.set("status", input.status);
    if (input.minCapacity !== undefined) query.set("minCapacity", String(input.minCapacity));
    if (input.unitKind) query.set("unitKind", input.unitKind);
    return request<RoomStatusBoardDto>(
      `/api/v1/properties/${encodeURIComponent(propertyId)}/room-status?${query.toString()}`,
      signal ? { signal } : {}
    );
  },
  maintenanceLocks: (propertyId: string, status: "ACTIVE" | "RELEASED" = "ACTIVE") => {
    const query = new URLSearchParams({ propertyId, status });
    return request<{ maintenanceLocks: MaintenanceLockDto[] }>(`/api/v1/maintenance-locks?${query.toString()}`);
  },
  quote: (input: {
    propertyId: string;
    inventoryUnitId: string;
    stayType?: string;
    arrivalDate: string;
    departureDate: string;
    pricingPolicyVersionId: string;
    memberId?: string;
  }, metadata: ClientCommandMetadata, signal?: AbortSignal) => request<CreateQuoteCommandResponseDto>("/api/v1/quotes", {
    method: "POST",
    headers: metadataHeaders(metadata),
    body: JSON.stringify(input),
    ...(signal ? { signal } : {})
  }),
  orders: (propertyId: string, status?: string) => {
    const query = new URLSearchParams({ propertyId });
    if (status) query.set("status", status);
    return request<{ businessDate: string; orders: OrderRowDto[] }>(`/api/v1/orders?${query.toString()}`);
  },
  order: (orderId: string, signal?: AbortSignal) => request<unknown>(
    `/api/v1/orders/${encodeURIComponent(orderId)}`,
    signal ? { signal } : {}
  ).then(parseOrderView),
  members: (propertyId: string, memberQuery?: string) => {
    const query = new URLSearchParams({ propertyId });
    if (memberQuery?.trim()) query.set("query", memberQuery.trim());
    return request<{ members: MemberSummaryDto[] }>(`/api/v1/members?${query.toString()}`);
  },
  member: (memberId: string, propertyId: string) => {
    const query = new URLSearchParams({ propertyId });
    return request<MemberViewDto>(`/api/v1/members/${encodeURIComponent(memberId)}?${query.toString()}`);
  },
  tokens: (propertyId: string) => {
    const query = new URLSearchParams({ propertyId });
    return request<{ tokens: TokenDto[] }>(`/api/v1/tokens?${query.toString()}`);
  },
  tokenTargets: (propertyId: string) => request<{ subjects: TokenTargetDto[] }>(
    `/api/v1/properties/${encodeURIComponent(propertyId)}/token-targets`
  ),
  preview: (envelope: CommandEnvelope, metadata: ClientCommandMetadata, signal?: AbortSignal) => request<CommandPreviewResponse>("/api/v1/command-previews", {
    method: "POST",
    headers: metadataHeaders(metadata),
    body: JSON.stringify(envelope),
    ...(signal ? { signal } : {})
  }),
  confirm: (
    previewId: string,
    propertyId: string,
    commandType: CommandType,
    effectHash: string,
    reason: CommandReason,
    idempotencyKey: string,
    signal?: AbortSignal
  ) => request<ReceiptDto>(`/api/v1/command-previews/${encodeURIComponent(previewId)}/confirm`, {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
      "X-Correlation-ID": `web-confirm-${crypto.randomUUID()}`
    },
    body: JSON.stringify({ propertyId, commandType, confirmation: true, expectedEffectHash: effectHash, reason }),
    ...(signal ? { signal } : {})
  }, true),
  recoveryKey: (commandType: HistoricalCommandType) => `web-confirm-${commandType.toLowerCase()}-${crypto.randomUUID()}`,
  commandResult: (propertyId: string, commandType: HistoricalRecoverableCommandType, idempotencyKey: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ propertyId, commandType, idempotencyKey });
    return request<Partial<ReceiptDto> & Pick<ReceiptDto, "executionStatus" | "businessCommitted">>(`/api/v1/command-results?${query.toString()}`, signal ? { signal } : {})
      .then(normalizeCommandResult);
  },
  resolveCommandResult: (
    propertyId: string,
    commandType: HistoricalRecoverableCommandType,
    idempotencyKey: string,
    signal?: AbortSignal
  ) => {
    const metadata = api.commandMetadata("resolve-command-result");
    return request<Partial<ReceiptDto> & Pick<ReceiptDto, "executionStatus" | "businessCommitted">>(
      "/api/v1/command-results/resolve",
      {
        method: "POST",
        headers: metadataHeaders(metadata),
        body: JSON.stringify({ propertyId, commandType, idempotencyKey }),
        ...(signal ? { signal } : {})
      }
    ).then(normalizeCommandResult);
  }
};

export type { ClientCommandMetadata } from "./types";
