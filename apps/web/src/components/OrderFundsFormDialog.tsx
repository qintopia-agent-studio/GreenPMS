import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CollectionFactDto, CommandRequest, OrderViewDto } from "../types";
import {
  buildOrderFundsRequest,
  collectionAmountMinorToYuanInput,
  collectionFactTransactionReferenceLabel,
  collectionMethodLabel,
  orderFundsTitles,
  orderFundsTransactionReferenceRequired,
  remainingRefundableMinor,
  type OrderFundsAction
} from "../orderFunds";
import { InlineError, Modal, formatDateTime, formatMinor } from "../uiBasic";
import { ExternalPaymentPicker } from "./ExternalPaymentPicker";

export type { OrderFundsAction } from "../orderFunds";

export function OrderFundsFormDialog({ action, view, initialFactId, draft, writeBlocked = false, writeBlockedReason = "当前订单、房态或权限已变化，暂不能继续。请关闭后重新打开并核对。", onClose, onSubmit }: {
  action: OrderFundsAction;
  view: OrderViewDto;
  initialFactId?: string;
  draft?: CommandRequest;
  writeBlocked?: boolean;
  writeBlockedReason?: string;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const collections = view.collectionFacts.filter((fact) => fact.fact_type === "COLLECTION");
  const refundableCollections = collections.filter((fact) => remainingRefundableMinor(view.collectionFacts, fact) > 0);
  const matchingDraft = draft?.commandType === action
    && draft.input.orderId === view.order.id
    && draft.input.propertyId === view.order.property_id ? draft : undefined;
  const draftFactId = typeof matchingDraft?.input.referencesFactId === "string" ? matchingDraft.input.referencesFactId : undefined;
  const initialSelectedFactId = initialFactId ?? draftFactId ?? refundableCollections[0]?.fact_id ?? "";
  const recordedExcessMinor = view.amounts.refundReferenceAmount.minorUnits;
  function selectedRefundCollectionFor(collectionFactId: string): CollectionFactDto | undefined {
    return collections.find((fact) => fact.fact_id === collectionFactId);
  }
  function suggestedRefundFor(collectionFactId: string): number {
    const collection = selectedRefundCollectionFor(collectionFactId);
    if (!collection) return 0;
    return Math.min(recordedExcessMinor, remainingRefundableMinor(view.collectionFacts, collection));
  }
  const initialSuggestedRefund = action === "RECORD_REFUND" ? suggestedRefundFor(initialSelectedFactId) : 0;
  const initialRefundMethod = action === "RECORD_REFUND" ? selectedRefundCollectionFor(initialSelectedFactId)?.method ?? "WECOM" : "WECOM";
  const [amountYuan, setAmountYuan] = useState(() => typeof matchingDraft?.input.amountMinor === "number"
    ? collectionAmountMinorToYuanInput(matchingDraft.input.amountMinor)
    : collectionAmountMinorToYuanInput(initialSuggestedRefund));
  const [method, setMethod] = useState(typeof matchingDraft?.input.method === "string" ? matchingDraft.input.method : initialRefundMethod);
  const [note, setNote] = useState(typeof matchingDraft?.input.note === "string" ? matchingDraft.input.note : "");
  const [transactionReference, setTransactionReference] = useState(typeof matchingDraft?.input.transactionReference === "string" ? matchingDraft.input.transactionReference : "");
  const [refundReference, setRefundReference] = useState(typeof matchingDraft?.input.refundReference === "string" ? matchingDraft.input.refundReference : "");
  const [factId, setFactId] = useState(initialSelectedFactId);
  const transactionReferenceRequired = orderFundsTransactionReferenceRequired(action, method);
  const selectedRefundCollection = action === "RECORD_REFUND" ? selectedRefundCollectionFor(factId) : undefined;
  const [validationError, setValidationError] = useState<unknown>();
  const previousRefundSuggestion = useRef({ action, factId, recordedExcessMinor });

  useEffect(() => {
    const previous = previousRefundSuggestion.current;
    previousRefundSuggestion.current = { action, factId, recordedExcessMinor };
    if (action !== "RECORD_REFUND" || (previous.action === action && previous.factId === factId && previous.recordedExcessMinor === recordedExcessMinor)) return;
    setAmountYuan(collectionAmountMinorToYuanInput(suggestedRefundFor(factId)));
  }, [action, factId, recordedExcessMinor]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeBlocked) return;
    setValidationError(undefined);
    try {
      const request = buildOrderFundsRequest(view, action, { amountYuan, method, note, transactionReference, refundReference, factId });
      onSubmit(request);
    } catch (error) {
      setValidationError(error);
    }
  }

  return (
    <Modal title={orderFundsTitles[action]} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit} noValidate>
        <InlineError error={validationError} title="无法继续" />
        {writeBlocked ? <p className="form-field-note" role="status">{writeBlockedReason}</p> : null}
        <div className="form-grid form-grid-two">
          {action === "RECORD_REFUND" && refundableCollections.length === 0 ? (
            <div className="span-two form-field-note" role="status">
              <strong>该订单当前没有可退款的收款记录</strong>
              <span>需要先有未被冲销、且仍有可退余额的原收款，才能登记退款。</span>
            </div>
          ) : null}
          {action === "RECORD_REFUND" && refundableCollections.length > 0 ? <label className="span-two">选择原收款<select value={factId} onChange={(event) => {
            const nextFactId = event.target.value;
            const nextFact = selectedRefundCollectionFor(nextFactId);
            setFactId(nextFactId);
            if (nextFact?.method) setMethod(nextFact.method);
            setTransactionReference("");
            setRefundReference("");
            setValidationError(undefined);
          }} required>{refundableCollections.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{formatDateTime(fact.created_at)} · {collectionFactTransactionReferenceLabel(view.collectionFacts, fact)} · 可退 {formatMinor(remainingRefundableMinor(view.collectionFacts, fact), fact.currency)} · {collectionMethodLabel(fact.method)}</option>)}</select></label> : null}
          <label>金额（元）<input type="text" value={amountYuan} onChange={(event) => { setAmountYuan(event.target.value); setValidationError(undefined); }} required inputMode="decimal" placeholder="例如 1280.50" data-testid="fact-amount-yuan" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0} /></label>
          <label>{action === "RECORD_REFUND" ? "退款方式" : "收款方式"}<select value={method} onChange={(event) => { setMethod(event.target.value); setTransactionReference(""); setValidationError(undefined); }} disabled={(action === "RECORD_REFUND" && refundableCollections.length === 0) || selectedRefundCollection?.method === "WECOM"}><option value="WECOM">企业微信</option><option value="BANK_TRANSFER">银行转账</option><option value="CASH">现金</option><option value="OTHER">其他</option></select></label>
          {action === "RECORD_REFUND" && method === "WECOM" ? <div className="span-two form-field-note" role="status">
            <strong>企业微信原路退回</strong>
            <span>对应所选原收款；本次退款需记录独立退款单号。</span>
          </div> : null}
          {action === "RECORD_REFUND" && method === "WECOM" ? <ExternalPaymentPicker key={factId} propertyId={view.order.property_id} kind="REFUND" originalCollectionFactId={factId} value={refundReference} amountMinor={Math.round(Number(amountYuan) * 100)} testId="refund-reference" disabled={refundableCollections.length === 0} onChange={(reference, item) => { setRefundReference(reference); if (item?.amountMinor) setAmountYuan(collectionAmountMinorToYuanInput(item.amountMinor)); setValidationError(undefined); }} /> : null}
          {transactionReferenceRequired ? method === "WECOM" ? <ExternalPaymentPicker propertyId={view.order.property_id} value={transactionReference} amountMinor={Math.round(Number(amountYuan) * 100) || Math.max(0, view.amounts.collectionDifference.minorUnits)} testId="transaction-reference" onChange={(reference, item) => { setTransactionReference(reference); if (item?.amountMinor) setAmountYuan(collectionAmountMinorToYuanInput(item.amountMinor)); setValidationError(undefined); }} /> : <label className="span-two">交易单号 / 流水号<input value={transactionReference} onChange={(event) => { setTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="transaction-reference" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0} /></label> : null}
          <label className="span-two">{action === "RECORD_REFUND" ? "退款原因" : method === "CASH" ? "收款人" : method === "OTHER" ? "其他收款说明" : "备注（选填）"}<textarea rows={3} value={note} onChange={(event) => { setNote(event.target.value); setValidationError(undefined); }} required={action === "RECORD_REFUND" || method === "CASH" || method === "OTHER"} maxLength={1000} data-testid={action === "RECORD_REFUND" ? "refund-reason" : "collection-note"} /></label>
        </div>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={writeBlocked || (action === "RECORD_REFUND" && refundableCollections.length === 0)}>下一步</button></div>
      </form>
    </Modal>
  );
}
