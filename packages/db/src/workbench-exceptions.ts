import { sql, type Kysely } from 'kysely';
import { DomainError, type WorkbenchExceptionsQuery, type WorkbenchExceptionsResponse, type WorkbenchExceptionItem } from '@qintopia/contracts';
import type { Database } from './schema.ts';
import { propertyLocalClockAt } from './members.ts';
import { workbenchExceptionReasons, type WorkbenchExceptionEvidence } from './workbench-exception-rules.ts';

interface EvidenceRow extends WorkbenchExceptionEvidence {
  orderId: string;
  guestName: string;
  unitLabel: string | null;
}

/** One property-wide snapshot; no business mutations or per-order lifecycle projections. */
export async function getWorkbenchExceptions(db: Kysely<Database>, query: WorkbenchExceptionsQuery): Promise<WorkbenchExceptionsResponse> {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('VALIDATION_ERROR', '每页数量必须在 1 至 100 之间', 400);
  return db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const property = await trx.selectFrom('properties').select(['timezone', sql<Date>`transaction_timestamp()`.as('asOf')])
      .where('id', '=', query.propertyId).executeTakeFirst();
    if (!property) throw new DomainError('NOT_FOUND', 'Property not found', 404);
    const asOf = new Date(property.asOf).toISOString();
    const businessDate = propertyLocalClockAt(property.timezone, new Date(property.asOf)).date;
    // Aggregate independent fact families before joining, so multiple claims, refunds,
    // retained lots or amendments cannot multiply the financial sums.
    const rows = (await sql<EvidenceRow>`
      WITH scoped AS (SELECT * FROM orders WHERE property_id=${query.propertyId}),
      facts AS (SELECT f.* FROM collection_facts f JOIN scoped o ON o.id=f.order_id),
      fact_totals AS (
        SELECT f.order_id, SUM(f.net_effect_minor)::text net,
          bool_or(f.currency<>p.currency) currency_mismatch
        FROM facts f LEFT JOIN scoped o ON o.id=f.order_id LEFT JOIN pricing_revisions p ON p.id=o.current_revision_id GROUP BY f.order_id
      ),
      lot_balances AS (
        SELECT l.id,l.source_order_id,l.source_fact_id,l.property_id,l.amount_minor,
          l.amount_minor-COALESCE(SUM(e.amount_minor),0) remaining
        FROM retained_funds l JOIN scoped o ON o.id=l.source_order_id
        LEFT JOIN retained_fund_entries e ON e.retained_fund_id=l.id
        GROUP BY l.id
      ),
      source_reserved AS (SELECT source_fact_id,SUM(remaining) reserved FROM lot_balances GROUP BY source_fact_id),
      source_deductions AS (
        SELECT f.references_fact_id,
          COALESCE(SUM(f.amount_minor) FILTER (WHERE f.fact_type='REFUND' AND NOT EXISTS(SELECT 1 FROM facts r WHERE r.reverses_fact_id=f.fact_id)),0) refunded,
          COALESCE(SUM(f.amount_minor) FILTER (WHERE f.fact_type='REALLOCATION_OUT'),0) transferred
        FROM facts f WHERE f.references_fact_id IS NOT NULL GROUP BY f.references_fact_id
      ),
      source_balances AS (
        SELECT f.fact_id,f.order_id,
          CASE WHEN EXISTS(SELECT 1 FROM facts r WHERE r.reverses_fact_id=f.fact_id) THEN 0
            ELSE f.amount_minor-COALESCE(d.refunded,0)-COALESCE(d.transferred,0) END available,
          COALESCE(r.reserved,0) reserved
        FROM facts f LEFT JOIN source_deductions d ON d.references_fact_id=f.fact_id
        LEFT JOIN source_reserved r ON r.source_fact_id=f.fact_id WHERE f.fact_type IN ('COLLECTION','REALLOCATION_IN')
      ),
      source_issues AS (
        SELECT order_id,bool_or(available<0 OR reserved<0 OR reserved>available) invalid FROM source_balances GROUP BY order_id
      ),
      retained_totals AS (
        SELECT l.source_order_id,SUM(l.remaining)::text remaining,
          bool_or(l.remaining<0 OR l.remaining>l.amount_minor OR f.fact_id IS NULL OR f.order_id<>l.source_order_id
            OR f.fact_type NOT IN ('COLLECTION','REALLOCATION_IN') OR l.property_id<>${query.propertyId}) invalid
        FROM lot_balances l LEFT JOIN facts f ON f.fact_id=l.source_fact_id GROUP BY l.source_order_id
      ),
      claim_totals AS (
        SELECT s.order_id,COUNT(*)::int count FROM inventory_claims c
        JOIN stay_segments seg ON seg.id=c.source_id JOIN stays s ON s.id=seg.stay_id JOIN scoped o ON o.id=s.order_id
        WHERE c.source_type='ORDER_SEGMENT' AND c.active GROUP BY s.order_id
      ),
      coverage_totals AS (
        SELECT c.order_id,COUNT(*)::int count FROM coverage_items c JOIN scoped o ON o.id=c.order_id WHERE c.status='HELD' GROUP BY c.order_id
      ),
      channel_totals AS (
        SELECT f.order_id,COUNT(*)::int count,SUM(f.amount_minor) net,bool_or(f.kind='SALE') has_sale,
          bool_or(f.currency<>p.currency OR f.property_id<>${query.propertyId}) invalid
        FROM channel_operating_facts f JOIN scoped o ON o.id=f.order_id
        LEFT JOIN pricing_revisions p ON p.id=o.current_revision_id GROUP BY f.order_id
      ),
      opening_totals AS (
        SELECT x.source_id,SUM(x.amount_minor) amount FROM operating_sales_opening x JOIN scoped o ON o.id=x.source_id
        WHERE x.property_id=${query.propertyId} AND x.source_kind='CHANNEL_REFUND' GROUP BY x.source_id
      ),
      amendment_totals AS (SELECT a.order_id,COUNT(*)::int count FROM amendments a JOIN scoped o ON o.id=a.order_id GROUP BY a.order_id)
      SELECT o.id "orderId",o.status "orderStatus",s.status "stayStatus",o.arrival_date::text "arrivalDate",o.departure_date::text "departureDate",
        o.stay_type "stayType",o.booking_channel_code "bookingChannelCode",p.currency,
        p.current_contract_amount_minor::text "contractMinor",COALESCE(f.net,'0') "netMinor",COALESCE(r.remaining,'0') "retainedMinor",
        (COALESCE(f.currency_mismatch,false) OR COALESCE(r.invalid,false) OR COALESCE(si.invalid,false) OR p.order_id IS DISTINCT FROM o.id) "fundsInconsistent",
        (s.id IS NULL OR COALESCE(a.count,0)<>o.version OR COALESCE(last_event.status,'RESERVED')<>o.status) "lifecycleInconsistent",
        COALESCE(cl.count,0) "activeClaims",COALESCE(cv.count,0) "heldCoverage",
        EXISTS(SELECT 1 FROM operating_sales_baselines b WHERE b.property_id=${query.propertyId}) "channelInitialized",
        COALESCE(ch.count,0) "channelFactCount",COALESCE(ch.has_sale,false) "channelHasSale",
        (COALESCE(ch.net,0)-COALESCE(op.amount,0))::text "channelNetMinor",COALESCE(ch.invalid,false) "channelInconsistent",
        COALESCE(NULLIF(CASE WHEN correction.id IS NOT NULL THEN correction.corrected_nickname ELSE guest.nickname END,''),
          NULLIF(CASE WHEN correction.id IS NOT NULL THEN correction.corrected_full_name ELSE guest.full_name END,''),
          NULLIF(o.primary_guest_snapshot->>'nickname',''),NULLIF(o.primary_guest_snapshot->>'fullName',''),'未登记姓名') "guestName",
        CASE WHEN unit.active AND o.status IN ('RESERVED','CHECKED_IN') THEN COALESCE(catalog.snapshot->'unitCodes'->>unit.id,unit.code) ELSE unit.code END "unitLabel"
      FROM scoped o LEFT JOIN stays s ON s.order_id=o.id LEFT JOIN pricing_revisions p ON p.id=o.current_revision_id
      LEFT JOIN fact_totals f ON f.order_id=o.id LEFT JOIN retained_totals r ON r.source_order_id=o.id LEFT JOIN source_issues si ON si.order_id=o.id
      LEFT JOIN claim_totals cl ON cl.order_id=o.id LEFT JOIN coverage_totals cv ON cv.order_id=o.id LEFT JOIN channel_totals ch ON ch.order_id=o.id
      LEFT JOIN opening_totals op ON op.source_id=o.id LEFT JOIN amendment_totals a ON a.order_id=o.id
      LEFT JOIN LATERAL (SELECT CASE amendment_type WHEN 'CHECK_IN' THEN 'CHECKED_IN' WHEN 'CHECK_OUT' THEN 'CHECKED_OUT'
        WHEN 'REVOKE_CHECK_OUT' THEN 'CHECKED_IN' WHEN 'CANCEL_ORDER' THEN 'CANCELLED' WHEN 'MARK_NO_SHOW' THEN 'NO_SHOW'
        WHEN 'REVOKE_CHECK_IN' THEN 'CHECK_IN_REVOKED' END status FROM amendments WHERE order_id=o.id
        AND amendment_type IN ('CHECK_IN','CHECK_OUT','REVOKE_CHECK_OUT','CANCEL_ORDER','MARK_NO_SHOW','REVOKE_CHECK_IN') ORDER BY sequence DESC LIMIT 1) last_event ON true
      LEFT JOIN LATERAL (SELECT * FROM active_order_occupants WHERE order_id=o.id AND role='PRIMARY' ORDER BY ordinal,id LIMIT 1) guest ON true
      LEFT JOIN LATERAL (SELECT * FROM order_occupant_corrections WHERE occupant_id=guest.id ORDER BY sequence DESC LIMIT 1) correction ON true
      LEFT JOIN LATERAL (SELECT inventory_unit_id FROM stay_segments WHERE stay_id=s.id ORDER BY sequence DESC LIMIT 1) seg ON true
      LEFT JOIN LATERAL (SELECT c.inventory_unit_id FROM inventory_claims c JOIN stay_segments ss ON ss.id=c.source_id
        WHERE c.source_type='ORDER_SEGMENT' AND c.active AND ss.stay_id=s.id
        AND c.service_date=least(greatest(${businessDate}::date,o.arrival_date),o.departure_date-1) ORDER BY c.id LIMIT 1) position ON true
      LEFT JOIN inventory_units unit ON unit.id=COALESCE(position.inventory_unit_id,seg.inventory_unit_id)
      LEFT JOIN room_catalog_state catalog ON catalog.property_id=o.property_id ORDER BY o.id COLLATE "C"
    `.execute(trx)).rows;
    const all: WorkbenchExceptionItem[] = [];
    for (const row of rows) {
      const reasons = workbenchExceptionReasons(row, businessDate);
      if (reasons.length) all.push({ orderId: row.orderId, orderStatus: row.orderStatus, stayStatus: row.stayStatus,
        guestName: row.guestName, arrivalDate: row.arrivalDate, departureDate: row.departureDate,
        unitLabel: row.unitLabel, orderHref: `/orders/${encodeURIComponent(row.orderId)}`, reasons });
    }
    const candidates = query.afterId ? all.filter(item => item.orderId > query.afterId!) : all;
    const items = candidates.slice(0, limit);
    return { propertyId: query.propertyId, businessDate, asOf, totalOrders: all.length, items,
      nextCursor: candidates.length > limit ? items.at(-1)!.orderId : null };
  });
}
