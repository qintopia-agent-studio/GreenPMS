import Fastify from "fastify";
import fastJsonStringify, { type Schema } from "fast-json-stringify";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createReceiptSerializerCompiler } from "./receipt-serializer.ts";
import {
  ErrorResponse, HistoricalCommandConfirmConflictResponseSchema, HistoricalCommandPreviewResponseSchema,
  HistoricalCommandResultRecoverySchema, HistoricalReceiptReadSchema
} from "./schemas.ts";

const zero = { currency: "CNY", minorUnits: 0 };
const timeline = ["2026-11-08", "2026-11-09"].map(serviceDate => ({ serviceDate, inventoryUnitId: "unit_recovery" }));
const result = {
  orderId: "order_recovery", stayId: "stay_recovery", amendmentId: "amendment_recovery",
  staySegmentId: "segment_recovery", pricingRevisionId: "revision_recovery", effectHash: "a".repeat(64),
  arrivalDate: "2026-11-08", departureDate: "2026-11-10",
  before: { arrivalDate: "2026-11-08", departureDate: "2026-11-09", nights: 1,
    currentContractAmount: zero, stayTimeline: timeline.slice(0, 1) },
  after: { arrivalDate: "2026-11-08", departureDate: "2026-11-10", nights: 2, stayTimeline: timeline,
    pricing: { coverageSet: [], cashLines: [], cashRemainder: zero, currentContractAmount: zero } },
  pricingDecision: { pricingBasis: "FREE", policyBaseAmount: zero, targetCurrentContractAmount: zero,
    differenceFromPolicy: zero, manualAdjustmentMinor: 0, differenceExceedsThreshold: false,
    reason: { code: "EXTEND_STAY_FREE", note: "" } },
  inventoryChange: { preservedDates: ["2026-11-08"], releasedDates: [], addedDates: ["2026-11-09"] },
  entitlementChange: { preservedCoverageDates: [], releasedCoverageDates: [], addedCoverageDates: [], consumedCoverageDates: [] },
  fundsSummary: { netRecordedCollection: zero, collectionDifference: zero }
};
const current = {
  receiptId: "receipt_recovery", commandId: "command_recovery", commandType: "EXTEND_STAY",
  executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation_recovery",
  resourceRefs: [result.orderId, result.stayId, result.amendmentId, result.staySegmentId, result.pricingRevisionId],
  factRefs: [], committedAt: "2026-11-08T10:00:00.000Z", result
};
const { effectHash: _hash, ...legacyResultFields } = result;
const { stayTimeline: _timeline, ...legacyBefore } = result.before;
const legacyResult = { ...legacyResultFields, before: legacyBefore };
const historical = {
  ...current, result: legacyResult,
  protocolVersion: "LEGACY_STAGE_9_10", recoveryMode: "HISTORICAL_READ_ONLY"
};
const effect = {
  operation: "EXTEND_STAY", orderId: result.orderId, stayId: result.stayId, inventoryUnitId: "unit_recovery",
  before: result.before, after: result.after, pricingDecision: result.pricingDecision,
  inventoryChange: result.inventoryChange, entitlementChange: result.entitlementChange, fundsSummary: result.fundsSummary
};
const preview = {
  previewId: "preview_recovery", commandType: "EXTEND_STAY", effectHash: result.effectHash,
  effect, expiresAt: "2026-11-08T10:05:00.000Z"
};
const previewReceipt = { ...current, commandType: "PREVIEW:EXTEND_STAY", result: { preview } };
const historicalPreview = { ...preview, effect: { ...effect, before: legacyBefore } };
const historicalPreviewReceipt = {
  ...historical, commandType: "PREVIEW:EXTEND_STAY", result: { preview: historicalPreview }
};
const unknown = { executionStatus: "UNKNOWN", businessCommitted: false };
const notExecuted = {
  receiptId: "receipt_interrupted", commandId: "command_interrupted", commandType: "EXTEND_STAY",
  executionStatus: "NOT_EXECUTED", businessCommitted: false, correlationId: "correlation_recovery",
  resourceRefs: [], factRefs: [], error: {
    code: "COMMAND_INTERRUPTED", message: "The original request was not executed",
    correlationId: "correlation_recovery", retryable: false
  }
};

// Recreate the previous nested contract to compare both schema flattening and
// compiler options, including the existing rejection and projection behavior.
const previousRecoverySchema = Type.Union([
  HistoricalReceiptReadSchema,
  Type.Object({ executionStatus: Type.Literal("UNKNOWN"), businessCommitted: Type.Literal(false),
    commandId: Type.Optional(Type.String({ minLength: 3, maxLength: 160 })),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 }))
  }, { additionalProperties: false })
]);
const baselineSerializer = (schema: object) => fastJsonStringify(schema as Schema);
const previousSerialize = baselineSerializer(previousRecoverySchema);
const compile = createReceiptSerializerCompiler();
const serialize = compile({ schema: HistoricalCommandResultRecoverySchema, method: "POST",
  url: "/api/v1/command-results/resolve", httpStatus: "200" });

