import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto, RoomStatusBoardDto, RoomStatusUnitDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  getRoomStatusBoard,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { newId } from "@qintopia/domain";
import fastJsonStringify from "fast-json-stringify";
import { sql, type Kysely } from "kysely";
import { OrderDetailResponseSchema } from "../../apps/api/src/schemas.ts";
import { buildHistoricalStayArrangementCorrectionEffect } from "../../packages/db/src/admin-historical-stay-corrections.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.ADMIN_HISTORICAL_STAY_CORRECTIONS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_admin_historical_stay_corrections";

const historicalCommandType = "CORRECT_HISTORICAL_STAY_ARRANGEMENTS";
const historicalAmendmentType = "CORRECT_HISTORICAL_STAY_ARRANGEMENT";

const administratorPrincipal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Demo Administrator",
  ...authScope({ profile: "administrator" })
};

const ordinaryPrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope({ profile: "ordinary" })
};

type HistoricalCorrectionItem = {
  orderId: string;
  expectedVersion: number;
  target: {
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  };
};

type StayTimelineEntry = { serviceDate: string; inventoryUnitId: string };
type FrozenOccupant = { ordinal: number; role: "PRIMARY" | "ADDITIONAL"; fullName: string | null; nickname: string | null };

type FrozenPreviewFactOverrides = {
  beforeNights?: number;
  beforeStayTimeline?: StayTimelineEntry[];
  afterNights?: number;
  afterStayTimeline?: StayTimelineEntry[];
  occupantCount?: number;
  occupants?: FrozenOccupant[];
  collectionFactCount?: number;
  netRecordedCollectionMinor?: number;
  collectionDifferenceMinor?: number;
};

type CorrectionCreatedAtOverrides = Partial<Record<
  "amendment" | "segment" | "pricingRevision" | "correction",
  Date
>>;

type CommandConfirmation = Parameters<typeof confirmCommandPreview>[3];

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function historicalEnvelope(correctionSet: HistoricalCorrectionItem[]): CommandEnvelope {
  return {
    commandType: historicalCommandType,
    input: {
      propertyId: demo.propertyId,
      correctionSet,
      evidenceNote: "交接记录与原始住宿凭据已复核"
    }
  } as unknown as CommandEnvelope;
}

function historicalConfirmation(effectHash: string): CommandConfirmation {
  return {
    propertyId: demo.propertyId,
    commandType: historicalCommandType,
    confirmation: true,
    expectedEffectHash: effectHash,
    reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "主管按真实住宿凭据纠正历史安排" }
  } as unknown as CommandConfirmation;
}

async function previewHistorical(
  correctionSet: HistoricalCorrectionItem[],
  prefix: string,
  principal = administratorPrincipal
) {
  return createCommandPreview(db, principal, historicalEnvelope(correctionSet), metadata(`${prefix}-preview`));
}

async function confirmHistorical(
  prepared: Awaited<ReturnType<typeof previewHistorical>>,
  prefix: string,
  confirmationMetadata = metadata(`${prefix}-confirm`)
): Promise<ReceiptDto> {
  return confirmCommandPreview(
    db,
    administratorPrincipal,
    prepared.preview.previewId,
    historicalConfirmation(prepared.preview.effectHash),
    confirmationMetadata
  );
}

async function correctPrimaryOccupant(orderId: string, prefix: string) {
  const view = await getOrderView(db, orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!);
  const occupant = view.occupants[0]!;
  const corrected = {
    fullName: `已核实住宿人 ${prefix}`,
    nickname: `已核 ${prefix}`,
    phone: occupant.phone,
    documentNumber: occupant.documentNumber
  };
  const prepared = await createCommandPreview(db, administratorPrincipal, {
    commandType: "CORRECT_ORDER_OCCUPANT",
    input: {
      propertyId: demo.propertyId,
      orderId,
      occupantId: occupant.id,
      expectedPriorSnapshot: {
        fullName: occupant.fullName,
        nickname: occupant.nickname,
        phone: occupant.phone,
        documentNumber: occupant.documentNumber
      },
      correctedSnapshot: corrected
    }
  }, metadata(`${prefix}-occupant-preview`));
  const receipt = await confirmCommandPreview(db, administratorPrincipal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CORRECT_ORDER_OCCUPANT",
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: "DATA_ENTRY_CORRECTION", note: "主管核对真实住宿人资料后更正" }
  }, metadata(`${prefix}-occupant-confirm`));
  expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  return { occupant, corrected, receipt };
}

async function createCompletedStay(options: {
  prefix: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}) {
  const reason = `历史住宿安排纠错夹具 ${options.prefix}`;
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    stayType: "TRANSIENT",
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: demo.transientPolicyId
  });
  const createPreview = await createCommandPreview(db, administratorPrincipal, {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `历史纠错住客 ${options.prefix}`, nickname: `纠错 ${options.prefix}` },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits,
      backfill: true,
      backfillReason: reason,
      backfillCollection: {
        amountMinor: quote.currentContractAmount.minorUnits,
        method: "WECOM",
        transactionReference: `WX-HIST-CORR-${options.prefix.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "-")}`
      }
    }
  }, metadata(`${options.prefix}-create-preview`));
  const receipt = await confirmCommandPreview(db, administratorPrincipal, createPreview.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: createPreview.preview.effectHash,
    reason: { code: "BACKFILL_STAY", note: reason }
  }, metadata(`${options.prefix}-create-confirm`));
  expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  const orderId = receipt.result!.orderId as string;
  const stayId = receipt.result!.stayId as string;
  const view = await getOrderView(db, orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!);
  expect(view.order).toMatchObject({ id: orderId, status: "CHECKED_OUT" });
  expect(view.stay).toMatchObject({ id: stayId, status: "COMPLETED" });
  return {
    orderId,
    stayId,
    unitId: options.unitId,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    expectedVersion: view.order.version,
    currentContractAmountMinor: view.amounts.currentContractAmount.minorUnits
  };
}

async function createOverdueInHouseStay(options: {
  prefix: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}) {
  return withPropertyClockForTesting(new Date(`${options.arrivalDate}T04:00:00.000Z`), async () => {
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: options.unitId,
      stayType: "TRANSIENT",
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      pricingPolicyVersionId: demo.publicPricingPolicyId
    });
    const createPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: `逾期未退住客 ${options.prefix}`, nickname: `未退 ${options.prefix}` },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
      }
    }, metadata(`${options.prefix}-create-preview`));
    const createReceipt = await confirmCommandPreview(db, administratorPrincipal, createPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: createPreview.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata(`${options.prefix}-create-confirm`));
    const orderId = createReceipt.result!.orderId as string;
    const checkInPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, metadata(`${options.prefix}-check-in-preview`));
    const checkInReceipt = await confirmCommandPreview(db, administratorPrincipal, checkInPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CHECK_IN",
      confirmation: true,
      expectedEffectHash: checkInPreview.preview.effectHash,
      reason: { code: "CHECK_IN", note: "创建逾期未退边界夹具" }
    }, metadata(`${options.prefix}-check-in-confirm`));
    expect(checkInReceipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    return { orderId, stayId: createReceipt.result!.stayId as string };
  });
}

