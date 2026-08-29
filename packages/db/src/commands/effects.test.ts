import { describe, expect, it } from "vitest";
import {
  isExactConvertedCoverageGraph,
  normalizeBackfillCollectionInput,
  optionalString
} from "./effects.ts";

describe("isExactConvertedCoverageGraph", () => {
  const conversion = {
    contractId: "contract_conversion",
    entitlementLotId: "lot_conversion",
    entitlementUnitKind: "ROOM_NIGHT" as const
  };
  const rows = ["2026-09-01", "2026-09-02"].map((serviceDate) => ({
    service_date: serviceDate,
    status: "CONSUMED",
    contract_id: conversion.contractId,
    lot_id: conversion.entitlementLotId,
    unit_kind: conversion.entitlementUnitKind
  }));

  it("requires every converted night to belong to the conversion contract and lot", () => {
    expect(isExactConvertedCoverageGraph(rows, ["2026-09-01", "2026-09-02"], conversion)).toBe(true);
    expect(isExactConvertedCoverageGraph(
      rows.map((row, index) => index === 1 ? { ...row, contract_id: "contract_other" } : row),
      ["2026-09-01", "2026-09-02"],
      conversion
    )).toBe(false);
    expect(isExactConvertedCoverageGraph(
      rows.map((row, index) => index === 1 ? { ...row, lot_id: "lot_other" } : row),
      ["2026-09-01", "2026-09-02"],
      conversion
    )).toBe(false);
  });

  it("rejects missing, duplicated, non-consumed, or wrong-kind coverage", () => {
    expect(isExactConvertedCoverageGraph(rows.slice(0, 1), ["2026-09-01", "2026-09-02"], conversion)).toBe(false);
    expect(isExactConvertedCoverageGraph(
      [{ ...rows[0]! }, { ...rows[0]! }],
      ["2026-09-01", "2026-09-02"],
      conversion
    )).toBe(false);
    expect(isExactConvertedCoverageGraph(
      rows.map((row, index) => index === 1 ? { ...row, status: "HELD" } : row),
      ["2026-09-01", "2026-09-02"],
      conversion
    )).toBe(false);
    expect(isExactConvertedCoverageGraph(
      rows.map((row, index) => index === 1 ? { ...row, unit_kind: "BED_NIGHT" } : row),
      ["2026-09-01", "2026-09-02"],
      conversion
    )).toBe(false);
  });
});

describe("optionalString", () => {
  it("normalizes blank optional input to an omitted value", () => {
    expect(optionalString({}, "note")).toBeUndefined();
    expect(optionalString({ note: null }, "note")).toBeUndefined();
    expect(optionalString({ note: "   " }, "note")).toBeUndefined();
  });

  it("trims populated input and rejects non-string values", () => {
    expect(optionalString({ note: "  已核对  " }, "note")).toBe("已核对");
    expect(() => optionalString({ note: 123 }, "note")).toThrow("note must be a string");
  });
});

describe("normalizeBackfillCollectionInput", () => {
  it.each(["WECOM", "BANK_TRANSFER"] as const)("requires and normalizes a transaction reference for positive %s collections", (method) => {
    expect(normalizeBackfillCollectionInput({
      amountMinor: 12_300,
      method,
      transactionReference: "  TXN-001  ",
      note: "  已核对  "
    })).toEqual({
      amountMinor: 12_300,
      method,
      transactionReference: "TXN-001",
      note: "已核对"
    });
    expect(() => normalizeBackfillCollectionInput({ amountMinor: 12_300, method }))
      .toThrow(method === "WECOM" ? "必须填写企业微信交易单号" : "必须填写银行转账交易单号或流水号");
    expect(() => normalizeBackfillCollectionInput({
      amountMinor: 12_300,
      method,
      transactionReference: "TXN-001",
      cashCollector: "不应提交"
    })).toThrow("不填写现金收款人");
  });

  it("requires separate collector and note evidence for a positive cash collection", () => {
    expect(normalizeBackfillCollectionInput({
      amountMinor: 8_800,
      method: "CASH",
      cashCollector: "  张三  ",
      note: "  前台现金收款  "
    })).toEqual({
      amountMinor: 8_800,
      method: "CASH",
      cashCollector: "张三",
      note: "前台现金收款"
    });
    expect(() => normalizeBackfillCollectionInput({ amountMinor: 8_800, method: "CASH", note: "前台现金收款" }))
      .toThrow("必须填写收款人");
    expect(() => normalizeBackfillCollectionInput({ amountMinor: 8_800, method: "CASH", cashCollector: "张三" }))
      .toThrow("必须填写备注");
    expect(() => normalizeBackfillCollectionInput({
      amountMinor: 8_800,
      method: "CASH",
      cashCollector: "张三",
      note: "前台现金收款",
      transactionReference: "CASH-MUST-NOT-HAVE-A-REFERENCE"
    })).toThrow("现金补录收款不填写交易单号");
  });

  it("accepts zero without payment evidence but still requires a supported method", () => {
    expect(normalizeBackfillCollectionInput({ amountMinor: 0, method: "WECOM" })).toEqual({
      amountMinor: 0,
      method: "WECOM",
      note: ""
    });
    expect(normalizeBackfillCollectionInput({ amountMinor: 0, method: "CASH" })).toEqual({
      amountMinor: 0,
      method: "CASH"
    });
    expect(() => normalizeBackfillCollectionInput({ amountMinor: 0, method: "OTHER" }))
      .toThrow("补录收款方式必须是企业微信、银行转账或现金");
  });

  it("uses the caller-provided action label for COMPLETE_STAY evidence messages", () => {
    expect(() => normalizeBackfillCollectionInput(
      { amountMinor: 8_800, method: "CASH", note: "前台现金收款" },
      "collection",
      "完成住宿"
    )).toThrow("现金完成住宿收款必须填写收款人");
    expect(() => normalizeBackfillCollectionInput(
      { amountMinor: 12_300, method: "OTHER" },
      "collection",
      "完成住宿"
    )).toThrow("完成住宿收款方式必须是企业微信、银行转账或现金");
    expect(normalizeBackfillCollectionInput(
      { amountMinor: 8_800, method: "CASH", cashCollector: "张三", note: "前台现金收款" },
      "collection",
      "完成住宿"
    )).toEqual({ amountMinor: 8_800, method: "CASH", cashCollector: "张三", note: "前台现金收款" });
  });
});
