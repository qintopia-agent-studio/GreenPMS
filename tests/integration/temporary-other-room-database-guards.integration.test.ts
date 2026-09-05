import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto, StoredQuoteDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createDatabase,
  createCommandPreview,
  databaseReady,
  propertyLocalToday,
  withMutablePropertyWallClockForTesting,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { stableHash } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import {
  applyHistoricalStayArrangementCorrection,
  lockHistoricalStayArrangementCorrectionResources
} from "../../packages/db/src/admin-historical-stay-corrections.ts";
import { lockCommandResources } from "../../packages/db/src/commands/apply.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const databaseUrl = process.env.TEMPORARY_OTHER_ROOM_GUARDS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_temporary_other_room_guards";

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

const historicalCommandType = "CORRECT_HISTORICAL_STAY_ARRANGEMENTS";
const historicalAmendmentType = "CORRECT_HISTORICAL_STAY_ARRANGEMENT";

const ownerReadinessOptions = {
  identity: "maintenance-owner",
  staffProfileManifestName: "demo"
} as const;

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

function clockInstant(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

async function atPropertyClock<T>(date: string, operation: () => Promise<T>): Promise<T> {
  return withMutablePropertyWallClockForTesting(clockInstant(date), () =>
    withPropertyClockForTesting(clockInstant(date), operation));
}

async function command(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  return confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "TEMPORARY_OTHER_ROOM_GUARD_TEST", note: `确认 ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createMember(memberId: string): Promise<void> {
  memberSequence += 1;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `TEMP-GUARD-${memberSequence}`,
    nickname: `Guard ${memberSequence}`,
    full_name: `Temporary Guard ${memberSequence}`,
    phone: `139${String(memberSequence).padStart(8, "0")}`,
    wechat: `temporary-guard-${memberSequence}`
  }).execute();
  await db.insertInto("member_property_links").values({
    member_id: memberId,
    property_id: demo.propertyId
  }).execute();
}

async function activateProduct(
  memberId: string,
  productId: "membership_product_shared_bath_single_v1" | "membership_product_private_bath_single_v1",
  prefix: string
) {
  const agreedPriceMinor = productId === "membership_product_private_bath_single_v1" ? 216_000 : 162_000;
  const created = await command({
    commandType: "CREATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, memberId, membershipProductId: productId, agreedPriceMinor }
  }, `${prefix}-membership`);
  const membershipOrderId = created.result!.membershipOrderId as string;
  await command({
    commandType: "RECORD_MEMBERSHIP_PAYMENT",
    input: {
      propertyId: demo.propertyId,
      membershipOrderId,
      amountMinor: 1,
      transactionReference: `TEMP-GUARD-${prefix}`
    }
  }, `${prefix}-payment`);
  const activated = await command({
    commandType: "ACTIVATE_MEMBERSHIP_ORDER",
    input: { propertyId: demo.propertyId, membershipOrderId }
  }, `${prefix}-activation`);
  return {
    membershipOrderId,
    contractId: activated.result!.contractId as string,
    lotId: activated.result!.entitlementLotId as string
  };
}

async function insertAdditionalActiveProductSource(
  sourceMembershipOrderId: string,
  productId: "membership_product_shared_bath_single_v1" | "membership_product_private_bath_single_v1",
  prefix: string
) {
  const source = await db.selectFrom("membership_orders")
    .selectAll()
    .where("id", "=", sourceMembershipOrderId)
    .executeTakeFirstOrThrow();
  const product = await db.selectFrom("membership_products")
    .selectAll()
    .where("id", "=", productId)
    .executeTakeFirstOrThrow();
  const sourceContract = await db.selectFrom("member_contracts")
    .selectAll()
    .where("id", "=", source.contract_id!)
    .executeTakeFirstOrThrow();
  if (!source.valid_from || !source.valid_until || !source.activated_by_command_id) {
    throw new Error("Active test membership source is incomplete");
  }
  const membershipOrderId = `membership_order_temporary_guard_${prefix}`;
  const contractId = `contract_temporary_guard_${prefix}`;
  const lotId = `lot_temporary_guard_${prefix}`;
  await db.insertInto("membership_orders").values({
    id: membershipOrderId,
    property_id: source.property_id,
    member_id: source.member_id,
    product_id: product.id,
    product_code: product.code,
    product_version: product.version,
    product_name: product.name,
    listed_price_minor: product.list_price_minor,
    agreed_price_minor: product.list_price_minor,
    price_adjustment_minor: 0,
    price_adjustment_reason: null,
    currency: product.currency,
    entitlement_unit_kind: product.entitlement_unit_kind,
    entitlement_units: product.entitlement_units,
    allowed_room_type_code: product.allowed_room_type_code,
    allowed_inventory_kind: product.allowed_inventory_kind,
    status: "DRAFT",
    activated_at: null,
    valid_from: null,
    valid_until: null,
    contract_id: null,
    entitlement_lot_id: null,
    version: 1,
    created_by_command_id: source.created_by_command_id,
    activated_by_command_id: null
  }).execute();
  await db.insertInto("member_contracts").values({
    id: contractId,
    property_id: source.property_id,
    member_id: source.member_id,
    member_name: sourceContract.member_name,
    status: "ACTIVE",
    valid_from: source.valid_from,
    valid_until: source.valid_until,
    version: 1,
    membership_order_id: membershipOrderId
  }).execute();
  await db.insertInto("entitlement_lots").values({
    id: lotId,
    contract_id: contractId,
    unit_kind: product.entitlement_unit_kind,
    total_units: product.entitlement_units,
    expires_on: source.valid_until,
    version: 1
  }).execute();
  await db.updateTable("membership_orders").set({
    status: "ACTIVE",
    activated_at: new Date(),
    valid_from: source.valid_from,
    valid_until: source.valid_until,
    contract_id: contractId,
    entitlement_lot_id: lotId,
    version: 2,
    activated_by_command_id: source.activated_by_command_id
  }).where("id", "=", membershipOrderId).execute();
  return { membershipOrderId, contractId, lotId };
}

async function inventoryUnitId(code: string): Promise<string> {
  return (await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow()).id;
}

async function quote(options: {
  memberId: string;
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
  temporaryOtherRoom?: true;
}): Promise<StoredQuoteDto> {
  return createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    memberId: options.memberId,
    inventoryUnitId: options.inventoryUnitId,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    ...(options.temporaryOtherRoom ? { temporaryOtherRoom: true } : {})
  });
}

async function prepareTemporaryOrder(
  prefix: string,
  options?: { arrivalOffset?: number; unitCode?: string }
) {
  const memberId = `member_temporary_guard_${prefix}`;
  await createMember(memberId);
  const membership = await activateProduct(
    memberId,
    "membership_product_shared_bath_single_v1",
    prefix
  );
  const today = await propertyLocalToday(db, demo.propertyId);
  const arrivalDate = shiftDate(today, options?.arrivalOffset ?? 10);
  const departureDate = shiftDate(arrivalDate, 2);
  const actualInventoryUnitId = await inventoryUnitId(options?.unitCode ?? "B01");
  const storedQuote = await quote({
    memberId,
    inventoryUnitId: actualInventoryUnitId,
    arrivalDate,
    departureDate,
    temporaryOtherRoom: true
  });
  const reason = `现场临时安排 ${prefix}`;
  const prepared = await createCommandPreview(db, principal, {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: storedQuote.quoteId,
      primaryGuest: { fullName: `Guard ${prefix}`, nickname: prefix },
      temporaryOtherRoomReason: reason
    }
  }, metadata(`${prefix}-preview`));
  return { memberId, membership, arrivalDate, departureDate, prepared, reason };
}

async function confirmTemporaryOrder(prepared: Awaited<ReturnType<typeof prepareTemporaryOrder>>): Promise<ReceiptDto> {
  return confirmCommandPreview(db, principal, prepared.prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: prepared.prepared.preview.effectHash,
    reason: { code: "TEMPORARY_OTHER_ROOM", note: prepared.reason }
  }, metadata(`${prepared.memberId}-confirm`));
}

async function completeTemporaryOrder(prefix: string) {
  const today = await propertyLocalToday(db, demo.propertyId);
  const setupDate = shiftDate(today, -6);
  const prepared = await atPropertyClock(setupDate, () =>
    prepareTemporaryOrder(prefix, { arrivalOffset: 1, unitCode: "B01" }));
  const created = await atPropertyClock(setupDate, () => confirmTemporaryOrder(prepared));
  expect(created, JSON.stringify(created, null, 2)).toMatchObject({
    executionStatus: "EXECUTED",
    businessCommitted: true
  });
  const orderId = created.result!.orderId as string;
  await atPropertyClock(prepared.arrivalDate, () => command({
    commandType: "CHECK_IN",
    input: { propertyId: demo.propertyId, orderId }
  }, `${prefix}-check-in`));
  await atPropertyClock(prepared.departureDate, () => command({
    commandType: "CHECK_OUT",
    input: { propertyId: demo.propertyId, orderId }
  }, `${prefix}-check-out`));
  const completed = await db.selectFrom("orders")
    .innerJoin("stays", "stays.order_id", "orders.id")
    .select([
      "orders.id as order_id",
      "stays.id as stay_id",
      "orders.status as order_status",
      "stays.status as stay_status",
      "orders.version as version"
    ])
    .where("orders.id", "=", orderId)
    .executeTakeFirstOrThrow();
  expect(completed).toMatchObject({
    order_status: "CHECKED_OUT",
    stay_status: "COMPLETED"
  });
  return {
    orderId,
    stayId: completed.stay_id,
    expectedVersion: completed.version,
    targetArrivalDate: shiftDate(today, -2),
    targetDepartureDate: shiftDate(today, -1)
  };
}

async function compatibleHistoricalRoomTarget(sourceUnitId: string): Promise<string> {
  const row = await db.selectFrom("inventory_units as source")
    .innerJoin("inventory_units as target", (join) => join
      .onRef("target.property_id", "=", "source.property_id")
      .onRef("target.kind", "=", "source.kind")
      .onRef("target.pricing_product_code", "=", "source.pricing_product_code"))
    .select("target.id")
    .where("source.id", "=", sourceUnitId)
    .where("target.id", "!=", sourceUnitId)
    .where("target.active", "=", true)
    .orderBy("target.code")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function historicalCorrectionRuntimeGraph(input: {
  orderId: string;
  stayId: string;
  expectedVersion: number;
  targetArrivalDate: string;
  targetDepartureDate: string;
  prefix: string;
}) {
  const [
    order,
    currentSegment,
    currentRevision,
    occupantRows,
    collectionSummary
  ] = await Promise.all([
    db.selectFrom("orders").selectAll().where("id", "=", input.orderId).executeTakeFirstOrThrow(),
    db.selectFrom("stay_segments").selectAll().where("stay_id", "=", input.stayId)
      .orderBy("sequence", "desc").executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").selectAll().where("id", "=", sql<string>`(
      SELECT current_revision_id FROM orders WHERE id = ${input.orderId}
    )`).executeTakeFirstOrThrow(),
    db.selectFrom("order_occupants").select(["ordinal", "role", "full_name", "nickname"])
      .where("order_id", "=", input.orderId).orderBy("ordinal").execute(),
    db.selectFrom("collection_facts").select(({ fn }) => [
      fn.countAll<string>().as("count"),
      fn.coalesce(fn.sum<number>("net_effect_minor"), sql<number>`0`).as("net")
    ]).where("order_id", "=", input.orderId).executeTakeFirstOrThrow()
  ]);
  const targetInventoryUnitId = await compatibleHistoricalRoomTarget(currentSegment.inventory_unit_id);
  const beforeTimeline = [];
  for (
    let serviceDate = currentSegment.arrival_date;
    serviceDate < currentSegment.departure_date;
    serviceDate = shiftDate(serviceDate, 1)
  ) {
    beforeTimeline.push({ serviceDate, inventoryUnitId: currentSegment.inventory_unit_id });
  }
  const afterTimeline = [];
  for (
    let serviceDate = input.targetArrivalDate;
    serviceDate < input.targetDepartureDate;
    serviceDate = shiftDate(serviceDate, 1)
  ) {
    afterTimeline.push({ serviceDate, inventoryUnitId: targetInventoryUnitId });
  }
  const correction = {
    orderId: input.orderId,
    stayId: input.stayId,
    expectedVersion: input.expectedVersion,
    before: {
      inventoryUnitId: currentSegment.inventory_unit_id,
      arrivalDate: currentSegment.arrival_date,
      departureDate: currentSegment.departure_date,
      nights: beforeTimeline.length,
      stayTimeline: beforeTimeline
    },
    after: {
      inventoryUnitId: targetInventoryUnitId,
      arrivalDate: input.targetArrivalDate,
      departureDate: input.targetDepartureDate,
      nights: afterTimeline.length,
      stayTimeline: afterTimeline
    },
    unchanged: {
      orderStatus: "CHECKED_OUT",
      stayStatus: "COMPLETED",
      stayType: order.stay_type,
      currentRevisionId: currentRevision.id,
      currentContractAmountMinor: currentRevision.current_contract_amount_minor,
      currency: currentRevision.currency,
      occupantCount: occupantRows.length,
      occupants: occupantRows.map((occupant) => ({
        ordinal: occupant.ordinal,
        role: occupant.role,
        fullName: occupant.full_name,
        nickname: occupant.nickname
      })),
      collectionFactCount: Number(collectionSummary.count),
      netRecordedCollectionMinor: Number(collectionSummary.net),
      collectionDifferenceMinor: currentRevision.current_contract_amount_minor - Number(collectionSummary.net)
    }
  };
  const effect = { operation: historicalCommandType, corrections: [correction] };
  const basisVersions = {
    propertyId: demo.propertyId,
    correctionSetHash: stableHash([{
      orderId: correction.orderId,
      expectedVersion: correction.expectedVersion,
      after: correction.after
    }])
  };
  return {
    commandId: `temporary-historical-${input.prefix}-command`,
    previewId: `temporary-historical-${input.prefix}-preview`,
    receiptId: `temporary-historical-${input.prefix}-receipt`,
    auditId: `temporary-historical-${input.prefix}-audit`,
    correlationId: `temporary-historical-${input.prefix}`,
    input: {
      propertyId: demo.propertyId,
      correctionSet: [{
        orderId: input.orderId,
        expectedVersion: input.expectedVersion,
        target: {
          inventoryUnitId: targetInventoryUnitId,
          arrivalDate: input.targetArrivalDate,
          departureDate: input.targetDepartureDate
        }
      }],
      evidenceNote: "交接记录与原始住宿凭据已复核"
    },
    effect,
    basisVersions,
    effectHash: stableHash({ effect, basisVersions }),
    reason: {
      code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION",
      note: "主管按真实住宿凭据纠正历史安排"
    }
  };
}

async function insertForgedHistoricalCorrectionRuntimeGraphForTemporaryOrder(input: {
  orderId: string;
  stayId: string;
  expectedVersion: number;
  targetArrivalDate: string;
  targetDepartureDate: string;
  prefix: string;
}): Promise<void> {
  const graph = await historicalCorrectionRuntimeGraph(input);
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE qintopia_runtime`.execute(trx);
    await trx.insertInto("command_executions").values({
      id: graph.commandId,
      subject_id: administratorPrincipal.subjectId,
      credential_id: administratorPrincipal.credentialId,
      property_id: demo.propertyId,
      command_type: historicalCommandType,
      idempotency_key: graph.correlationId,
      request_hash: "a".repeat(64),
      correlation_id: graph.correlationId,
      state: "EXECUTING",
      completed_at: null
    }).execute();
    await trx.insertInto("command_previews").values({
      id: graph.previewId,
      subject_id: administratorPrincipal.subjectId,
      property_id: demo.propertyId,
      command_type: historicalCommandType,
      normalized_input: graph.input,
      input_hash: "c".repeat(64),
      effect: graph.effect,
      effect_hash: graph.effectHash,
      basis_versions: graph.basisVersions,
      expires_at: new Date(Date.now() + 10 * 60_000),
      status: "USED",
      used_at: new Date()
    }).execute();
    await lockHistoricalStayArrangementCorrectionResources(trx, graph.input);
    await applyHistoricalStayArrangementCorrection(trx, {
      input: graph.input,
      effect: graph.effect,
      reason: graph.reason,
      commandId: graph.commandId
    });
    await trx.updateTable("command_executions").set({
      state: "APPLIED",
      completed_at: sql<Date>`transaction_timestamp()`
    }).where("id", "=", graph.commandId).execute();
    await trx.insertInto("command_receipts").values({
      id: graph.receiptId,
      command_id: graph.commandId,
      execution_status: "EXECUTED",
      business_committed: true,
      result: { operation: historicalCommandType },
      error: null,
      resource_refs: JSON.stringify([input.orderId, input.stayId]),
      fact_refs: JSON.stringify([]),
      committed_at: sql<Date>`transaction_timestamp()`
    }).execute();
    await trx.insertInto("audit_entries").values({
      id: graph.auditId,
      subject_id: administratorPrincipal.subjectId,
      credential_id: administratorPrincipal.credentialId,
      action: historicalCommandType,
      decision: "ALLOWED",
      command_id: graph.commandId,
      correlation_id: graph.correlationId,
      reason: graph.reason,
      target_refs: JSON.stringify([input.orderId]),
      metadata: { previewId: graph.previewId, effectHash: graph.effectHash }
    }).execute();
  });
}

