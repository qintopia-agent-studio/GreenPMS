import { describe, expect, it } from "vitest";
import {
  projectReceiptResultForRead,
  projectStayMembershipConversionResultEvidenceForRead
} from "./service.ts";

describe("command receipt read projection", () => {
  it("keeps pre-8.6 stay conversion receipts readable without rewriting stored audit data", () => {
    const historical = {
      membershipOrderId: "membership_order_existing",
      conversionLedgerFactIds: ["fact_conversion_existing"]
    };

    expect(projectReceiptResultForRead(
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      historical,
      "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"
    )).toEqual({
      ...historical,
      conversionMode: "COMPLETED",
      conversionCoverageIds: []
    });
    expect(historical).not.toHaveProperty("conversionCoverageIds");
  });

  it("does not mask a missing current conversion coverage audit field", () => {
    const malformedCurrent = {
      membershipOrderId: "membership_order_current",
      conversionLedgerFactIds: ["fact_conversion_current"]
    };

    expect(projectReceiptResultForRead(
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      malformedCurrent
    )).toBe(malformedCurrent);
  });

  it("preserves explicit in-house conversion coverage and unrelated command results", () => {
    const current = { conversionMode: "IN_HOUSE", conversionCoverageIds: ["coverage_current"] };
    const unrelated = { orderId: "order_existing" };

    expect(projectReceiptResultForRead("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", current)).toBe(current);
    expect(projectReceiptResultForRead("CHECK_IN", unrelated)).toBe(unrelated);
  });

  it("derives a pre-mode conversion from immutable ledger evidence and rejects a forged completed shape", () => {
    const preMode = {
      convertedUnits: 2,
      conversionCoverageIds: ["coverage_first", "coverage_second"],
      conversionLedgerFactIds: ["ledger_first", "ledger_second"]
    };
    const ledger = [
      { fact_id: "ledger_first", coverage_id: "coverage_first" },
      { fact_id: "ledger_second", coverage_id: "coverage_second" }
    ];
    expect(projectStayMembershipConversionResultEvidenceForRead(preMode, ledger)).toEqual({
      ...preMode,
      conversionMode: "IN_HOUSE"
    });
    expect(() => projectStayMembershipConversionResultEvidenceForRead({
      ...preMode,
      conversionMode: "COMPLETED",
      conversionCoverageIds: []
    }, ledger)).toThrow("Persisted stay-membership conversion coverage differs from its receipt");
  });

  it("derives completed conversions only when every conversion ledger fact has no coverage", () => {
    const preMode = {
      convertedUnits: 2,
      conversionCoverageIds: [],
      conversionLedgerFactIds: ["ledger_first", "ledger_second"]
    };
    expect(projectStayMembershipConversionResultEvidenceForRead(preMode, [
      { fact_id: "ledger_first", coverage_id: null },
      { fact_id: "ledger_second", coverage_id: null }
    ])).toEqual({ ...preMode, conversionMode: "COMPLETED" });
    expect(() => projectStayMembershipConversionResultEvidenceForRead(preMode, [
      { fact_id: "ledger_first", coverage_id: null },
      { fact_id: "ledger_second", coverage_id: "coverage_second" }
    ])).toThrow("Persisted stay-membership conversion coverage differs from its receipt");
  });
});
