import type { Transaction } from "kysely";
import { DomainError } from "@qintopia/contracts";
import { newId, stableHash } from "@qintopia/domain";
import type { DbExecutor } from "../inventory.ts";
import type { Database } from "../schema.ts";
import { appendAmendment, loadActiveStayTimeline, loadTemporaryOtherRoomCreateEvidence, type OrderContext } from "../orders.ts";
import { requireObject, requireString, type BuiltCommandEffect } from "./effects.ts";

export async function buildCompanionEffect(db: DbExecutor, context: OrderContext, input: Record<string, unknown>): Promise<BuiltCommandEffect> {
  const { order, stay } = context;
  if (!(order.status === "RESERVED" && stay.status === "PLANNED")
    && !(order.status === "CHECKED_IN" && stay.status === "IN_HOUSE")) {
    throw new DomainError("INVALID_ORDER_STATE", "仅已预订或在住的整房订单可以管理同住人", 409);
  }
  const timeline = await loadActiveStayTimeline(db, context);
  const unitIds = [...new Set(timeline.map((day) => day.inventoryUnitId))].sort();
  const units = await db.selectFrom("inventory_units").select(["id", "kind", "code", "occupancy_capacity"])
    .where("property_id", "=", order.property_id).where("id", "in", unitIds).orderBy("id").execute();
  if (!unitIds.length || units.length !== unitIds.length || units.some((unit) => unit.kind !== "ROOM")) {
    throw new DomainError("VALIDATION_ERROR", "只有整房订单可以添加或撤销同住人登记");
  }
  const capacity = Math.min(...units.map((unit) => unit.occupancy_capacity));
  const occupants = await db.selectFrom("active_order_occupants").selectAll().where("order_id", "=", order.id).orderBy("ordinal").execute();
  const action = requireString(input, "action");
  let ordinal: number;
  let occupantId: string;
  let guest: { fullName: string | null; nickname: string | null; phone: string | null; documentNumber: string | null };
  if (action === "ADD") {
    if (input.occupantId !== undefined) throw new DomainError("VALIDATION_ERROR", "添加同住人不能指定已有人员");
    const raw = requireObject(input.guest, "guest");
    const field = (name: string, max: number, required: boolean): string | null => {
      const value = raw[name];
      if (!required && value === null) return null;
      const trimmed = requireString(raw, name);
      if (trimmed.length > max) throw new DomainError("VALIDATION_ERROR", "同住人资料超过允许长度");
      return trimmed;
    };
    guest = { fullName: field("fullName", 200, true), nickname: field("nickname", 200, true), phone: field("phone", 80, false), documentNumber: field("documentNumber", 120, false) };
    const maximum = await db.selectFrom("order_occupants").select(({ fn }) => fn.max<number>("ordinal").as("ordinal"))
      .where("order_id", "=", order.id).executeTakeFirstOrThrow();
    ordinal = Number(maximum.ordinal) + 1;
    occupantId = `occupant_${stableHash({ orderId: order.id, ordinal, operation: "MANAGE_ORDER_OCCUPANTS" })}`;
  } else if (action === "REMOVE") {
    if (input.guest !== undefined) throw new DomainError("VALIDATION_ERROR", "撤销登记不能同时修改人员资料");
    occupantId = requireString(input, "occupantId");
    const occupant = occupants.find((row) => row.id === occupantId);
    if (!occupant) throw new DomainError("NOT_FOUND", "该同住人不存在或登记已撤销", 404);
    if (occupant.role !== "ADDITIONAL") throw new DomainError("VALIDATION_ERROR", "不能撤销主要入住人登记");
    ordinal = occupant.ordinal;
    const correction = await db.selectFrom("order_occupant_corrections").selectAll().where("occupant_id", "=", occupantId).orderBy("sequence", "desc").executeTakeFirst();
    guest = {
      fullName: correction?.corrected_full_name ?? occupant.full_name,
      nickname: correction?.corrected_nickname ?? occupant.nickname,
      phone: correction ? correction.corrected_phone : occupant.phone,
      documentNumber: correction ? correction.corrected_document_number : occupant.document_number
    };
  } else throw new DomainError("VALIDATION_ERROR", "不支持的同住人操作");
  const afterCount = occupants.length + (action === "ADD" ? 1 : -1);
  if (afterCount > capacity) throw new DomainError("VALIDATION_ERROR", `订单安排最多可登记 ${capacity} 人，添加后为 ${afterCount} 人`);
  const temporary = await loadTemporaryOtherRoomCreateEvidence(db, order.id);
  const effect = { operation: "MANAGE_ORDER_OCCUPANTS", action, orderId: order.id, occupantId, ordinal, guest,
    arrivalDate: order.arrival_date, departureDate: order.departure_date,
    beforeCount: occupants.length, afterCount, occupancyCapacity: capacity,
    ...(temporary ? { temporaryOtherRoomArrangement: temporary.arrangement, temporaryOtherRoomCreateAmendmentId: temporary.createAmendmentId } : {}) };
  const basisVersions = {
    orderVersion: order.version, orderStatus: order.status, timeline, units,
    occupants: occupants.map((row) => row.id)
  };
  return { propertyId: order.property_id, effect, effectHash: stableHash({ effect, basisVersions }), basisVersions };
}

export async function applyCompanionEffect(trx: Transaction<Database>, context: OrderContext, effect: Record<string, unknown>, options: {
  commandId: string; reason: { code: string; note: string };
}) {
  if (!options.reason.note.trim()) throw new DomainError("VALIDATION_ERROR", "必须填写同住人登记原因");
  const orderId = context.order.id;
  const occupantId = requireString(effect, "occupantId");
  const amendmentId = await appendAmendment(trx, { orderId, sequence: context.order.version + 1,
    amendmentType: "MANAGE_ORDER_OCCUPANTS", reasonCode: options.reason.code, reasonNote: options.reason.note,
    priorVersion: context.order.version, payload: effect, commandId: options.commandId });
  let removalId: string | null = null;
  if (effect.action === "ADD") {
    const guest = requireObject(effect.guest);
    await trx.insertInto("order_occupants").values({ id: occupantId, order_id: orderId, ordinal: Number(effect.ordinal), role: "ADDITIONAL",
      full_name: requireString(guest, "fullName"), nickname: requireString(guest, "nickname"),
      phone: guest.phone === null ? null : requireString(guest, "phone"),
      document_number: guest.documentNumber === null ? null : requireString(guest, "documentNumber"),
      created_by_command_id: options.commandId }).execute();
  } else {
    removalId = newId("fact");
    await trx.insertInto("order_occupant_removals").values({ id: removalId, order_id: orderId, occupant_id: occupantId,
      amendment_id: amendmentId, created_by_command_id: options.commandId }).execute();
  }
  await trx.updateTable("orders").set({ version: context.order.version + 1, updated_at: new Date() }).where("id", "=", orderId).execute();
  return { persistedResult: { ...effect, amendmentId, removalId }, resourceRefs: [orderId, occupantId, amendmentId], factRefs: removalId ? [removalId] : [] };
}