async function businessFactCounts(): Promise<Record<string, unknown>> {
  const [
    orders,
    occupants,
    stays,
    amendments,
    segments,
    revisions,
    claims,
    coverage,
    ledger,
    collections,
    appliedCommands,
    executedReceipts,
    allowedAudits,
    usedPreviews,
    historicalCorrections,
    roomDays,
    lots,
    roomStatusRevision
  ] = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("order_occupants").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stays").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("amendments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("stay_segments").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_revisions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("coverage_items").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("entitlement_ledger").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("collection_facts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("state", "=", "APPLIED").executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("business_committed", "=", true).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("decision", "=", "ALLOWED").executeTakeFirstOrThrow(),
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("status", "=", "USED").executeTakeFirstOrThrow(),
    db.selectFrom("historical_stay_arrangement_corrections").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_room_days")
      .select(["room_id", "service_date", "whole_claim_id", "version"])
      .orderBy("room_id").orderBy("service_date").execute(),
    db.selectFrom("entitlement_lots").select(["id", "total_units", "status", "version"])
      .orderBy("id").execute(),
    db.selectFrom("room_status_revisions").select(["property_id", "revision"])
      .where("property_id", "=", demo.propertyId).executeTakeFirst()
  ]);
  return {
    counts: [
      orders, occupants, stays, amendments, segments, revisions, claims, coverage,
      ledger, collections, appliedCommands, executedReceipts, allowedAudits, usedPreviews,
      historicalCorrections
    ].map((row) => Number(row.count)),
    roomDays,
    lots,
    roomStatusRevision: roomStatusRevision?.revision ?? null
  };
}

