import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type CommandType } from "@qintopia/contracts";
import { randomUUID } from "node:crypto";
import type { Database } from "./schema.ts";
import type { ExternalBillKind } from "./wecom-client.ts";
import type { ExternalPaymentItem, ExternalPaymentList } from "../../contracts/src/external-payments.ts";
export type { ExternalPaymentItem, ExternalPaymentList } from "../../contracts/src/external-payments.ts";

type Db = Kysely<Database> | Transaction<Database>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const money = (value: unknown): number => Number(record(value).minorUnits ?? 0);
export interface PaymentQuery {
  kind: ExternalBillKind; recommended?: boolean; amountMinor?: number; query?: string;
  status?: "AVAILABLE" | "ALL" | "MATCHED" | "HISTORICAL";
  begin?: Date; end?: Date; beforeId?: string; limit?: number; originalCollectionFactId?: string;
  billId?: string;
}

export async function listExternalPayments(db: Db, propertyId: string, query: PaymentQuery): Promise<ExternalPaymentList> {
  const source = (await sql<{ enabled: boolean; last_synced_at: Date | null; has_error: boolean }>`
    SELECT bool_or(s.enabled) AS enabled,min(s.last_success_at) AS last_synced_at,
      bool_or(s.last_error_code IS NOT NULL) AS has_error
    FROM external_payment_sources s JOIN external_payment_accounts a ON a.source_id=s.id
    WHERE a.property_id=${propertyId}`.execute(db)).rows[0];
  const base = { enabled: source?.enabled === true, lastSyncedAt: source?.last_synced_at?.toISOString() ?? null,
    synchronizationError: source?.has_error === true };
  if (!base.enabled) return { ...base, items: [], hasMore: false, nextBeforeId: null };
  const limit = query.recommended ? 5 : Math.max(1, Math.min(100, query.limit ?? 50));
  const amountMinor = query.amountMinor ?? null;
  const term = query.query?.trim() || null;
  const status = query.recommended ? "AVAILABLE" : query.status ?? "AVAILABLE";
  const originalFactId = query.originalCollectionFactId ?? null;
  if (query.kind === "REFUND" && originalFactId) {
    const original = await db.selectFrom("collection_facts").innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select("collection_facts.fact_id").where("collection_facts.fact_id", "=", originalFactId)
      .where("orders.property_id", "=", propertyId).where("collection_facts.fact_type", "=", "COLLECTION").executeTakeFirst();
    if (!original) throw new DomainError("NOT_FOUND", "原收款不存在", 404);
  }
  const rows = (await sql<{
    id: string; kind: ExternalBillKind; reference: string; transaction_id: string | null; amount_minor: number | null;
    occurred_at: Date; nickname: string | null; status: ExternalPaymentItem["status"];
    order_id: string | null; membership_order_id: string | null;
  }>`WITH candidates AS (
    SELECT b.*,c.nickname,f.order_id,mf.membership_order_id,
      CASE WHEN m.bill_id IS NOT NULL THEN 'MATCHED'
        WHEN b.needs_review OR EXISTS(SELECT 1 FROM external_payment_bills duplicate
          WHERE duplicate.property_id=b.property_id AND duplicate.kind=b.kind AND duplicate.reference=b.reference AND duplicate.id<>b.id) THEN 'REVIEW'
        WHEN b.occurred_at<s.matching_since THEN 'HISTORICAL'
        WHEN b.state='PENDING' THEN 'PENDING'
        WHEN b.state<>'SUCCESS' OR b.amount_minor IS NULL THEN 'UNVERIFIED'
        ELSE 'AVAILABLE' END AS status
    FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
    LEFT JOIN external_payment_contacts c ON c.source_id=b.source_id AND c.external_user_id=b.external_user_id
    LEFT JOIN external_payment_matches m ON m.bill_id=b.id
    LEFT JOIN collection_facts f ON f.fact_id=m.collection_fact_id
    LEFT JOIN membership_payment_facts mf ON mf.fact_id=m.membership_payment_fact_id
    WHERE b.property_id=${propertyId} AND s.enabled AND b.kind=${query.kind}
      AND (${query.billId ?? null}::text IS NULL OR b.id=${query.billId ?? null})
      AND (${query.begin ?? null}::timestamptz IS NULL OR b.occurred_at>=${query.begin ?? null})
      AND (${query.end ?? null}::timestamptz IS NULL OR b.occurred_at<${query.end ?? null})
      AND (${originalFactId}::text IS NULL OR b.transaction_id=(SELECT transaction_reference FROM collection_facts WHERE fact_id=${originalFactId}))
      AND (${term}::text IS NULL OR c.nickname ILIKE '%'||${term}||'%' OR b.reference ILIKE '%'||${term}||'%')
  ) SELECT * FROM candidates
    WHERE (${status}='ALL' OR status=${status})
      AND (${amountMinor}::integer IS NULL OR amount_minor=${amountMinor})
      AND (${!query.recommended} OR occurred_at>=now()-interval '7 days')
      AND (${query.beforeId ?? null}::text IS NULL OR (occurred_at,id)<(
        SELECT occurred_at,id FROM external_payment_bills WHERE id=${query.beforeId ?? null} AND property_id=${propertyId}))
    ORDER BY occurred_at DESC,id DESC LIMIT ${limit + 1}`.execute(db)).rows;
  const items = rows.slice(0, limit).map(row => ({ id: row.id, kind: row.kind, reference: row.reference,
    originalTransactionReference: row.kind === "REFUND" ? row.transaction_id : null,
    amountMinor: row.amount_minor, occurredAt: row.occurred_at.toISOString(), nickname: row.nickname,
    status: row.status, orderId: row.order_id, membershipOrderId: row.membership_order_id,
    recommendationReasons: query.recommended ? [amountMinor ? "金额一致" : "近期流水", ...(originalFactId ? ["对应原收款"] : [])] : [] }));
  return { ...base, items, hasMore: rows.length > limit, nextBeforeId: rows.length > limit ? items.at(-1)!.id : null };
}