describe("receipt response serialization", () => {
  it.each([
    ["current extension", current],
    ["historical extension", historical],
    ["unknown without identity", unknown],
    ["unknown with identity", { ...unknown, commandId: current.commandId, correlationId: current.correlationId }],
    ["durably not executed", notExecuted],
    ["current preview", previewReceipt],
    ["historical preview", historicalPreviewReceipt]
  ])("preserves the previous %s response byte for byte", (_name, input) => {
    const previous = previousSerialize(input);
    expect(serialize(input)).toBe(previous);
    expect(JSON.parse(serialize(input))).toEqual(input);
  }, 30_000);

  it.each([
    ["extra receipt data", { ...current, secret: "must-not-leak" }],
    ["extra result data", { ...current, result: { ...result, secret: "must-not-leak" } }],
    ["malformed timestamp", { ...current, committedAt: "not-a-date" }],
    ["missing effect hash", { ...current, result: legacyResultFields }],
    ["wrong historical protocol", { ...historical, protocolVersion: "NOT_A_PROTOCOL" }],
    ["missing historical read mode", { ...historical, recoveryMode: undefined }],
    ["unknown marked committed", { ...unknown, businessCommitted: true }],
    ["unknown with receipt payload", { ...unknown, result: {} }],
    ["invalid command identity", { ...current, commandType: "UNKNOWN_COMMAND" }]
  ])("still rejects %s", (_name, input) => {
    expect(() => previousSerialize(input)).toThrow();
    expect(() => serialize(input)).toThrow();
  }, 30_000);

  it("preserves preview response wrappers and keeps PREVIEW identity", () => {
    const baseline = baselineSerializer(HistoricalCommandPreviewResponseSchema);
    const optimized = compile({ schema: HistoricalCommandPreviewResponseSchema, method: "POST",
      url: "/api/v1/command-previews", httpStatus: "200" });
    for (const input of [{ preview, receipt: previewReceipt },
      { preview: historicalPreview, receipt: historicalPreviewReceipt }]) {
      expect(optimized(input)).toBe(baseline(input));
      expect(JSON.parse(optimized(input)).receipt.commandType).toBe("PREVIEW:EXTEND_STAY");
    }
  }, 30_000);

  it("still projects schema fields instead of emitting arbitrary error properties", () => {
    const input = { ...notExecuted.error, internalSql: "must-not-leak", credential: "must-not-leak" };
    const projected = compile({ schema: ErrorResponse, method: "POST", url: "/api/v1/command-results/resolve", httpStatus: "400" })(input);
    expect(projected).toBe(fastJsonStringify(ErrorResponse)(input));
    expect(JSON.parse(projected)).toEqual(notExecuted.error);
  });

  it("preserves both not-executed receipts and errors returned by Confirm 409", () => {
    const baseline = baselineSerializer(Type.Union([HistoricalReceiptReadSchema, ErrorResponse]));
    const optimized = compile({ schema: HistoricalCommandConfirmConflictResponseSchema, method: "POST",
      url: "/api/v1/command-previews/:previewId/confirm", httpStatus: "409" });
    for (const input of [notExecuted, notExecuted.error]) {
      expect(optimized(input)).toBe(baseline(input));
      expect(JSON.parse(optimized(input))).toEqual(input);
    }
    for (const input of [{ ...notExecuted, secret: "must-not-leak" },
      { ...notExecuted.error, secret: "must-not-leak" }, { ...notExecuted.error, code: "NOT_AN_ERROR_CODE" }]) {
      expect(() => baseline(input)).toThrow();
      expect(() => optimized(input)).toThrow();
    }
  }, 30_000);

  it("shares a compiled response between recovery routes while keeping request validation", async () => {
    const app = Fastify();
    const compiler = createReceiptSerializerCompiler();
    const serializers: unknown[] = [];
    for (const url of ["/commands/command_test", "/command-results/resolve"]) {
      app.post(url, {
        serializerCompiler: compiler,
        schema: { body: Type.Object({ commandType: Type.Literal("EXTEND_STAY") }),
          response: { 200: HistoricalCommandResultRecoverySchema } }
      }, async (_request, reply) => {
        serializers.push(reply.getSerializationFunction("200"));
        return unknown;
      });
    }
    try {
      for (const url of ["/commands/command_test", "/command-results/resolve"]) {
        const response = await app.inject({ method: "POST", url, payload: { commandType: "EXTEND_STAY" } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(unknown);
      }
      expect(serializers[0]).toBeTypeOf("function");
      expect(serializers[1]).toBe(serializers[0]);
      const invalid = await app.inject({ method: "POST", url: "/command-results/resolve", payload: { commandType: "NOT_A_COMMAND" } });
      expect(invalid.statusCode).toBe(400);
      expect(serializers).toHaveLength(2);
      const separateInstance = createReceiptSerializerCompiler()({ schema: HistoricalCommandResultRecoverySchema,
        method: "POST", url: "/command-results/resolve", httpStatus: "200" });
      expect(separateInstance).not.toBe(serializers[0]);
    } finally { await app.close(); }
  });
});
