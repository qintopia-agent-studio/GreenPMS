import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto, StoredQuoteDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  executeQuoteCommand,
  getOrderView,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.TEMPORARY_OTHER_ROOM_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_temporary_other_room";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

const administratorPrincipal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Demo Administrator",
  ...authScope({ profile: "administrator" })
};

const products = {
  sharedSingle: "membership_product_shared_bath_single_v1",
  privateSingle: "membership_product_private_bath_single_v1",
  sharedQuad: "membership_product_shared_bath_quad_v1"
} as const;

type TemporaryArrangement = {
  kind: "TEMPORARY_OTHER_ROOM";
  membershipOrderId: string;
  memberContractId: string;
  entitlementLotId: string;
  originalRoomTypeCode: string;
  originalInventoryKind: "ROOM";
  entitlementUnitKind: "ROOM_NIGHT";
  actualInventoryUnitId: string;
  actualRoomTypeCode: string;
  actualInventoryKind: "ROOM";
  arrivalDate: string;
  departureDate: string;
};

type TemporaryQuote = StoredQuoteDto & {
  temporaryOtherRoomArrangement?: TemporaryArrangement;
};

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

async function command(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "TEMPORARY_OTHER_ROOM_TEST", note: `确认 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMember(memberId: string) {
  memberSequence += 1;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `TEMP-${memberId.toUpperCase()}`,
    nickname: `Temp ${memberSequence}`,
    full_name: `Temporary ${memberSequence}`,
    phone: `138${String(memberSequence).padStart(8, "0")}`,
    wechat: `temporary-${memberSequence}`
  }).execute();
  await db.insertInto("member_property_links").values({ member_id: memberId, property_id: demo.propertyId }).execute();
}

async function activateProduct(memberId: string, productId: string, prefix: string) {
  const order = await command({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: productId,
      agreedPriceMinor: productId === products.sharedQuad ? 93_600 : productId === products.privateSingle ? 216_000 : 162_000
    }
  }, `${prefix}-order`);
  const membershipOrderId = order.result!.membershipOrderId as string;
  await command({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor: 1, transactionReference: `TEMP-${prefix}` }
  }, `${prefix}-payment`);
  const activation = await command({
    commandType: "ACTIVATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, membershipOrderId }
  }, `${prefix}-activation`);
  return {
    membershipOrderId,
    contractId: activation.result!.contractId as string,
    lotId: activation.result!.entitlementLotId as string
  };
}

async function insertSecondActiveRoomSource(
  sourceMembershipOrderId: string,
  prefix: string,
  options?: { productId?: string; validFrom?: string; validUntil?: string }
) {
  const source = await db.selectFrom("membership_orders")
    .selectAll()
    .where("id", "=", sourceMembershipOrderId)
    .executeTakeFirstOrThrow();
  if (!source.valid_from || !source.valid_until) throw new Error("Active test membership is missing its validity interval");
  const product = options?.productId
    ? await db.selectFrom("membership_products").selectAll().where("id", "=", options.productId).executeTakeFirstOrThrow()
    : undefined;
  const validFrom = options?.validFrom ?? source.valid_from;
  const validUntil = options?.validUntil ?? source.valid_until;
  const orderId = `membership_order_temporary_${prefix}`;
  const contractId = `contract_temporary_${prefix}`;
  const lotId = `lot_temporary_${prefix}`;
  await db.insertInto("membership_orders").values({
    id: orderId,
    property_id: source.property_id,
    member_id: source.member_id,
    product_id: product?.id ?? source.product_id,
    product_code: product?.code ?? source.product_code,
    product_version: product?.version ?? source.product_version,
    product_name: product?.name ?? source.product_name,
    listed_price_minor: product?.list_price_minor ?? source.listed_price_minor,
    agreed_price_minor: product?.list_price_minor ?? source.agreed_price_minor,
    price_adjustment_minor: source.price_adjustment_minor,
    price_adjustment_reason: source.price_adjustment_reason,
    currency: product?.currency ?? source.currency,
    entitlement_unit_kind: product?.entitlement_unit_kind ?? source.entitlement_unit_kind,
    entitlement_units: product?.entitlement_units ?? source.entitlement_units,
    allowed_room_type_code: product?.allowed_room_type_code ?? source.allowed_room_type_code,
    allowed_inventory_kind: product?.allowed_inventory_kind ?? source.allowed_inventory_kind,
    status: "DRAFT",
    activated_at: null,
    valid_from: null,
    valid_until: null,
    contract_id: null,
    entitlement_lot_id: null,
    version: 1,
    created_by_command_id: source.created_by_command_id,
    activated_by_command_id: null
  }).execute();
  await db.insertInto("member_contracts").values({
    id: contractId,
    property_id: source.property_id,
    member_id: source.member_id,
    member_name: `Temporary ${prefix}`,
    status: "ACTIVE",
    valid_from: validFrom,
    valid_until: validUntil,
    version: 1,
    membership_order_id: orderId
  }).execute();
  await db.insertInto("entitlement_lots").values({
    id: lotId,
    contract_id: contractId,
    unit_kind: product?.entitlement_unit_kind ?? source.entitlement_unit_kind,
    total_units: product?.entitlement_units ?? source.entitlement_units,
    expires_on: validUntil,
    version: 1
  }).execute();
  await db.updateTable("membership_orders").set({
    status: "ACTIVE",
    activated_at: new Date(),
    valid_from: validFrom,
    valid_until: validUntil,
    contract_id: contractId,
    entitlement_lot_id: lotId,
    version: 2,
    activated_by_command_id: source.activated_by_command_id
  }).where("id", "=", orderId).execute();
}

async function unitId(code: string): Promise<string> {
  return (await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow()).id;
}

async function quote(input: {
  memberId?: string;
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
  temporaryOtherRoom?: true;
}): Promise<TemporaryQuote> {
  return createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: input.inventoryUnitId,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberId: input.memberId,
    ...(input.temporaryOtherRoom ? { temporaryOtherRoom: true } : {})
  } as Parameters<typeof createQuoteForTesting>[1]) as Promise<TemporaryQuote>;
}

async function quoteThroughCommand(input: {
  memberId: string;
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
}): Promise<TemporaryQuote> {
  const result = await executeQuoteCommand(db, principal, {
    propertyId: demo.propertyId,
    inventoryUnitId: input.inventoryUnitId,
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    memberId: input.memberId,
    temporaryOtherRoom: true
  }, metadata("temporary-other-room-quote-command"));
  expect(result.receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  return result.quote as TemporaryQuote;
}

async function temporaryPreview(quoteId: string, reason: string, prefix: string) {
  return temporaryPreviewFor(principal, quoteId, reason, prefix);
}

async function temporaryPreviewFor(actor: AuthPrincipal, quoteId: string, reason: string, prefix: string) {
  return createCommandPreview(db, actor, {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId,
      primaryGuest: { fullName: `临时安排 ${prefix}`, nickname: prefix },
      temporaryOtherRoomReason: reason
    }
  }, metadata(`${prefix}-preview`));
}

async function temporaryConfirm(
  previewId: string,
  effectHash: string,
  reason: string,
  prefix: string,
  requestMetadata = metadata(`${prefix}-confirm`)
) {
  return temporaryConfirmFor(principal, previewId, effectHash, reason, prefix, requestMetadata);
}

async function temporaryConfirmFor(
  actor: AuthPrincipal,
  previewId: string,
  effectHash: string,
  reason: string,
  prefix: string,
  requestMetadata = metadata(`${prefix}-confirm`)
) {
  return confirmCommandPreview(db, actor, previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: effectHash,
    reason: { code: "TEMPORARY_OTHER_ROOM", note: reason }
  }, requestMetadata);
}

async function businessCounts() {
  const rows = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("coverage_items").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return rows.map(({ count }) => Number(count));
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db?.destroy();
});

describe("temporary other-room whole-room member stays", () => {
  it("returns safe structural eligibility, then quotes and confirms a zero-cash arrangement against one original Lot", async () => {
    const memberId = "member_temporary_other_room_success";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.sharedSingle, "temporary-success");
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 12);
    const departureDate = shiftDate(arrivalDate, 2);
    const actualInventoryUnitId = await unitId("B01");
    const reason = "原房型满房，现场安排至独卫房";

    await expect(quote({ memberId, inventoryUnitId: actualInventoryUnitId, arrivalDate, departureDate })).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      details: {
        temporaryOtherRoomAvailable: true,
        originalRoomTypeCode: "shared_bath_single",
        actualRoomTypeCode: "private_bath_single"
      }
    });

    const quoted = await quoteThroughCommand({ memberId, inventoryUnitId: actualInventoryUnitId, arrivalDate, departureDate });
    const expectedArrangement: TemporaryArrangement = {
      kind: "TEMPORARY_OTHER_ROOM",
      membershipOrderId: membership.membershipOrderId,
      memberContractId: membership.contractId,
      entitlementLotId: membership.lotId,
      originalRoomTypeCode: "shared_bath_single",
      originalInventoryKind: "ROOM",
      entitlementUnitKind: "ROOM_NIGHT",
      actualInventoryUnitId,
      actualRoomTypeCode: "private_bath_single",
      actualInventoryKind: "ROOM",
      arrivalDate,
      departureDate
    };
    expect(quoted).toMatchObject({
      temporaryOtherRoomArrangement: expectedArrangement,
      coverageSet: [
        { serviceDate: arrivalDate, inventoryUnitId: actualInventoryUnitId, entitlementLotId: membership.lotId, unitKind: "ROOM_NIGHT" },
        { serviceDate: shiftDate(arrivalDate, 1), inventoryUnitId: actualInventoryUnitId, entitlementLotId: membership.lotId, unitKind: "ROOM_NIGHT" }
      ],
      cashLines: [],
      cashRemainder: { minorUnits: 0 },
      currentContractAmount: { minorUnits: 0 }
    });

    const prepared = await temporaryPreview(quoted.quoteId, reason, "temporary-success");
    expect(prepared.preview.effect).toMatchObject({ temporaryOtherRoomArrangement: expectedArrangement });
    const wrongReason = await temporaryConfirm(prepared.preview.previewId, prepared.preview.effectHash, "不同的现场原因", "temporary-wrong-reason");
    expect(wrongReason).toMatchObject({ businessCommitted: false, error: { code: "CONFIRMATION_MISMATCH" } });

    const confirmationMetadata = metadata("temporary-success-confirm");
    const receipt = await temporaryConfirm(prepared.preview.previewId, prepared.preview.effectHash, reason, "temporary-success", confirmationMetadata);
    expect(receipt).toMatchObject({ businessCommitted: true, result: { temporaryOtherRoomArrangement: expectedArrangement } });
    const replay = await temporaryConfirm(prepared.preview.previewId, prepared.preview.effectHash, reason, "temporary-success", confirmationMetadata);
    expect(replay).toEqual(receipt);

    const orderId = receipt.result!.orderId as string;
    const [coverage, claims, revision, amendment, ledger, collections] = await Promise.all([
      db.selectFrom("coverage_items").select(["contract_id", "lot_id", "inventory_unit_id", "service_date", "unit_kind", "status"]).where("order_id", "=", orderId).orderBy("service_date").execute(),
      db.selectFrom("inventory_claims")
        .innerJoin("stay_segments", "stay_segments.id", "inventory_claims.source_id")
        .innerJoin("stays", "stays.id", "stay_segments.stay_id")
        .select(["inventory_claims.inventory_unit_id", "inventory_claims.service_date", "inventory_claims.active"])
        .where("inventory_claims.source_type", "=", "ORDER_SEGMENT")
        .where("stays.order_id", "=", orderId)
        .orderBy("inventory_claims.service_date")
        .execute(),
      db.selectFrom("pricing_revisions").select(["cash_lines", "manual_adjustment_minor", "current_contract_amount_minor"]).where("order_id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").select(["reason_code", "reason_note", "payload"]).where("order_id", "=", orderId).where("amendment_type", "=", "CREATE_ORDER").executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_ledger").select(["lot_id", "entry_type", "quantity_delta", "service_date"]).where("order_id", "=", orderId).orderBy("service_date").execute(),
      db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()
    ]);
    expect(coverage).toEqual([
      { contract_id: membership.contractId, lot_id: membership.lotId, inventory_unit_id: actualInventoryUnitId, service_date: arrivalDate, unit_kind: "ROOM_NIGHT", status: "HELD" },
      { contract_id: membership.contractId, lot_id: membership.lotId, inventory_unit_id: actualInventoryUnitId, service_date: shiftDate(arrivalDate, 1), unit_kind: "ROOM_NIGHT", status: "HELD" }
    ]);
    expect(claims).toEqual([
      { inventory_unit_id: actualInventoryUnitId, service_date: arrivalDate, active: true },
      { inventory_unit_id: actualInventoryUnitId, service_date: shiftDate(arrivalDate, 1), active: true }
    ]);
    expect(revision).toMatchObject({ cash_lines: [], manual_adjustment_minor: 0, current_contract_amount_minor: 0 });
    expect(amendment).toMatchObject({ reason_code: "TEMPORARY_OTHER_ROOM", reason_note: reason, payload: expect.objectContaining({ temporaryOtherRoomArrangement: expectedArrangement }) });
    expect(ledger).toEqual([
      { lot_id: membership.lotId, entry_type: "HOLD", quantity_delta: -1, service_date: arrivalDate },
      { lot_id: membership.lotId, entry_type: "HOLD", quantity_delta: -1, service_date: shiftDate(arrivalDate, 1) }
    ]);
    expect(collections).toEqual([]);

    const actionView = await getOrderView(db, orderId, "WRITE", new Set([
      "CORRECT_ORDER_OCCUPANT",
      "CHECK_IN",
      "RESCHEDULE_STAY",
      "EXTEND_STAY",
      "MOVE_UNIT",
      "REPRICE_ORDER",
      "RECORD_COLLECTION",
      "RECORD_REFUND",
      "REVERSE_FACT",
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    ]));
    expect(actionView.allowedActions.map((action) => action.code)).toEqual(expect.arrayContaining([
      "CORRECT_ORDER_OCCUPANT",
      "CHECK_IN",
      "RESCHEDULE_STAY"
    ]));
    expect(actionView.allowedActions.map((action) => action.code)).not.toEqual(expect.arrayContaining([
      "EXTEND_STAY",
      "MOVE_UNIT",
      "REPRICE_ORDER",
      "RECORD_COLLECTION",
      "RECORD_REFUND",
      "REVERSE_FACT",
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    ]));

    const originalRoomQuote = await quote({
      inventoryUnitId: await unitId("D01"),
      arrivalDate,
      departureDate
    });
    expect(originalRoomQuote.quoteId).toEqual(expect.any(String));
    expect(await db.selectFrom("inventory_claims")
      .innerJoin("stay_segments", "stay_segments.id", "inventory_claims.source_id")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select("inventory_claims.inventory_unit_id")
      .where("inventory_claims.source_type", "=", "ORDER_SEGMENT")
      .where("stays.order_id", "=", orderId)
      .where("inventory_claims.inventory_unit_id", "=", await unitId("D01"))
      .execute()).toEqual([]);

    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", actualInventoryUnitId).execute();
    const historicalView = await getOrderView(db, orderId, "WRITE", new Set());
    expect(historicalView.referencedInventoryUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: actualInventoryUnitId, code: "B01", active: false })
    ]));
    expect(await db.selectFrom("inventory_units")
      .select("id")
      .where("id", "=", actualInventoryUnitId)
      .where("active", "=", true)
      .execute()).toEqual([]);
  });

  it("keeps the original Lot usable for later ordinary matching orders and lifecycle actions", async () => {
    const memberId = "member_temporary_other_room_later_exact";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.sharedSingle, "temporary-later-exact");
    const today = await propertyLocalToday(db, demo.propertyId);
    const temporaryArrival = shiftDate(today, 5);
    const temporaryDeparture = shiftDate(temporaryArrival, 1);

    const temporaryQuote = await quote({
      memberId,
      inventoryUnitId: await unitId("B01"),
      arrivalDate: temporaryArrival,
      departureDate: temporaryDeparture,
      temporaryOtherRoom: true
    });
    const temporaryReason = "本次现场临时安排，后续仍使用原房型";
    const temporaryPrepared = await temporaryPreview(
      temporaryQuote.quoteId,
      temporaryReason,
      "temporary-later-exact"
    );
    await expect(temporaryConfirm(
      temporaryPrepared.preview.previewId,
      temporaryPrepared.preview.effectHash,
      temporaryReason,
      "temporary-later-exact"
    )).resolves.toMatchObject({ businessCommitted: true });

    const exactInventoryUnitId = await unitId("D01");
    const createOrdinaryOrder = async (prefix: string, arrivalDate: string, departureDate: string) => {
      const ordinaryQuote = await quote({ memberId, inventoryUnitId: exactInventoryUnitId, arrivalDate, departureDate });
      expect(ordinaryQuote).toMatchObject({
        memberContractId: membership.contractId,
        coverageSet: expect.arrayContaining([
          expect.objectContaining({ entitlementLotId: membership.lotId, inventoryUnitId: exactInventoryUnitId })
        ])
      });
      const created = await command({
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: ordinaryQuote.quoteId,
          primaryGuest: { fullName: `原房型后续订单 ${prefix}`, nickname: prefix }
        }
      }, `${prefix}-create`);
      expect(created).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
      return created.result!.orderId as string;
    };

    const checkedInOrderId = await createOrdinaryOrder("later-exact-check-in", today, shiftDate(today, 1));
    await expect(command({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: checkedInOrderId }
    }, "later-exact-check-in")).resolves.toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });

    const [contractBeforeExtend, lotBeforeExtend] = await Promise.all([
      db.selectFrom("member_contracts")
        .select("version")
        .where("id", "=", membership.contractId)
        .executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_lots")
        .select("version")
        .where("id", "=", membership.lotId)
        .executeTakeFirstOrThrow()
    ]);
    const extendedServiceDate = shiftDate(today, 1);
    await expect(command({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: checkedInOrderId,
        newDepartureDate: shiftDate(today, 2)
      }
    }, "later-exact-extend")).resolves.toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const [contractAfterExtend, lotAfterExtend, extensionLedger] = await Promise.all([
      db.selectFrom("member_contracts")
        .select("version")
        .where("id", "=", membership.contractId)
        .executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_lots")
        .select("version")
        .where("id", "=", membership.lotId)
        .executeTakeFirstOrThrow(),
      db.selectFrom("entitlement_ledger")
        .select(["entry_type", "quantity_delta", "service_date", "reason"])
        .where("order_id", "=", checkedInOrderId)
        .where("service_date", "=", extendedServiceDate)
        .orderBy("entry_type")
        .execute()
    ]);
    expect(contractAfterExtend.version).toBe(contractBeforeExtend.version + 2);
    expect(lotAfterExtend.version).toBe(lotBeforeExtend.version + 2);
    expect(extensionLedger).toEqual([
      {
        entry_type: "CONSUME",
        quantity_delta: 0,
        service_date: extendedServiceDate,
        reason: "EXTEND_STAY_ENTITLEMENT_CONSUMED"
      },
      {
        entry_type: "HOLD",
        quantity_delta: -1,
        service_date: extendedServiceDate,
        reason: "ORDER_COVERAGE_HOLD"
      }
    ]);

    const reservedArrival = shiftDate(today, 8);
    const reservedDeparture = shiftDate(reservedArrival, 2);
    const reservedOrderId = await createOrdinaryOrder("later-exact-reserved", reservedArrival, reservedDeparture);
    await expect(command({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: reservedOrderId,
        newArrivalDate: reservedArrival,
        newDepartureDate: shiftDate(reservedArrival, 1)
      }
    }, "later-exact-reschedule")).resolves.toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    await expect(command({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: reservedOrderId }
    }, "later-exact-cancel")).resolves.toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });

    expect(await db.selectFrom("orders")
      .select(["id", "status"])
      .where("id", "in", [checkedInOrderId, reservedOrderId])
      .orderBy("id")
      .execute()).toEqual(expect.arrayContaining([
      { id: checkedInOrderId, status: "CHECKED_IN" },
      { id: reservedOrderId, status: "CANCELLED" }
    ]));
  });

  it("lets an administrator confirm a private-single entitlement into another whole-room type", async () => {
    const memberId = "member_temporary_other_room_admin_private";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.privateSingle, "temporary-admin-private");
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 18);
    const departureDate = shiftDate(arrivalDate, 2);
    const actualInventoryUnitId = await unitId("D01");
    const reason = "会员同意本次安排至公卫单人间";

    const quoted = await quote({
      memberId,
      inventoryUnitId: actualInventoryUnitId,
      arrivalDate,
      departureDate,
      temporaryOtherRoom: true
    });
    expect(quoted.temporaryOtherRoomArrangement).toMatchObject({
      membershipOrderId: membership.membershipOrderId,
      memberContractId: membership.contractId,
      entitlementLotId: membership.lotId,
      originalRoomTypeCode: "private_bath_single",
      originalInventoryKind: "ROOM",
      entitlementUnitKind: "ROOM_NIGHT",
      actualInventoryUnitId,
      actualRoomTypeCode: "shared_bath_single",
      actualInventoryKind: "ROOM",
      arrivalDate,
      departureDate
    });

    const prepared = await temporaryPreviewFor(
      administratorPrincipal,
      quoted.quoteId,
      reason,
      "temporary-admin-private"
    );
    const receipt = await temporaryConfirmFor(
      administratorPrincipal,
      prepared.preview.previewId,
      prepared.preview.effectHash,
      reason,
      "temporary-admin-private"
    );
    expect(receipt).toMatchObject({
      businessCommitted: true,
      result: {
        temporaryOtherRoomArrangement: {
          entitlementLotId: membership.lotId,
          actualInventoryUnitId
        }
      }
    });

    const orderId = receipt.result!.orderId as string;
    expect(await db.selectFrom("coverage_items")
      .select(["lot_id", "inventory_unit_id", "unit_kind", "status"])
      .where("order_id", "=", orderId)
      .orderBy("service_date")
      .execute()).toEqual([
      { lot_id: membership.lotId, inventory_unit_id: actualInventoryUnitId, unit_kind: "ROOM_NIGHT", status: "HELD" },
      { lot_id: membership.lotId, inventory_unit_id: actualInventoryUnitId, unit_kind: "ROOM_NIGHT", status: "HELD" }
    ]);
  });

  it("rejects the temporary marker for an exactly matching entitlement and grants no extra CREATE_ORDER privilege", async () => {
    const memberId = "member_temporary_other_room_exact";
    await createMember(memberId);
    await activateProduct(memberId, products.sharedSingle, "temporary-exact");
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 14);
    const departureDate = shiftDate(arrivalDate, 2);
    const exactInventoryUnitId = await unitId("D01");

    const ordinaryQuote = await quote({ memberId, inventoryUnitId: exactInventoryUnitId, arrivalDate, departureDate });
    expect(ordinaryQuote.temporaryOtherRoomArrangement).toBeUndefined();
    await expect(quote({ memberId, inventoryUnitId: exactInventoryUnitId, arrivalDate, departureDate, temporaryOtherRoom: true }))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });

    const otherRoomQuote = await quote({
      memberId,
      inventoryUnitId: await unitId("B01"),
      arrivalDate,
      departureDate,
      temporaryOtherRoom: true
    });
    await expect(temporaryPreviewFor(principal, otherRoomQuote.quoteId, "普通员工创建", "temporary-ordinary"))
      .resolves.toMatchObject({ preview: { commandType: "CREATE_ORDER" } });
    await expect(temporaryPreviewFor(administratorPrincipal, otherRoomQuote.quoteId, "管理员创建", "temporary-administrator"))
      .resolves.toMatchObject({ preview: { commandType: "CREATE_ORDER" } });
  });

  it("offers a valid temporary arrangement when a non-covering exact-room entitlement also exists", async () => {
    const memberId = "member_temporary_other_room_masked";
    await createMember(memberId);
    const source = await activateProduct(memberId, products.sharedSingle, "temporary-masked-source");
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 14);
    const departureDate = shiftDate(arrivalDate, 2);
    await insertSecondActiveRoomSource(source.membershipOrderId, "masked-exact", {
      productId: products.privateSingle,
      validFrom: shiftDate(departureDate, 10),
      validUntil: shiftDate(departureDate, 370)
    });
    const actualInventoryUnitId = await unitId("B01");

    await expect(quote({ memberId, inventoryUnitId: actualInventoryUnitId, arrivalDate, departureDate }))
      .rejects.toMatchObject({
        code: "ENTITLEMENT_CONFLICT",
        details: {
          temporaryOtherRoomAvailable: true,
          originalRoomTypeCode: "shared_bath_single",
          actualRoomTypeCode: "private_bath_single"
        }
      });
    await expect(quote({
      memberId,
      inventoryUnitId: actualInventoryUnitId,
      arrivalDate,
      departureDate,
      temporaryOtherRoom: true
    })).resolves.toMatchObject({
      temporaryOtherRoomArrangement: {
        membershipOrderId: source.membershipOrderId,
        entitlementLotId: source.lotId
      }
    });
  });

  it("makes a changed entitlement balance stale and reserves an idempotency key for the confirmed arrangement and reason", async () => {
    const memberId = "member_temporary_other_room_stale";
    await createMember(memberId);
    const membership = await activateProduct(memberId, products.sharedSingle, "temporary-stale");
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 16);
    const departureDate = shiftDate(arrivalDate, 2);
    const actualInventoryUnitId = await unitId("B01");
    const quoted = await quote({ memberId, inventoryUnitId: actualInventoryUnitId, arrivalDate, departureDate, temporaryOtherRoom: true });
    const prepared = await temporaryPreview(quoted.quoteId, "余额变更前预览", "temporary-stale");
    await command({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: membership.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 1,
        adjustmentReason: "临时安排预览后的余额变更"
      }
    }, "temporary-stale-balance");
    const beforeStaleConfirm = await businessCounts();
    await expect(temporaryConfirm(prepared.preview.previewId, prepared.preview.effectHash, "余额变更前预览", "temporary-stale"))
      .resolves.toMatchObject({ businessCommitted: false, executionStatus: "NOT_EXECUTED", error: { code: "PREVIEW_STALE" } });
    expect(await businessCounts()).toEqual(beforeStaleConfirm);

    await command({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: membership.lotId,
        expectedAvailableBalance: 1,
        targetAvailableBalance: 30,
        adjustmentReason: "临时安排幂等测试恢复余额"
      }
    }, "temporary-idempotency-balance");
    const refreshed = await quote({ memberId, inventoryUnitId: actualInventoryUnitId, arrivalDate, departureDate, temporaryOtherRoom: true });
    const committedPreview = await temporaryPreview(refreshed.quoteId, "幂等原因 A", "temporary-idempotency");
    const confirmationMetadata = metadata("temporary-idempotency-confirm");
    await expect(temporaryConfirm(
      committedPreview.preview.previewId,
      committedPreview.preview.effectHash,
      "幂等原因 A",
      "temporary-idempotency",
      confirmationMetadata
    )).resolves.toMatchObject({ businessCommitted: true });
    await expect(temporaryConfirm(
      committedPreview.preview.previewId,
      committedPreview.preview.effectHash,
      "幂等原因 B",
      "temporary-idempotency",
      confirmationMetadata
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("serializes concurrent claims of the actual room and the same entitlement Lot", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const roomArrival = shiftDate(today, 22);
    const roomDeparture = shiftDate(roomArrival, 2);
    const actualInventoryUnitId = await unitId("B01");
    const firstMemberId = "member_temporary_other_room_actual_a";
    const secondMemberId = "member_temporary_other_room_actual_b";
    await createMember(firstMemberId);
    await createMember(secondMemberId);
    await activateProduct(firstMemberId, products.sharedSingle, "temporary-actual-a");
    await activateProduct(secondMemberId, products.sharedSingle, "temporary-actual-b");
    const [firstQuote, secondQuote] = await Promise.all([
      quote({ memberId: firstMemberId, inventoryUnitId: actualInventoryUnitId, arrivalDate: roomArrival, departureDate: roomDeparture, temporaryOtherRoom: true }),
      quote({ memberId: secondMemberId, inventoryUnitId: actualInventoryUnitId, arrivalDate: roomArrival, departureDate: roomDeparture, temporaryOtherRoom: true })
    ]);
    const [firstPreview, secondPreview] = await Promise.all([
      temporaryPreview(firstQuote.quoteId, "实际房并发 A", "temporary-actual-a"),
      temporaryPreview(secondQuote.quoteId, "实际房并发 B", "temporary-actual-b")
    ]);
    const actualRoomResults = await Promise.all([
      temporaryConfirm(firstPreview.preview.previewId, firstPreview.preview.effectHash, "实际房并发 A", "temporary-actual-a"),
      temporaryConfirm(secondPreview.preview.previewId, secondPreview.preview.effectHash, "实际房并发 B", "temporary-actual-b")
    ]);
    expect(actualRoomResults.filter((result) => result.businessCommitted)).toHaveLength(1);
    expect(actualRoomResults.filter((result) => !result.businessCommitted)).toEqual([
      expect.objectContaining({ executionStatus: "NOT_EXECUTED", error: expect.objectContaining({ code: "PREVIEW_STALE" }) })
    ]);

    const balanceMemberId = "member_temporary_other_room_balance_race";
    await createMember(balanceMemberId);
    await activateProduct(balanceMemberId, products.sharedSingle, "temporary-balance-race");
    const balanceArrival = shiftDate(today, 32);
    const balanceDeparture = shiftDate(balanceArrival, 20);
    const [firstBalanceQuote, secondBalanceQuote] = await Promise.all([
      quote({ memberId: balanceMemberId, inventoryUnitId: await unitId("B01"), arrivalDate: balanceArrival, departureDate: balanceDeparture, temporaryOtherRoom: true }),
      quote({ memberId: balanceMemberId, inventoryUnitId: await unitId("B02"), arrivalDate: balanceArrival, departureDate: balanceDeparture, temporaryOtherRoom: true })
    ]);
    const [firstBalancePreview, secondBalancePreview] = await Promise.all([
      temporaryPreview(firstBalanceQuote.quoteId, "余额并发 A", "temporary-balance-race-a"),
      temporaryPreview(secondBalanceQuote.quoteId, "余额并发 B", "temporary-balance-race-b")
    ]);
    const balanceResults = await Promise.all([
      temporaryConfirm(firstBalancePreview.preview.previewId, firstBalancePreview.preview.effectHash, "余额并发 A", "temporary-balance-race-a"),
      temporaryConfirm(secondBalancePreview.preview.previewId, secondBalancePreview.preview.effectHash, "余额并发 B", "temporary-balance-race-b")
    ]);
    expect(balanceResults.filter((result) => result.businessCommitted)).toHaveLength(1);
    expect(balanceResults.filter((result) => !result.businessCommitted)).toEqual([
      expect.objectContaining({ executionStatus: "NOT_EXECUTED", error: expect.objectContaining({ code: "PREVIEW_STALE" }) })
    ]);
  });

  it("never exposes a continuable arrangement or writes facts for bed directions, inactive or expired rights, inadequate balance, or ambiguous sources", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 20);
    const departureDate = shiftDate(arrivalDate, 2);
    const [privateRoom, bed] = await Promise.all([unitId("B01"), unitId("101-A")]);
    const roomMember = "member_temporary_other_room_room";
    const bedMember = "member_temporary_other_room_bed";
    const balanceMember = "member_temporary_other_room_balance";
    const inactiveMember = "member_temporary_other_room_inactive";
    const expiredMember = "member_temporary_other_room_expired";
    await createMember(roomMember);
    await createMember(bedMember);
    await createMember(balanceMember);
    await createMember(inactiveMember);
    await createMember(expiredMember);
    const roomMembership = await activateProduct(roomMember, products.sharedSingle, "temporary-room");
    await activateProduct(bedMember, products.sharedQuad, "temporary-bed");
    const balanceMembership = await activateProduct(balanceMember, products.sharedSingle, "temporary-balance-member");
    await command({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId: inactiveMember,
        membershipProductId: products.sharedSingle,
        agreedPriceMinor: 162_000
      }
    }, "temporary-inactive-membership");
    await activateProduct(expiredMember, products.sharedSingle, "temporary-expired-membership");
    const before = await businessCounts();

    await expect(quote({ memberId: roomMember, inventoryUnitId: bed, arrivalDate, departureDate, temporaryOtherRoom: true }))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    await expect(quote({ memberId: bedMember, inventoryUnitId: privateRoom, arrivalDate, departureDate, temporaryOtherRoom: true }))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    for (const rejected of [
      await quote({ memberId: inactiveMember, inventoryUnitId: privateRoom, arrivalDate, departureDate, temporaryOtherRoom: true })
        .then(() => null, (error: unknown) => error),
      await quote({
        memberId: expiredMember,
        inventoryUnitId: privateRoom,
        arrivalDate: shiftDate(today, 370),
        departureDate: shiftDate(today, 372),
        temporaryOtherRoom: true
      }).then(() => null, (error: unknown) => error)
    ]) {
      expect(rejected).toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
      expect(rejected).not.toMatchObject({ details: { temporaryOtherRoomAvailable: true } });
    }
    expect(await businessCounts()).toEqual(before);

    await insertSecondActiveRoomSource(roomMembership.membershipOrderId, "ambiguous");
    await expect(quote({ memberId: roomMember, inventoryUnitId: privateRoom, arrivalDate, departureDate, temporaryOtherRoom: true }))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });

    await command({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: balanceMembership.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 1,
        adjustmentReason: "临时安排余额不足红灯"
      }
    }, "temporary-balance");
    const afterPreparation = await businessCounts();
    await expect(quote({ memberId: balanceMember, inventoryUnitId: privateRoom, arrivalDate, departureDate, temporaryOtherRoom: true }))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(await businessCounts()).toEqual(afterPreparation);
  });
});