async function expectTamperedConfirmationToRollBack(
  prepared: Awaited<ReturnType<typeof prepareTemporaryOrder>>,
  before: Record<string, unknown>
): Promise<void> {
  await expect(confirmTemporaryOrder(prepared)).resolves.toMatchObject({
    executionStatus: "NOT_EXECUTED",
    businessCommitted: false
  });
  expect(await businessFactCounts()).toEqual(before);
}

const postResolutionBlockerKey = "qintopia:test:temporary-other-room-after-source-resolution";

type AdvisoryHolder = {
  client: pg.Client;
  key: string;
  pid: number;
  released: boolean;
};

async function holdAdvisoryLock(key: string): Promise<AdvisoryHolder> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid()::integer AS pid")).rows[0]!.pid;
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0::bigint))", [key]);
  return { client, key, pid, released: false };
}

async function releaseAdvisoryLock(holder: AdvisoryHolder): Promise<void> {
  if (holder.released) return;
  await holder.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0::bigint))", [holder.key]);
  holder.released = true;
}

async function closeAdvisoryHolder(holder: AdvisoryHolder): Promise<void> {
  await holder.client.query("ROLLBACK").catch(() => undefined);
  await releaseAdvisoryLock(holder).catch(() => undefined);
  await holder.client.end();
}

