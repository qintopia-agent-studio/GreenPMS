import type { CollectionFactDto, CommandRequest, OrderViewDto } from "./types";
import { formatMinor } from "./uiBasic";

const MAX_AMOUNT_MINOR = 2_147_483_647;

export type OrderFundsAction = "RECORD_COLLECTION" | "RECORD_REFUND";

export const orderFundsTitles: Record<OrderFundsAction, string> = {
  RECORD_COLLECTION: "登记收款",
  RECORD_REFUND: "登记退款"
};

export interface OrderFundsFormValues {
  amountYuan: string;
  method: string;
  note: string;
  transactionReference: string;
  refundReference: string;
  factId: string;
}

export function orderFundsTransactionReferenceRequired(action: OrderFundsAction, method: string): boolean {
  return method === "BANK_TRANSFER" || (action === "RECORD_COLLECTION" && method === "WECOM");
}

export function buildOrderFundsRequest(
  view: Pick<OrderViewDto, "order" | "collectionFacts">,
  action: OrderFundsAction,
  values: OrderFundsFormValues
): CommandRequest {
  const { amountYuan, method, note, transactionReference, refundReference, factId } = values;
  const refundableCollections = view.collectionFacts.filter((fact) => remainingRefundableMinor(view.collectionFacts, fact) > 0);
  const selectedCollection = refundableCollections.find((fact) => fact.fact_id === factId);
  if (action === "RECORD_REFUND" && refundableCollections.length === 0) {
    throw new Error("该订单当前没有可退款的收款记录，不能登记退款");
  }
  if (action === "RECORD_REFUND" && !selectedCollection) {
    throw new Error("请选择要退款的原收款");
  }
  const trimmedNote = note.trim();
  if (action === "RECORD_REFUND" && !trimmedNote) {
    throw new Error("必须填写退款原因");
  }
  if (action === "RECORD_COLLECTION" && !trimmedNote && (method === "CASH" || method === "OTHER")) {
    throw new Error(method === "CASH" ? "必须填写收款人" : "必须填写其他收款说明");
  }
  const amountMinor = collectionAmountYuanInputToMinor(amountYuan);
  if (amountMinor === undefined) {
    throw new Error("金额必须按人民币元填写，大于 0 且最多保留两位小数");
  }
  const selectedRemainingMinor = selectedCollection ? remainingRefundableMinor(view.collectionFacts, selectedCollection) : 0;
  if (action === "RECORD_REFUND" && amountMinor > selectedRemainingMinor) {
    const maximum = formatMinor(selectedRemainingMinor, selectedCollection?.currency ?? "CNY");
    throw new Error(`退款金额不能超过所选原收款的剩余可退金额（最多可退 ${maximum}）。如需退多笔原收款，请分多次办理。`);
  }
  if (orderFundsTransactionReferenceRequired(action, method) && !transactionReference.trim()) {
    throw new Error(method === "WECOM" ? "必须填写企业微信交易单号" : "必须填写交易单号或流水号");
  }
  if (action === "RECORD_REFUND" && method === "WECOM" && !refundReference.trim()) {
    throw new Error("必须填写本次企业微信退款单号");
  }
  return {
    commandType: action,
    title: orderFundsTitles[action],
    description: "",
    input: {
      propertyId: view.order.property_id,
      orderId: view.order.id,
      amountMinor,
      method,
      note: trimmedNote,
      ...(transactionReference.trim() ? { transactionReference: transactionReference.trim() } : {}),
      ...(action === "RECORD_REFUND" ? {
        referencesFactId: factId,
        ...(method === "WECOM" ? { refundReference: refundReference.trim() } : {})
      } : {})
    },
    initialReason: { code: action, note: action === "RECORD_REFUND" ? trimmedNote : trimmedNote || "登记收款" }
  };
}

export function remainingRefundableMinor(facts: readonly CollectionFactDto[], collection: CollectionFactDto): number {
  if (collection.fact_type !== "COLLECTION" || facts.some((fact) => fact.reverses_fact_id === collection.fact_id)) return 0;
  const activeRefunded = facts
    .filter((fact) => fact.fact_type === "REFUND" && fact.references_fact_id === collection.fact_id)
    .filter((refund) => !facts.some((fact) => fact.reverses_fact_id === refund.fact_id))
    .reduce((sum, refund) => sum + refund.amount_minor, 0);
  return Math.max(0, collection.amount_minor - activeRefunded);
}

export function collectionFactTransactionReferenceLabel(facts: readonly CollectionFactDto[], fact: CollectionFactDto): string {
  if (fact.fact_type === "REVERSAL") return "不适用";
  if (fact.transaction_reference) return fact.transaction_reference;
  if (fact.fact_type === "REFUND" && fact.method === "WECOM") {
    const original = facts.find((item) => item.fact_id === fact.references_fact_id);
    return `${fact.refund_reference ? `退款 ${fact.refund_reference}` : "历史未记录退款单号"}${original?.transaction_reference ? ` · 原收款 ${original.transaction_reference}` : ""}`;
  }
  return fact.method === "CASH" || fact.method === "OTHER" ? "不适用" : "历史未记录";
}

export function collectionMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    CASH: "现金",
    BANK_TRANSFER: "银行转账",
    CARD: "银行卡",
    WECOM: "企业微信",
    WECHAT: "微信",
    ALIPAY: "支付宝",
    OTHER: "其他方式"
  };
  return labels[method] ?? "其他方式";
}

export function collectionAmountYuanInputToMinor(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const [yuanPart, fractionPart = ""] = normalized.split(".");
  const minor = BigInt(yuanPart!) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  if (minor <= 0n || minor > BigInt(MAX_AMOUNT_MINOR)) return undefined;
  return Number(minor);
}

export function collectionAmountMinorToYuanInput(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) return "";
  const yuan = Math.trunc(minorUnits / 100);
  const cents = minorUnits % 100;
  return cents === 0 ? String(yuan) : `${yuan}.${String(cents).padStart(2, "0")}`;
}
