import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fastJsonStringify from "fast-json-stringify";
import type {
  AuthPrincipal,
  BookingChannelCode,
  CommandEnvelope,
  ReceiptDto,
  RoomStatusBoardDto,
  RoomStatusUnitDto
} from "@qintopia/contracts";
import { OrderDetailResponseSchema } from "../../apps/api/src/schemas.ts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  getRoomStatusBoard,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import { newId } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { releaseInventoryClaims } from "../../packages/db/src/inventory.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let db: Kysely<Database>;
let sequence = 0;
let memberPhoneSequence = 0;

const ARRIVAL = "2026-08-06";
const DEPARTURE = "2026-08-11";
const COMPLETION = "2026-08-15";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope({ credentialType: "TOKEN", profile: "ordinary" })
};

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function atClock<T>(date: string, operation: () => Promise<T>): Promise<T> {
  return withPropertyClockForTesting(new Date(`${date}T12:00:00.000Z`), operation);
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function confirm(envelope: CommandEnvelope, prefix: string, reasonNote?: string): Promise<ReceiptDto> {
  const prepared = await preview(envelope, prefix);
  const reason = envelope.commandType === "CREATE_ORDER"
    ? { code: "CREATE_STANDARD_ORDER", note: "" }
    : envelope.commandType === "COMPLETE_STAY"
      ? { code: "COMPLETE_STAY", note: reasonNote ?? "" }
      : { code: "AUTOMATED_ACCEPTANCE", note: "complete-stay integration acceptance" };
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason
  }, metadata(`${prefix}-confirm`));
}

async function createPastOrder(options: {
  prefix: string;
  unitId?: string;
  stayType?: "TRANSIENT" | "FREE";
  channel?: BookingChannelCode;
  targetAmountMinor?: number;
  memberId?: string;
  arrivalDate?: string;
  departureDate?: string;
}) {
  const stayType = options.stayType ?? "TRANSIENT";
  const arrivalDate = options.arrivalDate ?? ARRIVAL;
  const departureDate = options.departureDate ?? DEPARTURE;
  return atClock(arrivalDate, async () => {
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: options.unitId ?? demo.roomId,
      stayType,
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId,
      ...(options.memberId ? { memberId: options.memberId } : {})
    });
    const channel = options.memberId || stayType === "FREE" ? undefined : (options.channel ?? "WECOM");
    const receipt = await confirm({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: `住客 ${options.prefix}`, nickname: options.prefix },
        ...(stayType === "FREE"
          ? { freeStayReason: "义工服务期间免费入住", freeStayCategoryCode: "VOLUNTEER" as const }
          : {}),
        ...(channel
          ? {
              bookingChannelCode: channel,
              channelOrderReference: channel === "WECOM" ? null : `CHANNEL-${options.prefix}`,
              ...(options.targetAmountMinor !== undefined
                ? {
                    targetCurrentContractAmountMinor: options.targetAmountMinor,
                    ...(channel !== "WECOM" ? { channelPriceDifferenceReason: "按渠道后台真实应结金额下单" } : {})
                  }
                : {})
            }
          : {})
      }
    }, `${options.prefix}-create`);
    return { orderId: receipt.result!.orderId as string, quote, receipt };
  }) as Promise<{ orderId: string; quote: Awaited<ReturnType<typeof createQuote>>; receipt: ReceiptDto }>;
}

async function completeStay(
  orderId: string,
  prefix: string,
  reason: string,
  collection?: Record<string, unknown>,
  completionDate = COMPLETION
) {
  return atClock(completionDate, () => confirm({
    commandType: "COMPLETE_STAY",
    input: {
      propertyId: demo.propertyId,
      orderId,
      actualStayCompletedConfirmed: true,
      reasonNote: reason,
      ...(collection ? { collection } : {})
    }
  }, `${prefix}-complete`, reason)) as Promise<ReceiptDto>;
}

async function recordCollection(orderId: string, amountMinor: number, prefix: string, method = "WECOM") {
  return atClock(ARRIVAL, () => confirm({
    commandType: "RECORD_COLLECTION",
    input: {
      propertyId: demo.propertyId,
      orderId,
      amountMinor,
      method,
      ...(method === "WECOM" ? { transactionReference: `WX-${prefix}` } : {})
    }
  }, `${prefix}-collection`)) as Promise<ReceiptDto>;
}

async function board(): Promise<RoomStatusBoardDto> {
  return getRoomStatusBoard(db, {
    propertyId: demo.propertyId,
    arrivalDate: shiftDate(ARRIVAL, -1),
    departureDate: shiftDate(COMPLETION, 1),
    accessLevel: "WRITE",
    commandGrants: principal.propertyCommandGrants.get(demo.propertyId)!,
    requestingSubjectId: demo.agentSubjectId,
    pageSize: 200
  });
}

function unitIn(result: RoomStatusBoardDto, unitId: string): RoomStatusUnitDto {
  for (const room of result.rooms) {
    if (room.id === unitId) return room;
    const child = room.children.find((unit) => unit.id === unitId);
    if (child) return child;
  }
  throw new Error(`Unit ${unitId} is absent from room-status`);
}

async function projectedStatus(orderId: string, unitId: string) {
  const result = await board();
  return unitIn(result, unitId).intervals.find((interval) =>
    interval.references.some((reference) => reference.type === "ORDER" && reference.id === orderId)
  )?.status;
}

