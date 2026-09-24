import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { DomainError, type ErrorCode } from "@qintopia/contracts";
import { createDatabase } from "@qintopia/db";
import { buildServer } from "./server.ts";
import { ErrorResponse } from "./schemas.ts";
import { publicCommandErrorPayload } from "./public-error.ts";

// These represent the business rejection producers found in the error-contract audit.
const cases: Array<[string, ErrorCode, Record<string, unknown>]> = [
  ["catalog room/type/bed conflicts", "INVENTORY_CONFLICT", { roomCodes: ["01"], orderIds: ["order_synthetic"] }],
  ["order room conflicts", "INVENTORY_CONFLICT", { orderId: "order_synthetic", inventoryUnitId: "unit_synthetic" }],
  ["expired membership", "ENTITLEMENT_CONFLICT", { expiresOn: "2026-09-01", propertyToday: "2026-09-21" }],
  ["membership date", "ENTITLEMENT_CONFLICT", { asOfDate: "2026-09-22", propertyToday: "2026-09-21" }],
  ["concurrent balance", "AGGREGATE_VERSION_CONFLICT", { expectedAvailableBalance: 5, availableBefore: 4 }],
  ["existing fulfillment", "INVALID_ORDER_STATE", { existingFulfillmentAmendments: ["CHECK_IN"] }],
  ["coverage dates", "ENTITLEMENT_CONFLICT", { orderId: "order_synthetic", timelineDates: ["2026-09-21"], heldCoverageDates: [] }],
  ["coverage IDs", "ENTITLEMENT_CONFLICT", { orderId: "order_synthetic", coverageIds: ["coverage_synthetic"] }],
  ["nonzero contract", "VALIDATION_ERROR", { currentContractAmountMinor: 100 }],
  ["existing collections", "VALIDATION_ERROR", { orderId: "order_synthetic", collectionFactIds: ["fact_synthetic"] }],
  ["consumed dates", "ENTITLEMENT_CONFLICT", { orderId: "order_synthetic", requestedDates: ["2026-09-21"], consumedDates: [] }],
  ["historical duplicate order", "VALIDATION_ERROR", { orderId: "order_synthetic" }],
  ["historical overlap", "INVENTORY_CONFLICT", { orderId: "order_synthetic", inventoryUnitId: "unit_synthetic", conflictingOrderId: "order_other", conflictingInventoryUnitId: "unit_other", serviceDate: "2026-09-21" }],
  ["historical occupancy", "INVENTORY_CONFLICT", { fingerprint: ["synthetic-occupancy"] }],
  ["historical outside overlap", "INVENTORY_CONFLICT", { orderId: "order_synthetic", inventoryUnitId: "unit_synthetic", requestedOrderId: "order_other", requestedInventoryUnitId: "unit_other" }],
  ["historical lifecycle", "INVALID_ORDER_STATE", { orderId: "order_synthetic", orderStatus: "CHECKED_IN", stayStatus: "IN_HOUSE" }],
  ["historical stale version", "AGGREGATE_VERSION_CONFLICT", { orderId: "order_synthetic", expectedVersion: 1, actualVersion: 2 }],
  ["historical intervals", "VALIDATION_ERROR", { orderId: "order_synthetic", intervalCount: 2 }],
  ["historical destination", "VALIDATION_ERROR", { orderId: "order_synthetic", beforeInventoryUnitId: "unit_synthetic", targetInventoryUnitId: "unit_other" }],
  ["historical capacity", "VALIDATION_ERROR", { orderId: "order_synthetic", occupantCount: 3, occupancyCapacity: 2 }],
  ["historical entitlement", "ENTITLEMENT_CONFLICT", { orderId: "order_synthetic", coverageCount: 1, entitlementLedgerCount: 1 }],
  ["historical future dates", "VALIDATION_ERROR", { orderId: "order_synthetic", correctedDepartureDate: "2026-09-22", propertyToday: "2026-09-21" }],
  ["integration cursor", "CURSOR_EXPIRED", { rebuild_required: true }]
];
let app: Awaited<ReturnType<typeof buildServer>>;
describe("business error HTTP contracts", () => {
  beforeAll(async () => {
    // No request in this suite queries the database.
    app = await buildServer(createDatabase("postgres://unused:unused@127.0.0.1:1/unused"));
    app.get<{ Params: { index: string } }>("/error-regression/:index", { schema: { response: { 409: ErrorResponse } } }, async (request) => {
      const [, code, details] = cases[Number(request.params.index)]!;
      throw new DomainError(code, "请核对具体业务原因后再操作", 409, false, details);
    });
    app.get<{ Params: { index: string } }>("/receipt-regression/:index", { schema: { response: { 200: Type.Object({ error: ErrorResponse }) } } }, async (request) => {
      const [, code, details] = cases[Number(request.params.index)]!;
      return { error: { code, message: "已拒绝，未写入", retryable: false, correlationId: "synthetic", details } };
    });
    app.get("/unknown-error-detail", { schema: { response: { 409: ErrorResponse } } }, async () => {
      throw new DomainError("INVENTORY_CONFLICT", "房间已有占用", 409, false, { futurePrivateDetail: "must-not-be-exposed" });
    });
  });
  afterAll(async () => { await app?.close(); });
  it.each(cases.map((item, index) => [item[0], index] as const))("preserves %s in errors and recovery receipts", async (_name, index) => {
    const [, code, details] = cases[index]!;
    const response = await app.inject({ url: `/error-regression/${index}` });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code, message: "请核对具体业务原因后再操作" });
    const receipt = await app.inject({ url: `/receipt-regression/${index}` });
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json().error).toMatchObject({ code, message: "已拒绝，未写入" });
    if (index === 0 || code === "CURSOR_EXPIRED") {
      expect(response.json().details).toEqual(details);
      expect(receipt.json().error.details).toEqual(details);
    } else {
      expect(response.json()).not.toHaveProperty("details");
      expect(receipt.json().error).not.toHaveProperty("details");
    }
  });
  it("omits unsupported optional diagnostics without masking the business rejection", async () => {
    const response = await app.inject({ url: "/unknown-error-detail" });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: "INVENTORY_CONFLICT", message: "房间已有占用" });
    expect(response.json()).not.toHaveProperty("details");
    expect(response.body).not.toContain("must-not-be-exposed");
  });
  it("projects wrapped recovery receipts without mutating stored evidence or business data", () => {
    const error = { code: "INVENTORY_CONFLICT", message: "房间已有占用", retryable: false, correlationId: "synthetic",
      details: { internalDiagnostic: "private" } };
    const stored = { receipt: { executionStatus: "REJECTED", businessCommitted: false, error }, result: { error } };
    const before = structuredClone(stored);
    const projected = publicCommandErrorPayload(stored);
    expect(projected).toMatchObject({ receipt: { executionStatus: "REJECTED", businessCommitted: false,
      error: { code: "INVENTORY_CONFLICT", message: "房间已有占用" } } });
    expect(projected).not.toHaveProperty("receipt.error.details");
    expect(projected).toHaveProperty("result.error.details.internalDiagnostic", "private");
    expect(stored).toEqual(before);
  });
});
