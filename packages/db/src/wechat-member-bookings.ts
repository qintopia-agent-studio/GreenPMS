import { randomBytes } from "node:crypto";
import { sql, type Selectable, type Transaction } from "kysely";
import {
  DomainError,
  memberFacingLabel,
  renderNoticeFields,
  type BookingRoom,
  type MemberBooking
} from "@qintopia/contracts";
import { enumerateServiceDates, MAX_SERVICE_NIGHTS } from "@qintopia/domain";
import { type DbExecutor, listAvailability } from "./inventory.ts";
import { propertyLocalToday } from "./members.ts";
import { createQuoteInTransaction, resolveMemberCoverage } from "./pricing-service.ts";
import { readRoomCatalog, resolveCatalogPolicyId } from "./room-catalog.ts";
import { memberRuleVersion, recordMemberInteraction } from "./member-notifications.ts";
import type { Database } from "./schema.ts";

type Booking = Selectable<Database["wechat_member_bookings"]>;
export interface MemberBookingScope {
  appId: string;
  propertyId: string;
  memberId: string;
  bindingId: string;
}
interface StayRequest {
  arrival: string;
  departure: string;
  roomType: string;
  kind: "ROOM" | "BED";
  requestKey: string;
}
const insufficient = () => new DomainError("ENTITLEMENT_CONFLICT", "本次住宿的可用权益不足，请联系服务号客服。", 409);
const changed = () => new DomainError("AGGREGATE_VERSION_CONFLICT", "这条申请已处理，请刷新查看结果。", 409);
export function bookingView(b: Booking): MemberBooking {
  return {
    id: b.id,
    arrival: b.arrival_date,
    departure: b.departure_date,
    room: b.room_type_name,
    kind: b.inventory_kind,
    status: b.status,
    created: b.created_at.toISOString(),
    decided: b.decided_at?.toISOString() ?? null
  };
}
type BookingWithStay = Booking & {
  stay_status: string | null;
  stay_arrival: string | null;
  stay_departure: string | null;
};
export async function currentMemberBooking(db: DbExecutor, b: BookingWithStay, today: string): Promise<MemberBooking> {
  const view = bookingView(b);
  if (b.stay_status && b.stay_arrival && b.stay_departure)
    view.stay = { status: b.stay_status, arrival: b.stay_arrival, departure: b.stay_departure };
  if (b.status !== "PENDING") return view;
  if (b.arrival_date < today) return { ...view, attention: "原申请入住日已过，请联系服务号客服。" };
  try {
    await checkCoverage(
      db,
      b.property_id,
      b.member_id,
      { arrival: b.arrival_date, departure: b.departure_date, roomType: b.room_type_code, kind: b.inventory_kind },
      today
    );
  } catch (e) {
    if (e instanceof DomainError && e.code === "ENTITLEMENT_CONFLICT") return { ...view, attention: e.message };
    throw e;
  }
  return view;
}
export async function memberBookingRooms(db: DbExecutor, property: string, member: string): Promise<BookingRoom[]> {
  const products = await db
    .selectFrom("membership_orders")
    .select(["allowed_room_type_codes", "allowed_room_type_code", "allowed_inventory_kind"])
    .where("property_id", "=", property)
    .where("member_id", "=", member)
    .where("status", "=", "ACTIVE")
    .execute();
  const catalog = await readRoomCatalog(db, property);
  return catalog.types
    .filter(
      (t) =>
        t.active &&
        products.some(
          (p) =>
            p.allowed_inventory_kind === t.saleMode &&
            (p.allowed_room_type_codes ?? [p.allowed_room_type_code]).includes(t.code)
        )
    )
    .map((t) => ({ code: t.code, kind: t.saleMode, name: memberFacingLabel(t.name, "适用房型") }));
}
async function checkCoverage(
  db: DbExecutor,
  propertyId: string,
  memberId: string,
  input: Pick<StayRequest, "arrival" | "departure" | "roomType" | "kind">,
  today?: string
) {
  if (input.arrival < (today ?? (await propertyLocalToday(db, propertyId))))
    throw new DomainError("VALIDATION_ERROR", "请选择今天或以后的入住日期。");
  if (input.departure <= input.arrival) throw new DomainError("VALIDATION_ERROR", "离店日须晚于入住日。");
  let dates: string[];
  try {
    dates = enumerateServiceDates(input.arrival, input.departure);
  } catch (error) {
    if (error instanceof DomainError)
      throw new DomainError("VALIDATION_ERROR", "一次住宿可申请 1 至 " + MAX_SERVICE_NIGHTS + " 晚。");
    throw error;
  }

  const coverage = await resolveMemberCoverage(db, {
    propertyId,
    memberId,
    roomTypeCode: input.roomType,
    inventoryUnitKind: input.kind,
    dates
  }).catch((error) => {
    if (error instanceof DomainError && error.code === "ENTITLEMENT_CONFLICT")
      throw new DomainError("ENTITLEMENT_CONFLICT", "所选住宿的权益无法匹配，请联系服务号客服。", 409);
    throw error;
  });
  if (coverage.coverageCandidates.length !== dates.length) throw insufficient();
}
export async function submitMemberBooking(trx: Transaction<Database>, scope: MemberBookingScope, input: StayRequest) {
  const { appId, propertyId, memberId, bindingId } = scope;
  await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["wx-book", appId, propertyId, memberId])},0))`.execute(
    trx
  );
  const own = trx
    .selectFrom("wechat_member_bookings")
    .selectAll()
    .where("app_id", "=", appId)
    .where("property_id", "=", propertyId)
    .where("member_id", "=", memberId);
  const identity = { app_id: appId, property_id: propertyId, member_id: memberId, request_key: input.requestKey };
  const earlier = trx
    .selectFrom("wechat_member_booking_requests")
    .select("booking_id")
    .where((eb) => eb.and(identity));
  const replay = await own.where("id", "=", earlier).executeTakeFirst();
  const remember = (bookingId: string) =>
    trx
      .insertInto("wechat_member_booking_requests")
      .values({ ...identity, booking_id: bookingId })
      .execute();
  if (replay) {
    if (
      replay.arrival_date !== input.arrival ||
      replay.departure_date !== input.departure ||
      replay.room_type_code !== input.roomType ||
      replay.inventory_kind !== input.kind
    )
      throw changed();
    return bookingView(replay);
  }
  const matching = own
    .where("arrival_date", "=", input.arrival)
    .where("departure_date", "=", input.departure)
    .where("room_type_code", "=", input.roomType)
    .where("inventory_kind", "=", input.kind)
    .where("status", "=", "PENDING");
  const current = await matching.executeTakeFirst();
  if (current) {
    await remember(current.id);
    return bookingView(current);
  }
  const room = (await memberBookingRooms(trx, propertyId, memberId)).find(
    (r) => r.code === input.roomType && r.kind === input.kind
  );
  if (!room) throw insufficient();
  await checkCoverage(trx, propertyId, memberId, input);
  const booking = await trx
    .insertInto("wechat_member_bookings")
    .values({
      id: "Q" + randomBytes(9).toString("hex").toUpperCase(),
      app_id: appId,
      property_id: propertyId,
      member_id: memberId,
      binding_id: bindingId,
      arrival_date: input.arrival,
      departure_date: input.departure,
      room_type_code: room.code,
      room_type_name: room.name,
      inventory_kind: room.kind
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await remember(booking.id);
  await recordMemberInteraction(trx, {
    event_key: "request:" + booking.id,
    app_id: appId,
    property_id: propertyId,
    member_id: memberId,
    binding_id: bindingId,
    booking_id: booking.id,
    kind: "提交住宿预订",
    state: "RECORDED",
    detail: "会员已提交，等待门店排房",
    content: JSON.stringify({ 入住日: input.arrival, 离店日: input.departure, 房型: room.name })
  });
  return bookingView(booking);
}

export async function pendingMemberBooking(trx: Transaction<Database>, property: string, id: string) {
  const b = await trx
    .selectFrom("wechat_member_bookings")
    .selectAll()
    .where("property_id", "=", property)
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!b) throw new DomainError("NOT_FOUND", "找不到本店的预订申请。", 404);
  if (b.status !== "PENDING") throw changed();
  return b;
}
export async function bookingUnitOptions(db: DbExecutor, b: Booking) {
  const rooms = await listAvailability(db, b.property_id, b.arrival_date, b.departure_date, b.inventory_kind);
  return rooms
    .filter((room) => room.available && room.roomTypeCode === b.room_type_code)
    .map((room) => ({ id: room.id, name: room.code }));
}
export async function prepareBookingQuote(
  trx: Transaction<Database>,
  property: string,
  id: string,
  unitId: string,
  subject: string
) {
  const b = await pendingMemberBooking(trx, property, id);
  await checkCoverage(trx, property, b.member_id, {
    arrival: b.arrival_date,
    departure: b.departure_date,
    roomType: b.room_type_code,
    kind: b.inventory_kind
  });
  if (!(await bookingUnitOptions(trx, b)).some((r) => r.id === unitId))
    throw new DomainError("INVENTORY_CONFLICT", "所选房间或床位已不可用，请重新排房。", 409);
  const head = await resolveCatalogPolicyId(trx, property, b.arrival_date);
  const policy =
    head ??
    (
      await trx
        .selectFrom("pricing_policy_versions")
        .select("id")
        .where("property_id", "=", property)
        .where("status", "=", "PUBLISHED")
        .where("calculation_kind", "=", "DURATION_BAND_TOTAL")
        .where("effective_from", "<=", b.arrival_date)
        .where((eb) => eb.or([eb("effective_until", "is", null), eb("effective_until", ">", b.arrival_date)]))
        .orderBy("effective_from", "desc")
        .orderBy("version", "desc")
        .executeTakeFirst()
    )?.id;
  if (!policy) throw new DomainError("PRICING_POLICY_UNCONFIGURED", "本店尚无适用的住宿价格版本。", 409);
  const q = await createQuoteInTransaction(
    trx,
    {
      propertyId: property,
      inventoryUnitId: unitId,
      arrivalDate: b.arrival_date,
      departureDate: b.departure_date,
      pricingPolicyVersionId: policy,
      memberId: b.member_id,
      requesterSubjectId: subject
    },
    b.id
  );
  if (
    q.coverageSet.length !== enumerateServiceDates(b.arrival_date, b.departure_date).length ||
    q.cashLines.length ||
    q.currentContractAmount.minorUnits ||
    q.cashRemainder.minorUnits
  )
    throw insufficient();
  const member = await trx
    .selectFrom("members")
    .select(["full_name as fullName", "nickname", "phone"])
    .where("id", "=", b.member_id)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return { quoteId: q.quoteId, primaryGuest: member };
}
export async function decideMemberBooking(
  trx: Transaction<Database>,
  b: Booking,
  subject: string,
  orderId: string | null
) {
  const status = orderId ? "CONFIRMED" : "DECLINED";
  await trx
    .updateTable("wechat_member_bookings")
    .set({ status, order_id: orderId, decided_at: sql`clock_timestamp()`, decided_by: subject })
    .where("id", "=", b.id)
    .where("status", "=", "PENDING")
    .returning("id")
    .executeTakeFirstOrThrow();
  const { rules } = await memberRuleVersion(trx, b.property_id);
  const binding = await trx
    .selectFrom("wechat_member_bindings")
    .select(["booking_template", "revoked_at"])
    .where("id", "=", b.binding_id)
    .executeTakeFirst();
  const tpl = rules.booking;
  const detail = !rules.bookingEnabled
    ? "管理员已暂停预订通知"
    : !tpl
      ? "预订结果模板未配置"
      : binding?.revoked_at || !binding
        ? "原微信已解绑"
        : binding.booking_template !== tpl.template
          ? "会员尚未授权当前预订模板"
          : null;
  const values = {
    room: b.room_type_name,
    arrival: b.arrival_date,
    departure: b.departure_date,
    reference: b.id,
    status: orderId ? "已确认" : "无法安排"
  };
  const content = tpl
    ? Object.fromEntries(Object.entries(renderNoticeFields(tpl, values)).map(([key, v]) => [key, v.value]))
    : values;
  await recordMemberInteraction(trx, {
    event_key: "booking:" + b.id,
    app_id: b.app_id,
    property_id: b.property_id,
    member_id: b.member_id,
    binding_id: b.binding_id,
    booking_id: b.id,
    kind: orderId ? "预订已确认" : "预订未能安排",
    state: detail ? "SKIPPED" : "PENDING",
    detail: detail ?? "等待微信受理",
    template_id: tpl?.template,
    content: JSON.stringify(content)
  });
}
