import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ROOM_STATUS_MAX_QUERY_NIGHTS,
  ROOM_STATUS_OPERATIONAL_TASK_LIMIT,
  type AuthPrincipal,
  type CommandEnvelope,
  type ReceiptDto,
  type RoomStatusBoardDto,
  type RoomStatusUnitDto
} from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  getRoomStatusBoard,
  listAvailability,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { sql, type Kysely, type Updateable } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { assertRoomStatusBoard } from "../../apps/web/src/room-status/roomStatusValidation.ts";
import { RoomStatusBoardSchema } from "../../apps/api/src/schemas.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.ROOM_STATUS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_room_status";

const writePrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;
const roomStatusSchemaValidator = new Ajv2020({ allErrors: true, strict: true });
addFormats(roomStatusSchemaValidator);
const validateRoomStatusBoardSchema = roomStatusSchemaValidator.compile(RoomStatusBoardSchema);

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function withOrdinaryOrderCreationClock<T>(arrivalDate: string, operation: () => Promise<T>): Promise<T> {
  const businessDate = await propertyLocalToday(db, demo.propertyId);
  return arrivalDate < businessDate
    ? withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), operation)
    : operation();
}

async function prepare(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, writePrincipal, envelope, metadata(`${prefix}-preview`));
}

async function confirmPrepared(
  prepared: Awaited<ReturnType<typeof prepare>>,
  prefix: string,
  confirmMetadata = metadata(`${prefix}-confirm`)
) {
  const confirmation = {
    propertyId: demo.propertyId,
    commandType: prepared.preview.commandType,
    confirmation: true as const,
    expectedEffectHash: prepared.preview.effectHash,
    reason: prepared.preview.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "ROOM_STATUS_ACCEPTANCE", note: `Room-status acceptance for ${prefix}` }
  };
  const receipt = await confirmCommandPreview(db, writePrincipal, prepared.preview.previewId, confirmation, confirmMetadata);
  return { receipt, confirmation, confirmMetadata };
}

async function execute(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const prepared = await prepare(envelope, prefix);
  return (await confirmPrepared(prepared, prefix)).receipt;
}

async function board(options: {
  arrivalDate: string;
  departureDate: string;
  accessLevel?: "READ" | "WRITE";
  page?: number;
  pageSize?: number;
  search?: string;
  roomType?: string;
  salesMode?: "WHOLE_ROOM" | "BED_SPLIT" | "UNAVAILABLE";
  status?: RoomStatusBoardDto["rooms"][number]["days"][number]["status"];
  minCapacity?: number;
  unitKind?: "ROOM" | "BED";
}): Promise<RoomStatusBoardDto> {
  return getRoomStatusBoard(db, {
    propertyId: demo.propertyId,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    accessLevel: options.accessLevel ?? "WRITE",
    requestingSubjectId: demo.agentSubjectId,
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
    ...(options.roomType !== undefined ? { roomType: options.roomType } : {}),
    ...(options.salesMode !== undefined ? { salesMode: options.salesMode } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.minCapacity !== undefined ? { minCapacity: options.minCapacity } : {}),
    ...(options.unitKind !== undefined ? { unitKind: options.unitKind } : {})
  });
}

async function lodgingBusinessFactCounts() {
  const [
    orders,
    stays,
    quotes,
    pricingRevisions,
    coverageItems,
    membershipOrders,
    membershipPayments,
    memberContracts,
    entitlementLots,
    entitlementLedger,
    collections
  ] = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("quotes").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("coverage_items").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("membership_orders").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("membership_payment_facts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("member_contracts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("entitlement_lots").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("collection_facts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow()
  ]);
  return {
    orders: orders.count,
    stays: stays.count,
    quotes: quotes.count,
    pricingRevisions: pricingRevisions.count,
    coverageItems: coverageItems.count,
    membershipOrders: membershipOrders.count,
    membershipPayments: membershipPayments.count,
    memberContracts: memberContracts.count,
    entitlementLots: entitlementLots.count,
    entitlementLedger: entitlementLedger.count,
    collections: collections.count
  };
}

function shiftLocalDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function testPricingPolicyForDates(arrivalDate: string, departureDate: string): string {
  return arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
    ? demo.transientPolicyId
    : demo.publicPricingPolicyId;
}

function unitIn(result: RoomStatusBoardDto, unitId: string): RoomStatusUnitDto {
  for (const room of result.rooms) {
    if (room.id === unitId) return room;
    const child = room.children.find((unit) => unit.id === unitId);
    if (child) return child;
  }
  throw new Error(`Unit ${unitId} is absent from room-status`);
}

function intervalForOrder(result: RoomStatusBoardDto, unitId: string, orderId: string) {
  const interval = unitIn(result, unitId).intervals.find((candidate) => candidate.references
    .some((reference) => reference.type === "ORDER" && reference.id === orderId));
  if (!interval) throw new Error(`Order ${orderId} is absent from room-status intervals`);
  return interval;
}

function taskForOrder(result: RoomStatusBoardDto, orderId: string) {
  const task = result.operationalTasks.find((candidate) => candidate.references
    .some((reference) => reference.type === "ORDER" && reference.id === orderId));
  if (!task) throw new Error(`Order ${orderId} is absent from room-status operational tasks`);
  return task;
}

async function createOrder(options: {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  prefix: string;
  stayType?: "TRANSIENT" | "FREE";
  freeStayReason?: string;
  memberContractId?: string;
  nickname?: string;
  bookingChannelCode?: "WECOM" | "YOUMUDAO" | "CTRIP" | "MEITUAN";
  channelOrderReference?: string;
  pricingPolicyVersionId?: string;
}) {
  return withOrdinaryOrderCreationClock(options.arrivalDate, async () => {
    const stayType = options.stayType ?? "TRANSIENT";
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: options.unitId,
      stayType,
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      pricingPolicyVersionId: options.pricingPolicyVersionId ?? (stayType === "FREE"
        ? demo.freePolicyId
        : testPricingPolicyForDates(options.arrivalDate, options.departureDate)),
      ...(options.memberContractId ? { memberContractId: options.memberContractId } : {})
    });
    return execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: `Room status ${options.prefix}`, nickname: options.nickname ?? `RS ${options.prefix}` },
        ...(!options.memberContractId && stayType !== "FREE" ? {
          bookingChannelCode: options.bookingChannelCode ?? "WECOM",
          channelOrderReference: options.bookingChannelCode && options.bookingChannelCode !== "WECOM"
            ? options.channelOrderReference ?? `RS-${options.prefix.toUpperCase()}`
            : null,
          targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
        } : {}),
        ...(stayType === "FREE" ? { freeStayReason: options.freeStayReason ?? "Volunteer accommodation", freeStayCategoryCode: "RECEPTION" } : {})
      }
    }, `${options.prefix}-create`);
  });
}

async function markOrderInHouseFixture(orderId: string) {
  const order = await db.selectFrom("orders")
    .select(["status", "version", "arrival_date"])
    .where("id", "=", orderId)
    .executeTakeFirstOrThrow();
  const segment = await db.selectFrom("stay_segments as segment")
    .innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .select("segment.inventory_unit_id")
    .where("stay.order_id", "=", orderId)
    .orderBy("segment.sequence", "desc")
    .executeTakeFirstOrThrow();
  const nextVersion = order.version + 1;
  await db.insertInto("amendments").values({
    id: `amend_room_status_fixture_check_in_${++sequence}`,
    order_id: orderId,
    sequence: nextVersion,
    amendment_type: "CHECK_IN",
    reason_code: "ROOM_STATUS_FIXTURE_SETUP",
    reason_note: "准备房态在住与迟录退房测试状态",
    prior_version: order.version,
    new_version: nextVersion,
    payload: {
      orderId,
      fromStatus: order.status,
      toStatus: "CHECKED_IN",
      inventoryUnitId: segment.inventory_unit_id,
      businessDate: order.arrival_date,
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 0 }
    },
    command_id: null
  }).execute();
  await db.updateTable("orders").set({ status: "CHECKED_IN", version: nextVersion }).where("id", "=", orderId).execute();
  await db.updateTable("stays").set({ status: "IN_HOUSE" }).where("order_id", "=", orderId).execute();
}

async function updateOrderIdentityForProjectionTest(
  orderId: string,
  values: Updateable<Database["orders"]>
): Promise<void> {
  await sql`alter table orders disable trigger orders_protect_identity`.execute(db);
  try {
    await db.updateTable("orders").set(values).where("id", "=", orderId).execute();
  } finally {
    await sql`alter table orders enable trigger orders_protect_identity`.execute(db);
  }
}

async function recordFullCollectionForProjectionTest(orderId: string, prefix: string): Promise<void> {
  const revision = await db.selectFrom("orders as order")
    .innerJoin("pricing_revisions as revision", "revision.id", "order.current_revision_id")
    .select("revision.current_contract_amount_minor as amountMinor")
    .where("order.id", "=", orderId)
    .executeTakeFirstOrThrow();
  const amountMinor = Number(revision.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`Expected a positive current contract amount for ${prefix}`);
  }
  await execute({
    commandType: "RECORD_COLLECTION",
    input: {
      propertyId: demo.propertyId,
      orderId,
      amountMinor,
      method: "WECOM",
      transactionReference: `ROOM-STATUS-${prefix.toUpperCase()}-FULL`,
      note: "room-status projection source fixture"
    }
  }, `${prefix}-full-collection`);
}

async function orderFulfillmentState(orderId: string) {
  const segmentIds = (await db.selectFrom("stay_segments as segment")
    .innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .select("segment.id")
    .where("stay.order_id", "=", orderId)
    .orderBy("segment.id")
    .execute()).map((segment) => segment.id);
  return Promise.all([
    db.selectFrom("orders").select(["status", "version", "current_revision_id"]).where("id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select("status").where("order_id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").select(["id", "amendment_type", "payload"]).where("order_id", "=", orderId).orderBy("sequence").execute(),
    db.selectFrom("pricing_revisions").select("id").where("order_id", "=", orderId).orderBy("revision_no").execute(),
    db.selectFrom("inventory_claims").select(["id", "active", "released_at"]).where("source_id", "in", segmentIds).orderBy("id").execute(),
    db.selectFrom("coverage_items").select(["id", "status"]).where("order_id", "=", orderId).orderBy("id").execute(),
    db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).orderBy("fact_id").execute(),
    db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).orderBy("fact_id").execute(),
    db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).orderBy("id").execute()
  ]);
}

