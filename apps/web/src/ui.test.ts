import { describe, expect, it } from "vitest";
import { businessStatusLabel, fulfillmentReceiptCopy, fulfillmentTransitionIsExpected, guestNicknameLabel, lodgingReceiptCopy, occupantSummaryItems, receiptTransactionReferenceLabel } from "./ui.tsx";

describe("Fulfillment business presentation", () => {
  it("uses one Chinese lifecycle vocabulary without protocol or enum labels", () => {
    expect(["RESERVED", "PLANNED", "CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "COMPLETED"].map(businessStatusLabel))
      .toEqual(["已预订", "已预订", "在住", "在住", "已退房", "已完成"]);
  });

  it("summarizes current check-in and check-out results without promising a cleaning task", () => {
    expect(fulfillmentReceiptCopy("CHECK_IN", true)).toEqual({
      heading: "办理入住已完成",
      description: "住宿状态已更新为在住；本次不涉及会员权益。"
    });
    expect(fulfillmentReceiptCopy("CHECK_IN", true, 2)).toEqual({
      heading: "办理入住已完成",
      description: "住宿状态已更新为在住；本次核销 2 晚已冻结的会员权益。"
    });
    expect(fulfillmentReceiptCopy("CHECK_OUT", true)).toEqual({
      heading: "办理退房已完成",
      description: "住宿状态已更新为已退房，后续库存已按当前住宿事实释放。"
    });
    expect(fulfillmentReceiptCopy("CHECK_OUT", true).description).not.toContain("清洁");
    // Historical recovery records still need readable copy after the workflow is disabled.
    expect(fulfillmentReceiptCopy("COMPLETE_CLEANING", true)).toEqual({
      heading: "清洁已完成",
      description: "清洁任务已更新为已完成，住宿历史保持不变。"
    });
    expect(JSON.stringify(fulfillmentReceiptCopy("CHECK_OUT", false))).not.toMatch(/Preview|Confirm|Receipt|Command|CHECKED/);
  });

  it("only accepts the authoritative transition for each fulfillment command", () => {
    expect(fulfillmentTransitionIsExpected("CHECK_IN", {
      fromStatus: "RESERVED", toStatus: "CHECKED_IN",
      businessDate: "2026-07-25", effectiveDate: "2026-07-25", recordingMode: "ON_SCHEDULE"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_OUT", {
      fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT",
      businessDate: "2026-07-26", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("COMPLETE_CLEANING", { fromStatus: "PENDING", toStatus: "COMPLETED" })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_IN", { fromStatus: "RESERVED", toStatus: "CHECKED_OUT" })).toBe(false);
    expect(fulfillmentTransitionIsExpected("CHECK_OUT", {
      fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT",
      businessDate: "2026-07-24", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(false);
  });

  it("explains a late-recorded check-out without treating the record date as the departure date", () => {
    expect(fulfillmentReceiptCopy("CHECK_OUT", true, 0, {
      effectiveDate: "2026-07-25",
      recordedBusinessDate: "2026-07-26",
      recordingMode: "LATE_RECORDED"
    })).toEqual({
      heading: "迟录退房已完成",
      description: "退房按原计划退房日 2026-07-25 生效，于 2026-07-26 营业日迟录；订单金额保持不变，住宿库存已释放。"
    });
  });
});

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
