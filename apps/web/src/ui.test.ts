import { describe, expect, it } from "vitest";
import { guestNicknameLabel, lodgingReceiptCopy, occupantSummaryItems, receiptTransactionReferenceLabel } from "./ui.tsx";

describe("Receipt transaction reference labels", () => {
  it("distinguishes reversal non-applicability from a historical missing collection or refund reference", () => {
    expect(receiptTransactionReferenceLabel({ factType: "REVERSAL", transactionReference: null })).toBe("不适用");
    expect(receiptTransactionReferenceLabel({ factType: "COLLECTION", transactionReference: null })).toBe("历史未记录");
    expect(receiptTransactionReferenceLabel({ factType: "REFUND", transactionReference: "TXN-REFUND-001" })).toBe("TXN-REFUND-001");
  });
});

describe("Guest nickname labels", () => {
  it("keeps a recorded nickname and derives an explicit historical compatibility label", () => {
    expect(guestNicknameLabel({ fullName: "Legal Name", nickname: "山风" })).toBe("山风");
    expect(guestNicknameLabel({ fullName: "Legacy Missing" })).toBe("历史未记录");
    expect(guestNicknameLabel({ fullName: "Legacy Null", nickname: null })).toBe("历史未记录");
  });
});

describe("Occupant command summaries", () => {
  it("keeps occupant order and excludes phone and document details from the compact summary", () => {
    const summary = occupantSummaryItems([{
      id: "occupant_primary",
      ordinal: 1,
      role: "PRIMARY",
      nickname: "山风",
      fullName: "主要姓名",
      phone: "13800000000",
      documentNumber: "PRIVATE-DOC"
    }, {
      id: "occupant_additional",
      ordinal: 2,
      role: "ADDITIONAL",
      nickname: "小满",
      fullName: "同行姓名"
    }]);

    expect(summary).toEqual([
      { key: "occupant_primary", roleLabel: "主要 / 联系人", nickname: "山风", fullName: "主要姓名" },
      { key: "occupant_additional", roleLabel: "同行人 1", nickname: "小满", fullName: "同行姓名" }
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/13800000000|PRIVATE-DOC/);
  });

  it("keeps the accepted member-stay receipt copy while adding occupant summaries separately", () => {
    expect(lodgingReceiptCopy(true, true)).toEqual({
      heading: "会员住宿订单已创建",
      description: "住宿日期、库存和会员权益覆盖已按核对结果记录。"
    });
    expect(lodgingReceiptCopy(false, true)).toEqual({
      heading: "会员住宿订单未创建",
      description: "本次操作没有写入住宿订单或会员权益变动。"
    });
    expect(lodgingReceiptCopy(true, false)).toEqual({
      heading: "住宿订单已创建",
      description: "住宿日期、库存和住宿人名单已按核对结果记录。"
    });
    expect(lodgingReceiptCopy(false, false)).toEqual({
      heading: "住宿订单未创建",
      description: "本次操作没有写入住宿订单。"
    });
  });
});
