import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  propertyLocalToday,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.RECEIPT_REFERENCES_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_receipt_references";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

const contractId = "member_receipt_references";
const activeLotId = "lot_receipt_references_active";
const expiringLotId = "lot_receipt_references_expiring";

let db: Kysely<Database>;
let sequence = 0;

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function metadata(prefix: string) {
  sequence += 1;
  return {
    idempotencyKey: `receipt-refs-${prefix}-${sequence}`,
    correlationId: `receipt-refs-${prefix}-${sequence}`
  };
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
      : { code: "RECEIPT_REFERENCE_TEST", note: `Verify permanent references for ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMemberOrder(prefix: string, arrivalDate: string, departureDate: string) {
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.transientPolicyId,
    memberContractId: contractId
  });
  const receipt = await previewAndConfirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Receipt reference guest ${prefix}`, nickname: `Receipt ${prefix}` }
    }
  }, `${prefix}-create`);
  const orderId = receipt.result?.orderId;
  if (typeof orderId !== "string") throw new Error("CREATE_ORDER receipt did not contain orderId");
  const coverage = await db.selectFrom("coverage_items")
    .select(["id", "service_date", "status"])
    .where("order_id", "=", orderId)
    .orderBy("service_date")
    .execute();
  return { receipt, orderId, coverage };
}

