import { useState, type FormEvent } from "react";
import type { CommandRequest, OrderViewDto } from "../types";
import { collectionAmountMinorToYuanInput, collectionAmountYuanInputToMinor } from "../orderFunds";
import { buildRefundReconciliationRequest, type RefundReconciliationDraft } from "../wecomRefundReconciliation";
import { InlineError, Modal, formatMinor } from "../uiBasic";
import { ExternalPaymentPicker, type PaymentItem } from "./ExternalPaymentPicker";

type RefundRow = RefundReconciliationDraft["refunds"][number] & { key: number; reference: string; item?: PaymentItem | undefined };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function draftValues(draft: CommandRequest | undefined, view: OrderViewDto) {
  const root = draft?.commandType === "RECORD_REFUND" && draft.input.orderId === view.order.id && draft.input.propertyId === view.order.property_id ? object(draft.input.reconciliation) : {};
  const source = object(root.source);
  return { sourceBillId: typeof source.externalPaymentBillId === "string" ? source.externalPaymentBillId : "",
    sourceAmountYuan: collectionAmountMinorToYuanInput(Number(source.amountMinor)),
    refunds: (Array.isArray(root.refunds) ? root.refunds : []).map((value, key): RefundRow => {
      const row = object(value); return { key, billId: String(row.externalPaymentBillId ?? ""), reference: "", amountYuan: collectionAmountMinorToYuanInput(Number(row.amountMinor)) };
    }), note: typeof root.note === "string" ? root.note : "" };
}
const remaining = (item: PaymentItem) => "remainingMinor" in item ? item.remainingMinor : item.amountMinor ?? 0;

