import { sql, type Transaction } from "kysely";
import { DomainError } from "@qintopia/contracts";
import { newId } from "@qintopia/domain";
import type { DbExecutor } from "./inventory.ts";
import type { Database } from "./schema.ts";
import type { OrderContext } from "./orders.ts";
import type { ExternalPaymentBasis } from "./external-payments.ts";
import { requirePaymentAllocationEnabled } from "./payment-allocation.ts";

export const refundReconciliationOperation = "RECONCILE_WECOM_REFUNDS";
type Input = Record<string, unknown>;
interface Share { externalPaymentBillId: string; amountMinor: number }
interface Bill {
  id: string; property_id: string; source_id: string; merchant_id: string; kind: string; reference: string;
  transaction_id: string | null; original_trade_no: string; amount_minor: number | null; occurred_at: Date;
  state: string; needs_review: boolean; enabled: boolean; matching_since: Date; duplicate: boolean;
  allocated_minor: string; member_claimed: boolean; unresolved_history: boolean;
}
export interface RefundReconciliationEffect extends Record<string, unknown> {
  operation: typeof refundReconciliationOperation; orderId: string; orderStatus: string; currency: "CNY";
  source: Share & { transactionReference: string; occurredAt: string };
  refunds: Array<Share & { refundReference: string; occurredAt: string }>;
  collectedMinor: number; refundedMinor: number; netEffectMinor: number; note: string;
}
function record(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("VALIDATION_ERROR", "成组补登记资料格式不正确");
  return value as Input;
}
function exact(value: Input, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new DomainError("VALIDATION_ERROR", "成组补登记字段不完整或包含不支持的字段");
  }
}
function share(value: unknown): Share {
  const row = record(value); exact(row, ["externalPaymentBillId", "amountMinor"]);
  if (typeof row.externalPaymentBillId !== "string" || !row.externalPaymentBillId.trim()
    || row.externalPaymentBillId.length > 255 || !Number.isSafeInteger(row.amountMinor)
    || Number(row.amountMinor) <= 0 || Number(row.amountMinor) > 2147483647) {
    throw new DomainError("VALIDATION_ERROR", "请选择真实流水并填写有效的本单份额");
  }
  return { externalPaymentBillId: row.externalPaymentBillId.trim(), amountMinor: Number(row.amountMinor) };
}
export function parseRefundReconciliation(value: unknown) {
  const input = record(value); exact(input, ["source", "refunds", "note"]);
  const source = share(input.source);
  if (!Array.isArray(input.refunds) || input.refunds.length < 1 || input.refunds.length > 50) {
    throw new DomainError("VALIDATION_ERROR", "请选择 1 至 50 笔已成功的退款");
  }
  const refunds = input.refunds.map(share);
  if (new Set(refunds.map(row => row.externalPaymentBillId)).size !== refunds.length
    || refunds.some(row => row.externalPaymentBillId === source.externalPaymentBillId)) {
    throw new DomainError("VALIDATION_ERROR", "同一退款流水不能重复选择");
  }
  const refundedMinor = refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  if (refundedMinor > source.amountMinor) throw new DomainError("REFUND_LIMIT_EXCEEDED", "本次退款份额不能超过本次补登记的原收款份额", 409);
  if (typeof input.note !== "string" || !input.note.trim() || input.note.trim().length > 1000) {
    throw new DomainError("VALIDATION_ERROR", "请填写收退款归属核对说明");
  }
  return { source, refunds, refundedMinor, note: input.note.trim() };
}

/** No money is made available unless it is net of the still-unassigned refunds.
 * A fully refunded new share is also safe: it creates no spendable balance and
 * lets a completely refunded payment be reconciled one original order at a time. */
export function refundReconciliationReserveSafe(sourceRemaining: bigint, unassignedRefunds: bigint, collected: bigint, refunded: bigint) {
  return collected > 0n && refunded > 0n && refunded <= collected && collected <= sourceRemaining
    && refunded <= unassignedRefunds
    && (collected === refunded || sourceRemaining - collected >= unassignedRefunds - refunded);
}

