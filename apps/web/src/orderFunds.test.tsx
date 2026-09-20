import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderFundsFormDialog } from "./components/OrderFundsFormDialog";
import { buildOrderFundsRequest, type OrderFundsFormValues } from "./orderFunds";
import type { CollectionFactDto, OrderViewDto } from "./types";

function collection(overrides: Partial<CollectionFactDto> = {}): CollectionFactDto {
  return {
    fact_id: "collection_1",
    order_id: "order_1",
    fact_type: "COLLECTION",
    amount_minor: 10_000,
    net_effect_minor: 10_000,
    currency: "CNY",
    references_fact_id: null,
    reverses_fact_id: null,
    method: "WECOM",
    cash_collector: null,
    note: "",
    transaction_reference: "WX-COLLECTION-1",
    pricing_revision_id: null,
    command_id: "command_1",
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides
  };
}

function orderView(facts: CollectionFactDto[] = [collection()]): OrderViewDto {
  return {
    order: { id: "order_1", property_id: "property_1" },
    amounts: {
      collectionDifference: { minorUnits: 0, currency: "CNY" },
      refundReferenceAmount: { minorUnits: 8_000, currency: "CNY" }
    },
    collectionFacts: facts
  } as OrderViewDto;
}

const values: OrderFundsFormValues = {
  amountYuan: "28.50",
  method: "WECOM",
  note: "",
  transactionReference: "WX-COLLECTION-NEW",
  refundReference: "",
  factId: "collection_1"
};

describe("shared order funds requests", () => {
  it("keeps collection amounts, evidence and reason bound to the selected order", () => {
    expect(buildOrderFundsRequest(orderView(), "RECORD_COLLECTION", values)).toEqual({
      commandType: "RECORD_COLLECTION",
      title: "登记收款",
      description: "",
      input: {
        propertyId: "property_1",
        orderId: "order_1",
        amountMinor: 2850,
        method: "WECOM",
        note: "",
        transactionReference: "WX-COLLECTION-NEW"
      },
      initialReason: { code: "RECORD_COLLECTION", note: "登记收款" }
    });
  });

  it.each([
    ["WECOM", "必须填写企业微信交易单号"],
    ["BANK_TRANSFER", "必须填写交易单号或流水号"],
    ["CASH", "必须填写收款人"],
    ["OTHER", "必须填写其他收款说明"]
  ])("preserves required evidence for %s collections", (method, error) => {
    expect(() => buildOrderFundsRequest(orderView(), "RECORD_COLLECTION", { ...values, method, transactionReference: "" })).toThrow(error);
  });

  it.each(["0", "-1", "1.001", "1e2", "21474836.48"])("rejects invalid amount %s before formal review", (amountYuan) => {
    expect(() => buildOrderFundsRequest(orderView(), "RECORD_COLLECTION", { ...values, amountYuan })).toThrow("金额必须按人民币元填写");
  });

  it("limits a refund to its original collection after prior refunds, even when another collection has a balance", () => {
    const view = orderView([
      collection(),
      collection({ fact_id: "collection_2", amount_minor: 20_000, net_effect_minor: 20_000 }),
      collection({ fact_id: "refund_1", fact_type: "REFUND", amount_minor: 4_000, net_effect_minor: -4_000, references_fact_id: "collection_1" })
    ]);
    const refund = { ...values, amountYuan: "60.01", note: "多收退回", transactionReference: "", refundReference: "WX-REFUND-1" };
    expect(() => buildOrderFundsRequest(view, "RECORD_REFUND", refund)).toThrow("最多可退 ¥60.00");
    const request = buildOrderFundsRequest(view, "RECORD_REFUND", { ...refund, amountYuan: "60" });
    expect(request.input).toMatchObject({ amountMinor: 6000, referencesFactId: "collection_1", refundReference: "WX-REFUND-1" });
    expect(request.input).not.toHaveProperty("transactionReference");
  });

  it("requires a currently refundable original collection, refund reason and separate WeCom refund evidence", () => {
    const refund = { ...values, transactionReference: "", note: "多收退回", refundReference: "WX-REFUND-1" };
    expect(() => buildOrderFundsRequest(orderView([]), "RECORD_REFUND", refund)).toThrow("没有可退款的收款记录");
    expect(() => buildOrderFundsRequest(orderView(), "RECORD_REFUND", { ...refund, factId: "another_order_fact" })).toThrow("请选择要退款的原收款");
    expect(() => buildOrderFundsRequest(orderView(), "RECORD_REFUND", { ...refund, note: " " })).toThrow("必须填写退款原因");
    expect(() => buildOrderFundsRequest(orderView(), "RECORD_REFUND", { ...refund, refundReference: " " })).toThrow("必须填写本次企业微信退款单号");
  });
});

describe("shared order funds form", () => {
  it("restores the reviewed refund draft instead of replacing it with the suggested excess", () => {
    const view = orderView();
    const draft = buildOrderFundsRequest(view, "RECORD_REFUND", {
      ...values, note: "已核对只退本次差额", transactionReference: "", refundReference: "WX-REFUND-DRAFT"
    });
    const html = renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_REFUND" view={view} draft={draft} onClose={() => {}} onSubmit={() => {}} />);
    expect(html).toMatch(/data-testid="fact-amount-yuan"[^>]*value="28.50"/);
    expect(html).toContain("已核对只退本次差额");
    expect(html).toContain('value="WX-REFUND-DRAFT"');
    expect(html).toContain('value="WECOM" selected=""');
    expect(html).toContain("企业微信原路退回");
  });

  it("does not restore a draft from another order", () => {
    const draft = buildOrderFundsRequest(orderView(), "RECORD_COLLECTION", { ...values, note: "其他订单备注" });
    const view = orderView();
    view.order.id = "order_2";
    const html = renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_COLLECTION" view={view} draft={draft} onClose={() => {}} onSubmit={() => {}} />);
    expect(html).not.toContain("其他订单备注");
    expect(html).not.toContain("WX-COLLECTION-NEW");
    expect(html).toMatch(/data-testid="fact-amount-yuan"[^>]*value=""/);
  });

  it("disables further review when there is no refundable collection or writes are blocked", () => {
    const withoutRefund = renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_REFUND" view={orderView([])} onClose={() => {}} onSubmit={() => {}} />);
    const writeBlocked = renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_COLLECTION" view={orderView()} writeBlocked onClose={() => {}} onSubmit={() => {}} />);
    expect(withoutRefund).toContain("该订单当前没有可退款的收款记录");
    expect(withoutRefund).toMatch(/type="submit"[^>]*disabled=""/);
    expect(writeBlocked).toMatch(/type="submit"[^>]*disabled=""/);
    expect(writeBlocked).toContain("当前订单、房态或权限已变化");
    const changedRevision = renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_COLLECTION" view={orderView()} writeBlocked writeBlockedReason="房态已更新，请重新打开收款表单。" onClose={() => {}} onSubmit={() => {}} />);
    expect(changedRevision).toContain("房态已更新，请重新打开收款表单。");
  });
});