interface PaymentDescriptor { kind: ExternalBillKind; reference: string; amountMinor: number; originalCollectionFactId?: string }
function descriptors(command: CommandType, effect: RecordValue): PaymentDescriptor[] {
  if ((command === "RECORD_COLLECTION" || command === "RECORD_REFUND") && effect.method === "WECOM") {
    return [{ kind: command === "RECORD_REFUND" ? "REFUND" : "COLLECTION",
      reference: String(command === "RECORD_REFUND" ? effect.refundReference ?? "" : effect.transactionReference ?? ""),
      amountMinor: Number(effect.amountMinor), ...(command === "RECORD_REFUND" ? { originalCollectionFactId: String(effect.referencesFactId) } : {}) }];
  }
  let payment: RecordValue = {};
  if (command === "RECORD_MEMBERSHIP_PAYMENT" || command === "BACKFILL_HISTORICAL_MEMBERSHIP") payment = record(effect.payment);
  if (command === "CORRECT_MEMBERSHIP_PAYMENT") payment = record(effect.replacement);
  if (command === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") payment = record(effect.remainingPayment);
  if (command === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") payment = record(record(effect.funds).replacementDirectPayment);
  if (command === "COMPLETE_STAY" || command === "CREATE_ORDER") {
    payment = command === "CREATE_ORDER" ? record(record(effect.backfill).collection) : record(effect.collection);
    if (payment.method !== "WECOM") return [];
  }
  if (!payment.transactionReference) return [];
  return [{ kind: "COLLECTION", reference: String(payment.transactionReference), amountMinor: Number(payment.amountMinor ?? money(payment.amount)) }];
}

export interface ExternalPaymentBasis { billId: string; kind: ExternalBillKind; reference: string; amountMinor: number; alreadyMatched: boolean }
export async function externalPaymentBasis(db: Db, propertyId: string, command: CommandType, effect: RecordValue,
  lock = false): Promise<ExternalPaymentBasis[]> {
  const payments = descriptors(command, effect);
  if (!payments.length) return [];
  const configured = (await sql<{ enabled: boolean }>`SELECT EXISTS(SELECT 1 FROM external_payment_accounts a
    JOIN external_payment_sources s ON s.id=a.source_id WHERE a.property_id=${propertyId} AND s.enabled) AS enabled`.execute(db)).rows[0]?.enabled;
  if (!configured) return [];
  const output: ExternalPaymentBasis[] = [];
  for (const payment of payments) {
    if (lock) {
      // A separate statement is required: after waiting for a competing commit,
      // the subsequent READ COMMITTED query must see its newly inserted match.
      await sql`SELECT b.id FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
        WHERE b.property_id=${propertyId} AND s.enabled AND b.kind=${payment.kind} AND b.reference=${payment.reference}
        ORDER BY b.id FOR UPDATE OF b`.execute(db);
    }
    const rows = (await sql<{
      id: string; amount_minor: number | null; state: string; needs_review: boolean; occurred_at: Date;
      matching_since: Date; transaction_id: string | null; collection_fact_id: string | null; membership_payment_fact_id: string | null;
    }>`SELECT b.id,b.amount_minor,b.state,b.needs_review,b.occurred_at,s.matching_since,b.transaction_id,
      m.collection_fact_id,m.membership_payment_fact_id
      FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
      LEFT JOIN external_payment_matches m ON m.bill_id=b.id
      WHERE b.property_id=${propertyId} AND s.enabled AND b.kind=${payment.kind} AND b.reference=${payment.reference}
      `.execute(db)).rows;
    if (rows.length !== 1) throw new DomainError("VALIDATION_ERROR", rows.length ? "同号流水不唯一，请先核对商户" : "请选择已同步的企业微信收退款流水");
    const bill = rows[0]!;
    const alreadyMatched = Boolean(bill.collection_fact_id || bill.membership_payment_fact_id);
    let sameCorrection = command === "CORRECT_MEMBERSHIP_PAYMENT" && bill.membership_payment_fact_id === effect.originalPaymentFactId;
    if (!sameCorrection && command === "CORRECT_MEMBERSHIP_PAYMENT" && bill.membership_payment_fact_id) {
      // Note-only corrections append a replacement fact. Keep the original
      // external match while allowing later corrections along that same chain.
      sameCorrection = (await sql<{ valid: boolean }>`WITH RECURSIVE lineage AS (
        SELECT fact_id,command_id,membership_order_id FROM membership_payment_facts
          WHERE fact_id=${String(effect.originalPaymentFactId)} AND membership_order_id=${String(effect.membershipOrderId)}
            AND fact_type='COLLECTION' AND transaction_reference=${payment.reference}
        UNION SELECT previous.fact_id,previous.command_id,previous.membership_order_id FROM lineage current
          JOIN membership_payment_facts reversal ON reversal.command_id=current.command_id AND reversal.fact_type='REVERSAL'
          JOIN membership_payment_facts previous ON previous.fact_id=reversal.reverses_fact_id
          WHERE previous.membership_order_id=current.membership_order_id AND previous.fact_type='COLLECTION'
            AND previous.transaction_reference=${payment.reference}
      ) SELECT EXISTS(SELECT 1 FROM lineage WHERE fact_id=${bill.membership_payment_fact_id}) AS valid`.execute(db)).rows[0]?.valid === true;
    }
    if (alreadyMatched && !sameCorrection) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "这笔收退款已匹配，请选择其他流水", 409);
    if (bill.state !== "SUCCESS" || bill.needs_review || bill.amount_minor !== payment.amountMinor) throw new DomainError("VALIDATION_ERROR", "流水金额或状态不符合本次登记，请重新核对");
    if (bill.occurred_at < bill.matching_since && !sameCorrection) throw new DomainError("VALIDATION_ERROR", "这笔流水属于历史不纳入范围");
    if (payment.originalCollectionFactId) {
      const original = await db.selectFrom("collection_facts").innerJoin("orders", "orders.id", "collection_facts.order_id")
        .select(["collection_facts.transaction_reference", "collection_facts.order_id"])
        .where("collection_facts.fact_id", "=", payment.originalCollectionFactId).where("orders.property_id", "=", propertyId).executeTakeFirst();
      if (!bill.transaction_id || original?.transaction_reference !== bill.transaction_id || original.order_id !== effect.orderId) throw new DomainError("VALIDATION_ERROR", "退款流水与所选订单原收款不对应");
    }
    output.push({ billId: bill.id, kind: payment.kind, reference: payment.reference, amountMinor: payment.amountMinor, alreadyMatched });
  }
  if (new Set(output.map(p => p.billId)).size !== output.length) throw new DomainError("VALIDATION_ERROR", "同一流水不能重复选择");
  return output;
}

export async function bindExternalPayments(trx: Transaction<Database>, commandId: string, basis: ExternalPaymentBasis[]): Promise<void> {
  for (const payment of basis) {
    if (payment.alreadyMatched) continue;
    const rows = (await sql<{ fact_id: string; kind: "LODGING" | "MEMBERSHIP" }>`
      SELECT fact_id,'LODGING' AS kind FROM collection_facts
        WHERE command_id=${commandId} AND fact_type=${payment.kind} AND method='WECOM' AND amount_minor=${payment.amountMinor}
          AND CASE WHEN fact_type='REFUND' THEN refund_reference ELSE transaction_reference END=${payment.reference}
      UNION ALL SELECT fact_id,'MEMBERSHIP' FROM membership_payment_facts
        WHERE command_id=${commandId} AND fact_type='COLLECTION' AND source_type='DIRECT_WECOM'
          AND ${payment.kind}='COLLECTION' AND transaction_reference=${payment.reference} AND amount_minor=${payment.amountMinor}`.execute(trx)).rows;
    if (rows.length !== 1) throw new DomainError("INTERNAL_ERROR", "收退款事实与选定流水未形成唯一对应", 500);
    const fact = rows[0]!;
    await sql`INSERT INTO external_payment_matches(bill_id,collection_fact_id,membership_payment_fact_id,origin)
      VALUES(${payment.billId},${fact.kind === "LODGING" ? fact.fact_id : null},${fact.kind === "MEMBERSHIP" ? fact.fact_id : null},'CONFIRMED')`.execute(trx);
  }
}

export async function readExternalPaymentEvents(db: Db, propertyId: string, after: string, limit = 100) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n) throw new DomainError("VALIDATION_ERROR", "流水事件游标无效");
  const rows = (await sql<{ sequence: string; event_id: string; bill_id: string; event_type: string; created_at: Date; kind: ExternalBillKind }>`
    SELECT e.sequence::text,e.event_id,e.bill_id,e.event_type,e.created_at,b.kind FROM external_payment_events e
    JOIN external_payment_bills b ON b.id=e.bill_id
    WHERE e.property_id=${propertyId} AND e.sequence>${after}::bigint ORDER BY e.sequence LIMIT ${Math.max(1, Math.min(100,limit))}`.execute(db)).rows;
  return { schemaVersion: "pms.payments.v1", propertyId, events: rows.map(row => ({ eventId: row.event_id,
    billId: row.bill_id, kind: row.kind, eventType: row.event_type, occurredAt: row.created_at.toISOString(), sequence: row.sequence })),
    nextCursor: rows.at(-1)?.sequence ?? after };
}

export function externalBillId(): string { return `payment_${randomUUID()}`; }