async function sourceBills(db: DbExecutor, propertyId: string, sourceId: string, selectedIds: string[]): Promise<Bill[]> {
  // Freeze business evidence only. Sync's updated_at/contact observation fields
  // can change on an identical poll and must not invalidate an otherwise valid preview.
  return (await sql<Bill>`SELECT b.id,b.property_id,b.source_id,b.merchant_id,b.kind,b.reference,
    b.transaction_id,b.original_trade_no,b.amount_minor,b.occurred_at,b.state,b.needs_review,s.enabled,s.matching_since,
    EXISTS(SELECT 1 FROM external_payment_bills duplicate WHERE duplicate.property_id=b.property_id
      AND duplicate.kind=b.kind AND duplicate.reference=b.reference AND duplicate.id<>b.id) duplicate,
    COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a WHERE a.bill_id=b.id
      AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id)),0)::text allocated_minor,
    EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=b.id AND m.membership_payment_fact_id IS NOT NULL) member_claimed,
    (EXISTS(SELECT 1 FROM collection_facts f JOIN orders o ON o.id=f.order_id
      WHERE o.property_id=b.property_id AND f.method='WECOM' AND f.fact_type=b.kind
        AND (f.external_payment_bill_id=b.id OR CASE WHEN b.kind='COLLECTION' THEN f.transaction_reference ELSE f.refund_reference END=b.reference)
        AND NOT EXISTS(SELECT 1 FROM collection_facts r WHERE r.reverses_fact_id=f.fact_id
          AND NOT EXISTS(SELECT 1 FROM stay_collection_membership_transfers t
            WHERE t.property_id=o.property_id AND t.source_collection_fact_id=f.fact_id AND t.source_reversal_fact_id=r.fact_id))
        AND f.amount_minor<>(SELECT COALESCE(sum(a.amount_minor),0) FROM external_payment_allocations a
          WHERE a.bill_id=b.id AND a.collection_fact_id=f.fact_id
            AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)))
      OR EXISTS(SELECT 1 FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id
        WHERE b.kind='COLLECTION' AND o.property_id=b.property_id AND f.fact_type='COLLECTION'
          AND f.source_type='DIRECT_WECOM' AND f.transaction_reference=b.reference
          AND NOT EXISTS(SELECT 1 FROM membership_payment_facts r WHERE r.reverses_fact_id=f.fact_id))) unresolved_history
    FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
    WHERE b.property_id=${propertyId} AND (b.id IN (${sql.join([sourceId, ...selectedIds])})
      OR EXISTS(SELECT 1 FROM external_payment_bills p WHERE p.id=${sourceId} AND p.property_id=b.property_id
        AND p.source_id=b.source_id AND p.merchant_id=b.merchant_id AND b.kind='REFUND'
        AND (b.transaction_id=p.reference OR b.original_trade_no=p.original_trade_no))) ORDER BY b.id`.execute(db)).rows;
}
function verified(bill: Bill | undefined, kind: string): asserts bill is Bill & { amount_minor: number } {
  if (bill?.unresolved_history) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "该流水已有尚未落实来源占用的历史登记，请先核对历史归属后再补登记", 409);
  }
  if (!bill || bill.kind !== kind || !bill.enabled || bill.state !== "SUCCESS" || bill.amount_minor === null
    || bill.amount_minor <= 0 || bill.needs_review || bill.duplicate || bill.member_claimed
    || bill.occurred_at < bill.matching_since || BigInt(bill.allocated_minor) > BigInt(bill.amount_minor)) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "所选收退款来源尚未核实、属于历史范围或已经占用，请重新核对", 409);
  }
}
export async function buildRefundReconciliation(db: DbExecutor, context: OrderContext, rawInput: Input) {
  requirePaymentAllocationEnabled();
  exact(rawInput, ["propertyId", "orderId", "reconciliation"]);
  const input = parseRefundReconciliation(rawInput.reconciliation);
  const { order } = context;
  if (!["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"].includes(order.status)
    || context.revision.currency !== "CNY" || order.stay_type === "FREE"
    || order.member_id !== null || order.member_contract_id !== null
    || (order.booking_channel_code !== null && order.booking_channel_code !== "WECOM")) {
    throw new DomainError("INVALID_ORDER_STATE", "该订单不支持企微收退款补登记", 409);
  }
  const rows = await sourceBills(db, order.property_id, input.source.externalPaymentBillId, input.refunds.map(row => row.externalPaymentBillId));
  const source = rows.find(row => row.id === input.source.externalPaymentBillId);
  verified(source, "COLLECTION");
  const related = rows.filter(row => row.kind === "REFUND" && row.source_id === source.source_id && row.merchant_id === source.merchant_id
    && (row.transaction_id === source.reference || row.original_trade_no === source.original_trade_no));
  const successful = related.filter(row => row.state === "SUCCESS");
  if (successful.some(row => row.amount_minor === null || row.needs_review || row.duplicate || row.transaction_id !== source.reference
    || BigInt(row.allocated_minor) > BigInt(row.amount_minor))) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "原收款存在来源或金额待核对的退款，暂不能成组补登记", 409);
  }
  if (successful.reduce((sum, row) => sum + BigInt(row.amount_minor!), 0n) > BigInt(source.amount_minor)) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "成功退款总额超过原收款，请核对来源", 409);
  }
  const refunds = input.refunds.map(part => {
    const bill = rows.find(row => row.id === part.externalPaymentBillId); verified(bill, "REFUND");
    if (bill.source_id !== source.source_id || bill.merchant_id !== source.merchant_id || bill.transaction_id !== source.reference) {
      throw new DomainError("VALIDATION_ERROR", "退款流水与所选原收款不对应");
    }
    if (BigInt(part.amountMinor) > BigInt(bill.amount_minor) - BigInt(bill.allocated_minor)) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "本次退款份额超过流水尚未归属的余额", 409);
    }
    return { ...part, refundReference: bill.reference, occurredAt: bill.occurred_at.toISOString() };
  });
  const remaining = BigInt(source.amount_minor) - BigInt(source.allocated_minor);
  const unassigned = successful.reduce((sum, row) => sum + BigInt(row.amount_minor!) - BigInt(row.allocated_minor), 0n);
  if (!refundReconciliationReserveSafe(remaining, unassigned, BigInt(input.source.amountMinor), BigInt(input.refundedMinor))) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "本次补登记会占用其他尚未归属退款的资金，请核对本单收退款份额", 409);
  }
  const effect: RefundReconciliationEffect = { operation: refundReconciliationOperation, orderId: order.id, orderStatus: order.status, currency: "CNY",
    source: { ...input.source, transactionReference: source.reference, occurredAt: source.occurred_at.toISOString() }, refunds,
    collectedMinor: input.source.amountMinor, refundedMinor: input.refundedMinor, netEffectMinor: input.source.amountMinor - input.refundedMinor, note: input.note };
  // Binding refunds first keeps the ordinary collection freeze intact. The
  // remaining multi-order case is admitted only by the migration's group proof.
  const payments: ExternalPaymentBasis[] = [...refunds.map(row => ({ billId: row.externalPaymentBillId, kind: "REFUND" as const,
    reference: row.refundReference, amountMinor: row.amountMinor, alreadyMatched: false, allocation: true,
    allocatedMinor: Number(rows.find(bill => bill.id === row.externalPaymentBillId)!.allocated_minor) })),
  { billId: source.id, kind: "COLLECTION", reference: source.reference, amountMinor: input.source.amountMinor,
    alreadyMatched: false, allocation: true, allocatedMinor: Number(source.allocated_minor) }];
  return { effect, basis: { reconciliationBills: rows, externalPayments: payments } };
}