async function completeStayBusinessSnapshot(orderId: string) {
  const [order, stay, segments, occupants, amendments, revisions, collectionFacts] = await Promise.all([
    db.selectFrom("orders")
      .select(["id", "status", "arrival_date", "departure_date", "current_revision_id", "version"])
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow(),
    db.selectFrom("stays")
      .select(["id", "status"])
      .where("order_id", "=", orderId)
      .executeTakeFirstOrThrow(),
    db.selectFrom("stay_segments")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select(["stay_segments.id", "stay_segments.inventory_unit_id", "stay_segments.arrival_date", "stay_segments.departure_date"])
      .where("stays.order_id", "=", orderId)
      .orderBy("stay_segments.sequence")
      .execute(),
    db.selectFrom("order_occupants")
      .select(["id", "ordinal", "role", "full_name", "nickname", "phone", "document_number", "created_by_command_id"])
      .where("order_id", "=", orderId)
      .orderBy("ordinal")
      .execute(),
    db.selectFrom("amendments")
      .select(["id", "sequence", "amendment_type", "reason_code", "reason_note", "command_id"])
      .where("order_id", "=", orderId)
      .orderBy("sequence")
      .execute(),
    db.selectFrom("pricing_revisions")
      .select(["id", "revision_no", "amendment_id", "arrival_date", "departure_date", "policy_base_amount_minor", "current_contract_amount_minor", "currency"])
      .where("order_id", "=", orderId)
      .orderBy("revision_no")
      .execute(),
    db.selectFrom("collection_facts")
      .select(["fact_id", "fact_type", "amount_minor", "net_effect_minor", "command_id"])
      .where("order_id", "=", orderId)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute()
  ]);
  const claims = await db.selectFrom("inventory_claims")
    .select(["id", "source_id", "inventory_unit_id", "service_date", "active", "released_at"])
    .where("source_type", "=", "ORDER_SEGMENT")
    .where("source_id", "in", segments.map((segment) => segment.id))
    .orderBy("service_date")
    .orderBy("id")
    .execute();
  return { order, stay, segments, occupants, amendments, revisions, collectionFacts, claims };
}

async function unitId(code: string) {
  return (await db.selectFrom("inventory_units").select("id").where("property_id", "=", demo.propertyId).where("code", "=", code).executeTakeFirstOrThrow()).id;
}

async function createMember(memberId: string) {
  memberPhoneSequence += 1;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `COMPLETE-${memberId.toUpperCase()}`,
    nickname: `完成住宿 ${memberId}`,
    full_name: `完成住宿 ${memberId}`,
    phone: `137${String(memberPhoneSequence).padStart(8, "0")}`,
    wechat: `wx-complete-${memberId}`
  }).execute();
  await db.insertInto("member_property_links").values({ member_id: memberId, property_id: demo.propertyId }).execute();
}

async function activateProduct(memberId: string, prefix: string) {
  const order = await confirm({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: {
      propertyId: demo.propertyId,
      memberId,
      membershipProductId: "membership_product_shared_bath_single_v1",
      agreedPriceMinor: 162_000
    }
  }, `${prefix}-order`);
  const membershipOrderId = order.result!.membershipOrderId as string;
  await confirm({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor: 1, transactionReference: `WX-${prefix}` }
  }, `${prefix}-payment`);
  const activation = await confirm({
    commandType: "ACTIVATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, membershipOrderId }
  }, `${prefix}-activation`);
  return {
    membershipOrderId,
    contractId: activation.result!.contractId as string,
    lotId: activation.result!.entitlementLotId as string
  };
}

async function injectExternalChannelCollection(orderId: string, prefix: string) {
  const order = await db.selectFrom("orders")
    .innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
    .select(["orders.current_revision_id", "pricing_revisions.currency"])
    .where("orders.id", "=", orderId)
    .executeTakeFirstOrThrow();
  const commandId = newId("command");
  await sql`ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_validate_new_transaction_reference`.execute(db);
  try {
    await db.insertInto("command_executions").values({
      id: commandId,
      subject_id: demo.agentSubjectId,
      credential_id: "token_demo_write",
      property_id: demo.propertyId,
      command_type: "RECORD_COLLECTION",
      idempotency_key: `corrupt-channel-funds-${prefix}-${sequence}`,
      request_hash: "corrupt-channel-funds",
      correlation_id: `corrupt-channel-funds-${prefix}-${sequence}`,
      state: "APPLIED",
      completed_at: new Date()
    }).execute();
    await db.insertInto("collection_facts").values({
      fact_id: newId("fact"),
      order_id: orderId,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: order.currency,
      references_fact_id: null,
      reverses_fact_id: null,
      method: "WECOM",
      note: "故意注入的渠道住宿收款污染",
      transaction_reference: `WX-CORRUPT-${prefix}`,
      cash_collector: null,
      pricing_revision_id: order.current_revision_id,
      command_id: commandId
    }).execute();
  } finally {
    await sql`ALTER TABLE collection_facts ENABLE TRIGGER collection_facts_validate_new_transaction_reference`.execute(db);
  }
}

