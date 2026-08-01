import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, BookingChannelCode, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createDatabase,
  createCommandPreview,
  getOrderView,
  propertyLocalToday,
  releaseInventoryClaimsOnDates,
  type Database
} from "@qintopia/db";
import { newId, parseLocalDate } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { loadActiveStayTimeline, loadOrderContext } from "../../packages/db/src/orders.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.STAY_DATE_CHANGE_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stay_date_changes";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function shiftDate(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function testPricingPolicyForDates(arrivalDate: string, departureDate: string): string {
  return arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
    ? demo.transientPolicyId
    : demo.publicPricingPolicyId;
}

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(
  prepared: Awaited<ReturnType<typeof preview>>,
  prefix: string,
  confirmationMetadata = metadata(`${prefix}-confirm`)
): Promise<ReceiptDto> {
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: prepared.preview.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: prepared.preview.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "AUTOMATED_STAGE9", note: "4.2 自动化验收" }
  }, confirmationMetadata);
}

async function execute(envelope: CommandEnvelope, prefix: string) {
  return confirm(await preview(envelope, prefix), prefix);
}

async function createPaidOrder(options: {
  prefix: string;
  arrivalDate: string;
  departureDate: string;
  unitId?: string;
  channel?: BookingChannelCode;
  targetDeltaMinor?: number;
  pricingPolicyVersionId?: string;
}) {
  const channel = options.channel ?? "CTRIP";
  const priced = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId ?? demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: options.pricingPolicyVersionId
      ?? testPricingPolicyForDates(options.arrivalDate, options.departureDate)
  });
  const target = priced.currentContractAmount.minorUnits + (options.targetDeltaMinor ?? 0);
  const receipt = await execute({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: priced.quoteId,
      primaryGuest: { fullName: options.prefix, nickname: options.prefix },
      bookingChannelCode: channel,
      channelOrderReference: channel === "WECOM" ? null : `${channel}-${options.prefix}`,
      ...(channel === "WECOM" && options.targetDeltaMinor === undefined ? {} : { targetCurrentContractAmountMinor: target }),
      ...(options.targetDeltaMinor ? { manualPriceAdjustmentReason: "创建时主动偏价" } : {})
    }
  }, `${options.prefix}-create`);
  return { orderId: receipt.result!.orderId as string, priced, target };
}

async function createFreeOrder(options: {
  prefix: string;
  arrivalDate: string;
  departureDate: string;
  unitId: string;
}) {
  const priced = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    stayType: "FREE",
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: demo.freePolicyId
  });
  const receipt = await execute({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: priced.quoteId,
      primaryGuest: { fullName: options.prefix, nickname: options.prefix },
      freeStayReason: "4.2 房床并发测试",
      freeStayCategoryCode: "RECEPTION"
    }
  }, `${options.prefix}-create`);
  return { orderId: receipt.result!.orderId as string };
}

async function createMemberProfile(memberId: string): Promise<void> {
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `STAGE9-${memberId}`,
    full_name: memberId,
    phone: "13800009009",
    wechat: `wx-${memberId}`
  }).execute();
  await db.insertInto("member_property_links").values({
    member_id: memberId,
    property_id: demo.propertyId
  }).execute();
}

async function addSharedSingleEntitlement(options: {
  prefix: string;
  memberId: string;
  validFrom: string;
  validUntil: string;
  totalUnits?: number;
}) {
  const contractId = `contract_${options.prefix}`;
  const lotId = `lot_${options.prefix}`;
  const membershipOrderId = `membership_order_${options.prefix}`;
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("member_contracts").values({
      id: contractId,
      property_id: demo.propertyId,
      member_id: options.memberId,
      member_name: options.memberId,
      status: "ACTIVE",
      valid_from: options.validFrom,
      valid_until: options.validUntil,
      version: 1
    }).execute();
    await trx.insertInto("entitlement_lots").values({
      id: lotId,
      contract_id: contractId,
      unit_kind: "ROOM_NIGHT",
      total_units: options.totalUnits ?? 1,
      expires_on: options.validUntil,
      version: 1
    }).execute();
    await trx.insertInto("membership_orders").values({
      id: membershipOrderId,
      property_id: demo.propertyId,
      member_id: options.memberId,
      product_id: "membership_product_shared_bath_single_v1",
      product_code: "SHARED_BATH_SINGLE_30",
      product_version: 1,
      product_name: "公卫单人间会员",
      listed_price_minor: 162_000,
      agreed_price_minor: 162_000,
      price_adjustment_minor: 0,
      price_adjustment_reason: null,
      currency: "CNY",
      entitlement_unit_kind: "ROOM_NIGHT",
      entitlement_units: options.totalUnits ?? 1,
      allowed_room_type_code: "shared_bath_single",
      allowed_inventory_kind: "ROOM",
      status: "ACTIVE",
      activated_at: new Date("2028-01-01T00:00:00.000Z"),
      valid_from: options.validFrom,
      valid_until: options.validUntil,
      contract_id: contractId,
      entitlement_lot_id: lotId,
      version: 1,
      created_by_command_id: `command_${options.prefix}`,
      activated_by_command_id: `command_${options.prefix}`
    }).execute();
    await trx.updateTable("member_contracts")
      .set({ membership_order_id: membershipOrderId })
      .where("id", "=", contractId)
      .executeTakeFirstOrThrow();
  });
  return { contractId, lotId };
}

async function markHistoricalOrderInHouse(orderId: string, businessDate: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom("orders").selectAll().where("id", "=", orderId).forUpdate().executeTakeFirstOrThrow();
    const stay = await trx.selectFrom("stays").select("id").where("order_id", "=", orderId).executeTakeFirstOrThrow();
    await trx.insertInto("amendments").values({
      id: newId("amend"),
      order_id: orderId,
      sequence: order.version + 1,
      amendment_type: "CHECK_IN",
      reason_code: "STAGE9_HISTORICAL_SETUP",
      reason_note: "构造计划退房日及逾期续住的历史在住事实",
      prior_version: order.version,
      new_version: order.version + 1,
      payload: {
        orderId,
        fromStatus: "RESERVED",
        toStatus: "CHECKED_IN",
        businessDate,
        entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 0 }
      },
      command_id: null,
      created_at: sql`(SELECT max(created_at) FROM amendments WHERE order_id = ${orderId})`
    }).execute();
    await trx.updateTable("orders").set({ status: "CHECKED_IN", version: order.version + 1, updated_at: new Date() })
      .where("id", "=", orderId).executeTakeFirstOrThrow();
    await trx.updateTable("stays").set({ status: "IN_HOUSE" }).where("id", "=", stay.id).executeTakeFirstOrThrow();
  });
}

async function businessSnapshot(orderId: string) {
  const [order, stay, amendments, segments, revisions, claims, coverage, ledger, facts] = await Promise.all([
    db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("stays").selectAll().where("order_id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").selectAll().where("order_id", "=", orderId).orderBy("sequence").execute(),
    db.selectFrom("stay_segments").innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .selectAll("stay_segments").where("stays.order_id", "=", orderId).orderBy("stay_segments.sequence").execute(),
    db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no").execute(),
    db.selectFrom("inventory_claims").selectAll().where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", db.selectFrom("stay_segments").innerJoin("stays", "stays.id", "stay_segments.stay_id")
        .select("stay_segments.id").where("stays.order_id", "=", orderId)).orderBy("service_date").orderBy("id").execute(),
    db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute(),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId)
      .orderBy("created_at").orderBy("fact_id").execute()
  ]);
  return JSON.parse(JSON.stringify({ order, stay, amendments, segments, revisions, claims, coverage, ledger, facts }));
}

async function atomicBusinessSnapshot(orderId: string) {
  const [orderFacts, roomDays, bedDays, roomStatusRevision] = await Promise.all([
    businessSnapshot(orderId),
    db.selectFrom("inventory_room_days").selectAll().orderBy("room_id").orderBy("service_date").execute(),
    db.selectFrom("inventory_bed_days").selectAll().orderBy("room_id").orderBy("bed_id").orderBy("service_date").execute(),
    db.selectFrom("room_status_revisions").selectAll().orderBy("property_id").execute()
  ]);
  return JSON.parse(JSON.stringify({ orderFacts, roomDays, bedDays, roomStatusRevision }));
}

