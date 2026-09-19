import { describe, expect, it, vi } from "vitest";
import { classifyTransactionFailure, reportTransactionFailure } from "./transaction-failure.ts";

describe("command transaction failures", () => {
  it.each(["40001", "40P01", "55P03", "57014"])("allows a new attempt after PostgreSQL abort %s", (code) => {
    expect(classifyTransactionFailure({ code }).rejection.retryable).toBe(true);
  });
  it.each(["23514", "23505", "23503", "42501", "ECONNRESET", "08006", undefined])("does not encourage blind retry for %s", (code) => {
    expect(classifyTransactionFailure({ code }).rejection.retryable).toBe(false);
  });
  it("reports only allowlisted diagnostic fields without exception or caller content", () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportTransactionFailure({ code: "23514", constraint: "stage11_move_target_capacity_snapshot",
        message: "private guest", detail: "private account", query: "secret SQL", stack: "secret stack" },
      { commandType: "MOVE_UNIT", previewId: "preview_synthetic", correlationId: "private correlation" });
      const output = String(logger.mock.calls[0]![0]);
      expect(JSON.parse(output)).toEqual({ event: "COMMAND_TRANSACTION_FAILED", commandType: "MOVE_UNIT",
        previewId: "preview_synthetic", correlationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sqlState: "23514", constraint: "stage11_move_target_capacity_snapshot", category: "CONSTRAINT", retryable: false });
      expect(output).not.toMatch(/private|secret/);
      expect(classifyTransactionFailure({ code: "23514", constraint: "unsafe\nidentifier" }).diagnostic.constraint).toBeUndefined();
    } finally { logger.mockRestore(); }
  });
});