async function fulfillmentDatePair() {
  await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
  const arrivalDate = await propertyLocalToday(db, demo.propertyId);
  await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
  const departureDate = await propertyLocalToday(db, demo.propertyId);
  expect(departureDate > arrivalDate).toBe(true);
  await db.updateTable("properties").set({ timezone: "Pacific/Pago_Pago" }).where("id", "=", demo.propertyId).execute();
  return { arrivalDate, departureDate };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} was not persisted as a string array`);
  }
  return value as string[];
}

async function expectExactLedgerReferences(options: {
  receipt: ReceiptDto;
  entryTypes: Database["entitlement_ledger"]["entry_type"][];
  coverageResourceIds: string[];
  resourceRefs: string[];
}) {
  const persisted = await db.selectFrom("command_receipts")
    .select(["command_id", "resource_refs", "fact_refs"])
    .where("id", "=", options.receipt.receiptId)
    .executeTakeFirstOrThrow();
  const ledger = await db.selectFrom("entitlement_ledger")
    .select(["fact_id", "entry_type", "coverage_id", "command_id"])
    .where("command_id", "=", options.receipt.commandId)
    .orderBy("fact_id")
    .execute();

  const ledgerFactIds = ledger.map((row) => row.fact_id);
  const ledgerCoverageIds = [...new Set(ledger.flatMap((row) => row.coverage_id ? [row.coverage_id] : []))];
  const referencedCoverage = options.receipt.resourceRefs.filter((id) => options.coverageResourceIds.includes(id));

  expect(options.receipt.businessCommitted).toBe(true);
  expect(options.receipt.executionStatus).toBe("EXECUTED");
  expect(persisted.command_id).toBe(options.receipt.commandId);
  expect(sorted(stringArray(persisted.fact_refs, "fact_refs"))).toEqual(sorted(options.receipt.factRefs));
  expect(sorted(stringArray(persisted.resource_refs, "resource_refs"))).toEqual(sorted(options.receipt.resourceRefs));
  expect(sorted(options.receipt.factRefs)).toEqual(sorted(ledgerFactIds));
  expect(ledger.map((row) => row.entry_type).sort()).toEqual([...options.entryTypes].sort());
  expect(ledger.every((row) => row.command_id === options.receipt.commandId)).toBe(true);
  expect(sorted(ledgerCoverageIds)).toEqual(sorted(options.coverageResourceIds));
  expect(sorted(referencedCoverage)).toEqual(sorted(options.coverageResourceIds));
  expect(sorted(options.receipt.resourceRefs)).toEqual(sorted(options.resourceRefs));
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
  await db.insertInto("members").values({
    id: "member_profile_receipt_references",
    identity_card_number: "TEST-RECEIPT-REFERENCES-ID",
    full_name: "Receipt Reference Member",
    phone: "13800000002",
    wechat: "receipt-reference-member"
  }).execute();
  await db.insertInto("member_contracts").values({
    id: contractId,
    property_id: demo.propertyId,
    member_id: "member_profile_receipt_references",
    member_name: "Receipt Reference Member",
    status: "ACTIVE",
    valid_from: "2026-01-01",
    valid_until: "2035-12-31",
    version: 1
  }).execute();
  await db.insertInto("entitlement_lots").values([
    {
      id: activeLotId,
      contract_id: contractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 12,
      expires_on: "2035-12-31",
      version: 1
    },
    {
      id: expiringLotId,
      contract_id: contractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 3,
      expires_on: "2026-01-01",
      version: 1
    }
  ]).execute();
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe.sequential("Receipt permanent references for member entitlement facts", () => {
  it("ties HOLD and RELEASE facts and coverage resources to their exact commands", async () => {
    const created = await createMemberOrder("release", "2028-03-01", "2028-03-03");
    const coverageIds = created.coverage.map((item) => item.id);
    expect(created.coverage.map((item) => item.status)).toEqual(["HELD", "HELD"]);
    await expectExactLedgerReferences({
      receipt: created.receipt,
      entryTypes: ["HOLD", "HOLD"],
      coverageResourceIds: coverageIds,
      resourceRefs: [
        created.orderId,
        created.receipt.result!.stayId as string,
        created.receipt.result!.segmentId as string,
        created.receipt.result!.pricingRevisionId as string,
        ...((created.receipt.result!.occupants as Array<{ id: string }>).map((occupant) => occupant.id)),
        ...coverageIds
      ]
    });

    const cancelled = await previewAndConfirm({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "release-cancel");
    await expectExactLedgerReferences({
      receipt: cancelled,
      entryTypes: ["RELEASE", "RELEASE"],
      coverageResourceIds: coverageIds,
      resourceRefs: [created.orderId, cancelled.result!.amendmentId as string, ...coverageIds]
    });
  });

  it("ties CONSUME facts and coverage resources to the CHECK_IN command exactly once", async () => {
    const { arrivalDate, departureDate } = await fulfillmentDatePair();
    const created = await createMemberOrder("consume", arrivalDate, departureDate);
    const coverageIds = created.coverage.map((item) => item.id);
    const checkedIn = await previewAndConfirm({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "consume-check-in");

    await expectExactLedgerReferences({
      receipt: checkedIn,
      entryTypes: created.coverage.map(() => "CONSUME" as const),
      coverageResourceIds: coverageIds,
      resourceRefs: [created.orderId, checkedIn.result!.amendmentId as string, ...coverageIds]
    });

    await db.updateTable("properties").set({ timezone: "Pacific/Kiritimati" }).where("id", "=", demo.propertyId).execute();
    const checkedOut = await previewAndConfirm({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "consume-check-out");
    expect(checkedOut.factRefs).toEqual([]);
  });

  it("keeps retained and released coverage references exact when rescheduling", async () => {
    const created = await createMemberOrder("shorten", "2028-05-01", "2028-05-04");
    const allCoverageIds = created.coverage.map((item) => item.id);
    const releasedCoverageIds = created.coverage
      .filter((item) => item.service_date >= "2028-05-02")
      .map((item) => item.id);
    const shortened = await previewAndConfirm({
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        newArrivalDate: "2028-05-01",
        newDepartureDate: "2028-05-02"
      }
    }, "shorten");
    const releasedClaimIds = await db.selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select("claim.id")
      .where("stay.order_id", "=", created.orderId)
      .where("claim.active", "=", false)
      .where("claim.service_date", ">=", "2028-05-02")
      .orderBy("claim.id")
      .execute();

    await expectExactLedgerReferences({
      receipt: shortened,
      entryTypes: ["RELEASE", "RELEASE"],
      coverageResourceIds: releasedCoverageIds,
      resourceRefs: [
        created.orderId,
        shortened.result!.stayId as string,
        shortened.result!.amendmentId as string,
        shortened.result!.staySegmentId as string,
        shortened.result!.pricingRevisionId as string,
        ...releasedClaimIds.map((claim) => claim.id),
        ...allCoverageIds
      ]
    });
  });

  it.each([
    {
      label: "ADJUST",
      envelope: {
        commandType: "ADJUST_MEMBER_ENTITLEMENT",
        input: {
          propertyId: demo.propertyId,
          entitlementLotId: activeLotId,
          quantityDelta: 2,
          adjustmentReason: "Receipt reference acceptance adjustment"
        }
      } satisfies CommandEnvelope,
      lotId: activeLotId,
      entryType: "ADJUST" as const
    },
    {
      label: "EXPIRE",
      envelope: {
        commandType: "EXPIRE_MEMBER_ENTITLEMENT",
        input: { propertyId: demo.propertyId, entitlementLotId: expiringLotId, asOfDate: "2026-01-02" }
      } satisfies CommandEnvelope,
      lotId: expiringLotId,
      entryType: "EXPIRE" as const
    }
  ])("ties $label fact to its command with no coverage reference", async ({ label, envelope, lotId, entryType }) => {
    const receipt = await previewAndConfirm(envelope, label.toLowerCase());
    await expectExactLedgerReferences({
      receipt,
      entryTypes: [entryType],
      coverageResourceIds: [],
      resourceRefs: [contractId, lotId]
    });
  });
});
