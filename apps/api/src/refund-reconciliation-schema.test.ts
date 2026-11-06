import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import fastJsonStringify from "fast-json-stringify";
import { describe, expect, it } from "vitest";
import { CommandEnvelopeSchema, CommandEffectSchema, ReceiptSchema } from "./schemas.ts";

FormatRegistry.Set("date-time", value => Number.isFinite(Date.parse(value)));
const input = {
  propertyId: "property_demo", orderId: "order_cancelled",
  reconciliation: {
    source: { externalPaymentBillId: "payment_source", amountMinor: 100000 },
    refunds: [{ externalPaymentBillId: "payment_refund", amountMinor: 100000 }], note: "补齐已发生的真实收退款"
  }
};
const effect = {
  operation: "RECONCILE_WECOM_REFUNDS", orderId: "order_cancelled", orderStatus: "CANCELLED", currency: "CNY",
  source: { ...input.reconciliation.source, transactionReference: "collection-reference", occurredAt: "2026-11-04T01:00:00.000Z" },
  refunds: [{ ...input.reconciliation.refunds[0], refundReference: "refund-reference", occurredAt: "2026-11-05T01:00:00.000Z" }],
  collectedMinor: 100000, refundedMinor: 100000, netEffectMinor: 0, note: input.reconciliation.note
};

describe("成组退款HTTP契约", () => {
  it("完整序列化原收款、独立退款和多事实回执，防止响应丢失核对依据", () => {
    expect(Value.Check(CommandEnvelopeSchema, { commandType: "RECORD_REFUND", input })).toBe(true);
    expect(Value.Check(CommandEffectSchema, effect)).toBe(true);
    const receipt = { receiptId: "receipt_group", commandId: "command_group", commandType: "RECORD_REFUND", executionStatus: "EXECUTED", businessCommitted: true,
      correlationId: "group-test", result: { ...effect, sourceFactId: "fact_source", refundFactIds: ["fact_refund"], effectHash: "a".repeat(64) },
      resourceRefs: ["order_cancelled"], factRefs: ["fact_source", "fact_refund"], committedAt: "2026-11-06T01:00:00.000Z" };
    expect(Value.Check(ReceiptSchema, receipt)).toBe(true);
    expect(JSON.parse(fastJsonStringify(ReceiptSchema)(receipt))).toEqual(receipt);
  });
  it("成组与旧单笔输入互斥，未选择退款不能借补记路径只加收款", () => {
    expect(Value.Check(CommandEnvelopeSchema, { commandType: "RECORD_REFUND", input: { ...input, referencesFactId: "fact_existing", amountMinor: 1 } })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, { commandType: "RECORD_REFUND", input: { ...input, reconciliation: { ...input.reconciliation, refunds: [] } } })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, { commandType: "RECORD_REFUND", input: { propertyId: input.propertyId, orderId: input.orderId,
      amountMinor: 1000, referencesFactId: "fact_existing", method: "WECOM", refundReference: "refund-old", note: "正常退款" } })).toBe(true);
  });
});
