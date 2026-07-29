import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, BookingChannelCode, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createDatabase,
  createCommandPreview,
  getOrderView,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import { newId, parseLocalDate } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
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
}) {
  const channel = options.channel ?? "CTRIP";
  const priced = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId ?? demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: demo.transientPolicyId
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
      command_id: null
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
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute()
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

  it("fails closed for invalid states, no-op dates, past arrivals, and multi-unit reserved arrangements", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder({
      prefix: "stage9-state-matrix",
      arrivalDate: "2028-07-10",
      departureDate: "2028-07-13"
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
    const afterMove = await businessSnapshot(created.orderId);
    await expect(preview({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-07-11",
        newDepartureDate: "2028-07-14",
        targetCurrentContractAmountMinor: created.target
      }
    }, "multi-unit-rejected")).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "该订单已有换房安排，当前版本暂不能调整预订日期"
    });
    expect(await businessSnapshot(created.orderId)).toEqual(afterMove);
  });

  it("extends an in-house stay on its planned departure day and after the planned departure date", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDay = await createPaidOrder({
      prefix: "stage9-departure-day",
      arrivalDate: shiftDate(businessDate, -1),
      departureDate: businessDate,
      unitId: demo.roomId,
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(departureDay.orderId, shiftDate(businessDate, -1));
    const departureDayPreview = await preview({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: departureDay.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
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
      channel: "WECOM"
    });
    await markHistoricalOrderInHouse(overdue.orderId, shiftDate(businessDate, -3));
    const overduePreview = await preview({
      commandType: "EXTEND_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: overdue.orderId,
        newDepartureDate: shiftDate(businessDate, 1)
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
    expect(allCoverage).toHaveLength(6);
    expect(allCoverage.filter((item) => item.status === "HELD").map((item) => item.service_date).sort())
      .toEqual(["2028-09-01", "2028-09-02"]);
    expect(allCoverage.filter((item) => item.status === "RELEASED")).toHaveLength(4);
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
      pricingPolicyVersionId: demo.transientPolicyId,
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
      pricingPolicyVersionId: demo.transientPolicyId,
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
      pricingPolicyVersionId: demo.transientPolicyId,
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