export async function lockRefundReconciliation(trx: Transaction<Database>, propertyId: string, raw: unknown) {
  const input = parseRefundReconciliation(raw);
  const rows = await sourceBills(trx, propertyId, input.source.externalPaymentBillId, input.refunds.map(row => row.externalPaymentBillId));
  const ids = rows.map(row => row.id).sort();
  if (ids.length) await sql`SELECT id FROM external_payment_bills WHERE property_id=${propertyId} AND id IN (${sql.join(ids)}) ORDER BY id FOR UPDATE`.execute(trx);
}
export async function applyRefundReconciliation(trx: Transaction<Database>, effect: RefundReconciliationEffect, commandId: string, previewId: string) {
  const sourceFactId = newId("fact"), refundFactIds = effect.refunds.map(() => newId("fact"));
  const insert = async (id: string, kind: "COLLECTION" | "REFUND", row: Share, reference: string) => {
    await sql`INSERT INTO collection_facts(fact_id,order_id,fact_type,amount_minor,net_effect_minor,currency,references_fact_id,
      reverses_fact_id,method,note,transaction_reference,refund_reference,external_payment_bill_id,pricing_revision_id,command_id)
      SELECT ${id},o.id,${kind},${row.amountMinor},${kind === "COLLECTION" ? row.amountMinor : -row.amountMinor},'CNY',
        ${kind === "REFUND" ? sourceFactId : null},NULL,'WECOM',${effect.note},${kind === "COLLECTION" ? reference : null},
        ${kind === "REFUND" ? reference : null},${row.externalPaymentBillId},o.current_revision_id,${commandId}
      FROM orders o WHERE o.id=${effect.orderId}`.execute(trx);
  };
  await insert(sourceFactId, "COLLECTION", effect.source, effect.source.transactionReference);
  for (const [index, row] of effect.refunds.entries()) await insert(refundFactIds[index]!, "REFUND", row, row.refundReference);
  await sql`INSERT INTO wecom_refund_reconciliations(command_id,preview_id,source_fact_id)
    VALUES(${commandId},${previewId},${sourceFactId})`.execute(trx);
  return { persistedResult: { ...effect, sourceFactId, refundFactIds }, resourceRefs: [effect.orderId], factRefs: [sourceFactId, ...refundFactIds] };
}
