import { sql } from "kysely";
import { DomainError, memberFacingLabel, type MemberCenterView } from "@qintopia/contracts";
import { parseLocalDate, sha256 } from "@qintopia/domain";
import type { DbExecutor } from "./inventory.ts";
import { memberDirectoryEntitlements } from "./members.ts";
import { readRoomCatalog } from "./room-catalog.ts";
import type { Database } from "./schema.ts";

export const expiryLeadDays = [60, 30] as const;

export function shiftMemberDate(localDate: string, days: number) {
  const date = parseLocalDate(localDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const actions: Record<Database["entitlement_ledger"]["entry_type"], string> = {
  HOLD: "预订预留", CONSUME: "入住核销", CONVERSION_CONSUME: "住宿转会员核销", RELEASE: "预留释放",
  RESTORE: "权益返还", ADJUST: "权益更正", EXPIRE: "权益到期", VOID: "权益作废"
};

const invalidCursor = () => new DomainError("VALIDATION_ERROR", "明细页码已失效，请重新读取我的权益。", 400);

export async function memberCenterView(db: DbExecutor, propertyId: string, memberId: string, cursor?: string): Promise<MemberCenterView> {
  const summary = await memberDirectoryEntitlements(db, propertyId, [memberId]);
  const entries = summary.byMember.get(memberId) ?? [];
  if (!entries.length) {
    if (cursor) throw invalidCursor();
    return { asOf: summary.asOfDate, cards: [], history: [], next: null };
  }
  const orders = await db.selectFrom("membership_orders as o").leftJoin("member_contracts as c", "c.id", "o.contract_id")
    .select(["o.id", "o.allowed_room_type_code", "o.allowed_room_type_codes", "c.valid_from", "o.entitlement_lot_id"])
    .select(sql<number>`(select count(*)::integer from coverage_items x where x.lot_id=o.entitlement_lot_id and x.status='HELD')`.as("held"))
    .where("o.property_id", "=", propertyId).where("o.member_id", "=", memberId).execute();
  const catalog = await readRoomCatalog(db, propertyId);
  const names = new Map(catalog.types.map(room => [room.code, room.name]));
  const snapshots = new Map(orders.map(order => [order.id, order]));
  const cards = entries.map(entry => {
    const order = snapshots.get(entry.orderId)!;
    return { product: memberFacingLabel(entry.productName), unit: entry.unitKind, status: entry.status, available: entry.availableUnits,
      held: order.held, startsOn: order.valid_from, expiresOn: entry.expiresOn,
      rooms: (order.allowed_room_type_codes ?? [order.allowed_room_type_code]).map(code => memberFacingLabel(names.get(code) ?? code, "适用房型")),
      reminderDates: entry.status === "ACTIVE" && entry.expiresOn ? expiryLeadDays.map(days => shiftMemberDate(entry.expiresOn!, -days))
        .filter(date => !order.valid_from || date >= order.valid_from) : [] };
  });
  let historyQuery = db.selectFrom("entitlement_ledger as e").innerJoin("membership_orders as o", "o.entitlement_lot_id", "e.lot_id")
    .innerJoin("properties as p", "p.id", "o.property_id")
    .where("o.property_id", "=", propertyId).where("o.member_id", "=", memberId)
    .select(sql<string>`(e.created_at at time zone p.timezone)::date::text`.as("recorded_on"))
    .select(["e.fact_id", "e.entry_type", "e.quantity_delta", "e.service_date", "o.product_name", "o.entitlement_unit_kind"]);
  if (cursor) {
    if (!/^[a-f0-9]{64}$/.test(cursor)) throw invalidCursor();
    // Scope the cursor to this member and preserve PostgreSQL microsecond ordering.
    const boundary = await historyQuery.clearSelect().select("e.fact_id")
      .select(sql<string>`e.created_at::text`.as("recorded_at"))
      .where(sql<boolean>`encode(sha256(convert_to(e.fact_id, 'UTF8')), 'hex') = ${cursor}`).executeTakeFirst();
    if (!boundary) throw invalidCursor();
    historyQuery = historyQuery.where(sql<boolean>`(e.created_at,e.fact_id) < (${boundary.recorded_at}::timestamptz,${boundary.fact_id})`);
  }
  const rows = await historyQuery.orderBy("e.created_at", "desc").orderBy("e.fact_id", "desc").limit(26).execute();
  const page = rows.slice(0, 25);
  const last = page.at(-1);
  return { asOf: summary.asOfDate, cards, history: page.map(fact => ({
    product: memberFacingLabel(fact.product_name), unit: fact.entitlement_unit_kind, action: actions[fact.entry_type],
    quantity: fact.entry_type === "CONSUME" ? 1 : fact.entry_type === "ADJUST" ? fact.quantity_delta : Math.abs(fact.quantity_delta),
    serviceDate: fact.service_date, recordedOn: fact.recorded_on
  })), next: rows.length > page.length && last ? sha256(last.fact_id) : null };
}
