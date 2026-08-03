import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, findCommandResult, getOrderView, listAvailability, loadActiveStayTimeline, loadOrderContext, propertyLocalToday, type Database } from "@qintopia/db";
import { newOpaqueSecret } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let db: Kysely<Database>;
const memberSourceUnitId = "unit_room_d_gen_01";
const memberTargetUnitId = "unit_room_d_gen_02";
const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let sequence = 0;
function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function testPricingPolicyForDates(arrivalDate: string, departureDate: string): string {
  return arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
    ? demo.transientPolicyId
    : demo.publicPricingPolicyId;
}

async function previewAndConfirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const preview = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  return confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "AUTOMATED_ACCEPTANCE", note: "Database integration acceptance" }
  }, metadata(`${prefix}-confirm`));
}

async function quote(unitId: string, options: { member?: boolean; stayType?: "TRANSIENT" | "FREE"; arrival?: string; departure?: string } = {}) {
  const stayType = options.stayType ?? "TRANSIENT";
  const arrivalDate = options.arrival ?? "2026-07-21";
  const departureDate = options.departure ?? "2026-07-24";
  return createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType,
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : testPricingPolicyForDates(arrivalDate, departureDate),
    ...(options.member ? { memberContractId: demo.memberContractId } : {})
  });
}

