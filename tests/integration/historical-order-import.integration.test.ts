import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AuthPrincipal, RoomStatusUnitDto } from "@qintopia/contracts";
import {
  type Database,
  type HistoricalOrderImportManifest,
  applyHistoricalOrderImport,
  confirmCommandPreview,
  createCommandPreview,
  createDatabase,
  dryRunHistoricalOrderImport,
  getOrderView,
  getRoomStatusBoard,
  historicalOperationalTupleHash,
  listAvailability,
  maskHistoricalArchivePhone,
  manifestStableHash,
  parseHistoricalOrderImportManifest,
  withPropertyClockForTesting
} from "@qintopia/db";
import { resetDatabase } from "../helpers/database.ts";
import { sql, type Kysely } from "kysely";
import { sha256, stableHash } from "@qintopia/domain";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import {
  buildHistoricalOrderImportSyntheticManifest,
  historicalImportFixtureSourceIds
} from "../fixtures/historical-order-import.fixture.ts";
import {
  authorizeHistoricalImportApply,
  createHistoricalImportDryRunEvidence,
  historicalImportDatabaseFingerprint,
  issueHistoricalImportApproval,
  issueHistoricalImportRecoveryAttestation
} from "../../packages/db/src/historical-import-approval.ts";

const databaseUrl = process.env.HISTORICAL_ORDER_IMPORT_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_historical_order_import";
const manifest = parseHistoricalOrderImportManifest(buildHistoricalOrderImportSyntheticManifest());
const resolutionClock = new Date("2026-08-10T04:00:00.000Z");
const resolvedCheckoutClock = new Date("2026-08-13T04:00:00.000Z");
const resolvedDepartureDate = "2026-08-13";
const postCutoverIncrementAmountMinor = 26_000;

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let commandSequence = 0;
const approvalKeys = generateKeyPairSync("ed25519");
const recoveryKeys = generateKeyPairSync("ed25519");
const restoreDatabaseFingerprint = "9".repeat(64);
const backupArtifactSha256 = "8".repeat(64);

function modifiedSyntheticManifest(
  modify: (records: Array<Record<string, any>>) => void
): HistoricalOrderImportManifest {
  const candidate = buildHistoricalOrderImportSyntheticManifest();
  const records = candidate.records as Array<Record<string, any>>;
  modify(records);
  for (const record of records) {
    const canonical = { ...record };
    delete canonical.canonicalPayloadHash;
    record.canonicalPayloadHash = stableHash(canonical);
  }
  candidate.approvedOperationalTuplesSha256 = historicalOperationalTupleHash(records as never);
  candidate.manifestHash = manifestStableHash(candidate);
  return parseHistoricalOrderImportManifest(candidate);
}

function metadata(prefix: string) {
  commandSequence += 1;
  return {
    idempotencyKey: `${prefix}-${commandSequence}`,
    correlationId: `${prefix}-${commandSequence}`
  };
}

