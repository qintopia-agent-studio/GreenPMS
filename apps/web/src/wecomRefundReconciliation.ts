import type { CommandRequest, OrderViewDto, ReceiptDto } from "./types";
import { collectionAmountYuanInputToMinor } from "./orderFunds";

export interface RefundReconciliationDraft {
  sourceBillId: string;
  sourceAmountYuan: string;
  refunds: Array<{ billId: string; amountYuan: string }>;
  note: string;
}

export interface RefundReconciliationInput {
  source: { externalPaymentBillId: string; amountMinor: number };
  refunds: Array<{ externalPaymentBillId: string; amountMinor: number }>;
  note: string;
}

export interface RefundReconciliationEffect {
  operation: "RECONCILE_WECOM_REFUNDS";
  orderId: string;
  orderStatus: string;
  currency: "CNY";
  source: { externalPaymentBillId: string; transactionReference: string; amountMinor: number; occurredAt: string };
  refunds: Array<{ externalPaymentBillId: string; refundReference: string; amountMinor: number; occurredAt: string }>;
  collectedMinor: number;
  refundedMinor: number;
  netEffectMinor: number;
  note: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positiveMoney = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));

export function isRefundReconciliationInput(input: Record<string, unknown>): boolean {
  return record(input.reconciliation);
}

/** Persist only the submitted evidence needed to verify the original receipt after reload. */
export function isValidRefundReconciliationInput(value: unknown): value is RefundReconciliationInput {
  if (!record(value) || Object.keys(value).some(key => !["source", "refunds", "note"].includes(key))
    || !text(value.note) || value.note.length > 1000 || !Array.isArray(value.refunds) || value.refunds.length < 1 || value.refunds.length > 50) return false;
  const validShare = (share: unknown): share is RefundReconciliationInput["source"] => record(share)
    && Object.keys(share).length === 2 && text(share.externalPaymentBillId) && positiveMoney(share.amountMinor);
  if (!validShare(value.source) || !value.refunds.every(validShare)) return false;
  const ids = [value.source.externalPaymentBillId, ...value.refunds.map(row => row.externalPaymentBillId)];
  return new Set(ids).size === ids.length && value.refunds.reduce((sum, row) => sum + row.amountMinor, 0) <= value.source.amountMinor;
}

export function buildRefundReconciliationRequest(view: Pick<OrderViewDto, "order">, draft: RefundReconciliationDraft): CommandRequest {
  const sourceAmount = collectionAmountYuanInputToMinor(draft.sourceAmountYuan);
  if (!draft.sourceBillId || sourceAmount === undefined) throw new Error("请选择真实原收款，并填写本订单需要补记的收款金额");
  if (draft.refunds.length > 50) throw new Error("一次最多补齐 50 笔退款，请分次核对");
  if (!draft.refunds.length) throw new Error("至少选择一笔已成功的关联退款");
  const refunds = draft.refunds.map(row => {
    const amountMinor = collectionAmountYuanInputToMinor(row.amountYuan);
    if (!row.billId || amountMinor === undefined) throw new Error("请选择真实退款，并填写本订单对应的退款金额");
    return { externalPaymentBillId: row.billId, amountMinor };
  });
  if (new Set(refunds.map(row => row.externalPaymentBillId)).size !== refunds.length) throw new Error("同一退款流水只能选择一次");
  if (refunds.some(row => row.externalPaymentBillId === draft.sourceBillId)) throw new Error("退款必须选择独立的退款流水");
  const totalRefund = refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  if (totalRefund > sourceAmount) throw new Error("本次退款合计不能超过本订单补记的原收款金额");
  if (!draft.note.trim()) throw new Error("请填写退款原因和补记说明");
  return {
    commandType: "RECORD_REFUND", title: "一起补齐收款与退款", description: "",
    input: { propertyId: view.order.property_id, orderId: view.order.id, reconciliation: {
      source: { externalPaymentBillId: draft.sourceBillId, amountMinor: sourceAmount }, refunds, note: draft.note.trim()
    } },
    initialReason: { code: "RECORD_REFUND", note: draft.note.trim() }
  };
}

/** Reject incomplete or unrelated evidence before allowing a financial confirmation. */
export function refundReconciliationPreviewHasEvidence(effect: unknown, input: Record<string, unknown>): effect is RefundReconciliationEffect {
  if (!record(effect) || !record(input.reconciliation)) return false;
  const submitted = input.reconciliation;
  if (effect.operation !== "RECONCILE_WECOM_REFUNDS" || effect.orderId !== input.orderId || !text(effect.orderId)
    || effect.currency !== "CNY" || !["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"].includes(String(effect.orderStatus))
    || !record(effect.source) || !record(submitted.source) || !Array.isArray(effect.refunds) || !Array.isArray(submitted.refunds)
    || !effect.refunds.length || effect.refunds.length > 50 || effect.refunds.length !== submitted.refunds.length || effect.note !== submitted.note || !text(effect.note)) return false;
  const source = effect.source;
  if (!text(source.externalPaymentBillId) || source.externalPaymentBillId !== submitted.source.externalPaymentBillId
    || !text(source.transactionReference) || !positiveMoney(source.amountMinor) || source.amountMinor !== submitted.source.amountMinor || !date(source.occurredAt)) return false;
  const ids = new Set<string>();
  let refunded = 0;
  for (let i = 0; i < effect.refunds.length; i++) {
    const row = effect.refunds[i], expected = submitted.refunds[i];
    if (!record(row) || !record(expected) || !text(row.externalPaymentBillId) || row.externalPaymentBillId !== expected.externalPaymentBillId
      || row.externalPaymentBillId === source.externalPaymentBillId || ids.has(row.externalPaymentBillId)
      || !text(row.refundReference) || !positiveMoney(row.amountMinor) || row.amountMinor !== expected.amountMinor || !date(row.occurredAt)) return false;
    ids.add(row.externalPaymentBillId); refunded += row.amountMinor;
  }
  return Number.isSafeInteger(refunded) && refunded <= source.amountMinor && effect.collectedMinor === source.amountMinor
    && effect.refundedMinor === refunded && effect.netEffectMinor === source.amountMinor - refunded;
}

export function refundReconciliationReceiptHasEvidence(receipt: ReceiptDto, input: Record<string, unknown>, previewEffect?: Record<string, unknown>, effectHash?: string): boolean {
  const result = receipt.result;
  if (!record(result) || !refundReconciliationPreviewHasEvidence(result, input) || typeof effectHash !== "string" || !/^[a-f0-9]{64}$/.test(effectHash)
    || result.effectHash !== effectHash || !text(result.sourceFactId) || !Array.isArray(result.refundFactIds)
    || result.refundFactIds.length !== result.refunds.length || !result.refundFactIds.every(text)
    || new Set([result.sourceFactId, ...result.refundFactIds]).size !== result.refunds.length + 1
    || !receipt.resourceRefs.includes(result.orderId) || !receipt.factRefs.includes(result.sourceFactId)
    || !result.refundFactIds.every(id => receipt.factRefs.includes(id))) return false;
  return !previewEffect || Object.entries(previewEffect).every(([key, value]) => sameEvidence(value, result[key]));
}

function sameEvidence(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameEvidence(value, right[index]));
  if (record(left) && record(right)) return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && sameEvidence(value, right[key]));
  return false;
}