async function createOrder(unitId: string, prefix: string, options: { member?: boolean; stayType?: "TRANSIENT" | "FREE"; arrival?: string; departure?: string; bookingChannelCode?: "YOUMUDAO" | "CTRIP" | "MEITUAN" | "WECOM" } = {}) {
  const priced = await quote(unitId, options);
  const bookingChannelCode = options.bookingChannelCode ?? "WECOM";
  return previewAndConfirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: priced.quoteId,
      primaryGuest: { fullName: `Guest ${prefix}`, nickname: `Guest ${prefix}` },
      ...(!options.member && options.stayType !== "FREE" ? {
        bookingChannelCode,
        channelOrderReference: bookingChannelCode === "WECOM" ? null : `TEST-ORDER-${prefix}`,
        targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits
      } : {}),
      ...(options.stayType === "FREE" ? { freeStayReason: `Automated FREE stay fixture: ${prefix}`, freeStayCategoryCode: "VOLUNTEER" } : {})
    }
  }, prefix);
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeEach(async () => {
  db = await resetTestDatabase();
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("PostgreSQL core operations", () => {
  it("requires a nonblank guest nickname before Preview and produces zero command or business writes", async () => {
    const priced = await quote(demo.roomId, { arrival: "2026-08-01", departure: "2026-08-02" });
    const artifactCounts = async () => Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]).then((rows) => rows.map((row) => Number(row.count)));
    const before = await artifactCounts();

    for (const [label, primaryGuest] of [
      ["missing", { fullName: "Missing nickname" }],
      ["blank", { fullName: "Blank nickname", nickname: "   " }]
    ] as const) {
      await expect(createCommandPreview(db, principal, {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: priced.quoteId,
          primaryGuest,
          bookingChannelCode: "WECOM",
          channelOrderReference: null,
          targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits
        }
      }, metadata(`nickname-${label}`))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "nickname is required" });
    }

    expect(await artifactCounts()).toEqual(before);
  });

  it("requires a nonblank guest nickname for FREE stays before Preview and produces zero command or business writes", async () => {
    const priced = await quote(demo.roomId, { stayType: "FREE", arrival: "2026-08-01", departure: "2026-08-02" });
    const artifactCounts = async () => Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]).then((rows) => rows.map((row) => Number(row.count)));
    const before = await artifactCounts();

    for (const [label, primaryGuest] of [
      ["missing", { fullName: "Missing FREE nickname" }],
      ["blank", { fullName: "Blank FREE nickname", nickname: "   " }]
    ] as const) {
      await expect(createCommandPreview(db, principal, {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: priced.quoteId,
          primaryGuest,
          freeStayReason: "Volunteer accommodation fixture",
          freeStayCategoryCode: "VOLUNTEER"
        }
      }, metadata(`free-nickname-${label}`))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "nickname is required" });
    }

    expect(await artifactCounts()).toEqual(before);
  });

  it("requires a volunteer/reception category for FREE stays, rejects channels with zero writes, and persists the category", async () => {
    const artifactCounts = async () => Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]).then((rows) => rows.map((row) => Number(row.count)));
    const before = await artifactCounts();

    const rejectedQuote = await quote(demo.roomId, { stayType: "FREE", arrival: "2026-08-05", departure: "2026-08-06" });
    for (const [label, fields] of [
      ["missing-category", { freeStayReason: "Missing category fixture" }],
      ["invalid-category", { freeStayReason: "Invalid category fixture", freeStayCategoryCode: "SPONSORED" }],
      ["channel-on-free", { freeStayReason: "Channel on FREE fixture", freeStayCategoryCode: "VOLUNTEER", bookingChannelCode: "WECOM" }],
      ["category-on-transient", { freeStayCategoryCode: "VOLUNTEER", bookingChannelCode: "WECOM" }]
    ] as const) {
      const isTransient = label === "category-on-transient";
      const target = isTransient
        ? await quote(demo.roomId, { arrival: "2026-08-07", departure: "2026-08-08" })
        : rejectedQuote;
      await expect(createCommandPreview(db, principal, {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: target.quoteId,
          primaryGuest: { fullName: `Free Category ${label}`, nickname: `Free Category ${label}` },
          ...(isTransient ? { targetCurrentContractAmountMinor: target.currentContractAmount.minorUnits } : {}),
          ...fields
        }
      }, metadata(`free-category-${label}`))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await artifactCounts()).toEqual(before);

    for (const [freeStayCategoryCode, arrival, departure] of [
      ["VOLUNTEER", "2026-08-10", "2026-08-11"],
      ["RECEPTION", "2026-08-12", "2026-08-13"]
    ] as const) {
      const priced = await quote(demo.roomId, { stayType: "FREE", arrival, departure });
      const receipt = await previewAndConfirm({
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: priced.quoteId,
          primaryGuest: { fullName: `Category Guest ${freeStayCategoryCode}`, nickname: `Category ${freeStayCategoryCode}` },
          freeStayReason: `Category persistence fixture: ${freeStayCategoryCode}`,
          freeStayCategoryCode
        }
      }, `free-category-${freeStayCategoryCode.toLowerCase()}`);
      expect(receipt.result).toMatchObject({ freeStayCategoryCode, bookingChannelCode: null, channelOrderReference: null });
      const orderId = receipt.result!.orderId as string;
      const row = await db.selectFrom("orders").select(["free_stay_category_code", "booking_channel_code", "channel_order_reference"]).where("id", "=", orderId).executeTakeFirstOrThrow();
      expect(row).toEqual({ free_stay_category_code: freeStayCategoryCode, booking_channel_code: null, channel_order_reference: null });
      const view = await getOrderView(db, orderId);
      expect(view.order.free_stay_category_code).toBe(freeStayCategoryCode);
    }
  });

  it("trims and traces the guest nickname through Preview, Receipt, order query, and amendment", async () => {
    const priced = await quote(demo.roomId, { arrival: "2026-08-03", departure: "2026-08-04" });
    const previewMetadata = metadata("nickname-trace-preview");
    const prepared = await createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: priced.quoteId,
        primaryGuest: { fullName: "  林晓  ", nickname: "  小林  " },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits
      }
    }, previewMetadata);
    expect(prepared.preview.effect.primaryGuest).toEqual({ fullName: "林晓", nickname: "小林" });
    expect((await db.selectFrom("command_previews")
      .select("normalized_input")
      .where("id", "=", prepared.preview.previewId)
      .executeTakeFirstOrThrow()).normalized_input).toMatchObject({
      primaryGuest: { fullName: "林晓", nickname: "小林" }
    });
    const replay = await createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: priced.quoteId,
        primaryGuest: { fullName: "林晓", nickname: "小林" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: priced.currentContractAmount.minorUnits
      }
    }, previewMetadata);
    expect(replay.receipt.receiptId).toBe(prepared.receipt.receiptId);
    expect(replay.preview.previewId).toBe(prepared.preview.previewId);

    const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata("nickname-trace-confirm"));
    expect(receipt.result?.primaryGuest).toEqual({ fullName: "林晓", nickname: "小林" });

    const view = await getOrderView(db, receipt.result!.orderId as string);
    expect(view.order.primary_guest_snapshot).toEqual({ fullName: "林晓", nickname: "小林" });
    expect(view.amendments[0]?.payload).toMatchObject({ primaryGuest: { fullName: "林晓", nickname: "小林" } });
  });

  it("forms coverage before cash and locks policy/versioned order history", async () => {
    const priced = await quote(demo.roomId, { member: true });
    expect(priced.coverageSet).toHaveLength(2);
    expect(priced.cashLines).toHaveLength(1);
    expect(priced.cashRemainder.minorUnits).toBe(12_000);
    const receipt = await previewAndConfirm({
      commandType: "CREATE_ORDER",
      input: { propertyId: demo.propertyId, quoteId: priced.quoteId, primaryGuest: { fullName: "Member Guest", nickname: "Member Guest" } }
    }, "member-order");
    expect(receipt.businessCommitted).toBe(true);
    const view = await getOrderView(db, receipt.result!.orderId as string);
    expect(view.order.pricing_policy_version_id).toBe(demo.transientPolicyId);
    expect(view.pricingRevisions).toHaveLength(1);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(12_000);
  });

  it("reconciles newly available entitlement into real coverage exactly once", async () => {
    const created = await createOrder(demo.roomId, "reprice-coverage", { member: true });
    const orderId = created.result!.orderId as string;
    expect((await getOrderView(db, orderId)).coverageSet.filter((item) => item.status === "HELD")).toHaveLength(2);

    await previewAndConfirm({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: demo.roomLotId,
        quantityDelta: 1,
        adjustmentReason: "Cover the third service date"
      }
    }, "reprice-coverage-adjust");
    await previewAndConfirm({
      commandType: "REFRESH_MEMBER_COVERAGE",
      input: { propertyId: demo.propertyId, orderId }
    }, "reprice-coverage-first");

    let activeCoverage = (await getOrderView(db, orderId)).coverageSet.filter((item) => item.status === "HELD");
    expect(activeCoverage).toHaveLength(3);
    expect(new Set(activeCoverage.map((item) => item.service_date)).size).toBe(3);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("order_id", "=", orderId).where("entry_type", "=", "HOLD").execute()).toHaveLength(3);
    let balance = await db.selectFrom("entitlement_lots")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.total_units",
        sql<number>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as integer)`.as("ledger_delta")
      ])
      .where("entitlement_lots.id", "=", demo.roomLotId)
      .groupBy("entitlement_lots.total_units")
      .executeTakeFirstOrThrow();
    expect(balance.total_units + Number(balance.ledger_delta)).toBe(0);

    await previewAndConfirm({
      commandType: "REFRESH_MEMBER_COVERAGE",
      input: { propertyId: demo.propertyId, orderId }
    }, "reprice-coverage-second");
    activeCoverage = (await getOrderView(db, orderId)).coverageSet.filter((item) => item.status === "HELD");
    expect(activeCoverage).toHaveLength(3);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("order_id", "=", orderId).where("entry_type", "=", "HOLD").execute()).toHaveLength(3);
    balance = await db.selectFrom("entitlement_lots")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.total_units",
        sql<number>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as integer)`.as("ledger_delta")
      ])
      .where("entitlement_lots.id", "=", demo.roomLotId)
      .groupBy("entitlement_lots.total_units")
      .executeTakeFirstOrThrow();
    expect(balance.total_units + Number(balance.ledger_delta)).toBe(0);
  });

  it("enforces one active coverage per order date and moves coverage with a new permanent ID", async () => {
    const created = await createOrder(memberSourceUnitId, "coverage-unique", {
      member: true,
      arrival: "2026-08-21",
      departure: "2026-08-23"
    });
    const orderId = created.result!.orderId as string;
    const before = await getOrderView(db, orderId);
    const oldCoverage = before.coverageSet.find((item) => item.service_date === "2026-08-22" && item.status === "HELD")!;
    await expect(db.insertInto("coverage_items").values({
      id: "coverage_duplicate_order_date",
      order_id: orderId,
      contract_id: demo.memberContractId,
      lot_id: demo.roomLotId,
      inventory_unit_id: oldCoverage.inventory_unit_id,
      service_date: "2026-08-22",
      unit_kind: "ROOM_NIGHT",
      status: "HELD",
      held_by_revision_id: before.order.current_revision_id!
    }).execute()).rejects.toMatchObject({ constraint: "coverage_items_active_order_date_idx" });

    const moved = await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: memberTargetUnitId,
        effectiveDate: "2026-08-22"
      }
    }, "coverage-unique-move");
    expect(moved).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    const movedCoverage = (await getOrderView(db, orderId)).coverageSet.filter((item) => item.service_date === "2026-08-22");
    expect(movedCoverage).toHaveLength(2);
    expect(movedCoverage.find((item) => item.id === oldCoverage.id)?.status).toBe("RELEASED");
    const active = movedCoverage.find((item) => item.status === "HELD")!;
    expect(active.id).not.toBe(oldCoverage.id);
    expect(active.inventory_unit_id).toBe(memberTargetUnitId);
  });

  it("rejects FREE membership before holding entitlement and during defensive command recalculation", async () => {
    await expect(quote(demo.roomId, { member: true, stayType: "FREE" }))
      .rejects.toMatchObject({ code: "PRICING_POLICY_UNCONFIGURED" });
    expect(await db.selectFrom("quotes").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").execute()).toHaveLength(0);

    const forged = await quote(demo.roomId, { stayType: "FREE" });
    await db.updateTable("quotes").set({ member_contract_id: demo.memberContractId }).where("id", "=", forged.quoteId).execute();
    await expect(createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: { propertyId: demo.propertyId, quoteId: forged.quoteId, primaryGuest: { fullName: "No entitlement debit", nickname: "No Debit" }, freeStayReason: "Defensive FREE membership rejection fixture", freeStayCategoryCode: "VOLUNTEER" }
    }, metadata("free-member-command-denied"))).rejects.toMatchObject({ code: "PRICING_POLICY_UNCONFIGURED" });
    expect(await db.selectFrom("orders").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").execute()).toHaveLength(0);
  });

  it("creates a new permanent coverage and HOLD fact when a released night is extended back", async () => {
    const arrivalDate = addDays(await propertyLocalToday(db, demo.propertyId), 1);
    const shortenedDepartureDate = addDays(arrivalDate, 2);
    const departureDate = addDays(arrivalDate, 3);
    const returnedServiceDate = addDays(arrivalDate, 2);
    await previewAndConfirm({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId, quantityDelta: 1, adjustmentReason: "Three-night re-hold acceptance" }
    }, "rehold-adjust");
    const created = await createOrder(demo.roomId, "rehold", {
      member: true,
      arrival: arrivalDate,
      departure: departureDate
    });
    const orderId = created.result!.orderId as string;
    const initialView = await getOrderView(db, orderId);
    const initialCoverage = initialView.coverageSet.find((item) => item.service_date === returnedServiceDate)!;

    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: shortenedDepartureDate
      }
    }, "rehold-shorten");
    expect((await getOrderView(db, orderId)).coverageSet.find((item) => item.id === initialCoverage.id)?.status).toBe("RELEASED");

    const extended = await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: departureDate
      }
    }, "rehold-extend");
    expect(extended.businessCommitted).toBe(true);
    const view = await getOrderView(db, orderId);
    const coverageForReturnedNight = view.coverageSet.filter((item) => item.service_date === returnedServiceDate);
    expect(coverageForReturnedNight).toHaveLength(2);
    expect(coverageForReturnedNight.map((item) => item.status).sort()).toEqual(["HELD", "RELEASED"]);
    const activeCoverage = coverageForReturnedNight.find((item) => item.status === "HELD")!;
    expect(activeCoverage.id).not.toBe(initialCoverage.id);
    const ledger = await db.selectFrom("entitlement_ledger").select(["fact_id", "entry_type", "coverage_id", "quantity_delta"])
      .where("order_id", "=", orderId).where("service_date", "=", returnedServiceDate).execute();
    expect(ledger.filter((entry) => entry.entry_type === "HOLD")).toHaveLength(2);
    expect(ledger.filter((entry) => entry.entry_type === "HOLD").map((entry) => entry.coverage_id)).toContain(activeCoverage.id);
    expect(new Set(ledger.map((entry) => entry.fact_id)).size).toBe(ledger.length);
  });

  it("serializes whole-room versus child-bed claims while allowing different beds", async () => {
    const roomQuote = await quote(demo.roomId, { stayType: "FREE" });
    const bedQuote = await quote(demo.bedAId, { stayType: "FREE" });
    const [roomPreview, bedPreview] = await Promise.all([
      createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: roomQuote.quoteId, primaryGuest: { fullName: "Room Guest", nickname: "Room Guest" }, freeStayReason: "Whole-room mutex fixture", freeStayCategoryCode: "VOLUNTEER" } }, metadata("room-preview")),
      createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: bedQuote.quoteId, primaryGuest: { fullName: "Bed Guest", nickname: "Bed Guest" }, freeStayReason: "Bed mutex fixture", freeStayCategoryCode: "VOLUNTEER" } }, metadata("bed-preview"))
    ]);
    const [roomResult, bedResult] = await Promise.all([
      confirmCommandPreview(db, principal, roomPreview.preview.previewId, { propertyId: demo.propertyId, commandType: "CREATE_ORDER", confirmation: true, expectedEffectHash: roomPreview.preview.effectHash, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, metadata("room-confirm")),
      confirmCommandPreview(db, principal, bedPreview.preview.previewId, { propertyId: demo.propertyId, commandType: "CREATE_ORDER", confirmation: true, expectedEffectHash: bedPreview.preview.effectHash, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, metadata("bed-confirm"))
    ]);
    expect([roomResult.businessCommitted, bedResult.businessCommitted].filter(Boolean)).toHaveLength(1);
    const availability = await listAvailability(db, demo.propertyId, "2026-07-21", "2026-07-24");
    expect(availability.find((unit) => unit.id === demo.roomId)?.available).toBe(false);

    await db.destroy();
    db = await resetTestDatabase();
    const [bedA, bedB] = await Promise.all([createOrder(demo.bedAId, "bed-a", { stayType: "FREE" }), createOrder(demo.bedBId, "bed-b", { stayType: "FREE" })]);
    expect(bedA.businessCommitted).toBe(true);
    expect(bedB.businessCommitted).toBe(true);
  });

  it("completes concurrent member order creation and entitlement adjustment without a lock-order deadlock", async () => {
    const priced = await quote(demo.secondRoomId, { member: true, arrival: "2026-08-01", departure: "2026-08-02" });
    const createPreview = await createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: { propertyId: demo.propertyId, quoteId: priced.quoteId, primaryGuest: { fullName: "Lock Order Guest", nickname: "Lock Guest" } }
    }, metadata("lock-order-create-preview"));
    const adjustPreview = await createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId, quantityDelta: 1, adjustmentReason: "Concurrent lock-order acceptance" }
    }, metadata("lock-order-adjust-preview"));
    const outcomes = await within(Promise.allSettled([
      confirmCommandPreview(db, principal, createPreview.preview.previewId, {
        propertyId: demo.propertyId, commandType: "CREATE_ORDER",
        confirmation: true, expectedEffectHash: createPreview.preview.effectHash,
        reason: { code: "CREATE_STANDARD_ORDER", note: "" }
      }, metadata("lock-order-create-confirm")),
      confirmCommandPreview(db, principal, adjustPreview.preview.previewId, {
        propertyId: demo.propertyId, commandType: "ADJUST_MEMBER_ENTITLEMENT",
        confirmation: true, expectedEffectHash: adjustPreview.preview.effectHash,
        reason: { code: "LOCK_ORDER_TEST", note: "Adjust entitlement concurrently" }
      }, metadata("lock-order-adjust-confirm"))
    ]), 5_000);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const receipts = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    expect(receipts.filter((receipt) => receipt.businessCommitted)).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.businessCommitted).map((receipt) => receipt.error?.code)).toEqual(["PREVIEW_STALE"]);
  });

  it("rejects a stale preview with zero domain writes and preserves a durable rejection receipt", async () => {
    const firstQuote = await quote(demo.secondRoomId, { stayType: "FREE" });
    const stale = await createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: firstQuote.quoteId, primaryGuest: { fullName: "Stale Guest", nickname: "Stale Guest" }, freeStayReason: "Stale Preview fixture", freeStayCategoryCode: "VOLUNTEER" } }, metadata("stale-preview"));
    await createOrder(demo.secondRoomId, "winner", { stayType: "FREE" });
    const countBefore = await db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    const rejected = await confirmCommandPreview(db, principal, stale.preview.previewId, { propertyId: demo.propertyId, commandType: "CREATE_ORDER", confirmation: true, expectedEffectHash: stale.preview.effectHash, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, metadata("stale-confirm"));
    const countAfter = await db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    expect(rejected.businessCommitted).toBe(false);
    expect(rejected.error?.code).toBe("PREVIEW_STALE");
    expect(Number(countAfter.count)).toBe(Number(countBefore.count));
  });

  it("returns PREVIEW_STALE when an order state changes after Preview", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createOrder(demo.roomId, "state-stale", {
      stayType: "FREE",
      arrival: arrivalDate,
      departure: addDays(arrivalDate, 1)
    });
    const orderId = created.result!.orderId as string;
    const stale = await createCommandPreview(db, principal, {
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, metadata("state-stale-preview"));

    await previewAndConfirm({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, "state-stale-winner");
    const amendmentsBefore = await db.selectFrom("amendments").select("id").where("order_id", "=", orderId).execute();

    const rejected = await confirmCommandPreview(db, principal, stale.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CHECK_IN",
      confirmation: true,
      expectedEffectHash: stale.preview.effectHash,
      reason: { code: "STATE_STALE", note: "Order state changed after Preview" }
    }, metadata("state-stale-confirm"));

    expect(rejected).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "INVALID_ORDER_STATE" } }
    });
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", orderId).execute())
      .toHaveLength(amendmentsBefore.length);
  });

  it("rolls back domain facts when receipt persistence fails", async () => {
    const priced = await quote(demo.roomId, { stayType: "FREE" });
    const preview = await createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: priced.quoteId, primaryGuest: { fullName: "Rollback Guest", nickname: "Rollback Guest" }, freeStayReason: "Transaction rollback fixture", freeStayCategoryCode: "VOLUNTEER" } }, metadata("rollback-preview"));
    await sql.raw("CREATE OR REPLACE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced receipt failure'; END $$; CREATE TRIGGER force_receipt_failure BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION fail_receipt()").execute(db);
    await expect(confirmCommandPreview(db, principal, preview.preview.previewId, { propertyId: demo.propertyId, commandType: "CREATE_ORDER", confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: { code: "CREATE_STANDARD_ORDER", note: "" } }, metadata("rollback-confirm"))).rejects.toThrow(/forced receipt failure/);
    const orders = await db.selectFrom("orders").select("id").execute();
    const claims = await db.selectFrom("inventory_claims").select("id").execute();
    expect(orders).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });

  it("completes collection, shortening, referenced refund, check-in, and check-out on separate eligible orders", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = addDays(arrivalDate, 1);
    const created = await createOrder(demo.roomId, "journey", {
      member: true,
      arrival: arrivalDate,
      departure: addDays(departureDate, 1)
    });
    const orderId = created.result!.orderId as string;
    const firstCollection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 6_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-COLLECTION-ONE", note: "first installment" }
    }, "collection-one");
    await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 6_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-COLLECTION-TWO", note: "second installment" }
    }, "collection-two");
    const shortened = await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId, newArrivalDate: arrivalDate, newDepartureDate: departureDate }
    }, "shorten");
    expect(shortened.businessCommitted).toBe(true);
    const refund = await previewAndConfirm({
      commandType: "RECORD_REFUND",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 3_000, referencesFactId: firstCollection.factRefs[0], method: "BANK_TRANSFER", transactionReference: "TEST-TXN-REFUND-ONE", note: "referenced partial refund" }
    }, "refund");
    expect(refund.factRefs).toHaveLength(1);
    await previewAndConfirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "check-in");

    await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
    const checkoutArrivalDate = await propertyLocalToday(db, demo.propertyId);
    const checkoutCreated = await createOrder(demo.secondRoomId, "planned-check-out", {
      arrival: checkoutArrivalDate,
      departure: addDays(checkoutArrivalDate, 1)
    });
    const checkoutOrderId = checkoutCreated.result!.orderId as string;
    await previewAndConfirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: checkoutOrderId } }, "planned-check-out-check-in");
    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    await previewAndConfirm({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: checkoutOrderId } }, "check-out");

    const view = await getOrderView(db, orderId);
    expect(view.order.status).toBe("CHECKED_IN");
    expect(view.stay.status).toBe("IN_HOUSE");
    expect(view.pricingRevisions).toHaveLength(2);
    expect(view.collectionFacts).toHaveLength(3);
    expect(view.amounts).toEqual({
      currentContractAmount: { currency: "CNY", minorUnits: 0 },
      netRecordedCollection: { currency: "CNY", minorUnits: 9_000 },
      collectionDifference: { currency: "CNY", minorUnits: -9_000 },
      refundReferenceAmount: { currency: "CNY", minorUnits: 9_000 }
    });
    expect(view.coverageSet.some((item) => item.status === "CONSUMED")).toBe(true);
    expect(view.coverageSet.some((item) => item.status === "HELD")).toBe(false);
    const checkoutView = await getOrderView(db, checkoutOrderId);
    expect(checkoutView.order.status).toBe("CHECKED_OUT");
    expect(checkoutView.stay.status).toBe("COMPLETED");
    expect(checkoutView.fulfillment.state).toBe("CHECKED_OUT");
    expect(checkoutView.fulfillment.checkIn).not.toBeNull();
    expect(checkoutView.fulfillment.checkOut).not.toBeNull();
    expect(checkoutView.effectiveArrangement).toMatchObject({
      presentation: "LAST",
      arrivalDate: checkoutArrivalDate,
      departureDate: addDays(checkoutArrivalDate, 1)
    });
    expect(await db.selectFrom("inventory_claims").select("id")
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", view.segments.map((segment) => segment.id))
      .where("active", "=", true).execute()).toHaveLength(1);
    expect(await db.selectFrom("inventory_claims").select("id")
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", checkoutView.segments.map((segment) => segment.id))
      .where("active", "=", true).execute()).toHaveLength(0);
  });

  it("appends extension and move revisions while retaining the locked policy", async () => {
    const arrivalDate = addDays(await propertyLocalToday(db, demo.propertyId), 1);
    const originalDepartureDate = addDays(arrivalDate, 1);
    const moveDate = addDays(arrivalDate, 1);
    const extendedDepartureDate = addDays(arrivalDate, 3);
    const created = await createOrder(demo.roomId, "move", { stayType: "FREE", arrival: arrivalDate, departure: originalDepartureDate });
    const orderId = created.result!.orderId as string;
    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId, newArrivalDate: arrivalDate, newDepartureDate: extendedDepartureDate }
    }, "extend");
    await previewAndConfirm({ commandType: "MOVE_UNIT", input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: moveDate } }, "move");
    const view = await getOrderView(db, orderId);
    expect(view.segments).toHaveLength(3);
    expect(view.pricingRevisions).toHaveLength(3);
    expect(view.pricingRevisions.every((revision) => revision.policy_version_id === demo.freePolicyId)).toBe(true);
    expect(view.currentSegment.inventoryUnitId).toBe(demo.secondRoomId);
    const availability = await listAvailability(db, demo.propertyId, moveDate, extendedDepartureDate);
    expect(availability.find((unit) => unit.id === demo.roomId)?.available).toBe(true);
    expect(availability.find((unit) => unit.id === demo.secondRoomId)?.available).toBe(false);
    const moveTargetAvailability = await listAvailability(
      db,
      demo.propertyId,
      moveDate,
      extendedDepartureDate,
      undefined,
      orderId
    );
    expect(moveTargetAvailability.find((unit) => unit.id === demo.secondRoomId)?.available).toBe(true);
  });

  it("fails the order query closed when the immutable amendment chain no longer matches the order version", async () => {
    const created = await createOrder(demo.roomId, "damaged-lifecycle", { stayType: "FREE" });
    const orderId = created.result!.orderId as string;
    await db.updateTable("orders").set({ version: 2 }).where("id", "=", orderId).execute();

    await expect(getOrderView(db, orderId)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      statusCode: 500,
      retryable: false
    });
  });

  it("recalculates each service date from the active inventory timeline across repeated moves", async () => {
    const arrivalDate = addDays(await propertyLocalToday(db, demo.propertyId), 1);
    const day1 = addDays(arrivalDate, 1);
    const moveDate = addDays(arrivalDate, 2);
    const day3 = addDays(arrivalDate, 3);
    const shortenedDepartureDate = addDays(arrivalDate, 3);
    const departureDate = addDays(arrivalDate, 4);
    await previewAndConfirm({
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId, quantityDelta: 2, adjustmentReason: "Four-night timeline acceptance" }
    }, "timeline-adjust");
    const created = await createOrder(memberSourceUnitId, "timeline", { member: true, arrival: arrivalDate, departure: departureDate });
    const orderId = created.result!.orderId as string;
    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId, newArrivalDate: arrivalDate, newDepartureDate: shortenedDepartureDate }
    }, "timeline-shorten");

    let context = await loadOrderContext(db, orderId);
    expect(await loadActiveStayTimeline(db, context)).toEqual([
      { serviceDate: arrivalDate, inventoryUnitId: memberSourceUnitId },
      { serviceDate: day1, inventoryUnitId: memberSourceUnitId },
      { serviceDate: moveDate, inventoryUnitId: memberSourceUnitId }
    ]);
    let view = await getOrderView(db, orderId);
    let activeCoverage = view.coverageSet.filter((item) => item.status === "HELD");
    expect(activeCoverage).toHaveLength(3);
    expect(new Set(activeCoverage.map((item) => item.service_date)).size).toBe(3);
    expect(activeCoverage.find((item) => item.service_date === arrivalDate)?.inventory_unit_id).toBe(memberSourceUnitId);
    expect(activeCoverage.find((item) => item.service_date === moveDate)?.inventory_unit_id).toBe(memberSourceUnitId);

    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId, newArrivalDate: arrivalDate, newDepartureDate: departureDate }
    }, "timeline-extend");
    const movedToTarget = await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberTargetUnitId, effectiveDate: moveDate }
    }, "timeline-move-one");
    expect(movedToTarget).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    await previewAndConfirm({
      commandType: "REPRICE_ORDER",
      input: { propertyId: demo.propertyId, orderId, targetCurrentContractAmountMinor: 500 }
    }, "timeline-reprice");
    view = await getOrderView(db, orderId);
    expect(view.pricingRevisions.at(-1)?.manual_adjustment_minor).toBe(500);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(500);

    const movedBackToSource = await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: memberSourceUnitId, effectiveDate: moveDate }
    }, "timeline-move-two");
    expect(movedBackToSource).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    context = await loadOrderContext(db, orderId);
    expect(await loadActiveStayTimeline(db, context)).toEqual([
      { serviceDate: arrivalDate, inventoryUnitId: memberSourceUnitId },
      { serviceDate: day1, inventoryUnitId: memberSourceUnitId },
      { serviceDate: moveDate, inventoryUnitId: memberSourceUnitId },
      { serviceDate: day3, inventoryUnitId: memberSourceUnitId }
    ]);
    view = await getOrderView(db, orderId);
    activeCoverage = view.coverageSet.filter((item) => item.status === "HELD");
    expect(activeCoverage).toHaveLength(4);
    expect(new Set(activeCoverage.map((item) => item.service_date)).size).toBe(4);
    expect(activeCoverage.every((item) => item.inventory_unit_id === memberSourceUnitId)).toBe(true);
    expect(view.pricingRevisions.at(-1)?.manual_adjustment_minor).toBe(0);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(0);
    expect(view.pricingRevisions.every((revision) => revision.policy_version_id === demo.transientPolicyId)).toBe(true);
    expect(view.currentSegment.arrivalDate).toBe(moveDate);
    expect(view.originalArrangement).toEqual({
      arrivalDate,
      departureDate,
      intervals: [{ inventoryUnitId: memberSourceUnitId, arrivalDate, departureDate }]
    });
    expect(view.effectiveArrangement).toMatchObject({
      presentation: "CURRENT",
      arrivalDate,
      departureDate,
      intervals: [{ inventoryUnitId: memberSourceUnitId, arrivalDate, departureDate }]
    });
    expect(view.arrangementHistory.map((item) => item.type)).toEqual([
      "INITIAL_BOOKING", "RESCHEDULE", "RESCHEDULE", "MOVE", "MOVE"
    ]);
    for (const [index, interval] of view.effectiveArrangement.intervals.entries()) {
      expect(interval.departureDate > interval.arrivalDate).toBe(true);
      if (index > 0) expect(interval.arrivalDate).toBe(view.effectiveArrangement.intervals[index - 1]!.departureDate);
    }
  });

  it("crops a reserved multi-unit arrangement with Plan B while preserving the in-range unit", async () => {
    const arrivalDate = addDays(await propertyLocalToday(db, demo.propertyId), 1);
    const day1 = addDays(arrivalDate, 1);
    const moveDate = addDays(arrivalDate, 2);
    const departureDate = addDays(arrivalDate, 4);
    const croppedDepartureDate = addDays(arrivalDate, 2);
    const created = await createOrder(demo.roomId, "shorten-move-boundary", {
      stayType: "FREE",
      arrival: arrivalDate,
      departure: departureDate
    });
    const orderId = created.result!.orderId as string;
    await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: moveDate }
    }, "shorten-move-boundary-move");
    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId, newArrivalDate: arrivalDate, newDepartureDate: croppedDepartureDate }
    }, "reschedule-after-move-plan-b");
    const context = await loadOrderContext(db, orderId);
    expect(await loadActiveStayTimeline(db, context)).toEqual([
      { serviceDate: arrivalDate, inventoryUnitId: demo.roomId },
      { serviceDate: day1, inventoryUnitId: demo.roomId }
    ]);
    expect(context.currentSegment.inventoryUnitId).toBe(demo.roomId);
  });

  it("supports move and extension while checked in and rejects shortening on the arrival day", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const moveDate = addDays(arrivalDate, 1);
    const originalDepartureDate = addDays(arrivalDate, 3);
    const extendedDepartureDate = addDays(arrivalDate, 4);
    const created = await createOrder(demo.roomId, "checked-in-amendments", {
      stayType: "FREE",
      arrival: arrivalDate,
      departure: originalDepartureDate
    });
    const orderId = created.result!.orderId as string;
    await previewAndConfirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "checked-in-amendments-check-in");
    await previewAndConfirm({
      commandType: "MOVE_UNIT",
      input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate: moveDate }
    }, "checked-in-amendments-move");
    await previewAndConfirm({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: extendedDepartureDate }
    }, "checked-in-amendments-extend");
    await expect(createCommandPreview(db, principal, {
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: originalDepartureDate }
    }, metadata("checked-in-amendments-shorten-rejected"))).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "入住当天暂不办理缩短或提前退房；未实际使用房间时请使用后续的撤销入住流程"
    });
    const context = await loadOrderContext(db, orderId);
    expect(context.order.status).toBe("CHECKED_IN");
    expect(await loadActiveStayTimeline(db, context)).toEqual([
      { serviceDate: arrivalDate, inventoryUnitId: demo.roomId },
      { serviceDate: moveDate, inventoryUnitId: demo.secondRoomId },
      { serviceDate: addDays(arrivalDate, 2), inventoryUnitId: demo.secondRoomId },
      { serviceDate: addDays(arrivalDate, 3), inventoryUnitId: demo.secondRoomId }
    ]);
  });

  it("rejects impossible or timestamp MOVE effective dates as validation errors", async () => {
    const created = await createOrder(demo.roomId, "move-date-validation", { stayType: "FREE" });
    const orderId = created.result!.orderId as string;
    for (const effectiveDate of ["2026-02-30", "2026-07-22T00:00:00Z"]) {
      await expect(createCommandPreview(db, principal, {
        commandType: "MOVE_UNIT",
        input: { propertyId: demo.propertyId, orderId, newInventoryUnitId: demo.secondRoomId, effectiveDate }
      }, metadata("move-date-validation-denied"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect((await getOrderView(db, orderId)).segments).toHaveLength(1);
  });

  it("issues, rotates, and revokes only self-bound narrowed tokens", async () => {
    const issuedSecret = newOpaqueSecret("qtp");
    const issued = await previewAndConfirm({
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Acceptance token",
        accessCeiling: "READ",
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: issuedSecret
      }
    }, "issue-token");
    expect(issued.result).not.toHaveProperty("tokenSecret");
    const tokenId = issued.result!.tokenId as string;
    const replacementSecret = newOpaqueSecret("qtp");
    const rotated = await previewAndConfirm({
      commandType: "ROTATE_TOKEN",
      input: { propertyId: demo.propertyId, tokenId, tokenSecret: replacementSecret }
    }, "rotate-token");
    expect(rotated.result).not.toHaveProperty("tokenSecret");
    const newTokenId = rotated.result!.tokenId as string;
    const old = await db.selectFrom("api_tokens").selectAll().where("id", "=", tokenId).executeTakeFirstOrThrow();
    expect(old.revoked_at).not.toBeNull();
    expect(old.replaced_by_id).toBe(newTokenId);
    await previewAndConfirm({ commandType: "REVOKE_TOKEN", input: { propertyId: demo.propertyId, tokenId: newTokenId } }, "revoke-token");
    const replacement = await db.selectFrom("api_tokens").select("revoked_at").where("id", "=", newTokenId).executeTakeFirstOrThrow();
    expect(replacement.revoked_at).not.toBeNull();
  });

  it("expires only the available entitlement balance after the inclusive expiry date", async () => {
    const expirationLotId = "lot_core_expiration_acceptance";
    await db.insertInto("entitlement_lots").values({
      id: expirationLotId,
      contract_id: demo.memberContractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 5,
      expires_on: "2026-01-01",
      version: 1
    }).execute();

    await expect(createCommandPreview(db, principal, {
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: expirationLotId, asOfDate: "2026-01-01" }
    }, metadata("expire-on-inclusive-date"))).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });

    const stalePreview = await createCommandPreview(db, principal, {
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: expirationLotId, asOfDate: "2026-01-02" }
    }, metadata("expire-stale-preview"));
    expect(stalePreview.preview.effect).toMatchObject({
      entitlementLotId: expirationLotId,
      remainingAvailable: 5,
      quantityDelta: -5,
      asOfDate: "2026-01-02",
      entryType: "EXPIRE"
    });
    const storedStalePreview = await db.selectFrom("command_previews").select("basis_versions").where("id", "=", stalePreview.preview.previewId).executeTakeFirstOrThrow();
    expect(storedStalePreview.basis_versions).toMatchObject({ lotVersion: 1, contractVersion: 1, remainingAvailable: 5 });

    const winnerPreview = await createCommandPreview(db, principal, {
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: expirationLotId, asOfDate: "2026-01-02" }
    }, metadata("expire-winner-preview"));
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "EXPIRE_MEMBER_ENTITLEMENT" as const,
      confirmation: true as const,
      expectedEffectHash: winnerPreview.preview.effectHash,
      reason: { code: "ENTITLEMENT_EXPIRY", note: "Expire the available balance after lot expiry" }
    };
    const confirmMetadata = { idempotencyKey: "expire-success-confirm", correlationId: "expire-success-confirm" };
    const expired = await confirmCommandPreview(db, principal, winnerPreview.preview.previewId, confirmation, confirmMetadata);
    const replay = await confirmCommandPreview(db, principal, winnerPreview.preview.previewId, confirmation, confirmMetadata);
    expect(replay.receiptId).toBe(expired.receiptId);

    const staleResult = await confirmCommandPreview(db, principal, stalePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      confirmation: true,
      expectedEffectHash: stalePreview.preview.effectHash,
      reason: { code: "ENTITLEMENT_EXPIRY", note: "Confirm stale expiration preview" }
    }, metadata("expire-stale-confirm"));
    expect(staleResult).toMatchObject({ businessCommitted: false, error: { code: "PREVIEW_STALE" } });
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("lot_id", "=", expirationLotId).where("entry_type", "=", "EXPIRE").execute()).toHaveLength(1);

    expect(expired.result).toMatchObject({
      entitlementLotId: expirationLotId,
      contractId: demo.memberContractId,
      factId: expired.factRefs[0],
      entryType: "EXPIRE",
      expiredUnits: 5,
      remainingAvailable: 0,
      asOfDate: "2026-01-02"
    });
    expect(expired.resourceRefs).toEqual([demo.memberContractId, expirationLotId]);
    expect(expired.factRefs).toHaveLength(1);

    const fact = await db.selectFrom("entitlement_ledger").selectAll().where("fact_id", "=", expired.factRefs[0]!).executeTakeFirstOrThrow();
    expect(fact).toMatchObject({
      lot_id: expirationLotId,
      entry_type: "EXPIRE",
      quantity_delta: -5,
      service_date: null,
      order_id: null,
      coverage_id: null,
      reason: "ENTITLEMENT_EXPIRED asOfDate=2026-01-02"
    });
    const balance = await db.selectFrom("entitlement_lots")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.total_units",
        sql<number>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as integer)`.as("ledger_delta")
      ])
      .where("entitlement_lots.id", "=", expirationLotId)
      .groupBy("entitlement_lots.total_units")
      .executeTakeFirstOrThrow();
    expect(balance.total_units + Number(balance.ledger_delta)).toBe(0);
    const lot = await db.selectFrom("entitlement_lots").select("version").where("id", "=", expirationLotId).executeTakeFirstOrThrow();
    const contract = await db.selectFrom("member_contracts").select("version").where("id", "=", demo.memberContractId).executeTakeFirstOrThrow();
    expect(lot.version).toBe(2);
    expect(contract.version).toBe(2);
  });

  it("rejects integer command inputs outside PostgreSQL's safe integer range", async () => {
    await expect(createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: demo.roomLotId,
        quantityDelta: 2_147_483_648,
        adjustmentReason: "Out-of-range acceptance"
      }
    }, metadata("integer-range-denied"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("records a zero-quantity expiration marker and prevents release or adjustment from reviving the lot", async () => {
    const created = await createOrder(demo.roomId, "expire-held", { member: true, arrival: "2026-01-01", departure: "2026-01-03" });
    const orderId = created.result!.orderId as string;
    await db.updateTable("entitlement_lots")
      .set({ expires_on: "2026-01-02" })
      .where("id", "=", demo.roomLotId)
      .execute();
    const expired = await previewAndConfirm({
      commandType: "EXPIRE_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId, asOfDate: "2026-01-03" }
    }, "expire-held-marker");
    expect(expired.result).toMatchObject({ expiredUnits: 0, remainingAvailable: 0 });
    const marker = await db.selectFrom("entitlement_ledger").selectAll().where("fact_id", "=", expired.factRefs[0]!).executeTakeFirstOrThrow();
    expect(marker).toMatchObject({ entry_type: "EXPIRE", quantity_delta: 0 });

    await expect(createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId, quantityDelta: 1, adjustmentReason: "Must not revive expired lot" }
    }, metadata("expired-adjust-denied"))).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    const laterQuote = await quote(demo.secondRoomId, { member: true, arrival: "2026-01-04", departure: "2026-01-05" });
    expect(laterQuote.coverageSet).toHaveLength(0);
    expect(laterQuote.cashRemainder.minorUnits).toBe(12_000);

    await previewAndConfirm({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } }, "expire-held-cancel");
    const balance = await db.selectFrom("entitlement_lots")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select([
        "entitlement_lots.total_units",
        sql<number>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as integer)`.as("ledger_delta")
      ])
      .where("entitlement_lots.id", "=", demo.roomLotId)
      .groupBy("entitlement_lots.total_units")
      .executeTakeFirstOrThrow();
    expect(balance.total_units + Number(balance.ledger_delta)).toBe(0);
    const releaseExpirations = await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "=", demo.roomLotId).where("entry_type", "=", "EXPIRE").where("reason", "=", "RELEASE_AFTER_EXPIRY").execute();
    expect(releaseExpirations).toHaveLength(2);
    expect(releaseExpirations.every((entry) => entry.quantity_delta === -1)).toBe(true);
  });

  it("keeps a manual adjustment in one revision and does not inherit it", async () => {
    const arrivalDate = addDays(await propertyLocalToday(db, demo.propertyId), 1);
    const departureDate = addDays(arrivalDate, 3);
    const shortenedDepartureDate = addDays(arrivalDate, 2);
    const created = await createOrder(demo.roomId, "manual-adjustment", {
      arrival: arrivalDate,
      departure: departureDate
    });
    const orderId = created.result!.orderId as string;
    await previewAndConfirm({
      commandType: "REPRICE_ORDER",
      input: { propertyId: demo.propertyId, orderId, targetCurrentContractAmountMinor: 35_000 }
    }, "manual-reprice");
    let view = await getOrderView(db, orderId);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(35_000);
    expect(view.pricingRevisions.at(-1)?.manual_adjustment_minor).toBe(-1_000);
    await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: shortenedDepartureDate,
        targetCurrentContractAmountMinor: 24_000
      }
    }, "shorten-after-reprice");
    view = await getOrderView(db, orderId);
    expect(view.amounts.currentContractAmount.minorUnits).toBe(24_000);
    expect(view.pricingRevisions.at(-1)?.manual_adjustment_minor).toBe(0);
  });

  it("links each money fact to the pricing revision active when the fact was recorded", async () => {
    const created = await createOrder(demo.roomId, "money-revision-link");
    const orderId = created.result!.orderId as string;
    const initialRevisionId = (await getOrderView(db, orderId)).order.current_revision_id!;
    await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 5_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-BEFORE-REPRICE", note: "before repricing" }
    }, "money-before-reprice");
    await previewAndConfirm({
      commandType: "REPRICE_ORDER",
      input: { propertyId: demo.propertyId, orderId, targetCurrentContractAmountMinor: 35_000 }
    }, "money-reprice");
    const repricedRevisionId = (await getOrderView(db, orderId)).order.current_revision_id!;
    expect(repricedRevisionId).not.toBe(initialRevisionId);
    await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 6_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-AFTER-REPRICE", note: "after repricing" }
    }, "money-after-reprice");

    const facts = (await getOrderView(db, orderId)).collectionFacts;
    expect(facts.map((fact) => ({ reference: fact.transaction_reference, revisionId: fact.pricing_revision_id }))).toEqual([
      { reference: "TEST-TXN-BEFORE-REPRICE", revisionId: initialRevisionId },
      { reference: "TEST-TXN-AFTER-REPRICE", revisionId: repricedRevisionId }
    ]);

    await expect(sql`
      INSERT INTO collection_facts (
        fact_id, order_id, fact_type, amount_minor, net_effect_minor, currency,
        references_fact_id, reverses_fact_id, method, note, transaction_reference,
        pricing_revision_id, command_id
      ) VALUES (
        'fact_missing_pricing_revision', ${orderId}, 'COLLECTION', 1, 1, 'CNY',
        NULL, NULL, 'CASH', 'must reject missing revision', NULL,
        NULL, 'command_missing_pricing_revision'
      )
    `.execute(db)).rejects.toMatchObject({ constraint: "collection_facts_new_pricing_revision_required" });

    const otherCreated = await createOrder(demo.secondRoomId, "money-cross-order-revision");
    const otherOrderId = otherCreated.result!.orderId as string;
    const otherRevisionId = (await getOrderView(db, otherOrderId)).order.current_revision_id!;
    await expect(sql`
      INSERT INTO collection_facts (
        fact_id, order_id, fact_type, amount_minor, net_effect_minor, currency,
        references_fact_id, reverses_fact_id, method, note, transaction_reference,
        pricing_revision_id, command_id
      ) VALUES (
        'fact_cross_order_pricing_revision', ${orderId}, 'COLLECTION', 1, 1, 'CNY',
        NULL, NULL, 'CASH', 'must reject cross-order revision', NULL,
        ${otherRevisionId}, 'command_cross_order_pricing_revision'
      )
    `.execute(db)).rejects.toMatchObject({ constraint: "collection_facts_pricing_revision_order_fk" });
  });

  it("uses operator-selected collection methods for direct orders and forbids per-order funds on external channels", async () => {
    const wecomQuote = await quote(demo.roomId, { arrival: "2026-09-01", departure: "2026-09-02" });
    const wecomCreated = await previewAndConfirm({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: wecomQuote.quoteId,
        primaryGuest: { fullName: "WECOM Method Guard", nickname: "WECOM Guard" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: wecomQuote.currentContractAmount.minorUnits
      }
    }, "wecom-method-order");
    const wecomOrderId = wecomCreated.result!.orderId as string;
    const wecomCollection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: wecomOrderId,
        amountMinor: 5_000,
        method: "CASH",
        note: "cash collection by operator"
      }
    }, "wecom-collection");
    await previewAndConfirm({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: wecomOrderId,
        referencesFactId: wecomCollection.factRefs[0],
        amountMinor: 1_000,
        method: "BANK_TRANSFER",
        transactionReference: "TEST-TXN-WECOM-REFUND-BANK",
        note: "bank transfer refund reason"
      }
    }, "wecom-refund-bank");

    const externalCreated = await createOrder(demo.secondRoomId, "external-method-guard", {
      arrival: "2026-09-01",
      departure: "2026-09-02",
      bookingChannelCode: "YOUMUDAO"
    });
    const externalOrderId = externalCreated.result!.orderId as string;
    await expect(createCommandPreview(db, principal, {
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: externalOrderId,
        amountMinor: 5_000,
        method: "WECOM",
        transactionReference: "TEST-TXN-EXTERNAL-WECOM-REJECT"
      }
    }, metadata("external-wecom-reject"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "外部渠道订单不在 PMS 登记单笔收款或退款；请核对渠道订单号和本单渠道应结金额，由财务按渠道总账核对。"
    });
  });

  it("uses the shared inventory path for maintenance and releases cancellation/no-show claims", async () => {
    const locked = await previewAndConfirm({
      commandType: "LOCK_MAINTENANCE",
      input: { propertyId: demo.propertyId, inventoryUnitId: demo.roomId, arrivalDate: "2026-07-21", departureDate: "2026-07-23", reason: "Planned electrical inspection" }
    }, "maintenance-lock");
    let availability = await listAvailability(db, demo.propertyId, "2026-07-21", "2026-07-23");
    expect(availability.find((unit) => unit.id === demo.bedAId)?.available).toBe(false);
    await previewAndConfirm({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId: locked.result!.maintenanceLockId }
    }, "maintenance-release");
    availability = await listAvailability(db, demo.propertyId, "2026-07-21", "2026-07-23");
    expect(availability.find((unit) => unit.id === demo.bedAId)?.available).toBe(true);

    const cancelled = await createOrder(demo.roomId, "cancel", { member: true });
    const cancelledOrderId = cancelled.result!.orderId as string;
    await previewAndConfirm({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: cancelledOrderId } }, "cancel");
    const cancelledView = await getOrderView(db, cancelledOrderId);
    expect(cancelledView.order.status).toBe("CANCELLED");
    expect(cancelledView.coverageSet.every((item) => item.status === "RELEASED")).toBe(true);
    expect(cancelledView.fulfillment.state).toBe("CANCELLED");
    expect(cancelledView.effectiveArrangement.presentation).toBe("BEFORE_CANCELLATION");
    expect(cancelledView.effectiveArrangement.intervals).toEqual(cancelledView.originalArrangement.intervals);

    const noShow = await createOrder(demo.secondRoomId, "no-show", { stayType: "FREE" });
    const noShowOrderId = noShow.result!.orderId as string;
    await previewAndConfirm({ commandType: "MARK_NO_SHOW", input: { propertyId: demo.propertyId, orderId: noShowOrderId } }, "no-show");
    const noShowView = await getOrderView(db, noShowOrderId);
    expect(noShowView.order.status).toBe("NO_SHOW");
    expect(noShowView.fulfillment.state).toBe("NO_SHOW");
    expect(noShowView.effectiveArrangement.presentation).toBe("NO_SHOW_ORDER");
    expect(noShowView.effectiveArrangement.intervals).toEqual(noShowView.originalArrangement.intervals);
    expect(await db.selectFrom("inventory_claims").select("id").where("active", "=", true).execute()).toHaveLength(0);
  });

  it("reverses a collection without overwriting the original fact", async () => {
    const created = await createOrder(demo.roomId, "reversal", { stayType: "FREE" });
    const orderId = created.result!.orderId as string;
    const collection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 5_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-REVERSAL-SOURCE", note: "recorded manually" }
    }, "reversal-collection");
    await previewAndConfirm({
      commandType: "REVERSE_FACT",
      input: { propertyId: demo.propertyId, orderId, reversesFactId: collection.factRefs[0], note: "duplicate entry" }
    }, "reversal");
    const view = await getOrderView(db, orderId);
    expect(view.collectionFacts).toHaveLength(2);
    expect(view.collectionFacts[0]?.fact_type).toBe("COLLECTION");
    expect(view.collectionFacts[1]?.fact_type).toBe("REVERSAL");
    expect(view.amounts.netRecordedCollection.minorUnits).toBe(0);
  });

  it("rejects refunds of reversed collections and reversal of collections with active refunds", async () => {
    const reversedOrder = await createOrder(demo.roomId, "refund-after-reversal", { stayType: "FREE" });
    const reversedOrderId = reversedOrder.result!.orderId as string;
    const reversedCollection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId: reversedOrderId, amountMinor: 5_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-REFUND-AFTER-REVERSAL-SOURCE", note: "to reverse" }
    }, "refund-after-reversal-collection");
    await previewAndConfirm({
      commandType: "REVERSE_FACT",
      input: { propertyId: demo.propertyId, orderId: reversedOrderId, reversesFactId: reversedCollection.factRefs[0], note: "reversed first" }
    }, "refund-after-reversal-reverse");
    await expect(createCommandPreview(db, principal, {
      commandType: "RECORD_REFUND",
      input: { propertyId: demo.propertyId, orderId: reversedOrderId, referencesFactId: reversedCollection.factRefs[0], amountMinor: 1_000, method: "CASH", note: "attempt refund after reversal" }
    }, metadata("refund-after-reversal-denied"))).rejects.toMatchObject({ code: "FACT_ALREADY_REVERSED" });

    const refundedOrder = await createOrder(demo.secondRoomId, "reversal-after-refund", { stayType: "FREE" });
    const refundedOrderId = refundedOrder.result!.orderId as string;
    const refundedCollection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId: refundedOrderId, amountMinor: 5_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-REFUNDED-COLLECTION", note: "partially refunded" }
    }, "reversal-after-refund-collection");
    await previewAndConfirm({
      commandType: "RECORD_REFUND",
      input: { propertyId: demo.propertyId, orderId: refundedOrderId, referencesFactId: refundedCollection.factRefs[0], amountMinor: 1_000, method: "CASH", note: "partial cash refund" }
    }, "reversal-after-refund-refund");
    await expect(createCommandPreview(db, principal, {
      commandType: "REVERSE_FACT",
      input: { propertyId: demo.propertyId, orderId: refundedOrderId, reversesFactId: refundedCollection.factRefs[0], note: "must reverse refund first" }
    }, metadata("reversal-after-refund-denied"))).rejects.toMatchObject({ code: "REFUND_LIMIT_EXCEEDED" });
    const facts = (await getOrderView(db, refundedOrderId)).collectionFacts;
    expect(facts.map((fact) => fact.fact_type)).toEqual(["COLLECTION", "REFUND"]);
  });

  it("serializes a concurrent refund and reversal of the same collection fact", async () => {
    const created = await createOrder(demo.roomId, "refund-reversal-race", { stayType: "FREE" });
    const orderId = created.result!.orderId as string;
    const collection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 5_000, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-REFUND-REVERSAL-RACE-SOURCE", note: "race source" }
    }, "refund-reversal-race-collection");
    const factId = collection.factRefs[0]!;
    const [refundPreview, reversalPreview] = await Promise.all([
      createCommandPreview(db, principal, {
        commandType: "RECORD_REFUND",
        input: { propertyId: demo.propertyId, orderId, referencesFactId: factId, amountMinor: 1_000, method: "CASH", note: "concurrent cash refund" }
      }, metadata("refund-reversal-race-refund-preview")),
      createCommandPreview(db, principal, {
        commandType: "REVERSE_FACT",
        input: { propertyId: demo.propertyId, orderId, reversesFactId: factId, note: "concurrent correction" }
      }, metadata("refund-reversal-race-reversal-preview"))
    ]);
    const outcomes = await within(Promise.allSettled([
      confirmCommandPreview(db, principal, refundPreview.preview.previewId, {
        propertyId: demo.propertyId, commandType: "RECORD_REFUND",
        confirmation: true,
        expectedEffectHash: refundPreview.preview.effectHash,
        reason: { code: "CONCURRENCY_TEST", note: "Concurrent refund" }
      }, metadata("refund-reversal-race-refund-confirm")),
      confirmCommandPreview(db, principal, reversalPreview.preview.previewId, {
        propertyId: demo.propertyId, commandType: "REVERSE_FACT",
        confirmation: true,
        expectedEffectHash: reversalPreview.preview.effectHash,
        reason: { code: "CONCURRENCY_TEST", note: "Concurrent reversal" }
      }, metadata("refund-reversal-race-reversal-confirm"))
    ]), 5_000);
    const committed = outcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value.businessCommitted ? [outcome.value] : []);
    expect(committed).toHaveLength(1);
    const rejectedCodes = outcomes.flatMap((outcome) => {
      if (outcome.status === "fulfilled") return outcome.value.businessCommitted ? [] : [outcome.value.error?.code];
      const reason = outcome.reason as { code?: string };
      return [reason.code];
    });
    expect(rejectedCodes).toHaveLength(1);
    expect(["PREVIEW_STALE", "FACT_ALREADY_REVERSED", "REFUND_LIMIT_EXCEEDED"]).toContain(rejectedCodes[0]);
    const facts = await db.selectFrom("collection_facts").select("fact_type").where("order_id", "=", orderId).execute();
    expect(facts).toHaveLength(2);
    expect(facts.filter((fact) => fact.fact_type === "REFUND" || fact.fact_type === "REVERSAL")).toHaveLength(1);
  });

  it("enforces pricing, guest snapshot, revision, and fact immutability in PostgreSQL", async () => {
    const created = await createOrder(demo.roomId, "immutable", { stayType: "FREE" });
    const orderId = created.result!.orderId as string;
    const collection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 100, method: "BANK_TRANSFER", transactionReference: "TEST-TXN-IMMUTABLE", note: "immutable fact" }
    }, "immutable-collection");
    await expect(db.updateTable("pricing_policy_versions").set({ nightly_rate_minor: 1 }).where("id", "=", demo.freePolicyId).execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable("orders").set({ primary_guest_snapshot: { fullName: "Changed" } }).where("id", "=", orderId).execute()).rejects.toThrow(/immutable/);
    const view = await getOrderView(db, orderId);
    await expect(db.updateTable("pricing_revisions").set({ current_contract_amount_minor: 999 }).where("id", "=", view.order.current_revision_id!).execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable("collection_facts").set({ amount_minor: 999 }).where("fact_id", "=", collection.factRefs[0]!).execute()).rejects.toThrow(/append-only/);
  });

  it("persists deterministic recovery states and reports only an actively locked command as unknown", async () => {
    const priced = await quote(demo.roomId, { stayType: "FREE" });
    const preview = await createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: { propertyId: demo.propertyId, quoteId: priced.quoteId, primaryGuest: { fullName: "Recovery Guest", nickname: "Recovery Guest" }, freeStayReason: "Command recovery fixture", freeStayCategoryCode: "VOLUNTEER" }
    }, { idempotencyKey: "recovery-preview", correlationId: "recovery" });
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER" as const,
      confirmation: true as const,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    };
    const first = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, { idempotencyKey: "recovery-confirm", correlationId: "recovery" });
    const replay = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, { idempotencyKey: "recovery-confirm", correlationId: "recovery" });
    expect(replay.receiptId).toBe(first.receiptId);
    await expect(confirmCommandPreview(db, principal, preview.preview.previewId, { ...confirmation, expectedEffectHash: `${confirmation.expectedEffectHash}-different` }, { idempotencyKey: "recovery-confirm", correlationId: "recovery" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await findCommandResult(db, principal, demo.propertyId, "CREATE_ORDER", "recovery-confirm")).toMatchObject({ executionStatus: "EXECUTED", receiptId: first.receiptId });
    expect(await findCommandResult(db, principal, demo.propertyId, "CREATE_ORDER", "never-executed")).toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });

    const recoveryCommandType = "CHECK_IN";
    const recoveryIdempotencyKey = "recovery-unknown";
    const lockKey = `qintopia:command:${principal.subjectId}:${demo.propertyId}:${recoveryCommandType}:${recoveryIdempotencyKey}`;
    let releaseLock!: () => void;
    let reportLockAcquired!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockAcquired = new Promise<void>((resolve) => { reportLockAcquired = resolve; });
    const lockOwner = db.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
      reportLockAcquired();
      await releaseGate;
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    });
    await lockAcquired;

    try {
      expect(await findCommandResult(db, principal, demo.propertyId, recoveryCommandType, recoveryIdempotencyKey))
        .toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
    } finally {
      releaseLock();
    }
    await lockOwner;
    expect(await findCommandResult(db, principal, demo.propertyId, recoveryCommandType, recoveryIdempotencyKey))
      .toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
  });
});