async function advisoryWaiterCount(holderPid?: number): Promise<number> {
  const result = holderPid === undefined
    ? await sql<{ count: string }>`
        SELECT count(DISTINCT waiting.pid)::text AS count
        FROM pg_locks AS waiting
        WHERE waiting.locktype = 'advisory'
          AND NOT waiting.granted
          AND waiting.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `.execute(db)
    : await sql<{ count: string }>`
        SELECT count(DISTINCT waiting.pid)::text AS count
        FROM pg_locks AS held
        JOIN pg_locks AS waiting
          ON waiting.locktype = held.locktype
          AND waiting.database IS NOT DISTINCT FROM held.database
          AND waiting.classid IS NOT DISTINCT FROM held.classid
          AND waiting.objid IS NOT DISTINCT FROM held.objid
          AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          AND waiting.pid <> held.pid
        WHERE held.pid = ${holderPid}
          AND held.locktype = 'advisory'
          AND held.granted
          AND NOT waiting.granted
      `.execute(db);
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForAdvisoryWaiters(minimum: number, holderPid?: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await advisoryWaiterCount(holderPid) >= minimum) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory lock waiter(s)`);
}

async function installPostResolutionOrderBlocker(): Promise<void> {
  await sql.raw(`
    CREATE OR REPLACE FUNCTION qintopia_test_block_after_temporary_source_resolution() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'qintopia:test:temporary-other-room-after-source-resolution',
        0::bigint
      ));
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER qintopia_test_block_after_temporary_source_resolution
      BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION qintopia_test_block_after_temporary_source_resolution()
  `).execute(db);
}

beforeEach(async () => {
  sequence = 0;
  memberSequence = 0;
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db?.destroy();
});

describe.sequential("temporary other-room database guards", () => {
  it("fails closed when a completed temporary order receives a forged historical stay arrangement correction graph", async () => {
    const completed = await completeTemporaryOrder("historical-correction-closed");
    const before = await businessFactCounts();

    await expect(insertForgedHistoricalCorrectionRuntimeGraphForTemporaryOrder({
      ...completed,
      prefix: "historical-correction-closed"
    })).rejects.toMatchObject({
      constraint: "temporary_other_room_lifecycle_closed"
    });
    expect(await businessFactCounts()).toEqual(before);
  });

  it("takes the shared member entitlement lock before locking a temporary order", async () => {
    const prepared = await prepareTemporaryOrder("lifecycle-lock-order");
    const created = await confirmTemporaryOrder(prepared);
    const orderId = created.result!.orderId as string;
    const holder = await holdAdvisoryLock(`qintopia:member-entitlements:${prepared.memberId}`);
    const lifecycleLock = db.transaction().execute((trx) => lockCommandResources(trx, "CANCEL_ORDER", {
      propertyId: demo.propertyId,
      orderId
    }));
    try {
      await waitForAdvisoryWaiters(1, holder.pid);
      await holder.client.query("BEGIN");
      await holder.client.query("SET LOCAL lock_timeout = '1s'");
      await expect(holder.client.query(
        "SELECT id FROM orders WHERE id = $1 FOR UPDATE",
        [orderId]
      )).resolves.toMatchObject({ rowCount: 1 });
      await holder.client.query("ROLLBACK");
      await releaseAdvisoryLock(holder);
      await expect(lifecycleLock).resolves.toBeUndefined();
    } finally {
      await releaseAdvisoryLock(holder).catch(() => undefined);
      await lifecycleLock.catch(() => undefined);
      await closeAdvisoryHolder(holder);
    }
  });

  it("takes the shared member entitlement lock before contract and Lot row locks for every entitlement mutation", async () => {
    const contractOnlyQuote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      arrivalDate: "2028-08-10",
      departureDate: "2028-08-11",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberContractId: demo.memberContractId
    });
    const holder = await holdAdvisoryLock(`qintopia:member-entitlements:${demo.memberId}`);
    const inputs: Array<[CommandEnvelope["commandType"], Record<string, unknown>]> = [
      ["CREATE_ORDER", { propertyId: demo.propertyId, quoteId: contractOnlyQuote.quoteId }],
      ["ADD_MEMBER_ENTITLEMENT_LOT", { propertyId: demo.propertyId, memberContractId: demo.memberContractId }],
      ["ADJUST_MEMBER_ENTITLEMENT", { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId }],
      ["CORRECT_MEMBER_ENTITLEMENT_BALANCE", { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId }],
      ["EXPIRE_MEMBER_ENTITLEMENT", { propertyId: demo.propertyId, entitlementLotId: demo.roomLotId }]
    ];
    const attempts = inputs.map(([commandType, input]) => db.transaction().execute(
      (trx) => lockCommandResources(trx, commandType, input)
    ));
    try {
      await waitForAdvisoryWaiters(inputs.length, holder.pid);
      await holder.client.query("BEGIN");
      await holder.client.query("SET LOCAL lock_timeout = '1s'");
      await expect(holder.client.query(
        "SELECT id FROM member_contracts WHERE id = $1 FOR UPDATE",
        [demo.memberContractId]
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(holder.client.query(
        "SELECT id FROM entitlement_lots WHERE id = $1 FOR UPDATE",
        [demo.roomLotId]
      )).resolves.toMatchObject({ rowCount: 1 });
      await holder.client.query("ROLLBACK");
      await releaseAdvisoryLock(holder);
      await expect(Promise.all(attempts)).resolves.toHaveLength(inputs.length);
    } finally {
      await releaseAdvisoryLock(holder).catch(() => undefined);
      await Promise.all(attempts.map((attempt) => attempt.catch(() => undefined)));
      await closeAdvisoryHolder(holder);
    }
  });

  it("fails closed when a contract-only quote has a missing member owner", async () => {
    const ownerlessContractId = "contract_temporary_guard_ownerless";
    await sql.raw("ALTER TABLE member_contracts DISABLE TRIGGER member_contracts_validate_new_member").execute(db);
    try {
      await db.insertInto("member_contracts").values({
        id: ownerlessContractId,
        property_id: demo.propertyId,
        member_id: null,
        member_name: "Ownerless legacy contract",
        status: "ACTIVE",
        valid_from: "2026-01-01",
        valid_until: "2029-12-31",
        version: 1,
        membership_order_id: null
      }).execute();
    } finally {
      await sql.raw("ALTER TABLE member_contracts ENABLE TRIGGER member_contracts_validate_new_member").execute(db);
    }
    await db.insertInto("entitlement_lots").values({
      id: "lot_temporary_guard_ownerless",
      contract_id: ownerlessContractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 1,
      expires_on: "2029-12-31",
      status: "ACTIVE",
      version: 1
    }).execute();
    const ownerlessQuote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      arrivalDate: "2028-08-10",
      departureDate: "2028-08-11",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberContractId: ownerlessContractId
    });
    const lockQuote = (quoteId: string) => db.transaction().execute((trx) => lockCommandResources(trx, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId
    }));

    await expect(lockQuote(ownerlessQuote.quoteId)).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
  });

  it("serializes a selected-Lot balance change after temporary source resolution", async () => {
    const prepared = await prepareTemporaryOrder("selected-balance-race");
    const balancePreview = await createCommandPreview(db, principal, {
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: prepared.membership.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 29,
        adjustmentReason: "验证唯一来源扫描后的余额竞争"
      }
    }, metadata("selected-balance-race-preview"));
    await installPostResolutionOrderBlocker();
    const holder = await holdAdvisoryLock(postResolutionBlockerKey);
    let createAttempt: Promise<ReceiptDto> | undefined;
    let balanceAttempt: Promise<ReceiptDto> | undefined;
    try {
      createAttempt = confirmTemporaryOrder(prepared);
      await waitForAdvisoryWaiters(1, holder.pid);
      balanceAttempt = confirmCommandPreview(db, principal, balancePreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
        confirmation: true,
        expectedEffectHash: balancePreview.preview.effectHash,
        reason: { code: "TEMPORARY_OTHER_ROOM_RACE", note: "验证唯一来源扫描后的余额竞争" }
      }, metadata("selected-balance-race-confirm"));
      await waitForAdvisoryWaiters(2);
      await releaseAdvisoryLock(holder);
      const [createReceipt, balanceReceipt] = await Promise.all([createAttempt, balanceAttempt]);
      expect(createReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
      expect(balanceReceipt).toMatchObject({
        businessCommitted: false,
        executionStatus: "NOT_EXECUTED",
        error: { code: "VALIDATION_ERROR" }
      });
    } finally {
      await releaseAdvisoryLock(holder).catch(() => undefined);
      await Promise.all([createAttempt, balanceAttempt].flatMap((attempt) => attempt ? [attempt.catch(() => undefined)] : []));
      await closeAdvisoryHolder(holder);
    }
  });

  it("serializes a second complete source becoming eligible after temporary source resolution", async () => {
    const memberId = "member_temporary_guard_second_source_race";
    await createMember(memberId);
    const primary = await activateProduct(memberId, "membership_product_shared_bath_single_v1", "second-source-race-primary");
    const secondary = await insertAdditionalActiveProductSource(
      primary.membershipOrderId,
      "membership_product_shared_bath_single_v1",
      "second-source-race-secondary"
    );
    await command({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: secondary.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 1,
        adjustmentReason: "构造尚不足以成为第二完整来源的权益"
      }
    }, "second-source-race-lower");
    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 10);
    const departureDate = shiftDate(arrivalDate, 2);
    const storedQuote = await quote({
      memberId,
      inventoryUnitId: await inventoryUnitId("B01"),
      arrivalDate,
      departureDate,
      temporaryOtherRoom: true
    });
    const reason = "验证唯一来源扫描后的第二来源竞争";
    const createPreview = await createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: storedQuote.quoteId,
        primaryGuest: { fullName: "Second Source Race", nickname: "source-race" },
        temporaryOtherRoomReason: reason
      }
    }, metadata("second-source-race-create-preview"));
    const expansionPreview = await createCommandPreview(db, principal, {
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: secondary.lotId,
        expectedAvailableBalance: 1,
        targetAvailableBalance: 30,
        adjustmentReason: "使第二来源重新具备完整覆盖能力"
      }
    }, metadata("second-source-race-expansion-preview"));
    await installPostResolutionOrderBlocker();
    const holder = await holdAdvisoryLock(postResolutionBlockerKey);
    let createAttempt: Promise<ReceiptDto> | undefined;
    let expansionAttempt: Promise<ReceiptDto> | undefined;
    try {
      createAttempt = confirmCommandPreview(db, principal, createPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CREATE_ORDER",
        confirmation: true,
        expectedEffectHash: createPreview.preview.effectHash,
        reason: { code: "TEMPORARY_OTHER_ROOM", note: reason }
      }, metadata("second-source-race-create-confirm"));
      await waitForAdvisoryWaiters(1, holder.pid);
      expansionAttempt = confirmCommandPreview(db, principal, expansionPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
        confirmation: true,
        expectedEffectHash: expansionPreview.preview.effectHash,
        reason: { code: "TEMPORARY_OTHER_ROOM_RACE", note: "使第二来源重新具备完整覆盖能力" }
      }, metadata("second-source-race-expansion-confirm"));
      await waitForAdvisoryWaiters(2);
      await releaseAdvisoryLock(holder);
      const [createReceipt, expansionReceipt] = await Promise.all([createAttempt, expansionAttempt]);
      expect(createReceipt).toMatchObject({
        businessCommitted: true,
        executionStatus: "EXECUTED",
        result: { temporaryOtherRoomArrangement: { entitlementLotId: primary.lotId } }
      });
      expect(expansionReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
    } finally {
      await releaseAdvisoryLock(holder).catch(() => undefined);
      await Promise.all([createAttempt, expansionAttempt].flatMap((attempt) => attempt ? [attempt.catch(() => undefined)] : []));
      await closeAdvisoryHolder(holder);
    }
  });

  it("keeps a partially covering exact-room entitlement on the ordinary member path", async () => {
    const memberId = "member_temporary_guard_exact_priority";
    await createMember(memberId);
    const mismatch = await activateProduct(memberId, "membership_product_shared_bath_single_v1", "exact-mismatch");
    const exact = await insertAdditionalActiveProductSource(
      mismatch.membershipOrderId,
      "membership_product_private_bath_single_v1",
      "exact-match"
    );
    await command({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: exact.lotId,
        expectedAvailableBalance: 30,
        targetAvailableBalance: 1,
        adjustmentReason: "构造仅覆盖一晚的精确房型权益"
      }
    }, "exact-partial-balance");

    const today = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = shiftDate(today, 12);
    const departureDate = shiftDate(arrivalDate, 2);
    const actualInventoryUnitId = await inventoryUnitId("B01");
    const ordinary = await quote({ memberId, inventoryUnitId: actualInventoryUnitId, arrivalDate, departureDate });

    expect(ordinary.coverageSet).toHaveLength(1);
    expect(ordinary.coverageSet[0]).toMatchObject({ entitlementLotId: exact.lotId });
    expect(ordinary.currentContractAmount.minorUnits).toBeGreaterThan(0);
    await expect(quote({
      memberId,
      inventoryUnitId: actualInventoryUnitId,
      arrivalDate,
      departureDate,
      temporaryOtherRoom: true
    })).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT" });
  });

  it("rolls back when a same-command adjustment drives the selected Lot negative after HOLD", async () => {
    const prepared = await prepareTemporaryOrder("negative-balance");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_negative_balance() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entry_type = 'HOLD' AND NOT EXISTS (
          SELECT 1 FROM entitlement_ledger
          WHERE fact_id = 'fact_temporary_negative_' || NEW.command_id
        ) THEN
          INSERT INTO entitlement_ledger (
            fact_id, lot_id, entry_type, quantity_delta, service_date,
            order_id, coverage_id, reason, command_id
          ) VALUES (
            'fact_temporary_negative_' || NEW.command_id,
            NEW.lot_id, 'ADJUST', -2147483647, NULL,
            NULL, NULL, 'TEMPORARY_GUARD_NEGATIVE_BALANCE', NULL
          );
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_negative_balance
        AFTER INSERT ON entitlement_ledger
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_negative_balance()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back when a second complete mismatched source appears after effect rebuild", async () => {
    const prepared = await prepareTemporaryOrder("second-source");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_second_source() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        source_membership membership_orders%ROWTYPE;
        source_contract member_contracts%ROWTYPE;
        second_order_id text := 'membership_order_second_' || NEW.command_id;
        second_contract_id text := 'contract_second_' || NEW.command_id;
        second_lot_id text := 'lot_second_' || NEW.command_id;
      BEGIN
        IF NEW.execution_status = 'EXECUTED' AND NEW.business_committed AND EXISTS (
          SELECT 1 FROM command_executions AS execution
          WHERE execution.id = NEW.command_id
            AND execution.command_type = 'CREATE_ORDER'
        ) THEN
          SELECT membership_order.* INTO source_membership
          FROM amendments AS amendment
          JOIN membership_orders AS membership_order
            ON membership_order.id = amendment.payload #>> '{temporaryOtherRoomArrangement,membershipOrderId}'
          WHERE amendment.command_id = NEW.command_id
            AND amendment.amendment_type = 'CREATE_ORDER';
          SELECT * INTO source_contract
          FROM member_contracts
          WHERE id = source_membership.contract_id;

          INSERT INTO membership_orders (
            id, property_id, member_id, product_id, product_code, product_version,
            product_name, listed_price_minor, agreed_price_minor, price_adjustment_minor,
            price_adjustment_reason, currency, entitlement_unit_kind, entitlement_units,
            allowed_room_type_code, allowed_inventory_kind, status, activated_at,
            valid_from, valid_until, contract_id, entitlement_lot_id, version,
            created_by_command_id, activated_by_command_id
          ) VALUES (
            second_order_id, source_membership.property_id, source_membership.member_id,
            source_membership.product_id, source_membership.product_code,
            source_membership.product_version, source_membership.product_name,
            source_membership.listed_price_minor, source_membership.agreed_price_minor,
            source_membership.price_adjustment_minor, source_membership.price_adjustment_reason,
            source_membership.currency, source_membership.entitlement_unit_kind,
            source_membership.entitlement_units, source_membership.allowed_room_type_code,
            source_membership.allowed_inventory_kind, 'DRAFT', NULL, NULL, NULL, NULL, NULL,
            1, source_membership.created_by_command_id, NULL
          );
          INSERT INTO member_contracts (
            id, property_id, member_id, member_name, status, valid_from, valid_until,
            version, membership_order_id
          ) VALUES (
            second_contract_id, source_contract.property_id, source_contract.member_id,
            source_contract.member_name, 'ACTIVE', source_contract.valid_from,
            source_contract.valid_until, 1, second_order_id
          );
          INSERT INTO entitlement_lots (
            id, contract_id, unit_kind, total_units, expires_on, version
          ) VALUES (
            second_lot_id, second_contract_id, source_membership.entitlement_unit_kind,
            source_membership.entitlement_units, source_contract.valid_until, 1
          );
          UPDATE membership_orders SET
            status = 'ACTIVE',
            activated_at = transaction_timestamp(),
            valid_from = source_contract.valid_from,
            valid_until = source_contract.valid_until,
            contract_id = second_contract_id,
            entitlement_lot_id = second_lot_id,
            version = 2,
            activated_by_command_id = source_membership.activated_by_command_id
          WHERE id = second_order_id;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_second_source
        BEFORE INSERT ON command_receipts
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_second_source()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back the complete temporary arrangement graph before and after every material write stage", async () => {
    const stages = [
      { label: "amendment", table: "amendments", condition: "NEW.amendment_type = 'CREATE_ORDER' AND NEW.reason_code = 'TEMPORARY_OTHER_ROOM'" },
      { label: "claim", table: "inventory_claims", condition: "NEW.source_type = 'ORDER_SEGMENT'" },
      { label: "coverage", table: "coverage_items", condition: "NEW.status = 'HELD'" },
      { label: "ledger", table: "entitlement_ledger", condition: "NEW.entry_type = 'HOLD' AND NEW.reason = 'ORDER_COVERAGE_HOLD'" },
      { label: "receipt", table: "command_receipts", condition: "NEW.execution_status = 'EXECUTED' AND NEW.business_committed" }
    ] as const;

    for (const stage of stages) {
      for (const timing of ["BEFORE", "AFTER"] as const) {
        const prefix = `fault-${stage.label}-${timing.toLowerCase()}`;
        const prepared = await prepareTemporaryOrder(prefix);
        const before = await businessFactCounts();
        await sql.raw(`
          CREATE OR REPLACE FUNCTION qintopia_test_reject_temporary_write() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF ${stage.condition} THEN
              RAISE EXCEPTION 'injected temporary arrangement ${stage.label} ${timing.toLowerCase()} failure';
            END IF;
            RETURN NEW;
          END
          $$;
          CREATE TRIGGER qintopia_test_reject_temporary_write
            ${timing} INSERT ON ${stage.table}
            FOR EACH ROW EXECUTE FUNCTION qintopia_test_reject_temporary_write()
        `).execute(db);

        let receipt: ReceiptDto;
        try {
          receipt = await confirmTemporaryOrder(prepared);
        } finally {
          await sql.raw(`DROP TRIGGER qintopia_test_reject_temporary_write ON ${stage.table}`).execute(db);
        }
        expect(receipt, prefix).toMatchObject({
          executionStatus: "NOT_EXECUTED",
          businessCommitted: false,
          error: { code: "COMMAND_INTERRUPTED" }
        });
        expect(await businessFactCounts(), prefix).toEqual(before);
      }
    }
  });

  it("rolls back an extra INITIAL segment appended to the create-order graph", async () => {
    const prepared = await prepareTemporaryOrder("extra-segment");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_extra_segment() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.segment_type = 'INITIAL' AND NEW.id NOT LIKE 'segment_temporary_extra_%' THEN
          INSERT INTO stay_segments (
            id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date,
            segment_type, supersedes_segment_id, amendment_id
          ) VALUES (
            'segment_temporary_extra_' || NEW.id, NEW.stay_id, 2,
            NEW.inventory_unit_id, NEW.arrival_date, NEW.departure_date,
            'INITIAL', NULL, NEW.amendment_id
          );
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_extra_segment
        AFTER INSERT ON stay_segments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_extra_segment()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back an extra inactive Claim attached to the legitimate INITIAL segment", async () => {
    const prepared = await prepareTemporaryOrder("extra-claim");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_extra_claim() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_type = 'ORDER_SEGMENT'
          AND NEW.active
          AND NEW.id NOT LIKE 'claim_temporary_extra_%' THEN
          INSERT INTO inventory_claims (
            id, property_id, room_id, inventory_unit_id, service_date,
            source_type, source_id, active, released_at
          ) VALUES (
            'claim_temporary_extra_' || NEW.id, NEW.property_id, NEW.room_id,
            NEW.inventory_unit_id, NEW.service_date, NEW.source_type, NEW.source_id,
            false, transaction_timestamp()
          );
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_extra_claim
        AFTER INSERT ON inventory_claims
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_extra_claim()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back an unrelated Stay segment inserted by the same create-order transaction", async () => {
    const baseline = await prepareTemporaryOrder("unrelated-segment-baseline", { arrivalOffset: 40, unitCode: "B02" });
    await expect(confirmTemporaryOrder(baseline)).resolves.toMatchObject({ businessCommitted: true });
    const prepared = await prepareTemporaryOrder("unrelated-segment");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_unrelated_segment() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        other_segment stay_segments%ROWTYPE;
        next_sequence integer;
      BEGIN
        IF NEW.segment_type = 'INITIAL' AND NEW.id NOT LIKE 'segment_temporary_unrelated_%' THEN
          SELECT segment.* INTO other_segment
          FROM stay_segments AS segment
          WHERE segment.stay_id IS DISTINCT FROM NEW.stay_id
          ORDER BY segment.id
          LIMIT 1;
          IF other_segment.id IS NOT NULL THEN
            SELECT coalesce(max(segment.sequence), 0) + 1 INTO next_sequence
            FROM stay_segments AS segment
            WHERE segment.stay_id = other_segment.stay_id;
            INSERT INTO stay_segments (
              id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date,
              segment_type, supersedes_segment_id, amendment_id
            ) VALUES (
              'segment_temporary_unrelated_' || NEW.id, other_segment.stay_id,
              next_sequence, other_segment.inventory_unit_id, other_segment.arrival_date,
              other_segment.departure_date, 'INITIAL', NULL, NEW.amendment_id
            );
          END IF;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_unrelated_segment
        AFTER INSERT ON stay_segments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_unrelated_segment()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back an unrelated inactive Claim inserted by the same create-order transaction", async () => {
    const baseline = await prepareTemporaryOrder("unrelated-claim-baseline", { arrivalOffset: 40, unitCode: "B02" });
    await expect(confirmTemporaryOrder(baseline)).resolves.toMatchObject({ businessCommitted: true });
    const prepared = await prepareTemporaryOrder("unrelated-claim");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_unrelated_claim() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        other_claim inventory_claims%ROWTYPE;
      BEGIN
        IF NEW.source_type = 'ORDER_SEGMENT'
          AND NEW.active
          AND NEW.id NOT LIKE 'claim_temporary_unrelated_%' THEN
          SELECT claim.* INTO other_claim
          FROM inventory_claims AS claim
          WHERE claim.source_type = 'ORDER_SEGMENT'
            AND claim.source_id IS DISTINCT FROM NEW.source_id
          ORDER BY claim.id
          LIMIT 1;
          IF other_claim.id IS NOT NULL THEN
            INSERT INTO inventory_claims (
              id, property_id, room_id, inventory_unit_id, service_date,
              source_type, source_id, active, released_at
            ) VALUES (
              'claim_temporary_unrelated_' || NEW.id, other_claim.property_id,
              other_claim.room_id, other_claim.inventory_unit_id, other_claim.service_date,
              other_claim.source_type, other_claim.source_id, false, transaction_timestamp()
            );
          END IF;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_unrelated_claim
        AFTER INSERT ON inventory_claims
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_unrelated_claim()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back when CREATE_ORDER Audit metadata and targets are detached from the Preview", async () => {
    const prepared = await prepareTemporaryOrder("audit-evidence");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_audit_evidence() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'CREATE_ORDER' AND NEW.decision = 'ALLOWED' THEN
          NEW.metadata := jsonb_build_object(
            'previewId', 'preview_tampered',
            'effectHash', NEW.metadata ->> 'effectHash'
          );
          NEW.target_refs := '[]'::jsonb;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_audit_evidence
        BEFORE INSERT ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_audit_evidence()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rolls back when CREATE_ORDER Receipt resource and fact references are incomplete", async () => {
    const prepared = await prepareTemporaryOrder("receipt-evidence");
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_temporary_receipt_evidence() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.execution_status = 'EXECUTED' AND NEW.business_committed AND EXISTS (
          SELECT 1 FROM command_executions AS execution
          WHERE execution.id = NEW.command_id
            AND execution.command_type = 'CREATE_ORDER'
        ) THEN
          NEW.resource_refs := '[]'::jsonb;
          NEW.fact_refs := '[]'::jsonb;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_temporary_receipt_evidence
        BEFORE INSERT ON command_receipts
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_temporary_receipt_evidence()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it("rejects every post-create collection fact on a temporary arrangement under the runtime role", async () => {
    const prepared = await prepareTemporaryOrder("post-create-funds");
    const receipt = await confirmTemporaryOrder(prepared);
    const orderId = receipt.result!.orderId as string;
    const pricingRevisionId = receipt.result!.pricingRevisionId as string;
    const runtimeDb = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
    try {
      await expect(runtimeDb.insertInto("collection_facts").values({
        fact_id: "fact_temporary_other_room_post_create",
        order_id: orderId,
        fact_type: "COLLECTION",
        amount_minor: 100,
        net_effect_minor: 100,
        currency: "CNY",
        references_fact_id: null,
        reverses_fact_id: null,
        method: "OTHER",
        note: "direct runtime fact must remain forbidden",
        transaction_reference: null,
        cash_collector: null,
        pricing_revision_id: pricingRevisionId,
        command_id: "command_temporary_other_room_direct_fact"
      }).execute()).rejects.toMatchObject({
        code: "23514",
        constraint: "temporary_other_room_no_funds"
      });
    } finally {
      await runtimeDb.destroy();
    }
    expect(await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", orderId).execute()).toEqual([]);
  });

  it.each(["EXTEND_STAY", "MOVE_UNIT", "REPRICE_ORDER", "REFRESH_MEMBER_COVERAGE"] as const)(
    "rejects a directly appended %s amendment for an existing temporary arrangement",
    async (amendmentType) => {
      const prepared = await prepareTemporaryOrder(`post-create-${amendmentType.toLowerCase()}`);
      const receipt = await confirmTemporaryOrder(prepared);
      const orderId = receipt.result!.orderId as string;
      const [order, creation] = await Promise.all([
        db.selectFrom("orders").select("version").where("id", "=", orderId).executeTakeFirstOrThrow(),
        db.selectFrom("amendments")
          .select("command_id")
          .where("order_id", "=", orderId)
          .where("sequence", "=", 1)
          .executeTakeFirstOrThrow()
      ]);
      const runtimeDb = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
      try {
        await expect(runtimeDb.insertInto("amendments").values({
          id: `amendment_temporary_direct_${amendmentType.toLowerCase()}`,
          order_id: orderId,
          sequence: order.version + 1,
          amendment_type: amendmentType,
          reason_code: "TEMPORARY_OTHER_ROOM_GUARD_TEST",
          reason_note: "直接追加必须被数据库拒绝",
          prior_version: order.version,
          new_version: order.version + 1,
          payload: {},
          command_id: creation.command_id
        }).execute()).rejects.toMatchObject({
          code: "23514",
          constraint: "temporary_other_room_lifecycle_closed"
        });
      } finally {
        await runtimeDb.destroy();
      }
    }
  );

  it.each([
    { label: "unchanged", arrivalOffset: 0, departureOffset: 0 },
    { label: "shifted", arrivalOffset: 1, departureOffset: 1 },
    { label: "expanded", arrivalOffset: 0, departureOffset: 1 }
  ])("rejects a directly appended RESCHEDULE_STAY that is not a strict subset: $label", async ({ label, arrivalOffset, departureOffset }) => {
    const prepared = await prepareTemporaryOrder(`direct-reschedule-${label}`);
    const receipt = await confirmTemporaryOrder(prepared);
    const orderId = receipt.result!.orderId as string;
    const [order, creation] = await Promise.all([
      db.selectFrom("orders").select("version").where("id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("amendments")
        .select("command_id")
        .where("order_id", "=", orderId)
        .where("sequence", "=", 1)
        .executeTakeFirstOrThrow()
    ]);
    const newArrivalDate = shiftDate(prepared.arrivalDate, arrivalOffset);
    const newDepartureDate = shiftDate(prepared.departureDate, departureOffset);

    await expect(db.insertInto("amendments").values({
      id: `amendment_temporary_direct_reschedule_${label}`,
      order_id: orderId,
      sequence: order.version + 1,
      amendment_type: "RESCHEDULE_STAY",
      reason_code: "TEMPORARY_OTHER_ROOM_GUARD_TEST",
      reason_note: "伪造改期必须被数据库拒绝",
      prior_version: order.version,
      new_version: order.version + 1,
      payload: {
        operation: "RESCHEDULE_STAY",
        after: { arrivalDate: newArrivalDate, departureDate: newDepartureDate },
        temporaryOtherRoomArrangement: receipt.result!.temporaryOtherRoomArrangement,
        temporaryOtherRoomCreateAmendmentId: receipt.result!.temporaryOtherRoomCreateAmendmentId
      },
      command_id: creation.command_id
    }).execute()).rejects.toMatchObject({
      code: "23514",
      constraint: "temporary_other_room_reschedule_subset"
    });
  });

  it.each(["contract", "lot", "balance"] as const)(
    "rejects a direct % mutation of the original temporary-arrangement membership source",
    async (target) => {
      const prepared = await prepareTemporaryOrder(`direct-member-source-${target}`);
      await confirmTemporaryOrder(prepared);

      const attempt = target === "contract"
        ? db.updateTable("member_contracts")
          .set({ valid_until: shiftDate(prepared.departureDate, 30) })
          .where("id", "=", prepared.membership.contractId)
          .execute()
        : target === "lot"
          ? db.updateTable("entitlement_lots")
            .set({ expires_on: shiftDate(prepared.departureDate, 30) })
            .where("id", "=", prepared.membership.lotId)
            .execute()
          : db.insertInto("entitlement_ledger").values({
            fact_id: "fact_temporary_direct_member_source_balance",
            lot_id: prepared.membership.lotId,
            entry_type: "ADJUST",
            quantity_delta: 1,
            service_date: null,
            order_id: null,
            coverage_id: null,
            reason: "DIRECT_TEMPORARY_SOURCE_MUTATION",
            command_id: null
          }).execute();

      await expect(attempt).rejects.toMatchObject({
        code: "23514",
        constraint: "temporary_other_room_member_chain_closed"
      });
    }
  );

  it.each(["contract", "lot"] as const)(
    "rejects a standalone version-only update to the temporary-arrangement source %s",
    async (target) => {
      const prepared = await prepareTemporaryOrder(`direct-member-source-version-${target}`);
      await confirmTemporaryOrder(prepared);

      const attempt = target === "contract"
        ? db.updateTable("member_contracts")
          .set({ version: sql`version + 1` })
          .where("id", "=", prepared.membership.contractId)
          .execute()
        : db.updateTable("entitlement_lots")
          .set({ version: sql`version + 1` })
          .where("id", "=", prepared.membership.lotId)
          .execute();

      await expect(attempt).rejects.toMatchObject({
        code: "23514",
        constraint: "temporary_other_room_member_chain_closed"
      });
    }
  );

  it("rejects inserting a new entitlement Lot under a temporary-arrangement source contract", async () => {
    const prepared = await prepareTemporaryOrder("direct-member-source-new-lot");
    await confirmTemporaryOrder(prepared);

    await expect(db.insertInto("entitlement_lots").values({
      id: "lot_temporary_direct_member_source_new",
      contract_id: prepared.membership.contractId,
      unit_kind: "ROOM_NIGHT",
      total_units: 1,
      expires_on: shiftDate(prepared.departureDate, 30),
      status: "ACTIVE",
      version: 1
    }).execute()).rejects.toMatchObject({
      code: "23514",
      constraint: "temporary_other_room_member_chain_closed"
    });
  });

  it("serializes a sibling Lot insert that starts after temporary source resolution", async () => {
    const prepared = await prepareTemporaryOrder("concurrent-sibling-lot");
    await installPostResolutionOrderBlocker();
    const holder = await holdAdvisoryLock(postResolutionBlockerKey);
    let createAttempt: Promise<ReceiptDto> | undefined;
    let siblingAttempt: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      createAttempt = confirmTemporaryOrder(prepared);
      await waitForAdvisoryWaiters(1, holder.pid);
      siblingAttempt = db.insertInto("entitlement_lots").values({
        id: "lot_temporary_concurrent_sibling",
        contract_id: prepared.membership.contractId,
        unit_kind: "ROOM_NIGHT",
        total_units: 1,
        expires_on: shiftDate(prepared.departureDate, 30),
        status: "ACTIVE",
        version: 1
      }).execute().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      await waitForAdvisoryWaiters(2);
      await releaseAdvisoryLock(holder);

      const [createReceipt, siblingOutcome] = await Promise.all([createAttempt, siblingAttempt]);
      expect(createReceipt).toMatchObject({ businessCommitted: true, executionStatus: "EXECUTED" });
      expect(siblingOutcome.ok).toBe(false);
      if (siblingOutcome.ok) throw new Error("Concurrent sibling Lot insertion unexpectedly committed");
      expect(siblingOutcome.error).toMatchObject({
        code: "23514",
        constraint: "temporary_other_room_member_chain_closed"
      });
      await expect(db.selectFrom("entitlement_lots")
        .select("id")
        .where("id", "=", "lot_temporary_concurrent_sibling")
        .executeTakeFirst()).resolves.toBeUndefined();
    } finally {
      await releaseAdvisoryLock(holder).catch(() => undefined);
      await Promise.all([
        createAttempt ? createAttempt.catch(() => undefined) : Promise.resolve(),
        siblingAttempt ? siblingAttempt.catch(() => undefined) : Promise.resolve()
      ]);
      await closeAdvisoryHolder(holder);
    }
  });

  it.each([
    { label: "contract", table: "member_contracts", arrangementField: "memberContractId" },
    { label: "lot", table: "entitlement_lots", arrangementField: "entitlementLotId" }
  ] as const)("rejects a second protected source version bump in one lifecycle transaction: $label", async ({ table, arrangementField }) => {
    const prepared = await prepareTemporaryOrder(`duplicate-source-version-${table}`);
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_duplicate_temporary_source_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 AND EXISTS (
          SELECT 1
          FROM amendments AS created
          WHERE created.sequence = 1
            AND created.amendment_type = 'CREATE_ORDER'
            AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
            AND created.payload #>> '{temporaryOtherRoomArrangement,${arrangementField}}' = NEW.id
        ) THEN
          UPDATE ${table} SET version = version + 1 WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_duplicate_temporary_source_version
        AFTER UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_duplicate_temporary_source_version()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it.each([
    { label: "contract", table: "member_contracts", arrangementField: "memberContractId" },
    { label: "lot", table: "entitlement_lots", arrangementField: "entitlementLotId" }
  ] as const)("rejects a protected source version bump repeated after a subtransaction bump: $label", async ({ table, arrangementField }) => {
    const prepared = await prepareTemporaryOrder(`subtransaction-source-version-${table}`);
    const before = await businessFactCounts();
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_subtransaction_temporary_source_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entry_type = 'HOLD'
          AND (SELECT count(*) FROM entitlement_ledger WHERE command_id = NEW.command_id) = 1
          AND EXISTS (
            SELECT 1
            FROM amendments AS created
            WHERE created.sequence = 1
              AND created.amendment_type = 'CREATE_ORDER'
              AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
              AND created.payload #>> '{temporaryOtherRoomArrangement,${arrangementField}}' = (
                SELECT coverage.${table === "member_contracts" ? "contract_id" : "lot_id"}
                FROM coverage_items AS coverage
                WHERE coverage.id = NEW.coverage_id
              )
          ) THEN
          BEGIN
            UPDATE ${table}
            SET version = version + 1
            WHERE id = (
              SELECT coverage.${table === "member_contracts" ? "contract_id" : "lot_id"}
              FROM coverage_items AS coverage
              WHERE coverage.id = NEW.coverage_id
            );
          EXCEPTION WHEN OTHERS THEN
            RAISE;
          END;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_subtransaction_temporary_source_version
        AFTER INSERT ON entitlement_ledger
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_subtransaction_temporary_source_version()
    `).execute(db);

    await expectTamperedConfirmationToRollBack(prepared, before);
  });

  it.each([
    "qintopia_validate_coverage_ownership()",
    "qintopia_validate_temporary_other_room_create_order()",
    "qintopia_reject_temporary_other_room_lifecycle_amendment()",
    "qintopia_protect_temporary_other_room_member_chain()",
    "qintopia_reject_temporary_other_room_funds()"
  ])("fails readiness when runtime receives EXECUTE on %s", async (signature) => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error(`rollback readiness privilege probe: ${signature}`);
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`GRANT EXECUTE ON FUNCTION ${signature} TO qintopia_runtime`).execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when the deferred validator body drifts, then recovers after rollback", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback readiness function-body probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION qintopia_validate_temporary_other_room_create_order() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `).execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when the permanent zero-funds trigger binding drifts", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback zero-funds trigger probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql`DROP TRIGGER collection_facts_reject_temporary_other_room_funds ON collection_facts`.execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when the permanent lifecycle trigger binding drifts", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback lifecycle trigger probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql`DROP TRIGGER amendments_reject_temporary_other_room_lifecycle ON amendments`.execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when the permanent lifecycle validator body drifts", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback lifecycle body probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION qintopia_reject_temporary_other_room_lifecycle_amendment() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `).execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when a permanent member-source trigger binding drifts", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback member-source trigger probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql`DROP TRIGGER entitlement_lots_protect_temporary_other_room_source ON entitlement_lots`.execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when the permanent member-source validator body drifts", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback member-source body probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION qintopia_protect_temporary_other_room_member_chain() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `).execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });

  it("fails readiness when the permanent zero-funds validator body drifts", async () => {
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
    const rollback = new Error("rollback zero-funds body probe");
    await expect(db.transaction().execute(async (trx) => {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION qintopia_reject_temporary_other_room_funds() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `).execute(trx);
      expect(await databaseReady(trx, ownerReadinessOptions)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, ownerReadinessOptions)).toBe(true);
  });
});
