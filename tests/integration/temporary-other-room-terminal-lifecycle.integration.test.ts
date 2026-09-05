import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto, StoredQuoteDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  executeQuoteCommand,
  findCommandResult,
  getReceipt,
  getOrderView,
  propertyLocalToday,
  projectStoredPreviewForRead,
  withMutablePropertyWallClockForTesting,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.TEMPORARY_OTHER_ROOM_TERMINAL_LIFECYCLE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_temporary_other_room_terminal_lifecycle";

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

function clockInstant(date: string, time = "12:00:00"): Date {
  return new Date(`${date}T${time}.000Z`);
}

async function atPropertyClock<T>(date: string, operation: () => Promise<T>, time = "12:00:00"): Promise<T> {
  const instant = clockInstant(date, time);
  return withMutablePropertyWallClockForTesting(instant, () =>
    withPropertyClockForTesting(instant, () => operation()));
}

function reasonFor(envelope: CommandEnvelope, prefix: string) {
  if (envelope.commandType === "CREATE_ORDER") {
    return { code: "TEMPORARY_OTHER_ROOM", note: `现场安排 ${prefix}` };
  }
  if (envelope.commandType === "COMPLETE_STAY") {
    return { code: "COMPLETE_STAY", note: String(envelope.input.reasonNote ?? "") };
  }
  if (envelope.commandType === "CORRECT_ORDER_OCCUPANT") {
    return { code: "DATA_ENTRY_CORRECTION", note: "人工核对临时安排住宿人资料后更正" };
  }
  return { code: "TEMPORARY_OTHER_ROOM_LIFECYCLE", note: `核对 ${prefix}` };
}

async function preview(envelope: CommandEnvelope, prefix: string, actor: AuthPrincipal = principal) {
  return createCommandPreview(db, actor, envelope, metadata(`${prefix}-preview`));
}

async function confirm(
  envelope: CommandEnvelope,
  prefix: string,
  actor: AuthPrincipal = principal
): Promise<ReceiptDto> {
  const prepared = await preview(envelope, prefix, actor);
  const confirmation = {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true as const,
    expectedEffectHash: prepared.preview.effectHash,
    reason: reasonFor(envelope, prefix)
  };
  return confirmCommandPreview(db, actor, prepared.preview.previewId, confirmation, metadata(`${prefix}-confirm`));
}

async function confirmWithReplayAndRecovery(
  envelope: CommandEnvelope,
  prefix: string,
  actor: AuthPrincipal = principal,
  created?: { arrangement: Arrangement; createAmendmentId: string }
): Promise<ReceiptDto> {
  const prepared = await preview(envelope, prefix, actor);
  const confirmationMetadata = metadata(`${prefix}-confirm`);
  const confirmation = {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true as const,
    expectedEffectHash: prepared.preview.effectHash,
    reason: reasonFor(envelope, prefix)
  };
  const receipt = await confirmCommandPreview(db, actor, prepared.preview.previewId, confirmation, confirmationMetadata);
  expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({
    executionStatus: "EXECUTED",
    businessCommitted: true
  });
  if (created) {
    expectTemporaryEvidence(receipt.result as Record<string, unknown> | null, created);
  }
  const replay = await confirmCommandPreview(db, actor, prepared.preview.previewId, confirmation, confirmationMetadata);
  expect(replay).toEqual(receipt);
  const recoveredReceipt = await getReceipt(db, actor, receipt.receiptId);
  expect(recoveredReceipt).toMatchObject({
    receiptId: receipt.receiptId,
    commandId: receipt.commandId,
    executionStatus: "EXECUTED",
    businessCommitted: true
  });
  const recoveredCommandResult = await findCommandResult(
    db,
    actor,
    envelope.input.propertyId as string,
    envelope.commandType,
    confirmationMetadata.idempotencyKey
  );
  expect(recoveredCommandResult).toMatchObject({
    receiptId: receipt.receiptId,
    commandId: receipt.commandId,
    executionStatus: "EXECUTED",
    businessCommitted: true
  });
  if (!("result" in recoveredCommandResult)) {
    throw new Error("Recovered command result did not contain committed business evidence");
  }
  if (created) {
    expectTemporaryEvidence(recoveredReceipt.result as Record<string, unknown> | null, created);
    expectTemporaryEvidence(recoveredCommandResult.result as Record<string, unknown> | null, created);
  }
  return receipt;
}