beforeEach(async () => {
  db = await resetTestDatabase();
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("complete overdue reserved stay", () => {
  it("corrects the 106 and 324 equivalent while preserving the original order, stay, occupant, dates, and price", async () => {
    const room106Id = await unitId("106");
    const created = await createPastOrder({
      prefix: "324",
      unitId: room106Id,
      arrivalDate: "2026-08-06",
      departureDate: "2026-08-12"
    });
    const before = await completeStayBusinessSnapshot(created.orderId);
    expect(before.order).toMatchObject({
      id: created.orderId,
      status: "RESERVED",
      arrival_date: "2026-08-06",
      departure_date: "2026-08-12",
      version: 1
    });
    expect(before.stay.status).toBe("PLANNED");
    expect(before.segments).toHaveLength(1);
    expect(before.segments[0]).toMatchObject({
      inventory_unit_id: room106Id,
      arrival_date: "2026-08-06",
      departure_date: "2026-08-12"
    });
    expect(before.occupants).toEqual([expect.objectContaining({ full_name: "住客 324", nickname: "324" })]);
    expect(before.revisions).toEqual([expect.objectContaining({
      revision_no: 1,
      arrival_date: "2026-08-06",
      departure_date: "2026-08-12",
      current_contract_amount_minor: 139_200,
      currency: "CNY"
    })]);
    expect(before.collectionFacts).toEqual([]);
    expect(before.claims).toHaveLength(6);
    expect(before.claims.every((claim) => claim.active === true && claim.released_at === null)).toBe(true);

    const reason = "客人实际入住并已离店，纠正开发期间遗留的错误预订";
    const receipt = await completeStay(created.orderId, "324", reason, undefined, "2026-08-25");
    expect(receipt.result).toMatchObject({ settlementStatus: "ARREARS", collectionFactId: null });
    expect(receipt.factRefs).toEqual([]);

    const after = await completeStayBusinessSnapshot(created.orderId);
    expect(after.order).toEqual({ ...before.order, status: "CHECKED_OUT", version: 3 });
    expect(after.stay).toEqual({ ...before.stay, status: "COMPLETED" });
    expect(after.segments).toEqual(before.segments);
    expect(after.occupants).toEqual(before.occupants);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.collectionFacts).toEqual([]);
    expect(after.amendments[0]).toEqual(before.amendments[0]);
    expect(after.amendments.slice(1)).toEqual([
      expect.objectContaining({
        sequence: 2,
        amendment_type: "CHECK_IN",
        reason_code: "COMPLETE_STAY",
        reason_note: reason,
        command_id: receipt.commandId
      }),
      expect.objectContaining({
        sequence: 3,
        amendment_type: "CHECK_OUT",
        reason_code: "COMPLETE_STAY",
        reason_note: reason,
        command_id: receipt.commandId
      })
    ]);
    expect(after.claims.map((claim) => ({
      id: claim.id,
      source_id: claim.source_id,
      inventory_unit_id: claim.inventory_unit_id,
      service_date: claim.service_date
    }))).toEqual(before.claims.map((claim) => ({
      id: claim.id,
      source_id: claim.source_id,
      inventory_unit_id: claim.inventory_unit_id,
      service_date: claim.service_date
    })));
    expect(after.claims.every((claim) => claim.active === false && claim.released_at !== null)).toBe(true);
    expect(await db.selectFrom("audit_entries")
      .select(["action", "decision", "command_id", "target_refs"])
      .where("command_id", "=", receipt.commandId)
      .execute()).toEqual([expect.objectContaining({
        action: "COMPLETE_STAY",
        decision: "ALLOWED",
        command_id: receipt.commandId
      })]);
  });

  it("atomically completes an overdue reserved stay that was already paid in full", async () => {
    const reason = "客人实际住过且已离店，系统漏录入住与退房";
    const created = await createPastOrder({ prefix: "paid" });
    const orderId = created.orderId;
    const contractAmountMinor = created.quote.currentContractAmount.minorUnits;
    await recordCollection(orderId, contractAmountMinor, "paid-full");

    const receipt = await completeStay(orderId, "paid", reason);
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(receipt.result).toMatchObject({
      orderId,
      status: "CHECKED_OUT",
      settlementStatus: "SETTLED",
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      checkInAmendmentId: expect.stringMatching(/^amend_/),
      checkOutAmendmentId: expect.stringMatching(/^amend_/),
      collectionFactId: null,
      consumedCoverageIds: [],
      fulfillmentTiming: {
        effectiveDate: DEPARTURE,
        recordedBusinessDate: COMPLETION,
        recordingMode: "LATE_RECORDED"
      }
    });

    const [order, stay, amendments, claims, facts, cleaningTasks] = await Promise.all([
      db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("stays").selectAll().where("order_id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").selectAll().where("order_id", "=", orderId).orderBy("sequence").execute(),
      db.selectFrom("inventory_claims").selectAll().where("source_id", "in",
        db.selectFrom("stay_segments").select("id").where("stay_id", "=", receipt.result!.stayId as string)).execute(),
      db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).execute(),
      db.selectFrom("cleaning_tasks").select("id").where("order_id", "=", orderId).execute()
    ]);
    expect(order).toMatchObject({ status: "CHECKED_OUT", version: 3 });
    expect(stay.status).toBe("COMPLETED");
    expect(amendments.map((amendment) => amendment.amendment_type)).toEqual(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT"]);
    expect(amendments.slice(1).every((amendment) =>
      amendment.reason_code === "COMPLETE_STAY" && amendment.reason_note === reason)).toBe(true);
    expect(claims).toHaveLength(5);
    expect(claims.every((claim) => claim.active === false && claim.released_at !== null)).toBe(true);
    expect(receipt.result?.releasedClaimIds).toEqual(expect.arrayContaining(claims.map((claim) => claim.id)));
    expect(facts).toEqual([expect.objectContaining({
      amount_minor: contractAmountMinor,
      method: "WECOM",
      transaction_reference: "WX-paid-full"
    })]);
    expect(cleaningTasks).toEqual([]);

    const detail = await getOrderView(db, orderId);
    JSON.parse(fastJsonStringify(OrderDetailResponseSchema)(detail));
    expect(await projectedStatus(orderId, demo.roomId)).toBe("SETTLED");

    // 库存已闭环：同一段历史日期不能再补录其他订单。
    await atClock(COMPLETION, async () => {
      const overlappingQuote = await createQuote(db, {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: ARRIVAL,
        departureDate: DEPARTURE,
        pricingPolicyVersionId: demo.publicPricingPolicyId
      });
      await expect(preview({
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: overlappingQuote.quoteId,
          primaryGuest: { fullName: "重叠补录", nickname: "重叠补录" },
          backfill: true,
          backfillReason: "重叠冲突验证",
          bookingChannelCode: "WECOM",
          channelOrderReference: null
        }
      }, "overlap")).rejects.toMatchObject({
        code: "INVENTORY_CONFLICT",
        statusCode: 409,
        details: { orderId }
      });
    });
  });

  it("binds late CHECK_IN to the first timeline unit and CHECK_OUT to the last after a reserved move", async () => {
    const arrivalDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftDate(arrivalDate, 5);
    const completionDate = shiftDate(departureDate, 1);
    const created = await createPastOrder({ prefix: "moved-timeline", arrivalDate, departureDate });
    const effectiveDate = shiftDate(arrivalDate, 2);
    const moveReceipt = await atClock(arrivalDate, () => confirm({
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newInventoryUnitId: demo.secondRoomId,
        effectiveDate
      }
    }, "moved-timeline-move"));
    expect(moveReceipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const activeTimeline = await db.selectFrom("inventory_claims")
      .innerJoin("stay_segments", "stay_segments.id", "inventory_claims.source_id")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select(["inventory_claims.service_date", "inventory_claims.inventory_unit_id"])
      .where("stays.order_id", "=", created.orderId)
      .where("inventory_claims.source_type", "=", "ORDER_SEGMENT")
      .where("inventory_claims.active", "=", true)
      .orderBy("inventory_claims.service_date")
      .execute();
    expect(activeTimeline).toEqual([
      { service_date: arrivalDate, inventory_unit_id: demo.roomId },
      { service_date: shiftDate(arrivalDate, 1), inventory_unit_id: demo.roomId },
      ...[2, 3, 4].map((days) => ({
        service_date: shiftDate(arrivalDate, days),
        inventory_unit_id: demo.secondRoomId
      }))
    ]);

    const receipt = await completeStay(created.orderId, "moved-timeline", "跨房源实际住宿已完成", undefined, completionDate);
    expect(receipt.result).toMatchObject({
      status: "CHECKED_OUT",
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      releasedClaimIds: expect.arrayContaining([
        expect.stringMatching(/^claim_/),
        expect.stringMatching(/^claim_/)
      ])
    });
    const fulfillment = await db.selectFrom("amendments")
      .select(["amendment_type", "payload"])
      .where("order_id", "=", created.orderId)
      .where("amendment_type", "in", ["CHECK_IN", "CHECK_OUT"])
      .orderBy("sequence")
      .execute();
    expect(fulfillment).toHaveLength(2);
    expect(fulfillment[0]).toMatchObject({
      amendment_type: "CHECK_IN",
      payload: expect.objectContaining({ inventoryUnitId: demo.roomId, effectiveDate: arrivalDate })
    });
    expect(fulfillment[1]).toMatchObject({
      amendment_type: "CHECK_OUT",
      payload: expect.objectContaining({ inventoryUnitId: demo.secondRoomId, effectiveDate: departureDate })
    });
  });

  it("fails closed when the complete-stay source order has a broken lifecycle chain", async () => {
    const created = await createPastOrder({ prefix: "lifecycle-corrupt" });
    await db.updateTable("orders")
      .set({ version: 2 })
      .where("id", "=", created.orderId)
      .executeTakeFirstOrThrow();

    await expect(completeStay(created.orderId, "lifecycle-corrupt", "损坏生命周期不得完成住宿"))
      .rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "订单版本与不可变变更记录数量不一致"
      });
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", created.orderId).execute()).toHaveLength(1);
    expect(await db.selectFrom("inventory_claims")
      .select("inventory_claims.id")
      .where("source_id", "in", db.selectFrom("stay_segments").select("stay_segments.id")
        .innerJoin("stays", "stays.id", "stay_segments.stay_id")
        .where("stays.order_id", "=", created.orderId))
      .where("active", "=", true)
      .execute()).toHaveLength(5);
  });

  it("rejects an active order Claim outside the current interval instead of silently releasing it", async () => {
    const created = await createPastOrder({ prefix: "outside-claim" });
    const segment = await db.selectFrom("stay_segments")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select("stay_segments.id")
      .where("stays.order_id", "=", created.orderId)
      .executeTakeFirstOrThrow();
    const corruptClaimId = newId("claim");
    await sql`ALTER TABLE inventory_claims DISABLE TRIGGER inventory_claims_validate_source`.execute(db);
    try {
      await db.insertInto("inventory_claims").values({
        id: corruptClaimId,
        property_id: demo.propertyId,
        room_id: demo.roomId,
        inventory_unit_id: demo.roomId,
        service_date: DEPARTURE,
        source_type: "ORDER_SEGMENT",
        source_id: segment.id,
        active: true,
        released_at: null
      }).execute();
    } finally {
      await sql`ALTER TABLE inventory_claims ENABLE TRIGGER inventory_claims_validate_source`.execute(db);
    }
    await db.insertInto("inventory_room_days")
      .values({ room_id: demo.roomId, service_date: DEPARTURE, whole_claim_id: null, version: 0 })
      .onConflict((oc) => oc.columns(["room_id", "service_date"]).doNothing())
      .execute();
    await db.updateTable("inventory_room_days")
      .set({ whole_claim_id: corruptClaimId })
      .where("room_id", "=", demo.roomId)
      .where("service_date", "=", DEPARTURE)
      .executeTakeFirstOrThrow();

    await expect(completeStay(created.orderId, "outside-claim", "区间外 Claim 不得被释放"))
      .rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Stay inventory timeline has active Claims outside the order interval"
      });
    expect(await db.selectFrom("inventory_claims").select(["active", "released_at"])
      .where("id", "=", corruptClaimId).executeTakeFirstOrThrow())
      .toEqual({ active: true, released_at: null });
  });

  it("rolls back inventory Claim release when the inventory-day pointer does not match", async () => {
    const created = await createPastOrder({ prefix: "claim-pointer" });
    const segment = await db.selectFrom("stay_segments")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select("stay_segments.id")
      .where("stays.order_id", "=", created.orderId)
      .executeTakeFirstOrThrow();
    const firstClaim = await db.selectFrom("inventory_claims")
      .select(["id", "room_id", "service_date"])
      .where("source_id", "=", segment.id)
      .where("active", "=", true)
      .orderBy("service_date")
      .executeTakeFirstOrThrow();
    await db.updateTable("inventory_room_days")
      .set({ whole_claim_id: null })
      .where("room_id", "=", firstClaim.room_id)
      .where("service_date", "=", firstClaim.service_date)
      .executeTakeFirstOrThrow();

    await expect(db.transaction().execute((trx) =>
      releaseInventoryClaims(trx, "ORDER_SEGMENT", [segment.id])))
      .rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "库存占用指针损坏，不能释放库存",
        details: { claimId: firstClaim.id }
      });
    expect(await db.selectFrom("inventory_claims")
      .select("id")
      .where("source_id", "=", segment.id)
      .where("active", "=", true)
      .execute()).toHaveLength(5);
  });

  it("projects unpaid completed stays as arrears and settles after an ordinary collection", async () => {
    const created = await createPastOrder({ prefix: "arrears" });
    const orderId = created.orderId;
    const contractAmountMinor = created.quote.currentContractAmount.minorUnits;

    const receipt = await completeStay(orderId, "arrears", "客人已离店，但住宿款尚未收齐");
    expect(receipt.result).toMatchObject({ settlementStatus: "ARREARS", collectionFactId: null });
    expect(receipt.factRefs).toEqual([]);
    expect(await projectedStatus(orderId, demo.roomId)).toBe("ARREARS");
    expect((await getOrderView(db, orderId)).amounts.collectionDifference.minorUnits).toBe(contractAmountMinor);

    await recordCollection(orderId, contractAmountMinor, "arrears-balance");
    expect((await getOrderView(db, orderId)).amounts.collectionDifference.minorUnits).toBe(0);
    expect(await projectedStatus(orderId, demo.roomId)).toBe("SETTLED");
  });

  it("records a real supplemental collection while completing the stay", async () => {
    const created = await createPastOrder({ prefix: "supplement" });
    const orderId = created.orderId;
    const contractAmountMinor = created.quote.currentContractAmount.minorUnits;
    await recordCollection(orderId, 10_000, "supplement-partial");

    const receipt = await completeStay(orderId, "supplement", "退房时现金补收剩余房款", {
      amountMinor: contractAmountMinor - 10_000,
      method: "CASH",
      cashCollector: "前台小秦",
      note: "退房现金补收"
    });
    expect(receipt.result).toMatchObject({
      settlementStatus: "SETTLED",
      collectionFactId: expect.stringMatching(/^fact_/)
    });
    expect(receipt.factRefs).toHaveLength(1);
    const facts = await db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute();
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({
      amount_minor: contractAmountMinor - 10_000,
      method: "CASH",
      cash_collector: "前台小秦",
      note: "退房现金补收",
      transaction_reference: null
    });
    expect(await projectedStatus(orderId, demo.roomId)).toBe("SETTLED");
  });

  it("rejects supplemental collections that exceed the outstanding balance or miss evidence", async () => {
    const overpaid = await createPastOrder({ prefix: "overpaid" });
    const overpaidAmount = overpaid.quote.currentContractAmount.minorUnits;
    await recordCollection(overpaid.orderId, 5_000, "overpaid-partial");
    await expect(completeStay(overpaid.orderId, "overpaid", "超额补收应被拦截", {
      amountMinor: overpaidAmount,
      method: "WECOM",
      transactionReference: "WX-OVERPAID"
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "完成住宿补记实收金额不能超过订单未结余额"
    });

    const cash = await createPastOrder({ prefix: "cash-missing", unitId: demo.secondRoomId });
    await expect(completeStay(cash.orderId, "cash-missing", "缺少现金收款人应被拦截", {
      amountMinor: 8_800,
      method: "CASH",
      note: "现金补收"
    })).rejects.toMatchObject({ message: "现金完成住宿收款必须填写收款人" });

    const wecom = await createPastOrder({ prefix: "wecom-missing", unitId: await unitId("B01") });
    await expect(completeStay(wecom.orderId, "wecom-missing", "缺少交易单号应被拦截", {
      amountMinor: 8_800,
      method: "WECOM"
    })).rejects.toMatchObject({ message: "必须填写企业微信交易单号" });
  });

  it("closes free, member, and external-channel completed stays without lodging collection facts", async () => {
    const free = await createPastOrder({ prefix: "free", stayType: "FREE" });
    const freeReceipt = await completeStay(free.orderId, "free", "义工免费入住已完成");
    expect(freeReceipt.result).toMatchObject({ settlementStatus: "SETTLED", collectionFactId: null });
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", free.orderId).execute()).toEqual([]);
    expect(await projectedStatus(free.orderId, demo.roomId)).toBe("SETTLED");

    const channel = await createPastOrder({ prefix: "channel", channel: "CTRIP", targetAmountMinor: 32_400, unitId: demo.secondRoomId });
    const channelReceipt = await completeStay(channel.orderId, "channel", "渠道订单已完成住宿");
    expect(channelReceipt.result).toMatchObject({ settlementStatus: "SETTLED", collectionFactId: null });
    expect(channelReceipt.factRefs).toEqual([]);
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", channel.orderId).execute()).toEqual([]);
    expect(await projectedStatus(channel.orderId, demo.secondRoomId)).toBe("SETTLED");
    const channelOrder = await db.selectFrom("orders").selectAll().where("id", "=", channel.orderId).executeTakeFirstOrThrow();
    const channelRevision = await db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", channel.orderId).executeTakeFirstOrThrow();
    expect(channelOrder).toMatchObject({ booking_channel_code: "CTRIP", channel_order_reference: "CHANNEL-channel" });
    expect(channelRevision).toMatchObject({ pricing_basis: "CHANNEL_CONTRACT", current_contract_amount_minor: 32_400 });

    const memberId = "member_complete_stay";
    await createMember(memberId);
    await atClock(ARRIVAL, () => activateProduct(memberId, "member"));
    const memberOrder = await createPastOrder({ prefix: "member", memberId, unitId: await unitId("D01") });
    const held = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", memberOrder.orderId).execute();
    expect(held).toHaveLength(5);
    expect(held.every((item) => item.status === "HELD")).toBe(true);
    const memberReceipt = await completeStay(memberOrder.orderId, "member", "会员权益住宿已完成");
    expect(memberReceipt.result).toMatchObject({
      settlementStatus: "SETTLED",
      collectionFactId: null,
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      consumedCoverageIds: expect.arrayContaining(held.map((item) => item.id))
    });
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", memberOrder.orderId).execute()).toEqual([]);
    const consumed = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", memberOrder.orderId).execute();
    expect(consumed).toHaveLength(5);
    expect(consumed.every((item) => item.status === "CONSUMED")).toBe(true);
    expect(await projectedStatus(memberOrder.orderId, await unitId("D01"))).toBe("SETTLED");

    // 会员权益与完整住宿时间线不一致时拒绝完成住宿。
    const memberMismatch = "member_complete_stay_mismatch";
    await createMember(memberMismatch);
    const mismatchMembership = await atClock(ARRIVAL, () => activateProduct(memberMismatch, "member-mismatch"));
    await confirm({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: mismatchMembership.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 4,
        adjustmentReason: "制造权益不足场景"
      }
    }, "member-mismatch-balance");
    const mismatchOrder = await createPastOrder({ prefix: "member-mismatch", memberId: memberMismatch, unitId: await unitId("D01") });
    expect(mismatchOrder.quote.coverageSet).toHaveLength(4);
    await expect(completeStay(mismatchOrder.orderId, "member-mismatch", "覆盖不一致应被拦截"))
      .rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
  });

  it.each(["FREE", "MEMBER", "CHANNEL"] as const)(
    "fails closed when a %s stay already contains lodging collection facts",
    async (kind) => {
      let orderId: string;
      if (kind === "FREE") {
        orderId = (await createPastOrder({ prefix: "free-funds", stayType: "FREE" })).orderId;
        await recordCollection(orderId, 100, "free-funds");
      } else if (kind === "MEMBER") {
        const memberId = "member_complete_stay_funds";
        await createMember(memberId);
        await atClock(ARRIVAL, () => activateProduct(memberId, "member-funds"));
        orderId = (await createPastOrder({
          prefix: "member-funds",
          memberId,
          unitId: await unitId("D01")
        })).orderId;
        await recordCollection(orderId, 100, "member-funds");
      } else {
        orderId = (await createPastOrder({
          prefix: "channel-funds",
          channel: "CTRIP",
          targetAmountMinor: 32_400,
          unitId: demo.secondRoomId
        })).orderId;
        await injectExternalChannelCollection(orderId, "channel-funds");
      }

      await expect(completeStay(orderId, `${kind.toLowerCase()}-funds`, "特殊订单资金污染不得完成住宿"))
        .rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          message: expect.stringContaining("已存在")
        });
      expect(await db.selectFrom("orders").select("status").where("id", "=", orderId).executeTakeFirstOrThrow())
        .toEqual({ status: "RESERVED" });
      expect(await db.selectFrom("stays").select("status").where("order_id", "=", orderId).executeTakeFirstOrThrow())
        .toEqual({ status: "PLANNED" });
      expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute())
        .toHaveLength(1);
    }
  );

  it("always requires CHANNEL_CONTRACT pricing for an external-channel completion", async () => {
    const created = await createPastOrder({
      prefix: "channel-basis-corrupt",
      channel: "CTRIP",
      targetAmountMinor: 32_400,
      unitId: demo.secondRoomId
    });
    await sql`ALTER TABLE pricing_revisions DISABLE TRIGGER pricing_revisions_append_only`.execute(db);
    try {
      await db.updateTable("pricing_revisions")
        .set({ pricing_basis: "POLICY" })
        .where("order_id", "=", created.orderId)
        .executeTakeFirstOrThrow();
    } finally {
      await sql`ALTER TABLE pricing_revisions ENABLE TRIGGER pricing_revisions_append_only`.execute(db);
    }

    await expect(completeStay(created.orderId, "channel-basis-corrupt", "渠道计价基础污染不得完成住宿"))
      .rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "外部渠道订单缺少本单渠道应结金额的计价记录，不能完成住宿；请先核对渠道资料"
      });
  });

  it.each(["HELD", "CONSUMED"] as const)(
    "fails closed when a non-member order contains %s member coverage",
    async (coverageStatus) => {
      const memberId = `member_non_member_${coverageStatus.toLowerCase()}`;
      await createMember(memberId);
      await atClock(ARRIVAL, () => activateProduct(memberId, `non-member-${coverageStatus.toLowerCase()}`));
      const created = await createPastOrder({
        prefix: `non-member-${coverageStatus.toLowerCase()}`,
        memberId,
        unitId: await unitId("D01")
      });
      if (coverageStatus === "CONSUMED") {
        await sql`ALTER TABLE coverage_items DISABLE TRIGGER coverage_items_validate_lifecycle_state`.execute(db);
        try {
          await db.updateTable("coverage_items")
            .set({ status: "CONSUMED" })
            .where("order_id", "=", created.orderId)
            .execute();
        } finally {
          await sql`ALTER TABLE coverage_items ENABLE TRIGGER coverage_items_validate_lifecycle_state`.execute(db);
        }
      }
      await sql`ALTER TABLE orders DISABLE TRIGGER orders_protect_identity`.execute(db);
      try {
        await db.updateTable("orders")
          .set({ member_id: null, member_contract_id: null })
          .where("id", "=", created.orderId)
          .executeTakeFirstOrThrow();
      } finally {
        await sql`ALTER TABLE orders ENABLE TRIGGER orders_protect_identity`.execute(db);
      }

      await expect(completeStay(created.orderId, `non-member-${coverageStatus.toLowerCase()}`, "非会员权益污染不得完成住宿"))
        .rejects.toMatchObject({
          code: "ENTITLEMENT_CONFLICT",
          message: "非会员订单存在冻结或已核销会员权益，当前数据状态异常，不能完成住宿"
        });
    }
  );

  it("rejects COMPLETE_STAY before the planned departure date and on already fulfilled orders", async () => {
    const early = await createPastOrder({ prefix: "early" });
    await expect(atClock(shiftDate(DEPARTURE, -1), () => confirm({
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: early.orderId,
        actualStayCompletedConfirmed: true,
        reasonNote: "未到退房日不能完成住宿"
      }
    }, "early-complete", "未到退房日不能完成住宿"))).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      message: "订单未到计划退房日，请使用普通入住流程"
    });

    const checkedIn = await createPastOrder({ prefix: "already-checked-in", unitId: demo.secondRoomId });
    await atClock(ARRIVAL, () => confirm({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: checkedIn.orderId }
    }, "already-check-in"));
    await expect(completeStay(checkedIn.orderId, "already-checked-in", "已有入住记录不能再次完成住宿"))
      .rejects.toMatchObject({
        code: "INVALID_ORDER_STATE",
        message: "只有已预订且未办理入住的订单可以完成住宿"
      });

    const checkedOut = await createPastOrder({ prefix: "already-checked-out", unitId: await unitId("B01") });
    await atClock(ARRIVAL, () => confirm({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: checkedOut.orderId }
    }, "already-check-in"));
    await atClock(DEPARTURE, () => confirm({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId: checkedOut.orderId }
    }, "already-check-out"));
    await expect(completeStay(checkedOut.orderId, "already-checked-out", "已有退房记录不能再次完成住宿"))
      .rejects.toMatchObject({
        code: "INVALID_ORDER_STATE",
        message: "只有已预订且未办理入住的订单可以完成住宿"
      });
  });

  it("rejects non-fulfillment amendments inside a COMPLETE_STAY command", async () => {
    const created = await createPastOrder({ prefix: "smuggle" });
    const orderId = created.orderId;
    const commandId = newId("command");
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: demo.agentSubjectId,
        credential_id: "token_demo_write",
        property_id: demo.propertyId,
        command_type: "COMPLETE_STAY",
        idempotency_key: `smuggle-${sequence}`,
        request_hash: "forged",
        correlation_id: `smuggle-${sequence}`,
        state: "EXECUTING"
      }).execute();
      await trx.insertInto("amendments").values({
        id: newId("amend"),
        order_id: orderId,
        sequence: 2,
        amendment_type: "CREATE_ORDER",
        reason_code: "COMPLETE_STAY",
        reason_note: "forged-chain",
        prior_version: 1,
        new_version: 2,
        payload: { orderId },
        command_id: commandId
      }).execute();
    })).rejects.toMatchObject({
      code: "23514",
      constraint: "amendments_complete_stay_typed_pair"
    });
  });

  it("requires exactly one CHECK_IN and one CHECK_OUT before a COMPLETE_STAY execution can commit as APPLIED", async () => {
    const created = await createPastOrder({ prefix: "exact-pair" });
    const commandId = newId("command");
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: demo.agentSubjectId,
        credential_id: "token_demo_write",
        property_id: demo.propertyId,
        command_type: "COMPLETE_STAY",
        idempotency_key: `exact-pair-${sequence}`,
        request_hash: "forged",
        correlation_id: `exact-pair-${sequence}`,
        state: "EXECUTING"
      }).execute();
      await trx.insertInto("amendments").values({
        id: newId("amend"),
        order_id: created.orderId,
        sequence: 2,
        amendment_type: "CHECK_IN",
        reason_code: "COMPLETE_STAY",
        reason_note: "missing-checkout",
        prior_version: 1,
        new_version: 2,
        payload: {
          orderId: created.orderId,
          fromStatus: "RESERVED",
          toStatus: "CHECKED_IN"
        },
        command_id: commandId
      }).execute();
      await trx.updateTable("command_executions")
        .set({ state: "APPLIED", completed_at: new Date() })
        .where("id", "=", commandId)
        .executeTakeFirstOrThrow();
    })).rejects.toMatchObject({
      code: "23514",
      constraint: "command_executions_complete_stay_exact_pair"
    });
  });

  it("replays an identical confirmation without duplicating the completed stay or collection", async () => {
    const created = await createPastOrder({ prefix: "idempotent" });
    const orderId = created.orderId;
    const contractAmountMinor = created.quote.currentContractAmount.minorUnits;
    await recordCollection(orderId, contractAmountMinor, "idempotent-paid");

    const reason = "幂等完成住宿原因";
    const envelope: CommandEnvelope = {
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        actualStayCompletedConfirmed: true,
        reasonNote: reason
      }
    };
    const prepared = await atClock(COMPLETION, () => preview(envelope, "idempotent-complete"));
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "COMPLETE_STAY" as const,
      confirmation: true as const,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "COMPLETE_STAY", note: reason }
    };
    const confirmMetadata = metadata("idempotent-complete-confirm");
    const first = await atClock(COMPLETION, () => confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmMetadata));
    const replay = await atClock(COMPLETION, () => confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmMetadata));
    expect(replay).toEqual(first);
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", orderId).execute()).toHaveLength(3);
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toHaveLength(1);
  });

  it("serializes different COMPLETE_STAY previews so only one correction commits", async () => {
    const created = await createPastOrder({ prefix: "concurrent-correction" });
    const reason = "并发核对同一笔错误预订";
    const envelope: CommandEnvelope = {
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        actualStayCompletedConfirmed: true,
        reasonNote: reason
      }
    };
    const [firstPrepared, secondPrepared] = await atClock(COMPLETION, () => Promise.all([
      preview(envelope, "concurrent-correction-first"),
      preview(envelope, "concurrent-correction-second")
    ]));
    const firstMetadata = metadata("concurrent-correction-first-confirm");
    const secondMetadata = metadata("concurrent-correction-second-confirm");
    const confirmation = (effectHash: string) => ({
      propertyId: demo.propertyId,
      commandType: "COMPLETE_STAY" as const,
      confirmation: true as const,
      expectedEffectHash: effectHash,
      reason: { code: "COMPLETE_STAY", note: reason }
    });

    const receipts = await atClock(COMPLETION, () => Promise.all([
      confirmCommandPreview(db, principal, firstPrepared.preview.previewId, confirmation(firstPrepared.preview.effectHash), firstMetadata),
      confirmCommandPreview(db, principal, secondPrepared.preview.previewId, confirmation(secondPrepared.preview.effectHash), secondMetadata)
    ]));
    expect(receipts.filter((receipt) => receipt.businessCommitted)).toHaveLength(1);
    const rejectedReceipts = receipts.filter((receipt) => !receipt.businessCommitted);
    expect(rejectedReceipts).toHaveLength(1);
    expect(rejectedReceipts[0]?.executionStatus).toBe("NOT_EXECUTED");
    expect(rejectedReceipts[0]?.error?.code).toBe("PREVIEW_STALE");

    const snapshot = await completeStayBusinessSnapshot(created.orderId);
    expect(snapshot.order).toMatchObject({ status: "CHECKED_OUT", version: 3 });
    expect(snapshot.stay.status).toBe("COMPLETED");
    expect(snapshot.amendments.map((amendment) => amendment.amendment_type)).toEqual(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT"]);
    expect(snapshot.amendments.slice(1).every((amendment) => amendment.command_id === receipts.find((receipt) => receipt.businessCommitted)!.commandId)).toBe(true);
    expect(snapshot.collectionFacts).toEqual([]);
    expect(snapshot.claims).toHaveLength(5);
    expect(snapshot.claims.every((claim) => claim.active === false && claim.released_at !== null)).toBe(true);

    const persisted = await db.selectFrom("command_executions")
      .innerJoin("command_receipts", "command_receipts.command_id", "command_executions.id")
      .select(["command_executions.idempotency_key", "command_receipts.execution_status", "command_receipts.business_committed", "command_receipts.error"])
      .where("command_executions.idempotency_key", "in", [firstMetadata.idempotencyKey, secondMetadata.idempotencyKey])
      .execute();
    expect(persisted).toHaveLength(2);
    expect(persisted.map((row) => row.execution_status).sort()).toEqual(["EXECUTED", "NOT_EXECUTED"]);
    expect(persisted.find((row) => !row.business_committed)?.error).toMatchObject({ code: "PREVIEW_STALE" });
  });

  it.each([
    {
      artifact: "Receipt",
      tableName: "command_receipts",
      functionName: "fail_complete_stay_receipt",
      triggerName: "fail_complete_stay_receipt_at_commit",
      failureMessage: "forced complete-stay receipt failure"
    },
    {
      artifact: "audit",
      tableName: "audit_entries",
      functionName: "fail_complete_stay_audit",
      triggerName: "fail_complete_stay_audit_at_commit",
      failureMessage: "forced complete-stay audit failure"
    }
  ] as const)("rolls back the entire correction when $artifact persistence fails", async ({
    artifact,
    tableName,
    functionName,
    triggerName,
    failureMessage
  }) => {
    const created = await createPastOrder({ prefix: `correction-${artifact.toLowerCase()}-rollback` });
    const reason = `纠正提交在 ${artifact} 持久化失败时必须整体回滚`;
    const envelope: CommandEnvelope = {
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        actualStayCompletedConfirmed: true,
        reasonNote: reason,
        collection: {
          amountMinor: 10_000,
          method: "WECOM",
          transactionReference: `WX-CORRECTION-${artifact.toUpperCase()}-ROLLBACK`
        }
      }
    };
    const prepared = await atClock(COMPLETION, () => preview(envelope, `correction-${artifact.toLowerCase()}-rollback`));
    const before = await completeStayBusinessSnapshot(created.orderId);
    const confirmMetadata = metadata(`correction-${artifact.toLowerCase()}-rollback-confirm`);
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "COMPLETE_STAY" as const,
      confirmation: true as const,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "COMPLETE_STAY", note: reason }
    };

    try {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '${failureMessage}'; END $$;
        CREATE CONSTRAINT TRIGGER ${triggerName} AFTER INSERT ON ${tableName}
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `).execute(db);

      await expect(atClock(COMPLETION, () => confirmCommandPreview(
        db,
        principal,
        prepared.preview.previewId,
        confirmation,
        confirmMetadata
      ))).rejects.toThrow(failureMessage);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName};
        DROP FUNCTION IF EXISTS ${functionName}();
      `).execute(db);
    }

    expect(await completeStayBusinessSnapshot(created.orderId)).toEqual(before);
    expect(await db.selectFrom("command_executions")
      .select("id")
      .where("subject_id", "=", principal.subjectId)
      .where("property_id", "=", demo.propertyId)
      .where("command_type", "=", "COMPLETE_STAY")
      .where("idempotency_key", "=", confirmMetadata.idempotencyKey)
      .execute()).toHaveLength(0);
    expect(await db.selectFrom("audit_entries")
      .select("id")
      .where("correlation_id", "=", confirmMetadata.correlationId)
      .execute()).toHaveLength(0);
    expect(await db.selectFrom("command_previews")
      .select(["status", "used_at"])
      .where("id", "=", prepared.preview.previewId)
      .executeTakeFirstOrThrow()).toEqual({ status: "OPEN", used_at: null });

    const retried = await atClock(COMPLETION, () => confirmCommandPreview(
      db,
      principal,
      prepared.preview.previewId,
      confirmation,
      confirmMetadata
    ));
    expect(retried).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    const afterRetry = await completeStayBusinessSnapshot(created.orderId);
    expect(afterRetry.order).toMatchObject({ status: "CHECKED_OUT", version: 3 });
    expect(afterRetry.collectionFacts).toHaveLength(1);
    expect(afterRetry.claims.every((claim) => claim.active === false && claim.released_at !== null)).toBe(true);
  });

  it("keeps the current property business date visible to the completion flow", async () => {
    expect(await propertyLocalToday(db, demo.propertyId)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(sql`select 1`.execute(db)).resolves.toBeDefined();
  });
});
