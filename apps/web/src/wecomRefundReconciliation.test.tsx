import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderFundsFormDialog } from "./components/OrderFundsFormDialog";
import { paymentSelectable, type PaymentItem } from "./components/ExternalPaymentPicker";
import { buildRefundReconciliationRequest, refundReconciliationPreviewHasEvidence, refundReconciliationReceiptHasEvidence, type RefundReconciliationDraft } from "./wecomRefundReconciliation";
import { EffectSummary, clearTerminalPersistedCommandRecoveryIfPresent, readPersistedCommandRecovery, receiptHasCommandEvidence, recoveryCommandRequest, savePersistedCommandRecovery, transitionPersistedCommandRecovery, type PersistedCommandRecovery } from "./ui";
import type { OrderViewDto, PreviewDto, ReceiptDto } from "./types";

const view = { order: { id: "order-1", property_id: "property-1", status: "CANCELLED" }, collectionFacts: [],
  refundReconciliationAvailable: true,
  amounts: { collectionDifference: { minorUnits: 0, currency: "CNY" }, refundReferenceAmount: { minorUnits: 0, currency: "CNY" } } } as unknown as OrderViewDto;
const draft: RefundReconciliationDraft = { sourceBillId: "source", sourceAmountYuan: "1000", refunds: [{ billId: "refund-1", amountYuan: "600" }, { billId: "refund-2", amountYuan: "400" }], note: "订单取消，已收已退漏记" };
const request = () => buildRefundReconciliationRequest(view, structuredClone(draft));
function effect() {
  return { operation: "RECONCILE_WECOM_REFUNDS", orderId: "order-1", orderStatus: "CANCELLED", currency: "CNY",
    source: { externalPaymentBillId: "source", transactionReference: "WECOM-SOURCE", amountMinor: 100000, occurredAt: "2026-11-01T08:00:00Z" },
    refunds: [ { externalPaymentBillId: "refund-1", refundReference: "WECOM-REFUND-1", amountMinor: 60000, occurredAt: "2026-11-02T08:00:00Z" },
      { externalPaymentBillId: "refund-2", refundReference: "WECOM-REFUND-2", amountMinor: 40000, occurredAt: "2026-11-03T08:00:00Z" } ],
    collectedMinor: 100000, refundedMinor: 100000, netEffectMinor: 0, note: draft.note };
}
function receipt(): ReceiptDto { return { receiptId: "receipt-1", commandId: "command-1", executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation-1", committedAt: "2026-11-06T08:00:00Z", resourceRefs: ["order-1"], factRefs: ["source-fact", "refund-fact-1", "refund-fact-2"], result: { ...effect(), effectHash: "a".repeat(64), sourceFactId: "source-fact", refundFactIds: ["refund-fact-1", "refund-fact-2"] } } as ReceiptDto; }

describe("grouped WeCom refund evidence", () => {
  it("keeps gross collection and multiple refunds, including zero net on a cancelled order", () => {
    expect(request().input).toEqual({ propertyId: "property-1", orderId: "order-1", reconciliation: { source: { externalPaymentBillId: "source", amountMinor: 100000 }, refunds: [{ externalPaymentBillId: "refund-1", amountMinor: 60000 }, { externalPaymentBillId: "refund-2", amountMinor: 40000 }], note: draft.note } });
    expect(refundReconciliationPreviewHasEvidence(effect(), request().input)).toBe(true);
    const html = renderToStaticMarkup(<EffectSummary businessCommand="RECORD_REFUND" preview={{ previewId: "preview-1", commandType: "RECORD_REFUND", effectHash: "a".repeat(64), expiresAt: "2026-11-07T08:00:00Z", effect: effect() } as PreviewDto} commandInput={request().input} />);
    for (const reference of ["WECOM-SOURCE", "WECOM-REFUND-1", "WECOM-REFUND-2"]) expect(html).toContain(reference);
    expect(html).toContain("1,000.00"); expect(html).toContain("订单状态、金额和住宿安排保持原状");
    const grid = /<dl class="difference-grid">([\s\S]*?)<\/dl>/.exec(html)?.[1];
    expect(grid).toBeDefined();
    // Each label/value pair must be direct grid children on desktop and mobile.
    expect(grid).not.toMatch(/<div\b/);
    expect(grid).toMatch(/<dt>第 1 笔退款<\/dt><dd>¥600\.00 · WECOM-REFUND-1[^<]*<\/dd><dt>第 2 笔退款<\/dt><dd>¥400\.00 · WECOM-REFUND-2[^<]*<\/dd><dt>本次退款合计<\/dt><dd>¥1,000\.00<\/dd><dt>本次净影响<\/dt><dd><strong>¥0\.00<\/strong><\/dd>/);
  });
  it.each(["0", "-1", "0.001", "1e3", "21474836.48"])("rejects invalid original collection amount %s", amount => {
    expect(() => buildRefundReconciliationRequest(view, { ...draft, sourceAmountYuan: amount })).toThrow();
  });
  it("rejects duplicate, same-source, excessive and unreasoned refunds", () => {
    expect(() => buildRefundReconciliationRequest(view, { ...draft, refunds: [draft.refunds[0]!, draft.refunds[0]!] })).toThrow("只能选择一次");
    expect(() => buildRefundReconciliationRequest(view, { ...draft, refunds: [{ billId: "source", amountYuan: "100" }] })).toThrow("独立的退款流水");
    expect(() => buildRefundReconciliationRequest(view, { ...draft, sourceAmountYuan: "999.99" })).toThrow("不能超过");
    expect(() => buildRefundReconciliationRequest(view, { ...draft, note: " " })).toThrow("补记说明");
  });
  it("fails closed for preview source, amount, order, timestamp and gross-total mismatches", () => {
    for (const mutate of [
      (e: ReturnType<typeof effect>) => { e.source.externalPaymentBillId = "other"; },
      (e: ReturnType<typeof effect>) => { e.refunds[0]!.amountMinor = 1; },
      (e: ReturnType<typeof effect>) => { e.refunds[0]!.occurredAt = "unknown"; },
      (e: ReturnType<typeof effect>) => { e.orderId = "other"; },
      (e: ReturnType<typeof effect>) => { e.refundedMinor = 0; },
      (e: ReturnType<typeof effect>) => { e.netEffectMinor = 1; }
    ]) { const changed = effect(); mutate(changed); expect(refundReconciliationPreviewHasEvidence(changed, request().input)).toBe(false); }
  });
  it("requires every durable fact, the same preview, and its effect hash in the receipt", () => {
    expect(refundReconciliationReceiptHasEvidence(receipt(), request().input, effect(), "a".repeat(64))).toBe(true);
    const changed = receipt(); changed.factRefs.pop();
    expect(refundReconciliationReceiptHasEvidence(changed, request().input, effect(), "a".repeat(64))).toBe(false);
    expect(refundReconciliationReceiptHasEvidence(receipt(), request().input, effect(), "b".repeat(64))).toBe(false);
    expect(refundReconciliationReceiptHasEvidence(receipt(), request().input, { ...effect(), orderStatus: "RESERVED" }, "a".repeat(64))).toBe(false);
    const duplicate = receipt(); duplicate.result!.refundFactIds = ["refund-fact-1", "refund-fact-1"];
    expect(refundReconciliationReceiptHasEvidence(duplicate, request().input, effect(), "a".repeat(64))).toBe(false);
  });
  it("persists the original shares and hash so a reload can verify every refund without resubmission", () => {
    const context = { subjectId: "operator", scopeId: "property:property-1", request: request() };
    const confirming = { state: "CONFIRMING" as const, previewId: "preview-1", confirmationKey: "confirmation-1", effectHash: "a".repeat(64) };
    const { effectHash: _hash, ...withoutHash } = confirming;
    expect(transitionPersistedCommandRecovery(undefined, context, withoutHash).accepted).toBe(false);
    for (const reconciliation of [null, undefined, [], { ...context.request.input.reconciliation as object, note: "x".repeat(1001) }]) {
      expect(transitionPersistedCommandRecovery(undefined, { ...context, request: { ...context.request, input: { ...context.request.input, reconciliation } } }, confirming).accepted).toBe(false);
    }
    const transition = transitionPersistedCommandRecovery(undefined, context, confirming);
    expect(transition.accepted).toBe(true);
    if (!transition.recovery) throw new Error("Missing grouped refund recovery");
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    expect(savePersistedCommandRecovery(storage, transition.recovery)).toBe(true);
    const saved = readPersistedCommandRecovery(storage, context.subjectId, context.scopeId);
    expect(saved.kind).toBe("VALID");
    if (saved.kind !== "VALID") throw new Error("Invalid saved recovery");
    const restored = recoveryCommandRequest(saved.recovery);
    expect(restored.title).toBe("查询收款与退款登记结果");
    expect(restored.input).toEqual(context.request.input);
    expect(restored.recoveryEffectHash).toBe(confirming.effectHash);
    expect(receiptHasCommandEvidence("RECORD_REFUND", receipt(), restored.input, undefined, restored.recoveryEffectHash)).toBe(true);
    const incomplete = receipt(); incomplete.factRefs.pop();
    expect(receiptHasCommandEvidence("RECORD_REFUND", incomplete, restored.input, undefined, restored.recoveryEffectHash)).toBe(false);
    const unresolved = transitionPersistedCommandRecovery(saved.recovery, context, { state: "RESOLVED", confirmationKey: confirming.confirmationKey, receipt: incomplete });
    expect(unresolved.recovery?.state).toBe("UNKNOWN");
    expect(unresolved.recovery?.confirmationKey).toBe(confirming.confirmationKey);
    expect(savePersistedCommandRecovery(storage, unresolved.recovery!)).toBe(true);
    expect(clearTerminalPersistedCommandRecoveryIfPresent(storage, context.subjectId, context.scopeId)).toMatchObject({ kind: "VALID", recovery: { state: "UNKNOWN" } });
    expect(transitionPersistedCommandRecovery(unresolved.recovery, context, { state: "RESOLVED", confirmationKey: confirming.confirmationKey, receipt: receipt() }).recovery?.state).toBe("EXECUTED");
    expect(receiptHasCommandEvidence("RECORD_REFUND", receipt(), restored.input, undefined, "b".repeat(64))).toBe(false);
    for (const patch of [{ effectHash: undefined }, { commandType: "RECORD_COLLECTION" as const }, { presentation: "FULFILLMENT" }, { targetRefs: [] }, { refundReconciliation: { ...saved.recovery.refundReconciliation!, refunds: [] } }]) {
      expect(savePersistedCommandRecovery(storage, { ...saved.recovery, ...patch } as unknown as PersistedCommandRecovery)).toBe(false);
      storage.setItem([...values.keys()][0]!, JSON.stringify({ ...saved.recovery, ...patch }));
      expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");
    }
  });
  it("restores every selected bill, share and reason on returning from preview", () => {
    const html = renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_REFUND" view={view} draft={request()} onClose={() => {}} onSubmit={() => {}} />);
    expect(html).toContain("登记退款 · 一起补齐原收款");
    expect(html).toMatch(/data-testid="reconciliation-source-amount"[^>]*value="1000"/);
    expect(html).toMatch(/data-testid="reconciliation-refund-amount-0"[^>]*value="600"/);
    expect(html).toMatch(/data-testid="reconciliation-refund-amount-1"[^>]*value="400"/);
    expect(html).toContain(draft.note); expect(html).toContain("正在读取收退款");
  });
  it("only offers grouped backfill when the server grants it", () => {
    const render = (available: boolean) => renderToStaticMarkup(<OrderFundsFormDialog action="RECORD_REFUND" view={{ ...view, refundReconciliationAvailable: available }} onClose={() => {}} onSubmit={() => {}} />);
    expect(render(true)).toContain("原收款尚未登记，一起补齐");
    expect(render(false)).not.toContain("原收款尚未登记，一起补齐");
  });
  it("requires explicit grouped review when choosing an already refunded collection", () => {
    const item = { kind: "COLLECTION", status: "AVAILABLE", amountMinor: 100000, remainingMinor: 100000, refundSummary: { unassignedMinor: 100000 } } as PaymentItem;
    expect(paymentSelectable(item, true)).toBe(false);
    expect(paymentSelectable(item, true, true)).toBe(true);
    expect(paymentSelectable({ ...item, status: "REVIEW" } as PaymentItem, true, true)).toBe(false);
  });
});