async function board(arrivalDate: string, departureDate: string): Promise<RoomStatusBoardDto> {
  return getRoomStatusBoard(db, {
    propertyId: demo.propertyId,
    arrivalDate,
    departureDate,
    accessLevel: "WRITE",
    commandGrants: administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!,
    requestingSubjectId: demo.administratorSubjectId,
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

function intervalForOrder(result: RoomStatusBoardDto, unitId: string, orderId: string) {
  return unitIn(result, unitId).intervals.find((interval) =>
    interval.references.some((reference) => reference.type === "ORDER" && reference.id === orderId)
  );
}

async function businessIdentityAndFundsSnapshot(orderId: string) {
  const view = await getOrderView(db, orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!);
  const [pricingRevisions, collectionFacts, coverageItems, entitlementLedger] = await Promise.all([
    db.selectFrom("pricing_revisions").selectAll().where("order_id", "=", orderId).orderBy("revision_no").execute(),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute(),
    db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute()
  ]);
  return JSON.parse(JSON.stringify({
    orderId: view.order.id,
    stayId: view.stay.id,
    orderStatus: view.order.status,
    stayStatus: view.stay.status,
    stayType: view.order.stay_type,
    primaryGuestSnapshot: view.order.primary_guest_snapshot,
    bookingChannelCode: view.order.booking_channel_code,
    channelOrderReference: view.order.channel_order_reference,
    memberId: view.order.member_id,
    memberContractId: view.order.member_contract_id,
    currentRevisionId: view.order.current_revision_id,
    currentContractAmount: view.amounts.currentContractAmount,
    collectionDifference: view.amounts.collectionDifference,
    occupants: view.occupants.map((occupant) => ({
      id: occupant.id,
      ordinal: occupant.ordinal,
      role: occupant.role,
      fullName: occupant.fullName,
      nickname: occupant.nickname,
      phone: occupant.phone,
      documentNumber: occupant.documentNumber
    })),
    pricingRevisions,
    collectionFacts,
    coverageItems,
    entitlementLedger
  }));
}

function stableBusinessIdentityAndFunds(snapshot: Awaited<ReturnType<typeof businessIdentityAndFundsSnapshot>>) {
  const { currentRevisionId: _currentRevisionId, pricingRevisions: _pricingRevisions, ...stable } = snapshot;
  return stable;
}

async function expectBusinessIdentityAndFundsPreservedAfterCorrection(
  orderId: string,
  before: Awaited<ReturnType<typeof businessIdentityAndFundsSnapshot>>,
  expectedCurrentDates: { arrivalDate: string; departureDate: string }
) {
  const after = await businessIdentityAndFundsSnapshot(orderId);
  expect(stableBusinessIdentityAndFunds(after)).toEqual(stableBusinessIdentityAndFunds(before));
  expect(after.pricingRevisions.slice(0, -1)).toEqual(before.pricingRevisions);
  expect(after.pricingRevisions).toHaveLength(before.pricingRevisions.length + 1);

  const priorRevision = before.pricingRevisions.at(-1)!;
  const copiedRevision = after.pricingRevisions.at(-1)!;
  expect(after.currentRevisionId).toBe(copiedRevision.id);
  expect(copiedRevision).toMatchObject({
    order_id: priorRevision.order_id,
    revision_no: priorRevision.revision_no + 1,
    policy_version_id: priorRevision.policy_version_id,
    arrival_date: expectedCurrentDates.arrivalDate,
    departure_date: expectedCurrentDates.departureDate,
    coverage_set: priorRevision.coverage_set,
    cash_lines: priorRevision.cash_lines,
    policy_base_amount_minor: priorRevision.policy_base_amount_minor,
    pricing_basis: priorRevision.pricing_basis,
    manual_adjustment_minor: priorRevision.manual_adjustment_minor,
    current_contract_amount_minor: priorRevision.current_contract_amount_minor,
    currency: priorRevision.currency
  });
  expect(copiedRevision.id).not.toBe(priorRevision.id);
  expect(copiedRevision.amendment_id).not.toBe(priorRevision.amendment_id);
}

async function businessArtifactCounts() {
  const [
    orders,
    stays,
    amendments,
    staySegments,
    inventoryClaims,
    pricingRevisions,
    collectionFacts,
    coverageItems,
    entitlementLedger,
    historicalCorrections
  ] = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stay_segments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("collection_facts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("coverage_items").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("historical_stay_arrangement_corrections").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return {
    orders: Number(orders.count),
    stays: Number(stays.count),
    amendments: Number(amendments.count),
    staySegments: Number(staySegments.count),
    inventoryClaims: Number(inventoryClaims.count),
    pricingRevisions: Number(pricingRevisions.count),
    collectionFacts: Number(collectionFacts.count),
    coverageItems: Number(coverageItems.count),
    entitlementLedger: Number(entitlementLedger.count),
    historicalCorrections: Number(historicalCorrections.count)
  };
}

const historicalWriteFailureTargets = [
  { table: "amendments", event: "INSERT" },
  { table: "stay_segments", event: "INSERT" },
  { table: "pricing_revisions", event: "INSERT" },
  { table: "inventory_claims", event: "INSERT" },
  { table: "historical_stay_arrangement_corrections", event: "INSERT" },
  { table: "orders", event: "UPDATE" },
  { table: "audit_entries", event: "INSERT" },
  { table: "command_receipts", event: "INSERT" }
] as const;

async function installHistoricalWriteFailure(table: string, event: string): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION qintopia_test_fail_historical_correction_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected historical correction write failure';
    END;
    $$
  `.execute(db);
  await sql`CREATE TRIGGER qintopia_test_fail_historical_correction_write BEFORE ${sql.raw(event)} ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION qintopia_test_fail_historical_correction_write()`.execute(db);
}

async function clearHistoricalWriteFailure(table: string): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS qintopia_test_fail_historical_correction_write ON ${sql.table(table)}`.execute(db);
  await sql`DROP FUNCTION IF EXISTS qintopia_test_fail_historical_correction_write()`.execute(db);
}

async function correctionAmendments(orderIds: string[]) {
  return db.selectFrom("amendments")
    .selectAll()
    .where("order_id", "in", orderIds)
    .where("amendment_type", "=", historicalAmendmentType)
    .orderBy("order_id")
    .orderBy("sequence")
    .execute();
}

async function insertForgedTypedHistoricalCorrectionGraph(options: {
  fixture: Awaited<ReturnType<typeof createCompletedStay>>;
  targetInventoryUnitId: string;
  targetArrivalDate: string;
  targetDepartureDate: string;
  actorSubjectId?: string;
  correctionSequence?: number;
  previewTargetDepartureDate?: string;
  auditEffectHash?: string;
  frozenPreviewFactOverrides?: FrozenPreviewFactOverrides;
  createdAtOverrides?: CorrectionCreatedAtOverrides;
  retainReleasedClaimPointer?: boolean;
  prefix: string;
}): Promise<void> {
  const commandId = `forged-historical-${options.prefix}-command`;
  const amendmentId = `forged-historical-${options.prefix}-amendment`;
  const segmentId = `forged-historical-${options.prefix}-segment`;
  const revisionId = `forged-historical-${options.prefix}-revision`;
  const correctionId = `forged-historical-${options.prefix}-correction`;
  const correlationId = `forged-historical-${options.prefix}`;
  const targetDates: string[] = [];
  for (let serviceDate = options.targetArrivalDate; serviceDate < options.targetDepartureDate; serviceDate = addDays(serviceDate, 1)) {
    targetDates.push(serviceDate);
  }

  await db.transaction().execute(async (trx) => {
    const [order, currentSegment, currentRevision, targetUnit, latestCorrection, occupantRows, collectionSummary] = await Promise.all([
      trx.selectFrom("orders").selectAll().where("id", "=", options.fixture.orderId).executeTakeFirstOrThrow(),
      trx.selectFrom("stay_segments").selectAll().where("stay_id", "=", options.fixture.stayId)
        .orderBy("sequence", "desc").executeTakeFirstOrThrow(),
      trx.selectFrom("pricing_revisions").selectAll().where("id", "=", sql<string>`(
        SELECT current_revision_id FROM orders WHERE id = ${options.fixture.orderId}
      )`).executeTakeFirstOrThrow(),
      trx.selectFrom("inventory_units").select(["id", "kind", "parent_room_id"])
        .where("id", "=", options.targetInventoryUnitId).executeTakeFirstOrThrow(),
      trx.selectFrom("historical_stay_arrangement_corrections").select("sequence")
        .where("order_id", "=", options.fixture.orderId).orderBy("sequence", "desc").executeTakeFirst(),
      trx.selectFrom("order_occupants").select(["ordinal", "role", "full_name", "nickname"])
        .where("order_id", "=", options.fixture.orderId).orderBy("ordinal").execute(),
      trx.selectFrom("collection_facts").select(({ fn }) => [
        fn.countAll<string>().as("count"),
        fn.coalesce(fn.sum<number>("net_effect_minor"), sql<number>`0`).as("net")
      ]).where("order_id", "=", options.fixture.orderId).executeTakeFirstOrThrow()
    ]);
    const nextVersion = order.version + 1;
    const beforeTimeline: Array<{ serviceDate: string; inventoryUnitId: string }> = [];
    for (let serviceDate = currentSegment.arrival_date; serviceDate < currentSegment.departure_date; serviceDate = addDays(serviceDate, 1)) {
      beforeTimeline.push({ serviceDate, inventoryUnitId: currentSegment.inventory_unit_id });
    }
    const afterTimeline = targetDates.map((serviceDate) => ({
      serviceDate,
      inventoryUnitId: options.targetInventoryUnitId
    }));
    const frozenFactOverrides = options.frozenPreviewFactOverrides ?? {};
    const occupants = occupantRows.map((occupant) => ({
      ordinal: occupant.ordinal,
      role: occupant.role,
      fullName: occupant.full_name,
      nickname: occupant.nickname
    }));
    const amendmentPayload = {
      operation: historicalAmendmentType,
      commandType: historicalCommandType,
      orderId: order.id,
      stayId: options.fixture.stayId,
      expectedVersion: order.version,
      correctionSetHash: `forged-final-set-${options.prefix}`,
      before: {
        inventoryUnitId: currentSegment.inventory_unit_id,
        arrivalDate: currentSegment.arrival_date,
        departureDate: currentSegment.departure_date,
        nights: frozenFactOverrides.beforeNights ?? beforeTimeline.length,
        stayTimeline: frozenFactOverrides.beforeStayTimeline ?? beforeTimeline
      },
      after: {
        inventoryUnitId: options.targetInventoryUnitId,
        arrivalDate: options.targetArrivalDate,
        departureDate: options.targetDepartureDate,
        nights: frozenFactOverrides.afterNights ?? afterTimeline.length,
        stayTimeline: frozenFactOverrides.afterStayTimeline ?? afterTimeline,
        pricing: {
          coverageSet: [],
          cashLines: [],
          currentContractAmount: { currency: currentRevision.currency, minorUnits: currentRevision.current_contract_amount_minor }
        }
      },
      unchanged: {
        orderStatus: "CHECKED_OUT",
        stayStatus: "COMPLETED",
        stayType: order.stay_type,
        currentRevisionId: currentRevision.id,
        currentContractAmountMinor: currentRevision.current_contract_amount_minor,
        currency: currentRevision.currency,
        occupantCount: frozenFactOverrides.occupantCount ?? occupants.length,
        occupants: frozenFactOverrides.occupants ?? occupants,
        collectionFactCount: frozenFactOverrides.collectionFactCount ?? Number(collectionSummary.count),
        netRecordedCollectionMinor: frozenFactOverrides.netRecordedCollectionMinor ?? Number(collectionSummary.net),
        collectionDifferenceMinor: frozenFactOverrides.collectionDifferenceMinor
          ?? currentRevision.current_contract_amount_minor - Number(collectionSummary.net)
      }
    };
    const previewId = `forged-historical-${options.prefix}-preview`;
    const effectHash = "b".repeat(64);
    const previewAfter = {
      inventoryUnitId: options.targetInventoryUnitId,
      arrivalDate: options.targetArrivalDate,
      departureDate: options.previewTargetDepartureDate ?? options.targetDepartureDate,
      nights: amendmentPayload.after.nights,
      stayTimeline: amendmentPayload.after.stayTimeline
    };
    const previewEffect = {
      operation: historicalCommandType,
      corrections: [{
        orderId: order.id,
        stayId: options.fixture.stayId,
        expectedVersion: order.version,
        before: amendmentPayload.before,
        after: previewAfter,
        unchanged: amendmentPayload.unchanged
      }]
    };

    await trx.insertInto("command_executions").values({
      id: commandId,
      subject_id: administratorPrincipal.subjectId,
      credential_id: administratorPrincipal.credentialId,
      property_id: demo.propertyId,
      command_type: historicalCommandType,
      idempotency_key: correlationId,
      request_hash: "a".repeat(64),
      correlation_id: correlationId,
      state: "EXECUTING",
      completed_at: null
    }).execute();
    await trx.insertInto("command_previews").values({
      id: previewId,
      subject_id: administratorPrincipal.subjectId,
      property_id: demo.propertyId,
      command_type: historicalCommandType,
      normalized_input: {},
      input_hash: "c".repeat(64),
      effect: previewEffect,
      effect_hash: effectHash,
      basis_versions: {
        propertyId: demo.propertyId,
        correctionSetHash: amendmentPayload.correctionSetHash
      },
      expires_at: new Date(Date.now() + 10 * 60_000),
      status: "USED",
      used_at: new Date()
    }).execute();
    await trx.insertInto("amendments").values({
      id: amendmentId,
      order_id: order.id,
      sequence: nextVersion,
      amendment_type: historicalAmendmentType,
      reason_code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION",
      reason_note: "伪造完整类型图也必须经过数据库最终集合校验",
      prior_version: order.version,
      new_version: nextVersion,
      payload: amendmentPayload,
      command_id: commandId,
      created_at: options.createdAtOverrides?.amendment ?? sql<Date>`transaction_timestamp()`
    }).execute();
    await trx.insertInto("stay_segments").values({
      id: segmentId,
      stay_id: options.fixture.stayId,
      sequence: currentSegment.sequence + 1,
      inventory_unit_id: options.targetInventoryUnitId,
      arrival_date: options.targetArrivalDate,
      departure_date: options.targetDepartureDate,
      segment_type: historicalAmendmentType,
      supersedes_segment_id: currentSegment.id,
      amendment_id: amendmentId,
      created_at: options.createdAtOverrides?.segment ?? sql<Date>`transaction_timestamp()`
    }).execute();
    await trx.insertInto("pricing_revisions").values({
      id: revisionId,
      order_id: order.id,
      revision_no: currentRevision.revision_no + 1,
      amendment_id: amendmentId,
      policy_version_id: currentRevision.policy_version_id,
      arrival_date: options.targetArrivalDate,
      departure_date: options.targetDepartureDate,
      coverage_set: JSON.stringify(currentRevision.coverage_set),
      cash_lines: JSON.stringify(currentRevision.cash_lines),
      policy_base_amount_minor: currentRevision.policy_base_amount_minor,
      pricing_basis: currentRevision.pricing_basis,
      manual_adjustment_minor: currentRevision.manual_adjustment_minor,
      current_contract_amount_minor: currentRevision.current_contract_amount_minor,
      currency: currentRevision.currency,
      created_at: options.createdAtOverrides?.pricingRevision ?? sql<Date>`transaction_timestamp()`
    }).execute();
    const claimIds = targetDates.map((_serviceDate, index) => `forged-historical-${options.prefix}-claim-${index}`);
    await trx.insertInto("inventory_claims").values(targetDates.map((serviceDate, index) => ({
      id: claimIds[index]!,
      property_id: demo.propertyId,
      room_id: targetUnit.kind === "ROOM" ? targetUnit.id : targetUnit.parent_room_id!,
      inventory_unit_id: targetUnit.id,
      service_date: serviceDate,
      source_type: "ORDER_SEGMENT" as const,
      source_id: segmentId,
      active: false,
      released_at: sql<Date>`transaction_timestamp()`
    }))).execute();
    if (options.retainReleasedClaimPointer) {
      const firstClaimId = claimIds[0]!;
      const firstServiceDate = targetDates[0]!;
      if (targetUnit.kind === "ROOM") {
        await trx.insertInto("inventory_room_days").values({
          room_id: targetUnit.id,
          service_date: firstServiceDate,
          whole_claim_id: firstClaimId,
          version: 1,
          updated_at: sql<Date>`transaction_timestamp()`
        }).onConflict((conflict) => conflict.columns(["room_id", "service_date"]).doUpdateSet({
          whole_claim_id: firstClaimId,
          version: sql`inventory_room_days.version + 1`,
          updated_at: sql<Date>`transaction_timestamp()`
        })).execute();
      } else {
        await trx.insertInto("inventory_bed_days").values({
          room_id: targetUnit.parent_room_id!,
          bed_id: targetUnit.id,
          service_date: firstServiceDate,
          bed_claim_id: firstClaimId,
          version: 1,
          updated_at: sql<Date>`transaction_timestamp()`
        }).onConflict((conflict) => conflict.columns(["bed_id", "service_date"]).doUpdateSet({
          bed_claim_id: firstClaimId,
          version: sql`inventory_bed_days.version + 1`,
          updated_at: sql<Date>`transaction_timestamp()`
        })).execute();
      }
    }
    await trx.insertInto("historical_stay_arrangement_corrections").values({
      id: correctionId,
      property_id: demo.propertyId,
      order_id: order.id,
      stay_id: options.fixture.stayId,
      sequence: options.correctionSequence ?? (latestCorrection?.sequence ?? 0) + 1,
      expected_version: order.version,
      prior_inventory_unit_id: currentSegment.inventory_unit_id,
      prior_arrival_date: currentSegment.arrival_date,
      prior_departure_date: currentSegment.departure_date,
      corrected_inventory_unit_id: options.targetInventoryUnitId,
      corrected_arrival_date: options.targetArrivalDate,
      corrected_departure_date: options.targetDepartureDate,
      reason_code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION",
      reason_note: "伪造完整类型图也必须经过数据库最终集合校验",
      actor_subject_id: options.actorSubjectId ?? administratorPrincipal.subjectId,
      amendment_id: amendmentId,
      stay_segment_id: segmentId,
      pricing_revision_id: revisionId,
      created_by_command_id: commandId,
      created_at: options.createdAtOverrides?.correction ?? sql<Date>`transaction_timestamp()`
    }).execute();
    await trx.updateTable("orders").set({
      arrival_date: options.targetArrivalDate,
      departure_date: options.targetDepartureDate,
      current_revision_id: revisionId,
      version: nextVersion,
      updated_at: sql<Date>`transaction_timestamp()`
    }).where("id", "=", order.id).execute();
    await trx.updateTable("command_executions").set({
      state: "APPLIED",
      completed_at: sql<Date>`transaction_timestamp()`
    }).where("id", "=", commandId).execute();
    await trx.insertInto("command_receipts").values({
      id: `forged-historical-${options.prefix}-receipt`,
      command_id: commandId,
      execution_status: "EXECUTED",
      business_committed: true,
      result: { operation: historicalCommandType },
      error: null,
      resource_refs: JSON.stringify([order.id, options.fixture.stayId]),
      fact_refs: JSON.stringify([correctionId]),
      committed_at: sql<Date>`transaction_timestamp()`
    }).execute();
    await trx.insertInto("audit_entries").values({
      id: `forged-historical-${options.prefix}-audit`,
      subject_id: administratorPrincipal.subjectId,
      credential_id: administratorPrincipal.credentialId,
      action: historicalCommandType,
      decision: "ALLOWED",
      command_id: commandId,
      correlation_id: correlationId,
      reason: {
        code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION",
        note: "伪造完整类型图也必须经过数据库最终集合校验"
      },
      target_refs: JSON.stringify([order.id]),
      metadata: { previewId, effectHash: options.auditEffectHash ?? effectHash }
    }).execute();
  });
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe.sequential("9.3 CORRECT_HISTORICAL_STAY_ARRANGEMENTS", () => {
  it("allows an inactive historical source unit while still requiring an active compatible target", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const fixture = await createCompletedStay({
      prefix: "inactive-historical-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -12),
      departureDate: addDays(businessDate, -10)
    });
    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", demo.roomId).execute();

    const prepared = await previewHistorical([{
      orderId: fixture.orderId,
      expectedVersion: fixture.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -9),
        departureDate: addDays(businessDate, -7)
      }
    }], "inactive-historical-source");

    expect(prepared.preview.effect).toMatchObject({
      corrections: [{
        before: { inventoryUnitId: demo.roomId },
        after: { inventoryUnitId: demo.secondRoomId }
      }]
    });
    await expect(confirmHistorical(prepared, "inactive-historical-source"))
      .resolves.toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    await db.updateTable("inventory_units").set({ active: false }).where("id", "=", demo.secondRoomId).execute();
    await expect(previewHistorical([{
      orderId: fixture.orderId,
      expectedVersion: fixture.expectedVersion + 1,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -8),
        departureDate: addDays(businessDate, -6)
      }
    }], "inactive-historical-target")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets an administrator preview and atomically confirm a single CHECKED_OUT/COMPLETED date and unit correction without drifting identity or funds", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const originalArrival = addDays(businessDate, -10);
    const originalDeparture = addDays(businessDate, -8);
    const correctedArrival = addDays(businessDate, -7);
    const correctedDeparture = addDays(businessDate, -5);
    const fixture = await createCompletedStay({
      prefix: "single",
      unitId: demo.roomId,
      arrivalDate: originalArrival,
      departureDate: originalDeparture
    });
    const immutableBefore = await businessIdentityAndFundsSnapshot(fixture.orderId);

    const prepared = await previewHistorical([{
      orderId: fixture.orderId,
      expectedVersion: fixture.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: correctedArrival,
        departureDate: correctedDeparture
      }
    }], "single");

    expect(prepared.preview.commandType).toBe(historicalCommandType);
    expect(prepared.preview.effect).toMatchObject({
      operation: historicalCommandType,
      corrections: [{
        orderId: fixture.orderId,
        stayId: fixture.stayId,
        before: {
          inventoryUnitId: demo.roomId,
          arrivalDate: originalArrival,
          departureDate: originalDeparture
        },
        after: {
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: correctedArrival,
          departureDate: correctedDeparture
        },
        unchanged: {
          currentContractAmountMinor: fixture.currentContractAmountMinor,
          orderStatus: "CHECKED_OUT",
          stayStatus: "COMPLETED"
        }
      }]
    });

    const receipt = await confirmHistorical(prepared, "single");
    expect(receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      resourceRefs: expect.arrayContaining([fixture.orderId, fixture.stayId]),
      result: {
        operation: historicalCommandType,
        reason: {
          code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION",
          note: "主管按真实住宿凭据纠正历史安排"
        },
        evidenceNote: "交接记录与原始住宿凭据已复核",
        actor: {
          subjectId: demo.administratorSubjectId,
          displayName: "Demo Administrator"
        },
        recordedAt: expect.any(String),
        corrections: [expect.objectContaining({
          orderId: fixture.orderId,
          stayId: fixture.stayId,
          before: expect.objectContaining({ arrivalDate: originalArrival, departureDate: originalDeparture }),
          after: expect.objectContaining({ arrivalDate: correctedArrival, departureDate: correctedDeparture })
        })]
      }
    });

    await expectBusinessIdentityAndFundsPreservedAfterCorrection(fixture.orderId, immutableBefore, {
      arrivalDate: correctedArrival,
      departureDate: correctedDeparture
    });
    const view = await getOrderView(db, fixture.orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!);
    expect(() => JSON.parse(fastJsonStringify(OrderDetailResponseSchema)(view))).not.toThrow();
    expect(view.order).toMatchObject({
      id: fixture.orderId,
      status: "CHECKED_OUT",
      arrival_date: correctedArrival,
      departure_date: correctedDeparture
    });
    expect(view.stay).toMatchObject({ id: fixture.stayId, status: "COMPLETED" });
    expect(view.effectiveArrangement.intervals).toEqual([{
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: correctedArrival,
      departureDate: correctedDeparture
    }]);
    expect((await db.selectFrom("amendments").select("amendment_type").where("order_id", "=", fixture.orderId).orderBy("sequence").execute())
      .map((amendment) => amendment.amendment_type)).toEqual([
      "CREATE_ORDER",
      "CHECK_IN",
      "CHECK_OUT",
      historicalAmendmentType
    ]);
    expect(intervalForOrder(await board(originalArrival, originalDeparture), demo.roomId, fixture.orderId)).toBeUndefined();
    expect(intervalForOrder(await board(correctedArrival, correctedDeparture), demo.secondRoomId, fixture.orderId))
      .toMatchObject({ status: "SETTLED", sourceStartDate: correctedArrival, sourceEndDate: correctedDeparture });
  });

  it("freezes the current corrected occupant projection in Preview and Receipt without reverting identity", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const fixture = await createCompletedStay({
      prefix: "effective-occupant",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -18),
      departureDate: addDays(businessDate, -16)
    });
    const correctedOccupant = await correctPrimaryOccupant(fixture.orderId, "effective-occupant");
    const afterOccupantCorrection = await getOrderView(
      db,
      fixture.orderId,
      "WRITE",
      administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!
    );
    const frozenOccupant = {
      ordinal: correctedOccupant.occupant.ordinal,
      role: correctedOccupant.occupant.role,
      fullName: correctedOccupant.corrected.fullName,
      nickname: correctedOccupant.corrected.nickname
    };
    const prepared = await previewHistorical([{
      orderId: fixture.orderId,
      expectedVersion: afterOccupantCorrection.order.version,
      target: {
        inventoryUnitId: demo.roomId,
        arrivalDate: addDays(businessDate, -15),
        departureDate: addDays(businessDate, -13)
      }
    }], "effective-occupant-historical");

    expect(prepared.preview.effect).toMatchObject({
      corrections: [{ unchanged: { occupantCount: 1, occupants: [frozenOccupant] } }]
    });
    const receipt = await confirmHistorical(prepared, "effective-occupant-historical");
    expect(receipt, JSON.stringify(receipt.error)).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: { corrections: [{ unchanged: { occupantCount: 1, occupants: [frozenOccupant] } }] }
    });
    const finalView = await getOrderView(
      db,
      fixture.orderId,
      "WRITE",
      administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!
    );
    expect(finalView.occupants[0]).toMatchObject(correctedOccupant.corrected);
    expect(await db.selectFrom("order_occupants")
      .select(["full_name", "nickname"])
      .where("id", "=", correctedOccupant.occupant.id)
      .executeTakeFirstOrThrow()).toMatchObject({
      full_name: correctedOccupant.occupant.fullName,
      nickname: correctedOccupant.occupant.nickname
    });
  });

  it("invalidates a historical-arrangement Preview when the effective occupant changes", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const fixture = await createCompletedStay({
      prefix: "occupant-stale",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -18),
      departureDate: addDays(businessDate, -16)
    });
    const prepared = await previewHistorical([{
      orderId: fixture.orderId,
      expectedVersion: fixture.expectedVersion,
      target: {
        inventoryUnitId: demo.roomId,
        arrivalDate: addDays(businessDate, -15),
        departureDate: addDays(businessDate, -13)
      }
    }], "occupant-stale-historical");
    await correctPrimaryOccupant(fixture.orderId, "occupant-stale");
    const afterOccupantCorrection = await businessArtifactCounts();

    await expect(confirmHistorical(prepared, "occupant-stale-historical")).resolves.toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await businessArtifactCounts()).toEqual(afterOccupantCorrection);
    expect(await correctionAmendments([fixture.orderId])).toHaveLength(0);
  });

  it("moves a completed stay to different historical dates in the same room", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const fixture = await createCompletedStay({
      prefix: "same-room-shift",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -18),
      departureDate: addDays(businessDate, -16)
    });
    const before = await businessIdentityAndFundsSnapshot(fixture.orderId);
    const correctedArrival = addDays(businessDate, -15);
    const correctedDeparture = addDays(businessDate, -13);
    const prepared = await previewHistorical([{
      orderId: fixture.orderId,
      expectedVersion: fixture.expectedVersion,
      target: {
        inventoryUnitId: fixture.unitId,
        arrivalDate: correctedArrival,
        departureDate: correctedDeparture
      }
    }], "same-room-shift");
    await expect(confirmHistorical(prepared, "same-room-shift")).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
    await expectBusinessIdentityAndFundsPreservedAfterCorrection(fixture.orderId, before, {
      arrivalDate: correctedArrival,
      departureDate: correctedDeparture
    });
  });

  it("replays a reordered equivalent correction set under one idempotency key without merging changed dates", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const leftArrival = addDays(businessDate, -24);
    const leftDeparture = addDays(businessDate, -22);
    const rightArrival = addDays(businessDate, -21);
    const rightDeparture = addDays(businessDate, -19);
    const left = await createCompletedStay({
      prefix: "normalized-set-left",
      unitId: demo.roomId,
      arrivalDate: leftArrival,
      departureDate: leftDeparture
    });
    const right = await createCompletedStay({
      prefix: "normalized-set-right",
      unitId: demo.secondRoomId,
      arrivalDate: rightArrival,
      departureDate: rightDeparture
    });
    const canonicalSet: HistoricalCorrectionItem[] = [{
      orderId: left.orderId,
      expectedVersion: left.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: rightArrival,
        departureDate: rightDeparture
      }
    }, {
      orderId: right.orderId,
      expectedVersion: right.expectedVersion,
      target: {
        inventoryUnitId: demo.roomId,
        arrivalDate: leftArrival,
        departureDate: leftDeparture
      }
    }];
    const requestMetadata = {
      idempotencyKey: "normalized-historical-correction-set",
      correlationId: "normalized-historical-correction-set"
    };
    const first = await createCommandPreview(
      db,
      administratorPrincipal,
      historicalEnvelope(canonicalSet),
      requestMetadata
    );
    const equivalent = await createCommandPreview(db, administratorPrincipal, {
      commandType: historicalCommandType,
      input: {
        propertyId: ` ${demo.propertyId} `,
        correctionSet: [...canonicalSet].reverse().map((item) => ({
          ...item,
          orderId: ` ${item.orderId} `,
          target: {
            inventoryUnitId: ` ${item.target.inventoryUnitId} `,
            arrivalDate: ` ${item.target.arrivalDate} `,
            departureDate: ` ${item.target.departureDate} `
          }
        })),
        evidenceNote: " 交接记录与原始住宿凭据已复核 "
      }
    } as unknown as CommandEnvelope, requestMetadata);
    expect(equivalent.preview.previewId).toBe(first.preview.previewId);
    expect(equivalent.receipt.commandId).toBe(first.receipt.commandId);

    await expect(createCommandPreview(db, administratorPrincipal, historicalEnvelope([
      { ...canonicalSet[0]!, target: { ...canonicalSet[0]!.target, departureDate: addDays(rightDeparture, -1) } },
      canonicalSet[1]!
    ]), requestMetadata)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("validates two completed stays as one final set so a room/date swap succeeds without false intermediate conflicts", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const leftArrival = addDays(businessDate, -12);
    const leftDeparture = addDays(businessDate, -10);
    const rightArrival = addDays(businessDate, -9);
    const rightDeparture = addDays(businessDate, -7);
    const left = await createCompletedStay({
      prefix: "swap-left",
      unitId: demo.roomId,
      arrivalDate: leftArrival,
      departureDate: leftDeparture
    });
    const right = await createCompletedStay({
      prefix: "swap-right",
      unitId: demo.secondRoomId,
      arrivalDate: rightArrival,
      departureDate: rightDeparture
    });
    const before = new Map([
      [left.orderId, await businessIdentityAndFundsSnapshot(left.orderId)],
      [right.orderId, await businessIdentityAndFundsSnapshot(right.orderId)]
    ]);

    const prepared = await previewHistorical([
      {
        orderId: left.orderId,
        expectedVersion: left.expectedVersion,
        target: {
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: rightArrival,
          departureDate: rightDeparture
        }
      },
      {
        orderId: right.orderId,
        expectedVersion: right.expectedVersion,
        target: {
          inventoryUnitId: demo.roomId,
          arrivalDate: leftArrival,
          departureDate: leftDeparture
        }
      }
    ], "swap");
    expect(prepared.preview.effect).toMatchObject({
      operation: historicalCommandType,
      corrections: expect.arrayContaining([
        expect.objectContaining({
          orderId: left.orderId,
          before: expect.objectContaining({ inventoryUnitId: demo.roomId, arrivalDate: leftArrival, departureDate: leftDeparture }),
          after: expect.objectContaining({ inventoryUnitId: demo.secondRoomId, arrivalDate: rightArrival, departureDate: rightDeparture })
        }),
        expect.objectContaining({
          orderId: right.orderId,
          before: expect.objectContaining({ inventoryUnitId: demo.secondRoomId, arrivalDate: rightArrival, departureDate: rightDeparture }),
          after: expect.objectContaining({ inventoryUnitId: demo.roomId, arrivalDate: leftArrival, departureDate: leftDeparture })
        })
      ])
    });

    const receipt = await confirmHistorical(prepared, "swap");
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(await correctionAmendments([left.orderId, right.orderId])).toHaveLength(2);
    await expectBusinessIdentityAndFundsPreservedAfterCorrection(left.orderId, before.get(left.orderId)!, {
      arrivalDate: rightArrival,
      departureDate: rightDeparture
    });
    await expectBusinessIdentityAndFundsPreservedAfterCorrection(right.orderId, before.get(right.orderId)!, {
      arrivalDate: leftArrival,
      departureDate: leftDeparture
    });

    const [leftView, rightView] = await Promise.all([
      getOrderView(db, left.orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!),
      getOrderView(db, right.orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!)
    ]);
    expect(leftView.effectiveArrangement.intervals).toEqual([{
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: rightArrival,
      departureDate: rightDeparture
    }]);
    expect(rightView.effectiveArrangement.intervals).toEqual([{
      inventoryUnitId: demo.roomId,
      arrivalDate: leftArrival,
      departureDate: leftDeparture
    }]);
    expect(() => JSON.parse(fastJsonStringify(OrderDetailResponseSchema)(leftView))).not.toThrow();
    expect(() => JSON.parse(fastJsonStringify(OrderDetailResponseSchema)(rightView))).not.toThrow();
    const leftHistory = leftView.arrangementHistory.at(-1)!;
    expect(leftHistory.type).toBe("HISTORICAL_STAY_CORRECTION");
    expect(leftHistory.correctionGroup).toMatchObject({
      reason: {
        code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION",
        note: "主管按真实住宿凭据纠正历史安排"
      },
      actor: {
        subjectId: demo.administratorSubjectId,
        displayName: "Demo Administrator"
      },
      recordedAt: expect.any(String),
      corrections: expect.arrayContaining([
        expect.objectContaining({
          orderId: left.orderId,
          before: expect.objectContaining({ inventoryUnitId: demo.roomId, arrivalDate: leftArrival, departureDate: leftDeparture }),
          after: expect.objectContaining({ inventoryUnitId: demo.secondRoomId, arrivalDate: rightArrival, departureDate: rightDeparture })
        }),
        expect.objectContaining({
          orderId: right.orderId,
          before: expect.objectContaining({ inventoryUnitId: demo.secondRoomId, arrivalDate: rightArrival, departureDate: rightDeparture }),
          after: expect.objectContaining({ inventoryUnitId: demo.roomId, arrivalDate: leftArrival, departureDate: leftDeparture })
        })
      ])
    });
    expect(leftHistory.correctionGroup!.corrections).toHaveLength(2);
    expect(intervalForOrder(await board(leftArrival, leftDeparture), demo.roomId, left.orderId)).toBeUndefined();
    expect(intervalForOrder(await board(leftArrival, leftDeparture), demo.roomId, right.orderId))
      .toMatchObject({ status: "SETTLED" });
    expect(intervalForOrder(await board(rightArrival, rightDeparture), demo.secondRoomId, right.orderId)).toBeUndefined();
    expect(intervalForOrder(await board(rightArrival, rightDeparture), demo.secondRoomId, left.orderId))
      .toMatchObject({ status: "SETTLED" });
  });

  it("does not let an overdue in-house stay block its historical departure day during confirmation", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "overdue-departure-day-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -12),
      departureDate: addDays(businessDate, -10)
    });
    const blockerDeparture = addDays(businessDate, -2);
    const overdue = await createOverdueInHouseStay({
      prefix: "overdue-departure-day-blocker",
      unitId: demo.secondRoomId,
      arrivalDate: addDays(businessDate, -4),
      departureDate: blockerDeparture
    });
    const overdueView = await getOrderView(db, overdue.orderId, "WRITE", administratorPrincipal.propertyCommandGrants.get(demo.propertyId)!);
    expect(overdueView.order).toMatchObject({ status: "CHECKED_IN", departure_date: blockerDeparture });
    expect(overdueView.stay).toMatchObject({ status: "IN_HOUSE" });

    const prepared = await previewHistorical([{
      orderId: source.orderId,
      expectedVersion: source.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: blockerDeparture,
        departureDate: addDays(blockerDeparture, 1)
      }
    }], "overdue-departure-day");

    await expect(confirmHistorical(prepared, "overdue-departure-day")).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
  });

  it("rejects conflicts outside the correction set and denies ordinary staff without business writes", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "outside-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -14),
      departureDate: addDays(businessDate, -12)
    });
    const blocker = await createCompletedStay({
      prefix: "outside-blocker",
      unitId: demo.secondRoomId,
      arrivalDate: addDays(businessDate, -13),
      departureDate: addDays(businessDate, -11)
    });
    const sourceBefore = await businessIdentityAndFundsSnapshot(source.orderId);
    const countsBeforeConflict = await businessArtifactCounts();

    await expect(previewHistorical([{
      orderId: source.orderId,
      expectedVersion: source.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: blocker.arrivalDate,
        departureDate: blocker.departureDate
      }
    }], "outside-conflict")).rejects.toMatchObject({
      code: "INVENTORY_CONFLICT",
      details: { orderId: blocker.orderId }
    });
    expect(await businessArtifactCounts()).toEqual(countsBeforeConflict);
    expect(await businessIdentityAndFundsSnapshot(source.orderId)).toEqual(sourceBefore);

    const countsBeforeStaffAttempt = await businessArtifactCounts();
    await expect(previewHistorical([{
      orderId: source.orderId,
      expectedVersion: source.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -10),
        departureDate: addDays(businessDate, -8)
      }
    }], "ordinary-denied", ordinaryPrincipal)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    expect(await businessArtifactCounts()).toEqual(countsBeforeStaffAttempt);
  });

  it("rejects stale previews, serializes concurrent confirms, and replays idempotent confirmation without duplicate facts", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const stale = await createCompletedStay({
      prefix: "stale",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -20),
      departureDate: addDays(businessDate, -18)
    });
    const stalePreview = await previewHistorical([{
      orderId: stale.orderId,
      expectedVersion: stale.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -17),
        departureDate: addDays(businessDate, -15)
      }
    }], "stale-old");
    const freshPreview = await previewHistorical([{
      orderId: stale.orderId,
      expectedVersion: stale.expectedVersion,
      target: {
        inventoryUnitId: demo.roomId,
        arrivalDate: addDays(businessDate, -16),
        departureDate: addDays(businessDate, -14)
      }
    }], "stale-fresh");
    await expect(confirmHistorical(freshPreview, "stale-fresh")).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
    await expect(confirmHistorical(stalePreview, "stale-old")).resolves.toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await correctionAmendments([stale.orderId])).toHaveLength(1);

    const idempotent = await createCompletedStay({
      prefix: "idempotent",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -13),
      departureDate: addDays(businessDate, -11)
    });
    const idempotentPreview = await previewHistorical([{
      orderId: idempotent.orderId,
      expectedVersion: idempotent.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -10),
        departureDate: addDays(businessDate, -8)
      }
    }], "idempotent");
    const idempotentMetadata = metadata("idempotent-confirm");
    const first = await confirmHistorical(idempotentPreview, "idempotent", idempotentMetadata);
    const replay = await confirmHistorical(idempotentPreview, "idempotent-replay", idempotentMetadata);
    expect(replay).toEqual(first);
    expect(await correctionAmendments([idempotent.orderId])).toHaveLength(1);

    const concurrent = await createCompletedStay({
      prefix: "concurrent",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -7),
      departureDate: addDays(businessDate, -5)
    });
    const [leftPreview, rightPreview] = await Promise.all([
      previewHistorical([{
        orderId: concurrent.orderId,
        expectedVersion: concurrent.expectedVersion,
        target: {
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: addDays(businessDate, -4),
          departureDate: addDays(businessDate, -2)
        }
      }], "concurrent-left"),
      previewHistorical([{
        orderId: concurrent.orderId,
        expectedVersion: concurrent.expectedVersion,
        target: {
          inventoryUnitId: demo.roomId,
          arrivalDate: addDays(businessDate, -3),
          departureDate: addDays(businessDate, -1)
        }
      }], "concurrent-right")
    ]);
    const receipts = await Promise.all([
      confirmHistorical(leftPreview, "concurrent-left"),
      confirmHistorical(rightPreview, "concurrent-right")
    ]);
    expect(receipts.filter((receipt) => receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.error?.code === "PREVIEW_STALE")).toHaveLength(1);
    expect(await correctionAmendments([concurrent.orderId])).toHaveLength(1);
  });

  it("serializes the same multi-order correction set when concurrent previews list orders in reverse order", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const leftArrival = addDays(businessDate, -12);
    const leftDeparture = addDays(businessDate, -10);
    const rightArrival = addDays(businessDate, -9);
    const rightDeparture = addDays(businessDate, -7);
    const left = await createCompletedStay({
      prefix: "reverse-concurrent-left",
      unitId: demo.roomId,
      arrivalDate: leftArrival,
      departureDate: leftDeparture
    });
    const right = await createCompletedStay({
      prefix: "reverse-concurrent-right",
      unitId: demo.secondRoomId,
      arrivalDate: rightArrival,
      departureDate: rightDeparture
    });
    const correctionSet: HistoricalCorrectionItem[] = [{
      orderId: left.orderId,
      expectedVersion: left.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: rightArrival,
        departureDate: rightDeparture
      }
    }, {
      orderId: right.orderId,
      expectedVersion: right.expectedVersion,
      target: {
        inventoryUnitId: demo.roomId,
        arrivalDate: leftArrival,
        departureDate: leftDeparture
      }
    }];
    const [forwardPreview, reversePreview] = await Promise.all([
      previewHistorical(correctionSet, "reverse-concurrent-forward"),
      previewHistorical([...correctionSet].reverse(), "reverse-concurrent-reverse")
    ]);
    expect(reversePreview.preview.effect).toEqual(forwardPreview.preview.effect);

    const receipts = await Promise.all([
      confirmHistorical(forwardPreview, "reverse-concurrent-forward"),
      confirmHistorical(reversePreview, "reverse-concurrent-reverse")
    ]);
    expect(receipts.filter((receipt) => receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.error?.code === "PREVIEW_STALE")).toHaveLength(1);
    expect(await correctionAmendments([left.orderId, right.orderId])).toHaveLength(2);
  });

  it("rolls back the complete correction graph when any business, audit, or Receipt write fails", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    for (const [index, failure] of historicalWriteFailureTargets.entries()) {
      const fixture = await createCompletedStay({
        prefix: `write-failure-${failure.table}`,
        unitId: demo.roomId,
        arrivalDate: addDays(businessDate, -40 - index * 3),
        departureDate: addDays(businessDate, -38 - index * 3)
      });
      const prepared = await previewHistorical([{
        orderId: fixture.orderId,
        expectedVersion: fixture.expectedVersion,
        target: {
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: addDays(businessDate, -37 - index * 3),
          departureDate: addDays(businessDate, -35 - index * 3)
        }
      }], `write-failure-${failure.table}`);
      const beforeGraph = await businessIdentityAndFundsSnapshot(fixture.orderId);
      const beforeCounts = await businessArtifactCounts();
      await installHistoricalWriteFailure(failure.table, failure.event);
      try {
        let receipt: ReceiptDto | undefined;
        try {
          receipt = await confirmHistorical(prepared, `write-failure-${failure.table}`);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        if (receipt) {
          expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
        }
      } finally {
        await clearHistoricalWriteFailure(failure.table);
      }
      expect(await businessArtifactCounts(), failure.table).toEqual(beforeCounts);
      expect(await businessIdentityAndFundsSnapshot(fixture.orderId), failure.table).toEqual(beforeGraph);
      expect(await correctionAmendments([fixture.orderId]), failure.table).toHaveLength(0);
    }
  });

  it("rejects direct database partial construction instead of allowing an incomplete correction fact chain", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const fixture = await createCompletedStay({
      prefix: "direct-partial",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });
    const currentSegment = await db.selectFrom("stay_segments")
      .selectAll()
      .where("stay_id", "=", fixture.stayId)
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    const countsBefore = await businessArtifactCounts();

    await expect(db.transaction().execute(async (trx) => {
      const amendmentId = newId("amend");
      await trx.insertInto("amendments").values({
        id: amendmentId,
        order_id: fixture.orderId,
        sequence: fixture.expectedVersion + 1,
        amendment_type: historicalAmendmentType,
        reason_code: "FORGED_HISTORICAL_STAY_CORRECTION",
        reason_note: "Direct partial construction must be rejected by deferred database guards",
        prior_version: fixture.expectedVersion,
        new_version: fixture.expectedVersion + 1,
        payload: {
          operation: historicalCommandType,
          forged: true
        },
        command_id: null
      }).execute();
      await trx.insertInto("stay_segments").values({
        id: newId("segment"),
        stay_id: fixture.stayId,
        sequence: currentSegment.sequence + 1,
        inventory_unit_id: demo.secondRoomId,
        arrival_date: addDays(businessDate, -21),
        departure_date: addDays(businessDate, -19),
        segment_type: historicalAmendmentType,
        supersedes_segment_id: currentSegment.id,
        amendment_id: amendmentId
      }).execute();
      await sql`select 1`.execute(trx);
    })).rejects.toBeTruthy();
    expect(await businessArtifactCounts()).toEqual(countsBefore);
  });

  it.each([
    ["整房", demo.roomId, demo.secondRoomId],
    ["床位", demo.bedAId, demo.bedBId]
  ])("rejects a typed %s correction that leaves an inventory day pointing at its released Claim", async (_label, sourceUnitId, targetUnitId) => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: `released-pointer-${sourceUnitId}`,
      unitId: sourceUnitId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });
    const countsBefore = await businessArtifactCounts();

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: targetUnitId,
      targetArrivalDate: addDays(businessDate, -10),
      targetDepartureDate: addDays(businessDate, -8),
      retainReleasedClaimPointer: true,
      prefix: `released-pointer-${targetUnitId}`
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_claim_pointer_release" });
    expect(await businessArtifactCounts()).toEqual(countsBefore);
  });

  it("rejects a complete forged typed graph whose released historical Claim evidence overlaps an outside active occupancy", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "forged-active-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -20),
      departureDate: addDays(businessDate, -18)
    });
    const blockerArrival = addDays(businessDate, -16);
    const blockerDeparture = addDays(businessDate, -14);
    const blocker = await createCompletedStay({
      prefix: "forged-active-blocker",
      unitId: demo.secondRoomId,
      arrivalDate: blockerArrival,
      departureDate: blockerDeparture
    });
    const blockerSegment = await db.selectFrom("stay_segments")
      .select("id")
      .where("stay_id", "=", blocker.stayId)
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    await db.insertInto("inventory_claims").values({
      id: "forged-active-blocker-claim",
      property_id: demo.propertyId,
      room_id: demo.secondRoomId,
      inventory_unit_id: demo.secondRoomId,
      service_date: blockerArrival,
      source_type: "ORDER_SEGMENT",
      source_id: blockerSegment.id,
      active: true,
      released_at: null
    }).execute();

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: blockerArrival,
      targetDepartureDate: blockerDeparture,
      prefix: "outside-active"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_outside_active_blocker" });
  });

  it("rejects a complete forged typed graph against outside completed projections, including room-versus-bed overlap", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "forged-completed-source",
      unitId: demo.secondRoomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });
    const blocker = await createCompletedStay({
      prefix: "forged-completed-bed-blocker",
      unitId: demo.bedAId,
      arrivalDate: addDays(businessDate, -16),
      departureDate: addDays(businessDate, -14)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.roomId,
      targetArrivalDate: blocker.arrivalDate,
      targetDepartureDate: blocker.departureDate,
      prefix: "outside-completed-room-bed"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_outside_completed_overlap" });
  });

  it("rejects a historical correction Preview whose corrected departure is after the property business date", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "future-preview-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -20),
      departureDate: addDays(businessDate, -18)
    });

    await expect(previewHistorical([{
      orderId: source.orderId,
      expectedVersion: source.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, 365),
        departureDate: addDays(businessDate, 367)
      }
    }], "future-corrected-departure")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a complete SQL correction graph whose corrected departure is after the property business date", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "future-sql-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: addDays(businessDate, 365),
      targetDepartureDate: addDays(businessDate, 367),
      prefix: "future-corrected-departure"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_future_date" });
  });

  it("binds every historical correction root to the exact used Preview effect", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "preview-root-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: addDays(businessDate, -10),
      targetDepartureDate: addDays(businessDate, -8),
      previewTargetDepartureDate: addDays(businessDate, -9),
      prefix: "preview-root-mismatch"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_preview_binding" });
  });

  it("binds the historical correction ALLOWED audit effect hash to its used Preview", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "preview-hash-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: addDays(businessDate, -10),
      targetDepartureDate: addDays(businessDate, -8),
      auditEffectHash: "0".repeat(64),
      prefix: "preview-hash-mismatch"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_preview_binding" });
  });

  it.each([
    ["before nights", (_context: { originalArrival: string; correctedArrival: string }) => ({ beforeNights: 99 })],
    ["after nights", (_context: { originalArrival: string; correctedArrival: string }) => ({ afterNights: 99 })],
    ["before stay timeline", (context: { originalArrival: string; correctedArrival: string }) => ({
      beforeStayTimeline: [
        { serviceDate: context.originalArrival, inventoryUnitId: demo.secondRoomId },
        { serviceDate: addDays(context.originalArrival, 1), inventoryUnitId: demo.roomId }
      ]
    })],
    ["after stay timeline", (context: { originalArrival: string; correctedArrival: string }) => ({
      afterStayTimeline: [
        { serviceDate: context.correctedArrival, inventoryUnitId: demo.secondRoomId },
        { serviceDate: addDays(context.correctedArrival, 2), inventoryUnitId: demo.secondRoomId }
      ]
    })],
    ["unchanged occupant count", (_context: { originalArrival: string; correctedArrival: string }) => ({ occupantCount: 99 })],
    ["unchanged occupant identity", (_context: { originalArrival: string; correctedArrival: string }) => ({
      occupants: [{ ordinal: 1, role: "PRIMARY", fullName: "被替换的住宿人", nickname: "被替换" }]
    })],
    ["collection fact count", (_context: { originalArrival: string; correctedArrival: string }) => ({ collectionFactCount: 99 })],
    ["net recorded collection", (_context: { originalArrival: string; correctedArrival: string }) => ({ netRecordedCollectionMinor: 0 })],
    ["collection difference", (_context: { originalArrival: string; correctedArrival: string }) => ({ collectionDifferenceMinor: 99 })]
  ] satisfies Array<[
    string,
    (context: { originalArrival: string; correctedArrival: string }) => FrozenPreviewFactOverrides
  ]>)("binds the frozen Preview %s to authoritative database facts", async (_label, overrideFactory) => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const originalArrival = addDays(businessDate, -24);
    const correctedArrival = addDays(businessDate, -10);
    const source = await createCompletedStay({
      prefix: `preview-facts-${sequence}`,
      unitId: demo.roomId,
      arrivalDate: originalArrival,
      departureDate: addDays(originalArrival, 2)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: correctedArrival,
      targetDepartureDate: addDays(correctedArrival, 2),
      frozenPreviewFactOverrides: overrideFactory({ originalArrival, correctedArrival }),
      prefix: `preview-facts-${sequence}`
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_preview_database_facts" });
  });

  it("rejects a complete SQL correction graph that freezes the superseded base occupant identity", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "forged-base-occupant",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });
    await correctPrimaryOccupant(source.orderId, "forged-base-occupant");
    const countsBefore = await businessArtifactCounts();

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: addDays(businessDate, -10),
      targetDepartureDate: addDays(businessDate, -8),
      prefix: "forged-base-occupant"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_preview_database_facts" });
    expect(await businessArtifactCounts()).toEqual(countsBefore);
  });

  it.each([
    "amendment",
    "segment",
    "pricingRevision",
    "correction"
  ] satisfies Array<keyof CorrectionCreatedAtOverrides>)(
    "binds the correction %s created_at to the current transaction",
    async (artifact) => {
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const source = await createCompletedStay({
        prefix: `created-at-${artifact}`,
        unitId: demo.roomId,
        arrivalDate: addDays(businessDate, -24),
        departureDate: addDays(businessDate, -22)
      });

      await expect(insertForgedTypedHistoricalCorrectionGraph({
        fixture: source,
        targetInventoryUnitId: demo.secondRoomId,
        targetArrivalDate: addDays(businessDate, -10),
        targetDepartureDate: addDays(businessDate, -8),
        createdAtOverrides: { [artifact]: new Date("2000-01-01T00:00:00.000Z") },
        prefix: `created-at-${artifact}`
      })).rejects.toMatchObject({ constraint: "historical_stay_correction_transaction_time" });
    }
  );

  it("does not let a second ALLOWED audit reference the same used Preview", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "reused-preview-audit",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });
    const prepared = await previewHistorical([{
      orderId: source.orderId,
      expectedVersion: source.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -10),
        departureDate: addDays(businessDate, -8)
      }
    }], "reused-preview-audit");
    await expect(confirmHistorical(prepared, "reused-preview-audit")).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
    const authoritativeAudit = await db.selectFrom("audit_entries")
      .selectAll()
      .where("decision", "=", "ALLOWED")
      .where(sql<boolean>`metadata ->> 'previewId' = ${prepared.preview.previewId}`)
      .executeTakeFirstOrThrow();

    await expect(db.insertInto("audit_entries").values({
      id: newId("audit"),
      subject_id: authoritativeAudit.subject_id,
      credential_id: authoritativeAudit.credential_id,
      action: authoritativeAudit.action,
      decision: "ALLOWED",
      command_id: authoritativeAudit.command_id,
      correlation_id: `${authoritativeAudit.correlation_id}-duplicate`,
      reason: JSON.stringify(authoritativeAudit.reason),
      target_refs: JSON.stringify(authoritativeAudit.target_refs),
      metadata: JSON.stringify(authoritativeAudit.metadata)
    }).execute()).rejects.toMatchObject({
      code: "23505",
      constraint: "audit_entries_allowed_preview_id_unique_idx"
    });
  });

  it("requires historical correction sequences to start at one", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "sequence-start-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: addDays(businessDate, -10),
      targetDepartureDate: addDays(businessDate, -8),
      correctionSequence: 2,
      prefix: "sequence-start-two"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_sequence" });
  });

  it("hides cross-property order existence when building a historical correction", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const otherPropertyId = "prop_historical_correction_scope_other";
    await db.insertInto("properties").values({
      id: otherPropertyId,
      code: "HIST-SCOPE-OTHER",
      name: "Historical correction scope fixture",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    const source = await createCompletedStay({
      prefix: "cross-property-hidden-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });

    await expect(buildHistoricalStayArrangementCorrectionEffect(db, {
      propertyId: otherPropertyId,
      correctionSet: [{
        orderId: source.orderId,
        expectedVersion: source.expectedVersion,
        target: {
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: addDays(businessDate, -10),
          departureDate: addDays(businessDate, -8)
        }
      }],
      evidenceNote: "跨门店资源必须按不存在处理"
    })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("requires each later historical correction sequence to be the exact next value", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "sequence-next-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -24),
      departureDate: addDays(businessDate, -22)
    });
    const first = await previewHistorical([{
      orderId: source.orderId,
      expectedVersion: source.expectedVersion,
      target: {
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: addDays(businessDate, -12),
        departureDate: addDays(businessDate, -10)
      }
    }], "sequence-next-first");
    await expect(confirmHistorical(first, "sequence-next-first")).resolves.toMatchObject({
      businessCommitted: true,
      executionStatus: "EXECUTED"
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.roomId,
      targetArrivalDate: addDays(businessDate, -8),
      targetDepartureDate: addDays(businessDate, -6),
      correctionSequence: 3,
      prefix: "sequence-next-three"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_sequence" });
  });

  it("binds every historical correction audit fact to the command actor", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const source = await createCompletedStay({
      prefix: "forged-actor-source",
      unitId: demo.roomId,
      arrivalDate: addDays(businessDate, -14),
      departureDate: addDays(businessDate, -12)
    });

    await expect(insertForgedTypedHistoricalCorrectionGraph({
      fixture: source,
      targetInventoryUnitId: demo.secondRoomId,
      targetArrivalDate: addDays(businessDate, -10),
      targetDepartureDate: addDays(businessDate, -8),
      actorSubjectId: ordinaryPrincipal.subjectId,
      prefix: "wrong-actor"
    })).rejects.toMatchObject({ constraint: "historical_stay_correction_actor_binding" });
  });
});
