import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { CommandType } from "@qintopia/contracts";
import { createDatabase, propertyLocalToday, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createBusinessApi } from "../helpers/business-api.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

let db: Kysely<Database>;
let app: FastifyInstance;
let api: ReturnType<typeof createBusinessApi>;
let sequence = 0;
let businessDate: string;
function day(offset = 0) {
  const date = new Date(`${businessDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
const at = <T>(day: string, run: () => Promise<T>, time = "04:00:00") =>
  withPropertyClockForTesting(new Date(`${day}T${time}Z`), run);

async function activeClaims(orderId: string) {
  return db.selectFrom("inventory_claims as claim")
    .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
    .innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .select(["claim.id", "claim.inventory_unit_id", "claim.service_date"])
    .where("claim.source_type", "=", "ORDER_SEGMENT").where("stay.order_id", "=", orderId)
    .where("claim.active", "=", true).orderBy("claim.service_date").orderBy("claim.id").execute();
}

async function state(orderId: string) {
  const view = await api.get(`/api/v1/orders/${orderId}`);
  return {
    order: view.order, stay: view.stay, occupants: view.occupants, segments: view.segments,
    pricingRevisions: view.pricingRevisions, coverageSet: view.coverageSet,
    collectionFacts: view.collectionFacts, amounts: view.amounts, fulfillment: view.fulfillment,
    amendments: view.amendments, claims: await activeClaims(orderId)
  };
}

async function createOrder(options: { arrival?: string; departure?: string; unit?: string; free?: boolean } = {}) {
  const arrivalDate = options.arrival ?? day();
  const departureDate = options.departure ?? day(2);
  const key = `daily-stay-create-${++sequence}`;
  return at(arrivalDate, async () => {
    const quoted = await app.inject({ method: "POST", url: "/api/v1/quotes",
      headers: { ...api.headers, "idempotency-key": `${key}-quote`, "x-correlation-id": key },
      payload: { propertyId: demo.propertyId, inventoryUnitId: options.unit ?? demo.roomId,
        stayType: options.free ? "FREE" : "TRANSIENT", arrivalDate, departureDate,
        pricingPolicyVersionId: options.free ? demo.freePolicyId : demo.publicPricingPolicyId } });
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json().receipt.commandType).toBe("CREATE_QUOTE");
    const created = await api.execute("CREATE_ORDER", {
      quoteId: quoted.json().quote.quoteId, primaryGuest: { fullName: "API synthetic guest", nickname: key },
      ...(options.free ? { freeStayReason: "Synthetic volunteer stay", freeStayCategoryCode: "VOLUNTEER" }
        : { bookingChannelCode: "WECOM" })
    }, key, { snapshot: () => db.selectFrom("orders").select(["id", "status", "version"]).orderBy("id").execute() });
    return created.result!.orderId as string;
  });
}

async function rejectPreview(commandType: CommandType, input: Record<string, unknown>, status: number, code: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/command-previews",
    headers: { ...api.headers, "idempotency-key": `daily-stay-rejected-${++sequence}`, "x-correlation-id": "daily-stay-rejected" },
    payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error?.code ?? response.json().code).toBe(code);
}

beforeEach(async () => {
  db = await resetTestDatabase();
  // SQL lifecycle guards use the real database business date. Keep committed
  // operations aligned with it; JS-only clock overrides cannot change SQL time.
  businessDate = await propertyLocalToday(db, demo.propertyId);
  app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
  await app.ready();
  api = createBusinessApi(app);
});
afterEach(async () => { await app?.close(); await db?.destroy(); });

describe("daily stay commands through the public token API", () => {
  it("reschedules a reservation with the same order and stay while replacing only its reserved inventory dates", async () => {
    const orderId = await createOrder();
    await at(day(), async () => {
      const before = await state(orderId);
      expect(before.order.status).toBe("RESERVED");
      expect(before.claims.map(claim => claim.service_date)).toEqual([day(), day(1)]);
      const receipt = await api.execute("RESCHEDULE_STAY", {
        orderId, newArrivalDate: day(2), newDepartureDate: day(4)
      }, "daily-reschedule", { snapshot: () => state(orderId) });
      expect(receipt.result).toMatchObject({ orderId });
      const rescheduled = await state(orderId);
      expect(rescheduled.order).toMatchObject({ id: orderId, status: "RESERVED",
        arrival_date: day(2), departure_date: day(4) });
      expect(rescheduled.stay).toMatchObject({ id: before.stay.id, status: "PLANNED" });
      expect(rescheduled.fulfillment).toEqual(before.fulfillment);
      expect(rescheduled.collectionFacts).toEqual(before.collectionFacts);
      expect(rescheduled.claims.map(({ inventory_unit_id, service_date }) => ({ inventory_unit_id, service_date }))).toEqual([
        { inventory_unit_id: demo.roomId, service_date: day(2) },
        { inventory_unit_id: demo.roomId, service_date: day(3) }
      ]);
      expect(await db.selectFrom("inventory_claims").select("active")
        .where("id", "in", before.claims.map(claim => claim.id)).execute()).toEqual([{ active: false }, { active: false }]);
      expect(rescheduled.amendments.filter((amendment: any) => amendment.amendment_type === "RESCHEDULE_STAY")).toHaveLength(1);
    });
  });

  it("adds and removes a companion with stable receipt identities and no price or inventory mutation", async () => {
    const orderId = await createOrder();
    await at(day(), async () => {
      const before = await state(orderId);
      const added = await api.execute("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD",
        guest: { fullName: "Synthetic companion", nickname: "companion", phone: null, documentNumber: null } },
      "daily-companion-add", { snapshot: () => state(orderId) });
      expect(added.result).toMatchObject({ orderId, beforeCount: 1, afterCount: 2, occupantId: expect.any(String) });
      const after = await state(orderId);
      expect(after.occupants).toHaveLength(2);
      expect(after.occupants[1]).toMatchObject({ id: added.result!.occupantId, role: "ADDITIONAL", nickname: "companion" });
      expect(after.claims).toEqual(before.claims);
      expect(after.amounts).toEqual(before.amounts);
      expect(after.pricingRevisions).toEqual(before.pricingRevisions);
      expect(after.collectionFacts).toEqual(before.collectionFacts);
      await rejectPreview("MANAGE_ORDER_OCCUPANTS", { orderId, action: "REMOVE", occupantId: after.occupants[0].id }, 400, "VALIDATION_ERROR");
      expect(await state(orderId)).toEqual(after);
      await api.execute("MANAGE_ORDER_OCCUPANTS", { orderId, action: "REMOVE", occupantId: added.result!.occupantId },
        "daily-companion-remove", { snapshot: () => state(orderId) });
      expect((await state(orderId)).occupants).toEqual(before.occupants);
      expect(await db.selectFrom("order_occupant_removals").select("id").where("order_id", "=", orderId).execute()).toHaveLength(1);
    });
  });

  it("extends, shortens, moves and reprices the same in-house order with actual inventory and price readback", async () => {
    const orderId = await createOrder({ arrival: day(-1), departure: day(1) });
    await at(day(-1), () => api.execute("CHECK_IN", { orderId }, "daily-changes-checkin", { snapshot: () => state(orderId) }));
    await at(day(), async () => {
      await api.execute("EXTEND_STAY", { orderId, newDepartureDate: day(3) },
        "daily-extend", { snapshot: () => state(orderId) });
      const extended = await state(orderId);
      expect(extended.order).toMatchObject({ status: "CHECKED_IN", departure_date: day(3) });
      expect(extended.claims.map(claim => claim.service_date)).toEqual([day(-1), day(), day(1), day(2)]);
      await rejectPreview("SHORTEN_STAY", { orderId, newDepartureDate: day(-1) }, 400, "VALIDATION_ERROR");
      expect(await state(orderId)).toEqual(extended);
      const shortened = await api.execute("SHORTEN_STAY", { orderId, newDepartureDate: day(2) },
        "daily-shorten", { snapshot: () => state(orderId) });
      expect(shortened.result).toMatchObject({ orderId });
      const afterShortening = await state(orderId);
      expect(afterShortening.order).toMatchObject({ status: "CHECKED_IN", departure_date: day(2) });
      expect(afterShortening.stay.status).toBe("IN_HOUSE");
      expect(afterShortening.claims.map(claim => claim.service_date)).toEqual([day(-1), day(), day(1)]);
      await api.execute("MOVE_UNIT", { orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: day() },
        "daily-move", { snapshot: () => state(orderId) });
      const moved = await state(orderId);
      expect(moved.stay.id).toBe(extended.stay.id);
      expect(moved.claims.map(({ inventory_unit_id, service_date }) => ({ inventory_unit_id, service_date }))).toEqual([
        { inventory_unit_id: demo.roomId, service_date: day(-1) },
        { inventory_unit_id: demo.secondRoomId, service_date: day() },
        { inventory_unit_id: demo.secondRoomId, service_date: day(1) }
      ]);
      const target = moved.amounts.currentContractAmount.minorUnits + 100;
      await api.execute("REPRICE_ORDER", { orderId, targetCurrentContractAmountMinor: target },
        "daily-reprice", { snapshot: () => state(orderId), reason: { code: "REPRICE_ORDER", note: "Synthetic guest confirmed the revised price" } });
      const repriced = await state(orderId);
      expect(repriced.amounts.currentContractAmount.minorUnits).toBe(target);
      expect(repriced.claims).toEqual(moved.claims);
      expect(repriced.collectionFacts).toEqual(extended.collectionFacts);
      for (const type of ["EXTEND_STAY", "SHORTEN_STAY", "MOVE_UNIT", "REPRICE_ORDER"]) {
        expect(repriced.amendments.filter((amendment: any) => amendment.amendment_type === type)).toHaveLength(1);
      }
    });
  });

  it("cancels a reservation once and releases inventory without inventing a refund", async () => {
    const orderId = await createOrder();
    await at(day(), async () => {
      const receipt = await api.execute("CANCEL_ORDER", { orderId }, "daily-cancel", { snapshot: () => state(orderId) });
      expect(receipt.result).toMatchObject({ orderId });
      const cancelled = await state(orderId);
      expect(cancelled.order.status).toBe("CANCELLED");
      expect(cancelled.stay.status).toBe("CANCELLED");
      expect(cancelled.amounts.currentContractAmount.minorUnits).toBe(0);
      expect(cancelled.claims).toEqual([]);
      expect(cancelled.collectionFacts).toEqual([]);
    });
  });

  it("rejects no-show before the local deadline and marks an overdue reservation without a phantom check-in", async () => {
    const orderId = await createOrder({ arrival: day(-1), departure: day(2) });
    await at(day(-1), async () => {
      const before = await state(orderId);
      await rejectPreview("MARK_NO_SHOW", { orderId }, 409, "INVALID_ORDER_STATE");
      expect(await state(orderId)).toEqual(before);
    }, "11:59:00");
    await at(day(), async () => {
      await api.execute("MARK_NO_SHOW", { orderId }, "daily-no-show", { snapshot: () => state(orderId) });
      const missed = await state(orderId);
      expect(missed.order.status).toBe("NO_SHOW");
      expect(missed.stay.status).toBe("NO_SHOW");
      expect(missed.claims).toEqual([]);
      expect(missed.fulfillment.checkIn).toBeNull();
      expect(missed.amounts.currentContractAmount.minorUnits).toBe(0);
    });
  });

  it("requires the unused-room confirmation before revoking same-day check-in and preserves its original evidence", async () => {
    const orderId = await createOrder();
    await at(day(), async () => {
      await api.execute("CHECK_IN", { orderId }, "daily-revoke-checkin", { snapshot: () => state(orderId) });
      const checkedIn = await state(orderId);
      await rejectPreview("REVOKE_CHECK_IN", { orderId, unusedRoomConfirmed: false }, 400, "VALIDATION_ERROR");
      expect(await state(orderId)).toEqual(checkedIn);
      await api.execute("REVOKE_CHECK_IN", { orderId, unusedRoomConfirmed: true },
        "daily-revoke", { snapshot: () => state(orderId) });
      const revoked = await state(orderId);
      expect(revoked.order.status).toBe("CHECK_IN_REVOKED");
      expect(revoked.stay.status).toBe("CHECK_IN_REVOKED");
      expect(revoked.fulfillment.checkIn).toEqual(checkedIn.fulfillment.checkIn);
      expect(revoked.fulfillment.checkInRevocation).not.toBeNull();
      expect(revoked.claims).toEqual([]);
      expect(revoked.amounts.currentContractAmount.minorUnits).toBe(0);
      expect(revoked.collectionFacts).toEqual([]);
    });
  });

  it("completes an overdue reservation only with explicit completed-stay facts and preserves one double-fulfillment record", async () => {
    const orderId = await createOrder({ free: true, arrival: day(-5), departure: day(-3) });
    await at(day(), async () => {
      const before = await state(orderId);
      await rejectPreview("COMPLETE_STAY", { orderId, actualStayCompletedConfirmed: false, reasonNote: "Synthetic completed stay" }, 400, "VALIDATION_ERROR");
      expect(await state(orderId)).toEqual(before);
      const reason = { code: "COMPLETE_STAY", note: "Synthetic staff confirmed the original stay was completed" };
      await api.execute("COMPLETE_STAY", { orderId, actualStayCompletedConfirmed: true, reasonNote: reason.note },
        "daily-complete", { snapshot: () => state(orderId), reason });
      const completed = await state(orderId);
      expect(completed.order).toMatchObject({ status: "CHECKED_OUT", arrival_date: day(-5), departure_date: day(-3) });
      expect(completed.stay.status).toBe("COMPLETED");
      expect(completed.fulfillment.checkIn).not.toBeNull();
      expect(completed.fulfillment.checkOut).not.toBeNull();
      for (const type of ["CHECK_IN", "CHECK_OUT"]) {
        expect(completed.amendments.filter((amendment: any) => amendment.amendment_type === type)).toHaveLength(1);
      }
      expect(completed.claims).toEqual([]);
      expect(completed.collectionFacts).toEqual([]);
      expect(completed.amounts.currentContractAmount.minorUnits).toBe(0);
    });
  });
});
