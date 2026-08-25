import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fastJsonStringify from "fast-json-stringify";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto, RoomStatusBoardDto, RoomStatusUnitDto } from "@qintopia/contracts";
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
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let db: Kysely<Database>;
let sequence = 0;

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function pricingPolicy(arrivalDate: string, departureDate: string, free = false): string {
  if (free) return demo.freePolicyId;
  return arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
    ? demo.transientPolicyId
    : demo.publicPricingPolicyId;
}

async function previewAndConfirm(
  envelope: CommandEnvelope,
  prefix: string,
  reason = "工作人员漏录，现按真实凭据补录"
): Promise<ReceiptDto> {
  const preview = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  return confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? envelope.input.backfill === true
        ? { code: "BACKFILL_STAY", note: reason }
        : { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "AUTOMATED_ACCEPTANCE", note: "8.3 integration acceptance" }
  }, metadata(`${prefix}-confirm`));
}

async function backfillEnvelope(options: {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  prefix: string;
  free?: boolean;
  channel?: "WECOM" | "CTRIP" | "MEITUAN" | "YOUMUDAO";
  targetAmountMinor?: number;
  collection?: {
    amountMinor: number | "FULL";
    method: "WECOM" | "BANK_TRANSFER" | "CASH";
    transactionReference?: string;
    cashCollector?: string;
    note?: string;
  };
  reason?: string;
}): Promise<{ envelope: CommandEnvelope; contractAmountMinor: number }> {
  const stayType = options.free ? "FREE" : "TRANSIENT";
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    stayType,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: pricingPolicy(options.arrivalDate, options.departureDate, options.free)
  });
  const channel = options.channel ?? "WECOM";
  const targetAmountMinor = options.targetAmountMinor ?? quote.currentContractAmount.minorUnits;
  const collection = options.collection
    ? { ...options.collection, amountMinor: options.collection.amountMinor === "FULL" ? targetAmountMinor : options.collection.amountMinor }
    : undefined;
  return {
    contractAmountMinor: targetAmountMinor,
    envelope: {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: `补录住客 ${options.prefix}`, nickname: `补录 ${options.prefix}` },
        backfill: true,
        backfillReason: options.reason ?? "工作人员漏录，现按真实凭据补录",
        ...(options.free ? {
          freeStayReason: "义工服务期间免费入住",
          freeStayCategoryCode: "VOLUNTEER" as const
        } : {
          bookingChannelCode: channel,
          channelOrderReference: channel === "WECOM" ? null : `CHANNEL-${options.prefix}`,
          targetCurrentContractAmountMinor: targetAmountMinor,
          ...(channel !== "WECOM" && targetAmountMinor !== quote.currentContractAmount.minorUnits
            ? { channelPriceDifferenceReason: "按渠道后台真实应结金额补录" }
            : {}),
          ...(collection ? { backfillCollection: collection } : {})
        })
      }
    }
  };
}

