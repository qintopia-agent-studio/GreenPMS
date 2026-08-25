import { describe, expect, it } from "vitest";
import { normalizeBackfillCollectionInput, optionalString } from "./effects.ts";

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
