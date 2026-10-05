import { sql, type Kysely } from "kysely";
import { DomainError, type WorkbenchFundsExceptionItem, type WorkbenchFundsExceptionList } from "@qintopia/contracts";
import type { Database } from "./schema.ts";
import { paymentAllocationEnabled } from "./payment-allocation.ts";

export interface WorkbenchFundsQuery { propertyId: string; query?: string; cursor?: string; limit?: number }
type Cursor = { at: string; id: string };
function decodeCursor(value?: string): Cursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (typeof cursor.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at)
      || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== "string" || cursor.id.length > 200
      || !/^(order|collection|refund):.+$/.test(cursor.id)) throw new Error();
    return cursor;
  } catch { throw new DomainError("VALIDATION_ERROR", "资金待办分页位置无效，请从第一页重新查询", 400); }
}
function checkedMinor(value: string | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new DomainError("INTERNAL_ERROR", "资金金额无法可靠读取，请核对来源", 500);
  return amount;
}

/** A projection of existing facts, never a second ledger or authorization to spend. */
export async function listWorkbenchFundsExceptions(db: Kysely<Database>, query: WorkbenchFundsQuery): Promise<WorkbenchFundsExceptionList> {
  const limit = query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.query?.length ?? 0) > 200 || (query.cursor?.length ?? 0) > 1000) {
    throw new DomainError("VALIDATION_ERROR", "资金待办查询参数无效", 400);
  }
  const cursor = decodeCursor(query.cursor);
  const term = query.query?.trim();
  const pattern = term ? `%${term.replace(/[\\%_]/g, "\\$&")}%` : null;
  type Row = { id: string; kind: WorkbenchFundsExceptionItem["kind"]; order_id: string | null; bill_id: string | null;
    reference: string | null; customer_label: string | null; room_label: string | null; amount_minor: string | null;
    occurred_at: string; reason: string };
  // One statement provides the page and complete filtered count from the same snapshot.
  // Cursor carries the exact DB timestamp: it survives resolution/removal of its row.
  const result = (await sql<{ items: Row[]; total: string; invalid_money: boolean }>`
    WITH ordinary_orders AS (
      SELECT o.id, o.created_at, o.status, p.current_contract_amount_minor,
        coalesce((SELECT sum(f.net_effect_minor) FROM collection_facts f WHERE f.order_id=o.id),0) net_minor,
        coalesce((SELECT sum(l.amount_minor-coalesce((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0))
          FROM retained_funds l WHERE l.source_order_id=o.id AND l.property_id=o.property_id),0) retained_minor,
        coalesce(guest.label, nullif(concat_ws(' ',o.primary_guest_snapshot->>'nickname',o.primary_guest_snapshot->>'fullName'),'')) customer_label,
        unit.label room_label
      FROM orders o LEFT JOIN pricing_revisions p ON p.id=o.current_revision_id
      LEFT JOIN LATERAL (
        SELECT CASE WHEN correction.id IS NOT NULL THEN
          nullif(concat_ws(' ',correction.corrected_nickname,correction.corrected_full_name),'')
          ELSE nullif(concat_ws(' ',occupant.nickname,occupant.full_name),'') END label
        FROM active_order_occupants occupant LEFT JOIN LATERAL (
          SELECT c.id,c.corrected_nickname,c.corrected_full_name FROM order_occupant_corrections c
          WHERE c.occupant_id=occupant.id ORDER BY c.sequence DESC LIMIT 1
        ) correction ON true WHERE occupant.order_id=o.id AND occupant.role='PRIMARY' LIMIT 1
      ) guest ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN u.active AND o.status IN ('RESERVED','CHECKED_IN') THEN
          coalesce(catalog.snapshot->'unitCodes'->>u.id,u.code) ELSE u.code END label
        FROM stays s JOIN stay_segments segment ON segment.stay_id=s.id
        JOIN inventory_units u ON u.id=segment.inventory_unit_id
        LEFT JOIN room_catalog_state catalog ON catalog.property_id=o.property_id
        WHERE s.order_id=o.id ORDER BY segment.sequence DESC LIMIT 1
      ) unit ON true
      WHERE o.property_id=${query.propertyId} AND o.stay_type<>'FREE'
        AND (o.booking_channel_code IS NULL OR o.booking_channel_code='WECOM')
        AND o.member_contract_id IS NULL
        AND (p.pricing_basis IS NULL OR p.pricing_basis NOT IN ('CHANNEL_CONTRACT','MEMBER_ENTITLEMENT'))
        AND NOT EXISTS(SELECT 1 FROM amendments a WHERE a.order_id=o.id AND a.amendment_type='CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP')
    ), bills AS (
      SELECT b.*, s.matching_since, c.nickname,
        coalesce((SELECT sum(a.amount_minor) FROM external_payment_allocations a WHERE a.bill_id=b.id
          AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases release WHERE release.allocation_id=a.id)),0) allocated_minor
      FROM external_payment_bills b JOIN external_payment_sources s ON s.id=b.source_id
      LEFT JOIN external_payment_contacts c ON c.source_id=b.source_id AND c.external_user_id=b.external_user_id
      WHERE b.property_id=${query.propertyId}
        AND NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=b.id AND m.membership_payment_fact_id IS NOT NULL)
    ), pending_refunds AS (
      SELECT r.* FROM bills r WHERE r.kind='REFUND' AND r.state='SUCCESS'
        AND (r.amount_minor IS NULL OR r.needs_review OR r.amount_minor>r.allocated_minor)
        AND NOT EXISTS(SELECT 1 FROM external_payment_bills parent JOIN external_payment_matches m ON m.bill_id=parent.id
          WHERE parent.property_id=r.property_id AND parent.source_id=r.source_id AND parent.merchant_id=r.merchant_id
            AND parent.reference=r.transaction_id AND m.membership_payment_fact_id IS NOT NULL)
        AND (r.occurred_at>=r.matching_since OR EXISTS(
          SELECT 1 FROM external_payment_bills parent JOIN external_payment_allocations a ON a.bill_id=parent.id
          JOIN collection_facts f ON f.fact_id=a.collection_fact_id JOIN ordinary_orders o ON o.id=f.order_id
          WHERE parent.property_id=r.property_id AND parent.source_id=r.source_id AND parent.merchant_id=r.merchant_id AND parent.reference=r.transaction_id))
    ), frozen_bills AS (
      SELECT DISTINCT parent.id FROM bills parent JOIN pending_refunds r
        ON r.property_id=parent.property_id AND r.source_id=parent.source_id AND r.merchant_id=parent.merchant_id AND r.transaction_id=parent.reference
      WHERE parent.kind='COLLECTION'
    ), unfrozen_order_sources AS (
      -- The original write guard freezes a receipt, not all cash on its order.
      -- This is the same remaining/reserved arithmetic as fundingSource.
      SELECT f.order_id, sum(greatest(f.amount_minor
        - coalesce((SELECT sum(r.amount_minor) FROM collection_facts r WHERE r.references_fact_id=f.fact_id AND r.fact_type='REFUND'
          AND NOT EXISTS(SELECT 1 FROM collection_facts v WHERE v.reverses_fact_id=r.fact_id)),0)
        - coalesce((SELECT sum(r.amount_minor) FROM collection_facts r WHERE r.references_fact_id=f.fact_id AND r.fact_type='REALLOCATION_OUT'),0)
        - coalesce((SELECT sum(l.amount_minor-coalesce((SELECT sum(e.amount_minor) FROM retained_fund_entries e WHERE e.retained_fund_id=l.id),0))
          FROM retained_funds l WHERE l.source_fact_id=f.fact_id),0),0)) available_minor
      FROM collection_facts f JOIN ordinary_orders o ON o.id=f.order_id
      LEFT JOIN external_payment_allocations allocation ON allocation.collection_fact_id=f.fact_id
      WHERE f.fact_type IN ('COLLECTION','REALLOCATION_IN')
        AND NOT EXISTS(SELECT 1 FROM collection_facts reversal WHERE reversal.reverses_fact_id=f.fact_id)
        AND NOT EXISTS(SELECT 1 FROM frozen_bills frozen WHERE frozen.id=coalesce(f.external_payment_bill_id,allocation.bill_id))
      GROUP BY f.order_id
    ), candidates AS (
      SELECT 'order:'||o.id id,'ORDER_EXCESS' kind,o.id order_id,NULL::text bill_id,NULL::text reference,o.customer_label,o.room_label,
        least(o.net_minor-o.current_contract_amount_minor-o.retained_minor,source.available_minor)::text amount_minor,o.created_at occurred_at,
        CASE WHEN EXISTS(SELECT 1 FROM collection_facts f LEFT JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id
          JOIN frozen_bills frozen ON frozen.id=coalesce(f.external_payment_bill_id,a.bill_id) WHERE f.order_id=o.id
          AND f.fact_type IN ('COLLECTION','REALLOCATION_IN')
          AND NOT EXISTS(SELECT 1 FROM collection_facts reversal WHERE reversal.reverses_fact_id=f.fact_id)) THEN
          '本行仅为未冻结来源待处理余款；其他来源有成功退款待核对，请先核对冻结款，不把账面金额当新增现金'
          WHEN o.status IN ('CHECKED_OUT','CANCELLED','NO_SHOW') THEN '多余款待处理：核对实际退款或客户留存；终态订单暂不支持在线改价'
          ELSE '多余款待核对：核对实际收退款或真实金额错误，不为清空异常改低房费' END reason
      FROM ordinary_orders o JOIN unfrozen_order_sources source ON source.order_id=o.id
      WHERE o.net_minor>o.current_contract_amount_minor+o.retained_minor AND source.available_minor>0
      UNION ALL
      SELECT 'collection:'||b.id,'UNALLOCATED_COLLECTION',NULL,b.id,b.reference,b.nickname,NULL,
        (b.amount_minor-b.allocated_minor)::text,b.occurred_at,'收款尚未匹配住宿订单，请核实款项归属后选单分配'
      FROM bills b WHERE b.kind='COLLECTION' AND b.state='SUCCESS' AND b.amount_minor IS NOT NULL AND NOT b.needs_review
        AND b.amount_minor>b.allocated_minor AND b.occurred_at>=b.matching_since
        AND NOT EXISTS(SELECT 1 FROM frozen_bills frozen WHERE frozen.id=b.id)
        AND NOT EXISTS(SELECT 1 FROM external_payment_bills duplicate WHERE duplicate.property_id=b.property_id
          AND duplicate.kind=b.kind AND duplicate.reference=b.reference AND duplicate.id<>b.id)
      UNION ALL
      SELECT 'refund:'||r.id,'UNASSIGNED_REFUND',associated.order_id,r.id,r.reference,r.nickname,NULL,
        CASE WHEN r.amount_minor IS NULL OR r.needs_review THEN NULL ELSE (r.amount_minor-r.allocated_minor)::text END,r.occurred_at,
        '成功退款尚未完成归属核对；关联收款已冻结，先核对退款，再处理订单余款。原收款：'||coalesce(r.transaction_id,'待核对')
      FROM pending_refunds r LEFT JOIN LATERAL (
        SELECT CASE WHEN count(DISTINCT f.order_id)=1 THEN min(f.order_id) ELSE NULL END order_id
        FROM external_payment_bills parent JOIN external_payment_allocations a ON a.bill_id=parent.id
          JOIN collection_facts f ON f.fact_id=a.collection_fact_id JOIN ordinary_orders o ON o.id=f.order_id
        WHERE parent.property_id=r.property_id AND parent.source_id=r.source_id AND parent.merchant_id=r.merchant_id AND parent.reference=r.transaction_id
          AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases release WHERE release.allocation_id=a.id)
      ) associated ON true
    ), filtered AS (
      SELECT * FROM candidates WHERE (${pattern}::text IS NULL OR
        concat_ws(' ',id,order_id,bill_id,reference,customer_label,room_label,reason) ILIKE ${pattern} ESCAPE '\\')
    ), page AS (
      SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at FROM filtered
      WHERE (${cursor?.at ?? null}::timestamptz IS NULL OR (occurred_at,id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::text))
      ORDER BY occurred_at DESC,id DESC LIMIT ${limit+1}
    ) SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'order_id',order_id,'bill_id',bill_id,'reference',reference,
        'customer_label',customer_label,'room_label',room_label,'amount_minor',amount_minor,'occurred_at',cursor_at,'reason',reason)
        ORDER BY occurred_at DESC,id DESC) FROM page),'[]'::jsonb) items,
      (SELECT count(*)::text FROM filtered) total,
      EXISTS(SELECT 1 FROM ordinary_orders WHERE net_minor<0 OR retained_minor<0 OR
        (current_contract_amount_minor IS NULL AND net_minor<>0) OR retained_minor>greatest(net_minor-current_contract_amount_minor,0))
      OR EXISTS(SELECT 1 FROM bills WHERE amount_minor IS NOT NULL AND allocated_minor>amount_minor) invalid_money
  `.execute(db)).rows[0]!;
  if (result.invalid_money) throw new DomainError("INTERNAL_ERROR", "资金来源或余额不一致，请核对原订单与流水", 500);
  const rows = result.items.slice(0,limit);
  const last = rows.at(-1);
  const total = checkedMinor(result.total)!;
  return {
    enabled: paymentAllocationEnabled(),
    items: rows.map(row => ({id:row.id,kind:row.kind,orderId:row.order_id,billId:row.bill_id,reference:row.reference,
      customerLabel:row.customer_label,roomLabel:row.room_label,amountMinor:checkedMinor(row.amount_minor),occurredAt:row.occurred_at,reason:row.reason})),
    total,
    nextCursor: result.items.length>limit && last ? Buffer.from(JSON.stringify({at:last.occurred_at,id:last.id} satisfies Cursor)).toString("base64url") : null
  };
}
