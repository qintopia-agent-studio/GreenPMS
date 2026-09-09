import { sql, type Kysely } from "kysely";
import { DomainError } from "@qintopia/contracts";
import type { Database } from "./schema.ts";
import { loadCurrentPrimaryGuests } from "./current-order-guests.ts";
import { propertyLocalToday } from "./members.ts";

export interface OrderListQuery {
  propertyId: string;
  status?: string;
  query?: string;
  workDate?: string;
  funds?: "BALANCE_DUE" | "OVERPAID";
  reconversionMemberId?: string;
  beforeId?: string;
  orderIds?: string[];
  pageSize?: number;
}

/** Read-only candidates; Preview and Confirm still revalidate all business eligibility. */
export async function listOrders(db: Kysely<Database>, query: OrderListQuery) {
  if (query.pageSize !== undefined && (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100)) {
    throw new DomainError("VALIDATION_ERROR", "每页数量必须在 1 至 100 之间", 400);
  }
  if (query.workDate && (query.beforeId || query.pageSize || query.reconversionMemberId || query.status || query.query || query.orderIds || query.funds)) {
    throw new DomainError("VALIDATION_ERROR", "今日工作查询不能与历史列表筛选或分页混用", 400);
  }
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const businessDate = await propertyLocalToday(trx, query.propertyId);
    let selection = trx.selectFrom("orders")
      .leftJoin("pricing_revisions as current_revision", "current_revision.id", "orders.current_revision_id")
      .leftJoin("stays", "stays.order_id", "orders.id")
      .leftJoinLateral(
        (qb) => qb.selectFrom("stay_segments")
          .select(["stay_id", "inventory_unit_id"])
          .whereRef("stay_id", "=", "stays.id")
          .orderBy("sequence", "desc")
          .limit(1)
          .as("current_segment"),
        (join) => join.onTrue()
      )
      .leftJoinLateral((qb) => qb.selectFrom("stay_segments as position_segment")
        .innerJoin("inventory_claims as position_claim", "position_claim.source_id", "position_segment.id")
        .select("position_claim.inventory_unit_id")
        .whereRef("position_segment.stay_id", "=", "stays.id")
        .where("position_claim.source_type", "=", "ORDER_SEGMENT")
        .where("position_claim.active", "=", true)
        .where(sql<boolean>`position_claim.service_date = least(greatest(${businessDate}::date, orders.arrival_date), orders.departure_date - 1)`)
        .orderBy("position_claim.id").limit(1).as("position"), (join) => join.onTrue())
      .leftJoin("inventory_units as current_unit", (join) => join.on("current_unit.id", "=", sql<string>`coalesce(position.inventory_unit_id, current_segment.inventory_unit_id)`))
      .selectAll("orders")
      .select([
        "stays.status as stay_status",
        "current_revision.current_contract_amount_minor as current_contract_amount_minor",
        "current_revision.currency as currency",
        "current_unit.name as current_unit_name",
        "current_unit.code as current_unit_code",
        "current_unit.room_type_code as current_unit_room_type_code"
      ])
      .where("orders.property_id", "=", query.propertyId);
    if (query.orderIds?.length) selection = selection.where("orders.id", "in", query.orderIds);
    if (query.status) selection = selection.where("orders.status", "=", query.status);
    if (query.workDate) {
      // Superset of the existing daily buckets: all current in-house stays,
      // arrivals on the browsing date, overdue planned arrivals, and terminal
      // exceptions whose stay spans the current business day. Historical checkout
      // and unrelated cancelled rows never enter the browser payload.
      selection = selection.where((eb) => eb.or([
        eb.and([eb("orders.status", "=", "CHECKED_IN"), eb("stays.status", "=", "IN_HOUSE")]),
        eb.and([eb("orders.status", "=", "RESERVED"), eb("stays.status", "=", "PLANNED"),
          eb.or([eb("orders.arrival_date", "=", query.workDate!), eb("orders.arrival_date", "<", businessDate)])]),
        eb.and([eb("orders.status", "in", ["CANCELLED", "NO_SHOW"]),
          eb("orders.arrival_date", "<=", businessDate), eb("orders.departure_date", ">=", businessDate)])
      ]));
    }
    if (query.funds) {
      // Same signed-fact arithmetic as orderAmountSummary; this is a review
      // filter, never authorization to collect or refund.
      selection = selection.where("orders.stay_type", "!=", "FREE")
        .where((eb) => eb.or([eb("orders.booking_channel_code", "is", null), eb("orders.booking_channel_code", "=", "WECOM")]))
        .where("current_revision.pricing_basis", "!=", "CHANNEL_CONTRACT");
      const net = sql<number>`(SELECT coalesce(sum(net_effect_minor), 0) FROM collection_facts WHERE order_id = orders.id)`;
      selection = query.funds === "BALANCE_DUE"
        ? selection.where("orders.status", "in", ["RESERVED", "CHECKED_IN", "CHECKED_OUT"])
          .where(sql<boolean>`current_revision.current_contract_amount_minor > ${net}`)
        : selection.where(sql<boolean>`current_revision.current_contract_amount_minor < ${net}`);
    }
    if (query.query?.trim()) {
      const pattern = `%${query.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      selection = selection.where(sql<boolean>`(
        orders.id ILIKE ${pattern} ESCAPE '\\'
        OR current_unit.code ILIKE ${pattern} ESCAPE '\\'
        OR current_unit.name ILIKE ${pattern} ESCAPE '\\'
        OR orders.channel_order_reference ILIKE ${pattern} ESCAPE '\\'
        OR (CASE WHEN orders.member_id IS NOT NULL OR orders.member_contract_id IS NOT NULL THEN '会员权益'
          WHEN orders.stay_type = 'FREE' THEN '免费住宿'
          WHEN orders.booking_channel_code = 'WECOM' THEN '企业微信'
          WHEN orders.booking_channel_code = 'YOUMUDAO' THEN '游牧岛'
          WHEN orders.booking_channel_code = 'CTRIP' THEN '携程'
          WHEN orders.booking_channel_code = 'MEITUAN' THEN '美团'
          ELSE '历史未记录' END) ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM active_order_occupants AS guest
          LEFT JOIN LATERAL (
            SELECT id, corrected_full_name, corrected_nickname, corrected_phone, corrected_document_number
            FROM order_occupant_corrections WHERE occupant_id = guest.id ORDER BY sequence DESC LIMIT 1
          ) AS correction ON true
          WHERE guest.order_id = orders.id AND guest.role = 'PRIMARY'
            AND (CASE WHEN correction.id IS NOT NULL THEN
              concat_ws(' ', correction.corrected_nickname, correction.corrected_full_name, correction.corrected_phone, correction.corrected_document_number)
              ELSE concat_ws(' ', guest.nickname, guest.full_name, guest.phone, guest.document_number)
              END) ILIKE ${pattern} ESCAPE '\\'
        )
        OR (NOT EXISTS (SELECT 1 FROM active_order_occupants WHERE order_id = orders.id AND role = 'PRIMARY')
          AND concat_ws(' ', orders.primary_guest_snapshot->>'nickname', orders.primary_guest_snapshot->>'fullName',
            orders.primary_guest_snapshot->>'phone', orders.primary_guest_snapshot->>'documentNumber') ILIKE ${pattern} ESCAPE '\\')
      )`);
    }
    if (query.reconversionMemberId) {
      const member = await trx.selectFrom("members")
        .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
        .select(["members.phone", "members.identity_card_number"])
        .where("members.id", "=", query.reconversionMemberId)
        .where("members.deleted_at", "is", null)
        .where("member_property_links.property_id", "=", query.propertyId)
        .executeTakeFirst();
      if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
      const phone = member.phone.replace(/\s+/g, "");
      const identity = member.identity_card_number?.trim().toUpperCase() ?? "";
      selection = selection
        .where("orders.status", "=", "CHECKED_OUT")
        .where("stays.status", "=", "COMPLETED")
        .where("orders.booking_channel_code", "=", "WECOM")
        .where("orders.member_id", "is", null)
        .where("orders.member_contract_id", "is", null)
        .where(sql<boolean>`EXISTS (
          SELECT 1 FROM active_order_occupants AS occupant
          LEFT JOIN LATERAL (
            SELECT id, corrected_phone, corrected_document_number
            FROM order_occupant_corrections
            WHERE occupant_id = occupant.id
            ORDER BY sequence DESC LIMIT 1
          ) AS correction ON true
          WHERE occupant.order_id = orders.id AND occupant.role = 'PRIMARY'
            AND ${phone} <> ''
            AND regexp_replace(CASE WHEN correction.id IS NOT NULL
              THEN correction.corrected_phone ELSE occupant.phone END, '[[:space:]]', '', 'g') = ${phone}
            AND (${identity} = '' OR coalesce(upper(btrim(CASE WHEN correction.id IS NOT NULL
              THEN correction.corrected_document_number ELSE occupant.document_number END)), '') IN ('', ${identity}))
        )`);
    }
    // Read one page plus a sentinel. Keep the database timestamp precision in
    // the cursor comparison; no offset scans or timestamp round-trips through JS.
    const pageSize = query.workDate ? undefined : query.pageSize ?? (query.reconversionMemberId ? 25 : 50);
    if (query.beforeId) selection = selection.where(sql<boolean>`(orders.created_at, orders.id) < (
      SELECT cursor_order.created_at, cursor_order.id FROM orders AS cursor_order
      WHERE cursor_order.id = ${query.beforeId} AND cursor_order.property_id = ${query.propertyId}
    )`);
    if (pageSize !== undefined) selection = selection.limit(pageSize + 1);
    const rows = await selection.orderBy("orders.created_at", "desc").orderBy("orders.id", "desc").execute();
    const orders = pageSize === undefined ? rows : rows.slice(0, pageSize);
    const currentGuests = await loadCurrentPrimaryGuests(trx, orders.map((order) => order.id));
    return {
      businessDate,
      ...(pageSize !== undefined ? { nextCursor: rows.length > pageSize ? orders.at(-1)!.id : null } : {}),
      orders: orders.map((order) => ({
        ...order,
        current_primary_guest: currentGuests.get(order.id) ?? order.primary_guest_snapshot
      }))
    };
  });
}
