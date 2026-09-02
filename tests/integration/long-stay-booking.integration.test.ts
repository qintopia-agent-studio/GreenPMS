import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, QuoteReadDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  executeQuoteCommand,
  findCommandResult,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetTestDatabase } from "../helpers/database.ts";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

let db: Kysely<Database>;
let sequence = 0;

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

function quoteInput(arrivalDate: string, departureDate: string) {
  return {
    propertyId: demo.propertyId,
    inventoryUnitId: demo.roomId,
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId
  };
}

function orderEnvelope(quote: QuoteReadDto, guestName: string): CommandEnvelope {
  return {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: guestName, nickname: guestName },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  };
}

async function quotePreviewConfirm(arrivalDate: string, departureDate: string, prefix: string) {
  return withOrdinaryOrderCreationClock(arrivalDate, async () => {
    const quoted = await executeQuoteCommand(db, principal, quoteInput(arrivalDate, departureDate), metadata(`${prefix}-quote`));
    const prepared = await createCommandPreview(
      db,
      principal,
      orderEnvelope(quoted.quote, `住客-${prefix}`),
      metadata(`${prefix}-preview`)
    );
    const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata(`${prefix}-confirm`));
    return { quoted, prepared, receipt };
  });
}

async function completeArtifactCounts() {
  const rows = await Promise.all([
    db.selectFrom("quotes").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stay_segments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("order_occupants").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("room_status_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return rows.map((row) => Number(row.count));
}

async function businessArtifactCounts() {
  const rows = await Promise.all([
    db.selectFrom("quotes").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stay_segments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("order_occupants").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("room_status_revisions").select("revision").where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow()
  ]);
  return rows.map((row, index) => index === rows.length - 1
    ? String((row as { revision: string }).revision)
    : Number((row as { count: number }).count));
}

async function protocolArtifactCounts() {
  const rows = await Promise.all([
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return rows.map((row) => Number(row.count));
}

beforeEach(async () => {
  db = await resetTestDatabase();
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe.sequential("long-stay Quote, Preview, and Confirm on PostgreSQL", () => {
  it("creates a conflict-free 117-night order through the complete command chain", async () => {
    const result = await quotePreviewConfirm("2026-07-26", "2026-11-20", "117-night");

    expect(result.quoted.receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(result.quoted.quote).toMatchObject({
      stayType: "CUSTOM",
      arrivalDate: "2026-07-26",
      departureDate: "2026-11-20"
    });
    expect(result.quoted.quote.cashLines).toEqual([
      expect.objectContaining({
        lineKind: "STAY_TOTAL",
        arrivalDate: "2026-07-26",
        departureDate: "2026-11-20",
        description: "住宿费合计：117 夜按 30 夜档折算",
        pricingSummary: expect.stringContaining("117 夜按 30 夜档")
      })
    ]);
    expect(JSON.stringify(result.quoted.quote)).not.toContain("numeratorMinor");
    expect(result.prepared.receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(result.receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const orderId = result.receipt.result?.orderId;
    const segmentId = result.receipt.result?.segmentId;
    expect(typeof orderId).toBe("string");
    expect(typeof segmentId).toBe("string");
    await expect(db.selectFrom("orders").select(["arrival_date", "departure_date"])
      .where("id", "=", orderId as string).executeTakeFirstOrThrow())
      .resolves.toEqual({ arrival_date: "2026-07-26", departure_date: "2026-11-20" });
    await expect(db.selectFrom("stay_segments").select(["arrival_date", "departure_date"])
      .where("id", "=", segmentId as string).executeTakeFirstOrThrow())
      .resolves.toEqual({ arrival_date: "2026-07-26", departure_date: "2026-11-20" });
    expect(await db.selectFrom("inventory_claims").select("service_date")
      .where("source_id", "=", segmentId as string).orderBy("service_date").execute())
      .toHaveLength(117);
  });

  it("rejects a conflict after the visible 30-night window with exact dates and zero writes", async () => {
    await quotePreviewConfirm("2026-09-15", "2026-09-16", "remote-blocker");
    const before = await completeArtifactCounts();

    await expect(executeQuoteCommand(
      db,
      principal,
      quoteInput("2026-07-26", "2026-11-20"),
      metadata("remote-conflict-quote")
    )).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
      message: expect.stringContaining("2026-09-15 至 2026-09-16"),
      details: {
        inventoryUnitCode: expect.any(String),
        overlapStartDate: "2026-09-15",
        overlapEndDate: "2026-09-16"
      }
    });

    expect(await completeArtifactCounts()).toEqual(before);
  });

  it("accepts exactly 366 nights and rejects 367 nights without another artifact", async () => {
    const accepted = await executeQuoteCommand(
      db,
      principal,
      quoteInput("2027-01-01", "2028-01-02"),
      metadata("366-night-quote")
    );
    expect(accepted.quote).toMatchObject({
      stayType: "CUSTOM",
      arrivalDate: "2027-01-01",
      departureDate: "2028-01-02"
    });
    expect(accepted.quote.cashLines).toEqual([
      expect.objectContaining({
        lineKind: "STAY_TOTAL",
        description: "住宿费合计：366 夜按 30 夜档折算",
        pricingSummary: expect.stringContaining("366 夜按 30 夜档")
      })
    ]);
    expect(JSON.stringify(accepted.quote)).not.toContain("numeratorMinor");
    const before = await completeArtifactCounts();

    await expect(executeQuoteCommand(
      db,
      principal,
      quoteInput("2027-01-01", "2028-01-03"),
      metadata("367-night-quote")
    )).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Stay cannot exceed 366 service nights"
    });

    expect(await completeArtifactCounts()).toEqual(before);
  });

  it("rejects Confirm when a remote night is occupied after Preview with zero extra business writes", async () => {
    const quoted = await executeQuoteCommand(
      db,
      principal,
      quoteInput("2026-07-26", "2026-11-20"),
      metadata("stale-remote-quote")
    );
    const prepared = await withPropertyClockForTesting(new Date("2026-07-26T12:00:00.000Z"), () => createCommandPreview(
      db,
      principal,
      orderEnvelope(quoted.quote, "远端并发住客"),
      metadata("stale-remote-preview")
    ));
    await quotePreviewConfirm("2026-10-15", "2026-10-16", "remote-winner");

    const beforeBusiness = await businessArtifactCounts();
    const beforeProtocol = await protocolArtifactCounts();
    const confirmationMetadata = metadata("stale-remote-confirm");
    const rejected = await withPropertyClockForTesting(new Date("2026-07-26T12:00:00.000Z"), () => confirmCommandPreview(
      db,
      principal,
      prepared.preview.previewId,
      {
        propertyId: demo.propertyId,
        commandType: "CREATE_ORDER",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "CREATE_STANDARD_ORDER", note: "" }
      },
      confirmationMetadata
    ));

    expect(rejected).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "INVENTORY_CONFLICT" } }
    });
    expect(await businessArtifactCounts()).toEqual(beforeBusiness);
    const afterProtocol = await protocolArtifactCounts();
    expect(afterProtocol).toEqual(beforeProtocol.map((count) => count + 1));
    await expect(findCommandResult(
      db,
      principal,
      demo.propertyId,
      "CREATE_ORDER",
      confirmationMetadata.idempotencyKey
    )).resolves.toEqual(rejected);
    await expect(db.selectFrom("command_previews").select("status")
      .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow())
      .resolves.toEqual({ status: "EXPIRED" });
  });
});