async function createMember(memberId: string) {
  memberSequence += 1;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `TEMP-TERMINAL-${memberSequence}`,
    nickname: `Terminal ${memberSequence}`,
    full_name: `Temporary terminal ${memberSequence}`,
    phone: `138${String(memberSequence).padStart(8, "0")}`,
    wechat: `temporary-terminal-${memberSequence}`
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
    input: { propertyId: demo.propertyId, membershipOrderId, amountMinor: 1, transactionReference: `TERMINAL-${prefix}` }
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
}): Promise<{ orderId: string; arrangement: Arrangement; createAmendmentId: string; actualUnitId: string; occupantId: string }> {
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
  expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({
    businessCommitted: true,
    result: {
      temporaryOtherRoomArrangement: arrangement
    }
  });
  const orderId = receipt.result!.orderId as string;
  const createAmendment = await db.selectFrom("amendments")
    .select(["id", "payload"])
    .where("order_id", "=", orderId)
    .where("amendment_type", "=", "CREATE_ORDER")
    .executeTakeFirstOrThrow();
  const occupantId = ((receipt.result!.occupants as Array<{ id: string }>)[0]!).id;
  expect(createAmendment.payload).toMatchObject({ temporaryOtherRoomArrangement: arrangement });
  return { orderId, arrangement, createAmendmentId: createAmendment.id, actualUnitId, occupantId };
}

async function createTemporaryOrderAt(options: {
  memberId: string;
  setupDate: string;
  arrivalDate: string;
  departureDate: string;
  unitCode: string;
  prefix: string;
}) {
  return atPropertyClock(options.setupDate, async () => {
    await activateProduct(options.memberId, options.prefix);
    return createTemporaryOrder(options);
  });
}

async function creationEvidence(orderId: string) {
  const create = await db.selectFrom("amendments")
    .select(["id", "payload"])
    .where("order_id", "=", orderId)
    .where("amendment_type", "=", "CREATE_ORDER")
    .executeTakeFirstOrThrow();
  return {
    createAmendmentId: create.id,
    arrangement: (create.payload as Record<string, unknown>).temporaryOtherRoomArrangement,
    createAmendmentCount: Number((await db.selectFrom("amendments")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("order_id", "=", orderId)
      .where("amendment_type", "=", "CREATE_ORDER")
      .executeTakeFirstOrThrow()).count)
  };
}

async function expectCreationEvidencePreserved(created: { orderId: string; arrangement: Arrangement; createAmendmentId: string }) {
  await expect(creationEvidence(created.orderId)).resolves.toEqual({
    createAmendmentId: created.createAmendmentId,
    arrangement: created.arrangement,
    createAmendmentCount: 1
  });
}

function expectTemporaryEvidence(
  result: Record<string, unknown> | null | undefined,
  created: { arrangement: Arrangement; createAmendmentId: string }
) {
  expect(result).toMatchObject({
    temporaryOtherRoomArrangement: created.arrangement,
    temporaryOtherRoomCreateAmendmentId: created.createAmendmentId
  });
}

async function expectRecoveredTemporaryEvidence(
  receipt: ReceiptDto,
  commandType: CommandType,
  idempotencyKey: string,
  actor: AuthPrincipal,
  created: { arrangement: Arrangement; createAmendmentId: string }
) {
  const byReceipt = await getReceipt(db, actor, receipt.receiptId);
  const byCommandResult = await findCommandResult(db, actor, demo.propertyId, commandType, idempotencyKey);
  if (!("result" in byCommandResult)) {
    throw new Error("Recovered command result did not contain committed business evidence");
  }
  expectTemporaryEvidence(byReceipt.result as Record<string, unknown> | null, created);
  expectTemporaryEvidence(byCommandResult.result as Record<string, unknown> | null, created);
}