async function expectDirectStage9RevisionRejected(options: {
  orderId: string;
  amendmentOrderId?: string;
  amendmentType: "RESCHEDULE_STAY" | "EXTEND_STAY";
  pricingBasis: "POLICY" | "CHANNEL_CONTRACT" | "MANUAL_ADJUSTMENT" | null;
  manualAdjustmentMinor: number;
  expectedConstraint: string;
}) {
  const order = await db.selectFrom("orders").selectAll().where("id", "=", options.orderId).executeTakeFirstOrThrow();
  const amendmentOrder = options.amendmentOrderId
    ? await db.selectFrom("orders").selectAll().where("id", "=", options.amendmentOrderId).executeTakeFirstOrThrow()
    : order;
  const currentRevision = await db.selectFrom("pricing_revisions").selectAll()
    .where("id", "=", order.current_revision_id!).executeTakeFirstOrThrow();
  const beforeCounts = await Promise.all([
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  const attempt = db.transaction().execute(async (trx) => {
    const amendmentId = newId("amend");
    await trx.insertInto("amendments").values({
      id: amendmentId,
      order_id: amendmentOrder.id,
      sequence: amendmentOrder.version + 1,
      amendment_type: options.amendmentType,
      reason_code: "STAGE9_DIRECT_GUARD",
      reason_note: "Migration 026 direct-write guard",
      prior_version: amendmentOrder.version,
      new_version: amendmentOrder.version + 1,
      payload: {},
      command_id: null
    }).execute();
    await trx.insertInto("pricing_revisions").values({
      id: newId("revision"),
      order_id: order.id,
      revision_no: currentRevision.revision_no + 1,
      amendment_id: amendmentId,
      policy_version_id: currentRevision.policy_version_id,
      arrival_date: order.arrival_date,
      departure_date: order.departure_date,
      coverage_set: JSON.stringify(currentRevision.coverage_set),
      cash_lines: JSON.stringify(currentRevision.cash_lines),
      policy_base_amount_minor: currentRevision.policy_base_amount_minor,
      pricing_basis: options.pricingBasis as "POLICY",
      manual_adjustment_minor: options.manualAdjustmentMinor,
      current_contract_amount_minor: currentRevision.policy_base_amount_minor + options.manualAdjustmentMinor,
      currency: currentRevision.currency
    }).execute();
  });
  await expect(attempt).rejects.toMatchObject({ constraint: options.expectedConstraint });
  const afterCounts = await Promise.all([
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  expect(afterCounts).toEqual(beforeCounts);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe.sequential("4.2 RESCHEDULE_STAY and checked-in EXTEND_STAY", () => {
  it("reschedules a reserved external-channel order atomically and preserves intersecting Claim ids", async () => {
    const created = await createPaidOrder({
      prefix: "stage9-claim-diff",
      arrivalDate: "2028-06-10",
      departureDate: "2028-06-13"
    });
    const beforeView = await getOrderView(db, created.orderId);
    const stayId = beforeView.stay.id;
    const beforeClaims = await db.selectFrom("inventory_claims")
      .select(["id", "service_date", "active"])
      .where("source_id", "in", beforeView.segments.map((segment) => segment.id))
      .orderBy("service_date")
      .execute();

    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-06-11",
        newDepartureDate: "2028-06-14",
        targetCurrentContractAmountMinor: created.priced.currentContractAmount.minorUnits
      }
    }, "stage9-claim-diff");
    expect(prepared.preview.effect).toMatchObject({
      operation: "RESCHEDULE_STAY",
      before: { arrivalDate: "2028-06-10", departureDate: "2028-06-13", nights: 3 },
      after: { arrivalDate: "2028-06-11", departureDate: "2028-06-14", nights: 3 },
      inventoryChange: {
        preservedDates: ["2028-06-11", "2028-06-12"],
        releasedDates: ["2028-06-10"],
        addedDates: ["2028-06-13"]
      },
      pricingDecision: { pricingBasis: "CHANNEL_CONTRACT" }
    });
    const confirmationMetadata = metadata("stage9-claim-diff-confirm");
    const receipt = await confirm(prepared, "stage9-claim-diff", confirmationMetadata);
    expect(receipt).toMatchObject({
      businessCommitted: true,
      result: {
        orderId: created.orderId,
        stayId,
        before: {
          arrivalDate: "2028-06-10",
          departureDate: "2028-06-13",
          nights: 3,
          currentContractAmount: expect.any(Object)
        },
        after: {
          arrivalDate: "2028-06-11",
          departureDate: "2028-06-14",
          nights: 3
        },
        inventoryChange: {
          preservedDates: ["2028-06-11", "2028-06-12"],
          releasedDates: ["2028-06-10"],
          addedDates: ["2028-06-13"]
        },
        entitlementChange: expect.any(Object),
        pricingDecision: expect.any(Object),
        fundsSummary: expect.any(Object)
      }
    });
    const replay = await confirm(prepared, "stage9-claim-diff-replay", confirmationMetadata);
    expect(replay.receiptId).toBe(receipt.receiptId);

    const view = await getOrderView(db, created.orderId);
    expect(view.order).toMatchObject({ arrival_date: "2028-06-11", departure_date: "2028-06-14", version: 2 });
    expect(view.stay.id).toBe(stayId);
    expect(view.arrangementHistory.at(-1)).toMatchObject({
      type: "RESCHEDULE",
      before: { arrivalDate: "2028-06-10", departureDate: "2028-06-13" },
      after: { arrivalDate: "2028-06-11", departureDate: "2028-06-14" }
    });
    const claims = await db.selectFrom("inventory_claims")
      .select(["id", "service_date", "active"])
      .where("source_id", "in", view.segments.map((segment) => segment.id))
      .orderBy("service_date")
      .orderBy("id")
      .execute();
    const oldByDate = new Map(beforeClaims.map((claim) => [claim.service_date, claim]));
    expect(claims.find((claim) => claim.service_date === "2028-06-10")).toMatchObject({ id: oldByDate.get("2028-06-10")!.id, active: false });
    expect(claims.find((claim) => claim.service_date === "2028-06-11")).toMatchObject({ id: oldByDate.get("2028-06-11")!.id, active: true });
    expect(claims.find((claim) => claim.service_date === "2028-06-12")).toMatchObject({ id: oldByDate.get("2028-06-12")!.id, active: true });
    expect(claims.find((claim) => claim.service_date === "2028-06-13")).toMatchObject({ active: true });
    expect(view.pricingRevisions).toHaveLength(2);
    expect(view.collectionFacts).toHaveLength(0);
  });

  it("fails closed for invalid states, no-op dates and past arrivals, then applies Plan B to a multi-unit reservation", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage9-state-matrix",
      arrivalDate: "2028-07-10",
      departureDate: "2028-07-13",
      channel: "WECOM"
    });
    const unchanged = await businessSnapshot(created.orderId);
    await expect(preview({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: "2028-07-14" }
    }, "reserved-extend-rejected")).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-07-10",
        newDepartureDate: "2028-07-13",
        targetCurrentContractAmountMinor: created.target
      }
    }, "no-op-rejected")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: shiftDate(businessDate, -1),
        newDepartureDate: shiftDate(businessDate, 1),
        targetCurrentContractAmountMinor: created.target
      }
    }, "past-arrival-rejected")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await businessSnapshot(created.orderId)).toEqual(unchanged);

    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: "2028-07-12"
      }
    }, "stage9-existing-move");
    const movedView = await getOrderView(db, created.orderId);
    const beforePlanClaims = await db.selectFrom("inventory_claims")
      .select(["id", "service_date", "inventory_unit_id", "active"])
      .where("source_id", "in", movedView.segments.map((segment) => segment.id))
      .where("active", "=", true)
      .orderBy("service_date")
      .execute();
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-07-11",
        newDepartureDate: "2028-07-14",
        targetCurrentContractAmountMinor: movedView.amounts.currentContractAmount.minorUnits
      }
    }, "multi-unit-plan-b");
    expect(prepared.preview.effect).toMatchObject({
      before: {
        stayTimeline: [
          { serviceDate: "2028-07-10", inventoryUnitId: demo.roomId },
          { serviceDate: "2028-07-11", inventoryUnitId: demo.roomId },
          { serviceDate: "2028-07-12", inventoryUnitId: demo.secondRoomId }
        ]
      },
      after: {
        stayTimeline: [
          { serviceDate: "2028-07-11", inventoryUnitId: demo.roomId },
          { serviceDate: "2028-07-12", inventoryUnitId: demo.roomId },
          { serviceDate: "2028-07-13", inventoryUnitId: demo.secondRoomId }
        ]
      },
      inventoryChange: {
        preservedDates: ["2028-07-11"],
        releasedDates: ["2028-07-10", "2028-07-12"],
        addedDates: ["2028-07-12", "2028-07-13"]
      }
    });
    const rescheduleReceipt = await confirm(prepared, "multi-unit-plan-b");
    expect(rescheduleReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const rescheduled = await getOrderView(db, created.orderId);
    expect(rescheduled.effectiveArrangement.intervals).toEqual([
      { inventoryUnitId: demo.roomId, arrivalDate: "2028-07-11", departureDate: "2028-07-13" },
      { inventoryUnitId: demo.secondRoomId, arrivalDate: "2028-07-13", departureDate: "2028-07-14" }
    ]);
    const allClaims = await db.selectFrom("inventory_claims")
      .select(["id", "service_date", "inventory_unit_id", "active"])
      .where("source_id", "in", rescheduled.segments.map((segment) => segment.id))
      .orderBy("service_date")
      .orderBy("id")
      .execute();
    const preserved = beforePlanClaims.find((claim) => claim.service_date === "2028-07-11")!;
    expect(allClaims).toContainEqual(preserved);
    expect(allClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service_date: "2028-07-12",
        inventory_unit_id: demo.secondRoomId,
        active: false
      }),
      expect.objectContaining({
        service_date: "2028-07-12",
        inventory_unit_id: demo.roomId,
        active: true
      }),
      expect.objectContaining({
        service_date: "2028-07-13",
        inventory_unit_id: demo.secondRoomId,
        active: true
      })
    ]));
  });

  it.each([
    {
      label: "one-sided extension",
      original: ["2029-01-10", "2029-01-14"],
      moveDate: "2029-01-12",
      changed: ["2029-01-09", "2029-01-14"],
      expected: [
        { inventoryUnitId: demo.roomId, arrivalDate: "2029-01-09", departureDate: "2029-01-12" },
        { inventoryUnitId: demo.secondRoomId, arrivalDate: "2029-01-12", departureDate: "2029-01-14" }
      ]
    },
    {
      label: "unequal two-sided change",
      original: ["2029-02-10", "2029-02-14"],
      moveDate: "2029-02-12",
      changed: ["2029-02-09", "2029-02-15"],
      expected: [
        { inventoryUnitId: demo.roomId, arrivalDate: "2029-02-09", departureDate: "2029-02-12" },
        { inventoryUnitId: demo.secondRoomId, arrivalDate: "2029-02-12", departureDate: "2029-02-15" }
      ]
    },
    {
      label: "entirely earlier interval",
      original: ["2029-03-10", "2029-03-14"],
      moveDate: "2029-03-12",
      changed: ["2029-03-01", "2029-03-03"],
      expected: [
        { inventoryUnitId: demo.roomId, arrivalDate: "2029-03-01", departureDate: "2029-03-03" }
      ]
    },
    {
      label: "entirely later interval",
      original: ["2029-04-10", "2029-04-14"],
      moveDate: "2029-04-12",
      changed: ["2029-04-20", "2029-04-22"],
      expected: [
        { inventoryUnitId: demo.secondRoomId, arrivalDate: "2029-04-20", departureDate: "2029-04-22" }
      ]
    }
  ])("persists the Plan B $label result exactly as previewed", async ({ label, original, moveDate, changed, expected }) => {
    const created = await createFreeOrder({
      prefix: `stage11-plan-b-${label}`,
      arrivalDate: original[0]!,
      departureDate: original[1]!,
      unitId: demo.roomId
    });
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: moveDate
      }
    }, `stage11-plan-b-${label}-move`);
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: changed[0]!,
        newDepartureDate: changed[1]!
      }
    }, `stage11-plan-b-${label}-reschedule`);
    const previewTimeline = (prepared.preview.effect.after as { stayTimeline: unknown }).stayTimeline;
    const receipt = await confirm(prepared, `stage11-plan-b-${label}-reschedule`);
    expect(receipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    const view = await getOrderView(db, created.orderId);
    expect(view.effectiveArrangement.intervals).toEqual(expected);
    expect(await loadActiveStayTimeline(db, await loadOrderContext(db, created.orderId))).toEqual(previewTimeline);
  });

  it("serializes two multi-unit Plan B shifts across every old and new room-day", async () => {
    const first = await createFreeOrder({
      prefix: "stage11-plan-b-concurrent-first",
      arrivalDate: "2029-05-01",
      departureDate: "2029-05-05",
      unitId: demo.roomId
    });
    const second = await createFreeOrder({
      prefix: "stage11-plan-b-concurrent-second",
      arrivalDate: "2029-05-10",
      departureDate: "2029-05-14",
      unitId: demo.roomId
    });
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: first.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: "2029-05-03"
      }
    }, "stage11-plan-b-concurrent-first-move");
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: second.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: "2029-05-12"
      }
    }, "stage11-plan-b-concurrent-second-move");
    const firstPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: first.orderId,
        newArrivalDate: "2029-06-01",
        newDepartureDate: "2029-06-05"
      }
    }, "stage11-plan-b-concurrent-first");
    const secondPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: second.orderId,
        newArrivalDate: "2029-06-01",
        newDepartureDate: "2029-06-05"
      }
    }, "stage11-plan-b-concurrent-second");
    const before = new Map([
      [first.orderId, await businessSnapshot(first.orderId)],
      [second.orderId, await businessSnapshot(second.orderId)]
    ]);
    const secondConnection = createDatabase(databaseUrl);
    try {
      const [firstReceipt, secondReceipt] = await Promise.all([
        confirm(firstPreview, "stage11-plan-b-concurrent-first"),
        confirmCommandPreview(secondConnection, principal, secondPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "RESCHEDULE_STAY",
          confirmation: true,
          expectedEffectHash: secondPreview.preview.effectHash,
          reason: { code: "AUTOMATED_STAGE11", note: "4.4 多房源并发验收" }
        }, metadata("stage11-plan-b-concurrent-second-confirm"))
      ]);
      const outcomes = [
        { orderId: first.orderId, receipt: firstReceipt },
        { orderId: second.orderId, receipt: secondReceipt }
      ];
      expect(outcomes.filter((item) => item.receipt.businessCommitted)).toHaveLength(1);
      const loser = outcomes.find((item) => !item.receipt.businessCommitted)!;
      expect(loser.receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        error: { code: "PREVIEW_STALE", details: { causeCode: "INVENTORY_CONFLICT" } }
      });
      expect(await businessSnapshot(loser.orderId)).toEqual(before.get(loser.orderId));
    } finally {
      await secondConnection.destroy();
    }
  });

  it("rejects a PostgreSQL-tampered Plan B timeline and rolls back every business fact", async () => {
    const created = await createFreeOrder({
      prefix: "stage11-plan-b-tampered",
      arrivalDate: "2029-07-01",
      departureDate: "2029-07-05",
      unitId: demo.roomId
    });
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: "2029-07-03"
      }
    }, "stage11-plan-b-tampered-move");
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2029-07-02",
        newDepartureDate: "2029-07-06"
      }
    }, "stage11-plan-b-tampered");
    const before = await atomicBusinessSnapshot(created.orderId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_tamper_stage11_plan_b() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'RESCHEDULE_STAY' THEN
          NEW.payload := jsonb_set(
            NEW.payload,
            '{after,stayTimeline,0,inventoryUnitId}',
            to_jsonb('unit_room_d_gen_02'::text),
            false
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_tamper_stage11_plan_b
        BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage11_plan_b()
    `).execute(db);
    try {
      const receipt = await confirm(prepared, "stage11-plan-b-tampered");
      expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage11_plan_b ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_tamper_stage11_plan_b()
      `).execute(db);
    }
  });

  it("extends an in-house stay on its planned departure day and after the planned departure date", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const requestedDepartureDate = shiftDate(businessDate, 1);
    const departureDay = await createPaidOrder({
      prefix: "stage9-departure-day",
      arrivalDate: shiftDate(businessDate, -1),
      departureDate: businessDate,
      unitId: demo.roomId,
      channel: "WECOM",
      pricingPolicyVersionId: testPricingPolicyForDates(shiftDate(businessDate, -1), requestedDepartureDate)
    });
    await markHistoricalOrderInHouse(departureDay.orderId, shiftDate(businessDate, -1));
    const departureDayPreview = await preview({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: departureDay.orderId,
        newDepartureDate: requestedDepartureDate
      }
    }, "stage9-departure-day");
    const departureDayReceipt = await confirm(departureDayPreview, "stage9-departure-day");
    expect(departureDayReceipt).toMatchObject({
      businessCommitted: true,
      result: {
        before: { departureDate: businessDate, nights: 1 },
        after: { departureDate: shiftDate(businessDate, 1), nights: 2 },
        inventoryChange: { addedDates: [businessDate] }
      }
    });

    const overdue = await createPaidOrder({
      prefix: "stage9-overdue",
      arrivalDate: shiftDate(businessDate, -3),
      departureDate: shiftDate(businessDate, -1),
      unitId: demo.secondRoomId,
      channel: "WECOM",
      pricingPolicyVersionId: testPricingPolicyForDates(shiftDate(businessDate, -3), requestedDepartureDate)
    });
    await markHistoricalOrderInHouse(overdue.orderId, shiftDate(businessDate, -3));
    const overduePreview = await preview({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: overdue.orderId,
        newDepartureDate: requestedDepartureDate
      }
    }, "stage9-overdue");
    const overdueReceipt = await confirm(overduePreview, "stage9-overdue");
    expect(overdueReceipt).toMatchObject({
      businessCommitted: true,
      result: {
        before: { departureDate: shiftDate(businessDate, -1), nights: 2 },
        after: { departureDate: shiftDate(businessDate, 1), nights: 4 }
      }
    });
  });

  it("revalidates a continuation after the property business date advances", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const previewBusinessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(previewBusinessDate, -2);
    const requestedDepartureDate = shiftDate(previewBusinessDate, 2);
    const created = await createPaidOrder({
      prefix: "stage11-extend-business-date-crossing",
      arrivalDate,
      departureDate: previewBusinessDate,
      unitId: demo.roomId,
      channel: "WECOM",
      pricingPolicyVersionId: testPricingPolicyForDates(arrivalDate, requestedDepartureDate)
    });
    await markHistoricalOrderInHouse(created.orderId, arrivalDate);
    const prepared = await preview({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: requestedDepartureDate
      }
    }, "stage11-extend-business-date-crossing");
    const before = await atomicBusinessSnapshot(created.orderId);

    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    expect(await propertyLocalToday(db, demo.propertyId)).toBe(shiftDate(previewBusinessDate, 1));
    const staleReceipt = await confirm(prepared, "stage11-extend-business-date-crossing");
    expect(staleReceipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" }
    });
    expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);

    const rebuilt = await preview({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: requestedDepartureDate
      }
    }, "stage11-extend-business-date-current");
    const receipt = await confirm(rebuilt, "stage11-extend-business-date-current");
    expect(receipt).toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED",
      result: {
        departureDate: requestedDepartureDate,
        before: { stayTimeline: expect.any(Array) },
        after: { stayTimeline: expect.any(Array) }
      }
    });
  });

  it("rebuilds external-channel and WECOM pricing without inheriting the old target", async () => {
    const external = await createPaidOrder({
      prefix: "stage9-channel",
      arrivalDate: "2028-08-01",
      departureDate: "2028-08-03",
      channel: "CTRIP"
    });
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: external.orderId,
        newArrivalDate: "2028-08-02",
        newDepartureDate: "2028-08-04"
      }
    }, "stage9-channel-missing-target")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: external.orderId,
        newArrivalDate: "2028-08-02",
        newDepartureDate: "2028-08-04",
        targetCurrentContractAmountMinor: 10_000
      }
    }, "stage9-channel-missing-reason")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const externalPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: external.orderId,
        newArrivalDate: "2028-08-02",
        newDepartureDate: "2028-08-04",
        targetCurrentContractAmountMinor: 10_000,
        channelPriceDifferenceReason: "渠道活动重新确认"
      }
    }, "stage9-channel-reprice");
    expect(externalPreview.preview.effect).toMatchObject({
      pricingDecision: {
        pricingBasis: "CHANNEL_CONTRACT",
        targetCurrentContractAmount: { minorUnits: 10_000 },
        differenceExceedsThreshold: true,
        reason: { code: "RESCHEDULE_STAY_CHANNEL_CONTRACT", note: "渠道活动重新确认" }
      }
    });

    const wecom = await createPaidOrder({
      prefix: "stage9-wecom",
      arrivalDate: "2028-08-10",
      departureDate: "2028-08-12",
      channel: "WECOM",
      targetDeltaMinor: -100
    });
    const wecomPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: wecom.orderId,
        newArrivalDate: "2028-08-11",
        newDepartureDate: "2028-08-13"
      }
    }, "stage9-wecom-policy-reset");
    expect(wecomPreview.preview.effect).toMatchObject({
      pricingDecision: {
        pricingBasis: "POLICY",
        differenceFromPolicy: { minorUnits: 0 },
        manualAdjustmentMinor: 0,
        reason: { code: "RESCHEDULE_STAY_POLICY", note: "" }
      }
    });
  });

  it("enforces Migration 026 pricing ownership, state, and basis guards on direct writes", async () => {
    const external = await createPaidOrder({
      prefix: "stage9-direct-external",
      arrivalDate: "2028-08-14",
      departureDate: "2028-08-16",
      channel: "CTRIP"
    });
    const wecom = await createPaidOrder({
      prefix: "stage9-direct-wecom",
      arrivalDate: "2028-08-18",
      departureDate: "2028-08-20",
      channel: "WECOM"
    });
    const otherWecom = await createPaidOrder({
      prefix: "stage9-direct-other",
      arrivalDate: "2028-08-22",
      departureDate: "2028-08-24",
      channel: "WECOM"
    });

    await expectDirectStage9RevisionRejected({
      orderId: external.orderId,
      amendmentType: "RESCHEDULE_STAY",
      pricingBasis: null,
      manualAdjustmentMinor: 0,
      expectedConstraint: "pricing_revisions_stage9_channel_basis"
    });
    await expectDirectStage9RevisionRejected({
      orderId: wecom.orderId,
      amendmentType: "RESCHEDULE_STAY",
      pricingBasis: "POLICY",
      manualAdjustmentMinor: 100,
      expectedConstraint: "pricing_revisions_stage9_wecom_basis"
    });
    await expectDirectStage9RevisionRejected({
      orderId: wecom.orderId,
      amendmentType: "RESCHEDULE_STAY",
      pricingBasis: "MANUAL_ADJUSTMENT",
      manualAdjustmentMinor: 0,
      expectedConstraint: "pricing_revisions_stage9_wecom_basis"
    });
    await expectDirectStage9RevisionRejected({
      orderId: wecom.orderId,
      amendmentOrderId: otherWecom.orderId,
      amendmentType: "RESCHEDULE_STAY",
      pricingBasis: "POLICY",
      manualAdjustmentMinor: 0,
      expectedConstraint: "pricing_revisions_stage9_amendment_order"
    });
    await expectDirectStage9RevisionRejected({
      orderId: wecom.orderId,
      amendmentType: "EXTEND_STAY",
      pricingBasis: "POLICY",
      manualAdjustmentMinor: 0,
      expectedConstraint: "pricing_revisions_stage9_order_status"
    });

    await markHistoricalOrderInHouse(wecom.orderId, "2028-08-18");
    await expectDirectStage9RevisionRejected({
      orderId: wecom.orderId,
      amendmentType: "RESCHEDULE_STAY",
      pricingBasis: "POLICY",
      manualAdjustmentMinor: 0,
      expectedConstraint: "pricing_revisions_stage9_order_status"
    });
  });

  it("keeps recorded collections immutable and reports positive, zero, and negative collection differences", async () => {
    const cases = [
      { label: "positive", collectionOffsetMinor: -100, expectedDifferenceMinor: 100, arrivalDate: "2028-08-20" },
      { label: "zero", collectionOffsetMinor: 0, expectedDifferenceMinor: 0, arrivalDate: "2028-08-24" },
      { label: "negative", collectionOffsetMinor: 100, expectedDifferenceMinor: -100, arrivalDate: "2028-08-28" }
    ] as const;
    for (const item of cases) {
      const departureDate = shiftDate(item.arrivalDate, 2);
      const newArrivalDate = shiftDate(item.arrivalDate, 1);
      const newDepartureDate = shiftDate(departureDate, 1);
      const created = await createPaidOrder({
        prefix: `stage9-funds-${item.label}`,
        arrivalDate: item.arrivalDate,
        departureDate,
        channel: "WECOM"
      });
      const draft = await preview({
        commandType: "RESCHEDULE_STAY",
        input: { propertyId: demo.propertyId, orderId: created.orderId, newArrivalDate, newDepartureDate }
      }, `stage9-funds-${item.label}-draft`);
      const after = (draft.preview.effect.after as { pricing: { currentContractAmount: { minorUnits: number } } });
      const targetMinor = after.pricing.currentContractAmount.minorUnits;
      await execute({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: created.orderId,
          amountMinor: targetMinor + item.collectionOffsetMinor,
          method: "WECOM",
          transactionReference: `WX-STAGE9-FUNDS-${item.label}`,
          note: "4.2 资金差额三态回归"
        }
      }, `stage9-funds-${item.label}-collection`);
      const factsBefore = (await getOrderView(db, created.orderId)).collectionFacts;
      const prepared = await preview({
        commandType: "RESCHEDULE_STAY",
        input: { propertyId: demo.propertyId, orderId: created.orderId, newArrivalDate, newDepartureDate }
      }, `stage9-funds-${item.label}`);
      expect(prepared.preview.effect).toMatchObject({
        fundsSummary: {
          netRecordedCollection: { minorUnits: targetMinor + item.collectionOffsetMinor },
          collectionDifference: { minorUnits: item.expectedDifferenceMinor }
        }
      });
      await confirm(prepared, `stage9-funds-${item.label}`);
      expect((await getOrderView(db, created.orderId)).collectionFacts).toEqual(factsBefore);
    }
  });

  it("moves HELD membership coverage A-to-B-to-A and consumes only newly extended coverage", async () => {
    const reservedQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: "2028-09-01",
      departureDate: "2028-09-03",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberId: demo.memberId
    });
    const reserved = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: reservedQuote.quoteId,
        primaryGuest: { fullName: "会员改期", nickname: "会员改期" }
      }
    }, "stage9-member-reserved");
    const reservedOrderId = reserved.result!.orderId as string;
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: reservedOrderId,
        newInventoryUnitId: "unit_room_d_gen_02",
        effectiveDate: "2028-09-02"
      }
    }, "stage11-member-reserved-move");
    for (const [arrivalDate, departureDate, prefix] of [
      ["2028-09-05", "2028-09-07", "to-b"],
      ["2028-09-01", "2028-09-03", "back-a"]
    ] as const) {
      await execute({
        commandType: "RESCHEDULE_STAY",
        input: { propertyId: demo.propertyId, orderId: reservedOrderId, newArrivalDate: arrivalDate, newDepartureDate: departureDate }
      }, `stage9-member-${prefix}`);
    }
    const allCoverage = await db.selectFrom("coverage_items")
      .selectAll().where("order_id", "=", reservedOrderId).orderBy("created_at").orderBy("id").execute();
    expect(allCoverage).toHaveLength(7);
    expect(allCoverage.filter((item) => item.status === "HELD")
      .map((item) => ({ serviceDate: item.service_date, inventoryUnitId: item.inventory_unit_id }))
      .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate)))
      .toEqual([
        { serviceDate: "2028-09-01", inventoryUnitId: "unit_room_d_gen_01" },
        { serviceDate: "2028-09-02", inventoryUnitId: "unit_room_d_gen_02" }
      ]);
    expect(allCoverage.filter((item) => item.status === "RELEASED")).toHaveLength(5);
    const balance = await db.selectFrom("entitlement_lots")
      .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
      .select(sql<string>`cast(entitlement_lots.total_units + coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("available"))
      .where("entitlement_lots.id", "=", demo.roomLotId)
      .groupBy("entitlement_lots.total_units")
      .executeTakeFirstOrThrow();
    expect(balance.available).toBe("0");

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const inHouseQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate: shiftDate(businessDate, 1),
      pricingPolicyVersionId: testPricingPolicyForDates(businessDate, shiftDate(businessDate, 2)),
      memberId: demo.memberId
    });
    const inHouse = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: inHouseQuote.quoteId,
        primaryGuest: { fullName: "会员续住", nickname: "会员续住" }
      }
    }, "stage9-member-in-house");
    const inHouseOrderId = inHouse.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: inHouseOrderId } }, "stage9-member-check-in");
    const existing = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", inHouseOrderId).executeTakeFirstOrThrow();
    expect(existing.status).toBe("CONSUMED");
    const extension = await execute({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId: inHouseOrderId, newDepartureDate: shiftDate(businessDate, 2) }
    }, "stage9-member-extend");
    expect(extension.businessCommitted).toBe(true);
    const consumed = await db.selectFrom("coverage_items")
      .selectAll().where("order_id", "=", inHouseOrderId).orderBy("service_date").execute();
    expect(consumed).toHaveLength(2);
    expect(consumed).toEqual([
      expect.objectContaining({ id: existing.id, service_date: businessDate, status: "CONSUMED" }),
      expect.objectContaining({ service_date: shiftDate(businessDate, 1), status: "CONSUMED" })
    ]);
    const consumeFacts = await db.selectFrom("entitlement_ledger")
      .select(["service_date", "entry_type"])
      .where("order_id", "=", inHouseOrderId)
      .where("entry_type", "=", "CONSUME")
      .orderBy("service_date")
      .execute();
    expect(consumeFacts).toEqual([
      { service_date: businessDate, entry_type: "CONSUME" },
      { service_date: shiftDate(businessDate, 1), entry_type: "CONSUME" }
    ]);
    const consumeReasons = await db.selectFrom("entitlement_ledger")
      .select(["service_date", "reason"])
      .where("order_id", "=", inHouseOrderId)
      .where("entry_type", "=", "CONSUME")
      .orderBy("service_date")
      .execute();
    expect(consumeReasons).toEqual([
      { service_date: businessDate, reason: "CHECK_IN_ENTITLEMENT_CONSUMED" },
      { service_date: shiftDate(businessDate, 1), reason: "EXTEND_STAY_ENTITLEMENT_CONSUMED" }
    ]);
  });

  it("preserves consumed coverage and prices added nights as cash after the member contract expires", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const quoted = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate: shiftDate(businessDate, 1),
      pricingPolicyVersionId: testPricingPolicyForDates(businessDate, shiftDate(businessDate, 2)),
      memberId: demo.memberId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quoted.quoteId,
        primaryGuest: { fullName: "失效后现金续住", nickname: "失效后现金续住" }
      }
    }, "stage9-expired-member-create");
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "stage9-expired-member-check-in");

    const consumedBefore = await db.selectFrom("coverage_items")
      .selectAll()
      .where("order_id", "=", orderId)
      .executeTakeFirstOrThrow();
    expect(consumedBefore).toMatchObject({ service_date: businessDate, status: "CONSUMED" });
    await db.updateTable("member_contracts")
      .set({ status: "EXPIRED", version: sql`version + 1` })
      .where("id", "=", consumedBefore.contract_id)
      .executeTakeFirstOrThrow();

    const prepared = await preview({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: shiftDate(businessDate, 2) }
    }, "stage9-expired-member-extend");
    expect(prepared.preview.effect).toMatchObject({
      after: {
        pricing: {
          coverageSet: [expect.objectContaining({ serviceDate: businessDate })],
          cashRemainder: { currency: "CNY", minorUnits: expect.any(Number) }
        }
      },
      entitlementChange: {
        addedCoverageDates: [],
        consumedCoverageDates: []
      }
    });
    const effect = prepared.preview.effect as { after: { pricing: { cashRemainder: { minorUnits: number } } } };
    expect(effect.after.pricing.cashRemainder.minorUnits).toBeGreaterThan(0);
    await confirm(prepared, "stage9-expired-member-extend");

    const [coverageAfter, consumeFacts, latestRevision] = await Promise.all([
      db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute(),
      db.selectFrom("entitlement_ledger").select(["service_date", "entry_type"])
        .where("order_id", "=", orderId).where("entry_type", "=", "CONSUME").orderBy("service_date").execute(),
      db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no", "desc").executeTakeFirstOrThrow()
    ]);
    expect(coverageAfter).toEqual([expect.objectContaining({ id: consumedBefore.id, service_date: businessDate, status: "CONSUMED" })]);
    expect(consumeFacts).toEqual([{ service_date: businessDate, entry_type: "CONSUME" }]);
    expect(latestRevision.current_contract_amount_minor).toBeGreaterThan(0);
  });

  it("allocates non-overlapping membership contracts by date and still rejects ambiguous same-day Lots", async () => {
    const memberId = "member_stage9_cross_contract";
    await createMemberProfile(memberId);
    await addSharedSingleEntitlement({
      prefix: "stage9_cross_contract_initial",
      memberId,
      validFrom: "2028-11-01",
      validUntil: "2028-11-01"
    });
    const initialQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: "2028-12-10",
      departureDate: "2028-12-12",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: initialQuote.quoteId,
        primaryGuest: { fullName: "跨合同会员", nickname: "跨合同会员" }
      }
    }, "stage9-cross-contract-create");
    const orderId = created.result!.orderId as string;
    const first = await addSharedSingleEntitlement({
      prefix: "stage9_cross_contract_first",
      memberId,
      validFrom: "2028-12-01",
      validUntil: "2028-12-01"
    });
    const second = await addSharedSingleEntitlement({
      prefix: "stage9_cross_contract_second",
      memberId,
      validFrom: "2028-12-02",
      validUntil: "2028-12-02"
    });

    const rescheduled = await execute({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-12-01",
        newDepartureDate: "2028-12-03"
      }
    }, "stage9-cross-contract-reschedule");
    expect(rescheduled).toMatchObject({ businessCommitted: true });
    const coverage = await db.selectFrom("coverage_items")
      .select(["contract_id", "lot_id", "service_date", "status"])
      .where("order_id", "=", orderId)
      .where("status", "=", "HELD")
      .orderBy("service_date")
      .execute();
    expect(coverage).toEqual([
      { contract_id: first.contractId, lot_id: first.lotId, service_date: "2028-12-01", status: "HELD" },
      { contract_id: second.contractId, lot_id: second.lotId, service_date: "2028-12-02", status: "HELD" }
    ]);

    await addSharedSingleEntitlement({
      prefix: "stage9_ambiguous_first",
      memberId,
      validFrom: "2028-12-05",
      validUntil: "2028-12-05"
    });
    await addSharedSingleEntitlement({
      prefix: "stage9_ambiguous_second",
      memberId,
      validFrom: "2028-12-05",
      validUntil: "2028-12-05"
    });
    const beforeAmbiguous = await businessSnapshot(orderId);
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-12-05",
        newDepartureDate: "2028-12-06"
      }
    }, "stage9-ambiguous-reschedule")).rejects.toMatchObject({
      code: "ENTITLEMENT_CONFLICT",
      message: expect.stringContaining("多份权益")
    });
    expect(await businessSnapshot(orderId)).toEqual(beforeAmbiguous);
  });

  it("fails closed when reserved coverage is already consumed or an in-house order still has old HELD coverage", async () => {
    const reservedQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: "2028-09-10",
      departureDate: "2028-09-12",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberId: demo.memberId
    });
    const reserved = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: reservedQuote.quoteId,
        primaryGuest: { fullName: "异常已核销预订", nickname: "异常已核销预订" }
      }
    }, "stage9-reserved-consumed-create");
    const reservedOrderId = reserved.result!.orderId as string;
    const reservedCoverage = await db.selectFrom("coverage_items").selectAll()
      .where("order_id", "=", reservedOrderId).orderBy("service_date").executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("coverage_items").set({ status: "CONSUMED", updated_at: new Date() })
        .where("id", "=", reservedCoverage.id).executeTakeFirstOrThrow();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: newId("fact"),
        lot_id: reservedCoverage.lot_id,
        entry_type: "CONSUME",
        quantity_delta: 0,
        service_date: reservedCoverage.service_date,
        order_id: reservedOrderId,
        coverage_id: reservedCoverage.id,
        reason: "STAGE9_CORRUPTION_TEST",
        command_id: null
      }).execute();
    });
    const reservedBefore = await businessSnapshot(reservedOrderId);
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: reservedOrderId,
        newArrivalDate: "2028-09-11",
        newDepartureDate: "2028-09-13"
      }
    }, "stage9-reserved-consumed-rejected")).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(await businessSnapshot(reservedOrderId)).toEqual(reservedBefore);

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const inHouseQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate: shiftDate(businessDate, 1),
      pricingPolicyVersionId: testPricingPolicyForDates(businessDate, shiftDate(businessDate, 2)),
      memberId: demo.memberId
    });
    const inHouse = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: inHouseQuote.quoteId,
        primaryGuest: { fullName: "异常冻结在住", nickname: "异常冻结在住" }
      }
    }, "stage9-in-house-held-create");
    const inHouseOrderId = inHouse.result!.orderId as string;
    await markHistoricalOrderInHouse(inHouseOrderId, businessDate);
    const inHouseBefore = await businessSnapshot(inHouseOrderId);
    await expect(preview({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId: inHouseOrderId, newDepartureDate: shiftDate(businessDate, 2) }
    }, "stage9-in-house-held-rejected")).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
    expect(await businessSnapshot(inHouseOrderId)).toEqual(inHouseBefore);
  });

  it("serializes rescheduling with a concurrently activated membership entitlement", async () => {
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: "2028-11-01",
      departureDate: "2028-11-03",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberId: demo.memberId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "并发会员改期", nickname: "并发会员改期" }
      }
    }, "stage9-concurrent-member-create");
    const orderId = created.result!.orderId as string;
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-11-05",
        newDepartureDate: "2028-11-07"
      }
    }, "stage9-concurrent-member-reschedule");
    const before = await businessSnapshot(orderId);

    let signalInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { signalInserted = resolve; });
    let allowCommit!: () => void;
    const commitAllowed = new Promise<void>((resolve) => { allowCommit = resolve; });
    const activation = db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`qintopia:member-entitlements:${demo.memberId}`}, 0::bigint))`.execute(trx);
      await trx.insertInto("member_contracts").values({
        id: "contract_stage9_concurrent_activation",
        property_id: demo.propertyId,
        member_id: demo.memberId,
        member_name: "Demo Member",
        status: "ACTIVE",
        valid_from: "2028-01-01",
        valid_until: "2029-12-31",
        version: 1
      }).execute();
      await trx.insertInto("entitlement_lots").values({
        id: "lot_stage9_concurrent_activation",
        contract_id: "contract_stage9_concurrent_activation",
        unit_kind: "ROOM_NIGHT",
        total_units: 2,
        expires_on: "2029-12-31",
        version: 1
      }).execute();
      await trx.insertInto("membership_orders").values({
        id: "membership_order_stage9_concurrent_activation",
        property_id: demo.propertyId,
        member_id: demo.memberId,
        product_id: "membership_product_shared_bath_single_v1",
        product_code: "SHARED_BATH_SINGLE_30",
        product_version: 1,
        product_name: "公卫单人间会员",
        listed_price_minor: 162_000,
        agreed_price_minor: 162_000,
        price_adjustment_minor: 0,
        price_adjustment_reason: null,
        currency: "CNY",
        entitlement_unit_kind: "ROOM_NIGHT",
        entitlement_units: 2,
        allowed_room_type_code: "shared_bath_single",
        allowed_inventory_kind: "ROOM",
        status: "ACTIVE",
        activated_at: new Date("2028-10-01T00:00:00.000Z"),
        valid_from: "2028-01-01",
        valid_until: "2029-12-31",
        contract_id: "contract_stage9_concurrent_activation",
        entitlement_lot_id: "lot_stage9_concurrent_activation",
        version: 1,
        created_by_command_id: "stage9_concurrent_activation",
        activated_by_command_id: "stage9_concurrent_activation"
      }).execute();
      await trx.updateTable("member_contracts")
        .set({ membership_order_id: "membership_order_stage9_concurrent_activation" })
        .where("id", "=", "contract_stage9_concurrent_activation")
        .execute();
      signalInserted();
      await commitAllowed;
    });
    await inserted;

    let confirmationSettled = false;
    const confirmation = confirm(prepared, "stage9-concurrent-member-confirm")
      .finally(() => { confirmationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(confirmationSettled).toBe(false);
    allowCommit();
    await activation;
    const receipt = await confirmation;
    expect(receipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "ENTITLEMENT_CONFLICT" } }
    });
    expect(await businessSnapshot(orderId)).toEqual(before);
  });

  it("rolls back every Stage 9 business write stage under injected PostgreSQL failures", async () => {
    const stages = [
      { label: "segment", table: "stay_segments", operation: "INSERT", condition: "NEW.segment_type IN ('RESCHEDULE_STAY', 'EXTEND_STAY')", member: false },
      { label: "revision", table: "pricing_revisions", operation: "INSERT", condition: "NEW.revision_no > 1", member: false },
      { label: "claim", table: "inventory_claims", operation: "INSERT", condition: "NEW.source_type = 'ORDER_SEGMENT'", member: false },
      { label: "coverage", table: "coverage_items", operation: "INSERT", condition: "TRUE", member: true },
      { label: "ledger", table: "entitlement_ledger", operation: "INSERT", condition: "NEW.order_id IS NOT NULL", member: true },
      { label: "order", table: "orders", operation: "UPDATE", condition: "NEW.version > OLD.version", member: false },
      { label: "receipt", table: "command_receipts", operation: "INSERT", condition: "NEW.execution_status = 'EXECUTED'", member: false }
    ] as const;

    for (const stage of stages) {
      if (stage !== stages[0]) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      let orderId: string;
      if (stage.member) {
        const quote = await createQuote(db, {
          propertyId: demo.propertyId,
          inventoryUnitId: "unit_room_d_gen_01",
          stayType: "TRANSIENT",
          arrivalDate: "2028-05-01",
          departureDate: "2028-05-03",
          pricingPolicyVersionId: demo.transientPolicyId,
          memberId: demo.memberId
        });
        const created = await execute({
          commandType: "CREATE_ORDER",
          input: {
            propertyId: demo.propertyId,
            quoteId: quote.quoteId,
            primaryGuest: { fullName: `故障注入-${stage.label}`, nickname: `故障注入-${stage.label}` }
          }
        }, `stage9-fault-${stage.label}-create`);
        orderId = created.result!.orderId as string;
      } else {
        orderId = (await createPaidOrder({
          prefix: `stage9-fault-${stage.label}`,
          arrivalDate: "2028-05-01",
          departureDate: "2028-05-03",
          channel: "WECOM"
        })).orderId;
      }
      const prepared = await preview({
        commandType: "RESCHEDULE_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId,
          newArrivalDate: "2028-05-05",
          newDepartureDate: "2028-05-07"
        }
      }, `stage9-fault-${stage.label}`);
      const before = await atomicBusinessSnapshot(orderId);
      await sql.raw(`
        CREATE OR REPLACE FUNCTION qintopia_test_reject_stage9_write() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF ${stage.condition} THEN
            RAISE EXCEPTION 'injected stage9 ${stage.label} failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER qintopia_test_reject_stage9_write
        BEFORE ${stage.operation} ON ${stage.table}
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_reject_stage9_write()
      `).execute(db);
      const receipt = await confirm(prepared, `stage9-fault-${stage.label}-confirm`);
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false
      });
      expect(await atomicBusinessSnapshot(orderId)).toEqual(before);
    }
  });

  it("serializes two connections rescheduling into the same room-day without partial loser writes", async () => {
    const first = await createPaidOrder({
      prefix: "stage9-same-room-first",
      arrivalDate: "2028-03-01",
      departureDate: "2028-03-03",
      channel: "WECOM"
    });
    const second = await createPaidOrder({
      prefix: "stage9-same-room-second",
      arrivalDate: "2028-03-05",
      departureDate: "2028-03-07",
      channel: "WECOM"
    });
    const firstPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: first.orderId,
        newArrivalDate: "2028-03-10",
        newDepartureDate: "2028-03-12"
      }
    }, "stage9-same-room-first");
    const secondPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: second.orderId,
        newArrivalDate: "2028-03-10",
        newDepartureDate: "2028-03-12"
      }
    }, "stage9-same-room-second");
    const before = new Map([
      [first.orderId, await businessSnapshot(first.orderId)],
      [second.orderId, await businessSnapshot(second.orderId)]
    ]);
    const secondConnection = createDatabase(databaseUrl);
    try {
      const [firstReceipt, secondReceipt] = await Promise.all([
        confirm(firstPreview, "stage9-same-room-first-confirm"),
        confirmCommandPreview(secondConnection, principal, secondPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "RESCHEDULE_STAY",
          confirmation: true,
          expectedEffectHash: secondPreview.preview.effectHash,
          reason: { code: "AUTOMATED_STAGE9", note: "4.2 同房并发验收" }
        }, metadata("stage9-same-room-second-confirm"))
      ]);
      const outcomes = [
        { orderId: first.orderId, receipt: firstReceipt },
        { orderId: second.orderId, receipt: secondReceipt }
      ];
      expect(outcomes.filter((item) => item.receipt.businessCommitted)).toHaveLength(1);
      const loser = outcomes.find((item) => !item.receipt.businessCommitted)!;
      expect(loser.receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        error: { code: "PREVIEW_STALE", details: { causeCode: "INVENTORY_CONFLICT" } }
      });
      expect(await businessSnapshot(loser.orderId)).toEqual(before.get(loser.orderId));
      const targetClaims = await db.selectFrom("inventory_claims")
        .selectAll()
        .where("room_id", "=", demo.roomId)
        .where("service_date", "in", ["2028-03-10", "2028-03-11"])
        .where("active", "=", true)
        .execute();
      expect(targetClaims).toHaveLength(2);
    } finally {
      await secondConnection.destroy();
    }
  });

  it("serializes whole-room versus child-bed rescheduling without partial loser writes", async () => {
    const wholeRoom = await createFreeOrder({
      prefix: "stage9-room-bed-whole",
      arrivalDate: "2028-04-01",
      departureDate: "2028-04-03",
      unitId: demo.roomId
    });
    const childBed = await createFreeOrder({
      prefix: "stage9-room-bed-child",
      arrivalDate: "2028-04-05",
      departureDate: "2028-04-07",
      unitId: demo.bedAId
    });
    const wholePreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: wholeRoom.orderId,
        newArrivalDate: "2028-04-10",
        newDepartureDate: "2028-04-12"
      }
    }, "stage9-room-bed-whole");
    const childPreview = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: childBed.orderId,
        newArrivalDate: "2028-04-10",
        newDepartureDate: "2028-04-12"
      }
    }, "stage9-room-bed-child");
    const before = new Map([
      [wholeRoom.orderId, await businessSnapshot(wholeRoom.orderId)],
      [childBed.orderId, await businessSnapshot(childBed.orderId)]
    ]);
    const secondConnection = createDatabase(databaseUrl);
    try {
      const [wholeReceipt, childReceipt] = await Promise.all([
        confirm(wholePreview, "stage9-room-bed-whole-confirm"),
        confirmCommandPreview(secondConnection, principal, childPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "RESCHEDULE_STAY",
          confirmation: true,
          expectedEffectHash: childPreview.preview.effectHash,
          reason: { code: "AUTOMATED_STAGE9", note: "4.2 房床并发验收" }
        }, metadata("stage9-room-bed-child-confirm"))
      ]);
      const outcomes = [
        { orderId: wholeRoom.orderId, receipt: wholeReceipt },
        { orderId: childBed.orderId, receipt: childReceipt }
      ];
      expect(outcomes.filter((item) => item.receipt.businessCommitted)).toHaveLength(1);
      const loser = outcomes.find((item) => !item.receipt.businessCommitted)!;
      expect(loser.receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        error: { code: "PREVIEW_STALE", details: { causeCode: "INVENTORY_CONFLICT" } }
      });
      expect(await businessSnapshot(loser.orderId)).toEqual(before.get(loser.orderId));
      const targetClaims = await db.selectFrom("inventory_claims")
        .select(["inventory_unit_id", "service_date", "active"])
        .where("room_id", "=", demo.roomId)
        .where("service_date", "in", ["2028-04-10", "2028-04-11"])
        .where("active", "=", true)
        .orderBy("service_date")
        .execute();
      expect(targetClaims).toHaveLength(2);
      expect(new Set(targetClaims.map((claim) => claim.inventory_unit_id)).size).toBe(1);
    } finally {
      await secondConnection.destroy();
    }
  });

  it("rolls back all business facts when a stale Preview or database guard rejects Confirm", async () => {
    const created = await createPaidOrder({
      prefix: "stage9-rollback",
      arrivalDate: "2028-10-01",
      departureDate: "2028-10-03",
      channel: "WECOM"
    });
    const prepared = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-10-02",
        newDepartureDate: "2028-10-04"
      }
    }, "stage9-stale");
    await execute({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        arrivalDate: "2028-10-03",
        departureDate: "2028-10-04",
        reason: "制造陈旧预检"
      }
    }, "stage9-stale-maintenance");
    const beforeStaleConfirm = await businessSnapshot(created.orderId);
    const staleReceipt = await confirm(prepared, "stage9-stale-confirm");
    expect(staleReceipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "INVENTORY_CONFLICT" } }
    });
    expect(await businessSnapshot(created.orderId)).toEqual(beforeStaleConfirm);

    await execute({
      commandType: "RELEASE_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        maintenanceLockId: (await db.selectFrom("maintenance_locks").select("id").executeTakeFirstOrThrow()).id
      }
    }, "stage9-release-maintenance");
    const afterRelease = await businessSnapshot(created.orderId);
    const reusedStale = await confirm(prepared, "stage9-stale-reuse");
    expect(reusedStale).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "PREVIEW_EXPIRED" } }
    });
    expect(await businessSnapshot(created.orderId)).toEqual(afterRelease);
    const guarded = await preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-10-02",
        newDepartureDate: "2028-10-04"
      }
    }, "stage9-guarded");
    await sql`
      CREATE OR REPLACE FUNCTION qintopia_test_reject_stage9_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.revision_no > 1 THEN RAISE EXCEPTION 'injected stage9 revision failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_reject_stage9_revision
      BEFORE INSERT ON pricing_revisions
      FOR EACH ROW EXECUTE FUNCTION qintopia_test_reject_stage9_revision()
    `.execute(db);
    const beforeGuardedConfirm = await businessSnapshot(created.orderId);
    const guardedReceipt = await confirm(guarded, "stage9-guarded-confirm");
    expect(guardedReceipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
    expect(await businessSnapshot(created.orderId)).toEqual(beforeGuardedConfirm);
  });
});

