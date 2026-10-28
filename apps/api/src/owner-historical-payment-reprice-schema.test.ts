import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import fastJsonStringify from "fast-json-stringify";
import { describe, expect, it } from "vitest";
import { CommandEffectSchema, OwnerHistoricalPaymentRepriceAmendmentRowSchema, OrderDetailResponseSchema } from "./schemas.ts";

FormatRegistry.Set("date-time", value => Number.isFinite(Date.parse(value)));
const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
function row() {
  return {
    id: "amend_owner_reprice", order_id: "order_d04", sequence: 5,
    amendment_type: "REPRICE_ORDER", reason_code: "HISTORICAL_PAYMENT_RECONCILIATION",
    reason_note: "固定历史合付款收口：恢复D04真实合同金额",
    prior_version: 4, new_version: 5, command_id: "command_owner_reprice",
    actor: { subjectId: "subject_admin", displayName: "管理员" }, created_at: "2026-10-28T04:00:00.000Z",
    payload: {
      orderId: "order_d04", before: { currentContractAmount: money(0) },
      policyBaseAmount: money(13000), targetCurrentContractAmount: money(13000), manualAdjustmentMinor: 0,
      maintenance: { planId: "historical-payment-reconciliation-2026-10-27", planSha256: "a".repeat(64), orderKey: "D04" }
    }
  };
}
const amendmentReadSchema = OrderDetailResponseSchema.properties.amendments.items;
const serializeAmendments = fastJsonStringify(Type.Object({ amendments: Type.Array(amendmentReadSchema) }));

describe("owner historical payment amendment read contract", () => {
  it("serializes the immutable payload through the order amendment union without widening write effects", () => {
    const amendment = row();
    expect(Value.Check(OwnerHistoricalPaymentRepriceAmendmentRowSchema, amendment)).toBe(true);
    expect(JSON.parse(serializeAmendments({ amendments: [amendment] })).amendments[0]).toEqual(amendment);
    expect(Value.Check(CommandEffectSchema, amendment.payload)).toBe(false);
  });

  const invalidCases: Array<[string, (value: ReturnType<typeof row>) => void]> = [
    ["command type", (value: ReturnType<typeof row>) => { value.amendment_type = "MOVE_UNIT"; }],
    ["reason code", value => { value.reason_code = "REPRICE_ORDER"; }],
    ["plan id", value => { value.payload.maintenance.planId = "other-plan"; }],
    ["order key", value => { value.payload.maintenance.orderKey = "D03"; }],
    ["plan hash", value => { value.payload.maintenance.planSha256 = "invalid"; }],
    ["prior amount", value => { value.payload.before.currentContractAmount.minorUnits = 1; }],
    ["target amount", value => { value.payload.targetCurrentContractAmount.minorUnits = 12999; }],
    ["policy amount", value => { value.payload.policyBaseAmount.minorUnits = 0; }],
    ["currency", value => { value.payload.targetCurrentContractAmount.currency = "USD"; }],
    ["manual adjustment", value => { value.payload.manualAdjustmentMinor = 1; }]
  ];
  it.each(invalidCases)("rejects an unrelated %s without accepting a generic command effect", (_label, change) => {
    const amendment = row();
    change(amendment);
    expect(Value.Check(amendmentReadSchema, amendment)).toBe(false);
    expect(() => serializeAmendments({ amendments: [amendment] })).toThrow();
  });

  it("rejects extra maintenance or payload fields", () => {
    const amendment = row();
    for (const payload of [
      { ...amendment.payload, arbitraryWrite: true },
      { ...amendment.payload, maintenance: { ...amendment.payload.maintenance, arbitraryScope: true } }
    ]) {
      expect(Value.Check(amendmentReadSchema, { ...amendment, payload })).toBe(false);
    }
  });
});