async function businessFacts(orderId: string) {
  const [coverage, claims, ledger] = await Promise.all([
    db.selectFrom("coverage_items")
      .select(["id", "service_date", "inventory_unit_id", "status", "lot_id"])
      .where("order_id", "=", orderId)
      .orderBy("service_date")
      .execute(),
    db.selectFrom("inventory_claims")
      .innerJoin("stay_segments", "stay_segments.id", "inventory_claims.source_id")
      .innerJoin("stays", "stays.id", "stay_segments.stay_id")
      .select(["inventory_claims.id", "inventory_claims.service_date", "inventory_claims.inventory_unit_id", "inventory_claims.active"])
      .where("stays.order_id", "=", orderId)
      .orderBy("inventory_claims.service_date")
      .execute(),
    db.selectFrom("entitlement_ledger")
      .select(["fact_id", "entry_type", "quantity_delta", "service_date", "coverage_id"])
      .where("order_id", "=", orderId)
      .orderBy("fact_id")
      .execute()
  ]);
  return { coverage, claims, ledger };
}

function serviceDates(facts: Awaited<ReturnType<typeof businessFacts>>): string[] {
  return facts.coverage.map((item) => item.service_date);
}

function ledgerDates(facts: Awaited<ReturnType<typeof businessFacts>>, entryType: string): string[] {
  return facts.ledger
    .filter((entry) => entry.entry_type === entryType)
    .map((entry) => entry.service_date)
    .filter((date): date is string => date !== null)
    .sort();
}

async function expectHeldReleaseCompensation(
  before: Awaited<ReturnType<typeof businessFacts>>,
  orderId: string
) {
  const after = await businessFacts(orderId);
  expect(after.coverage).toEqual(before.coverage.map((item) => ({ ...item, status: "RELEASED" })));
  expect(after.claims.every((claim) => !claim.active)).toBe(true);
  expect(ledgerDates(after, "RELEASE")).toEqual([...serviceDates(before)].sort());
  expect(after.ledger.filter((entry) => entry.entry_type === "RELEASE").every((entry) => entry.quantity_delta === 1)).toBe(true);
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db?.destroy();
});

