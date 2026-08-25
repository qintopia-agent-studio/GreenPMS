import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { newId, parseLocalDate } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.STAY_DATE_CHANGE_LIFECYCLE_CORRUPTION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stay_date_change_lifecycle_corruption";

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
  return {
    idempotencyKey: `${prefix}-${sequence}`,
    correlationId: `${prefix}-${sequence}`
  };
}

async function withOrdinaryOrderCreationClock<T>(arrivalDate: string, operation: () => Promise<T>): Promise<T> {
  const businessDate = await propertyLocalToday(db, demo.propertyId);
  return arrivalDate < businessDate
    ? withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00.000Z`), operation)
    : operation();
}

async function preview(envelope: CommandEnvelope, prefix: string) {
  return createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
}

async function execute(envelope: CommandEnvelope, prefix: string) {
  const prepared = await preview(envelope, prefix);
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: prepared.preview.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: prepared.preview.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "LIFECYCLE_CORRUPTION_FIXTURE", note: "构造日期变更生命周期测试事实" }
  }, metadata(`${prefix}-confirm`));
}

async function createReservedOrder(
  prefix: string,
  arrivalDate: string,
  departureDate: string,
  pricingPolicyVersionId: string = demo.transientPolicyId
) {
  return withOrdinaryOrderCreationClock(arrivalDate, async () => {
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId
    });
    const receipt = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: prefix, nickname: prefix },
        bookingChannelCode: "WECOM",
        channelOrderReference: null
      }
    }, `${prefix}-create`);
    return receipt.result!.orderId as string;
  });
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
      reason_code: "LIFECYCLE_CORRUPTION_FIXTURE",
      reason_note: "构造同月历史在住事实",
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
    await trx.updateTable("orders")
      .set({ status: "CHECKED_IN", version: order.version + 1, updated_at: new Date() })
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    await trx.updateTable("stays").set({ status: "IN_HOUSE" }).where("id", "=", stay.id).executeTakeFirstOrThrow();
  });
}

async function businessSnapshot(orderId: string) {
  const stayId = db.selectFrom("stays").select("id").where("order_id", "=", orderId);
  const segmentIds = db.selectFrom("stay_segments").select("id").where("stay_id", "in", stayId);
  const [
    order,
    stay,
    amendments,
    segments,
    revisions,
    claims,
    coverage,
    ledger,
    facts,
    roomStatusRevision,
    commandExecutions,
    commandPreviews,
    commandReceipts,
    auditEntries
  ] = await Promise.all([
    db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("stays").selectAll().where("order_id", "=", orderId).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").selectAll().where("order_id", "=", orderId).orderBy("sequence").execute(),
    db.selectFrom("stay_segments").selectAll().where("stay_id", "in", stayId).orderBy("sequence").execute(),
    db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no").execute(),
    db.selectFrom("inventory_claims").selectAll().where("source_type", "=", "ORDER_SEGMENT")
      .where("source_id", "in", segmentIds).orderBy("service_date").orderBy("id").execute(),
    db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute(),
    db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute(),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute(),
    db.selectFrom("room_status_revisions").selectAll().where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select("id").orderBy("id").execute(),
    db.selectFrom("command_previews").select("id").orderBy("id").execute(),
    db.selectFrom("command_receipts").select("id").orderBy("id").execute(),
    db.selectFrom("audit_entries").select("id").orderBy("id").execute()
  ]);
  return JSON.parse(JSON.stringify({
    order,
    stay,
    amendments,
    segments,
    revisions,
    claims,
    coverage,
    ledger,
    facts,
    roomStatusRevision,
    commandExecutions,
    commandPreviews,
    commandReceipts,
    auditEntries
  }));
}

async function expectPreviewFailsClosed(
  orderId: string,
  envelope: CommandEnvelope,
  prefix: string,
  message: string
) {
  const before = await businessSnapshot(orderId);
  await expect(preview(envelope, prefix)).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    message
  });
  expect(await businessSnapshot(orderId)).toEqual(before);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe.sequential("4.2 stay-date change lifecycle corruption guards", () => {
  it("rejects RESCHEDULE_STAY when a RESERVED order has an IN_HOUSE Stay", async () => {
    const orderId = await createReservedOrder("lifecycle-status", "2028-09-10", "2028-09-12");
    await db.updateTable("stays").set({ status: "IN_HOUSE" }).where("order_id", "=", orderId).executeTakeFirstOrThrow();

    await expectPreviewFailsClosed(orderId, {
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-09-11",
        newDepartureDate: "2028-09-13"
      }
    }, "lifecycle-status", "订单状态与住宿状态不一致");
  });

  it("rejects EXTEND_STAY when the current segment supersession chain is corrupt", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const orderId = await createReservedOrder(
      "lifecycle-segment",
      shiftDate(businessDate, -3),
      shiftDate(businessDate, -1),
      demo.publicPricingPolicyId
    );
    await markHistoricalOrderInHouse(orderId, shiftDate(businessDate, -3));
    await execute({
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: shiftDate(businessDate, 1) }
    }, "lifecycle-segment-first-extension");

    const currentSegment = await db.selectFrom("stay_segments")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select("stay_segments.id")
      .where("stays.order_id", "=", orderId)
      .orderBy("stay_segments.sequence", "desc")
      .executeTakeFirstOrThrow();
    await sql`ALTER TABLE stay_segments DISABLE TRIGGER stay_segments_append_only`.execute(db);
    try {
      await db.updateTable("stay_segments")
        .set({ supersedes_segment_id: currentSegment.id })
        .where("id", "=", currentSegment.id)
        .executeTakeFirstOrThrow();
    } finally {
      await sql`ALTER TABLE stay_segments ENABLE TRIGGER stay_segments_append_only`.execute(db);
    }

    await expectPreviewFailsClosed(orderId, {
      commandType: "EXTEND_STAY",
      input: { propertyId: demo.propertyId, orderId, newDepartureDate: shiftDate(businessDate, 2) }
    }, "lifecycle-segment-corrupt", "订单住宿安排 supersession 链或变更类型损坏");
  });

  it("rejects RESCHEDULE_STAY when current_revision_id points behind the latest revision", async () => {
    const orderId = await createReservedOrder("lifecycle-revision", "2028-10-10", "2028-10-12");
    await execute({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-10-11",
        newDepartureDate: "2028-10-13"
      }
    }, "lifecycle-revision-first-reschedule");
    const firstRevision = await db.selectFrom("pricing_revisions")
      .select("id")
      .where("order_id", "=", orderId)
      .orderBy("revision_no")
      .executeTakeFirstOrThrow();
    await db.updateTable("orders").set({ current_revision_id: firstRevision.id }).where("id", "=", orderId).executeTakeFirstOrThrow();

    await expectPreviewFailsClosed(orderId, {
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-10-12",
        newDepartureDate: "2028-10-14"
      }
    }, "lifecycle-revision-corrupt", "订单当前计价版本指针与最新计价版本不一致");
  });

  it("rejects RESCHEDULE_STAY when order version and amendment chain cardinality diverge", async () => {
    const orderId = await createReservedOrder("lifecycle-amendment", "2028-11-10", "2028-11-12");
    await db.updateTable("orders").set({ version: 2 }).where("id", "=", orderId).executeTakeFirstOrThrow();

    await expectPreviewFailsClosed(orderId, {
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: "2028-11-11",
        newDepartureDate: "2028-11-13"
      }
    }, "lifecycle-amendment-corrupt", "订单版本与不可变变更记录数量不一致");
  });
});
