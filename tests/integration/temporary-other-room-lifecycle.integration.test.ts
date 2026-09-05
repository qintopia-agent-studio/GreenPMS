import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto, StoredQuoteDto } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, getOrderView, propertyLocalToday, withMutablePropertyWallClockForTesting, withPropertyClockForTesting, type Database } from "@qintopia/db";
import type { Kysely } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.TEMPORARY_OTHER_ROOM_LIFECYCLE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_temporary_other_room_lifecycle";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

const productId = "membership_product_shared_bath_single_v1";

type Arrangement = NonNullable<StoredQuoteDto["temporaryOtherRoomArrangement"]>;

let db: Kysely<Database>;
let sequence = 0;
let memberSequence = 0;

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const prepared = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "TEMPORARY_OTHER_ROOM", note: `现场安排 ${prefix}` }
      : { code: "TEMPORARY_OTHER_ROOM_LIFECYCLE", note: `核对 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMember(memberId: string) {
  memberSequence += 1;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `TEMP-LIFECYCLE-${memberSequence}`,
    nickname: `Lifecycle ${memberSequence}`,
    full_name: `Temporary lifecycle ${memberSequence}`,
    phone: `139${String(memberSequence).padStart(8, "0")}`,
    wechat: `temporary-lifecycle-${memberSequence}`
  }).execute();
  await db.insertInto("member_property_links").values({ member_id: memberId, property_id: demo.propertyId }).execute();
}

async function activateProduct(memberId: string, prefix: string) {
  const order = await confirm({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, memberId, membershipProductId: productId, agreedPriceMinor: 162_000 }
  }, `${prefix}-membership-order`);
  const membershipOrderId = order.result!.membershipOrderId as string;
  await confirm({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor: 1, transactionReference: `LIFECYCLE-${prefix}` }
  }, `${prefix}-membership-payment`);
  const activation = await confirm({
    commandType: "ACTIVATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, membershipOrderId }
  }, `${prefix}-membership-activate`);
  return {
    membershipOrderId,
    contractId: activation.result!.contractId as string,
    lotId: activation.result!.entitlementLotId as string
  };
}

async function unitId(code: string): Promise<string> {
  return (await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow()).id;
}

async function createTemporaryOrder(options: {
  memberId: string;
  arrivalDate: string;
  departureDate: string;
  unitCode: string;
  prefix: string;
}): Promise<{ orderId: string; arrangement: Arrangement; createAmendmentId: string; actualUnitId: string }> {
  const actualUnitId = await unitId(options.unitCode);
  const quoted = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: actualUnitId,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberId: options.memberId,
    temporaryOtherRoom: true
  } as Parameters<typeof createQuoteForTesting>[1]) as StoredQuoteDto;
  const arrangement = quoted.temporaryOtherRoomArrangement;
  if (!arrangement) throw new Error("Temporary quote did not include its server arrangement snapshot");
  const receipt = await confirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quoted.quoteId,
      primaryGuest: { fullName: `临时安排 ${options.prefix}`, nickname: options.prefix },
      temporaryOtherRoomReason: `现场安排 ${options.prefix}`
    }
  }, options.prefix);
  expect(receipt).toMatchObject({ businessCommitted: true, result: { temporaryOtherRoomArrangement: arrangement } });
  const orderId = receipt.result!.orderId as string;
  const createAmendment = await db.selectFrom("amendments")
    .select(["id", "payload"])
    .where("order_id", "=", orderId)
    .where("amendment_type", "=", "CREATE_ORDER")
    .executeTakeFirstOrThrow();
  expect(createAmendment.payload).toMatchObject({ temporaryOtherRoomArrangement: arrangement });
  return { orderId, arrangement, createAmendmentId: createAmendment.id, actualUnitId };
}

async function arrangementSnapshot(orderId: string) {
  const create = await db.selectFrom("amendments")
    .select(["id", "payload"])
    .where("order_id", "=", orderId)
    .where("amendment_type", "=", "CREATE_ORDER")
    .executeTakeFirstOrThrow();
  return {
    createAmendmentId: create.id,
    arrangement: (create.payload as Record<string, unknown>).temporaryOtherRoomArrangement,
    amendments: await db.selectFrom("amendments")
      .select(["id", "amendment_type", "payload"])
      .where("order_id", "=", orderId)
      .orderBy("sequence")
      .execute()
  };
}

async function businessFacts(orderId: string) {
  const [coverage, claims, ledger, contract, lot] = await Promise.all([
    db.selectFrom("coverage_items").select(["id", "service_date", "inventory_unit_id", "status", "lot_id"]).where("order_id", "=", orderId).orderBy("service_date").execute(),
    db.selectFrom("inventory_claims").innerJoin("stay_segments", "stay_segments.id", "inventory_claims.source_id")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select(["inventory_claims.id", "inventory_claims.service_date", "inventory_claims.inventory_unit_id", "inventory_claims.active"])
      .where("stays.order_id", "=", orderId)
      .orderBy("inventory_claims.service_date").execute(),
    db.selectFrom("entitlement_ledger").select(["fact_id", "entry_type", "quantity_delta", "service_date", "coverage_id"]).where("order_id", "=", orderId).orderBy("fact_id").execute(),
    db.selectFrom("orders").innerJoin("member_contracts", "member_contracts.id", "orders.member_contract_id")
      .select("member_contracts.version as version").where("orders.id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("orders").innerJoin("entitlement_lots", "entitlement_lots.contract_id", "orders.member_contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.version"]).where("orders.id", "=", orderId).executeTakeFirstOrThrow()
  ]);
  return { coverage, claims, ledger, contractVersion: contract.version, lotId: lot.id, lotVersion: lot.version };
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db?.destroy();
});

describe("temporary other-room lifecycle boundaries", () => {
  it("keeps the immutable creation arrangement through CHECK_IN and CHECK_OUT", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 2);
    const departureDate = shiftDate(arrivalDate, 2);
    const memberId = "member_temporary_lifecycle_fulfillment";
    await createMember(memberId);
    await activateProduct(memberId, "fulfillment");
    const created = await createTemporaryOrder({
      memberId,
      arrivalDate,
      departureDate,
      unitCode: "B01",
      prefix: "temporary-lifecycle-fulfillment"
    });
    const initial = await arrangementSnapshot(created.orderId);
    const { checkIn, checkOut } = await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), () =>
      withMutablePropertyWallClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), async (wallClock) => {
        const checkedIn = await confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: created.orderId } }, "temporary-lifecycle-check-in");
        wallClock.set(new Date(`${departureDate}T12:00:00.000Z`));
        const checkedOut = await withPropertyClockForTesting(new Date(`${departureDate}T12:00:00.000Z`), () =>
          confirm({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: created.orderId } }, "temporary-lifecycle-check-out"));
        return { checkIn: checkedIn, checkOut: checkedOut };
      }));
    expect(checkIn).toMatchObject({ businessCommitted: true, result: { temporaryOtherRoomArrangement: created.arrangement } });
    expect(checkOut).toMatchObject({ businessCommitted: true, result: { temporaryOtherRoomArrangement: created.arrangement } });
    const after = await arrangementSnapshot(created.orderId);
    expect(after.createAmendmentId).toBe(initial.createAmendmentId);
    expect(after.arrangement).toEqual(initial.arrangement);
    expect(after.amendments.filter((amendment) => amendment.amendment_type === "CREATE_ORDER")).toHaveLength(1);
    expect((await getOrderView(db, created.orderId)).amendments.find((amendment) => amendment.id === initial.createAmendmentId)?.payload)
      .toMatchObject({ temporaryOtherRoomArrangement: created.arrangement });
  });

  it.each([
    { label: "left crop", arrivalOffset: 1, departureOffset: 0, unitCode: "B01" },
    { label: "right crop", arrivalOffset: 0, departureOffset: -1, unitCode: "B02" },
    { label: "both-edge crop", arrivalOffset: 1, departureOffset: -1, unitCode: "C01" }
  ])("allows a RESERVED strict non-empty subset for $label and preserves retained facts", async ({ arrivalOffset, departureOffset, unitCode }) => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 12);
    const departureDate = shiftDate(arrivalDate, 5);
    const memberId = `member_temporary_lifecycle_crop_${unitCode.toLowerCase()}`;
    await createMember(memberId);
    await activateProduct(memberId, `crop-${unitCode}`);
    const created = await createTemporaryOrder({ memberId, arrivalDate, departureDate, unitCode, prefix: `temporary-lifecycle-crop-${unitCode}` });
    const before = await businessFacts(created.orderId);
    const rescheduledArrival = shiftDate(arrivalDate, arrivalOffset);
    const rescheduledDeparture = shiftDate(departureDate, departureOffset);
    const receipt = await confirm({
      commandType: "RESCHEDULE_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newArrivalDate: rescheduledArrival, newDepartureDate: rescheduledDeparture }
    }, `temporary-lifecycle-reschedule-${unitCode}`);
    expect(receipt).toMatchObject({ businessCommitted: true, result: { temporaryOtherRoomArrangement: created.arrangement } });

    const after = await businessFacts(created.orderId);
    const retainedDates = before.coverage.map((item) => item.service_date).filter((date) => date >= rescheduledArrival && date < rescheduledDeparture);
    const releasedDates = before.coverage.map((item) => item.service_date).filter((date) => !retainedDates.includes(date));
    expect(after.coverage.filter((item) => retainedDates.includes(item.service_date)))
      .toEqual(before.coverage.filter((item) => retainedDates.includes(item.service_date)));
    expect(after.coverage.filter((item) => releasedDates.includes(item.service_date)))
      .toEqual(expect.arrayContaining(releasedDates.map((serviceDate) => expect.objectContaining({ service_date: serviceDate, status: "RELEASED" }))));
    expect(after.claims.filter((claim) => claim.active).map((claim) => ({ serviceDate: claim.service_date, unitId: claim.inventory_unit_id })))
      .toEqual(retainedDates.map((serviceDate) => ({ serviceDate, unitId: created.actualUnitId })));
    expect(after.ledger.filter((entry) => entry.entry_type === "RELEASE").map((entry) => entry.service_date).sort())
      .toEqual([...releasedDates].sort());
    expect(await arrangementSnapshot(created.orderId)).toMatchObject({
      createAmendmentId: created.createAmendmentId,
      arrangement: created.arrangement
    });
  });

  it("rejects unchanged, empty, shifted, and expanded RESERVED reschedules without changing temporary facts", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 18);
    const departureDate = shiftDate(arrivalDate, 4);
    const memberId = "member_temporary_lifecycle_reject_dates";
    await createMember(memberId);
    await activateProduct(memberId, "reject-dates");
    const created = await createTemporaryOrder({ memberId, arrivalDate, departureDate, unitCode: "B01", prefix: "temporary-lifecycle-reject-dates" });
    const before = await businessFacts(created.orderId);
    for (const [label, newArrivalDate, newDepartureDate] of [
      ["unchanged", arrivalDate, departureDate],
      ["empty", shiftDate(arrivalDate, 2), shiftDate(arrivalDate, 2)],
      ["shifted", shiftDate(arrivalDate, 1), shiftDate(departureDate, 1)],
      ["expanded", arrivalDate, shiftDate(departureDate, 1)]
    ]) {
      await expect(preview({
        commandType: "RESCHEDULE_STAY",
        input: { propertyId: demo.propertyId, orderId: created.orderId, newArrivalDate, newDepartureDate }
      }, `temporary-lifecycle-reject-${label}`)).rejects.toMatchObject({ code: expect.any(String) });
      expect(await businessFacts(created.orderId)).toEqual(before);
    }
  });

  it("only tail-shortens an in-house temporary order and never restores or releases its consumed entitlement", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const setupDate = shiftDate(today, -2);
    const arrivalDate = shiftDate(today, -1);
    const departureDate = shiftDate(today, 3);
    const newDepartureDate = shiftDate(today, 1);
    const memberId = "member_temporary_lifecycle_shorten";
    await createMember(memberId);
    const { created, shortened, before } = await withMutablePropertyWallClockForTesting(new Date(`${setupDate}T12:00:00.000Z`), async (wallClock) => {
      const prepared = await withPropertyClockForTesting(new Date(`${setupDate}T12:00:00.000Z`), async () => {
        await activateProduct(memberId, "shorten");
        return createTemporaryOrder({
          memberId,
          arrivalDate,
          departureDate,
          unitCode: "B01",
          prefix: "temporary-lifecycle-shorten"
        });
      });
      wallClock.set(new Date(`${arrivalDate}T12:00:00.000Z`));
      await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), () =>
        confirm({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: prepared.orderId } }, "temporary-lifecycle-shorten-check-in"));
      const snapshotBeforeShorten = await businessFacts(prepared.orderId);
      wallClock.set(new Date(`${today}T12:00:00.000Z`));
      const receipt = await withPropertyClockForTesting(new Date(`${today}T12:00:00.000Z`), () => confirm({
        commandType: "SHORTEN_STAY",
        input: { propertyId: demo.propertyId, orderId: prepared.orderId, newDepartureDate }
      }, "temporary-lifecycle-shorten-command"));
      return { created: prepared, shortened: receipt, before: snapshotBeforeShorten };
    });
    expect(before.coverage.every((item) => item.status === "CONSUMED")).toBe(true);
    expect(shortened, JSON.stringify(shortened, null, 2))
      .toMatchObject({ businessCommitted: true, result: { temporaryOtherRoomArrangement: created.arrangement } });
    const after = await businessFacts(created.orderId);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.contractVersion).toBe(before.contractVersion);
    expect(after.lotVersion).toBe(before.lotVersion);
    expect(after.claims.filter((claim) => claim.active).map((claim) => claim.service_date))
      .toEqual([arrivalDate, today]);
    expect(after.ledger.some((entry) => entry.entry_type === "RESTORE" || entry.entry_type === "RELEASE")).toBe(false);
    expect((await arrangementSnapshot(created.orderId)).arrangement).toEqual(created.arrangement);
  });

  it("fails closed for extending, moving, repricing, refreshing coverage, and recording funds", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 24);
    const departureDate = shiftDate(arrivalDate, 3);
    const memberId = "member_temporary_lifecycle_closed";
    await createMember(memberId);
    await activateProduct(memberId, "closed");
    const created = await createTemporaryOrder({ memberId, arrivalDate, departureDate, unitCode: "B01", prefix: "temporary-lifecycle-closed" });
    const before = await businessFacts(created.orderId);
    const rejected: CommandEnvelope[] = [
      { commandType: "EXTEND_STAY", input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(departureDate, 1) } },
      { commandType: "MOVE_UNIT", input: { propertyId: demo.propertyId, orderId: created.orderId, newInventoryUnitId: await unitId("B02"), effectiveDate: shiftDate(arrivalDate, 1) } },
      { commandType: "REPRICE_ORDER", input: { propertyId: demo.propertyId, orderId: created.orderId, targetCurrentContractAmountMinor: 0 } },
      { commandType: "REFRESH_MEMBER_COVERAGE", input: { propertyId: demo.propertyId, orderId: created.orderId } },
      { commandType: "RECORD_COLLECTION", input: { propertyId: demo.propertyId, orderId: created.orderId, amountMinor: 100, method: "CASH", cashCollector: "临时安排测试", note: "不得收款" } }
    ];
    for (const envelope of rejected) {
      await expect(preview(envelope, `temporary-lifecycle-closed-${envelope.commandType}`)).rejects.toMatchObject({ code: expect.any(String) });
      expect(await businessFacts(created.orderId)).toEqual(before);
    }
  });
});