describe("temporary other-room terminal lifecycle operations", () => {
  it("cancels a reserved temporary order with member release compensation and recoverable creation evidence", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_cancel";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate: today,
      arrivalDate: shiftDate(today, 3),
      departureDate: shiftDate(today, 5),
      unitCode: "B01",
      prefix: "temporary-terminal-cancel"
    });
    const before = await businessFacts(created.orderId);
    const prepared = await preview({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "temporary-terminal-cancel-command");
    const confirmationMetadata = metadata("temporary-terminal-cancel-command-confirm");
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "CANCEL_ORDER" as const,
      confirmation: true as const,
      expectedEffectHash: prepared.preview.effectHash,
      reason: reasonFor({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: created.orderId } }, "temporary-terminal-cancel-command")
    };
    const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmationMetadata);
    expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({ businessCommitted: true, result: { status: "CANCELLED" } });
    expectTemporaryEvidence(receipt.result, created);
    expect(await confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmationMetadata)).toEqual(receipt);
    await expectRecoveredTemporaryEvidence(receipt, "CANCEL_ORDER", confirmationMetadata.idempotencyKey, principal, created);
    await expectCreationEvidencePreserved(created);
    await expectHeldReleaseCompensation(before, created.orderId);
  });

  it("marks an overdue reserved temporary order no-show with the same held-release compensation and evidence", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const setupDate = shiftDate(today, -2);
    const memberId = "member_temporary_terminal_no_show";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate,
      arrivalDate: shiftDate(today, -1),
      departureDate: shiftDate(today, 2),
      unitCode: "B02",
      prefix: "temporary-terminal-no-show"
    });
    const before = await businessFacts(created.orderId);
    const receipt = await atPropertyClock(today, () => confirmWithReplayAndRecovery({
      commandType: "MARK_NO_SHOW",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "temporary-terminal-no-show-command", principal, created));
    expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({ businessCommitted: true, result: { status: "NO_SHOW" } });
    await expectCreationEvidencePreserved(created);
    await expectHeldReleaseCompensation(before, created.orderId);
  });

  it("revokes same-day check-in for a temporary order with ordinary restoration facts and recoverable evidence", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_revoke";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate: today,
      arrivalDate: today,
      departureDate: shiftDate(today, 2),
      unitCode: "C01",
      prefix: "temporary-terminal-revoke"
    });
    await atPropertyClock(today, () => confirm({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "temporary-terminal-revoke-check-in"));
    const before = await businessFacts(created.orderId);
    expect(before.coverage.every((item) => item.status === "CONSUMED")).toBe(true);
    const receipt = await atPropertyClock(today, () => confirmWithReplayAndRecovery({
      commandType: "REVOKE_CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: created.orderId, unusedRoomConfirmed: true }
    }, "temporary-terminal-revoke-command", principal, created));
    expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({ businessCommitted: true, result: { status: "CHECK_IN_REVOKED" } });
    await expectCreationEvidencePreserved(created);

    const after = await businessFacts(created.orderId);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.claims.every((claim) => !claim.active)).toBe(true);
    expect(ledgerDates(after, "RESTORE")).toEqual([...serviceDates(before)].sort());
    expect(after.ledger.filter((entry) => entry.entry_type === "RESTORE").every((entry) => entry.quantity_delta === 1)).toBe(true);
  });

  it("completes an overdue reserved temporary order by consuming held coverage and releasing Claims with recoverable evidence", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const setupDate = shiftDate(today, -5);
    const memberId = "member_temporary_terminal_complete";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate,
      arrivalDate: shiftDate(today, -4),
      departureDate: shiftDate(today, -1),
      unitCode: "B01",
      prefix: "temporary-terminal-complete"
    });
    const before = await businessFacts(created.orderId);
    expect(before.coverage.every((item) => item.status === "HELD")).toBe(true);
    const receipt = await atPropertyClock(today, () => confirmWithReplayAndRecovery({
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        actualStayCompletedConfirmed: true,
        reasonNote: "临时安排订单确认客人已实际入住并离店"
      }
    }, "temporary-terminal-complete-command", principal, created));
    expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({ businessCommitted: true, result: { status: "CHECKED_OUT" } });
    await expectCreationEvidencePreserved(created);

    const after = await businessFacts(created.orderId);
    expect(after.coverage).toEqual(before.coverage.map((item) => ({ ...item, status: "CONSUMED" })));
    expect(after.claims.every((claim) => !claim.active)).toBe(true);
    expect(ledgerDates(after, "CONSUME")).toEqual([...serviceDates(before)].sort());
    expect(after.ledger.filter((entry) => entry.entry_type === "CONSUME").every((entry) => entry.quantity_delta === 0)).toBe(true);
  });

  it("corrects a terminal temporary order occupant without mutating creation evidence or member/Claim facts", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_occupant";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate: today,
      arrivalDate: shiftDate(today, 4),
      departureDate: shiftDate(today, 6),
      unitCode: "B02",
      prefix: "temporary-terminal-occupant"
    });
    const cancelReceipt = await confirmWithReplayAndRecovery({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "temporary-terminal-occupant-cancel", principal, created);
    expect(cancelReceipt, JSON.stringify(cancelReceipt, null, 2)).toMatchObject({ result: { status: "CANCELLED" } });
    const terminalFacts = await businessFacts(created.orderId);
    const occupant = (await getOrderView(db, created.orderId)).occupants.find((item) => item.id === created.occupantId)!;
    const correctionEnvelope: CommandEnvelope = {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId: demo.propertyId,
        orderId: created.orderId,
        occupantId: created.occupantId,
        expectedPriorSnapshot: {
          fullName: occupant.fullName,
          nickname: occupant.nickname,
          phone: occupant.phone,
          documentNumber: occupant.documentNumber
        },
        correctedSnapshot: {
          fullName: "临时安排住客（已核对）",
          nickname: "已核对临住",
          phone: null,
          documentNumber: "TEMP-TERMINAL-DOC"
        }
      }
    };
    const prepared = await preview(correctionEnvelope, "temporary-terminal-occupant-correct", administratorPrincipal);
    const confirmationMetadata = metadata("temporary-terminal-occupant-correct-confirm");
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "CORRECT_ORDER_OCCUPANT" as const,
      confirmation: true as const,
      expectedEffectHash: prepared.preview.effectHash,
      reason: reasonFor(correctionEnvelope, "temporary-terminal-occupant-correct")
    };
    const receipt = await confirmCommandPreview(db, administratorPrincipal, prepared.preview.previewId, confirmation, confirmationMetadata);
    expect(receipt, JSON.stringify(receipt, null, 2)).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: {
        orderId: created.orderId,
        occupantId: created.occupantId,
        occupant: { nickname: "已核对临住" }
      }
    });
    expectTemporaryEvidence(receipt.result, created);
    expect(await confirmCommandPreview(db, administratorPrincipal, prepared.preview.previewId, confirmation, confirmationMetadata)).toEqual(receipt);
    await expectRecoveredTemporaryEvidence(receipt, "CORRECT_ORDER_OCCUPANT", confirmationMetadata.idempotencyKey, administratorPrincipal, created);
    await expectCreationEvidencePreserved(created);
    expect(await businessFacts(created.orderId)).toEqual(terminalFacts);
  });

  it("fails closed when the TEMPORARY_OTHER_ROOM create amendment loses its arrangement evidence", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_damaged_create";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate: today,
      arrivalDate: shiftDate(today, 8),
      departureDate: shiftDate(today, 10),
      unitCode: "B01",
      prefix: "temporary-terminal-damaged-create"
    });
    const create = await db.selectFrom("amendments")
      .select("payload")
      .where("id", "=", created.createAmendmentId)
      .executeTakeFirstOrThrow();
    const { temporaryOtherRoomArrangement: _removed, ...damagedPayload } = create.payload as Record<string, unknown>;

    await sql`ALTER TABLE amendments DISABLE TRIGGER amendments_append_only`.execute(db);
    try {
      await db.updateTable("amendments").set({ payload: damagedPayload })
        .where("id", "=", created.createAmendmentId).execute();
    } finally {
      await sql`ALTER TABLE amendments ENABLE TRIGGER amendments_append_only`.execute(db);
    }

    await expect(preview({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "temporary-terminal-damaged-create-preview")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rejects missing, partial, or cross-order temporary evidence during CREATE_ORDER receipt recovery", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const firstMemberId = "member_temporary_terminal_receipt_first";
    const secondMemberId = "member_temporary_terminal_receipt_second";
    await createMember(firstMemberId);
    await createMember(secondMemberId);
    const first = await createTemporaryOrderAt({
      memberId: firstMemberId,
      setupDate: today,
      arrivalDate: shiftDate(today, 12),
      departureDate: shiftDate(today, 14),
      unitCode: "B01",
      prefix: "temporary-terminal-receipt-first"
    });
    const second = await createTemporaryOrderAt({
      memberId: secondMemberId,
      setupDate: today,
      arrivalDate: shiftDate(today, 12),
      departureDate: shiftDate(today, 14),
      unitCode: "B02",
      prefix: "temporary-terminal-receipt-second"
    });
    const stored = await db.selectFrom("command_receipts")
      .innerJoin("amendments", "amendments.command_id", "command_receipts.command_id")
      .select(["command_receipts.id", "command_receipts.result"])
      .where("amendments.id", "=", first.createAmendmentId)
      .executeTakeFirstOrThrow();
    const original = stored.result as Record<string, unknown>;
    const variants = [
      (() => {
        const { temporaryOtherRoomArrangement: _arrangement, temporaryOtherRoomCreateAmendmentId: _id, ...value } = original;
        return value;
      })(),
      { ...original, temporaryOtherRoomCreateAmendmentId: undefined },
      { ...original, temporaryOtherRoomArrangement: undefined },
      {
        ...original,
        temporaryOtherRoomArrangement: second.arrangement,
        temporaryOtherRoomCreateAmendmentId: second.createAmendmentId
      }
    ];

    await sql`ALTER TABLE command_receipts DISABLE TRIGGER command_receipts_append_only`.execute(db);
    try {
      for (const damaged of variants) {
        await db.updateTable("command_receipts").set({ result: damaged }).where("id", "=", stored.id).execute();
        await expect(getReceipt(db, principal, stored.id)).rejects.toThrow(/temporary|临时安排/i);
      }
      await db.updateTable("command_receipts").set({ result: original }).where("id", "=", stored.id).execute();
    } finally {
      await sql`ALTER TABLE command_receipts ENABLE TRIGGER command_receipts_append_only`.execute(db);
    }
  });

  it("rejects detached temporary evidence in stored lifecycle Preview and Preview receipt recovery", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_preview_evidence";
    await createMember(memberId);
    const created = await createTemporaryOrderAt({
      memberId,
      setupDate: today,
      arrivalDate: shiftDate(today, 16),
      departureDate: shiftDate(today, 18),
      unitCode: "B01",
      prefix: "temporary-terminal-preview-evidence"
    });
    const prepared = await preview({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: created.orderId }
    }, "temporary-terminal-preview-evidence-command");
    const storedPreview = await db.selectFrom("command_previews").selectAll()
      .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
    const previewEffect = storedPreview.effect as Record<string, unknown>;
    const damagedEffect = { ...previewEffect, temporaryOtherRoomCreateAmendmentId: undefined };
    const storedReceipt = await db.selectFrom("command_receipts").selectAll()
      .where("id", "=", prepared.receipt.receiptId).executeTakeFirstOrThrow();
    const receiptResult = storedReceipt.result as Record<string, unknown>;
    const receiptPreview = receiptResult.preview as Record<string, unknown>;

    await sql`ALTER TABLE command_previews DISABLE TRIGGER command_previews_stage11_preserve_evidence`.execute(db);
    await sql`ALTER TABLE command_receipts DISABLE TRIGGER command_receipts_append_only`.execute(db);
    try {
      await db.updateTable("command_previews").set({ effect: damagedEffect })
        .where("id", "=", prepared.preview.previewId).execute();
      const damagedStoredPreview = await db.selectFrom("command_previews").selectAll()
        .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
      await expect(projectStoredPreviewForRead(db, damagedStoredPreview)).rejects.toThrow(/temporary|临时安排/i);

      await db.updateTable("command_receipts").set({
        result: { ...receiptResult, preview: { ...receiptPreview, effect: damagedEffect } }
      }).where("id", "=", prepared.receipt.receiptId).execute();
      await expect(getReceipt(db, principal, prepared.receipt.receiptId)).rejects.toThrow(/temporary|临时安排/i);
    } finally {
      await sql`ALTER TABLE command_previews ENABLE TRIGGER command_previews_stage11_preserve_evidence`.execute(db);
      await sql`ALTER TABLE command_receipts ENABLE TRIGGER command_receipts_append_only`.execute(db);
    }
  });

  it("rejects stored temporary CREATE_ORDER Preview source fields that differ from its Quote", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_create_preview_source";
    await createMember(memberId);
    await activateProduct(memberId, "temporary-terminal-create-preview-source");
    const actualUnitId = await unitId("B01");
    const quoted = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: actualUnitId,
      arrivalDate: shiftDate(today, 20),
      departureDate: shiftDate(today, 22),
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      memberId,
      temporaryOtherRoom: true
    } as Parameters<typeof createQuoteForTesting>[1]) as StoredQuoteDto;
    const prepared = await preview({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quoted.quoteId,
        primaryGuest: { fullName: "临时安排报价来源", nickname: "报价来源" },
        temporaryOtherRoomReason: "核对报价锁定的原权益来源"
      }
    }, "temporary-terminal-create-preview-source");
    const storedPreview = await db.selectFrom("command_previews").selectAll()
      .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
    const previewEffect = storedPreview.effect as Record<string, unknown>;
    const arrangement = previewEffect.temporaryOtherRoomArrangement as Record<string, unknown>;
    const damagedEffect = {
      ...previewEffect,
      temporaryOtherRoomArrangement: {
        ...arrangement,
        membershipOrderId: "membership_order_detached_from_quote"
      }
    };
    const storedReceipt = await db.selectFrom("command_receipts").selectAll()
      .where("id", "=", prepared.receipt.receiptId).executeTakeFirstOrThrow();
    const receiptResult = storedReceipt.result as Record<string, unknown>;
    const receiptPreview = receiptResult.preview as Record<string, unknown>;

    await sql`ALTER TABLE command_previews DISABLE TRIGGER command_previews_stage11_preserve_evidence`.execute(db);
    await sql`ALTER TABLE command_receipts DISABLE TRIGGER command_receipts_append_only`.execute(db);
    try {
      await db.updateTable("command_previews").set({ effect: damagedEffect })
        .where("id", "=", prepared.preview.previewId).execute();
      const damagedStoredPreview = await db.selectFrom("command_previews").selectAll()
        .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
      await expect(projectStoredPreviewForRead(db, damagedStoredPreview)).rejects.toThrow(/temporary|临时安排/i);

      await db.updateTable("command_receipts").set({
        result: { ...receiptResult, preview: { ...receiptPreview, effect: damagedEffect } }
      }).where("id", "=", prepared.receipt.receiptId).execute();
      await expect(getReceipt(db, principal, prepared.receipt.receiptId)).rejects.toThrow(/temporary|临时安排/i);
    } finally {
      await sql`ALTER TABLE command_previews ENABLE TRIGGER command_previews_stage11_preserve_evidence`.execute(db);
      await sql`ALTER TABLE command_receipts ENABLE TRIGGER command_receipts_append_only`.execute(db);
    }
  });

  it("rejects a stored temporary CREATE_ORDER Preview after its arrangement is removed but its reason remains", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_create_preview_missing_arrangement";
    await createMember(memberId);
    await activateProduct(memberId, "temporary-terminal-create-preview-missing-arrangement");
    const quoted = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: await unitId("B01"),
      arrivalDate: shiftDate(today, 24),
      departureDate: shiftDate(today, 26),
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      memberId,
      temporaryOtherRoom: true
    } as Parameters<typeof createQuoteForTesting>[1]) as StoredQuoteDto;
    const prepared = await preview({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quoted.quoteId,
        primaryGuest: { fullName: "临时安排缺失证据", nickname: "缺失证据" },
        temporaryOtherRoomReason: "保留原因但移除安排快照"
      }
    }, "temporary-terminal-create-preview-missing-arrangement");
    const storedPreview = await db.selectFrom("command_previews").selectAll()
      .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
    const { temporaryOtherRoomArrangement: _removed, ...damagedEffect } = storedPreview.effect as Record<string, unknown>;

    await sql`ALTER TABLE command_previews DISABLE TRIGGER command_previews_stage11_preserve_evidence`.execute(db);
    try {
      await db.updateTable("command_previews").set({ effect: damagedEffect })
        .where("id", "=", prepared.preview.previewId).execute();
      const damagedStoredPreview = await db.selectFrom("command_previews").selectAll()
        .where("id", "=", prepared.preview.previewId).executeTakeFirstOrThrow();
      await expect(projectStoredPreviewForRead(db, damagedStoredPreview)).rejects.toThrow(/temporary|临时安排/i);
    } finally {
      await sql`ALTER TABLE command_previews ENABLE TRIGGER command_previews_stage11_preserve_evidence`.execute(db);
    }
  });

  it("rejects temporary CREATE_QUOTE replay when its receipt arrangement differs from the stored Quote", async () => {
    const today = await propertyLocalToday(db, demo.propertyId);
    const memberId = "member_temporary_terminal_quote_receipt";
    await createMember(memberId);
    await activateProduct(memberId, "temporary-terminal-quote-receipt");
    const input = {
      propertyId: demo.propertyId,
      inventoryUnitId: await unitId("B01"),
      arrivalDate: shiftDate(today, 28),
      departureDate: shiftDate(today, 30),
      pricingPolicyVersionId: demo.publicPricingPolicyId,
      memberId,
      temporaryOtherRoom: true as const
    };
    const commandMetadata = metadata("temporary-terminal-quote-receipt");
    const created = await executeQuoteCommand(db, principal, input, commandMetadata);
    const storedReceipt = await db.selectFrom("command_receipts").selectAll()
      .where("id", "=", created.receipt.receiptId).executeTakeFirstOrThrow();
    const storedResult = storedReceipt.result as Record<string, unknown>;
    const storedQuote = storedResult.quote as Record<string, unknown>;
    const arrangement = storedQuote.temporaryOtherRoomArrangement as Record<string, unknown>;

    await sql`ALTER TABLE command_receipts DISABLE TRIGGER command_receipts_append_only`.execute(db);
    try {
      await db.updateTable("command_receipts").set({
        result: {
          ...storedResult,
          quote: {
            ...storedQuote,
            temporaryOtherRoomArrangement: {
              ...arrangement,
              entitlementLotId: "lot_detached_from_stored_quote"
            }
          }
        }
      }).where("id", "=", created.receipt.receiptId).execute();
      await expect(executeQuoteCommand(db, principal, input, commandMetadata)).rejects.toThrow(/temporary|临时安排/i);
    } finally {
      await sql`ALTER TABLE command_receipts ENABLE TRIGGER command_receipts_append_only`.execute(db);
    }
  });
});