export function WecomRefundReconciliationForm({ view, draft, editingDraft, initialSource, writeBlocked, writeBlockedReason, onBack, onClose, onSubmit }: {
  view: OrderViewDto; draft?: CommandRequest | undefined; editingDraft?: RefundReconciliationDraft | undefined; initialSource?: PaymentItem | undefined;
  writeBlocked?: boolean | undefined; writeBlockedReason?: string | undefined;
  onBack: (draft: RefundReconciliationDraft) => void; onClose: () => void; onSubmit: (request: CommandRequest) => void;
}) {
  const [initial] = useState(() => editingDraft ? { ...editingDraft, refunds: editingDraft.refunds.map((row, key) => ({ ...row, key, reference: "" })) } : draftValues(draft, view));
  const [sourceBillId, setSourceBillId] = useState(initial.sourceBillId || initialSource?.id || "");
  const resolvedInitialSource = initialSource && (!initial.sourceBillId || initial.sourceBillId === initialSource.id) ? initialSource : undefined;
  const [source, setSource] = useState<PaymentItem | undefined>(resolvedInitialSource);
  const [sourceReference, setSourceReference] = useState(resolvedInitialSource?.reference ?? "");
  const [sourceAmountYuan, setSourceAmountYuan] = useState(editingDraft ? initial.sourceAmountYuan : initial.sourceAmountYuan || (resolvedInitialSource ? collectionAmountMinorToYuanInput(remaining(resolvedInitialSource)) : ""));
  const [refunds, setRefunds] = useState<RefundRow[]>(initial.refunds.length ? initial.refunds : [{ key: 0, billId: "", reference: "", amountYuan: "" }]);
  const [nextKey, setNextKey] = useState(refunds.length);
  const [note, setNote] = useState(initial.note);
  const [error, setError] = useState<unknown>();
  const sourceAmount = collectionAmountYuanInputToMinor(sourceAmountYuan) ?? 0;
  const totalRefund = refunds.reduce((total, row) => total + (collectionAmountYuanInputToMinor(row.amountYuan) ?? 0), 0);
  const sourceRecordedMinor = source ? view.collectionFacts.filter(fact => fact.fact_type === "COLLECTION"
    && !view.collectionFacts.some(reversal => reversal.reverses_fact_id === fact.fact_id)
    && (fact.external_payment_bill_id === source.id || fact.transaction_reference === source.reference)).reduce((sum, fact) => sum + fact.amount_minor, 0) : 0;
  const blocked = writeBlocked || view.refundReconciliationAvailable !== true;
  function update(key: number, patch: Partial<RefundRow>) { setRefunds(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row)); setError(undefined); }
  function submit(event: FormEvent) {
    event.preventDefault(); if (blocked) return;
    try {
      if (!source || source.id !== sourceBillId) throw new Error("原收款资料尚未载入，请稍候核对");
      if (sourceAmount > remaining(source)) throw new Error("本单补记收款不能超过原流水尚未分配金额");
      for (const row of refunds) {
        if (!row.item || row.item.id !== row.billId) throw new Error("所选退款资料尚未载入，请稍候核对");
        if ((collectionAmountYuanInputToMinor(row.amountYuan) ?? 0) > remaining(row.item)) throw new Error("本单退款份额不能超过对应退款流水尚未分配金额");
      }
      onSubmit(buildRefundReconciliationRequest(view, { sourceBillId, sourceAmountYuan, refunds, note }));
    } catch (failure) { setError(failure); }
  }
  return <Modal title="登记退款 · 一起补齐原收款" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit} noValidate>
      <p className="form-field-note">原收款尚未登记时，在这里一起补齐真实收款与退款。请核对本订单的份额；确认后保留各笔流水，订单状态和住宿安排保持原状。</p>
      <InlineError error={error} title="无法继续" />
      {blocked ? <p role="status">{writeBlockedReason ?? "当前暂不能补齐收退款，请核对订单权限与流水同步状态。"}</p> : null}
      <div className="form-grid form-grid-two">
        <ExternalPaymentPicker allocationMode allowRefundedSource propertyId={view.order.property_id} value={sourceReference} billId={sourceBillId}
          label="选择需要补记的企业微信原收款" testId="reconciliation-source" disabled={Boolean(blocked)}
          onResolve={item => { setSource(item); if (item) setSourceReference(item.reference); }}
          onChange={(reference, item) => { setSourceReference(reference); setSourceBillId(item?.id ?? ""); setSource(item); setSourceAmountYuan(item ? collectionAmountMinorToYuanInput(remaining(item)) : ""); setRefunds([{ key: nextKey, billId: "", reference: "", amountYuan: "" }]); setNextKey(value => value + 1); setError(undefined); }} />
        {sourceRecordedMinor > 0 ? <p className="span-two form-field-note" role="status">本订单已登记此原收款 {formatMinor(sourceRecordedMinor, "CNY")}。已登记部分请返回选择已有原收款，只补退款；这里仅补尚未登记的份额，不要重复填写整笔收款。</p> : null}
        <label>本单补记收款（元）<input inputMode="decimal" value={sourceAmountYuan} onChange={event => setSourceAmountYuan(event.target.value)} data-testid="reconciliation-source-amount" /></label>
        {source ? <p className="form-field-note">原流水 {formatMinor(source.amountMinor ?? 0, "CNY")} · 尚未分配 {formatMinor(remaining(source), "CNY")}</p> : null}
      </div>
      {sourceBillId ? <div className="reconciliation-refunds">{refunds.map((row, index) => <fieldset key={row.key} className="reconciliation-refund-row">
        <legend>第 {index + 1} 笔退款</legend>
        <ExternalPaymentPicker allocationMode propertyId={view.order.property_id} kind="REFUND" originalCollectionBillId={sourceBillId}
          value={row.reference} billId={row.billId} label={`选择第 ${index + 1} 笔企业微信退款`} testId={`reconciliation-refund-${index}`} disabled={Boolean(blocked)}
          onResolve={item => update(row.key, { item, ...(item ? { reference: item.reference } : {}) })}
          onChange={(reference, item) => update(row.key, { reference, billId: item?.id ?? "", item,
            amountYuan: item ? collectionAmountMinorToYuanInput(Math.min(remaining(item), Math.max(0, sourceAmount - refunds.filter(other => other.key !== row.key).reduce((total, other) => total + (collectionAmountYuanInputToMinor(other.amountYuan) ?? 0), 0)))) : "" })} />
        <label>本单第 {index + 1} 笔退款（元）<input inputMode="decimal" value={row.amountYuan} onChange={event => update(row.key, { amountYuan: event.target.value })} data-testid={`reconciliation-refund-amount-${index}`} /></label>
        {row.item ? <small>该退款尚未分配 {formatMinor(remaining(row.item), "CNY")}</small> : null}
        {refunds.length > 1 ? <button type="button" className="button button-secondary button-small" onClick={() => setRefunds(rows => rows.filter(other => other.key !== row.key))}>移除第 {index + 1} 笔</button> : null}
      </fieldset>)}
        <button type="button" className="button button-secondary" disabled={refunds.length >= 50 || Boolean(blocked)} onClick={() => { setRefunds(rows => [...rows, { key: nextKey, billId: "", reference: "", amountYuan: "" }]); setNextKey(value => value + 1); }}>添加另一笔关联退款</button>
      </div> : null}
      <p className="form-field-note" aria-live="polite">本次补记收款 {formatMinor(sourceAmount, "CNY")} · 退款 {formatMinor(totalRefund, "CNY")} · 净影响 {formatMinor(sourceAmount - totalRefund, "CNY")}</p>
      <label>退款原因和补记说明<textarea rows={3} value={note} onChange={event => setNote(event.target.value)} required maxLength={1000} data-testid="reconciliation-note" /></label>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={() => onBack({ sourceBillId, sourceAmountYuan, refunds: refunds.map(({ billId, amountYuan }) => ({ billId, amountYuan })), note })}>返回选择已有原收款</button><button type="submit" className="button button-primary" disabled={Boolean(blocked)}>下一步</button></div>
    </form>
  </Modal>;
}