async function distinctBusinessDatesAcrossTimezones() {
  await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
  const arrivalDate = await propertyLocalToday(db, demo.propertyId);
  await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
  const departureDate = await propertyLocalToday(db, demo.propertyId);
  expect(departureDate > arrivalDate).toBe(true);
  await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
  return { arrivalDate, departureDate };
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("PostgreSQL room-status projection", () => {
  it("returns whole-property daily availability before filtering without double-counting split beds", async () => {
    const inventoryRows = await db.selectFrom("inventory_units")
      .select(["id", "kind", "parent_room_id", "active"])
      .where("property_id", "=", demo.propertyId)
      .execute();
    const activeRoomIds = new Set(inventoryRows
      .filter((unit) => unit.kind === "ROOM" && unit.active)
      .map((unit) => unit.id));
    const roomIdsWithBeds = new Set(inventoryRows
      .filter((unit) => unit.kind === "BED")
      .map((unit) => unit.parent_room_id!)
    );
    const expectedAvailableRooms = inventoryRows
      .filter((unit) => unit.kind === "ROOM" && unit.active && !roomIdsWithBeds.has(unit.id))
      .length;
    const expectedAvailableBeds = inventoryRows
      .filter((unit) => unit.kind === "BED" && unit.active && activeRoomIds.has(unit.parent_room_id!))
      .length;
    const expectedTotalSellableUnits = expectedAvailableRooms + expectedAvailableBeds;

    const unfiltered = await board({ arrivalDate: "2034-01-01", departureDate: "2034-01-03" });
    expect(unfiltered.availabilitySummary).toEqual([
      {
        serviceDate: "2034-01-01",
        availableRooms: expectedAvailableRooms,
        availableBeds: expectedAvailableBeds,
        paidOccupiedUnits: 0,
        totalSellableUnits: expectedTotalSellableUnits,
        occupantCount: 0
      },
      {
        serviceDate: "2034-01-02",
        availableRooms: expectedAvailableRooms,
        availableBeds: expectedAvailableBeds,
        paidOccupiedUnits: 0,
        totalSellableUnits: expectedTotalSellableUnits,
        occupantCount: 0
      }
    ]);

    const filteredEmpty = await board({
      arrivalDate: "2034-01-01",
      departureDate: "2034-01-03",
      search: "NO-SUCH-ROOM-STATUS-UNIT"
    });
    expect(filteredEmpty.rooms).toEqual([]);
    expect(filteredEmpty.availabilitySummary).toEqual(unfiltered.availabilitySummary);
  });

  it("projects authoritative physical-bed counts without substituting occupancy capacity or compatibility capacity", async () => {
    const fixtures = [
      { id: "unit_room_status_physical_two", code: "PHYSICAL-2", physicalBedCount: 2, occupancyCapacity: 2 },
      { id: "unit_room_status_physical_king", code: "PHYSICAL-KING", physicalBedCount: 1, occupancyCapacity: 2 },
      { id: "unit_room_status_physical_unknown", code: "PHYSICAL-UNKNOWN", physicalBedCount: null, occupancyCapacity: 2 }
    ] as const;
    await db.insertInto("inventory_units").values(fixtures.map((fixture) => ({
      id: fixture.id,
      property_id: demo.propertyId,
      kind: "ROOM" as const,
      parent_room_id: null,
      code: fixture.code,
      name: fixture.code,
      active: true,
      catalog_version: "test-physical-bed-contract",
      building_code: "TEST",
      room_type_code: "TEST_PHYSICAL",
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: fixture.physicalBedCount,
      occupancy_capacity: fixture.occupancyCapacity
    }))).execute();

    const result = await board({
      arrivalDate: "2034-02-01",
      departureDate: "2034-02-02",
      roomType: "TEST_PHYSICAL",
      pageSize: 200
    });
    expect(result.rooms.map((room) => ({
      id: room.id,
      physicalBedCount: room.physicalBedCount,
      capacity: room.capacity,
      occupancyCapacity: room.occupancyCapacity,
      bedSlotStates: room.bedSlotStates
    }))).toEqual([
      { id: fixtures[0].id, physicalBedCount: 2, capacity: 2, occupancyCapacity: 2, bedSlotStates: [] },
      { id: fixtures[1].id, physicalBedCount: 1, capacity: 1, occupancyCapacity: 2, bedSlotStates: [] },
      { id: fixtures[2].id, physicalBedCount: null, capacity: 1, occupancyCapacity: 2, bedSlotStates: [] }
    ]);
  });

  it("counts whole-room business occupancy in split-bed rooms by the room's occupied bed sellable units", async () => {
    await createOrder({
      unitId: demo.roomId,
      arrivalDate: "2029-03-01",
      departureDate: "2029-03-02",
      prefix: "split-room-business-units"
    });

    const occupied = await board({ arrivalDate: "2029-03-01", departureDate: "2029-03-02" });
    expect(unitIn(occupied, demo.roomId).children).toHaveLength(4);
    expect(occupied.availabilitySummary.find((item) => item.serviceDate === "2029-03-01"))
      .toMatchObject({ paidOccupiedUnits: 4, occupantCount: 1 });
  });

  it("aggregates only authoritative split-bed lodging facts before filters and fails closed for ambiguous occupancy", async () => {
    const normal = await createOrder({
      unitId: demo.bedAId,
      arrivalDate: "2029-02-01",
      departureDate: "2029-02-03",
      prefix: "occupancy-order"
    });
    const normalOrderId = normal.result!.orderId as string;
    const sameNicknameFree = await createOrder({
      unitId: demo.bedDId,
      arrivalDate: "2029-02-01",
      departureDate: "2029-02-03",
      prefix: "occupancy-same-nickname-free",
      nickname: "RS occupancy-order",
      stayType: "FREE"
    });
    const sameNicknameFreeOrderId = sameNicknameFree.result!.orderId as string;
    const cleaningSource = await createOrder({
      unitId: demo.bedCId,
      arrivalDate: "2029-02-01",
      departureDate: "2029-02-02",
      prefix: "occupancy-cleaning-source"
    });
    const cleaningSourceOrderId = cleaningSource.result!.orderId as string;
    const cleaningSourceStayId = cleaningSource.result!.stayId as string;
    const cancelledCleaningSource = await execute({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: cleaningSourceOrderId }
    }, "occupancy-cleaning-source-cancel");
    await db.insertInto("cleaning_tasks").values({
      id: "cleaning_split_bed_occupancy_exclusion",
      property_id: demo.propertyId,
      order_id: cleaningSourceOrderId,
      stay_id: cleaningSourceStayId,
      inventory_unit_id: demo.bedCId,
      room_id: demo.roomId,
      service_date: "2029-02-02",
      status: "PENDING",
      version: 1,
      created_by_command_id: cancelledCleaningSource.commandId,
      completed_by_command_id: null,
      completed_at: null
    }).execute();
    await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedBId,
        arrivalDate: "2029-02-01",
        departureDate: "2029-02-03",
        reason: "Must not count as a lodging occupant"
      }
    }, "occupancy-internal-use");

    const occupied = await board({ arrivalDate: "2029-02-01", departureDate: "2029-02-03" });
    expect(occupied.availabilitySummary).toEqual([
      expect.objectContaining({
        serviceDate: "2029-02-01",
        paidOccupiedUnits: 1,
        occupantCount: 1
      }),
      expect.objectContaining({
        serviceDate: "2029-02-02",
        paidOccupiedUnits: 1,
        occupantCount: 1
      })
    ]);
    const parent = unitIn(occupied, demo.roomId);
    expect(unitIn(occupied, demo.bedCId).days.find((day) => day.serviceDate === "2029-02-02"))
      .toMatchObject({ status: "AVAILABLE", available: true });
    expect(unitIn(occupied, demo.bedCId).intervals.some((interval) => interval.sourceKind === "CLEANING")).toBe(false);
    expect(parent.bedOccupancies).toEqual([
      {
        serviceDate: "2029-02-01",
        occupiedBedCount: 2,
        totalBedCount: 4,
        occupants: [
          {
            occupantId: expect.any(String),
            inventoryUnitId: demo.bedAId,
            inventoryUnitCode: "101-A",
            primaryOccupantLabel: "RS occupancy-order",
            sourceReference: expect.objectContaining({ type: "ORDER", id: normalOrderId })
          },
          {
            occupantId: expect.any(String),
            inventoryUnitId: demo.bedDId,
            inventoryUnitCode: "101-D",
            primaryOccupantLabel: "RS occupancy-order",
            sourceReference: expect.objectContaining({ type: "ORDER", id: sameNicknameFreeOrderId })
          }
        ]
      },
      {
        serviceDate: "2029-02-02",
        occupiedBedCount: 2,
        totalBedCount: 4,
        occupants: [
          {
            occupantId: expect.any(String),
            inventoryUnitId: demo.bedAId,
            inventoryUnitCode: "101-A",
            primaryOccupantLabel: "RS occupancy-order",
            sourceReference: expect.objectContaining({ type: "ORDER", id: normalOrderId })
          },
          {
            occupantId: expect.any(String),
            inventoryUnitId: demo.bedDId,
            inventoryUnitCode: "101-D",
            primaryOccupantLabel: "RS occupancy-order",
            sourceReference: expect.objectContaining({ type: "ORDER", id: sameNicknameFreeOrderId })
          }
        ]
      }
    ]);
    expect(parent.bedSlotStates.filter((slot) => slot.serviceDate === "2029-02-01")).toEqual([
      { serviceDate: "2029-02-01", inventoryUnitId: demo.bedAId, inventoryUnitCode: "101-A", status: "RESERVED" },
      { serviceDate: "2029-02-01", inventoryUnitId: demo.bedBId, inventoryUnitCode: "101-B", status: "MAINTENANCE" },
      { serviceDate: "2029-02-01", inventoryUnitId: demo.bedCId, inventoryUnitCode: "101-C", status: "AVAILABLE" },
      { serviceDate: "2029-02-01", inventoryUnitId: demo.bedDId, inventoryUnitCode: "101-D", status: "RESERVED" }
    ]);
    expect(parent.children.every((child) => child.bedOccupancies.length === 0)).toBe(true);
    expect(parent.children.every((child) => child.bedSlotStates.length === 0)).toBe(true);

    const historicalNickname = await createOrder({
      unitId: demo.bedAId,
      arrivalDate: "2029-02-22",
      departureDate: "2029-02-23",
      prefix: "occupancy-historical-missing-nickname"
    });
    await sql`alter table orders disable trigger orders_protect_identity`.execute(db);
    try {
      await db.updateTable("orders")
        .set({ primary_guest_snapshot: { fullName: "Historical Legal Name" } })
        .where("id", "=", historicalNickname.result!.orderId as string)
        .execute();
    } finally {
      await sql`alter table orders enable trigger orders_protect_identity`.execute(db);
    }
    const historicalParent = unitIn(await board({ arrivalDate: "2029-02-22", departureDate: "2029-02-23" }), demo.roomId);
    expect(historicalParent.bedOccupancies[0]!.occupants[0]!.primaryOccupantLabel)
      .toBe("RS occupancy-historical-missing-nickname");

    const roomOnly = await board({
      arrivalDate: "2029-02-01",
      departureDate: "2029-02-03",
      unitKind: "ROOM"
    });
    const roomOnlyParent = unitIn(roomOnly, demo.roomId);
    expect(roomOnlyParent.children).toEqual([]);
    expect(roomOnlyParent.childUnitIds).toEqual([demo.bedAId, demo.bedBId, demo.bedCId, demo.bedDId]);
    expect(roomOnlyParent.bedOccupancies).toEqual(parent.bedOccupancies);

    const free = await createOrder({
      unitId: demo.bedBId,
      arrivalDate: "2029-02-04",
      departureDate: "2029-02-06",
      prefix: "occupancy-free",
      stayType: "FREE"
    });
    const freeOrderId = free.result!.orderId as string;
    await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: "2029-02-04",
        departureDate: "2029-02-06",
        reason: "Must not count as a lodging occupant"
      }
    }, "occupancy-maintenance");
    const freeOccupied = unitIn(await board({ arrivalDate: "2029-02-04", departureDate: "2029-02-06" }), demo.roomId);
    expect(freeOccupied.bedOccupancies).toEqual([
      expect.objectContaining({
        serviceDate: "2029-02-04",
        occupiedBedCount: 1,
        totalBedCount: 4,
        occupants: [expect.objectContaining({
          inventoryUnitId: demo.bedBId,
          primaryOccupantLabel: "RS occupancy-free",
          sourceReference: expect.objectContaining({ type: "ORDER", id: freeOrderId })
        })]
      }),
      expect.objectContaining({ serviceDate: "2029-02-05", occupiedBedCount: 1, totalBedCount: 4 })
    ]);
    expect(freeOccupied.bedSlotStates.filter((slot) => slot.serviceDate === "2029-02-04").map((slot) => slot.status))
      .toEqual(["MAINTENANCE", "RESERVED", "AVAILABLE", "AVAILABLE"]);

    const wholeRoom = await createOrder({
      unitId: demo.roomId,
      arrivalDate: "2029-02-07",
      departureDate: "2029-02-09",
      prefix: "occupancy-whole-room"
    });
    const wholeRoomOrderId = wholeRoom.result!.orderId as string;
    const wholeRoomBoard = await board({ arrivalDate: "2029-02-07", departureDate: "2029-02-09" });
    const wholeRoomParent = unitIn(wholeRoomBoard, demo.roomId);
    expect(wholeRoomParent.bedOccupancies).toEqual([]);
    expect(wholeRoomParent.bedSlotStates.filter((slot) => slot.serviceDate === "2029-02-07")
      .every((slot) => slot.status === "RESERVED")).toBe(true);
    expect(wholeRoomParent.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actualInventoryUnitId: demo.roomId,
        primaryOccupantLabel: "RS occupancy-whole-room",
        references: expect.arrayContaining([expect.objectContaining({ type: "ORDER", id: wholeRoomOrderId })])
      })
    ]));

    await createOrder({
      unitId: demo.bedBId,
      arrivalDate: "2029-02-10",
      departureDate: "2029-02-11",
      prefix: "occupancy-alongside-unknown"
    });
    await sql`alter table inventory_claims disable trigger inventory_claims_validate_source`.execute(db);
    try {
      await db.insertInto("inventory_claims").values({
        id: "claim_unresolved_child_occupancy",
        property_id: demo.propertyId,
        room_id: demo.roomId,
        inventory_unit_id: demo.bedAId,
        service_date: "2029-02-10",
        source_type: "ORDER_SEGMENT",
        source_id: "segment_missing_child_occupancy",
        active: true,
        released_at: null
      }).execute();
    } finally {
      await sql`alter table inventory_claims enable trigger inventory_claims_validate_source`.execute(db);
    }
    const unknown = await board({ arrivalDate: "2029-02-10", departureDate: "2029-02-11" });
    expect(unknown.projectionState).toBe("PARTIAL");
    expect(unitIn(unknown, demo.roomId).bedOccupancies).toEqual([]);
    expect(unitIn(unknown, demo.roomId).bedSlotStates.filter((slot) => slot.serviceDate === "2029-02-10"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ inventoryUnitId: demo.bedAId, status: "UNKNOWN" }),
        expect.objectContaining({ inventoryUnitId: demo.bedBId, status: "RESERVED" })
      ]));

    await createOrder({
      unitId: demo.bedDId,
      arrivalDate: "2029-02-14",
      departureDate: "2029-02-15",
      prefix: "occupancy-alongside-parent-unknown"
    });
    await sql`alter table inventory_claims disable trigger inventory_claims_validate_source`.execute(db);
    try {
      await db.insertInto("inventory_claims").values({
        id: "claim_unresolved_parent_occupancy",
        property_id: demo.propertyId,
        room_id: demo.roomId,
        inventory_unit_id: demo.roomId,
        service_date: "2029-02-14",
        source_type: "ORDER_SEGMENT",
        source_id: "segment_missing_parent_occupancy",
        active: true,
        released_at: null
      }).execute();
    } finally {
      await sql`alter table inventory_claims enable trigger inventory_claims_validate_source`.execute(db);
    }
    const parentUnknown = await board({ arrivalDate: "2029-02-14", departureDate: "2029-02-15" });
    expect(parentUnknown.projectionState).toBe("PARTIAL");
    expect(unitIn(parentUnknown, demo.roomId).bedOccupancies).toEqual([]);
    expect(unitIn(parentUnknown, demo.roomId).bedSlotStates
      .filter((slot) => slot.serviceDate === "2029-02-14")
      .every((slot) => slot.status === "UNKNOWN")).toBe(true);

    const duplicate = await createOrder({
      unitId: demo.bedCId,
      arrivalDate: "2029-02-12",
      departureDate: "2029-02-13",
      prefix: "occupancy-duplicate"
    });
    await db.insertInto("inventory_claims").values({
      id: "claim_duplicate_child_occupancy",
      property_id: demo.propertyId,
      room_id: demo.roomId,
      inventory_unit_id: demo.bedCId,
      service_date: "2029-02-12",
      source_type: "ORDER_SEGMENT",
      source_id: duplicate.result!.segmentId as string,
      active: true,
      released_at: null
    }).execute();
    const duplicateBoard = await board({ arrivalDate: "2029-02-12", departureDate: "2029-02-13" });
    expect(duplicateBoard.projectionState).toBe("PARTIAL");
    expect(unitIn(duplicateBoard, demo.roomId).bedOccupancies).toEqual([]);
    const duplicateOrderId = duplicate.result!.orderId as string;
    const duplicateChild = unitIn(duplicateBoard, demo.bedCId);
    const duplicateIntervals = duplicateChild.intervals.filter((interval) => interval.references
      .some((item) => item.type === "ORDER" && item.id === duplicateOrderId));
    expect(duplicateIntervals).toHaveLength(1);
    expect(duplicateIntervals[0]!.claimIds).toHaveLength(2);
    expect(duplicateIntervals[0]!.claimIds).toContain("claim_duplicate_child_occupancy");
    expect(new Set(duplicateIntervals[0]!.references.map((item) => `${item.type}:${item.id}`)).size)
      .toBe(duplicateIntervals[0]!.references.length);
    expect(duplicateChild.days[0]!.intervalIds).toEqual([duplicateIntervals[0]!.id]);
    expect(duplicateChild.days[0]!.conflicts).toHaveLength(2);
    expect(() => assertRoomStatusBoard(duplicateBoard, {
      propertyId: demo.propertyId,
      range: { arrivalDate: "2029-02-12", departureDate: "2029-02-13" },
      pageIndex: 0
    })).not.toThrow();

    const duplicateAcrossBeds = await createOrder({
      unitId: demo.bedAId,
      arrivalDate: "2029-02-20",
      departureDate: "2029-02-21",
      prefix: "occupancy-duplicate-across-beds"
    });
    await sql`alter table inventory_claims disable trigger inventory_claims_validate_source`.execute(db);
    try {
      await db.insertInto("inventory_claims").values({
        id: "claim_duplicate_order_across_beds",
        property_id: demo.propertyId,
        room_id: demo.roomId,
        inventory_unit_id: demo.bedBId,
        service_date: "2029-02-20",
        source_type: "ORDER_SEGMENT",
        source_id: duplicateAcrossBeds.result!.segmentId as string,
        active: true,
        released_at: null
      }).execute();
    } finally {
      await sql`alter table inventory_claims enable trigger inventory_claims_validate_source`.execute(db);
    }
    const duplicateAcrossBedsBoard = await board({ arrivalDate: "2029-02-20", departureDate: "2029-02-21" });
    expect(duplicateAcrossBedsBoard.projectionState).toBe("PARTIAL");
    expect(unitIn(duplicateAcrossBedsBoard, demo.roomId).bedOccupancies).toEqual([]);

    const reservedWithInHouseStay = await createOrder({
      unitId: demo.bedAId,
      arrivalDate: "2029-02-16",
      departureDate: "2029-02-17",
      prefix: "occupancy-reserved-in-house-stay"
    });
    await db.updateTable("stays")
      .set({ status: "IN_HOUSE" })
      .where("id", "=", reservedWithInHouseStay.result!.stayId as string)
      .execute();
    const reservedMismatch = await board({ arrivalDate: "2029-02-16", departureDate: "2029-02-17" });
    const reservedMismatchInterval = unitIn(reservedMismatch, demo.bedAId).intervals.find((interval) => interval.references
      .some((item) => item.type === "ORDER" && item.id === reservedWithInHouseStay.result!.orderId));
    expect(reservedMismatch.projectionState).toBe("PARTIAL");
    expect(reservedMismatchInterval).toMatchObject({ status: "UNKNOWN", primaryOccupantLabel: null });
    expect(unitIn(reservedMismatch, demo.roomId).bedOccupancies).toEqual([]);
    expect(JSON.stringify(reservedMismatch)).not.toContain("RS occupancy-reserved-in-house-stay");

    const checkedInWithPlannedStay = await createOrder({
      unitId: demo.bedBId,
      arrivalDate: "2029-02-18",
      departureDate: "2029-02-19",
      prefix: "occupancy-checked-in-planned-stay"
    });
    await db.updateTable("orders")
      .set({ status: "CHECKED_IN" })
      .where("id", "=", checkedInWithPlannedStay.result!.orderId as string)
      .execute();
    const checkedInMismatch = await board({ arrivalDate: "2029-02-18", departureDate: "2029-02-19" });
    const checkedInMismatchInterval = unitIn(checkedInMismatch, demo.bedBId).intervals.find((interval) => interval.references
      .some((item) => item.type === "ORDER" && item.id === checkedInWithPlannedStay.result!.orderId));
    expect(checkedInMismatch.projectionState).toBe("PARTIAL");
    expect(checkedInMismatchInterval).toMatchObject({ status: "UNKNOWN", primaryOccupantLabel: null });
    expect(unitIn(checkedInMismatch, demo.roomId).bedOccupancies).toEqual([]);
    expect(JSON.stringify(checkedInMismatch)).not.toContain("RS occupancy-checked-in-planned-stay");

    const incompleteRoomId = "unit_room_status_incomplete_occupancy_catalog";
    await db.insertInto("inventory_units").values({
      id: incompleteRoomId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: "INCOMPLETE-OCCUPANCY",
      name: "Incomplete occupancy catalog room",
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "WHOLE_ROOM_COMBINATION",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: 4
    }).execute();
    await db.insertInto("inventory_units").values(["A", "B"].map((code) => ({
      id: `${incompleteRoomId}_bed_${code.toLowerCase()}`,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: incompleteRoomId,
      code: `INCOMPLETE-OCCUPANCY-${code}`,
      name: `Incomplete occupancy catalog bed ${code}`,
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: null
    }))).execute();
    const incompleteCatalog = await board({ arrivalDate: "2029-02-01", departureDate: "2029-02-03" });
    expect(incompleteCatalog.projectionState).toBe("PARTIAL");
    expect(unitIn(incompleteCatalog, incompleteRoomId).bedOccupancies).toEqual([]);
  });

  it("projects inherited bed conflicts, complete maintenance release, stale Preview zero-write, and monotonic revision", async () => {
    const initial = await board({ arrivalDate: "2028-08-01", departureDate: "2028-08-06" });
    expect(initial.revision).toBe("0");
    const businessFactsBefore = await lodgingBusinessFactCounts();

    const placed = await prepare({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: "2028-08-01",
        departureDate: "2028-08-03",
        reason: "Staff operational use"
      }
    }, "maintenance-place");
    expect(placed.preview.effect).toMatchObject({
      arrivalDate: "2028-08-01",
      departureDate: "2028-08-03",
      reason: "Staff operational use"
    });
    const confirmation = await confirmPrepared(placed, "maintenance-place");
    const blockId = confirmation.receipt.result!.maintenanceLockId as string;
    expect(confirmation.receipt.resourceRefs).toContain(blockId);
    expect(confirmation.receipt.factRefs).toHaveLength(2);
    expect(await lodgingBusinessFactCounts()).toEqual(businessFactsBefore);
    const claimsByDate = await db.selectFrom("inventory_claims")
      .select(["id", "service_date"])
      .where("source_type", "=", "MAINTENANCE")
      .where("source_id", "=", blockId)
      .orderBy("service_date")
      .execute();

    const occupied = await board({ arrivalDate: "2028-08-01", departureDate: "2028-08-06" });
    expect(occupied.revision).toBe("1");
    const parent = unitIn(occupied, demo.roomId);
    const bedA = unitIn(occupied, demo.bedAId);
    const bedB = unitIn(occupied, demo.bedBId);
    expect(parent.days[0]).toMatchObject({ status: "MAINTENANCE", available: false });
    expect(bedA.days[0]).toMatchObject({ status: "MAINTENANCE", available: false });
    expect(bedB.days[0]).toMatchObject({ status: "AVAILABLE", available: true });
    expect(parent.conflicts[0]).toMatchObject({
      requestedInventoryUnitId: demo.roomId,
      actualInventoryUnitId: demo.bedAId,
      sourceKind: "MAINTENANCE",
      startDate: "2028-08-01",
      endDate: "2028-08-03",
      blocking: true
    });
    expect(parent.conflicts[0]!.claimIds).toEqual(claimsByDate.map((claim) => claim.id));
    expect(parent.conflicts[0]!.claimId).toBe(claimsByDate[0]!.id);
    expect(parent.days[0]!.conflicts[0]).toMatchObject({
      startDate: "2028-08-01",
      endDate: "2028-08-02",
      requestedInventoryUnitId: demo.roomId,
      actualInventoryUnitId: demo.bedAId,
      claimId: claimsByDate[0]!.id,
      claimIds: [claimsByDate[0]!.id]
    });
    expect(parent.days[1]!.conflicts[0]).toMatchObject({
      startDate: "2028-08-02",
      endDate: "2028-08-03",
      claimId: claimsByDate[1]!.id,
      claimIds: [claimsByDate[1]!.id]
    });
    const bedACode = await db.selectFrom("inventory_units").select("code").where("id", "=", demo.bedAId).executeTakeFirstOrThrow();
    const oneBedMatch = await board({
      arrivalDate: "2028-08-01",
      departureDate: "2028-08-06",
      search: bedACode.code,
      unitKind: "BED"
    });
    const oneBedParent = unitIn(oneBedMatch, demo.roomId);
    expect(oneBedParent.childUnitIds).toEqual([demo.bedAId, demo.bedBId, demo.bedCId, demo.bedDId]);
    expect(oneBedParent.children.map((child) => child.id)).toEqual([demo.bedAId]);
    expect(bedA.intervals[0]!.allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RELEASE_MAINTENANCE", enabled: true, requiresFullInterval: true })
    ]));
    expect(bedA.intervals[0]).toMatchObject({
      startDate: "2028-08-01",
      endDate: "2028-08-03",
      sourceStartDate: "2028-08-01",
      sourceEndDate: "2028-08-03"
    });

    const replay = await confirmCommandPreview(
      db,
      writePrincipal,
      placed.preview.previewId,
      confirmation.confirmation,
      confirmation.confirmMetadata
    );
    expect(replay).toEqual(confirmation.receipt);
    expect(await db.selectFrom("maintenance_locks").select("id").execute()).toHaveLength(1);
    expect((await board({ arrivalDate: "2028-08-01", departureDate: "2028-08-06" })).revision).toBe("1");

    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId: blockId }
    }, "maintenance-release");
    const released = await board({ arrivalDate: "2028-08-01", departureDate: "2028-08-06" });
    expect(released.revision).toBe("2");
    expect(unitIn(released, demo.bedAId).days[0]).toMatchObject({ status: "AVAILABLE", available: true });
    expect(unitIn(released, demo.bedAId).intervals.some((interval) => interval.sourceKind === "MAINTENANCE")).toBe(false);

    const stale = await prepare({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: "2028-08-04",
        departureDate: "2028-08-06",
        reason: "Preview that will become stale"
      }
    }, "maintenance-stale");
    await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        arrivalDate: "2028-08-04",
        departureDate: "2028-08-06",
        reason: "Competing whole-room maintenance"
      }
    }, "maintenance-wins");
    const staleReceipt = (await confirmPrepared(stale, "maintenance-stale-confirm")).receipt;
    expect(staleReceipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
    expect(staleReceipt.error).toMatchObject({ code: "PREVIEW_STALE" });
    expect(await db.selectFrom("maintenance_locks").select("id").where("reason", "=", "Preview that will become stale").execute()).toHaveLength(0);
    expect((await board({ arrivalDate: "2028-08-01", departureDate: "2028-08-06" })).revision).toBe("3");
  });

  it("derives normal and overdue order tasks from the property business date across the full property", async () => {
    const baseline = await board({ arrivalDate: "2030-01-01", departureDate: "2030-01-02" });
    const businessDate = baseline.businessDate;
    const twoDaysAgo = shiftLocalDate(businessDate, -2);
    const yesterday = shiftLocalDate(businessDate, -1);
    const tomorrow = shiftLocalDate(businessDate, 1);
    const rooms = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .orderBy("code")
      .limit(11)
      .execute();
    expect(rooms).toHaveLength(11);

    const arrival = await createOrder({
      unitId: rooms[0]!.id,
      arrivalDate: businessDate,
      departureDate: tomorrow,
      prefix: "task-arrival"
    });
    const arrivalOrderId = arrival.result!.orderId as string;

    const inHouse = await createOrder({
      unitId: rooms[1]!.id,
      arrivalDate: yesterday,
      departureDate: tomorrow,
      prefix: "task-in-house"
    });
    const inHouseOrderId = inHouse.result!.orderId as string;
    await markOrderInHouseFixture(inHouseOrderId);

    const departure = await createOrder({
      unitId: rooms[2]!.id,
      arrivalDate: yesterday,
      departureDate: businessDate,
      prefix: "task-departure"
    });
    const departureOrderId = departure.result!.orderId as string;
    await markOrderInHouseFixture(departureOrderId);

    const moved = await createOrder({
      unitId: rooms[3]!.id,
      arrivalDate: yesterday,
      departureDate: tomorrow,
      prefix: "task-move"
    });
    const movedOrderId = moved.result!.orderId as string;
    await markOrderInHouseFixture(movedOrderId);
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: movedOrderId,
        newInventoryUnitId: rooms[4]!.id,
        effectiveDate: businessDate
      }
    }, "task-move-unit");

    const overdueArrival = await createOrder({
      unitId: rooms[5]!.id,
      arrivalDate: yesterday,
      departureDate: tomorrow,
      prefix: "task-overdue-arrival"
    });
    const overdueArrivalOrderId = overdueArrival.result!.orderId as string;

    const overdueDeparture = await createOrder({
      unitId: rooms[6]!.id,
      arrivalDate: twoDaysAgo,
      departureDate: yesterday,
      prefix: "task-overdue-departure"
    });
    const overdueDepartureOrderId = overdueDeparture.result!.orderId as string;
    await markOrderInHouseFixture(overdueDepartureOrderId);

    const cancelled = await createOrder({
      unitId: rooms[7]!.id,
      arrivalDate: yesterday,
      departureDate: tomorrow,
      prefix: "task-overdue-cancelled"
    });
    const cancelledOrderId = cancelled.result!.orderId as string;
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: cancelledOrderId } }, "task-overdue-cancelled-close");

    const noShow = await createOrder({
      unitId: rooms[8]!.id,
      arrivalDate: yesterday,
      departureDate: tomorrow,
      prefix: "task-overdue-no-show"
    });
    const noShowOrderId = noShow.result!.orderId as string;
    await execute({ commandType: "MARK_NO_SHOW", input: { propertyId: demo.propertyId, orderId: noShowOrderId } }, "task-overdue-no-show-close");

    const longFreeStayReason = "免".repeat(1_000);
    const overdueFreeStay = await createOrder({
      unitId: rooms[9]!.id,
      arrivalDate: yesterday,
      departureDate: tomorrow,
      prefix: "task-overdue-free-stay",
      stayType: "FREE",
      freeStayReason: longFreeStayReason
    });
    const overdueFreeStayOrderId = overdueFreeStay.result!.orderId as string;

    const inconsistentLifecycle = await createOrder({
      unitId: rooms[10]!.id,
      arrivalDate: businessDate,
      departureDate: tomorrow,
      prefix: "task-inconsistent-lifecycle"
    });
    const inconsistentLifecycleOrderId = inconsistentLifecycle.result!.orderId as string;
    await db.updateTable("stays")
      .set({ status: "IN_HOUSE" })
      .where("id", "=", inconsistentLifecycle.result!.stayId as string)
      .execute();

    const result = await board({ arrivalDate: "2030-02-01", departureDate: "2030-02-02", page: 0, pageSize: 1 });
    expect(result.businessDate).toBe(businessDate);
    expect(result.projectionState).toBe("PARTIAL");
    const taskForOrder = (orderId: string) => result.operationalTasks.find((task) => task.references.some((item) => item.type === "ORDER" && item.id === orderId));

    expect(taskForOrder(arrivalOrderId)).toMatchObject({
      taskKind: "ARRIVAL",
      businessDate,
      actualInventoryUnitId: rooms[0]!.id,
      startDate: businessDate,
      endDate: tomorrow,
      sourceStartDate: businessDate,
      sourceEndDate: tomorrow,
      status: "RESERVED",
      blocking: true,
      conflicts: [expect.objectContaining({
        blockingFactKind: "CLAIM",
        claimId: expect.any(String),
        claimIds: [expect.any(String)],
        startDate: businessDate,
        endDate: tomorrow,
        sourceReference: expect.objectContaining({ type: "ORDER", id: arrivalOrderId })
      })]
    });
    expect(taskForOrder(inHouseOrderId)).toMatchObject({
      taskKind: "IN_HOUSE",
      businessDate,
      actualInventoryUnitId: rooms[1]!.id,
      startDate: yesterday,
      endDate: tomorrow,
      sourceStartDate: yesterday,
      sourceEndDate: tomorrow,
      status: "IN_HOUSE",
      blocking: true,
      conflicts: [expect.objectContaining({
        blockingFactKind: "CLAIM",
        claimId: expect.any(String),
        claimIds: [expect.any(String)],
        startDate: businessDate,
        endDate: tomorrow,
        sourceReference: expect.objectContaining({ type: "ORDER", id: inHouseOrderId })
      })]
    });
    expect(taskForOrder(inconsistentLifecycleOrderId)).toMatchObject({
      taskKind: "EXCEPTION",
      businessDate,
      actualInventoryUnitId: rooms[10]!.id,
      status: "UNKNOWN",
      primaryOccupantLabel: null,
      blocking: true,
      reason: expect.stringContaining("Stay 状态 IN_HOUSE")
    });
    expect(result.operationalTasks.filter((task) => task.references
      .some((item) => item.type === "ORDER" && item.id === inconsistentLifecycleOrderId))).toHaveLength(1);
    expect(taskForOrder(departureOrderId)).toMatchObject({
      taskKind: "DEPARTURE",
      businessDate,
      actualInventoryUnitId: rooms[2]!.id,
      startDate: yesterday,
      endDate: businessDate,
      sourceStartDate: yesterday,
      sourceEndDate: businessDate,
      status: "IN_HOUSE",
      available: false,
      blocking: true,
      claimIds: [],
      conflicts: [expect.objectContaining({
        blockingFactKind: "LODGING_ORDER",
        claimId: null,
        claimIds: [],
        startDate: businessDate,
        endDate: tomorrow,
        sourceReference: expect.objectContaining({ type: "ORDER", id: departureOrderId })
      })]
    });
    expect(taskForOrder(movedOrderId)).toMatchObject({
      taskKind: "IN_HOUSE",
      businessDate,
      actualInventoryUnitId: rooms[4]!.id,
      sourceStartDate: yesterday,
      sourceEndDate: tomorrow
    });
    expect(taskForOrder(movedOrderId)?.actualInventoryUnitId).not.toBe(rooms[3]!.id);
    const movedStayId = moved.result!.stayId as string;
    const movedTimeline = await board({ arrivalDate: yesterday, departureDate: tomorrow, pageSize: 200 });
    const movedIntervalIn = (unitId: string) => unitIn(movedTimeline, unitId).intervals.find((interval) => (
      interval.references.some((reference) => reference.type === "ORDER" && reference.id === movedOrderId)
    ));
    expect(movedIntervalIn(rooms[3]!.id)).toMatchObject({
      actualInventoryUnitId: rooms[3]!.id,
      startDate: yesterday,
      endDate: businessDate,
      operationalAttention: null,
      references: expect.arrayContaining([expect.objectContaining({ type: "STAY", id: movedStayId })])
    });
    expect(movedIntervalIn(rooms[4]!.id)).toMatchObject({
      actualInventoryUnitId: rooms[4]!.id,
      startDate: businessDate,
      endDate: tomorrow,
      operationalAttention: null,
      references: expect.arrayContaining([expect.objectContaining({ type: "STAY", id: movedStayId })])
    });
    expect(taskForOrder(overdueArrivalOrderId)).toMatchObject({
      taskKind: "EXCEPTION",
      businessDate,
      actualInventoryUnitId: rooms[5]!.id,
      startDate: yesterday,
      endDate: tomorrow,
      sourceStartDate: yesterday,
      sourceEndDate: tomorrow,
      status: "RESERVED",
      operationalAttention: "OVERDUE_RESERVED",
      available: false,
      blocking: true,
      reason: `计划到店日 ${yesterday} 已早于营业日 ${businessDate}，订单仍处于已预订`,
      references: expect.arrayContaining([
        expect.objectContaining({ type: "ORDER", id: overdueArrivalOrderId }),
        expect.objectContaining({ type: "STAY" }),
        expect.objectContaining({ type: "INVENTORY_UNIT", id: rooms[5]!.id })
      ])
    });
    expect(taskForOrder(overdueDepartureOrderId)).toMatchObject({
      taskKind: "EXCEPTION",
      businessDate,
      actualInventoryUnitId: rooms[6]!.id,
      startDate: twoDaysAgo,
      endDate: yesterday,
      sourceStartDate: twoDaysAgo,
      sourceEndDate: yesterday,
      status: "IN_HOUSE",
      operationalAttention: "OVERDUE_IN_HOUSE",
      available: true,
      blocking: false,
      reason: `计划退房日 ${yesterday} 已早于营业日 ${businessDate}，订单仍处于在住`,
      references: expect.arrayContaining([
        expect.objectContaining({ type: "ORDER", id: overdueDepartureOrderId }),
        expect.objectContaining({ type: "STAY" }),
        expect.objectContaining({ type: "INVENTORY_UNIT", id: rooms[6]!.id })
      ]),
      claimIds: [],
      conflicts: [],
      allowedActions: expect.arrayContaining([expect.objectContaining({ code: "OPEN_ORDER", enabled: true })])
    });
    const future = shiftLocalDate(businessDate, 3);
    const todayBoard = await board({ arrivalDate: businessDate, departureDate: future, pageSize: 200 });
    const overdueUnit = unitIn(todayBoard, rooms[6]!.id);
    expect(overdueUnit.days).toHaveLength(3);
    expect(overdueUnit.days).toEqual(expect.arrayContaining([
      expect.objectContaining({ serviceDate: businessDate, status: "AVAILABLE", available: true, conflicts: [] }),
      expect.objectContaining({ serviceDate: tomorrow, status: "AVAILABLE", available: true, conflicts: [] })
    ]));
    expect(overdueUnit.intervals.some((interval) => interval.references
      .some((reference) => reference.type === "ORDER" && reference.id === overdueDepartureOrderId))).toBe(false);
    expect(overdueUnit.conflicts.some((conflict) => conflict.blockingFactKind === "OVERDUE_IN_HOUSE")).toBe(false);
    expect(overdueUnit.allowedActions.some((action) => action.code === "CREATE_ORDER" && action.enabled)).toBe(true);

    const historicalOverdueBoard = await board({ arrivalDate: twoDaysAgo, departureDate: businessDate, pageSize: 200 });
    const overdueHistoricalInterval = intervalForOrder(
      historicalOverdueBoard,
      rooms[6]!.id,
      overdueDepartureOrderId
    );
    expect(overdueHistoricalInterval).toMatchObject({
      startDate: twoDaysAgo,
      endDate: yesterday,
      status: "IN_HOUSE",
      operationalAttention: "OVERDUE_IN_HOUSE"
    });
    expect(overdueHistoricalInterval.endDate < businessDate).toBe(true);

    const departureUnit = unitIn(todayBoard, rooms[2]!.id);
    expect(departureUnit.days[0]).toMatchObject({ serviceDate: businessDate, status: "IN_HOUSE", available: false });
    expect(departureUnit.intervals).toEqual(expect.arrayContaining([expect.objectContaining({
      startDate: businessDate,
      endDate: tomorrow,
      sourceStartDate: businessDate,
      sourceEndDate: tomorrow,
      status: "IN_HOUSE",
      blocking: true,
      conflicts: [expect.objectContaining({
        blockingFactKind: "LODGING_ORDER",
        claimId: null,
        claimIds: [],
        sourceReference: expect.objectContaining({ type: "ORDER", id: departureOrderId })
      })]
    })]));
    expect(departureUnit.conflicts.some((conflict) => conflict.blockingFactKind === "OVERDUE_IN_HOUSE")).toBe(false);

    const availability = await listAvailability(db, demo.propertyId, businessDate, tomorrow, "ROOM");
    expect(availability.find((unit) => unit.id === rooms[6]!.id)?.nights[0]).toMatchObject({
      serviceDate: businessDate,
      available: true,
      blockingClaimIds: []
    });
    expect(availability.find((unit) => unit.id === rooms[2]!.id)?.nights[0]).toMatchObject({
      serviceDate: businessDate,
      available: false,
      blockingClaimIds: []
    });
    expect(availability.find((unit) => unit.id === rooms[6]!.id)?.nights[0]).not.toHaveProperty("blockingStayIds");
    expect(availability.find((unit) => unit.id === rooms[2]!.id)?.nights[0]).not.toHaveProperty("blockingStayIds");
    await expect(createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: rooms[2]!.id,
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate: tomorrow,
      pricingPolicyVersionId: testPricingPolicyForDates(businessDate, tomorrow)
    })).rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    await expect(createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: rooms[6]!.id,
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate: tomorrow,
      pricingPolicyVersionId: testPricingPolicyForDates(businessDate, tomorrow)
    })).resolves.toMatchObject({
      inventoryUnitId: rooms[6]!.id,
      arrivalDate: businessDate,
      departureDate: tomorrow
    });
    expect(taskForOrder(cancelledOrderId)).toBeUndefined();
    expect(taskForOrder(noShowOrderId)).toBeUndefined();
    expect(taskForOrder(overdueFreeStayOrderId)).toMatchObject({
      taskKind: "EXCEPTION",
      sourceKind: "FREE_STAY",
      status: "RESERVED",
      operationalAttention: "OVERDUE_RESERVED",
      blocking: true
    });
    expect(taskForOrder(overdueFreeStayOrderId)?.reason).toContain(longFreeStayReason);
    expect(taskForOrder(overdueFreeStayOrderId)?.reason?.length).toBeGreaterThan(1_000);
    expect(validateRoomStatusBoardSchema(result), JSON.stringify(validateRoomStatusBoardSchema.errors)).toBe(true);
    expect(() => assertRoomStatusBoard(result, {
      propertyId: demo.propertyId,
      range: { arrivalDate: "2030-02-01", departureDate: "2030-02-02" },
      pageIndex: 0
    })).not.toThrow();
  });

  it("projects the original arrival date across an overdue reserved prearranged bed move", async () => {
    const baseline = await board({ arrivalDate: "2030-02-01", departureDate: "2030-02-02" });
    const businessDate = baseline.businessDate;
    const orderArrivalDate = shiftLocalDate(businessDate, -2);
    const moveDate = shiftLocalDate(businessDate, 1);
    const departureDate = shiftLocalDate(businessDate, 3);
    const parentRoomId = "unit_room_status_overdue_move_fixture";
    const sourceBedId = `${parentRoomId}_bed_a`;
    const destinationBedId = `${parentRoomId}_bed_b`;
    await db.insertInto("inventory_units").values({
      id: parentRoomId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: "OVERDUE-MOVE",
      name: "Overdue move fixture room",
      active: true,
      catalog_version: "test-overdue-move",
      building_code: "TEST",
      room_type_code: "shared_bath_double",
      pricing_product_code: "shared_bath_double_whole_room",
      inventory_basis: "WHOLE_ROOM_COMBINATION",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: 2,
      occupancy_capacity: 2
    }).execute();
    await db.insertInto("inventory_units").values([sourceBedId, destinationBedId].map((id, index) => ({
      id,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: parentRoomId,
      code: `OVERDUE-MOVE-${index === 0 ? "A" : "B"}`,
      name: `Overdue move fixture bed ${index === 0 ? "A" : "B"}`,
      active: true,
      catalog_version: "test-overdue-move",
      building_code: "TEST",
      room_type_code: "shared_bath_double",
      pricing_product_code: "shared_bath_double_bed",
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: null,
      occupancy_capacity: 1
    }))).execute();
    const created = await createOrder({
      unitId: sourceBedId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "overdue-prearranged-bed-move",
      bookingChannelCode: "YOUMUDAO"
    });
    const orderId = created.result!.orderId as string;
    const currentAmount = await db.selectFrom("orders as order")
      .innerJoin("pricing_revisions as revision", "revision.id", "order.current_revision_id")
      .select("revision.current_contract_amount_minor")
      .where("order.id", "=", orderId)
      .executeTakeFirstOrThrow();
    const moved = await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: destinationBedId,
        effectiveDate: moveDate,
        targetCurrentContractAmountMinor: currentAmount.current_contract_amount_minor
      }
    }, "overdue-prearranged-bed-move");
    expect(moved.executionStatus).toBe("EXECUTED");
    await db.updateTable("orders")
      .set({ arrival_date: orderArrivalDate })
      .where("id", "=", orderId)
      .execute();

    const activeClaims = await db.selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select(["claim.service_date", "claim.inventory_unit_id"])
      .where("stay.order_id", "=", orderId)
      .where("claim.active", "=", true)
      .orderBy("claim.service_date")
      .execute();
    expect(activeClaims).toEqual([
      { service_date: businessDate, inventory_unit_id: sourceBedId },
      { service_date: moveDate, inventory_unit_id: destinationBedId },
      { service_date: shiftLocalDate(moveDate, 1), inventory_unit_id: destinationBedId }
    ]);

    const result = await board({
      arrivalDate: businessDate,
      departureDate,
      pageSize: 200
    });
    const belongsToOrder = (interval: RoomStatusUnitDto["intervals"][number]) => interval.references
      .some((reference) => reference.type === "ORDER" && reference.id === orderId);
    const originalRun = unitIn(result, sourceBedId).intervals.find(belongsToOrder);
    const movedRun = unitIn(result, destinationBedId).intervals.find(belongsToOrder);
    const parentRuns = unitIn(result, parentRoomId).intervals.filter(belongsToOrder);

    expect(originalRun).toMatchObject({
      actualInventoryUnitId: sourceBedId,
      startDate: businessDate,
      endDate: moveDate,
      sourceStartDate: businessDate,
      sourceEndDate: moveDate,
      orderArrivalDate,
      status: "RESERVED"
    });
    expect(movedRun).toMatchObject({
      actualInventoryUnitId: destinationBedId,
      startDate: moveDate,
      endDate: departureDate,
      sourceStartDate: moveDate,
      sourceEndDate: departureDate,
      orderArrivalDate,
      status: "RESERVED"
    });
    expect(parentRuns).toHaveLength(2);
    expect(parentRuns.map((interval) => interval.actualInventoryUnitId).sort()).toEqual([sourceBedId, destinationBedId].sort());
  });

  it("keeps an ended overdue reservation task healthy without projecting debt outside its stay interval", async () => {
    const baseline = await board({ arrivalDate: "2030-02-01", departureDate: "2030-02-02" });
    const businessDate = baseline.businessDate;
    const arrivalDate = shiftLocalDate(businessDate, -3);
    const departureDate = shiftLocalDate(businessDate, -1);
    const created = await withPropertyClockForTesting(
      new Date(`${arrivalDate}T12:00:00.000Z`),
      () => createOrder({
        unitId: demo.secondRoomId,
        arrivalDate,
        departureDate,
        prefix: "ended-overdue-reserved-attention"
      })
    );
    const orderId = created.result!.orderId as string;

    const result = await board({ arrivalDate: businessDate, departureDate: shiftLocalDate(businessDate, 1) });
    expect(taskForOrder(result, orderId)).toMatchObject({
      status: "RESERVED",
      attention: null,
      operationalAttention: "OVERDUE_RESERVED"
    });
  });

  it("fails an ended overdue reservation task closed when its current pricing revision is missing", async () => {
    const baseline = await board({ arrivalDate: "2030-02-01", departureDate: "2030-02-02" });
    const businessDate = baseline.businessDate;
    const arrivalDate = shiftLocalDate(businessDate, -3);
    const departureDate = shiftLocalDate(businessDate, -1);
    const created = await withPropertyClockForTesting(
      new Date(`${arrivalDate}T12:00:00.000Z`),
      () => createOrder({
        unitId: demo.secondRoomId,
        arrivalDate,
        departureDate,
        prefix: "ended-overdue-missing-current-revision"
      })
    );
    const orderId = created.result!.orderId as string;
    await db.updateTable("orders").set({ current_revision_id: null }).where("id", "=", orderId).execute();

    const result = await board({ arrivalDate: businessDate, departureDate: shiftLocalDate(businessDate, 1) });
    expect(result.projectionState).toBe("PARTIAL");
    expect(taskForOrder(result, orderId)).toMatchObject({
      taskKind: "EXCEPTION",
      status: "UNKNOWN",
      attention: null,
      operationalAttention: null,
      available: true,
      blocking: false,
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: [],
      allowedActions: []
    });
  });

  it("fails closed consistently in the grid and task projection when a current lodging Claim is missing", async () => {
    const baseline = await board({ arrivalDate: "2030-02-01", departureDate: "2030-02-02" });
    const businessDate = baseline.businessDate;
    const tomorrow = shiftLocalDate(businessDate, 1);
    const inventoryUnit = await db.selectFrom("inventory_units")
      .select("id")
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .orderBy("code")
      .executeTakeFirstOrThrow();
    const created = await createOrder({
      unitId: inventoryUnit.id,
      arrivalDate: businessDate,
      departureDate: tomorrow,
      prefix: "task-missing-current-claim"
    });
    const orderId = created.result!.orderId as string;
    const claim = await db.selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select(["claim.id", "claim.inventory_unit_id"])
      .where("claim.source_type", "=", "ORDER_SEGMENT")
      .where("claim.service_date", "=", businessDate)
      .where("claim.active", "=", true)
      .where("stay.order_id", "=", orderId)
      .executeTakeFirstOrThrow();
    await db.updateTable("inventory_claims")
      .set({ active: false, released_at: new Date() })
      .where("id", "=", claim.id)
      .execute();

    const result = await board({ arrivalDate: businessDate, departureDate: tomorrow, pageSize: 200 });
    const tasks = result.operationalTasks.filter((candidate) => candidate.references.some((item) => item.type === "ORDER" && item.id === orderId));
    expect(result.projectionState).toBe("PARTIAL");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskKind: "EXCEPTION",
      status: "UNKNOWN",
      blocking: true,
      reason: `营业日 ${businessDate} 的住宿订单占用记录缺失`,
      claimIds: [],
      conflicts: [expect.objectContaining({
        blockingFactKind: "LODGING_ORDER",
        claimId: null,
        claimIds: [],
        startDate: businessDate,
        endDate: tomorrow,
        sourceReference: expect.objectContaining({ type: "ORDER", id: orderId })
      })]
    });
    const unit = unitIn(result, claim.inventory_unit_id);
    expect(unit.days[0]).toMatchObject({ status: "UNKNOWN", available: false });
    expect(unit.intervals).toEqual(expect.arrayContaining([expect.objectContaining({
      status: "UNKNOWN",
      blocking: true,
      conflicts: [expect.objectContaining({
        blockingFactKind: "LODGING_ORDER",
        startDate: businessDate,
        endDate: tomorrow,
        sourceReference: expect.objectContaining({ type: "ORDER", id: orderId })
      })]
    })]));
    expect(() => assertRoomStatusBoard(result, {
      propertyId: demo.propertyId,
      range: { arrivalDate: businessDate, departureDate: tomorrow },
      pageIndex: 0
    })).not.toThrow();
  });

  it("keeps today's exceptions independent of the matrix range and page, excludes future Blocks, and removes released Blocks", async () => {
    const baseline = await board({ arrivalDate: "2030-03-01", departureDate: "2030-03-02" });
    const businessDate = baseline.businessDate;
    const tomorrow = shiftLocalDate(businessDate, 1);
    const futureStart = shiftLocalDate(businessDate, 10);
    const futureEnd = shiftLocalDate(businessDate, 12);
    const awayStart = shiftLocalDate(businessDate, 30);
    const awayEnd = shiftLocalDate(businessDate, 31);
    const lastRoom = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .orderBy("code", "desc")
      .executeTakeFirstOrThrow();

    const todayBlock = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: lastRoom.id,
        arrivalDate: businessDate,
        departureDate: tomorrow,
        reason: "Today's paginated exception"
      }
    }, "today-exception");
    const todayBlockId = todayBlock.result!.maintenanceLockId as string;
    const futureBlock = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: lastRoom.id,
        arrivalDate: futureStart,
        departureDate: futureEnd,
        reason: "Future Block must not become today's exception"
      }
    }, "future-exception");
    const futureBlockId = futureBlock.result!.maintenanceLockId as string;

    const outsideWindowAndPage = await board({
      arrivalDate: awayStart,
      departureDate: awayEnd,
      page: 0,
      pageSize: 1
    });
    expect(outsideWindowAndPage.rooms.some((room) => room.id === lastRoom.id)).toBe(false);
    const todayTask = outsideWindowAndPage.operationalTasks.find((task) => task.references.some((item) => item.type === "BLOCK" && item.id === todayBlockId));
    expect(todayTask).toMatchObject({
      taskKind: "EXCEPTION",
      businessDate,
      actualInventoryUnitId: lastRoom.id,
      startDate: businessDate,
      endDate: tomorrow,
      sourceStartDate: businessDate,
      sourceEndDate: tomorrow,
      sourceKind: "MAINTENANCE",
        status: "MAINTENANCE",
        blocking: true,
        conflicts: [expect.objectContaining({
          blockingFactKind: "CLAIM",
          claimId: expect.any(String),
          startDate: businessDate,
          endDate: tomorrow
        })]
    });
    expect(outsideWindowAndPage.operationalTasks.some((task) => task.references.some((item) => item.type === "BLOCK" && item.id === futureBlockId))).toBe(false);

    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId: todayBlockId }
    }, "today-exception-release");
    const afterRelease = await board({ arrivalDate: awayStart, departureDate: awayEnd, page: 0, pageSize: 1 });
    expect(afterRelease.operationalTasks.some((task) => task.references.some((item) => item.type === "BLOCK" && item.id === todayBlockId))).toBe(false);
    expect(afterRelease.operationalTasks.some((task) => task.references.some((item) => item.type === "BLOCK" && item.id === futureBlockId))).toBe(false);
    expect(await db.selectFrom("maintenance_locks").select("status").where("id", "=", todayBlockId).executeTakeFirstOrThrow())
      .toEqual({ status: "RELEASED" });
    expect(await db.selectFrom("inventory_claims").select("id").where("source_type", "=", "MAINTENANCE").where("source_id", "=", todayBlockId).where("active", "=", true).execute())
      .toHaveLength(0);
  });

  it("keeps inactive-unit exceptions stable across matrix ranges and outside the current page", async () => {
    const baseline = await board({ arrivalDate: "2030-03-01", departureDate: "2030-03-02" });
    const businessDate = baseline.businessDate;
    const inactiveRoom = await db.selectFrom("inventory_units")
      .select("id")
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .orderBy("code", "desc")
      .executeTakeFirstOrThrow();
    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", inactiveRoom.id).execute();
    try {
      const first = await board({ arrivalDate: "2031-01-01", departureDate: "2031-01-02", page: 0, pageSize: 1 });
      const second = await board({ arrivalDate: "2032-06-01", departureDate: "2032-06-03", page: 0, pageSize: 1 });
      expect(first.rooms.some((room) => room.id === inactiveRoom.id)).toBe(false);
      expect(second.rooms.some((room) => room.id === inactiveRoom.id)).toBe(false);
      const taskFrom = (result: RoomStatusBoardDto) => result.operationalTasks.find((task) => task.sourceKind === "UNIT_UNSELLABLE"
        && task.actualInventoryUnitId === inactiveRoom.id);
      const firstTask = taskFrom(first);
      const secondTask = taskFrom(second);
      expect(firstTask).toMatchObject({
        taskKind: "EXCEPTION",
        businessDate,
        startDate: businessDate,
        endDate: shiftLocalDate(businessDate, 1),
        sourceStartDate: businessDate,
        sourceEndDate: shiftLocalDate(businessDate, 1),
        status: "UNAVAILABLE",
        blocking: true,
        conflicts: [expect.objectContaining({
          blockingFactKind: "UNIT_UNSELLABLE",
          claimId: null,
          claimIds: [],
          startDate: businessDate,
          endDate: shiftLocalDate(businessDate, 1),
          sourceKind: "UNIT_UNSELLABLE",
          sourceReference: expect.objectContaining({ type: "INVENTORY_UNIT", id: inactiveRoom.id })
        })]
      });
      expect(secondTask).toEqual(firstTask);
      expect(() => assertRoomStatusBoard(first, {
        propertyId: demo.propertyId,
        range: { arrivalDate: "2031-01-01", departureDate: "2031-01-02" },
        pageIndex: 0
      })).not.toThrow();
    } finally {
      await db.updateTable("inventory_units").set({ active: true }).where("id", "=", inactiveRoom.id).execute();
    }
  });

  it("uses only active rooms and beds for the sellable tree while retaining inactive-bed audit references", async () => {
    const arrivalDate = "2031-03-01";
    const departureDate = "2031-03-03";
    const before = await board({ arrivalDate, departureDate, pageSize: 200 });
    const correctedRooms = [
      { id: "unit_room_105", code: "105", buildingCode: "1" },
      { id: "unit_room_108", code: "108", buildingCode: "1" },
      { id: "unit_room_206", code: "206", buildingCode: "2" }
    ] as const;
    const inactiveBedIds = correctedRooms.flatMap(({ id, code, buildingCode }) => ["C", "D"].map((suffix) => ({
      id: `${id}_bed_${suffix.toLowerCase()}`,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: id,
      code: `${code}-${suffix}`,
      name: `${code} · 床位 ${suffix}（已下线）`,
      active: false,
      catalog_version: "test-active-tree",
      building_code: buildingCode,
      room_type_code: "shared_bath_double",
      pricing_product_code: "shared_bath_double_bed",
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "SOURCE_EXPLICIT" as const,
      physical_bed_count: null,
      occupancy_capacity: 1
    })));
    await db.insertInto("inventory_units").values(inactiveBedIds).execute();

    const activeTree = await board({ arrivalDate, departureDate, pageSize: 200 });
    expect(activeTree.projectionState).toBe("READY");
    expect(activeTree.page).toEqual(before.page);
    expect(activeTree.availabilitySummary).toEqual(before.availabilitySummary);
    expect(activeTree.rooms.flatMap((room) => [room, ...room.children])
      .filter((unit) => inactiveBedIds.some((bed) => bed.id === unit.id))).toEqual([]);
    for (const { id, code } of correctedRooms) {
      const room = unitIn(activeTree, id);
      expect(room.capacity).toBe(2);
      expect(room.occupancyCapacity).toBe(2);
      expect(room.childUnitIds).toEqual([`${id}_bed_a`, `${id}_bed_b`]);
      expect(room.children.map((child) => child.id)).toEqual([`${id}_bed_a`, `${id}_bed_b`]);
      expect(room.children.every((child) => child.active)).toBe(true);
      expect(room.physicalBedCount).toBe(2);
      expect(room.bedSlotStates.filter((slot) => slot.serviceDate === arrivalDate)).toEqual([
        expect.objectContaining({ inventoryUnitId: `${id}_bed_a`, status: "AVAILABLE" }),
        expect.objectContaining({ inventoryUnitId: `${id}_bed_b`, status: "AVAILABLE" })
      ]);
      expect(activeTree.operationalTasks.filter((task) => task.actualInventoryUnitId.startsWith(`${id}_bed_`)))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            actualInventoryUnitId: `${id}_bed_c`,
            sourceKind: "UNIT_UNSELLABLE",
            references: expect.arrayContaining([expect.objectContaining({ type: "INVENTORY_UNIT", id: `${id}_bed_c` })])
          }),
          expect.objectContaining({
            actualInventoryUnitId: `${id}_bed_d`,
            sourceKind: "UNIT_UNSELLABLE",
            references: expect.arrayContaining([expect.objectContaining({ type: "INVENTORY_UNIT", id: `${id}_bed_d` })])
          })
        ]));
      const inactiveBedSearch = await board({
        arrivalDate,
        departureDate,
        pageSize: 200,
        search: `${code}-C`
      });
      expect(inactiveBedSearch.rooms).toEqual([]);
    }
    expect(() => assertRoomStatusBoard(activeTree, {
      propertyId: demo.propertyId,
      range: { arrivalDate, departureDate },
      pageIndex: 0
    })).not.toThrow();

    const activeBedFact = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: "unit_room_105_bed_a",
        arrivalDate,
        departureDate,
        reason: "An active bed fact must remain visible on its parent room"
      }
    }, "active-tree-active-bed-propagation");
    const propagatedBedFact = await board({ arrivalDate, departureDate, pageSize: 200 });
    for (const unitId of ["unit_room_105", "unit_room_105_bed_a"]) {
      expect(unitIn(propagatedBedFact, unitId).intervals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actualInventoryUnitId: "unit_room_105_bed_a",
          sourceKind: "MAINTENANCE",
          references: expect.arrayContaining([
            expect.objectContaining({ type: "BLOCK", id: activeBedFact.result!.maintenanceLockId })
          ])
        })
      ]));
    }
    await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: "unit_room_105",
        arrivalDate: "2031-03-03",
        departureDate: "2031-03-05",
        reason: "A parent fact must fan out only to active displayed beds"
      }
    }, "active-tree-parent-propagation");
    const propagatedParentFact = await board({
      arrivalDate: "2031-03-03",
      departureDate: "2031-03-05",
      pageSize: 200
    });
    for (const unitId of ["unit_room_105", "unit_room_105_bed_a", "unit_room_105_bed_b"]) {
      expect(unitIn(propagatedParentFact, unitId).intervals)
        .toEqual(expect.arrayContaining([expect.objectContaining({ actualInventoryUnitId: "unit_room_105" })]));
    }
    expect(propagatedParentFact.rooms.flatMap((room) => [room, ...room.children])
      .some((unit) => unit.id === "unit_room_105_bed_c" || unit.id === "unit_room_105_bed_d")).toBe(false);

    const hiddenBedId = inactiveBedIds[0]!.id;
    await db.updateTable("inventory_units").set({ active: true }).where("id", "=", hiddenBedId).execute();
    const hiddenMaintenance = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: hiddenBedId,
        arrivalDate,
        departureDate,
        reason: "Hidden inactive bed must remain fail closed while a current fact exists"
      }
    }, "active-tree-hidden-maintenance");
    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", hiddenBedId).execute();
    const hiddenCurrentFact = await board({ arrivalDate, departureDate, pageSize: 200 });
    expect(hiddenCurrentFact.projectionState).toBe("PARTIAL");
    expect(hiddenCurrentFact.rooms.flatMap((room) => [room, ...room.children]).some((unit) => unit.id === hiddenBedId)).toBe(false);
    expect(hiddenCurrentFact.operationalTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskKind: "EXCEPTION",
        actualInventoryUnitId: hiddenBedId,
        sourceKind: "MAINTENANCE",
        sourceStartDate: arrivalDate,
        sourceEndDate: departureDate,
        references: expect.arrayContaining([
          expect.objectContaining({ type: "BLOCK", id: hiddenMaintenance.result!.maintenanceLockId }),
          expect.objectContaining({ type: "CLAIM" })
        ])
      })
    ]));
    expect(hiddenCurrentFact.operationalTasks.filter((task) => task.actualInventoryUnitId === hiddenBedId
      && task.sourceKind === "UNIT_UNSELLABLE")).toHaveLength(1);

    await db.updateTable("inventory_units").set({ active: true }).where("id", "=", hiddenBedId).execute();
    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        maintenanceLockId: hiddenMaintenance.result!.maintenanceLockId as string
      }
    }, "active-tree-hidden-maintenance-release");
    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", hiddenBedId).execute();
    const releasedHiddenFact = await board({ arrivalDate, departureDate, pageSize: 200 });
    expect(releasedHiddenFact.projectionState).toBe("READY");
    expect(unitIn(releasedHiddenFact, "unit_room_105").bedSlotStates
      .filter((slot) => slot.serviceDate === arrivalDate)
      .map((slot) => slot.inventoryUnitId)).toEqual([
        "unit_room_105_bed_a",
        "unit_room_105_bed_b"
      ]);

    const malformedRoomId = "unit_room_status_active_tree_incomplete";
    await db.insertInto("inventory_units").values({
      id: malformedRoomId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: "ACTIVE-TREE-INCOMPLETE",
      name: "Active tree incomplete room",
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "WHOLE_ROOM_COMBINATION",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: 4,
      occupancy_capacity: 4
    }).execute();
    await db.insertInto("inventory_units").values(["A", "B"].map((suffix) => ({
      id: `${malformedRoomId}_bed_${suffix.toLowerCase()}`,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: malformedRoomId,
      code: `ACTIVE-TREE-INCOMPLETE-${suffix}`,
      name: `Active tree incomplete bed ${suffix}`,
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: null,
      occupancy_capacity: 1
    }))).execute();
    const malformed = await board({ arrivalDate, departureDate, pageSize: 200 });
    expect(malformed.projectionState).toBe("PARTIAL");
    expect(unitIn(malformed, malformedRoomId).bedOccupancies).toEqual([]);
  });

  it("derives the sellable bed catalog from active children and closes occupancy only when every active capacity agrees", async () => {
    const arrivalDate = "2031-04-01";
    const departureDate = "2031-04-03";
    const legacyRoomId = "unit_room_status_legacy_active_children";
    const legacyBeds = ["A", "B", "C", "D"].map((suffix, index) => ({
      id: `${legacyRoomId}_bed_${suffix.toLowerCase()}`,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: legacyRoomId,
      code: `LEGACY-ACTIVE-${suffix}`,
      name: `Legacy active child ${suffix}`,
      active: index < 2,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: null,
      occupancy_capacity: 1
    }));
    await db.insertInto("inventory_units").values({
      id: legacyRoomId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: "LEGACY-ACTIVE",
      name: "Legacy active room",
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "WHOLE_ROOM_COMBINATION",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: null,
      occupancy_capacity: 2
    }).execute();
    await db.insertInto("inventory_units").values(legacyBeds).execute();

    const legacy = await board({ arrivalDate, departureDate, pageSize: 200 });
    const legacyRoom = unitIn(legacy, legacyRoomId);
    expect(legacy.projectionState).toBe("READY");
    expect(legacyRoom).toMatchObject({ salesMode: "BED_SPLIT", capacity: 2, occupancyCapacity: 2 });
    expect(legacyRoom.childUnitIds).toEqual(legacyBeds.slice(0, 2).map((bed) => bed.id));
    expect(legacyRoom.children.map((bed) => bed.id)).toEqual(legacyBeds.slice(0, 2).map((bed) => bed.id));
    expect(legacy.rooms.flatMap((room) => [room, ...room.children])
      .some((unit) => legacyBeds.slice(2).some((bed) => bed.id === unit.id))).toBe(false);

    const retiredRoomId = "unit_room_status_all_historical_beds";
    await db.insertInto("inventory_units").values({
      id: retiredRoomId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: "HISTORICAL-BEDS",
      name: "Historical beds only room",
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "WHOLE_ROOM_COMBINATION",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: null,
      occupancy_capacity: 1
    }).execute();
    await db.insertInto("inventory_units").values(["A", "B"].map((suffix) => ({
      id: `${retiredRoomId}_bed_${suffix.toLowerCase()}`,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: retiredRoomId,
      code: `HISTORICAL-BEDS-${suffix}`,
      name: `Historical bed ${suffix}`,
      active: false,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: null,
      occupancy_capacity: 1
    }))).execute();
    const allHistorical = await board({ arrivalDate, departureDate, pageSize: 200 });
    expect(allHistorical.projectionState).toBe("READY");
    expect(unitIn(allHistorical, retiredRoomId)).toMatchObject({
      salesMode: "WHOLE_ROOM",
      capacity: 1,
      childUnitIds: [],
      children: [],
      bedOccupancies: []
    });

    const occupancyMismatchRoomId = "unit_room_status_active_occupancy_mismatch";
    await db.insertInto("inventory_units").values({
      id: occupancyMismatchRoomId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: "ACTIVE-OCCUPANCY-MISMATCH",
      name: "Active occupancy mismatch room",
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "WHOLE_ROOM_COMBINATION",
      code_provenance: "PMS_GENERATED",
      physical_bed_count: 2,
      occupancy_capacity: 3
    }).execute();
    await db.insertInto("inventory_units").values(["A", "B"].map((suffix) => ({
      id: `${occupancyMismatchRoomId}_bed_${suffix.toLowerCase()}`,
      property_id: demo.propertyId,
      kind: "BED" as const,
      parent_room_id: occupancyMismatchRoomId,
      code: `ACTIVE-OCCUPANCY-MISMATCH-${suffix}`,
      name: `Active occupancy mismatch bed ${suffix}`,
      active: true,
      catalog_version: null,
      building_code: "TEST",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: null,
      occupancy_capacity: 1
    }))).execute();
    const occupancyMismatch = await board({ arrivalDate, departureDate, pageSize: 200 });
    expect(occupancyMismatch.projectionState).toBe("PARTIAL");
    expect(unitIn(occupancyMismatch, occupancyMismatchRoomId).bedOccupancies).toEqual([]);
  });

  it("publishes a cross-window Block as safely releasable while preserving the complete source range and zero writes", async () => {
    const baseline = await board({ arrivalDate: "2030-04-01", departureDate: "2030-04-02" });
    const fullStart = shiftLocalDate(baseline.businessDate, 40);
    const fullEnd = shiftLocalDate(baseline.businessDate, 45);
    const visibleStart = shiftLocalDate(fullStart, 1);
    const visibleEnd = shiftLocalDate(fullEnd, -1);
    const placed = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: fullStart,
        departureDate: fullEnd,
        reason: "Cross-window complete Block"
      }
    }, "cross-window-place");
    const blockId = placed.result!.maintenanceLockId as string;
    const receiptCountBefore = await db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow();

    const partial = await board({ arrivalDate: visibleStart, departureDate: visibleEnd });
    const interval = unitIn(partial, demo.bedAId).intervals.find((candidate) => candidate.references.some((item) => item.type === "BLOCK" && item.id === blockId));
    expect(interval).toMatchObject({
      startDate: visibleStart,
      endDate: visibleEnd,
      sourceStartDate: fullStart,
      sourceEndDate: fullEnd,
      sourceKind: "MAINTENANCE",
      blocking: true
    });
    expect(interval?.allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "RELEASE_MAINTENANCE",
        enabled: true,
        requiresFullInterval: true,
        disabledReason: null,
        targetReference: expect.objectContaining({ type: "BLOCK", id: blockId })
      })
    ]));
    const releaseActions = partial.rooms.flatMap((room) => [room, ...room.children])
      .flatMap((unit) => [
        ...unit.allowedActions,
        ...unit.intervals.flatMap((item) => item.allowedActions)
      ])
      .filter((candidate) => candidate.code === "RELEASE_MAINTENANCE" && candidate.targetReference?.id === blockId);
    expect(releaseActions.length).toBeGreaterThan(0);
    expect(releaseActions.every((candidate) => candidate.enabled === true && candidate.requiresFullInterval)).toBe(true);

    const full = await board({ arrivalDate: fullStart, departureDate: fullEnd });
    expect(unitIn(full, demo.bedAId).intervals.find((candidate) => candidate.references.some((item) => item.id === blockId))?.allowedActions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "RELEASE_MAINTENANCE", enabled: true, requiresFullInterval: true })]));
    expect(await db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow())
      .toEqual(receiptCountBefore);
    expect(await db.selectFrom("maintenance_locks").select("status").where("id", "=", blockId).executeTakeFirstOrThrow())
      .toEqual({ status: "ACTIVE" });
    expect(await db.selectFrom("inventory_claims").select("id").where("source_type", "=", "MAINTENANCE").where("source_id", "=", blockId).where("active", "=", true).execute())
      .toHaveLength(5);
  });

  it("projects confirmed reserved date changes from the current Claim timeline with amendment Receipts", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftLocalDate(businessDate, 3);
    const originalDepartureDate = shiftLocalDate(businessDate, 7);
    const shortenedDepartureDate = shiftLocalDate(businessDate, 5);
    const extendedDepartureDate = shiftLocalDate(businessDate, 8);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate: originalDepartureDate,
      prefix: "authoritative-stay-timeline"
    });
    const orderId = created.result!.orderId as string;

    const shortened = await execute({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: shortenedDepartureDate
      }
    }, "authoritative-stay-shorten");
    const afterShorten = await board({ arrivalDate, departureDate: extendedDepartureDate });
    const shortenedIntervals = unitIn(afterShorten, demo.secondRoomId).intervals
      .filter((interval) => interval.references.some((item) => item.type === "ORDER" && item.id === orderId));
    expect(shortenedIntervals).toHaveLength(1);
    expect(shortenedIntervals[0]).toMatchObject({
      startDate: arrivalDate,
      endDate: shortenedDepartureDate,
      sourceStartDate: arrivalDate,
      sourceEndDate: shortenedDepartureDate,
      actualInventoryUnitId: demo.secondRoomId,
      sourceKind: "ORDER",
      blocking: true
    });
    expect(shortenedIntervals[0]!.claimIds).toHaveLength(2);
    expect(shortenedIntervals[0]!.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "RESCHEDULE_STAY", commandId: expect.any(String) }),
      expect.objectContaining({ action: "RESCHEDULE_STAY", receiptId: shortened.receiptId })
    ]));
    expect(shortenedIntervals[0]!.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RECEIPT", id: shortened.receiptId })
    ]));

    const extended = await execute({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: extendedDepartureDate
      }
    }, "authoritative-stay-extend");
    const afterExtend = await board({ arrivalDate, departureDate: extendedDepartureDate });
    const extendedIntervals = unitIn(afterExtend, demo.secondRoomId).intervals
      .filter((interval) => interval.references.some((item) => item.type === "ORDER" && item.id === orderId));
    expect(extendedIntervals).toHaveLength(1);
    expect(extendedIntervals[0]).toMatchObject({
      startDate: arrivalDate,
      endDate: extendedDepartureDate,
      sourceStartDate: arrivalDate,
      sourceEndDate: extendedDepartureDate,
      actualInventoryUnitId: demo.secondRoomId,
      sourceKind: "ORDER",
      blocking: true
    });
    expect(extendedIntervals[0]!.claimIds).toHaveLength(5);
    expect(extendedIntervals[0]!.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "RESCHEDULE_STAY", receiptId: shortened.receiptId }),
      expect.objectContaining({ action: "RESCHEDULE_STAY", commandId: expect.any(String) }),
      expect.objectContaining({ action: "RESCHEDULE_STAY", receiptId: extended.receiptId })
    ]));
    expect(extendedIntervals[0]!.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RECEIPT", id: shortened.receiptId }),
      expect.objectContaining({ type: "RECEIPT", id: extended.receiptId })
    ]));
    expect(await db.selectFrom("stay_segments")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select("stay_segments.id")
      .where("stays.order_id", "=", orderId)
      .execute()).toHaveLength(3);
    const activeClaims = await db.selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select(["claim.id", "claim.service_date"])
      .where("claim.source_type", "=", "ORDER_SEGMENT")
      .where("claim.active", "=", true)
      .where("stay.order_id", "=", orderId)
      .where("claim.service_date", ">=", arrivalDate)
      .where("claim.service_date", "<", extendedDepartureDate)
      .orderBy("claim.service_date")
      .execute();
    expect(extendedIntervals[0]!.claimIds).toEqual(activeClaims.map((claim) => claim.id));
    for (const [index, day] of unitIn(afterExtend, demo.secondRoomId).days.entries()) {
      expect(day.conflicts).toHaveLength(1);
      expect(day.conflicts[0]).toMatchObject({
        claimId: activeClaims[index]!.id,
        claimIds: [activeClaims[index]!.id],
        startDate: activeClaims[index]!.service_date,
        endDate: shiftLocalDate(activeClaims[index]!.service_date, 1)
      });
    }
  });

  it("checks out atomically without creating or projecting cleaning tasks", async () => {
    const { arrivalDate, departureDate: businessDate } = await distinctBusinessDatesAcrossTimezones();
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate: businessDate,
      prefix: "cleaning"
    });
    const orderId = created.result!.orderId as string;
    const checkIn = await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "cleaning-check-in");
    expect(checkIn.result).toMatchObject({ orderId });
    const checkInAmendment = await db.selectFrom("amendments").select("payload")
      .where("order_id", "=", orderId).where("amendment_type", "=", "CHECK_IN").executeTakeFirstOrThrow();
    expect(checkInAmendment.payload).toMatchObject({ businessDate: arrivalDate });
    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    expect((await getOrderView(db, orderId)).allowedActions.find((action) => action.code === "CHECK_OUT"))
      .toEqual({ code: "CHECK_OUT", enabled: true, disabledReason: null });
    const checkoutPrepared = await prepare({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }, "cleaning-check-out");
    expect(checkoutPrepared.preview.effect).not.toHaveProperty("cleaningTask");
    const checkout = await confirmPrepared(checkoutPrepared, "cleaning-check-out");
    expect(checkout.receipt.result).not.toHaveProperty("cleaningTaskId");
    expect(checkout.receipt.resourceRefs.some((reference) => reference.startsWith("cleaning_"))).toBe(false);
    expect(await db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()).toHaveLength(0);
    expect((await getOrderView(db, orderId)).cleaningTasks).toEqual([]);
    const checkoutAmendment = await db.selectFrom("amendments").select("payload")
      .where("order_id", "=", orderId).where("amendment_type", "=", "CHECK_OUT").executeTakeFirstOrThrow();
    expect(checkoutAmendment.payload).toMatchObject({ businessDate });

    const afterCheckout = await board({ arrivalDate, departureDate: shiftLocalDate(businessDate, 1) });
    expect(afterCheckout.revision).toBe("3");
    expect(afterCheckout.availabilitySummary.find((item) => item.serviceDate === arrivalDate))
      .toMatchObject({ paidOccupiedUnits: 4, occupantCount: 1 });
    const room = unitIn(afterCheckout, demo.secondRoomId);
    const historical = room.intervals.find((interval) => interval.references.some((item) => item.type === "ORDER" && item.id === orderId));
    expect(historical).toMatchObject({
      sourceKind: "ORDER",
      status: "ARREARS",
      attention: "ARREARS",
      label: `已结单 ${orderId}`,
      startDate: arrivalDate,
      endDate: businessDate,
      available: true,
      blocking: false,
      conflicts: []
    });
    const departureDay = room.days.find((day) => day.serviceDate === businessDate)!;
    expect(departureDay).toMatchObject({ status: "AVAILABLE", available: true, conflicts: [] });
    const stayNight = room.days.find((day) => day.serviceDate === arrivalDate)!;
    expect(stayNight).toMatchObject({ status: "ARREARS", available: false, intervalIds: [historical!.id], conflicts: [] });
    expect(room.intervals.some((interval) => interval.sourceKind === "CLEANING")).toBe(false);
    expect(afterCheckout.operationalTasks.flatMap((task) => task.allowedActions)
      .some((action) => action.code === "COMPLETE_CLEANING")).toBe(false);
    expect(room.allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CREATE_ORDER", enabled: true })
    ]));

    const replay = await confirmCommandPreview(
      db,
      writePrincipal,
      checkoutPrepared.preview.previewId,
      checkout.confirmation,
      checkout.confirmMetadata
    );
    expect(replay).toEqual(checkout.receipt);
    expect(await db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()).toHaveLength(0);
    expect((await board({ arrivalDate, departureDate: shiftLocalDate(businessDate, 1) })).revision).toBe("3");

    const stateAfterCheckout = await Promise.all([
      db.selectFrom("orders").select(["status", "version"]).where("id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("inventory_claims").select(["id", "active", "released_at"])
        .where("source_id", "=", created.result!.segmentId as string).orderBy("id").execute(),
      db.selectFrom("amendments").select(["id", "sequence", "amendment_type"]).where("order_id", "=", orderId).orderBy("sequence").execute(),
      db.selectFrom("command_receipts").select("id").orderBy("id").execute(),
      db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()
    ]);
    await expect(prepare({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId }
    }, "cleaning-check-out-duplicate-new-key")).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
    expect(await Promise.all([
      db.selectFrom("orders").select(["status", "version"]).where("id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("inventory_claims").select(["id", "active", "released_at"])
        .where("source_id", "=", created.result!.segmentId as string).orderBy("id").execute(),
      db.selectFrom("amendments").select(["id", "sequence", "amendment_type"]).where("order_id", "=", orderId).orderBy("sequence").execute(),
      db.selectFrom("command_receipts").select("id").orderBy("id").execute(),
      db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()
    ])).toEqual(stateAfterCheckout);

    const cancelled = await createOrder({
      unitId: demo.roomId,
      arrivalDate: "2028-08-20",
      departureDate: "2028-08-22",
      prefix: "cancelled"
    });
    const cancelledOrderId = cancelled.result!.orderId as string;
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: cancelledOrderId } }, "cancelled-order");
    const cancelledBoard = await board({ arrivalDate: "2028-08-20", departureDate: "2028-08-22" });
    expect(unitIn(cancelledBoard, demo.roomId).intervals.some((interval) => interval.references.some((item) => item.id === cancelledOrderId))).toBe(false);
  });

  it("does not project a completed bed stay as a current in-house occupancy", async () => {
    const { arrivalDate, departureDate: businessDate } = await distinctBusinessDatesAcrossTimezones();
    const created = await createOrder({
      unitId: demo.bedCId,
      arrivalDate,
      departureDate: businessDate,
      prefix: "historical-bed-stay"
    });
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "historical-bed-stay-check-in");
    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    await execute({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }, "historical-bed-stay-check-out");

    const afterCheckout = await board({ arrivalDate, departureDate: shiftLocalDate(businessDate, 1) });
    expect(afterCheckout.availabilitySummary.find((item) => item.serviceDate === arrivalDate))
      .toMatchObject({ paidOccupiedUnits: 1, occupantCount: 1 });
    const parentRoom = unitIn(afterCheckout, demo.roomId);
    const bed = unitIn(afterCheckout, demo.bedCId);
    const historical = bed.intervals.find((interval) => interval.references.some((item) => item.type === "ORDER" && item.id === orderId));
    expect(historical).toMatchObject({
      status: "ARREARS",
      attention: "ARREARS",
      label: `已结单 ${orderId}`,
      startDate: arrivalDate,
      endDate: businessDate,
      available: true,
      blocking: false,
      conflicts: []
    });
    expect(bed.days.find((day) => day.serviceDate === arrivalDate)).toMatchObject({ status: "ARREARS", available: false, intervalIds: [historical!.id] });
    expect(parentRoom.days.find((day) => day.serviceDate === arrivalDate)).toMatchObject({ status: "ARREARS", available: false });
    expect(parentRoom.bedOccupancies.find((item) => item.serviceDate === arrivalDate)).toMatchObject({
      occupiedBedCount: 1,
      occupants: [expect.objectContaining({ inventoryUnitId: demo.bedCId })]
    });
    expect(bed.days.find((day) => day.serviceDate === businessDate)).toMatchObject({ status: "AVAILABLE", available: true });
  });

  it("checks out a free stay without creating a cleaning task", async () => {
    const { arrivalDate, departureDate: businessDate } = await distinctBusinessDatesAcrossTimezones();
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate: businessDate,
      prefix: "free-checkout-no-cleaning",
      stayType: "FREE"
    });
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "free-checkout-no-cleaning-check-in");
    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    const checkedOut = await execute({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }, "free-checkout-no-cleaning-check-out");
    expect(checkedOut.result).not.toHaveProperty("cleaningTaskId");
    const checkedOutView = await getOrderView(db, orderId);
    expect(checkedOutView.order.status).toBe("CHECKED_OUT");
    expect(checkedOutView.fulfillment).toMatchObject({
      checkIn: { plannedBusinessDate: arrivalDate, recordedBusinessDate: arrivalDate, recordingMode: "ON_SCHEDULE" },
      checkOut: { plannedBusinessDate: businessDate, recordedBusinessDate: businessDate, recordingMode: "ON_SCHEDULE" }
    });
    expect(await db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()).toHaveLength(0);
    expect((await board({ arrivalDate, departureDate: shiftLocalDate(businessDate, 1) }))
      .availabilitySummary.find((item) => item.serviceDate === arrivalDate))
      .toMatchObject({ paidOccupiedUnits: 0, occupantCount: 0 });
  });

  it("enforces future-arrival and early-checkout gates while late-recording overdue fulfillment", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const futureArrivalDate = shiftLocalDate(businessDate, 1);
    const futureDepartureDate = shiftLocalDate(businessDate, 2);
    const future = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: futureArrivalDate,
      departureDate: futureDepartureDate,
      prefix: "future-fulfillment-blocked"
    });
    const futureOrderId = future.result!.orderId as string;

    expect((await getOrderView(db, futureOrderId)).allowedActions.find((action) => action.code === "CHECK_IN"))
      .toEqual({ code: "CHECK_IN", enabled: false, disabledReason: "ARRIVAL_DATE_NOT_REACHED" });
    const futureBefore = await orderFulfillmentState(futureOrderId);
    await expect(prepare({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: futureOrderId }
    }, "future-check-in-rejected")).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "未到计划入住日，不能办理普通入住",
      details: { businessDate, arrivalDate: futureArrivalDate }
    });
    expect(await orderFulfillmentState(futureOrderId)).toEqual(futureBefore);

    const overdueCheckout = await createOrder({
      unitId: demo.roomId,
      arrivalDate: shiftLocalDate(businessDate, -2),
      departureDate: shiftLocalDate(businessDate, -1),
      prefix: "overdue-checkout-blocked"
    });
    const overdueArrivalDate = shiftLocalDate(businessDate, -1);
    const overdueArrival = await createOrder({
      unitId: demo.roomId,
      arrivalDate: overdueArrivalDate,
      departureDate: shiftLocalDate(businessDate, 1),
      prefix: "overdue-arrival-blocked"
    });
    const overdueArrivalOrderId = overdueArrival.result!.orderId as string;
    expect((await getOrderView(db, overdueArrivalOrderId)).allowedActions.find((action) => action.code === "CHECK_IN"))
      .toEqual({ code: "CHECK_IN", enabled: true, disabledReason: null });
    const overdueArrivalPrepared = await prepare({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: overdueArrivalOrderId }
    }, "overdue-check-in-late-recorded");
    expect(overdueArrivalPrepared.preview.effect).toMatchObject({
      businessDate,
      effectiveDate: overdueArrivalDate,
      recordingMode: "LATE_RECORDED"
    });
    const overdueArrivalConfirmed = await confirmPrepared(overdueArrivalPrepared, "overdue-check-in-late-recorded");
    expect(overdueArrivalConfirmed.receipt.result).toMatchObject({
      fulfillmentTiming: {
        effectiveDate: overdueArrivalDate,
        recordedBusinessDate: businessDate,
        recordingMode: "LATE_RECORDED"
      }
    });

    const earlyDepartureDate = shiftLocalDate(businessDate, 1);
    const earlyCheckout = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate: earlyDepartureDate,
      prefix: "early-checkout-blocked"
    });
    const earlyCheckoutOrderId = earlyCheckout.result!.orderId as string;
    const checkInPrepared = await prepare({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: earlyCheckoutOrderId }
    }, "planned-date-check-in");
    expect(checkInPrepared.preview.effect).toMatchObject({ businessDate });
    await confirmPrepared(checkInPrepared, "planned-date-check-in");
    expect((await db.selectFrom("amendments").select("payload")
      .where("order_id", "=", earlyCheckoutOrderId).where("amendment_type", "=", "CHECK_IN")
      .executeTakeFirstOrThrow()).payload).toMatchObject({ businessDate });
    expect((await getOrderView(db, earlyCheckoutOrderId)).allowedActions.find((action) => action.code === "CHECK_OUT"))
      .toEqual({ code: "CHECK_OUT", enabled: false, disabledReason: "DEPARTURE_DATE_NOT_REACHED" });
    const earlyCheckoutBefore = await orderFulfillmentState(earlyCheckoutOrderId);
    const earlyProtocolBefore = await Promise.all([
      db.selectFrom("command_previews").select("id").orderBy("id").execute(),
      db.selectFrom("command_executions").select("id").orderBy("id").execute(),
      db.selectFrom("command_receipts").select("id").orderBy("id").execute(),
      db.selectFrom("audit_entries").select("id").orderBy("id").execute(),
      db.selectFrom("room_status_revisions").select(["property_id", "revision"]).orderBy("property_id").execute()
    ]);
    await expect(prepare({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: earlyCheckoutOrderId, newDepartureDate: businessDate }
    }, "early-check-out-shorten-bypass-rejected")).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "入住当天暂不办理缩短或提前退房；未实际使用房间时请使用后续的撤销入住流程"
    });
    expect(await orderFulfillmentState(earlyCheckoutOrderId)).toEqual(earlyCheckoutBefore);
    expect(await Promise.all([
      db.selectFrom("command_previews").select("id").orderBy("id").execute(),
      db.selectFrom("command_executions").select("id").orderBy("id").execute(),
      db.selectFrom("command_receipts").select("id").orderBy("id").execute(),
      db.selectFrom("audit_entries").select("id").orderBy("id").execute(),
      db.selectFrom("room_status_revisions").select(["property_id", "revision"]).orderBy("property_id").execute()
    ])).toEqual(earlyProtocolBefore);
    await expect(prepare({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId: earlyCheckoutOrderId }
    }, "early-check-out-rejected")).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "未到计划退房日，不能办理普通退房；当前版本暂不支持提前退房",
      details: { businessDate, departureDate: earlyDepartureDate }
    });
    expect(await orderFulfillmentState(earlyCheckoutOrderId)).toEqual(earlyCheckoutBefore);
    expect(await Promise.all([
      db.selectFrom("command_previews").select("id").orderBy("id").execute(),
      db.selectFrom("command_executions").select("id").orderBy("id").execute(),
      db.selectFrom("command_receipts").select("id").orderBy("id").execute(),
      db.selectFrom("audit_entries").select("id").orderBy("id").execute(),
      db.selectFrom("room_status_revisions").select(["property_id", "revision"]).orderBy("property_id").execute()
    ])).toEqual(earlyProtocolBefore);

    const overdueCheckoutOrderId = overdueCheckout.result!.orderId as string;
    await markOrderInHouseFixture(overdueCheckoutOrderId);
    expect((await getOrderView(db, overdueCheckoutOrderId)).allowedActions.find((action) => action.code === "CHECK_OUT"))
      .toEqual({ code: "CHECK_OUT", enabled: true, disabledReason: null });
    const overdueCheckoutBefore = await orderFulfillmentState(overdueCheckoutOrderId);
    const overdueAmountsBefore = (await getOrderView(db, overdueCheckoutOrderId)).amounts;
    const overduePrepared = await prepare({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId: overdueCheckoutOrderId }
    }, "overdue-check-out-late-recorded");
    expect(overduePrepared.preview.effect).toMatchObject({
      businessDate,
      effectiveDate: shiftLocalDate(businessDate, -1),
      recordingMode: "LATE_RECORDED"
    });
    const confirmed = await confirmPrepared(overduePrepared, "overdue-check-out-late-recorded");
    expect(confirmed.receipt.result).toMatchObject({
      fulfillmentTiming: {
        effectiveDate: shiftLocalDate(businessDate, -1),
        recordedBusinessDate: businessDate,
        recordingMode: "LATE_RECORDED"
      }
    });
    const replay = await confirmPrepared(
      overduePrepared,
      "overdue-check-out-late-recorded",
      confirmed.confirmMetadata
    );
    expect(replay.receipt.receiptId).toBe(confirmed.receipt.receiptId);

    const overdueCheckoutAfter = await orderFulfillmentState(overdueCheckoutOrderId);
    expect(overdueCheckoutAfter[0]).toMatchObject({
      status: "CHECKED_OUT",
      version: overdueCheckoutBefore[0].version + 1,
      current_revision_id: overdueCheckoutBefore[0].current_revision_id
    });
    expect(overdueCheckoutAfter[1]).toEqual({ status: "COMPLETED" });
    expect(overdueCheckoutAfter[2]).toHaveLength(overdueCheckoutBefore[2].length + 1);
    expect(overdueCheckoutAfter[2].at(-1)).toMatchObject({
      amendment_type: "CHECK_OUT",
      payload: { businessDate }
    });
    expect(overdueCheckoutAfter[3]).toEqual(overdueCheckoutBefore[3]);
    expect(overdueCheckoutAfter[4]).toHaveLength(overdueCheckoutBefore[4].length);
    expect(overdueCheckoutAfter[4].every((claim) => claim.active === false && claim.released_at !== null)).toBe(true);
    expect(overdueCheckoutAfter[5]).toEqual(overdueCheckoutBefore[5]);
    expect(overdueCheckoutAfter[6]).toEqual(overdueCheckoutBefore[6]);
    expect(overdueCheckoutAfter[7]).toEqual(overdueCheckoutBefore[7]);
    expect(overdueCheckoutAfter[8]).toEqual([]);

    const overdueView = await getOrderView(db, overdueCheckoutOrderId);
    expect(overdueView.order).toMatchObject({
      arrival_date: shiftLocalDate(businessDate, -2),
      departure_date: shiftLocalDate(businessDate, -1)
    });
    expect(overdueView.amounts).toEqual(overdueAmountsBefore);
    expect(overdueView.fulfillment.checkOut).toMatchObject({
      type: "CHECK_OUT",
      plannedBusinessDate: shiftLocalDate(businessDate, -1),
      recordedBusinessDate: businessDate,
      recordingMode: "LATE_RECORDED",
      actor: { subjectId: demo.agentSubjectId, displayName: "Demo Agent" }
    });
  });

  it("keeps the in-house operational task after rescheduling before check-in on the business date", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = businessDate;
    const departureDate = shiftLocalDate(businessDate, 2);
    const shortenedDepartureDate = shiftLocalDate(businessDate, 1);
    const shortenedQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate: shortenedDepartureDate,
      pricingPolicyVersionId: testPricingPolicyForDates(arrivalDate, departureDate)
    });
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "shorten-before-check-in"
    });
    const orderId = created.result!.orderId as string;
    await execute({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: arrivalDate,
        newDepartureDate: shortenedDepartureDate,
        targetCurrentContractAmountMinor: shortenedQuote.currentContractAmount.minorUnits
      }
    }, "shorten-before-check-in-shorten");
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "shorten-before-check-in-check-in");

    const result = await board({ arrivalDate, departureDate });
    const tasks = result.operationalTasks.filter((task) => task.references
      .some((item) => item.type === "ORDER" && item.id === orderId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskKind: "IN_HOUSE",
      businessDate,
      status: "IN_HOUSE",
      actualInventoryUnitId: demo.secondRoomId,
      blocking: true,
      reason: null
    });
    const room = unitIn(result, demo.secondRoomId);
    expect(room.days.find((day) => day.serviceDate === businessDate))
      .toMatchObject({ status: "IN_HOUSE", available: false });
    expect(room.days.find((day) => day.serviceDate === shortenedDepartureDate))
      .toMatchObject({ status: "AVAILABLE", available: true });
  });

  it("keeps prior-day and current-day cleaning rows unchanged while hiding and disabling the workflow", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const priorDate = shiftLocalDate(businessDate, -1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: shiftLocalDate(businessDate, -3),
      departureDate: priorDate,
      prefix: "overnight-cleaning"
    });
    const orderId = created.result!.orderId as string;
    const cancelled = await execute({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId }
    }, "overnight-cleaning-cancel");
    const stayId = created.result!.stayId as string;
    const cleaningTaskId = "cleaning_pending_across_business_date";
    await db.insertInto("cleaning_tasks").values({
      id: cleaningTaskId,
      property_id: demo.propertyId,
      order_id: orderId,
      stay_id: stayId,
      inventory_unit_id: demo.secondRoomId,
      room_id: demo.secondRoomId,
      service_date: priorDate,
      status: "PENDING",
      version: 1,
      created_by_command_id: cancelled.commandId,
      completed_by_command_id: null,
      completed_at: null
    }).execute();
    const currentCreated = await createOrder({
      unitId: demo.roomId,
      arrivalDate: priorDate,
      departureDate: businessDate,
      prefix: "current-day-cleaning"
    });
    const currentOrderId = currentCreated.result!.orderId as string;
    const currentCancelled = await execute({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: currentOrderId }
    }, "current-day-cleaning-cancel");
    const currentCleaningTaskId = "cleaning_pending_current_business_date";
    await db.insertInto("cleaning_tasks").values({
      id: currentCleaningTaskId,
      property_id: demo.propertyId,
      order_id: currentOrderId,
      stay_id: currentCreated.result!.stayId as string,
      inventory_unit_id: demo.roomId,
      room_id: demo.roomId,
      service_date: businessDate,
      status: "PENDING",
      version: 1,
      created_by_command_id: currentCancelled.commandId,
      completed_by_command_id: null,
      completed_at: null
    }).execute();

    const historicalRow = await db.selectFrom("cleaning_tasks").selectAll().where("id", "=", cleaningTaskId).executeTakeFirstOrThrow();
    const currentDayRow = await db.selectFrom("cleaning_tasks").selectAll().where("id", "=", currentCleaningTaskId).executeTakeFirstOrThrow();
    const receiptsBefore = await db.selectFrom("command_receipts").select("id").execute();
    const current = await board({ arrivalDate: businessDate, departureDate: shiftLocalDate(businessDate, 1) });
    expect(current.projectionState).toBe("READY");
    expect(current.operationalTasks.some((candidate) => candidate.references
      .some((reference) => reference.type === "OPERATIONS" && [cleaningTaskId, currentCleaningTaskId].includes(reference.id)))).toBe(false);
    expect(unitIn(current, demo.secondRoomId).intervals.some((interval) => interval.sourceKind === "CLEANING")).toBe(false);
    expect((await getOrderView(db, orderId)).cleaningTasks).toEqual([]);
    expect((await getOrderView(db, currentOrderId)).cleaningTasks).toEqual([]);

    await expect(prepare({
      commandType: "COMPLETE_CLEANING",
      input: { propertyId: demo.propertyId, cleaningTaskId }
    }, "overnight-cleaning-disabled")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Cleaning workflow is disabled in this release"
    });
    expect(await db.selectFrom("cleaning_tasks").selectAll().where("id", "=", cleaningTaskId).executeTakeFirstOrThrow())
      .toEqual(historicalRow);
    expect(await db.selectFrom("cleaning_tasks").selectAll().where("id", "=", currentCleaningTaskId).executeTakeFirstOrThrow())
      .toEqual(currentDayRow);
    expect(await db.selectFrom("command_receipts").select("id").execute()).toEqual(receiptsBefore);

    const historicalPreviewId = "preview_historical_cleaning_open";
    const historicalEffectHash = "a".repeat(64);
    await db.insertInto("command_previews").values({
      id: historicalPreviewId,
      subject_id: writePrincipal.subjectId,
      property_id: demo.propertyId,
      command_type: "COMPLETE_CLEANING",
      normalized_input: { propertyId: demo.propertyId, cleaningTaskId },
      input_hash: "b".repeat(64),
      effect: {
        cleaningTaskId,
        orderId,
        stayId: created.result!.stayId as string,
        inventoryUnitId: demo.secondRoomId,
        roomId: demo.secondRoomId,
        serviceDate: priorDate,
        fromStatus: "PENDING",
        toStatus: "COMPLETED"
      },
      effect_hash: historicalEffectHash,
      basis_versions: { cleaningTaskVersion: 1, status: "PENDING" },
      expires_at: new Date(Date.now() + 60_000),
      status: "OPEN",
      used_at: null
    }).execute();
    const artifactsBeforeConfirm = await Promise.all([
      db.selectFrom("command_executions").select("id").execute(),
      db.selectFrom("command_receipts").select("id").execute(),
      db.selectFrom("audit_entries").select("id").execute()
    ]);
    await expect(confirmCommandPreview(db, writePrincipal, historicalPreviewId, {
      propertyId: demo.propertyId,
      commandType: "COMPLETE_CLEANING",
      confirmation: true,
      expectedEffectHash: historicalEffectHash,
      reason: { code: "HISTORICAL_CLEANING_DISABLED", note: "确认停用版本不执行旧清洁预览" }
    }, metadata("historical-cleaning-confirm"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Cleaning workflow is disabled in this release"
    });
    expect(await Promise.all([
      db.selectFrom("command_executions").select("id").execute(),
      db.selectFrom("command_receipts").select("id").execute(),
      db.selectFrom("audit_entries").select("id").execute()
    ])).toEqual(artifactsBeforeConfirm);
    expect(await db.selectFrom("command_previews").select(["status", "used_at"])
      .where("id", "=", historicalPreviewId).executeTakeFirstOrThrow())
      .toEqual({ status: "OPEN", used_at: null });
    expect(await db.selectFrom("cleaning_tasks").selectAll().where("id", "=", cleaningTaskId).executeTakeFirstOrThrow())
      .toEqual(historicalRow);

    const missingTaskPreviewId = "preview_historical_cleaning_missing_task";
    const missingTaskEffectHash = "c".repeat(64);
    await db.insertInto("command_previews").values({
      id: missingTaskPreviewId,
      subject_id: writePrincipal.subjectId,
      property_id: demo.propertyId,
      command_type: "COMPLETE_CLEANING",
      normalized_input: { propertyId: demo.propertyId, cleaningTaskId: "cleaning_missing" },
      input_hash: "d".repeat(64),
      effect: {
        cleaningTaskId: "cleaning_missing",
        orderId,
        stayId: created.result!.stayId as string,
        inventoryUnitId: demo.secondRoomId,
        roomId: demo.secondRoomId,
        serviceDate: priorDate,
        fromStatus: "PENDING",
        toStatus: "COMPLETED"
      },
      effect_hash: missingTaskEffectHash,
      basis_versions: { cleaningTaskVersion: 1, status: "PENDING" },
      expires_at: new Date(Date.now() + 60_000),
      status: "OPEN",
      used_at: null
    }).execute();
    const artifactsBeforeMissingTaskConfirm = await Promise.all([
      db.selectFrom("command_executions").select("id").execute(),
      db.selectFrom("command_receipts").select("id").execute(),
      db.selectFrom("audit_entries").select("id").execute()
    ]);
    await expect(confirmCommandPreview(db, writePrincipal, missingTaskPreviewId, {
      propertyId: demo.propertyId,
      commandType: "COMPLETE_CLEANING",
      confirmation: true,
      expectedEffectHash: missingTaskEffectHash,
      reason: { code: "HISTORICAL_CLEANING_DISABLED", note: "不存在任务的旧预检也统一按停用处理" }
    }, metadata("historical-cleaning-missing-task-confirm"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Cleaning workflow is disabled in this release"
    });
    expect(await Promise.all([
      db.selectFrom("command_executions").select("id").execute(),
      db.selectFrom("command_receipts").select("id").execute(),
      db.selectFrom("audit_entries").select("id").execute()
    ])).toEqual(artifactsBeforeMissingTaskConfirm);
    expect(await db.selectFrom("command_previews").select(["status", "used_at"])
      .where("id", "=", missingTaskPreviewId).executeTakeFirstOrThrow())
      .toEqual({ status: "OPEN", used_at: null });
  });

  it("separates FREE_STAY from Order, limits READ actions, and fails closed for inactive or unresolved units", async () => {
    const free = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2028-09-01",
      departureDate: "2028-09-03",
      prefix: "free",
      stayType: "FREE"
    });
    const freeOrderId = free.result!.orderId as string;
    const readBoard = await board({ arrivalDate: "2028-09-01", departureDate: "2028-09-03", accessLevel: "READ" });
    const freeInterval = unitIn(readBoard, demo.secondRoomId).intervals.find((interval) => interval.sourceKind === "FREE_STAY")!;
    expect(freeInterval.primaryOccupantLabel).toBe("RS free");
    expect(freeInterval.references).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ORDER", id: freeOrderId })]));
    const actionCodes = readBoard.rooms.flatMap((room) => [room, ...room.children])
      .flatMap((unit) => [unit.allowedActions, ...unit.intervals.map((interval) => interval.allowedActions)])
      .flat()
      .map((item) => item.code);
    expect(actionCodes).toEqual(expect.arrayContaining(["OPEN_ORDER"]));
    expect(actionCodes.some((code) => code !== "OPEN_ORDER")).toBe(false);

    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", demo.roomId).execute();
    const inactive = await board({ arrivalDate: "2028-09-05", departureDate: "2028-09-06" });
    expect(inactive.rooms.flatMap((room) => [room, ...room.children])
      .filter((unit) => unit.id === demo.roomId || unit.id === demo.bedAId)).toEqual([]);
    expect(inactive.operationalTasks.find((task) => task.sourceKind === "UNIT_UNSELLABLE"
      && task.actualInventoryUnitId === demo.roomId)).toMatchObject({
      allowedActions: [],
      conflicts: [expect.objectContaining({
        blockingFactKind: "UNIT_UNSELLABLE",
        claimId: null,
        claimIds: [],
        sourceReference: expect.objectContaining({ type: "INVENTORY_UNIT", id: demo.roomId })
      })]
    });

    await sql`alter table inventory_claims disable trigger inventory_claims_validate_source`.execute(db);
    try {
      await db.insertInto("inventory_claims").values({
        id: "claim_unresolved_room_status",
        property_id: demo.propertyId,
        room_id: demo.secondRoomId,
        inventory_unit_id: demo.secondRoomId,
        service_date: "2028-09-07",
        source_type: "ORDER_SEGMENT",
        source_id: "segment_missing_room_status",
        active: true,
        released_at: null
      }).execute();
    } finally {
      await sql`alter table inventory_claims enable trigger inventory_claims_validate_source`.execute(db);
    }
    const unknown = await board({ arrivalDate: "2028-09-07", departureDate: "2028-09-08" });
    expect(unknown.projectionState).toBe("PARTIAL");
    expect(unitIn(unknown, demo.secondRoomId).days[0]).toMatchObject({ status: "UNKNOWN", available: false });
    expect(unitIn(unknown, demo.secondRoomId).allowedActions).toEqual([]);
  });

  it("fails closed on an active order Claim outside the order interval at its actual unit and service date", async () => {
    const arrivalDate = "2032-05-01";
    const departureDate = "2032-05-02";
    const queryDepartureDate = "2032-05-03";
    const created = await createOrder({
      unitId: demo.bedAId,
      arrivalDate,
      departureDate,
      prefix: "order-claim-outside-order-interval"
    });
    const claimId = "claim_outside_current_order_interval";
    const orderId = created.result!.orderId as string;

    await sql`alter table inventory_claims disable trigger inventory_claims_validate_source`.execute(db);
    try {
      await db.insertInto("inventory_claims").values({
        id: claimId,
        property_id: demo.propertyId,
        room_id: demo.roomId,
        inventory_unit_id: demo.bedAId,
        service_date: departureDate,
        source_type: "ORDER_SEGMENT",
        source_id: created.result!.segmentId as string,
        active: true,
        released_at: null
      }).execute();
    } finally {
      await sql`alter table inventory_claims enable trigger inventory_claims_validate_source`.execute(db);
    }

    const result = await board({ arrivalDate, departureDate: queryDepartureDate });
    const actualUnit = unitIn(result, demo.bedAId);
    const legalInterval = intervalForOrder(result, demo.bedAId, orderId);
    const damagedInterval = actualUnit.intervals.find((interval) => interval.references
      .some((item) => item.type === "CLAIM" && item.id === claimId));

    expect(result.projectionState).toBe("PARTIAL");
    expect(actualUnit.days.find((day) => day.serviceDate === arrivalDate)).toMatchObject({
      status: "UNKNOWN",
      available: false
    });
    expect(legalInterval).toMatchObject({
      actualInventoryUnitId: demo.bedAId,
      startDate: arrivalDate,
      endDate: departureDate,
      sourceStartDate: arrivalDate,
      sourceEndDate: departureDate,
      status: "UNKNOWN",
      attention: null,
      operationalAttention: null,
      available: false,
      blocking: true,
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: [],
      allowedActions: []
    });
    expect(actualUnit.days.find((day) => day.serviceDate === departureDate)).toMatchObject({
      status: "UNKNOWN",
      available: false
    });
    expect(damagedInterval).toMatchObject({
      actualInventoryUnitId: demo.bedAId,
      startDate: departureDate,
      endDate: queryDepartureDate,
      sourceStartDate: departureDate,
      sourceEndDate: queryDepartureDate,
      status: "UNKNOWN",
      attention: null,
      operationalAttention: null,
      available: false,
      blocking: true,
      sourceKind: "ORDER",
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: [],
      claimIds: [claimId],
      allowedActions: []
    });
    expect(damagedInterval?.references).toEqual([
      { type: "CLAIM", id: claimId, label: `Claim ${claimId}`, href: null }
    ]);
    expect(damagedInterval?.conflicts).toEqual([
      expect.objectContaining({
        blockingFactKind: "CLAIM",
        claimId,
        claimIds: [claimId],
        actualInventoryUnitId: demo.bedAId,
        startDate: departureDate,
        endDate: queryDepartureDate,
        sourceReference: { type: "CLAIM", id: claimId, label: `Claim ${claimId}`, href: null },
        blocking: true
      })
    ]);
  });

  it("projects active WECOM reserved arrears as attention without changing status, actions, filters, or idempotent revision", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "active-arrears"
    });
    const orderId = created.result!.orderId as string;

    const initial = await board({ arrivalDate: businessDate, departureDate });
    const initialInterval = intervalForOrder(initial, demo.secondRoomId, orderId);
    expect(initialInterval).toMatchObject({
      sourceKind: "ORDER",
      status: "RESERVED",
      attention: "ARREARS",
      available: false,
      blocking: true,
      allowedActions: [expect.objectContaining({ code: "OPEN_ORDER", enabled: true })]
    });
    expect(initialInterval.allowedActions.map((action) => action.code)).toEqual(["OPEN_ORDER"]);
    expect(unitIn(initial, demo.secondRoomId).days[0]).toMatchObject({
      status: "RESERVED",
      available: false,
      intervalIds: [initialInterval.id]
    });
    expect(initial.filterOptions.statuses).toContain("RESERVED");
    expect(initial.filterOptions.statuses).not.toContain("ARREARS");
    expect(taskForOrder(initial, orderId)).toMatchObject({
      taskKind: "ARRIVAL",
      status: "RESERVED",
      attention: "ARREARS",
      allowedActions: [expect.objectContaining({ code: "OPEN_ORDER", enabled: true })]
    });

    await execute({
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId,
        targetCurrentContractAmountMinor: 10_000
      }
    }, "active-arrears-reprice");
    const afterReprice = await board({ arrivalDate: businessDate, departureDate });
    expect(intervalForOrder(afterReprice, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: "ARREARS"
    });

    const partialCollectionPrepared = await prepare({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 4_000,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-ARREARS-PARTIAL",
        note: "partial collection keeps active reserved arrears visible"
      }
    }, "active-arrears-partial");
    const partialCollection = await confirmPrepared(partialCollectionPrepared, "active-arrears-partial");
    const afterPartial = await board({ arrivalDate: businessDate, departureDate });
    expect(Number(afterPartial.revision)).toBe(Number(afterReprice.revision) + 1);
    expect(intervalForOrder(afterPartial, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: "ARREARS"
    });
    const replayPartial = await confirmCommandPreview(
      db,
      writePrincipal,
      partialCollectionPrepared.preview.previewId,
      partialCollection.confirmation,
      partialCollection.confirmMetadata
    );
    expect(replayPartial).toEqual(partialCollection.receipt);
    expect((await board({ arrivalDate: businessDate, departureDate })).revision).toBe(afterPartial.revision);

    await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 6_000,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-ARREARS-BALANCE",
        note: "balance collection clears active reserved arrears attention"
      }
    }, "active-arrears-balance");
    const afterFull = await board({ arrivalDate: businessDate, departureDate });
    expect(Number(afterFull.revision)).toBe(Number(afterPartial.revision) + 1);
    expect(intervalForOrder(afterFull, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: null
    });
    expect(taskForOrder(afterFull, orderId)).toMatchObject({
      status: "RESERVED",
      attention: null
    });

    const refund = await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 1_000,
        referencesFactId: partialCollection.receipt.factRefs[0]!,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-ARREARS-REFUND",
        note: "refund reopens active reserved arrears attention"
      }
    }, "active-arrears-refund");
    const afterRefund = await board({ arrivalDate: businessDate, departureDate });
    expect(Number(afterRefund.revision)).toBe(Number(afterFull.revision) + 1);
    expect(intervalForOrder(afterRefund, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: "ARREARS"
    });

    const reverseRefundPrepared = await prepare({
      commandType: "REVERSE_FACT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        reversesFactId: refund.factRefs[0]!,
        note: "reverse refund clears active reserved arrears attention again"
      }
    }, "active-arrears-reverse-refund");
    const reverseRefund = await confirmPrepared(reverseRefundPrepared, "active-arrears-reverse-refund");
    const afterReverseRefund = await board({ arrivalDate: businessDate, departureDate });
    expect(Number(afterReverseRefund.revision)).toBe(Number(afterRefund.revision) + 1);
    expect(intervalForOrder(afterReverseRefund, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: null
    });
    const replayReverseRefund = await confirmCommandPreview(
      db,
      writePrincipal,
      reverseRefundPrepared.preview.previewId,
      reverseRefund.confirmation,
      reverseRefund.confirmMetadata
    );
    expect(replayReverseRefund).toEqual(reverseRefund.receipt);
    expect((await board({ arrivalDate: businessDate, departureDate })).revision).toBe(afterReverseRefund.revision);

    await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 1_000,
        referencesFactId: partialCollection.receipt.factRefs[0]!,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-ARREARS-REFUND-AGAIN",
        note: "second refund after refund reversal is valid"
      }
    }, "active-arrears-refund-again");
    const afterSecondRefund = await board({ arrivalDate: businessDate, departureDate });
    expect(Number(afterSecondRefund.revision)).toBe(Number(afterReverseRefund.revision) + 1);
    expect(intervalForOrder(afterSecondRefund, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: "ARREARS"
    });
  });

  it("projects migration 009 legacy direct reservations with a null booking channel as arrears", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "legacy-null-channel-arrears"
    });
    const orderId = created.result!.orderId as string;

    await sql`alter table orders disable trigger orders_protect_identity`.execute(db);
    try {
      await db.updateTable("orders")
        .set({ booking_channel_code: null })
        .where("id", "=", orderId)
        .executeTakeFirstOrThrow();
    } finally {
      await sql`alter table orders enable trigger orders_protect_identity`.execute(db);
    }

    const result = await board({ arrivalDate: businessDate, departureDate });
    expect(result.projectionState).toBe("READY");
    expect(intervalForOrder(result, demo.secondRoomId, orderId)).toMatchObject({
      status: "RESERVED",
      attention: "ARREARS",
      available: false,
      blocking: true
    });
    expect(taskForOrder(result, orderId)).toMatchObject({
      status: "RESERVED",
      attention: "ARREARS"
    });
  });

  it("limits active arrears attention to eligible service dates and excludes external, free, and member orders", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const priorDate = shiftLocalDate(businessDate, -1);
    const futureDate = shiftLocalDate(businessDate, 1);
    const overdue = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: priorDate,
      departureDate: futureDate,
      prefix: "cross-business-date"
    });
    const overdueOrderId = overdue.result!.orderId as string;
    const crossed = await board({ arrivalDate: priorDate, departureDate: futureDate });
    const overdueIntervals = unitIn(crossed, demo.secondRoomId).intervals
      .filter((interval) => interval.references.some((reference) => reference.type === "ORDER" && reference.id === overdueOrderId))
      .sort((left, right) => left.startDate.localeCompare(right.startDate));
    expect(overdueIntervals).toEqual([
      expect.objectContaining({
        startDate: priorDate,
        endDate: businessDate,
        status: "RESERVED",
        attention: null,
        operationalAttention: "OVERDUE_RESERVED"
      }),
      expect.objectContaining({
        startDate: businessDate,
        endDate: futureDate,
        status: "RESERVED",
        attention: "ARREARS",
        operationalAttention: "OVERDUE_RESERVED"
      })
    ]);
    expect(taskForOrder(crossed, overdueOrderId)).toMatchObject({
      taskKind: "EXCEPTION",
      status: "RESERVED",
      attention: "ARREARS",
      operationalAttention: "OVERDUE_RESERVED",
      sourceCategory: "DIRECT",
      freeStayCategoryCode: null,
      freeStayReason: null
    });

    const external = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2032-06-01",
      departureDate: "2032-06-02",
      prefix: "external-attention",
      bookingChannelCode: "YOUMUDAO",
      channelOrderReference: "EXT-ROOM-STATUS-ARREARS"
    });
    const ctrip = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2032-06-04",
      departureDate: "2032-06-05",
      prefix: "ctrip-source-badge",
      bookingChannelCode: "CTRIP",
      channelOrderReference: "CTRIP-ROOM-STATUS-SOURCE"
    });
    const meituan = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2032-06-05",
      departureDate: "2032-06-06",
      prefix: "meituan-source-badge",
      bookingChannelCode: "MEITUAN",
      channelOrderReference: "MEITUAN-ROOM-STATUS-SOURCE"
    });
    const free = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2032-06-02",
      departureDate: "2032-06-03",
      prefix: "free-attention",
      stayType: "FREE"
    });
    const member = await createOrder({
      unitId: demo.roomId,
      arrivalDate: "2032-06-03",
      departureDate: "2032-06-04",
      prefix: "member-attention",
      memberContractId: demo.memberContractId
    });
    const exclusions = await board({ arrivalDate: "2032-06-01", departureDate: "2032-06-06" });
    expect(intervalForOrder(exclusions, demo.secondRoomId, external.result!.orderId as string)).toMatchObject({
      attention: null,
      sourceCategory: "YOUMUDAO",
      freeStayCategoryCode: null,
      freeStayReason: null
    });
    expect(intervalForOrder(exclusions, demo.secondRoomId, ctrip.result!.orderId as string)).toMatchObject({
      attention: null,
      sourceCategory: "CTRIP"
    });
    expect(intervalForOrder(exclusions, demo.secondRoomId, meituan.result!.orderId as string)).toMatchObject({
      attention: null,
      sourceCategory: "MEITUAN"
    });
    expect(intervalForOrder(exclusions, demo.secondRoomId, free.result!.orderId as string)).toMatchObject({
      attention: null,
      sourceKind: "FREE_STAY",
      sourceCategory: "FREE_STAY",
      freeStayCategoryCode: "RECEPTION",
      freeStayReason: "Volunteer accommodation"
    });
    expect(intervalForOrder(exclusions, demo.roomId, member.result!.orderId as string)).toMatchObject({
      attention: null,
      sourceCategory: "MEMBER",
      freeStayCategoryCode: null,
      freeStayReason: null
    });
  });

  it("classifies legal active member links from either member field while tolerating conversion-style WECOM residue", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const memberIdOnly = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "member-id-wecom-source"
    });
    const contractIdOnly = await createOrder({
      unitId: demo.roomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "member-contract-wecom-source"
    });
    const memberIdOnlyOrderId = memberIdOnly.result!.orderId as string;
    const contractIdOnlyOrderId = contractIdOnly.result!.orderId as string;
    await updateOrderIdentityForProjectionTest(memberIdOnlyOrderId, { member_id: demo.memberId });
    await updateOrderIdentityForProjectionTest(contractIdOnlyOrderId, { member_contract_id: demo.memberContractId });

    const result = await board({ arrivalDate: businessDate, departureDate });
    expect(result.projectionState).toBe("READY");
    for (const [unitId, orderId] of [
      [demo.secondRoomId, memberIdOnlyOrderId],
      [demo.roomId, contractIdOnlyOrderId]
    ] as const) {
      expect(intervalForOrder(result, unitId, orderId)).toMatchObject({
        status: "RESERVED",
        sourceCategory: "MEMBER",
        freeStayCategoryCode: null,
        freeStayReason: null,
        primaryOccupantLabel: expect.any(String)
      });
      expect(taskForOrder(result, orderId)).toMatchObject({
        status: "RESERVED",
        sourceCategory: "MEMBER",
        freeStayCategoryCode: null,
        freeStayReason: null
      });
    }
  });

  it("fails closed when active lodging source relationships are contradictory", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const freeWithChannel = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "free-channel-conflict",
      stayType: "FREE"
    });
    const memberWithExternalChannel = await createOrder({
      unitId: demo.roomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "member-external-conflict"
    });
    const freeOrderId = freeWithChannel.result!.orderId as string;
    const memberOrderId = memberWithExternalChannel.result!.orderId as string;
    await updateOrderIdentityForProjectionTest(freeOrderId, { booking_channel_code: "WECOM" });
    await updateOrderIdentityForProjectionTest(memberOrderId, {
      member_id: demo.memberId,
      booking_channel_code: "CTRIP",
      channel_order_reference: "CTRIP-CONFLICT"
    });

    const result = await board({ arrivalDate: businessDate, departureDate });
    expect(result.projectionState).toBe("PARTIAL");
    for (const [unitId, orderId] of [
      [demo.secondRoomId, freeOrderId],
      [demo.roomId, memberOrderId]
    ] as const) {
      expect(intervalForOrder(result, unitId, orderId)).toMatchObject({
        status: "UNKNOWN",
        sourceCategory: null,
        freeStayCategoryCode: null,
        freeStayReason: null,
        primaryOccupantLabel: null,
        occupantCount: 0,
        occupants: [],
        allowedActions: []
      });
      expect(taskForOrder(result, orderId)).toMatchObject({
        status: "UNKNOWN",
        sourceCategory: null,
        freeStayCategoryCode: null,
        freeStayReason: null,
        primaryOccupantLabel: null,
        occupantCount: 0,
        occupants: [],
        allowedActions: []
      });
    }
  });

  it("normalizes historical source metadata without losing valid completed timelines", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const legacyFreeArrival = shiftLocalDate(businessDate, -8);
    const legacyFreeDeparture = shiftLocalDate(businessDate, -7);
    const damagedExternalArrival = shiftLocalDate(businessDate, -6);
    const damagedExternalDeparture = shiftLocalDate(businessDate, -5);
    const memberArrival = shiftLocalDate(businessDate, -4);
    const memberDeparture = shiftLocalDate(businessDate, -3);
    const damagedFreeArrival = shiftLocalDate(businessDate, -2);
    const damagedFreeDeparture = shiftLocalDate(businessDate, -1);
    const legacyFree = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: legacyFreeArrival,
      departureDate: legacyFreeDeparture,
      prefix: "legacy-free-source",
      stayType: "FREE"
    });
    const damagedExternal = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: damagedExternalArrival,
      departureDate: damagedExternalDeparture,
      prefix: "completed-external-source"
    });
    const completedMember = await createOrder({
      unitId: demo.roomId,
      arrivalDate: memberArrival,
      departureDate: memberDeparture,
      prefix: "completed-member-wecom-source"
    });
    const damagedFree = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: damagedFreeArrival,
      departureDate: damagedFreeDeparture,
      prefix: "completed-free-missing-reason",
      stayType: "FREE"
    });
    const legacyFreeOrderId = legacyFree.result!.orderId as string;
    const damagedExternalOrderId = damagedExternal.result!.orderId as string;
    const completedMemberOrderId = completedMember.result!.orderId as string;
    const damagedFreeOrderId = damagedFree.result!.orderId as string;
    await recordFullCollectionForProjectionTest(damagedExternalOrderId, "completed-external-source");
    await recordFullCollectionForProjectionTest(completedMemberOrderId, "completed-member-wecom-source");
    for (const [orderId, prefix] of [
      [legacyFreeOrderId, "legacy-free-source"],
      [damagedExternalOrderId, "completed-external-source"],
      [completedMemberOrderId, "completed-member-wecom-source"],
      [damagedFreeOrderId, "completed-free-missing-reason"]
    ] as const) {
      await markOrderInHouseFixture(orderId);
      await execute({
        commandType: "CHECK_OUT",
        input: { propertyId: demo.propertyId, orderId }
      }, `${prefix}-check-out`);
    }
    await updateOrderIdentityForProjectionTest(legacyFreeOrderId, {
      free_stay_category_code: null,
      free_stay_reason: null
    });
    await updateOrderIdentityForProjectionTest(damagedExternalOrderId, {
      booking_channel_code: "CTRIP",
      channel_order_reference: null
    });
    await updateOrderIdentityForProjectionTest(completedMemberOrderId, { member_id: demo.memberId });
    await updateOrderIdentityForProjectionTest(damagedFreeOrderId, { free_stay_reason: null });

    const result = await board({ arrivalDate: legacyFreeArrival, departureDate: damagedFreeDeparture });
    expect(result.projectionState).toBe("PARTIAL");
    expect(intervalForOrder(result, demo.secondRoomId, legacyFreeOrderId)).toMatchObject({
      status: "SETTLED",
      sourceKind: "FREE_STAY",
      sourceCategory: null,
      freeStayCategoryCode: null,
      freeStayReason: null,
      primaryOccupantLabel: "RS legacy-free-source"
    });
    expect(intervalForOrder(result, demo.secondRoomId, damagedExternalOrderId)).toMatchObject({
      status: "UNKNOWN",
      sourceKind: "ORDER",
      sourceCategory: null,
      freeStayCategoryCode: null,
      freeStayReason: null,
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: [],
      allowedActions: []
    });
    expect(intervalForOrder(result, demo.roomId, completedMemberOrderId)).toMatchObject({
      status: "SETTLED",
      sourceKind: "ORDER",
      sourceCategory: "MEMBER",
      freeStayCategoryCode: null,
      freeStayReason: null,
      primaryOccupantLabel: "RS completed-member-wecom-source"
    });
    expect(intervalForOrder(result, demo.secondRoomId, damagedFreeOrderId)).toMatchObject({
      status: "UNKNOWN",
      sourceKind: "FREE_STAY",
      sourceCategory: null,
      freeStayCategoryCode: null,
      freeStayReason: null,
      primaryOccupantLabel: null,
      occupantCount: 0,
      occupants: [],
      allowedActions: []
    });
  });

  it("fails closed instead of guessing active reserved arrears when the current pricing revision is missing", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "missing-current-revision"
    });
    const orderId = created.result!.orderId as string;
    await db.updateTable("orders").set({ current_revision_id: null }).where("id", "=", orderId).execute();

    const missingRevision = await board({ arrivalDate: businessDate, departureDate });
    expect(missingRevision.projectionState).toBe("PARTIAL");
    expect(intervalForOrder(missingRevision, demo.secondRoomId, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      available: false,
      blocking: true,
      allowedActions: []
    });
    expect(taskForOrder(missingRevision, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      allowedActions: []
    });
  });

  it("fails closed when current cash lines keep the same amount but no longer match the stay timeline", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "damaged-cash-line-timeline",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    });
    const orderId = created.result!.orderId as string;
    const revision = await db.selectFrom("orders as order")
      .innerJoin("pricing_revisions as revision", "revision.id", "order.current_revision_id")
      .select(["revision.id", "revision.cash_lines"])
      .where("order.id", "=", orderId)
      .executeTakeFirstOrThrow();
    const originalCashLines = revision.cash_lines as Array<{
      lineKind: string;
      amount: { minorUnits: number };
      calculationSegments: Array<{ inventoryUnitId: string }>;
    }>;
    expect(originalCashLines).toHaveLength(1);
    expect(originalCashLines[0]).toMatchObject({
      lineKind: "STAY_TOTAL",
      amount: { minorUnits: expect.any(Number) }
    });
    const unchangedAmount = originalCashLines[0]!.amount.minorUnits;

    await sql`alter table pricing_revisions disable trigger pricing_revisions_append_only`.execute(db);
    try {
      await sql`
        update pricing_revisions
        set cash_lines = jsonb_set(
          cash_lines::jsonb,
          '{0,calculationSegments,0,inventoryUnitId}',
          to_jsonb(${demo.roomId}::text)
        )::json
        where id = ${revision.id}
      `.execute(db);
    } finally {
      await sql`alter table pricing_revisions enable trigger pricing_revisions_append_only`.execute(db);
    }
    const damagedCashLines = (await db.selectFrom("pricing_revisions")
      .select("cash_lines")
      .where("id", "=", revision.id)
      .executeTakeFirstOrThrow()).cash_lines as typeof originalCashLines;
    expect(damagedCashLines[0]!.amount.minorUnits).toBe(unchangedAmount);
    expect(damagedCashLines[0]!.calculationSegments[0]!.inventoryUnitId).toBe(demo.roomId);

    const result = await board({ arrivalDate: businessDate, departureDate });
    expect(result.projectionState).toBe("PARTIAL");
    expect(intervalForOrder(result, demo.secondRoomId, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      available: false,
      blocking: true,
      allowedActions: []
    });
    expect(taskForOrder(result, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      allowedActions: []
    });
  });

  it("fails closed instead of projecting active reserved arrears from a negative net collection", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const negativeNet = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "negative-net-arrears"
    });
    const negativeNetOrderId = negativeNet.result!.orderId as string;
    const negativeNetCollection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: negativeNetOrderId,
        amountMinor: 1_000,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-NEGATIVE-NET-COLLECTION",
        note: "seed a fact that the test will corrupt to negative net"
      }
    }, "negative-net-arrears-collection");
    await sql`alter table collection_facts disable trigger collection_facts_append_only`.execute(db);
    try {
      await db.updateTable("collection_facts")
        .set({ net_effect_minor: -1_000 })
        .where("fact_id", "=", negativeNetCollection.factRefs[0]!)
        .execute();
    } finally {
      await sql`alter table collection_facts enable trigger collection_facts_append_only`.execute(db);
    }

    const damaged = await board({ arrivalDate: businessDate, departureDate });
    expect(damaged.projectionState).toBe("PARTIAL");
    expect(intervalForOrder(damaged, demo.secondRoomId, negativeNetOrderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      available: false,
      blocking: true,
      allowedActions: []
    });
    expect(taskForOrder(damaged, negativeNetOrderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      allowedActions: []
    });
  });

  it("fails closed when a reversed refund previously exceeded its damaged source collection", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "historical-over-refund-arrears"
    });
    const orderId = created.result!.orderId as string;
    const collection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 1_000,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-HISTORICAL-OVER-REFUND-COLLECTION",
        note: "seed source collection for historical over-refund corruption"
      }
    }, "historical-over-refund-collection");
    const refund = await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 1_000,
        referencesFactId: collection.factRefs[0]!,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-HISTORICAL-OVER-REFUND",
        note: "legal full refund before source collection corruption"
      }
    }, "historical-over-refund-refund");
    await execute({
      commandType: "REVERSE_FACT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        reversesFactId: refund.factRefs[0]!,
        note: "reverse the full refund before source collection corruption"
      }
    }, "historical-over-refund-reversal");
    expect((await board({ arrivalDate: businessDate, departureDate })).projectionState).toBe("READY");

    await sql`alter table collection_facts disable trigger collection_facts_append_only`.execute(db);
    try {
      await db.updateTable("collection_facts")
        .set({ amount_minor: 500, net_effect_minor: 500 })
        .where("fact_id", "=", collection.factRefs[0]!)
        .execute();
    } finally {
      await sql`alter table collection_facts enable trigger collection_facts_append_only`.execute(db);
    }

    const damaged = await board({ arrivalDate: businessDate, departureDate });
    expect(damaged.projectionState).toBe("PARTIAL");
    expect(intervalForOrder(damaged, demo.secondRoomId, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      available: false,
      blocking: true,
      allowedActions: []
    });
    expect(taskForOrder(damaged, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      allowedActions: []
    });
  });

  it("fails closed when an active collection loses its pricing revision lineage", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: businessDate,
      departureDate,
      prefix: "missing-collection-revision-lineage"
    });
    const orderId = created.result!.orderId as string;
    const collection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 1_000,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-MISSING-REVISION-LINEAGE",
        note: "seed a collection whose immutable lineage will be corrupted"
      }
    }, "missing-collection-revision-lineage");
    await sql`alter table collection_facts disable trigger collection_facts_append_only`.execute(db);
    try {
      await db.updateTable("collection_facts")
        .set({ pricing_revision_id: null })
        .where("fact_id", "=", collection.factRefs[0]!)
        .execute();
    } finally {
      await sql`alter table collection_facts enable trigger collection_facts_append_only`.execute(db);
    }

    const damaged = await board({ arrivalDate: businessDate, departureDate });
    expect(damaged.projectionState).toBe("PARTIAL");
    expect(intervalForOrder(damaged, demo.secondRoomId, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      available: false,
      blocking: true,
      allowedActions: []
    });
    expect(taskForOrder(damaged, orderId)).toMatchObject({
      status: "UNKNOWN",
      attention: null,
      allowedActions: []
    });
  });

  it("filters the full 200-room property before pagination and keeps unfiltered authoritative facets", async () => {
    const currentRooms = await db.selectFrom("inventory_units")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .executeTakeFirstOrThrow();
    const additions = 200 - Number(currentRooms.count);
    expect(additions).toBeGreaterThan(0);
    const targetRoomId = "unit_room_status_filter_page_four";
    await db.insertInto("inventory_units").values(Array.from({ length: additions }, (_, index) => {
      const target = index === additions - 1;
      return {
        id: target ? targetRoomId : `unit_room_status_filter_${index.toString().padStart(3, "0")}`,
        property_id: demo.propertyId,
        kind: "ROOM" as const,
        parent_room_id: null,
        code: target ? "ZZZ-NEEDLE-ROOM" : `Z-FILTER-${index.toString().padStart(3, "0")}`,
        name: target ? "Needle room on page four" : `Filter fixture room ${index}`,
        active: true,
        catalog_version: null,
        building_code: target ? "ZZZ" : "Z",
        room_type_code: target ? "FILTER_SPECIAL" : null,
        pricing_product_code: null,
        inventory_basis: "INDEPENDENT" as const,
        code_provenance: "PMS_GENERATED" as const,
        physical_bed_count: target ? 4 : 1,
        occupancy_capacity: target ? 4 : 1
      };
    })).execute();
    await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: targetRoomId,
        arrivalDate: "2029-01-10",
        departureDate: "2029-01-12",
        reason: "Authoritative status filter target"
      }
    }, "full-property-filter-maintenance");

    const unfilteredPageFour = await board({
      arrivalDate: "2029-01-10",
      departureDate: "2029-01-12",
      page: 3,
      pageSize: 50
    });
    expect(unfilteredPageFour.page).toEqual({ index: 3, size: 50, totalRooms: 200, totalPages: 4 });
    expect(unfilteredPageFour.rooms.some((room) => room.id === targetRoomId)).toBe(true);

    const filtered = await board({
      arrivalDate: "2029-01-10",
      departureDate: "2029-01-12",
      page: 0,
      pageSize: 50,
      search: "needle",
      roomType: "FILTER_SPECIAL",
      salesMode: "WHOLE_ROOM",
      status: "MAINTENANCE",
      minCapacity: 4,
      unitKind: "ROOM"
    });
    expect(filtered.page).toEqual({ index: 0, size: 50, totalRooms: 1, totalPages: 1 });
    expect(filtered.rooms).toHaveLength(1);
    expect(filtered.rooms[0]).toMatchObject({
      id: targetRoomId,
      roomTypeCode: "FILTER_SPECIAL",
      salesMode: "WHOLE_ROOM",
      capacity: 4,
      kind: "ROOM",
      children: []
    });
    expect(filtered.rooms[0]!.days.every((day) => day.status === "MAINTENANCE")).toBe(true);
    expect(filtered.filterOptions).toMatchObject({
      roomTypeCodes: expect.arrayContaining(["FILTER_SPECIAL"]),
      salesModes: expect.arrayContaining(["WHOLE_ROOM", "BED_SPLIT"]),
      statuses: expect.arrayContaining(["AVAILABLE", "MAINTENANCE"]),
      capacities: expect.arrayContaining([1, 4]),
      unitKinds: ["ROOM", "BED"]
    });

    const statusOnly = await board({
      arrivalDate: "2029-01-10",
      departureDate: "2029-01-12",
      pageSize: 50,
      status: "MAINTENANCE"
    });
    expect(statusOnly.page).toEqual({ index: 0, size: 50, totalRooms: 1, totalPages: 1 });
    expect(statusOnly.rooms.map((room) => room.id)).toEqual([targetRoomId]);

    const availableLastPage = await board({
      arrivalDate: "2029-01-10",
      departureDate: "2029-01-12",
      page: 3,
      pageSize: 50,
      status: "AVAILABLE"
    });
    expect(availableLastPage.page).toEqual({ index: 3, size: 50, totalRooms: 199, totalPages: 4 });
    expect(availableLastPage.rooms).toHaveLength(49);
    expect(availableLastPage.rooms.some((room) => room.id === targetRoomId)).toBe(false);
    expect(availableLastPage.rooms.every((room) => [room, ...room.children]
      .some((unit) => unit.days.some((day) => day.status === "AVAILABLE")))).toBe(true);
    expect(availableLastPage.filterOptions).toEqual(filtered.filterOptions);

    const bedOnly = await board({
      arrivalDate: "2029-01-10",
      departureDate: "2029-01-12",
      pageSize: 50,
      unitKind: "BED"
    });
    expect(bedOnly.page.totalRooms).toBeGreaterThan(0);
    expect(bedOnly.rooms.every((room) => room.kind === "ROOM" && room.children.length > 0
      && room.children.every((child) => child.kind === "BED"))).toBe(true);
    expect(bedOnly.filterOptions).toEqual(filtered.filterOptions);
  });

  it("caps operational tasks and fails closed when an SQL task source exceeds the projection limit", async () => {
    await db.insertInto("inventory_units").values(Array.from(
      { length: ROOM_STATUS_OPERATIONAL_TASK_LIMIT + 1 },
      (_, index) => ({
        id: `unit_room_status_task_limit_${index.toString().padStart(3, "0")}`,
        property_id: demo.propertyId,
        kind: "ROOM" as const,
        parent_room_id: null,
        code: `TASK-LIMIT-${index.toString().padStart(3, "0")}`,
        name: `Inactive operational task unit ${index}`,
        active: false,
        catalog_version: null,
        building_code: "TASK-LIMIT",
        room_type_code: null,
        pricing_product_code: null,
        inventory_basis: "INDEPENDENT" as const,
        code_provenance: "PMS_GENERATED" as const,
        physical_bed_count: 1
      })
    )).execute();

    const result = await board({ arrivalDate: "2031-01-01", departureDate: "2031-01-02" });
    expect(result.projectionState).toBe("PARTIAL");
    expect(result.operationalTasks).toHaveLength(ROOM_STATUS_OPERATIONAL_TASK_LIMIT);
    expect(result.operationalTasks.every((task) => task.sourceKind === "UNIT_UNSELLABLE")).toBe(true);
    expect(validateRoomStatusBoardSchema(result), JSON.stringify(validateRoomStatusBoardSchema.errors)).toBe(true);
  });

  it("bumps revision for repricing, active booking money history, and member coverage while serving 200 units by 30 nights within 500 ms P95", async () => {
    const created = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2028-10-01",
      departureDate: "2028-10-02",
      prefix: "money-revision"
    });
    const orderId = created.result!.orderId as string;
    const beforeReprice = await board({ arrivalDate: "2028-10-01", departureDate: "2028-10-02" });
    const reprice = await execute({
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId,
        targetCurrentContractAmountMinor: 10_000
      }
    }, "room-status-reprice-revision");
    const afterReprice = await board({ arrivalDate: "2028-10-01", departureDate: "2028-10-02" });
    expect(Number(afterReprice.revision)).toBe(Number(beforeReprice.revision) + 1);
    expect(unitIn(afterReprice, demo.secondRoomId).intervals.find((interval) => interval.references
      .some((reference) => reference.type === "ORDER" && reference.id === orderId))?.history)
      .toEqual(expect.arrayContaining([expect.objectContaining({ action: "REPRICE_ORDER", receiptId: reprice.receiptId })]));

    const beforeMoney = afterReprice.revision;
    await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 12_000,
        method: "BANK_TRANSFER",
        transactionReference: "ROOM-STATUS-MONEY-REVISION",
        note: "room status money revision probe"
      }
    }, "money-revision");
    expect(Number((await board({ arrivalDate: "2028-10-01", departureDate: "2028-10-02" })).revision)).toBe(Number(beforeMoney) + 1);

    const memberOrder = await createOrder({
      unitId: demo.roomId,
      arrivalDate: "2028-10-03",
      departureDate: "2028-10-04",
      prefix: "coverage-revision",
      memberContractId: demo.memberContractId
    });
    const memberOrderId = memberOrder.result!.orderId as string;
    const beforeRefresh = await board({ arrivalDate: "2028-10-03", departureDate: "2028-10-04" });
    const refresh = await execute({
      commandType: "REFRESH_MEMBER_COVERAGE",
      input: { propertyId: demo.propertyId, orderId: memberOrderId }
    }, "room-status-coverage-revision");
    const afterRefresh = await board({ arrivalDate: "2028-10-03", departureDate: "2028-10-04" });
    expect(Number(afterRefresh.revision)).toBe(Number(beforeRefresh.revision) + 1);
    expect(unitIn(afterRefresh, demo.roomId).intervals.find((interval) => interval.references
      .some((reference) => reference.type === "ORDER" && reference.id === memberOrderId))?.history)
      .toEqual(expect.arrayContaining([expect.objectContaining({ action: "REFRESH_MEMBER_COVERAGE", receiptId: refresh.receiptId })]));

    const currentCount = await db.selectFrom("inventory_units")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("property_id", "=", demo.propertyId)
      .executeTakeFirstOrThrow();
    const currentRoomCount = await db.selectFrom("inventory_units")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .executeTakeFirstOrThrow();
    const additions = 200 - Number(currentCount.count);
    const expectedRoomCount = Number(currentRoomCount.count) + additions;
    await db.insertInto("inventory_units").values(Array.from({ length: additions }, (_, index) => ({
      id: `unit_room_status_perf_${index.toString().padStart(3, "0")}`,
      property_id: demo.propertyId,
      kind: "ROOM" as const,
      parent_room_id: null,
      code: `Z-PERF-${index.toString().padStart(3, "0")}`,
      name: `Performance room ${index}`,
      active: true,
      catalog_version: null,
      building_code: "Z",
      room_type_code: null,
      pricing_product_code: null,
      inventory_basis: "INDEPENDENT" as const,
      code_provenance: "PMS_GENERATED" as const,
      physical_bed_count: 1
    }))).execute();

    const firstPageStartedAt = performance.now();
    const firstPage = await board({ arrivalDate: "2029-01-01", departureDate: "2029-01-31", pageSize: 50 });
    const firstPageElapsedMs = performance.now() - firstPageStartedAt;
    expect(firstPage.rooms).toHaveLength(50);
    expect(firstPage.page).toMatchObject({
      index: 0,
      size: 50,
      totalRooms: expectedRoomCount,
      totalPages: Math.ceil(expectedRoomCount / 50)
    });
    expect(firstPageElapsedMs).toBeLessThanOrEqual(500);

    const query = () => board({ arrivalDate: "2029-01-01", departureDate: "2029-01-31", pageSize: 200 });
    await query();
    await query();
    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const start = performance.now();
      const result = await query();
      samples.push(performance.now() - start);
      expect(result.rooms.reduce((count, room) => count + 1 + room.children.length, 0)).toBe(200);
      expect(result.dates).toHaveLength(ROOM_STATUS_MAX_QUERY_NIGHTS);
      const serialized = JSON.stringify(result);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(2_100_000);
      expect(gzipSync(serialized).byteLength).toBeLessThanOrEqual(50_000);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    expect(p95).toBeLessThanOrEqual(500);
  }, 30_000);

  it("rolls back Block, Claims, and revision when the durable Receipt cannot commit", async () => {
    await sql.raw(`
      CREATE OR REPLACE FUNCTION fail_maintenance_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.business_committed IS TRUE AND EXISTS (
          SELECT 1 FROM command_executions
          WHERE id = NEW.command_id AND command_type = 'LOCK_MAINTENANCE'
        ) THEN
          RAISE EXCEPTION 'forced maintenance receipt failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_maintenance_receipt_before_insert
      BEFORE INSERT ON command_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_maintenance_receipt();
    `).execute(db);
    try {
      const prepared = await prepare({
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.bedAId,
          arrivalDate: "2029-05-01",
          departureDate: "2029-05-03",
          reason: "Rollback acceptance"
        }
      }, "maintenance-rollback");
      const receipt = (await confirmPrepared(prepared, "maintenance-rollback")).receipt;
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "COMMAND_INTERRUPTED" }
      });
      expect(await db.selectFrom("maintenance_locks").select("id").execute()).toHaveLength(0);
      expect(await db.selectFrom("inventory_claims").select("id").where("source_type", "=", "MAINTENANCE").execute()).toHaveLength(0);
      expect((await board({ arrivalDate: "2029-05-01", departureDate: "2029-05-03" })).revision).toBe("0");
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS fail_maintenance_receipt_before_insert ON command_receipts;
        DROP FUNCTION IF EXISTS fail_maintenance_receipt();
      `).execute(db);
    }
  });

  it("keeps the 30-night query window separate from domain-valid long maintenance Blocks", async () => {
    const blockStart = "2032-01-01";
    const longBlockNights = ROOM_STATUS_MAX_QUERY_NIGHTS + 30;
    const blockEnd = shiftLocalDate(blockStart, longBlockNights);
    const queryEnd = shiftLocalDate(blockStart, ROOM_STATUS_MAX_QUERY_NIGHTS);
    const accepted = await prepare({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: blockStart,
        departureDate: blockEnd,
        reason: "Domain-valid maintenance Block longer than one query window"
      }
    }, "long-block-preview");
    const placed = (await confirmPrepared(accepted, "long-block-confirm")).receipt;
    const blockId = placed.result!.maintenanceLockId as string;
    expect(placed.factRefs).toHaveLength(longBlockNights);

    const queryWindow = await board({ arrivalDate: blockStart, departureDate: queryEnd });
    const interval = unitIn(queryWindow, demo.bedAId).intervals.find((candidate) => candidate.references
      .some((reference) => reference.type === "BLOCK" && reference.id === blockId));
    expect(interval).toMatchObject({
      startDate: blockStart,
      endDate: queryEnd,
      sourceStartDate: blockStart,
      sourceEndDate: blockEnd
    });
    expect(interval?.allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RELEASE_MAINTENANCE", enabled: true, requiresFullInterval: true })
    ]));

    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId: blockId }
    }, "long-block-release");
    expect(await db.selectFrom("inventory_claims").select("id")
      .where("source_type", "=", "MAINTENANCE").where("source_id", "=", blockId).where("active", "=", true).execute())
      .toHaveLength(0);

    const maintenance = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: blockStart,
        departureDate: blockEnd,
        reason: "Domain-valid maintenance longer than one query window"
      }
    }, "long-maintenance");
    const maintenanceLockId = maintenance.result!.maintenanceLockId as string;
    expect((await db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<string>().as("count"))
      .where("source_type", "=", "MAINTENANCE").where("source_id", "=", maintenanceLockId).executeTakeFirstOrThrow()).count)
      .toBe(String(longBlockNights));
    expect(unitIn(await board({ arrivalDate: blockStart, departureDate: queryEnd }), demo.secondRoomId).days)
      .toHaveLength(ROOM_STATUS_MAX_QUERY_NIGHTS);
    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId }
    }, "long-maintenance-release");
  });

  it("rejects deferred internal-use commands and direct database writes", async () => {
    await expect(prepare({
      commandType: "PLACE_INTERNAL_USE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: "2029-06-01",
        departureDate: "2029-06-02",
        reason: "Deferred internal use"
      }
    } as unknown as CommandEnvelope, "deferred-internal-use")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(db.insertInto("internal_use_blocks").values({
      id: "block_deferred_internal_use",
      property_id: demo.propertyId,
      inventory_unit_id: demo.bedAId,
      room_id: demo.roomId,
      arrival_date: "2029-06-01",
      departure_date: "2029-06-02",
      reason: "Deferred internal use",
      status: "ACTIVE",
      version: 1,
      created_by_command_id: "command_deferred_internal_use",
      released_by_command_id: null,
      released_at: null
    }).execute()).rejects.toMatchObject({ constraint: "internal_use_deferred" });

    await expect(db.insertInto("inventory_claims").values({
      id: "claim_deferred_internal_use",
      property_id: demo.propertyId,
      room_id: demo.roomId,
      inventory_unit_id: demo.bedAId,
      service_date: "2029-06-01",
      source_type: "INTERNAL_USE",
      source_id: "block_deferred_internal_use",
      active: true,
      released_at: null
    }).execute()).rejects.toMatchObject({ constraint: "internal_use_deferred" });

    expect(await db.selectFrom("internal_use_blocks").select("id").execute()).toHaveLength(0);
    expect(await db.selectFrom("inventory_claims").select("id").where("source_type", "=", "INTERNAL_USE").execute()).toHaveLength(0);
  });

  it("rejects direct Block release with active Claims plus Claim and cleaning identity corruption in PostgreSQL", async () => {
    const placed = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedAId,
        arrivalDate: "2029-06-01",
        departureDate: "2029-06-02",
        reason: "Immutable source acceptance"
      }
    }, "immutable-maintenance-primary");
    const blockId = placed.result!.maintenanceLockId as string;
    const claimId = placed.factRefs[0]!;
    await expect(db.updateTable("maintenance_locks").set({
      status: "RELEASED",
      version: 2,
      released_by_command_id: placed.commandId,
      released_at: new Date()
    }).where("id", "=", blockId).execute())
      .rejects.toMatchObject({ constraint: "maintenance_locks_active_claims_released" });
    await expect(db.updateTable("maintenance_locks").set({ reason: "Mutated reason" }).where("id", "=", blockId).execute())
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.updateTable("inventory_claims").set({ inventory_unit_id: demo.bedBId }).where("id", "=", claimId).execute())
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.updateTable("inventory_claims").set({ active: false, released_at: new Date() }).where("id", "=", claimId).execute())
      .rejects.toMatchObject({ constraint: "maintenance_claims_complete_release" });
    await expect(db.insertInto("inventory_claims").values({
      id: "claim_mismatched_maintenance_source",
      property_id: demo.propertyId,
      room_id: demo.roomId,
      inventory_unit_id: demo.bedBId,
      service_date: "2029-06-01",
      source_type: "MAINTENANCE",
      source_id: blockId,
      active: true,
      released_at: null
    }).execute()).rejects.toMatchObject({ constraint: "inventory_claims_typed_source_integrity" });
    await expect(db.deleteFrom("maintenance_locks").where("id", "=", blockId).execute())
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.deleteFrom("inventory_claims").where("id", "=", claimId).execute())
      .rejects.toMatchObject({ code: "55000" });
    const release = await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId: blockId }
    }, "immutable-maintenance-primary-release");
    expect(release.factRefs).toEqual([claimId]);
    expect(await db.selectFrom("inventory_claims").select("id")
      .where("source_type", "=", "MAINTENANCE").where("source_id", "=", blockId).where("active", "=", true).execute())
      .toHaveLength(0);

    const maintenance = await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.bedBId,
        arrivalDate: "2029-06-03",
        departureDate: "2029-06-04",
        reason: "Append-only maintenance source"
      }
    }, "immutable-maintenance");
    const maintenanceLockId = maintenance.result!.maintenanceLockId as string;
    await expect(db.updateTable("maintenance_locks").set({
      status: "RELEASED",
      version: 2,
      released_by_command_id: maintenance.commandId,
      released_at: new Date()
    }).where("id", "=", maintenanceLockId).execute())
      .rejects.toMatchObject({ constraint: "maintenance_locks_active_claims_released" });
    await expect(db.deleteFrom("maintenance_locks").where("id", "=", maintenanceLockId).execute())
      .rejects.toMatchObject({ code: "55000" });
    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId: demo.propertyId, maintenanceLockId }
    }, "immutable-maintenance-release");
    expect(await db.selectFrom("inventory_claims").select("id")
      .where("source_type", "=", "MAINTENANCE").where("source_id", "=", maintenanceLockId).where("active", "=", true).execute())
      .toHaveLength(0);

    const { arrivalDate, departureDate: businessDate } = await distinctBusinessDatesAcrossTimezones();
    const order = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate: businessDate,
      prefix: "immutable-cleaning"
    });
    const orderId = order.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "immutable-cleaning-checkin");
    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    const checkout = await execute({ commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId } }, "immutable-cleaning-checkout");
    const cleaningTaskId = "cleaning_immutable_historical";
    await db.insertInto("cleaning_tasks").values({
      id: cleaningTaskId,
      property_id: demo.propertyId,
      order_id: orderId,
      stay_id: order.result!.stayId as string,
      inventory_unit_id: demo.secondRoomId,
      room_id: demo.secondRoomId,
      service_date: businessDate,
      status: "PENDING",
      version: 1,
      created_by_command_id: checkout.commandId,
      completed_by_command_id: null,
      completed_at: null
    }).execute();
    await expect(db.updateTable("cleaning_tasks").set({ service_date: "2029-06-12" }).where("id", "=", cleaningTaskId).execute())
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.deleteFrom("cleaning_tasks").where("id", "=", cleaningTaskId).execute())
      .rejects.toMatchObject({ code: "55000" });

    const wrongCleaningOrder = await createOrder({
      unitId: demo.secondRoomId,
      arrivalDate: "2029-06-20",
      departureDate: "2029-06-21",
      prefix: "wrong-cleaning-segment"
    });
    await expect(db.insertInto("cleaning_tasks").values({
      id: "cleaning_wrong_stay_segment",
      property_id: demo.propertyId,
      order_id: wrongCleaningOrder.result!.orderId as string,
      stay_id: wrongCleaningOrder.result!.stayId as string,
      inventory_unit_id: demo.roomId,
      room_id: demo.roomId,
      service_date: "2029-06-21",
      status: "PENDING",
      version: 1,
      created_by_command_id: wrongCleaningOrder.commandId,
      completed_by_command_id: null,
      completed_at: null
    }).execute()).rejects.toMatchObject({ constraint: "cleaning_tasks_stay_segment_valid" });
  });
});