async function board(arrivalDate: string, departureDate: string): Promise<RoomStatusBoardDto> {
  return getRoomStatusBoard(db, {
    propertyId: demo.propertyId,
    arrivalDate,
    departureDate,
    accessLevel: "WRITE",
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

async function projectedStatus(orderId: string, unitId: string, arrivalDate: string, departureDate: string) {
  const result = await board(arrivalDate, departureDate);
  return unitIn(result, unitId).intervals.find((interval) =>
    interval.references.some((reference) => reference.type === "ORDER" && reference.id === orderId)
  )?.status;
}

async function lodgingArtifactCounts(): Promise<number[]> {
  return Promise.all([
    "orders",
    "stays",
    "amendments",
    "stay_segments",
    "inventory_claims",
    "pricing_revisions",
    "order_occupants",
    "collection_facts"
  ].map(async (table) => {
    const result = await db.selectFrom(table as keyof Database)
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }));
}

beforeEach(async () => {
  db = await resetTestDatabase();
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("8.3 completed-stay backfill", () => {
  it("atomically records a fully paid completed stay and closes inventory", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -5);
    const departureDate = addDays(businessDate, -2);
    const reason = "8.3 足额补录真实原因";
    const prepared = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "fully-paid",
      reason,
      collection: { amountMinor: "FULL", method: "WECOM", transactionReference: "WX-BACKFILL-FULL" }
    });

    const receipt = await previewAndConfirm(prepared.envelope, "backfill-fully-paid", reason);
    const orderId = receipt.result!.orderId as string;
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(receipt.result).toMatchObject({
      orderId,
      status: "CHECKED_OUT",
      effectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      backfill: {
        checkInAmendmentId: expect.stringMatching(/^amend_/),
        checkOutAmendmentId: expect.stringMatching(/^amend_/),
        settlementStatus: "SETTLED",
        collectedAmountMinor: prepared.contractAmountMinor,
        balanceDueMinor: 0
      }
    });
    expect(receipt.factRefs).toHaveLength(1);

    const [order, stay, amendments, claims, facts] = await Promise.all([
      db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("stays").selectAll().where("order_id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").selectAll().where("order_id", "=", orderId).orderBy("sequence").execute(),
      db.selectFrom("inventory_claims").selectAll().where("source_id", "in",
        db.selectFrom("stay_segments").select("id").where("stay_id", "=", receipt.result!.stayId as string)).execute(),
      db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).execute()
    ]);
    expect(order).toMatchObject({ status: "CHECKED_OUT", version: 3 });
    expect(stay.status).toBe("COMPLETED");
    expect(amendments.map((amendment) => amendment.amendment_type)).toEqual(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT"]);
    expect(amendments.every((amendment) => amendment.reason_code === "BACKFILL_STAY" && amendment.reason_note === reason)).toBe(true);
    expect(claims).toHaveLength(3);
    expect(claims.every((claim) => claim.active === false && claim.released_at !== null)).toBe(true);
    expect(facts).toEqual([expect.objectContaining({
      amount_minor: prepared.contractAmountMinor,
      net_effect_minor: prepared.contractAmountMinor,
      method: "WECOM",
      transaction_reference: "WX-BACKFILL-FULL"
    })]);
    const detail = await getOrderView(db, orderId);
    const serializedDetail = JSON.parse(fastJsonStringify(OrderDetailResponseSchema)(detail)) as typeof detail;
    expect(serializedDetail.amendments[0]?.payload).not.toHaveProperty("confirmedEffect");
    expect(await projectedStatus(orderId, demo.secondRoomId, arrivalDate, departureDate)).toBe("SETTLED");

    const overlapping = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "historical-overlap"
    });
    await expect(createCommandPreview(db, principal, overlapping.envelope, metadata("backfill-historical-overlap")))
      .rejects.toMatchObject({
        code: "INVENTORY_CONFLICT",
        statusCode: 409,
        message: "所选历史房源与已有住宿记录重叠，请先核对原订单",
        details: { orderId }
      });
  });

  it("projects zero and partial direct collections as arrears, then settles after an ordinary collection", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -6);
    const departureDate = addDays(businessDate, -3);

    const zero = await backfillEnvelope({
      unitId: demo.roomId,
      arrivalDate,
      departureDate,
      prefix: "zero",
      collection: { amountMinor: 0, method: "WECOM" }
    });
    const zeroReceipt = await previewAndConfirm(zero.envelope, "backfill-zero");
    const zeroOrderId = zeroReceipt.result!.orderId as string;
    expect(zeroReceipt.result).toMatchObject({
      status: "CHECKED_OUT",
      backfill: { settlementStatus: "ARREARS", collectedAmountMinor: 0, balanceDueMinor: zero.contractAmountMinor, collectionFactId: null }
    });
    expect(zeroReceipt.factRefs).toEqual([]);
    expect(await projectedStatus(zeroOrderId, demo.roomId, arrivalDate, departureDate)).toBe("ARREARS");

    const partial = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "partial",
      collection: { amountMinor: 10_000, method: "BANK_TRANSFER", transactionReference: "BANK-PARTIAL" }
    });
    const partialReceipt = await previewAndConfirm(partial.envelope, "backfill-partial");
    const partialOrderId = partialReceipt.result!.orderId as string;
    expect(partialReceipt.result).toMatchObject({
      backfill: { settlementStatus: "ARREARS", collectedAmountMinor: 10_000, balanceDueMinor: partial.contractAmountMinor - 10_000 }
    });
    expect(await projectedStatus(partialOrderId, demo.secondRoomId, arrivalDate, departureDate)).toBe("ARREARS");

    const settled = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId: partialOrderId,
        amountMinor: partial.contractAmountMinor - 10_000,
        method: "WECOM",
        transactionReference: "WX-PARTIAL-BALANCE"
      }
    }, "backfill-partial-balance");
    expect(settled.factRefs).toHaveLength(1);
    expect((await getOrderView(db, partialOrderId)).amounts.collectionDifference.minorUnits).toBe(0);
    expect(await projectedStatus(partialOrderId, demo.secondRoomId, arrivalDate, departureDate)).toBe("SETTLED");
  });

  it("closes free and complete external-channel stays without PMS collection facts", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -5);
    const departureDate = addDays(businessDate, -2);

    for (const { fixture, unitId } of [
      { fixture: await backfillEnvelope({ unitId: demo.roomId, arrivalDate, departureDate, prefix: "free", free: true }), unitId: demo.roomId },
      { fixture: await backfillEnvelope({
        unitId: demo.secondRoomId,
        arrivalDate,
        departureDate,
        prefix: "channel",
        channel: "CTRIP",
        targetAmountMinor: 32_400
      }), unitId: demo.secondRoomId }
    ]) {
      const receipt = await previewAndConfirm(fixture.envelope, `backfill-${fixture.envelope.input.quoteId as string}`);
      const orderId = receipt.result!.orderId as string;
      expect(receipt.result).toMatchObject({ status: "CHECKED_OUT", backfill: { settlementStatus: "SETTLED", collectedAmountMinor: 0, balanceDueMinor: 0, collectionFactId: null } });
      expect(receipt.factRefs).toEqual([]);
      expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toEqual([]);
      expect(await projectedStatus(orderId, unitId, arrivalDate, departureDate)).toBe("SETTLED");
    }

    const externalOrder = await db.selectFrom("orders").selectAll().where("channel_order_reference", "=", "CHANNEL-channel").executeTakeFirstOrThrow();
    const externalRevision = await db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", externalOrder.id).executeTakeFirstOrThrow();
    expect(externalOrder).toMatchObject({ booking_channel_code: "CTRIP", channel_order_reference: "CHANNEL-channel" });
    expect(externalRevision).toMatchObject({ pricing_basis: "CHANNEL_CONTRACT", current_contract_amount_minor: 32_400 });
  });

  it("persists cash collector and note as separate order-detail evidence", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -4);
    const departureDate = addDays(businessDate, -1);
    const prepared = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "cash",
      collection: { amountMinor: 10_000, method: "CASH", cashCollector: "前台小秦", note: "晚班现金收款" }
    });
    const receipt = await previewAndConfirm(prepared.envelope, "backfill-cash");
    const orderId = receipt.result!.orderId as string;
    const detail = await getOrderView(db, orderId);
    expect(detail.collectionFacts).toEqual([expect.objectContaining({
      method: "CASH",
      cash_collector: "前台小秦",
      note: "晚班现金收款",
      transaction_reference: null
    })]);

    await expect(db.insertInto("collection_facts").values({
      fact_id: newId("fact"),
      order_id: orderId,
      fact_type: "COLLECTION",
      amount_minor: 100,
      net_effect_minor: 100,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      note: "",
      transaction_reference: null,
      cash_collector: "前台小秦",
      pricing_revision_id: receipt.result!.pricingRevisionId as string,
      command_id: receipt.commandId
    }).execute()).rejects.toMatchObject({
      code: "23514",
      constraint: "collection_facts_backfill_cash_note_required"
    });
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toHaveLength(1);
  });

  it("rejects a cross-today backfill with no Preview or business writes and keeps the obsolete command closed", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -2);
    const departureDate = addDays(businessDate, 2);
    const prepared = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "cross-today",
    });
    const before = await Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    await expect(createCommandPreview(db, principal, prepared.envelope, metadata("backfill-cross-today"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 409,
      message: "跨今天的在住补录将在 8.4 开放"
    });
    const after = await Promise.all([
      db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    expect(after).toEqual(before);

    await expect(createCommandPreview(db, principal, {
      commandType: "BACKFILL_COMPLETED_STAY",
      input: { propertyId: demo.propertyId, orderId: "order_obsolete" }
    } as unknown as CommandEnvelope, metadata("obsolete-two-step-backfill"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Unsupported command type"
    });
  });

  it("requires the locked BACKFILL_STAY reason and prevents direct CREATE_ORDER checkout bypass", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -4);
    const departureDate = addDays(businessDate, -1);
    const reason = "锁定补录原因";
    const prepared = await backfillEnvelope({ unitId: demo.secondRoomId, arrivalDate, departureDate, prefix: "reason", reason });
    const preview = await createCommandPreview(db, principal, prepared.envelope, metadata("backfill-reason-preview"));

    const rejected = await confirmCommandPreview(db, principal, preview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "BACKFILL_STAY", note: "被确认时替换的原因" }
    }, metadata("backfill-reason-confirm"));
    expect(rejected).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false, error: { code: "CONFIRMATION_MISMATCH" } });
    expect(await db.selectFrom("orders").select("id").where("primary_guest_snapshot", "@>", JSON.stringify({ nickname: "补录 reason" })).execute()).toEqual([]);

    const futureArrival = addDays(businessDate, 1);
    const futureDeparture = addDays(businessDate, 2);
    const normalQuote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate: futureArrival,
      departureDate: futureDeparture,
      pricingPolicyVersionId: pricingPolicy(futureArrival, futureDeparture)
    });
    const normal = await previewAndConfirm({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: normalQuote.quoteId,
        primaryGuest: { fullName: "普通订单", nickname: "普通" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: normalQuote.currentContractAmount.minorUnits
      }
    }, "ordinary-order");
    const orderId = normal.result!.orderId as string;
    const commandId = normal.commandId;
    expect(normal.result).not.toHaveProperty("effectHash");
    await expect(db.insertInto("amendments").values({
      id: newId("amend"),
      order_id: orderId,
      sequence: 2,
      amendment_type: "CHECK_OUT",
      reason_code: "BACKFILL_STAY",
      reason_note: "试图绕过原子补录守卫",
      prior_version: 1,
      new_version: 2,
      payload: {
        fromStatus: "RESERVED",
        toStatus: "CHECKED_OUT",
        inventoryUnitId: demo.roomId,
        businessDate: futureDeparture,
        effectiveDate: futureDeparture,
        recordingMode: "ON_SCHEDULE"
      },
      command_id: commandId
    }).execute()).rejects.toMatchObject({ code: "23514", constraint: "amendments_backfill_create_order_checkout_chain" });
  });

  it("replays an identical confirmation without duplicating the completed stay or collection", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -4);
    const departureDate = addDays(businessDate, -1);
    const reason = "幂等补录原因";
    const prepared = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "idempotent",
      reason,
      collection: { amountMinor: "FULL", method: "WECOM", transactionReference: "WX-IDEMPOTENT" }
    });
    const preview = await createCommandPreview(db, principal, prepared.envelope, metadata("backfill-idempotent-preview"));
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER" as const,
      confirmation: true as const,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "BACKFILL_STAY", note: reason }
    };
    const confirmMetadata = metadata("backfill-idempotent-confirm");
    const first = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
    const replay = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
    expect(replay).toEqual(first);
    expect(first.result?.effectHash).toBe(preview.preview.effectHash);
    const orderId = first.result!.orderId as string;
    expect(await db.selectFrom("orders").select("id").where("id", "=", orderId).execute()).toHaveLength(1);
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", orderId).execute()).toHaveLength(3);
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toHaveLength(1);
  });

  it("serializes concurrent confirmations for the same historical inventory", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -5);
    const departureDate = addDays(businessDate, -2);
    const reason = "并发补录原因";
    const [left, right] = await Promise.all([
      backfillEnvelope({
        unitId: demo.secondRoomId,
        arrivalDate,
        departureDate,
        prefix: "concurrent-left",
        reason,
        collection: { amountMinor: "FULL", method: "WECOM", transactionReference: "WX-CONCURRENT-LEFT" }
      }),
      backfillEnvelope({
        unitId: demo.secondRoomId,
        arrivalDate,
        departureDate,
        prefix: "concurrent-right",
        reason,
        collection: { amountMinor: "FULL", method: "WECOM", transactionReference: "WX-CONCURRENT-RIGHT" }
      })
    ]);
    const [leftPreview, rightPreview] = await Promise.all([
      createCommandPreview(db, principal, left.envelope, metadata("backfill-concurrent-left-preview")),
      createCommandPreview(db, principal, right.envelope, metadata("backfill-concurrent-right-preview"))
    ]);
    const confirmation = (effectHash: string) => ({
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER" as const,
      confirmation: true as const,
      expectedEffectHash: effectHash,
      reason: { code: "BACKFILL_STAY", note: reason }
    });
    const receipts = await Promise.all([
      confirmCommandPreview(db, principal, leftPreview.preview.previewId, confirmation(leftPreview.preview.effectHash), metadata("backfill-concurrent-left-confirm")),
      confirmCommandPreview(db, principal, rightPreview.preview.previewId, confirmation(rightPreview.preview.effectHash), metadata("backfill-concurrent-right-confirm"))
    ]);
    const executed = receipts.filter((receipt) => receipt.executionStatus === "EXECUTED");
    const rejected = receipts.filter((receipt) => receipt.executionStatus === "NOT_EXECUTED");
    expect(executed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "INVENTORY_CONFLICT" } },
      resourceRefs: [],
      factRefs: []
    });
    const orderId = executed[0]!.result!.orderId as string;
    const orders = await db.selectFrom("orders").select("id")
      .where((expression) => expression.or([
        expression("primary_guest_snapshot", "@>", JSON.stringify({ nickname: "补录 concurrent-left" })),
        expression("primary_guest_snapshot", "@>", JSON.stringify({ nickname: "补录 concurrent-right" }))
      ])).execute();
    expect(orders).toEqual([{ id: orderId }]);
    expect(await db.selectFrom("amendments").select("id").where("order_id", "=", orderId).execute()).toHaveLength(3);
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toHaveLength(1);
  });

  it("rolls back every business fact when receipt persistence fails", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -4);
    const departureDate = addDays(businessDate, -1);
    const prepared = await backfillEnvelope({
      unitId: demo.secondRoomId,
      arrivalDate,
      departureDate,
      prefix: "rollback",
      collection: { amountMinor: "FULL", method: "WECOM", transactionReference: "WX-ROLLBACK" }
    });
    const preview = await createCommandPreview(db, principal, prepared.envelope, metadata("backfill-rollback-preview"));
    const beforeBusinessArtifacts = await lodgingArtifactCounts();
    await sql`
      CREATE FUNCTION fail_completed_stay_backfill_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.result IS NOT NULL AND NEW.result ? 'backfill' THEN
          RAISE EXCEPTION 'forced completed-stay backfill receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_completed_stay_backfill_receipt
      BEFORE INSERT ON command_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_completed_stay_backfill_receipt();
    `.execute(db);
    try {
      const rejected = await confirmCommandPreview(db, principal, preview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CREATE_ORDER",
        confirmation: true,
        expectedEffectHash: preview.preview.effectHash,
        reason: { code: "BACKFILL_STAY", note: "工作人员漏录，现按真实凭据补录" }
      }, metadata("backfill-rollback-confirm"));
      expect(rejected).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "COMMAND_INTERRUPTED" }
      });
      expect(rejected.factRefs).toEqual([]);
      expect(rejected.resourceRefs).toEqual([]);
      const matchingOrders = await db.selectFrom("orders")
        .select("id")
        .where("primary_guest_snapshot", "@>", JSON.stringify({ nickname: "补录 rollback" }))
        .execute();
      expect(matchingOrders).toEqual([]);
      expect(await db.selectFrom("collection_facts").select("fact_id").where("transaction_reference", "=", "WX-ROLLBACK").execute()).toEqual([]);
      expect(await lodgingArtifactCounts()).toEqual(beforeBusinessArtifacts);
    } finally {
      await sql`DROP TRIGGER fail_completed_stay_backfill_receipt ON command_receipts`.execute(db);
      await sql`DROP FUNCTION fail_completed_stay_backfill_receipt()`.execute(db);
    }
  });
});