describe.sequential("4.3 checked-in SHORTEN_STAY", () => {
  it("shortens after at least one fulfilled night, reprices the full stay, and keeps the order in house", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-in-house",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const before = await businessSnapshot(created.orderId);
    const newDepartureDate = shiftDate(businessDate, 1);
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate }
    }, "stage10-in-house");
    expect(prepared.preview.effect).toMatchObject({
      operation: "SHORTEN_STAY",
      completionMode: "SHORTEN_IN_HOUSE",
      after: { departureDate: newDepartureDate },
      inventoryChange: { releasedDates: [newDepartureDate] },
      entitlementSummary: { ledgerWriteCount: 0 },
      refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
    });
    const confirmationMetadata = metadata("stage10-in-house-confirm");
    const receipt = await confirm(prepared, "stage10-in-house", confirmationMetadata);
    expect(receipt.result).toMatchObject({
      completionMode: "SHORTEN_IN_HOUSE",
      checkoutAmendmentId: null,
      departureDate: newDepartureDate,
      fulfillmentTiming: null
    });
    const after = await businessSnapshot(created.orderId);
    expect(after.order).toMatchObject({ status: "CHECKED_IN", departure_date: newDepartureDate, version: before.order.version + 1 });
    expect(after.stay.status).toBe("IN_HOUSE");
    expect(after.amendments.at(-1)).toMatchObject({ amendment_type: "SHORTEN_STAY" });
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.facts).toEqual(before.facts);
    expect(after.claims.filter((claim: { active: boolean }) => claim.active).map((claim: { service_date: string }) => claim.service_date))
      .toEqual([shiftDate(businessDate, -2), shiftDate(businessDate, -1), businessDate]);
    expect((await getOrderView(db, created.orderId)).arrangementHistory.at(-1)?.type).toBe("SHORTENING");
    const committedSnapshot = await businessSnapshot(created.orderId);
    const replay = await confirm(prepared, "stage10-in-house-replay", confirmationMetadata);
    expect(replay.receiptId).toBe(receipt.receiptId);
    expect(await businessSnapshot(created.orderId)).toEqual(committedSnapshot);
  });

  it("atomically early-checks out with two amendments, closes every active Claim, and exposes a server refund reference", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-early-checkout",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        amountMinor: created.priced.currentContractAmount.minorUnits,
        method: "WECOM",
        transactionReference: "STAGE10-EARLY-COLLECTION"
      }
    }, "stage10-early-collection");
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const before = await businessSnapshot(created.orderId);
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: businessDate }
    }, "stage10-early-checkout");
    expect(prepared.preview.effect).toMatchObject({
      completionMode: "EARLY_CHECK_OUT",
      after: { departureDate: businessDate },
      refundReferenceAmount: { currency: "CNY", minorUnits: expect.any(Number) }
    });
    expect((prepared.preview.effect.refundReferenceAmount as { minorUnits: number }).minorUnits).toBeGreaterThan(0);
    const receipt = await confirm(prepared, "stage10-early-checkout");
    expect(receipt.result).toMatchObject({
      completionMode: "EARLY_CHECK_OUT",
      checkoutAmendmentId: expect.any(String),
      departureDate: businessDate,
      fulfillmentTiming: {
        effectiveDate: businessDate,
        recordedBusinessDate: businessDate,
        recordingMode: "ON_SCHEDULE"
      }
    });
    const after = await businessSnapshot(created.orderId);
    expect(after.order).toMatchObject({ status: "CHECKED_OUT", departure_date: businessDate, version: before.order.version + 2 });
    expect(after.stay.status).toBe("COMPLETED");
    expect(after.amendments.slice(-2).map((item: { amendment_type: string }) => item.amendment_type))
      .toEqual(["SHORTEN_STAY", "CHECK_OUT"]);
    expect(after.amendments.at(-2).command_id).toBe(after.amendments.at(-1).command_id);
    expect(after.amendments.at(-2).reason_note).toBe(after.amendments.at(-1).reason_note);
    const amendmentTimes = after.amendments.map((item: { created_at: string | Date }) => new Date(item.created_at).getTime());
    expect(amendmentTimes.every((value: number, index: number) => index === 0 || value >= amendmentTimes[index - 1]!)).toBe(true);
    expect(amendmentTimes.at(-2)).toBe(amendmentTimes.at(-1));
    expect(after.claims.every((claim: { active: boolean }) => !claim.active)).toBe(true);
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.facts).toEqual(before.facts);
    const view = await getOrderView(db, created.orderId);
    expect(view.fulfillment.state).toBe("CHECKED_OUT");
    expect(view.arrangementHistory.at(-1)).toMatchObject({
      type: "EARLY_CHECK_OUT",
      fundsSummary: { refundReferenceAmount: { currency: "CNY", minorUnits: expect.any(Number) } }
    });
  });

  it("serializes two valid shortening Previews into one consistent version and amendment chain", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-concurrent-previews",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const before = await businessSnapshot(created.orderId);
    const input: CommandEnvelope = {
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(businessDate, 1) }
    };
    const [firstPrepared, secondPrepared] = await Promise.all([
      preview(input, "stage10-concurrent-first"),
      preview(input, "stage10-concurrent-second")
    ]);

    const receipts = await Promise.all([
      confirm(firstPrepared, "stage10-concurrent-first"),
      confirm(secondPrepared, "stage10-concurrent-second")
    ]);
    expect(receipts.filter((receipt) => receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.executionStatus === "NOT_EXECUTED")).toEqual([
      expect.objectContaining({ businessCommitted: false, error: expect.objectContaining({ code: "PREVIEW_STALE" }) })
    ]);

    const after = await businessSnapshot(created.orderId);
    expect(after.order).toMatchObject({
      status: "CHECKED_IN",
      departure_date: shiftDate(businessDate, 1),
      version: before.order.version + 1
    });
    expect(after.amendments.filter((item: { amendment_type: string }) => item.amendment_type === "SHORTEN_STAY")).toHaveLength(1);
    expect(after.segments).toHaveLength(before.segments.length + 1);
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
  });

  it("serializes a concurrent collection before shortening and freezes the rebuilt refund summary", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-concurrent-funds",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const stalePrepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "stage10-concurrent-funds-stale");
    const before = await businessSnapshot(created.orderId);
    const fundingDb = createDatabase(databaseUrl);
    let releaseFunding!: () => void;
    const fundingMayCommit = new Promise<void>((resolve) => { releaseFunding = resolve; });
    let signalFundingLocked!: () => void;
    const fundingLocked = new Promise<void>((resolve) => { signalFundingLocked = resolve; });
    const fundingCommandId = "command_stage10_concurrent_collection";
    const collectionAmountMinor = 50_000;
    const currentRevisionId = before.order.current_revision_id as string;
    const funding = fundingDb.transaction().execute(async (trx) => {
      await trx.selectFrom("orders").select("id").where("id", "=", created.orderId).forUpdate().executeTakeFirstOrThrow();
      await trx.insertInto("command_executions").values({
        id: fundingCommandId,
        subject_id: principal.subjectId,
        credential_id: principal.credentialId,
        property_id: demo.propertyId,
        command_type: "RECORD_COLLECTION",
        idempotency_key: fundingCommandId,
        request_hash: "f".repeat(64),
        correlation_id: fundingCommandId,
        state: "APPLIED",
        completed_at: new Date()
      }).execute();
      await trx.insertInto("collection_facts").values({
        fact_id: "fact_stage10_concurrent_collection",
        order_id: created.orderId,
        fact_type: "COLLECTION",
        amount_minor: collectionAmountMinor,
        net_effect_minor: collectionAmountMinor,
        currency: "CNY",
        references_fact_id: null,
        reverses_fact_id: null,
        method: "WECOM",
        note: "并发收款事实",
        transaction_reference: "STAGE10-CONCURRENT-COLLECTION",
        pricing_revision_id: currentRevisionId,
        command_id: fundingCommandId
      }).execute();
      signalFundingLocked();
      await fundingMayCommit;
    });
    await fundingLocked;

    let shorteningSettled = false;
    const staleConfirmation = confirm(stalePrepared, "stage10-concurrent-funds-stale")
      .finally(() => { shorteningSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shorteningSettled).toBe(false);
    releaseFunding();
    await funding;
    await fundingDb.destroy();
    const staleReceipt = await staleConfirmation;
    expect(staleReceipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" }
    });
    expect((await businessSnapshot(created.orderId)).amendments).toEqual(before.amendments);

    const rebuilt = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "stage10-concurrent-funds-rebuilt");
    expect(rebuilt.preview.effect).toMatchObject({
      fundsSummary: { netRecordedCollection: { currency: "CNY", minorUnits: collectionAmountMinor } }
    });
    await confirm(rebuilt, "stage10-concurrent-funds-rebuilt");
    const after = await businessSnapshot(created.orderId);
    const shortening = after.amendments.find((item: { amendment_type: string }) => item.amendment_type === "SHORTEN_STAY");
    const shorteningPayload = shortening.payload as {
      after: { pricing: { currentContractAmount: { minorUnits: number } } };
    };
    expect(shortening.payload).toMatchObject({
      fundsSummary: { netRecordedCollection: { currency: "CNY", minorUnits: collectionAmountMinor } },
      refundReferenceAmount: {
        currency: "CNY",
        minorUnits: Math.max(0, collectionAmountMinor - shorteningPayload.after.pricing.currentContractAmount.minorUnits)
      }
    });
    expect(after.facts).toHaveLength(before.facts.length + 1);
  });

  it("revalidates the authoritative business date between Preview and Confirm", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const previewBusinessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-business-date-crossing",
      arrivalDate: shiftDate(previewBusinessDate, -2),
      departureDate: shiftDate(previewBusinessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(previewBusinessDate, -2));
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: shiftDate(previewBusinessDate, 1)
      }
    }, "stage10-business-date-crossing");
    expect(prepared.preview.effect).toMatchObject({ completionMode: "SHORTEN_IN_HOUSE" });
    const before = await businessSnapshot(created.orderId);

    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    const confirmBusinessDate = await propertyLocalToday(db, demo.propertyId);
    expect(confirmBusinessDate).toBe(shiftDate(previewBusinessDate, 1));
    const staleReceipt = await confirm(prepared, "stage10-business-date-crossing");
    expect(staleReceipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" }
    });
    expect(await businessSnapshot(created.orderId)).toEqual(before);

    const currentPrepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: confirmBusinessDate }
    }, "stage10-business-date-current");
    expect(currentPrepared.preview.effect).toMatchObject({ completionMode: "EARLY_CHECK_OUT" });
    const receipt = await confirm(currentPrepared, "stage10-business-date-current");
    expect(receipt.result).toMatchObject({ completionMode: "EARLY_CHECK_OUT", departureDate: confirmBusinessDate });
  });

  it.each([
    ["arrival-day", 0, 1, 0, "入住当天"],
    ["retrospective", -2, 2, -1, "不能早于当前营业日期"]
  ])("rejects %s shortening without changing business facts", async (_label, arrivalOffset, departureOffset, newDepartureOffset, message) => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: `stage10-reject-${_label}`,
      arrivalDate: shiftDate(businessDate, arrivalOffset),
      departureDate: shiftDate(businessDate, departureOffset),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, arrivalOffset));
    const before = await atomicBusinessSnapshot(created.orderId);
    await expect(preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: shiftDate(businessDate, newDepartureOffset)
      }
    }, `stage10-reject-${_label}`)).rejects.toThrow(message);
    expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
  });

  it("crops a future move at the new departure boundary", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const future = await createPaidOrder({
      prefix: "stage10-future-move",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(future.orderId, shiftDate(businessDate, -2));
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: future.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: shiftDate(businessDate, 1)
      }
    }, "stage10-future-move");
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: future.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
      }
    }, "stage11-future-move-crop");
    const beforeTimeline = [
      { serviceDate: shiftDate(businessDate, -2), inventoryUnitId: demo.roomId },
      { serviceDate: shiftDate(businessDate, -1), inventoryUnitId: demo.roomId },
      { serviceDate: businessDate, inventoryUnitId: demo.roomId },
      { serviceDate: shiftDate(businessDate, 1), inventoryUnitId: demo.secondRoomId }
    ];
    const afterTimeline = beforeTimeline.slice(0, 3);
    expect(prepared.preview.effect).toMatchObject({
      before: { stayTimeline: beforeTimeline },
      after: {
        departureDate: shiftDate(businessDate, 1),
        stayTimeline: afterTimeline
      },
      inventoryChange: { releasedDates: [shiftDate(businessDate, 1)] }
    });
    const receipt = await confirm(prepared, "stage11-future-move-crop");
    expect(receipt).toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED",
      result: {
        businessDate,
        before: { stayTimeline: beforeTimeline },
        after: { stayTimeline: afterTimeline }
      }
    });
    const view = await getOrderView(db, future.orderId);
    expect(view.effectiveArrangement.intervals).toEqual([
      {
        inventoryUnitId: demo.roomId,
        arrivalDate: shiftDate(businessDate, -2),
        departureDate: shiftDate(businessDate, 1)
      }
    ]);
  });

  it("allows a complete direct shortening that crops a future move at the new departure boundary", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(businessDate, -2);
    const newDepartureDate = shiftDate(businessDate, 1);
    const originalDepartureDate = shiftDate(businessDate, 3);
    const created = await createFreeOrder({
      prefix: "stage10-direct-future-move",
      arrivalDate,
      departureDate: originalDepartureDate,
      unitId: demo.roomId
    });
    await markHistoricalOrderInHouse(created.orderId, arrivalDate);
    await execute({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate: newDepartureDate
      }
    }, "stage10-direct-future-move");

    const order = await db.selectFrom("orders").selectAll().where("id", "=", created.orderId).executeTakeFirstOrThrow();
    const stay = await db.selectFrom("stays").selectAll().where("order_id", "=", created.orderId).executeTakeFirstOrThrow();
    const currentSegment = await db.selectFrom("stay_segments").selectAll()
      .where("stay_id", "=", stay.id).orderBy("sequence", "desc").executeTakeFirstOrThrow();
    const currentRevision = await db.selectFrom("pricing_revisions").selectAll()
      .where("id", "=", order.current_revision_id!).executeTakeFirstOrThrow();
    const segmentIds = (await db.selectFrom("stay_segments").select("id").where("stay_id", "=", stay.id).execute())
      .map((segment) => segment.id);
    const stayTimeline = (await db.selectFrom("inventory_claims").select(["service_date", "inventory_unit_id", "id"])
      .where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", segmentIds)
      .where("active", "=", true)
      .where("service_date", "<", newDepartureDate)
      .orderBy("service_date").orderBy("id").execute())
      .map((claim) => ({ serviceDate: claim.service_date, inventoryUnitId: claim.inventory_unit_id }));
    expect(stayTimeline).toEqual([
      { serviceDate: arrivalDate, inventoryUnitId: demo.roomId },
      { serviceDate: shiftDate(arrivalDate, 1), inventoryUnitId: demo.roomId },
      { serviceDate: businessDate, inventoryUnitId: demo.roomId }
    ]);

    const commandId = "command_stage10_direct_future_move_shorten";
    const amendmentId = "amend_stage10_direct_future_move_shorten";
    const segmentId = "segment_stage10_direct_future_move_shorten";
    const revisionId = "revision_stage10_direct_future_move_shorten";
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: created.orderId,
      stayId: stay.id,
      inventoryUnitId: demo.roomId,
      businessDate,
      completionMode: "SHORTEN_IN_HOUSE",
      before: {
        arrivalDate,
        departureDate: originalDepartureDate,
        nights: 5,
        currentContractAmount: { currency: "CNY", minorUnits: 0 },
        stayTimeline: [
          ...stayTimeline,
          { serviceDate: newDepartureDate, inventoryUnitId: demo.secondRoomId },
          { serviceDate: shiftDate(newDepartureDate, 1), inventoryUnitId: demo.secondRoomId }
        ]
      },
      after: {
        arrivalDate,
        departureDate: newDepartureDate,
        nights: 3,
        stayTimeline,
        pricing: {
          coverageSet: [],
          cashLines: [],
          cashRemainder: { currency: "CNY", minorUnits: 0 },
          currentContractAmount: { currency: "CNY", minorUnits: 0 }
        }
      },
      pricingDecision: {
        pricingBasis: "FREE",
        policyBaseAmount: { currency: "CNY", minorUnits: 0 },
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 0 },
        differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "STAY_CHANGE_FREE", note: "" }
      },
      inventoryChange: {
        preservedDates: stayTimeline.map((item) => item.serviceDate),
        releasedDates: [newDepartureDate, shiftDate(newDepartureDate, 1)],
        addedDates: []
      },
      entitlementSummary: {
        currentConsumedCoverageDates: [],
        retainedHistoricalConsumedCoverageDates: [],
        ledgerWriteCount: 0
      },
      fundsSummary: {
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: 0 },
        factCount: 0
      },
      refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
    };

    const directWrite = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: principal.subjectId,
        credential_id: principal.credentialId,
        property_id: demo.propertyId,
        command_type: "SHORTEN_STAY",
        idempotency_key: commandId,
        request_hash: "m".repeat(64),
        correlation_id: commandId,
        state: "EXECUTING",
        completed_at: null
      }).execute();
      await trx.insertInto("amendments").values({
        id: amendmentId,
        order_id: created.orderId,
        sequence: order.version + 1,
        amendment_type: "SHORTEN_STAY",
        reason_code: "STAGE10_DIRECT_FUTURE_MOVE",
        reason_note: "4.4 数据库组合守卫允许裁掉未来换房",
        prior_version: order.version,
        new_version: order.version + 1,
        payload: effect,
        command_id: commandId
      }).execute();
      await trx.insertInto("stay_segments").values({
        id: segmentId,
        stay_id: stay.id,
        sequence: currentSegment.sequence + 1,
        inventory_unit_id: demo.roomId,
        arrival_date: arrivalDate,
        departure_date: newDepartureDate,
        segment_type: "SHORTEN_STAY",
        supersedes_segment_id: currentSegment.id,
        amendment_id: amendmentId
      }).execute();
      await trx.insertInto("pricing_revisions").values({
        id: revisionId,
        order_id: created.orderId,
        revision_no: currentRevision.revision_no + 1,
        amendment_id: amendmentId,
        policy_version_id: order.pricing_policy_version_id,
        arrival_date: arrivalDate,
        departure_date: newDepartureDate,
        coverage_set: JSON.stringify([]),
        cash_lines: JSON.stringify([]),
        policy_base_amount_minor: 0,
        pricing_basis: "FREE",
        manual_adjustment_minor: 0,
        current_contract_amount_minor: 0,
        currency: "CNY"
      }).execute();
      await releaseInventoryClaimsOnDates(
        trx,
        "ORDER_SEGMENT",
        segmentIds,
        [newDepartureDate, shiftDate(newDepartureDate, 1)]
      );
      await trx.updateTable("orders").set({
        departure_date: newDepartureDate,
        current_revision_id: revisionId,
        version: order.version + 1,
        updated_at: new Date()
      }).where("id", "=", created.orderId).execute();
      await trx.updateTable("command_executions").set({ state: "APPLIED", completed_at: new Date() })
        .where("id", "=", commandId).execute();
    });

    await expect(directWrite).resolves.toBeUndefined();
    const updated = await db.selectFrom("orders")
      .select(["departure_date", "current_revision_id", "version"])
      .where("id", "=", created.orderId)
      .executeTakeFirstOrThrow();
    expect(updated).toEqual({
      departure_date: newDepartureDate,
      current_revision_id: revisionId,
      version: order.version + 1
    });
    expect(await loadActiveStayTimeline(db, await loadOrderContext(db, created.orderId))).toEqual(stayTimeline);
  });

  it("rejects a PostgreSQL-tampered shortening before timeline and rolls back every business fact", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage11-tampered-shorten-before",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
      }
    }, "stage11-tampered-shorten-before");
    const before = await atomicBusinessSnapshot(created.orderId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_tamper_stage11_shorten_before() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'SHORTEN_STAY' THEN
          NEW.payload := jsonb_set(
            NEW.payload,
            '{before,stayTimeline,0,inventoryUnitId}',
            to_jsonb('unit_room_102'::text),
            false
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_tamper_stage11_shorten_before
        BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage11_shorten_before()
    `).execute(db);
    try {
      const receipt = await confirm(prepared, "stage11-tampered-shorten-before");
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "COMMAND_INTERRUPTED" }
      });
      expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage11_shorten_before ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_tamper_stage11_shorten_before()
      `).execute(db);
    }
  });

  it("invalidates a Preview when collection facts change even if their net total returns to the same value", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-funds-hash",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
      }
    }, "stage10-funds-hash");
    const collection = await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        amountMinor: 100,
        method: "WECOM",
        transactionReference: "STAGE10-HASH-COLLECTION",
        note: "构造净额不变的新增资金事实"
      }
    }, "stage10-funds-hash-collection");
    await execute({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        amountMinor: 100,
        referencesFactId: collection.factRefs[0]!,
        method: "WECOM",
        transactionReference: "STAGE10-HASH-REFUND",
        note: "构造净额不变的新增退款事实"
      }
    }, "stage10-funds-hash-refund");
    const beforeConfirm = await businessSnapshot(created.orderId);
    expect(beforeConfirm.facts.reduce((sum: number, fact: { net_effect_minor: number }) => sum + fact.net_effect_minor, 0)).toBe(0);
    const receipt = await confirm(prepared, "stage10-funds-hash-confirm");
    expect(receipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" }
    });
    expect(await businessSnapshot(created.orderId)).toEqual(beforeConfirm);
  });

  it("rebuilds external-channel pricing and keeps free shortening at zero", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const external = await createPaidOrder({
      prefix: "stage10-external-channel",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "CTRIP"
    });
    await markHistoricalOrderInHouse(external.orderId, shiftDate(businessDate, -2));
    await expect(preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: external.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
      }
    }, "stage10-external-missing-target")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const externalPrepared = await preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: external.orderId,
        newDepartureDate: shiftDate(businessDate, 1),
        targetCurrentContractAmountMinor: 10_000,
        channelPriceDifferenceReason: "渠道缩短后重新确认应结金额"
      }
    }, "stage10-external-channel");
    expect(externalPrepared.preview.effect).toMatchObject({
      pricingDecision: {
        pricingBasis: "CHANNEL_CONTRACT",
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 10_000 }
      }
    });
    await confirm(externalPrepared, "stage10-external-channel");
    expect((await getOrderView(db, external.orderId)).pricingRevisions.at(-1)).toMatchObject({
      pricing_basis: "CHANNEL_CONTRACT",
      current_contract_amount_minor: 10_000,
      manual_adjustment_minor: 0
    });

    await db.destroy();
    db = await resetDatabase(databaseUrl);
    const free = await createFreeOrder({
      prefix: "stage10-free",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      unitId: demo.roomId
    });
    await markHistoricalOrderInHouse(free.orderId, shiftDate(businessDate, -2));
    const freeReceipt = await execute({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: free.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
      }
    }, "stage10-free-shorten");
    expect(freeReceipt).toMatchObject({
      businessCommitted: true,
      result: {
        completionMode: "SHORTEN_IN_HOUSE",
        pricingDecision: {
          pricingBasis: "FREE",
          targetCurrentContractAmount: { currency: "CNY", minorUnits: 0 }
        }
      }
    });
    expect((await getOrderView(db, free.orderId)).pricingRevisions.at(-1)).toMatchObject({
      pricing_basis: "FREE",
      policy_base_amount_minor: 0,
      current_contract_amount_minor: 0,
      manual_adjustment_minor: 0
    });
  });

  it("reports all three collection states without appending any money fact", async () => {
    const cases = [
      { label: "refund", collectionOffsetMinor: 100, expectedDifferenceMinor: -100, expectedRefundMinor: 100 },
      { label: "balanced", collectionOffsetMinor: 0, expectedDifferenceMinor: 0, expectedRefundMinor: 0 },
      { label: "supplement", collectionOffsetMinor: -100, expectedDifferenceMinor: 100, expectedRefundMinor: 0 }
    ] as const;

    for (const [index, item] of cases.entries()) {
      if (index > 0) {
        await db.destroy();
        db = await resetDatabase(databaseUrl);
      }
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const created = await createPaidOrder({
        prefix: `stage10-funds-${item.label}`,
        arrivalDate: shiftDate(businessDate, -2),
        departureDate: shiftDate(businessDate, 2),
        channel: "WECOM"
      });
      await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
      const draft = await preview({
        commandType: "SHORTEN_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: created.orderId,
          newDepartureDate: shiftDate(businessDate, 1)
        }
      }, `stage10-funds-${item.label}-draft`);
      const newContractAmount = (draft.preview.effect.after as {
        pricing: { currentContractAmount: { minorUnits: number } };
      }).pricing.currentContractAmount.minorUnits;
      await execute({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: created.orderId,
          amountMinor: newContractAmount + item.collectionOffsetMinor,
          method: "WECOM",
          transactionReference: `STAGE10-FUNDS-${item.label.toUpperCase()}`,
          note: "4.3 资金差额三态"
        }
      }, `stage10-funds-${item.label}-collection`);
      const factsBefore = await db.selectFrom("collection_facts").selectAll()
        .where("order_id", "=", created.orderId).orderBy("created_at").orderBy("fact_id").execute();
      const prepared = await preview({
        commandType: "SHORTEN_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: created.orderId,
          newDepartureDate: shiftDate(businessDate, 1)
        }
      }, `stage10-funds-${item.label}`);
      expect(prepared.preview.effect).toMatchObject({
        fundsSummary: {
          netRecordedCollection: { minorUnits: newContractAmount + item.collectionOffsetMinor },
          collectionDifference: { minorUnits: item.expectedDifferenceMinor }
        },
        refundReferenceAmount: { currency: "CNY", minorUnits: item.expectedRefundMinor }
      });
      await confirm(prepared, `stage10-funds-${item.label}`);
      expect(await db.selectFrom("collection_facts").selectAll()
        .where("order_id", "=", created.orderId).orderBy("created_at").orderBy("fact_id").execute()).toEqual(factsBefore);
    }
  });

  it("keeps consumed member coverage, ledger rows, and membership versions byte-for-byte unchanged", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const businessDateAfterAdvance = shiftDate(arrivalDate, 1);
    const departureDate = shiftDate(arrivalDate, 2);
    const memberId = "member_stage10_consumed";
    await createMemberProfile(memberId);
    const entitlement = await addSharedSingleEntitlement({
      prefix: "stage10_consumed",
      memberId,
      validFrom: arrivalDate,
      validUntil: shiftDate(arrivalDate, 365),
      totalUnits: 2
    });
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: testPricingPolicyForDates(arrivalDate, departureDate),
      memberId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "阶段十会员住客", nickname: "阶段十会员住客" }
      }
    }, "stage10-member-create");
    const orderId = created.result!.orderId as string;
    await execute({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, "stage10-member-check-in");
    const beforeCoverage = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute();
    const beforeLedger = await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute();
    const beforeContract = await db.selectFrom("member_contracts").selectAll().where("id", "=", entitlement.contractId).executeTakeFirstOrThrow();
    const beforeLot = await db.selectFrom("entitlement_lots").selectAll().where("id", "=", entitlement.lotId).executeTakeFirstOrThrow();
    expect(beforeCoverage.map((item) => item.status)).toEqual(["CONSUMED", "CONSUMED"]);

    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    expect(await propertyLocalToday(db, demo.propertyId)).toBe(businessDateAfterAdvance);
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: businessDateAfterAdvance }
    }, "stage10-member-early-checkout");
    expect(prepared.preview.effect).toMatchObject({
      completionMode: "EARLY_CHECK_OUT",
      after: {
        pricing: {
          currentContractAmount: { currency: "CNY", minorUnits: 0 }
        }
      },
      pricingDecision: { pricingBasis: "MEMBER_ENTITLEMENT" },
      entitlementSummary: {
        currentConsumedCoverageDates: [arrivalDate],
        retainedHistoricalConsumedCoverageDates: [businessDateAfterAdvance],
        ledgerWriteCount: 0
      }
    });
    await confirm(prepared, "stage10-member-early-checkout");
    const view = await getOrderView(db, orderId);
    expect(view.pricingRevisions.at(-1)).toMatchObject({
      pricing_basis: "MEMBER_ENTITLEMENT",
      current_contract_amount_minor: 0
    });
    expect(await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute()).toEqual(beforeCoverage);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute()).toEqual(beforeLedger);
    expect(await db.selectFrom("member_contracts").selectAll().where("id", "=", entitlement.contractId).executeTakeFirstOrThrow()).toEqual(beforeContract);
    expect(await db.selectFrom("entitlement_lots").selectAll().where("id", "=", entitlement.lotId).executeTakeFirstOrThrow()).toEqual(beforeLot);
  });

  it("keeps historical consumed coverage valid across two consecutive in-house shortenings", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const businessDate = shiftDate(arrivalDate, 1);
    const originalDepartureDate = shiftDate(arrivalDate, 4);
    const memberId = "member_stage10_repeat_shorten";
    await createMemberProfile(memberId);
    const entitlement = await addSharedSingleEntitlement({
      prefix: "stage10_repeat_shorten",
      memberId,
      validFrom: arrivalDate,
      validUntil: shiftDate(arrivalDate, 365),
      totalUnits: 4
    });
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate: originalDepartureDate,
      pricingPolicyVersionId: testPricingPolicyForDates(arrivalDate, originalDepartureDate),
      memberId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "阶段十连续缩短会员", nickname: "连续缩短会员" }
      }
    }, "stage10-repeat-member-create");
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "stage10-repeat-member-check-in");
    const beforeCoverage = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute();
    const beforeLedger = await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute();
    const beforeContract = await db.selectFrom("member_contracts").selectAll().where("id", "=", entitlement.contractId).executeTakeFirstOrThrow();
    const beforeLot = await db.selectFrom("entitlement_lots").selectAll().where("id", "=", entitlement.lotId).executeTakeFirstOrThrow();
    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    expect(await propertyLocalToday(db, demo.propertyId)).toBe(businessDate);

    const firstDepartureDate = shiftDate(businessDate, 2);
    const first = await execute({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: firstDepartureDate }
    }, "stage10-repeat-member-first");
    expect(first.result).toMatchObject({ completionMode: "SHORTEN_IN_HOUSE", departureDate: firstDepartureDate });

    const secondDepartureDate = shiftDate(businessDate, 1);
    const secondPrepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: secondDepartureDate }
    }, "stage10-repeat-member-second");
    expect(secondPrepared.preview.effect).toMatchObject({
      completionMode: "SHORTEN_IN_HOUSE",
      entitlementSummary: {
        currentConsumedCoverageDates: [arrivalDate, businessDate],
        retainedHistoricalConsumedCoverageDates: [secondDepartureDate, firstDepartureDate],
        ledgerWriteCount: 0
      }
    });
    await confirm(secondPrepared, "stage10-repeat-member-second");

    expect((await getOrderView(db, orderId)).order).toMatchObject({ status: "CHECKED_IN", departure_date: secondDepartureDate });
    expect(await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute()).toEqual(beforeCoverage);
    expect(await db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute()).toEqual(beforeLedger);
    expect(await db.selectFrom("member_contracts").selectAll().where("id", "=", entitlement.contractId).executeTakeFirstOrThrow()).toEqual(beforeContract);
    expect(await db.selectFrom("entitlement_lots").selectAll().where("id", "=", entitlement.lotId).executeTakeFirstOrThrow()).toEqual(beforeLot);
  });

  it("fails shortening Preview closed when multiple collections exceed the refund reference contract", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-refund-overflow",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    for (const [index, amountMinor] of [1_500_000_000, 1_000_000_000].entries()) {
      await execute({
        commandType: "RECORD_COLLECTION",
        input: {
          propertyId: demo.propertyId,
          orderId: created.orderId,
          amountMinor,
          method: "WECOM",
          transactionReference: `STAGE10-OVERFLOW-${index + 1}`
        }
      }, `stage10-overflow-collection-${index + 1}`);
    }
    const previewCountBefore = await db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    await expect(preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "stage10-overflow-shorten")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "订单建议退款金额超出支持范围"
    });
    const previewCountAfter = await db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    expect(Number(previewCountAfter.count)).toBe(Number(previewCountBefore.count));
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", created.orderId).execute()).toHaveLength(2);
  });

  it("rolls back every early-checkout business stage under injected PostgreSQL failures", async () => {
    const stages = [
      { label: "segment", table: "stay_segments", operation: "INSERT", condition: "NEW.segment_type = 'SHORTEN_STAY'" },
      { label: "revision", table: "pricing_revisions", operation: "INSERT", condition: "NEW.revision_no > 1" },
      { label: "claim", table: "inventory_claims", operation: "UPDATE", condition: "OLD.active IS TRUE AND NEW.active IS FALSE" },
      { label: "checkout-amendment", table: "amendments", operation: "INSERT", condition: "NEW.amendment_type = 'CHECK_OUT'" },
      { label: "stay", table: "stays", operation: "UPDATE", condition: "OLD.status = 'IN_HOUSE' AND NEW.status = 'COMPLETED'" },
      { label: "order", table: "orders", operation: "UPDATE", condition: "OLD.status = 'CHECKED_IN' AND NEW.status = 'CHECKED_OUT'" },
      { label: "receipt", table: "command_receipts", operation: "INSERT", condition: "NEW.execution_status = 'EXECUTED'" }
    ] as const;

    for (const [index, stage] of stages.entries()) {
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const created = await createPaidOrder({
        prefix: `stage10-fault-${stage.label}`,
        arrivalDate: shiftDate(businessDate, -2),
        departureDate: shiftDate(businessDate, 2),
        unitId: `unit_room_${103 + index}`,
        channel: "WECOM"
      });
      await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
      const prepared = await preview({
        commandType: "SHORTEN_STAY",
        input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: businessDate }
      }, `stage10-fault-${stage.label}`);
      const before = await atomicBusinessSnapshot(created.orderId);
      await sql.raw(`
        CREATE OR REPLACE FUNCTION qintopia_test_reject_stage10_write() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF ${stage.condition} THEN RAISE EXCEPTION 'injected stage10 ${stage.label} failure'; END IF;
          RETURN NEW;
        END $$;
      CREATE TRIGGER qintopia_test_reject_stage10_write
        BEFORE ${stage.operation} ON ${stage.table}
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_reject_stage10_write()
      `).execute(db);
      try {
        const receipt = await confirm(prepared, `stage10-fault-${stage.label}-confirm`);
        expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
        expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
      } finally {
        await sql.raw(`
          DROP TRIGGER IF EXISTS qintopia_test_reject_stage10_write ON ${stage.table};
          DROP FUNCTION IF EXISTS qintopia_test_reject_stage10_write()
        `).execute(db);
      }
    }
  });

  it("rejects a complete shortening write when the segment and Claim timelines point at different units", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-tampered-segment-unit",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "stage10-tampered-segment-unit");
    const before = await atomicBusinessSnapshot(created.orderId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_tamper_stage10_segment_unit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.segment_type = 'SHORTEN_STAY' THEN NEW.inventory_unit_id := 'unit_room_104'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_tamper_stage10_segment_unit
        BEFORE INSERT ON stay_segments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage10_segment_unit()
    `).execute(db);
    try {
      const receipt = await confirm(prepared, "stage10-tampered-segment-unit");
      expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage10_segment_unit ON stay_segments;
        DROP FUNCTION IF EXISTS qintopia_test_tamper_stage10_segment_unit()
      `).execute(db);
    }
  });

  it("binds the frozen shortening funds summary to the recorded collection facts", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-tampered-funds-summary",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId: created.orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "stage10-tampered-funds-summary");
    const before = await atomicBusinessSnapshot(created.orderId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_tamper_stage10_funds_summary() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'SHORTEN_STAY' THEN
          NEW.payload := jsonb_set(NEW.payload, '{fundsSummary,factCount}', '1'::jsonb, false);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_tamper_stage10_funds_summary
        BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage10_funds_summary()
    `).execute(db);
    try {
      const receipt = await confirm(prepared, "stage10-tampered-funds-summary");
      expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage10_funds_summary ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_tamper_stage10_funds_summary()
      `).execute(db);
    }
  });

  it("rejects mutually forged member revision and payload coverage against immutable CONSUMED facts", async () => {
    await db.updateTable("properties").set({ timezone: "Etc/GMT+12" }).where("id", "=", demo.propertyId).execute();
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_stage10_forged_coverage";
    await createMemberProfile(memberId);
    await addSharedSingleEntitlement({
      prefix: "stage10_forged_coverage",
      memberId,
      validFrom: arrivalDate,
      validUntil: shiftDate(arrivalDate, 365),
      totalUnits: 3
    });
    const departureDate = shiftDate(arrivalDate, 3);
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: testPricingPolicyForDates(arrivalDate, departureDate),
      memberId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "阶段十伪造权益", nickname: "伪造权益" }
      }
    }, "stage10-forged-coverage-create");
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "stage10-forged-coverage-check-in");
    await db.updateTable("properties").set({ timezone: "Etc/GMT-12" }).where("id", "=", demo.propertyId).execute();
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const prepared = await preview({
      commandType: "SHORTEN_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "stage10-forged-coverage");
    const before = await atomicBusinessSnapshot(orderId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_tamper_stage10_member_coverage() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF TG_TABLE_NAME = 'amendments' AND NEW.amendment_type = 'SHORTEN_STAY' THEN
          NEW.payload := jsonb_set(
            NEW.payload,
            '{after,pricing,coverageSet,0,inventoryUnitId}',
            to_jsonb('unit_room_104'::text),
            false
          );
        ELSIF TG_TABLE_NAME = 'pricing_revisions' AND NEW.revision_no > 1 THEN
          NEW.coverage_set := jsonb_set(
            NEW.coverage_set,
            '{0,inventoryUnitId}',
            to_jsonb('unit_room_104'::text),
            false
          );
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_tamper_stage10_member_amendment
        BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage10_member_coverage();
      CREATE TRIGGER qintopia_test_tamper_stage10_member_revision
        BEFORE INSERT ON pricing_revisions
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage10_member_coverage()
    `).execute(db);
    try {
      const receipt = await confirm(prepared, "stage10-forged-coverage");
      expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      expect(await atomicBusinessSnapshot(orderId)).toEqual(before);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage10_member_amendment ON amendments;
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage10_member_revision ON pricing_revisions;
        DROP FUNCTION IF EXISTS qintopia_test_tamper_stage10_member_coverage()
      `).execute(db);
    }
  });

  it.each(["EXECUTING", "REJECTED"] as const)(
    "rejects a complete direct shortening combination bound to a %s command and rolls back its facts",
    async (executionState) => {
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const emptyCommandId = `command_stage10_empty_${executionState.toLowerCase()}`;
      await db.insertInto("command_executions").values({
        id: emptyCommandId,
        subject_id: principal.subjectId,
        credential_id: principal.credentialId,
        property_id: demo.propertyId,
        command_type: "SHORTEN_STAY",
        idempotency_key: emptyCommandId,
        request_hash: "e".repeat(64),
        correlation_id: emptyCommandId,
        state: executionState,
        completed_at: executionState === "REJECTED" ? new Date() : null
      }).execute();
      expect(await db.selectFrom("command_executions").select("state").where("id", "=", emptyCommandId)
        .executeTakeFirstOrThrow()).toEqual({ state: executionState });

      const arrivalDate = shiftDate(businessDate, -2);
      const originalDepartureDate = shiftDate(businessDate, 2);
      const newDepartureDate = shiftDate(businessDate, 1);
      const created = await createFreeOrder({
        prefix: `stage10-direct-${executionState.toLowerCase()}-state`,
        arrivalDate,
        departureDate: originalDepartureDate,
        unitId: demo.roomId
      });
      await markHistoricalOrderInHouse(created.orderId, arrivalDate);
      const prepared = await preview({
        commandType: "SHORTEN_STAY",
        input: {
          propertyId: demo.propertyId,
          orderId: created.orderId,
          newDepartureDate
        }
      }, `stage10-direct-${executionState.toLowerCase()}-state`);

      const order = await db.selectFrom("orders").selectAll().where("id", "=", created.orderId)
        .executeTakeFirstOrThrow();
      const stay = await db.selectFrom("stays").selectAll().where("order_id", "=", created.orderId)
        .executeTakeFirstOrThrow();
      const currentSegment = await db.selectFrom("stay_segments").selectAll()
        .where("stay_id", "=", stay.id).orderBy("sequence", "desc").executeTakeFirstOrThrow();
      const currentRevision = await db.selectFrom("pricing_revisions").selectAll()
        .where("id", "=", order.current_revision_id!).executeTakeFirstOrThrow();
      const segmentIds = (await db.selectFrom("stay_segments").select("id").where("stay_id", "=", stay.id).execute())
        .map((segment) => segment.id);
      const afterPricing = (prepared.preview.effect as {
        after: { pricing: { coverageSet: unknown[]; cashLines: unknown[] } };
      }).after.pricing;
      const before = await atomicBusinessSnapshot(created.orderId);
      const forgedCommandId = `command_stage10_complete_${executionState.toLowerCase()}`;
      const amendmentId = `amend_stage10_complete_${executionState.toLowerCase()}`;
      const segmentId = `segment_stage10_complete_${executionState.toLowerCase()}`;
      const revisionId = `revision_stage10_complete_${executionState.toLowerCase()}`;
      const directWrite = db.transaction().execute(async (trx) => {
        await trx.insertInto("command_executions").values({
          id: forgedCommandId,
          subject_id: principal.subjectId,
          credential_id: principal.credentialId,
          property_id: demo.propertyId,
          command_type: "SHORTEN_STAY",
          idempotency_key: forgedCommandId,
          request_hash: "s".repeat(64),
          correlation_id: forgedCommandId,
          state: executionState,
          completed_at: executionState === "REJECTED" ? new Date() : null
        }).execute();
        await trx.insertInto("amendments").values({
          id: amendmentId,
          order_id: created.orderId,
          sequence: order.version + 1,
          amendment_type: "SHORTEN_STAY",
          reason_code: "STAGE10_DIRECT_STATE",
          reason_note: "完整缩短组合只能属于已应用命令",
          prior_version: order.version,
          new_version: order.version + 1,
          payload: prepared.preview.effect,
          command_id: forgedCommandId
        }).execute();
        await trx.insertInto("stay_segments").values({
          id: segmentId,
          stay_id: stay.id,
          sequence: currentSegment.sequence + 1,
          inventory_unit_id: demo.roomId,
          arrival_date: arrivalDate,
          departure_date: newDepartureDate,
          segment_type: "SHORTEN_STAY",
          supersedes_segment_id: currentSegment.id,
          amendment_id: amendmentId
        }).execute();
        await trx.insertInto("pricing_revisions").values({
          id: revisionId,
          order_id: created.orderId,
          revision_no: currentRevision.revision_no + 1,
          amendment_id: amendmentId,
          policy_version_id: order.pricing_policy_version_id,
          arrival_date: arrivalDate,
          departure_date: newDepartureDate,
          coverage_set: JSON.stringify(afterPricing.coverageSet),
          cash_lines: JSON.stringify(afterPricing.cashLines),
          policy_base_amount_minor: 0,
          pricing_basis: "FREE",
          manual_adjustment_minor: 0,
          current_contract_amount_minor: 0,
          currency: "CNY"
        }).execute();
        await releaseInventoryClaimsOnDates(
          trx,
          "ORDER_SEGMENT",
          segmentIds,
          [newDepartureDate]
        );
        await trx.updateTable("orders").set({
          departure_date: newDepartureDate,
          current_revision_id: revisionId,
          version: order.version + 1,
          updated_at: new Date()
        }).where("id", "=", created.orderId).executeTakeFirstOrThrow();
      });

      await expect(directWrite).rejects.toMatchObject({ constraint: "stage10_shorten_execution_state" });
      expect(await atomicBusinessSnapshot(created.orderId)).toEqual(before);
      expect(await db.selectFrom("command_executions").select("id").where("id", "=", forgedCommandId).execute())
        .toHaveLength(0);
    }
  );

  it("rejects direct PostgreSQL partial combinations, ordinary early-checkout bypasses, and entitlement writes", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage10-direct-guards",
      arrivalDate: shiftDate(businessDate, -2),
      departureDate: shiftDate(businessDate, 2),
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(created.orderId, shiftDate(businessDate, -2));
    const order = await db.selectFrom("orders").selectAll().where("id", "=", created.orderId).executeTakeFirstOrThrow();
    const guardedPreview = await preview({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
      }
    }, "stage10-direct-valid-effect");
    const shortPayload = guardedPreview.preview.effect;
    const directCommand = (id: string, commandType: "SHORTEN_STAY" | "CHECK_OUT" | "MOVE_UNIT") => ({
      id,
      subject_id: principal.subjectId,
      credential_id: principal.credentialId,
      property_id: demo.propertyId,
      command_type: commandType,
      idempotency_key: id,
      request_hash: "d".repeat(64),
      correlation_id: id,
      state: "APPLIED" as const,
      completed_at: new Date()
    });

    const emptyAppliedCommandId = "command_stage10_empty_applied";
    const emptyApplied = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values(directCommand(emptyAppliedCommandId, "SHORTEN_STAY")).execute();
    });
    await expect(emptyApplied).rejects.toMatchObject({ constraint: "stage10_shorten_amendment_complete" });

    const partialCommandId = "command_stage10_partial";
    const partial = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values(directCommand(partialCommandId, "SHORTEN_STAY")).execute();
      await trx.insertInto("amendments").values({
        id: "amend_stage10_partial",
        order_id: created.orderId,
        sequence: order.version + 1,
        amendment_type: "SHORTEN_STAY",
        reason_code: "STAGE10_DIRECT",
        reason_note: "直接写残缺组合应失败",
        prior_version: order.version,
        new_version: order.version + 1,
        payload: shortPayload,
        command_id: partialCommandId
      }).execute();
    });
    await expect(partial).rejects.toMatchObject({ constraint: "stage10_shorten_segment_revision_complete" });

    const commandlessShorten = db.insertInto("amendments").values({
      id: "amend_stage10_commandless",
      order_id: created.orderId,
      sequence: order.version + 1,
      amendment_type: "SHORTEN_STAY",
      reason_code: "STAGE10_DIRECT",
      reason_note: "无命令缩短必须失败",
      prior_version: order.version,
      new_version: order.version + 1,
      payload: shortPayload,
      command_id: null
    }).execute();
    await expect(commandlessShorten).rejects.toMatchObject({ constraint: "amendments_stage10_command_required" });

    const currentRevision = await db.selectFrom("pricing_revisions").selectAll()
      .where("id", "=", order.current_revision_id!).executeTakeFirstOrThrow();
    const wrongBasisCommandId = "command_stage10_wrong_basis";
    const wrongBasis = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values(directCommand(wrongBasisCommandId, "SHORTEN_STAY")).execute();
      const amendmentId = "amend_stage10_wrong_basis";
      await trx.insertInto("amendments").values({
        id: amendmentId,
        order_id: created.orderId,
        sequence: order.version + 1,
        amendment_type: "SHORTEN_STAY",
        reason_code: "STAGE10_DIRECT",
        reason_note: "企业微信缩短不得伪装渠道计价",
        prior_version: order.version,
        new_version: order.version + 1,
        payload: shortPayload,
        command_id: wrongBasisCommandId
      }).execute();
      await trx.insertInto("pricing_revisions").values({
        id: "revision_stage10_wrong_basis",
        order_id: created.orderId,
        revision_no: currentRevision.revision_no + 1,
        amendment_id: amendmentId,
        policy_version_id: currentRevision.policy_version_id,
        arrival_date: order.arrival_date,
        departure_date: shiftDate(businessDate, 1),
        coverage_set: JSON.stringify(currentRevision.coverage_set),
        cash_lines: JSON.stringify(currentRevision.cash_lines),
        policy_base_amount_minor: currentRevision.policy_base_amount_minor,
        pricing_basis: "CHANNEL_CONTRACT",
        manual_adjustment_minor: 0,
        current_contract_amount_minor: currentRevision.policy_base_amount_minor,
        currency: currentRevision.currency
      }).execute();
    });
    await expect(wrongBasis).rejects.toMatchObject({ constraint: "pricing_revisions_stage10_wecom_basis" });

    const ordinaryCheckoutCommandId = "command_stage10_ordinary_checkout";
    const bypass = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values(directCommand(ordinaryCheckoutCommandId, "CHECK_OUT")).execute();
      await trx.insertInto("amendments").values({
        id: "amend_stage10_ordinary_checkout",
        order_id: created.orderId,
        sequence: order.version + 1,
        amendment_type: "CHECK_OUT",
        reason_code: "STAGE10_DIRECT",
        reason_note: "普通退房不得提前旁路",
        prior_version: order.version,
        new_version: order.version + 1,
        payload: { businessDate, effectiveDate: businessDate, fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT" },
        command_id: ordinaryCheckoutCommandId
      }).execute();
    });
    await expect(bypass).rejects.toMatchObject({ constraint: "amendments_stage10_checkout_not_early" });

    const unrelatedCheckoutCommandId = "command_stage10_unrelated_checkout";
    const unrelatedCheckout = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values(directCommand(unrelatedCheckoutCommandId, "MOVE_UNIT")).execute();
      await trx.insertInto("amendments").values({
        id: "amend_stage10_unrelated_checkout",
        order_id: created.orderId,
        sequence: order.version + 1,
        amendment_type: "CHECK_OUT",
        reason_code: "STAGE10_DIRECT",
        reason_note: "异类型命令不得伪装退房",
        prior_version: order.version,
        new_version: order.version + 1,
        payload: { businessDate, effectiveDate: businessDate, fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT" },
        command_id: unrelatedCheckoutCommandId
      }).execute();
    });
    await expect(unrelatedCheckout).rejects.toMatchObject({ constraint: "amendments_stage10_checkout_command_type" });

    const lot = await db.selectFrom("entitlement_lots").select("id").executeTakeFirstOrThrow();
    const ledgerCommandId = "command_stage10_ledger";
    const ledgerWrite = db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values(directCommand(ledgerCommandId, "SHORTEN_STAY")).execute();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: "fact_stage10_forbidden",
        lot_id: lot.id,
        entry_type: "ADJUST",
        quantity_delta: 1,
        service_date: null,
        order_id: null,
        coverage_id: null,
        reason: "SHORTEN_STAY 不得写会员账本",
        command_id: ledgerCommandId
      }).execute();
    });
    await expect(ledgerWrite).rejects.toMatchObject({ constraint: "entitlement_ledger_stage10_no_write" });
    expect(await db.selectFrom("command_executions").select("id")
      .where("id", "in", [emptyAppliedCommandId, partialCommandId, wrongBasisCommandId, ordinaryCheckoutCommandId, unrelatedCheckoutCommandId, ledgerCommandId]).execute()).toHaveLength(0);
  });
});