async function count(table: string): Promise<number> {
  const row = await (db as unknown as { selectFrom(name: string): any }).selectFrom(table).select((eb: any) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countOrderImportRuns(): Promise<number> {
  const row = await db.selectFrom("migration_import_runs")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("source_system", "=", "ORDER_LAILE")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function approvalBundleFor(
  approvedManifest: HistoricalOrderImportManifest,
  options: {
    issuedAt?: Date;
    expiresAt?: Date;
    authorizationClock?: Date;
    approvedBy?: string;
    nonce?: string;
  } = {}
) {
  const report = await dryRunHistoricalOrderImport(db, approvedManifest);
  const fingerprint = await historicalImportDatabaseFingerprint(db);
  const issuedAt = options.issuedAt ?? new Date();
  const expiresAt = options.expiresAt ?? new Date(issuedAt.getTime() + 10 * 60_000);
  const dryRunEvidence = createHistoricalImportDryRunEvidence({
    report,
    targetDatabaseFingerprint: fingerprint,
    completedAt: new Date(issuedAt.getTime() - 1_000)
  });
  const candidateDryRunEvidence = createHistoricalImportDryRunEvidence({
    report,
    targetDatabaseFingerprint: restoreDatabaseFingerprint,
    completedAt: new Date(issuedAt.getTime() - 2_000)
  });
  const backupEvidence = {
    evidenceVersion: 1,
    targetDatabaseFingerprint: fingerprint,
    artifactId: `historical-import-backup-${issuedAt.getTime()}`,
    artifactSha256: backupArtifactSha256,
    completedAt: new Date(issuedAt.getTime() - 20 * 60_000).toISOString()
  } as const;
  const restoreEvidence = {
    evidenceVersion: 1,
    verificationId: `historical-import-restore-${issuedAt.getTime()}`,
    backupArtifactSha256,
    restoredDatabaseFingerprint: restoreDatabaseFingerprint,
    completedAt: new Date(issuedAt.getTime() - 10 * 60_000).toISOString(),
    result: "PASSED"
  } as const;
  const recoveryAttestation = issueHistoricalImportRecoveryAttestation({
    backupEvidence,
    restoreEvidence
  }, recoveryKeys.privateKey);
  const credential = issueHistoricalImportApproval({
    dryRunEvidence,
    candidateDryRunEvidence,
    recoveryAttestation,
    recoveryPublicKey: recoveryKeys.publicKey,
    approvedBy: options.approvedBy ?? "historical-import-integration-test",
    issuedAt,
    expiresAt,
    ...(options.nonce ? { nonce: options.nonce } : {})
  }, approvalKeys.privateKey);
  const authorization = await authorizeHistoricalImportApply(
    db,
    approvedManifest,
    report,
    credential,
    approvalKeys.publicKey,
    recoveryKeys.publicKey,
    options.authorizationClock ?? issuedAt
  );
  return { authorization, credential, issuedAt, expiresAt };
}

async function approvalFor(
  approvedManifest: HistoricalOrderImportManifest,
  options: Parameters<typeof approvalBundleFor>[1] = {}
) {
  return (await approvalBundleFor(approvedManifest, options)).authorization;
}

async function approvedApply(approvedManifest: HistoricalOrderImportManifest) {
  return applyHistoricalOrderImport(db, approvedManifest, await approvalFor(approvedManifest));
}

async function loadActiveOverdueHold() {
  return db.selectFrom("migration_overdue_inventory_holds as hold")
    .innerJoin("migration_order_sources as source", "source.id", "hold.source_id")
    .innerJoin("inventory_units as unit", "unit.id", "hold.inventory_unit_id")
    .select([
      "hold.id",
      "hold.source_id",
      "hold.order_id",
      "hold.property_id",
      "hold.room_id",
      "hold.inventory_unit_id",
      "hold.starts_on",
      "hold.cutover_observed_at",
      "source.historical_actual_amount_minor",
      "unit.code as inventory_unit_code"
    ])
    .where("source.source_order_id", "=", historicalImportFixtureSourceIds.overdue)
    .executeTakeFirstOrThrow();
}

type ActiveOverdueHold = Awaited<ReturnType<typeof loadActiveOverdueHold>>;

async function prepareResolution(hold: ActiveOverdueHold, prefix: string) {
  return withPropertyClockForTesting(resolutionClock, () => createCommandPreview(db, principal, {
    commandType: "RESOLVE_MIGRATED_OVERDUE_STAY",
    input: {
      propertyId: hold.property_id,
      orderId: hold.order_id,
      holdId: hold.id,
      newDepartureDate: resolvedDepartureDate,
      postCutoverIncrementAmountMinor
    }
  }, metadata(`${prefix}-preview`)));
}

function resolutionConfirmation(prepared: Awaited<ReturnType<typeof prepareResolution>>, propertyId: string) {
  return {
    propertyId,
    commandType: "RESOLVE_MIGRATED_OVERDUE_STAY" as const,
    confirmation: true as const,
    expectedEffectHash: prepared.preview.effectHash,
    reason: {
      code: "MIGRATED_OVERDUE_RESOLVED",
      note: "确认历史逾期在住单的实际离店日及切换后续住金额"
    }
  };
}

async function overdueResolutionBusinessState(hold: ActiveOverdueHold) {
  const [order, activeHold, releases, amendments, segments, revisions, claims, roomStatusRevision] = await Promise.all([
    db.selectFrom("orders").select([
      "id", "departure_date", "current_revision_id", "version", "status"
    ]).where("id", "=", hold.order_id).executeTakeFirstOrThrow(),
    db.selectFrom("migration_overdue_inventory_holds as hold")
      .leftJoin("migration_overdue_inventory_hold_releases as release", "release.hold_id", "hold.id")
      .select("hold.id")
      .where("hold.id", "=", hold.id)
      .where("release.id", "is", null)
      .executeTakeFirst(),
    db.selectFrom("migration_overdue_inventory_hold_releases")
      .selectAll().where("hold_id", "=", hold.id).orderBy("id").execute(),
    db.selectFrom("amendments").select([
      "id", "sequence", "amendment_type", "payload", "command_id"
    ]).where("order_id", "=", hold.order_id).where("sequence", ">", 1).orderBy("sequence").execute(),
    db.selectFrom("stay_segments as segment")
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select([
        "segment.id", "segment.sequence", "segment.segment_type", "segment.arrival_date",
        "segment.departure_date", "segment.inventory_unit_id", "segment.amendment_id"
      ])
      .where("stay.order_id", "=", hold.order_id)
      .where("segment.sequence", ">", 1)
      .orderBy("segment.sequence")
      .execute(),
    db.selectFrom("pricing_revisions").select([
      "id", "revision_no", "pricing_origin", "cash_lines", "current_contract_amount_minor"
    ]).where("order_id", "=", hold.order_id).where("revision_no", ">", 1).orderBy("revision_no").execute(),
    db.selectFrom("inventory_claims as claim")
      .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
      .innerJoin("stays as stay", "stay.id", "segment.stay_id")
      .select([
        "claim.id", "claim.source_id", "claim.service_date", "claim.inventory_unit_id",
        "claim.active", "claim.released_at"
      ])
      .where("stay.order_id", "=", hold.order_id)
      .where("claim.service_date", ">=", hold.starts_on)
      .orderBy("claim.service_date")
      .orderBy("claim.id")
      .execute(),
    db.selectFrom("room_status_revisions")
      .select(["property_id", "revision"])
      .where("property_id", "=", hold.property_id)
      .executeTakeFirst()
  ]);
  return { order, activeHold, releases, amendments, segments, revisions, claims, roomStatusRevision };
}

async function orderClaimState(orderId: string) {
  return db.selectFrom("inventory_claims as claim")
    .innerJoin("stay_segments as segment", "segment.id", "claim.source_id")
    .innerJoin("stays as stay", "stay.id", "segment.stay_id")
    .select([
      "claim.id", "claim.source_id", "claim.service_date", "claim.inventory_unit_id",
      "claim.active", "claim.released_at"
    ])
    .where("stay.order_id", "=", orderId)
    .orderBy("claim.service_date")
    .orderBy("claim.id")
    .execute();
}

function allUnits(units: RoomStatusUnitDto[]): RoomStatusUnitDto[] {
  return units.flatMap((unit) => [unit, ...allUnits(unit.children)]);
}

async function roomStatusForResolution(hold: ActiveOverdueHold) {
  const board = await getRoomStatusBoard(db, {
    propertyId: hold.property_id,
    arrivalDate: hold.starts_on,
    departureDate: resolvedDepartureDate,
    accessLevel: "WRITE",
    requestingSubjectId: principal.subjectId,
    pageSize: 200,
    search: hold.inventory_unit_code
  });
  const unit = allUnits(board.rooms).find((candidate) => candidate.id === hold.inventory_unit_id);
  expect(unit).toBeDefined();
  return unit!;
}

async function dropForcedResolutionFailure(): Promise<void> {
  await sql.raw(`
    DROP TRIGGER IF EXISTS qintopia_test_reject_migrated_overdue_revision ON pricing_revisions;
    DROP FUNCTION IF EXISTS qintopia_test_reject_migrated_overdue_revision();
    DROP SEQUENCE IF EXISTS qintopia_test_migrated_overdue_revision_attempts
  `).execute(db);
}

describe.sequential("historical order import", () => {
  beforeAll(async () => { db = await resetDatabase(databaseUrl); });
  afterAll(async () => {
    if (!db) return;
    await dropForcedResolutionFailure();
    await db.destroy();
  });

  it("dry-runs the verified manifest without a business write", async () => {
    const report = await dryRunHistoricalOrderImport(db, manifest);
    expect(report).toMatchObject({ mode: "DRY_RUN", replayedSources: 0, newSources: 535, expected: { historicalAccommodationArchives: 490, nonAccommodationArchives: 1, operationalOrders: 44, operationalSegmentCount: 50, totalAccommodationAmountFen: 28_140_438 } });
    expect(report.reconciliation).toMatchObject({
      sourceCount: 535,
      targetCount: 535,
      historicalArchiveTargets: 490,
      nonAccommodationArchiveTargets: 1,
      operationalTargets: 44,
      sourceOperationalSegmentEvidence: 50,
      historicalCollectionFacts: 0,
      activeOverdueHolds: 1,
      legacyMemberContracts: 1,
      entitlementLots: 1,
      entitlementCoveragePoints: 19,
      entitlementHoldFacts: 19,
      entitlementConsumeFacts: 19
    });
    expect(report.reconciliation.operationalClaimPoints).toBeGreaterThan(0);
    expect(await count("migration_import_runs")).toBe(0);
    expect(await count("migration_order_sources")).toBe(0);
  });

  it("rejects operational lifecycles that are not true on the fresh cutover date", async () => {
    const expiredInHouse = modifiedSyntheticManifest((records) => {
      const record = records.find((candidate) => candidate.observedLifecycle === "IN_HOUSE"
        && candidate.flags.length === 0 && candidate.segments.length === 1)!;
      record.sourceStay.departureDate = "2026-08-10";
      record.segments[0].departureDate = "2026-08-10";
    });
    await expect(dryRunHistoricalOrderImport(db, expiredInHouse)).rejects.toThrow(/in-house.*does not cover the cutover date/i);

    const startedReserved = modifiedSyntheticManifest((records) => {
      const record = records.find((candidate) => candidate.observedLifecycle === "RESERVED")!;
      record.sourceStay.arrivalDate = "2026-08-09";
      record.segments[0].arrivalDate = "2026-08-09";
    });
    await expect(dryRunHistoricalOrderImport(db, startedReserved)).rejects.toThrow(/reserved.*starts before the cutover date/i);

    const unmarkedOverdue = modifiedSyntheticManifest((records) => {
      const record = records.find((candidate) => candidate.source.orderId === historicalImportFixtureSourceIds.overdue)!;
      record.flags = [];
    });
    await expect(dryRunHistoricalOrderImport(db, unmarkedOverdue)).rejects.toThrow(/in-house.*does not cover the cutover date/i);
    expect(await count("migration_import_runs")).toBe(0);
  });

  it("rejects an overdue hold conflict with another operational snapshot in the same manifest", async () => {
    const conflictingManifest = modifiedSyntheticManifest((records) => {
      const record = records.find((candidate) => candidate.observedLifecycle === "IN_HOUSE"
        && candidate.flags.length === 0 && candidate.segments.length === 1
        && candidate.segments[0].inventoryUnitCode !== "306")!;
      record.sourceStay.arrivalDate = "2026-08-09";
      record.sourceStay.departureDate = "2026-08-12";
      record.sourceStay.rawRoom = "306";
      record.sourceStay.standardInventoryUnits = "306";
      Object.assign(record.segments[0], {
        sourceRoom: "306",
        inventoryUnitCode: "306",
        arrivalDate: "2026-08-09",
        departureDate: "2026-08-12"
      });
    });
    await expect(dryRunHistoricalOrderImport(db, conflictingManifest)).rejects.toThrow(/overdue hold.*conflicts with source/i);
    expect(await count("migration_import_runs")).toBe(0);
  });

  it("rejects an existing active maintenance claim in the overdue hold interval during dry-run", async () => {
    const unit = await db.selectFrom("inventory_units").select("id")
      .where("property_id", "=", demo.propertyId).where("code", "=", "306").executeTakeFirstOrThrow();
    const lockPreview = await createCommandPreview(db, principal, {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: unit.id,
        arrivalDate: "2026-08-10",
        departureDate: "2026-08-11",
        reason: "Historical import dry-run conflict fixture"
      }
    }, metadata("overdue-preflight-lock-preview"));
    const locked = await confirmCommandPreview(db, principal, lockPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "LOCK_MAINTENANCE",
      confirmation: true,
      expectedEffectHash: lockPreview.preview.effectHash,
      reason: { code: "AUTOMATED_ACCEPTANCE", note: "Create an active claim for dry-run conflict coverage" }
    }, metadata("overdue-preflight-lock-confirm"));
    const maintenanceLockId = locked.result?.maintenanceLockId as string;
    try {
      await expect(dryRunHistoricalOrderImport(db, manifest)).rejects.toThrow(/overdue hold inventory conflict/i);
      expect(await count("migration_import_runs")).toBe(0);
    } finally {
      const releasePreview = await createCommandPreview(db, principal, {
        commandType: "RELEASE_MAINTENANCE",
        input: { propertyId: demo.propertyId, maintenanceLockId }
      }, metadata("overdue-preflight-release-preview"));
      await confirmCommandPreview(db, principal, releasePreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "RELEASE_MAINTENANCE",
        confirmation: true,
        expectedEffectHash: releasePreview.preview.effectHash,
        reason: { code: "AUTOMATED_ACCEPTANCE", note: "Release the dry-run conflict fixture" }
      }, metadata("overdue-preflight-release-confirm"));
    }
  });

  it("rejects a forged authorization and an authorization that expired before transaction consumption with zero writes", async () => {
    await expect(applyHistoricalOrderImport(db, manifest, {} as never)).rejects.toThrow(/verified approval authorization/i);
    expect(await count("migration_import_runs")).toBe(0);
    expect(await count("migration_order_sources")).toBe(0);

    const now = new Date();
    const issuedAt = new Date(now.getTime() - 20_000);
    const expiredAuthorization = await approvalFor(manifest, {
      issuedAt,
      expiresAt: new Date(now.getTime() - 10_000),
      authorizationClock: new Date(issuedAt.getTime() + 5_000)
    });
    await expect(applyHistoricalOrderImport(db, manifest, expiredAuthorization)).rejects.toThrow(
      /expired before transaction consumption/i
    );
    expect(await count("migration_import_runs")).toBe(0);
    expect(await count("migration_order_sources")).toBe(0);
  });

  it("rolls back approval consumption with every import write when a source insert fails", async () => {
    const authorization = await approvalFor(manifest);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_reject_historical_import_source() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced historical source failure'
          USING ERRCODE = '23514', CONSTRAINT = 'qintopia_test_reject_historical_import_source';
      END;
      $$;
      CREATE TRIGGER qintopia_test_reject_historical_import_source
      BEFORE INSERT ON migration_order_sources
      FOR EACH ROW EXECUTE FUNCTION qintopia_test_reject_historical_import_source()
    `).execute(db);
    try {
      await expect(applyHistoricalOrderImport(db, manifest, authorization)).rejects.toMatchObject({
        constraint: "qintopia_test_reject_historical_import_source"
      });
      expect(await count("migration_import_runs")).toBe(0);
      expect(await count("migration_order_sources")).toBe(0);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_reject_historical_import_source ON migration_order_sources;
        DROP FUNCTION IF EXISTS qintopia_test_reject_historical_import_source()
      `).execute(db);
    }
  });

  it("commits archives and operational snapshots once, without historical money facts", async () => {
    const retryNonce = "r".repeat(43);
    const approvalIssuedAt = new Date();
    const approvalBundle = await approvalBundleFor(manifest, {
      issuedAt: approvalIssuedAt,
      nonce: retryNonce
    });
    const conflictingBundle = await approvalBundleFor(manifest, {
      issuedAt: approvalIssuedAt,
      nonce: retryNonce,
      approvedBy: "different-approver@example.invalid"
    });
    const authorization = approvalBundle.authorization;
    const attempts = await Promise.allSettled([
      applyHistoricalOrderImport(db, manifest, authorization),
      applyHistoricalOrderImport(db, manifest, authorization)
    ]);
    const fulfilled = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof applyHistoricalOrderImport>>> => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.filter((attempt) => attempt.value.mode === "APPLIED")).toHaveLength(1);
    for (const rejectedAttempt of rejected) {
      expect(rejectedAttempt.reason).toMatchObject({ message: expect.stringMatching(/serialize/i) });
    }
    const result = fulfilled.find((attempt) => attempt.value.mode === "APPLIED")!.value;
    const concurrentReplay = fulfilled.find((attempt) => attempt.value.mode === "REPLAYED")?.value;
    if (concurrentReplay) {
      expect(concurrentReplay.runId).toBe(result.runId);
      expect(concurrentReplay.approval.approvalRunId).toBe(result.approval.approvalRunId);
    }

    const directReplay = await applyHistoricalOrderImport(db, manifest, authorization);
    expect(directReplay).toMatchObject({
      mode: "REPLAYED",
      runId: result.runId,
      approval: { approvalRunId: result.approval.approvalRunId }
    });
    const postCommitDryRun = await dryRunHistoricalOrderImport(db, manifest);
    const restartedAuthorization = await authorizeHistoricalImportApply(
      db,
      manifest,
      postCommitDryRun,
      approvalBundle.credential,
      approvalKeys.publicKey,
      recoveryKeys.publicKey,
      new Date(approvalBundle.expiresAt.getTime() + 60_000)
    );
    const restartedReplay = await applyHistoricalOrderImport(db, manifest, restartedAuthorization);
    expect(restartedReplay).toMatchObject({
      mode: "REPLAYED",
      runId: result.runId,
      approval: { approvalRunId: result.approval.approvalRunId }
    });

    await expect(authorizeHistoricalImportApply(
      db,
      manifest,
      postCommitDryRun,
      conflictingBundle.credential,
      approvalKeys.publicKey,
      recoveryKeys.publicKey,
      new Date(approvalIssuedAt.getTime() + 60_000)
    )).rejects.toThrow(/nonce.*different approval|approval.*conflict/i);
    await expect(applyHistoricalOrderImport(db, manifest, conflictingBundle.authorization)).rejects.toThrow(
      /nonce.*different approval|approval.*conflict/i
    );
    expect(result).toMatchObject({ mode: "APPLIED", newSources: 535, replayedSources: 0 });
    expect(result.approval).toMatchObject({
      approvalRunId: expect.any(String),
      approvalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      nonceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      keyId: expect.stringMatching(/^[0-9a-f]{64}$/),
      approvedBy: "historical-import-integration-test"
    });
    expect(await count("migration_import_runs")).toBe(2);
    expect(await countOrderImportRuns()).toBe(1);
    expect(await count("migration_order_sources")).toBe(535);
    expect(await count("historical_order_archives")).toBe(491);
    expect(await (db as unknown as { selectFrom(name: string): any }).selectFrom("orders").select("id").where("migration_source_id", "is not", null).execute()).toHaveLength(44);
    expect(await (db as unknown as { selectFrom(name: string): any }).selectFrom("collection_facts as fact").innerJoin("orders as order", "order.id", "fact.order_id").select("fact.fact_id").where("order.migration_source_id", "is not", null).execute()).toHaveLength(0);
    expect(await count("migration_overdue_inventory_holds")).toBe(1);
    expect(await (db as unknown as { selectFrom(name: string): any }).selectFrom("coverage_items as coverage").innerJoin("orders as order", "order.id", "coverage.order_id").select("coverage.id").where("order.migration_source_id", "is not", null).execute()).toHaveLength(19);
    const channelCounts = await db.selectFrom("migration_order_sources")
      .select("mapped_channel_code")
      .select((eb) => eb.fn.countAll().as("count"))
      .groupBy("mapped_channel_code")
      .execute();
    expect(Object.fromEntries(channelCounts.map((row) => [
      row.mapped_channel_code ?? "NULL",
      Number(row.count)
    ]))).toEqual({ WECOM: 503, CTRIP: 15, MEITUAN: 11, YOUMUDAO: 4, NULL: 2 });
    const migratedOrders = await (db as unknown as { selectFrom(name: string): any }).selectFrom("orders").select("id").where("migration_source_id", "is not", null).execute() as Array<{ id: string }>;
    await Promise.all(migratedOrders.map(async ({ id }) => expect((await getOrderView(db, id)).order.id).toBe(id)));

    const sparse = await (db as unknown as { selectFrom(name: string): any }).selectFrom("orders as order").innerJoin("migration_order_sources as source", "source.id", "order.migration_source_id").select(["order.id", "order.arrival_date", "order.departure_date", "source.canonical_payload"]).where("source.source_order_id", "=", historicalImportFixtureSourceIds.sparse).executeTakeFirstOrThrow();
    expect(sparse.arrival_date).toBe("2026-08-07");
    expect(sparse.departure_date).toBe("2026-08-23");
    expect((sparse.canonical_payload as { segments: unknown[] }).segments).toHaveLength(2);
    expect(await (db as unknown as { selectFrom(name: string): any }).selectFrom("inventory_claims as claim").innerJoin("stay_segments as segment", "segment.id", "claim.source_id").innerJoin("stays as stay", "stay.id", "segment.stay_id").select("claim.id").where("stay.order_id", "=", sparse.id).execute()).toHaveLength(16);

    const concurrent = await (db as unknown as { selectFrom(name: string): any }).selectFrom("orders as order").innerJoin("migration_order_sources as source", "source.id", "order.migration_source_id").select("order.id").where("source.source_order_id", "=", historicalImportFixtureSourceIds.dualUnit).executeTakeFirstOrThrow();
    const concurrentClaims = await (db as unknown as { selectFrom(name: string): any }).selectFrom("inventory_claims as claim").innerJoin("stay_segments as segment", "segment.id", "claim.source_id").innerJoin("stays as stay", "stay.id", "segment.stay_id").innerJoin("inventory_units as unit", "unit.id", "claim.inventory_unit_id").select(["unit.code", "claim.service_date"]).where("stay.order_id", "=", concurrent.id).where("claim.service_date", "=", "2026-08-09").execute();
    expect(concurrentClaims.map((claim: { code: string }) => claim.code).sort()).toEqual(["108-A", "108-B"]);
    const concurrentUnits = await (db as any).selectFrom("inventory_units").select(["id", "code"]).where("code", "in", ["108-A", "108-B"]).execute();
    const availability = await listAvailability(db, "prop_qintopia_demo", "2026-08-09", "2026-08-10");
    for (const unit of concurrentUnits as Array<{ id: string }>) expect(availability.find((item) => item.id === unit.id)?.available).toBe(false);
  });

  it("serves historical archives through an explicitly scoped read-only projection", async () => {
    const archive = await db.selectFrom("historical_order_archives")
      .select(["id", "source_order_id", "guest_phone"])
      .where("guest_phone", "is not", null)
      .orderBy("id")
      .executeTakeFirstOrThrow();
    const otherPropertyId = "prop_historical_archive_scope_probe";
    const otherSecret = `qtp_${"a".repeat(43)}`;
    await db.insertInto("properties").values({
      id: otherPropertyId, code: "QTP-ARCHIVE-SCOPE", name: "Archive scope probe", timezone: "Asia/Shanghai", currency: "CNY"
    }).execute();
    await db.insertInto("subject_property_grants").values({
      subject_id: demo.agentSubjectId, property_id: otherPropertyId, access_level: "READ"
    }).execute();
    await db.insertInto("api_tokens").values({
      id: "token_historical_archive_scope_probe", subject_id: demo.agentSubjectId, label: "Archive scope probe",
      secret_hash: sha256(otherSecret), access_ceiling: "READ", property_scope: otherPropertyId,
      expires_at: "2030-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null
    }).execute();
    const app = await buildServer(createDatabase(databaseUrl));
    await app.ready();
    try {
      const list = await app.inject({
        method: "POST",
        url: "/api/v1/historical-order-archives",
        headers: { authorization: `Bearer ${demo.readToken}` },
        payload: { propertyId: demo.propertyId, query: archive.source_order_id }
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.headers["cache-control"]).toBe("private, no-store");
      expect(list.json()).toMatchObject({ archives: [expect.objectContaining({
        id: archive.id,
        source_order_id: archive.source_order_id,
        source_status: "SYNTHETIC_ARCHIVED_STATUS"
      })] });
      const listed = list.json().archives[0] as Record<string, unknown>;
      expect(listed).not.toHaveProperty("guest_phone");
      expect(listed).not.toHaveProperty("source_id");
      expect(listed).not.toHaveProperty("canonical_payload");

      const rawPhoneSearch = await app.inject({
        method: "POST",
        url: "/api/v1/historical-order-archives",
        headers: { authorization: `Bearer ${demo.readToken}` },
        payload: { propertyId: demo.propertyId, query: archive.guest_phone }
      });
      expect(rawPhoneSearch.statusCode, rawPhoneSearch.body).toBe(200);
      expect(rawPhoneSearch.json()).toMatchObject({ archives: [] });

      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/historical-order-archives/${archive.id}?propertyId=${demo.propertyId}`,
        headers: { authorization: `Bearer ${demo.readToken}` }
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.headers["cache-control"]).toBe("private, no-store");
      expect(detail.json()).toMatchObject({
        id: archive.id,
        guest_phone: maskHistoricalArchivePhone(archive.guest_phone),
        sourceEvidence: expect.objectContaining({ sourceSystem: "ORDER_LAILE", files: expect.any(Array) }),
        pricingEvidence: expect.any(Object)
      });
      expect(detail.body).not.toContain(archive.guest_phone!);
      expect(detail.json()).not.toHaveProperty("source_id");
      expect(detail.json()).not.toHaveProperty("canonical_payload");

      const foreignScope = await app.inject({
        method: "GET",
        url: `/api/v1/historical-order-archives/${archive.id}?propertyId=${otherPropertyId}`,
        headers: { authorization: `Bearer ${otherSecret}` }
      });
      expect(foreignScope.statusCode, foreignScope.body).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("serializes overdue-hold and active-claim writes on one stable room lock", async () => {
    const hold = await loadActiveOverdueHold();
    const roomLockKey = `qintopia:migration-overdue-room:${hold.property_id}:${hold.room_id}`;

    let holdWriteSettled = false;
    let holdWrite: Promise<{ error: unknown }> | undefined;
    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${roomLockKey}, 0::bigint))`.execute(trx);
      holdWrite = db.insertInto("migration_overdue_inventory_holds").values({
        id: "migration_hold_room_lock_probe",
        source_id: hold.source_id,
        order_id: hold.order_id,
        property_id: hold.property_id,
        room_id: hold.room_id,
        inventory_unit_id: hold.inventory_unit_id,
        starts_on: hold.starts_on,
        cutover_observed_at: hold.cutover_observed_at
      }).execute().then(
        () => ({ error: null }),
        (error: unknown) => ({ error })
      ).finally(() => { holdWriteSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(holdWriteSettled).toBe(false);
    });
    expect((await holdWrite!).error).toMatchObject({
      constraint: "migration_overdue_holds_inventory_conflict"
    });

    let claimWriteSettled = false;
    let claimWrite: Promise<{ error: unknown }> | undefined;
    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${roomLockKey}, 0::bigint))`.execute(trx);
      claimWrite = db.insertInto("inventory_claims").values({
        id: "migration_claim_room_lock_probe",
        property_id: hold.property_id,
        room_id: hold.room_id,
        inventory_unit_id: hold.inventory_unit_id,
        service_date: hold.starts_on,
        source_type: "ORDER_SEGMENT",
        source_id: "migration_invalid_room_lock_probe",
        active: true,
        released_at: null
      }).execute().then(
        () => ({ error: null }),
        (error: unknown) => ({ error })
      ).finally(() => { claimWriteSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(claimWriteSettled).toBe(false);
    });
    expect((await claimWrite!).error).toMatchObject({
      constraint: "inventory_claims_migration_overdue_hold_conflict"
    });
  });

  it("lets a migrated reserved snapshot follow the ordinary check-in and check-out fulfillment chain", async () => {
    const reserved = await db.selectFrom("orders as order")
      .innerJoin("migration_order_sources as source", "source.id", "order.migration_source_id")
      .select(["order.id", "order.arrival_date", "order.departure_date"])
      .where("source.observed_order_status", "=", "RESERVED")
      .orderBy("order.arrival_date")
      .orderBy("order.id")
      .executeTakeFirstOrThrow();
    const clockFor = (date: string) => new Date(`${date}T04:00:00.000Z`);

    const checkInPrepared = await withPropertyClockForTesting(clockFor(reserved.arrival_date), () => createCommandPreview(
      db,
      principal,
      { commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId: reserved.id } },
      metadata("migrated-reserved-check-in-preview")
    ));
    const checkIn = await withPropertyClockForTesting(clockFor(reserved.arrival_date), () => confirmCommandPreview(
      db,
      principal,
      checkInPrepared.preview.previewId,
      {
        propertyId: demo.propertyId,
        commandType: "CHECK_IN",
        confirmation: true,
        expectedEffectHash: checkInPrepared.preview.effectHash,
        reason: { code: "AUTOMATED_ACCEPTANCE", note: "Migrated reserved check-in acceptance" }
      },
      metadata("migrated-reserved-check-in-confirm")
    ));
    expect(checkIn).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    const checkedInView = await withPropertyClockForTesting(clockFor(reserved.arrival_date), () => getOrderView(db, reserved.id));
    expect(checkedInView).toMatchObject({
      order: { status: "CHECKED_IN" },
      stay: { status: "IN_HOUSE" },
      fulfillment: { checkIn: expect.any(Object), checkOut: null }
    });

    const checkOutPrepared = await withPropertyClockForTesting(clockFor(reserved.departure_date), () => createCommandPreview(
      db,
      principal,
      { commandType: "CHECK_OUT", input: { propertyId: demo.propertyId, orderId: reserved.id } },
      metadata("migrated-reserved-check-out-preview")
    ));
    const checkOut = await withPropertyClockForTesting(clockFor(reserved.departure_date), () => confirmCommandPreview(
      db,
      principal,
      checkOutPrepared.preview.previewId,
      {
        propertyId: demo.propertyId,
        commandType: "CHECK_OUT",
        confirmation: true,
        expectedEffectHash: checkOutPrepared.preview.effectHash,
        reason: { code: "AUTOMATED_ACCEPTANCE", note: "Migrated reserved check-out acceptance" }
      },
      metadata("migrated-reserved-check-out-confirm")
    ));
    expect(checkOut).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    const checkedOutView = await withPropertyClockForTesting(clockFor(reserved.departure_date), () => getOrderView(db, reserved.id));
    expect(checkedOutView).toMatchObject({
      order: { status: "CHECKED_OUT" },
      stay: { status: "COMPLETED" },
      fulfillment: { checkIn: expect.any(Object), checkOut: expect.any(Object) }
    });
  });

  it("blocks ordinary checkout at Preview and PostgreSQL while the migrated overdue hold is active", async () => {
    const hold = await loadActiveOverdueHold();
    const before = await overdueResolutionBusinessState(hold);
    const beforeClaims = await orderClaimState(hold.order_id);

    await expect(withPropertyClockForTesting(resolutionClock, () => createCommandPreview(db, principal, {
      commandType: "CHECK_OUT",
      input: { propertyId: hold.property_id, orderId: hold.order_id }
    }, metadata("overdue-active-hold-checkout-preview")))).rejects.toMatchObject({
      code: "INVALID_ORDER_STATE",
      statusCode: 409,
      message: "请先确认历史逾期在住的真实离店日和续住金额"
    });

    await expect(db.updateTable("orders")
      .set({ status: "CHECKED_OUT" })
      .where("id", "=", hold.order_id)
      .execute()).rejects.toMatchObject({
      constraint: "migration_overdue_order_status_requires_resolution"
    });

    expect(await overdueResolutionBusinessState(hold)).toEqual(before);
    expect(await orderClaimState(hold.order_id)).toEqual(beforeClaims);
  });

  it("rolls back every overdue-resolution business fact when revision persistence is forced to fail", async () => {
    const hold = await loadActiveOverdueHold();
    const prepared = await prepareResolution(hold, "overdue-forced-rollback");
    const before = await overdueResolutionBusinessState(hold);
    await sql.raw(`
      CREATE SEQUENCE qintopia_test_migrated_overdue_revision_attempts;
      CREATE OR REPLACE FUNCTION qintopia_test_reject_migrated_overdue_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.pricing_origin = 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER' THEN
          PERFORM nextval('qintopia_test_migrated_overdue_revision_attempts');
          RAISE EXCEPTION 'forced migrated overdue revision failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER qintopia_test_reject_migrated_overdue_revision
      BEFORE INSERT ON pricing_revisions
      FOR EACH ROW EXECUTE FUNCTION qintopia_test_reject_migrated_overdue_revision()
    `).execute(db);
    const confirmation = resolutionConfirmation(prepared, hold.property_id);
    let forcedFailureReached = false;
    const rejected = await (async () => {
      try {
        const receipt = await withPropertyClockForTesting(resolutionClock, () => confirmCommandPreview(
          db,
          principal,
          prepared.preview.previewId,
          confirmation,
          metadata("overdue-forced-rollback-confirm")
        ));
        const forcedFailureAttempts = await sql<{ is_called: boolean }>`
          SELECT is_called FROM qintopia_test_migrated_overdue_revision_attempts
        `.execute(db);
        forcedFailureReached = forcedFailureAttempts.rows[0]?.is_called === true;
        return receipt;
      } finally {
        await dropForcedResolutionFailure();
      }
    })();
    expect(rejected).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "COMMAND_INTERRUPTED", retryable: true }
    });
    expect(forcedFailureReached).toBe(true);
    const after = await overdueResolutionBusinessState(hold);
    expect(after).toEqual(before);
    expect(after.activeHold).toEqual({ id: hold.id });
    expect(after.releases).toEqual([]);
    expect(after.amendments).toEqual([]);
    expect(after.segments).toEqual([]);
    expect(after.revisions).toEqual([]);
    expect(after.claims).toEqual([]);
  });

  it("resolves a migrated overdue stay atomically and replays Confirm idempotently", async () => {
    const hold = await loadActiveOverdueHold();
    expect(hold).toMatchObject({
      property_id: demo.propertyId,
      starts_on: "2026-08-09",
      historical_actual_amount_minor: 13_000,
      inventory_unit_code: "306"
    });
    const beforeView = await withPropertyClockForTesting(resolutionClock, () => getOrderView(db, hold.order_id));
    expect(beforeView.allowedActions.find((action) => action.code === "RESOLVE_MIGRATED_OVERDUE_STAY"))
      .toEqual({ code: "RESOLVE_MIGRATED_OVERDUE_STAY", enabled: true, disabledReason: null });
    expect(beforeView.allowedActions.find((action) => action.code === "CHECK_OUT")).toEqual({
      code: "CHECK_OUT",
      enabled: false,
      disabledReason: "请先确认历史逾期在住的真实离店日和续住金额"
    });
    const beforeAvailability = await listAvailability(
      db,
      hold.property_id,
      hold.starts_on,
      resolvedDepartureDate
    );
    const heldUnitAvailability = beforeAvailability.find((unit) => unit.id === hold.inventory_unit_id);
    expect(heldUnitAvailability).toMatchObject({ available: false });
    expect(heldUnitAvailability?.nights.every((night) => !night.available)).toBe(true);
    const overdueUnit = await roomStatusForResolution(hold);
    const overdueInterval = overdueUnit.intervals.find((interval) => (
      interval.references.some((reference) => reference.type === "BLOCK" && reference.id === hold.id)
    ));
    expect(overdueInterval).toMatchObject({
      startDate: hold.starts_on,
      endDate: resolvedDepartureDate,
      status: "IN_HOUSE",
      available: false,
      blocking: true,
      primaryOccupantLabel: "历史在住客人"
    });
    expect(overdueInterval?.conflicts).toEqual([
      expect.objectContaining({
        blockingFactKind: "OVERDUE_IN_HOUSE",
        actualInventoryUnitId: hold.inventory_unit_id,
        startDate: hold.starts_on,
        endDate: resolvedDepartureDate
      })
    ]);

    const originalRevision = await db.selectFrom("pricing_revisions")
      .selectAll()
      .where("order_id", "=", hold.order_id)
      .where("revision_no", "=", 1)
      .executeTakeFirstOrThrow();
    const prepared = await prepareResolution(hold, "overdue-resolve");
    expect(prepared.preview.effect).toEqual({
      operation: "RESOLVE_MIGRATED_OVERDUE_STAY",
      orderId: hold.order_id,
      sourceId: hold.source_id,
      holdId: hold.id,
      historicalActualAmountMinor: 13_000,
      postCutoverIncrementAmountMinor,
      newContractAmountMinor: 39_000,
      newDepartureDate: resolvedDepartureDate
    });
    const confirmation = resolutionConfirmation(prepared, hold.property_id);
    const confirmationMetadata = metadata("overdue-resolve-confirm");
    const receipt = await withPropertyClockForTesting(resolutionClock, () => confirmCommandPreview(
      db,
      principal,
      prepared.preview.previewId,
      confirmation,
      confirmationMetadata
    ));
    expect(receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: {
        orderId: hold.order_id,
        holdId: hold.id,
        historicalActualAmountMinor: 13_000,
        postCutoverIncrementAmountMinor,
        newContractAmountMinor: 39_000,
        newDepartureDate: resolvedDepartureDate,
        amendmentId: expect.any(String),
        staySegmentId: expect.any(String),
        pricingRevisionId: expect.any(String),
        holdReleaseId: expect.any(String),
        effectHash: prepared.preview.effectHash
      }
    });
    const result = receipt.result as {
      amendmentId: string;
      staySegmentId: string;
      pricingRevisionId: string;
      holdReleaseId: string;
    };
    const [release, amendment, segment, revisions, claims, order] = await Promise.all([
      db.selectFrom("migration_overdue_inventory_hold_releases")
        .selectAll().where("hold_id", "=", hold.id).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").selectAll().where("id", "=", result.amendmentId).executeTakeFirstOrThrow(),
      db.selectFrom("stay_segments").selectAll().where("id", "=", result.staySegmentId).executeTakeFirstOrThrow(),
      db.selectFrom("pricing_revisions").selectAll()
        .where("order_id", "=", hold.order_id).orderBy("revision_no").execute(),
      db.selectFrom("inventory_claims").selectAll()
        .where("source_type", "=", "ORDER_SEGMENT")
        .where("source_id", "=", result.staySegmentId)
        .orderBy("service_date")
        .execute(),
      db.selectFrom("orders").selectAll().where("id", "=", hold.order_id).executeTakeFirstOrThrow()
    ]);
    expect(release).toMatchObject({
      id: result.holdReleaseId,
      hold_id: hold.id,
      source_id: hold.source_id,
      order_id: hold.order_id,
      command_id: receipt.commandId,
      extension_segment_id: result.staySegmentId,
      pricing_revision_id: result.pricingRevisionId,
      new_departure_date: resolvedDepartureDate
    });
    expect(amendment).toMatchObject({
      order_id: hold.order_id,
      sequence: 2,
      amendment_type: "EXTEND_STAY",
      prior_version: 1,
      new_version: 2,
      command_id: receipt.commandId,
      payload: prepared.preview.effect
    });
    expect(segment).toMatchObject({
      sequence: 2,
      inventory_unit_id: hold.inventory_unit_id,
      arrival_date: "2026-08-08",
      departure_date: resolvedDepartureDate,
      segment_type: "EXTEND_STAY",
      amendment_id: result.amendmentId
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(originalRevision);
    expect(revisions[0]).toMatchObject({
      revision_no: 1,
      pricing_origin: "MIGRATED_ACTUAL",
      policy_base_amount_minor: null,
      current_contract_amount_minor: 13_000,
      cash_lines: [{ lineKind: "MIGRATED_ACTUAL", historicalActualAmountMinor: 13_000, currency: "CNY" }]
    });
    expect(revisions[1]).toMatchObject({
      id: result.pricingRevisionId,
      revision_no: 2,
      amendment_id: result.amendmentId,
      departure_date: resolvedDepartureDate,
      pricing_origin: "MIGRATED_ACTUAL_PLUS_POST_CUTOVER",
      policy_base_amount_minor: null,
      current_contract_amount_minor: 39_000,
      cash_lines: [{
        lineKind: "MIGRATED_ACTUAL_PLUS_POST_CUTOVER",
        historicalActualAmountMinor: 13_000,
        postCutoverIncrementAmountMinor,
        newContractAmountMinor: 39_000,
        currency: "CNY"
      }]
    });
    expect(claims.map((claim) => claim.service_date)).toEqual([
      "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"
    ]);
    expect(claims.every((claim) => (
      claim.inventory_unit_id === hold.inventory_unit_id
      && claim.active
      && claim.released_at === null
    ))).toBe(true);
    expect(order).toMatchObject({
      id: hold.order_id,
      status: "CHECKED_IN",
      departure_date: resolvedDepartureDate,
      current_revision_id: result.pricingRevisionId,
      version: 2
    });
    const afterView = await withPropertyClockForTesting(resolutionClock, () => getOrderView(db, hold.order_id));
    expect(afterView.amounts.currentContractAmount).toEqual({ currency: "CNY", minorUnits: 39_000 });
    expect(afterView.allowedActions.find((action) => action.code === "RESOLVE_MIGRATED_OVERDUE_STAY"))
      .toEqual({
        code: "RESOLVE_MIGRATED_OVERDUE_STAY",
        enabled: false,
        disabledReason: "该订单没有待处理的逾期在住占房锁"
      });
    expect(afterView.allowedActions.find((action) => action.code === "CHECK_OUT"))
      .toEqual({ code: "CHECK_OUT", enabled: false, disabledReason: "DEPARTURE_DATE_NOT_REACHED" });
    const resolvedUnit = await roomStatusForResolution(hold);
    expect(resolvedUnit.days.every((day) => day.status === "IN_HOUSE" && !day.available)).toBe(true);
    expect(resolvedUnit.days.every((day) => (
      day.conflicts.some((conflict) => conflict.blockingFactKind === "CLAIM")
      && day.conflicts.every((conflict) => conflict.blockingFactKind !== "OVERDUE_IN_HOUSE")
    ))).toBe(true);

    const committedState = await overdueResolutionBusinessState(hold);
    const replay = await withPropertyClockForTesting(resolutionClock, () => confirmCommandPreview(
      db,
      principal,
      prepared.preview.previewId,
      confirmation,
      confirmationMetadata
    ));
    expect(replay.receiptId).toBe(receipt.receiptId);
    expect(replay.commandId).toBe(receipt.commandId);
    expect(await overdueResolutionBusinessState(hold)).toEqual(committedState);
    expect(committedState.releases).toHaveLength(1);
    expect(committedState.amendments).toHaveLength(1);
    expect(committedState.segments).toHaveLength(1);
    expect(committedState.revisions).toHaveLength(1);
    expect(committedState.claims).toHaveLength(4);

    const checkoutPrepared = await withPropertyClockForTesting(resolvedCheckoutClock, () => createCommandPreview(
      db,
      principal,
      {
        commandType: "CHECK_OUT",
        input: { propertyId: hold.property_id, orderId: hold.order_id }
      },
      metadata("overdue-resolved-checkout-preview")
    ));
    const checkoutReceipt = await withPropertyClockForTesting(resolvedCheckoutClock, () => confirmCommandPreview(
      db,
      principal,
      checkoutPrepared.preview.previewId,
      {
        propertyId: hold.property_id,
        commandType: "CHECK_OUT",
        confirmation: true,
        expectedEffectHash: checkoutPrepared.preview.effectHash,
        reason: { code: "AUTOMATED_ACCEPTANCE", note: "Resolved migrated overdue checkout acceptance" }
      },
      metadata("overdue-resolved-checkout-confirm")
    ));
    expect(checkoutReceipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: { orderId: hold.order_id, status: "CHECKED_OUT" }
    });
    expect(await db.selectFrom("orders").select("status").where("id", "=", hold.order_id).executeTakeFirstOrThrow())
      .toEqual({ status: "CHECKED_OUT" });
    expect((await orderClaimState(hold.order_id)).every((claim) => !claim.active && claim.released_at !== null)).toBe(true);
  });

  it("replays the identical manifest without duplicate targets", async () => {
    const replay = await approvedApply(manifest);
    expect(replay).toMatchObject({ mode: "REPLAYED", replayedSources: 535, newSources: 0 });
    expect(await count("migration_order_targets")).toBe(535);
  });

  it("replays the same immutable sources from a reissued manifest without requiring the old manifest hash", async () => {
    const raw = structuredClone(manifest) as unknown as Record<string, unknown>;
    raw.idempotencyKey = "historical-order-import:2026-03-13:reissued-test";
    raw.manifestHash = manifestStableHash(raw);
    const reissuedManifest = parseHistoricalOrderImportManifest(raw);
    const replay = await approvedApply(reissuedManifest);
    expect(replay).toMatchObject({
      mode: "REPLAYED",
      manifestHash: raw.manifestHash,
      replayedSources: 535,
      newSources: 0
    });
    expect(await countOrderImportRuns()).toBe(1);
    expect(await count("migration_order_targets")).toBe(535);
  });

  it("fails apply closed when the historical-import database readiness guard is damaged", async () => {
    const authorization = await approvalFor(manifest);
    await sql`DROP TRIGGER orders_migration_overdue_status_guard ON orders`.execute(db);
    try {
      await expect(applyHistoricalOrderImport(db, manifest, authorization)).rejects.toThrow(
        "Historical import database is not ready for migration 037"
      );
      expect(await countOrderImportRuns()).toBe(1);
      expect(await count("migration_order_targets")).toBe(535);
    } finally {
      await sql`
        CREATE TRIGGER orders_migration_overdue_status_guard
        BEFORE UPDATE OF status ON orders
        FOR EACH ROW EXECUTE FUNCTION qintopia_reject_active_migration_overdue_status_change()
      `.execute(db);
    }
  });
});
