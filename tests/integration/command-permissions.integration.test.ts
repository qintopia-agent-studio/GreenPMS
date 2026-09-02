import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  commandCatalogTypes,
  commandTypes,
  currentReleaseFeatures,
  type AuthPrincipal,
  type CommandCatalogType,
  type CommandEnvelope,
  type CommandType
} from "@qintopia/contracts";
import {
  authorizeCommandAccess,
  confirmCommandPreview,
  createCommandPreview,
  executeQuoteCommand,
  findCommandResult,
  getCommand,
  getOrderView,
  getReceipt,
  loadPropertyCommandGrantSnapshot,
  resolveCommandResult,
  withCommandAuthorizationAudit,
  type CommandAuthorizationStage,
  type Database
} from "@qintopia/db";
import {
  administratorCommandGrants,
  ordinaryStaffCommandGrants,
  systemDerivedCommandTypes,
  newId,
  newOpaqueSecret,
  sha256,
  stableHash
} from "@qintopia/domain";
import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.COMMAND_PERMISSIONS_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_command_permissions";

const ordinaryCommands = ordinaryStaffCommandGrants;
const administratorCommands = administratorCommandGrants;
const historicalReadCommands = ["PLACE_INTERNAL_USE", "RELEASE_INTERNAL_USE", "BACKFILL_COMPLETED_STAY"] as const;
const executeAuthorizationStages = ["PREVIEW", "CONFIRM"] as const satisfies readonly CommandAuthorizationStage[];
const readAuthorizationStages = ["STORED_PREVIEW", "REPLAY", "RECEIPT", "COMMAND", "FIND", "RESOLVE"] as const satisfies readonly CommandAuthorizationStage[];

let db: Kysely<Database>;
let sequence = 0;
let operatorPrincipal: AuthPrincipal;
let administratorPrincipal: AuthPrincipal;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function insertSession(subjectId: string, id: string) {
  await db.insertInto("web_sessions").values({
    id,
    subject_id: subjectId,
    secret_hash: sha256(newOpaqueSecret("qts")),
    expires_at: "2035-01-01T00:00:00.000Z",
    revoked_at: null
  }).execute();
}

async function insertToken(options: {
  id: string;
  subjectId: string;
  secret: string;
  expiresAt: string;
  revokedAt?: string | null;
  commandCeiling?: readonly CommandCatalogType[];
}) {
  await db.insertInto("api_tokens").values({
    id: options.id,
    subject_id: options.subjectId,
    label: options.id,
    secret_hash: sha256(options.secret),
    access_ceiling: "WRITE",
    property_scope: demo.propertyId,
    expires_at: options.expiresAt,
    revoked_at: options.revokedAt ?? null,
    rotated_from_id: null,
    replaced_by_id: null
  }).execute();
  if (options.commandCeiling?.length) {
    await db.insertInto("token_command_ceilings").values(options.commandCeiling.map((commandType) => ({
      token_id: options.id,
      subject_id: options.subjectId,
      property_id: demo.propertyId,
      command_type: commandType
    }))).execute();
  }
}

async function grant(subjectId: string, commands: readonly CommandCatalogType[]) {
  for (const commandType of commands) {
    await sql`
      insert into subject_command_grants (subject_id, property_id, command_type)
      values (${subjectId}, ${demo.propertyId}, ${commandType})
      on conflict (subject_id, property_id, command_type) do nothing
    `.execute(db);
  }
}

async function revoke(subjectId: string, commandType: CommandCatalogType) {
  const result = await db.deleteFrom("subject_command_grants")
    .where("subject_id", "=", subjectId)
    .where("property_id", "=", demo.propertyId)
    .where("command_type", "=", commandType)
    .executeTakeFirst();
  expect(result.numDeletedRows).toBe(1n);
}

async function createOrderFixture(prefix: string, arrivalDate: string) {
  const unit = await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("kind", "=", "ROOM")
    .where("occupancy_capacity", "=", 2)
    .where("inventory_basis", "=", "INDEPENDENT")
    .orderBy("code")
    .executeTakeFirstOrThrow();
  const departureDate = `${arrivalDate.slice(0, 8)}${String(Number(arrivalDate.slice(8)) + 2).padStart(2, "0")}`;
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unit.id,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.transientPolicyId
  });
  const prepared = await createCommandPreview(db, operatorPrincipal, {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: "权限测试住客", nickname: "权限测试" },
      additionalGuests: [{ fullName: "权限测试同行人", nickname: "同行人" }],
      bookingChannelCode: "YOUMUDAO",
      channelOrderReference: `COMMAND-PERMISSION-${prefix}`,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  }, metadata(`${prefix}-create-preview`));
  const receipt = await confirmCommandPreview(db, operatorPrincipal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: "CREATE_STANDARD_ORDER", note: "" }
  }, metadata(`${prefix}-create-confirm`));
  return {
    orderId: receipt.result!.orderId as string,
    occupantId: (receipt.result!.occupants as Array<{ id: string }>)[1]!.id,
    amountMinor: quote.currentContractAmount.minorUnits
  };
}

async function protocolAndBusinessCounts() {
  const [previews, executions, receipts, corrections, audits] = await Promise.all([
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("order_occupant_corrections").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [previews, executions, receipts, corrections, audits].map((row) => Number(row.count));
}

async function protocolQuoteAndTokenCounts() {
  const [previews, executions, receipts, audits, quotes, tokens, tokenCeilings] = await Promise.all([
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("quotes").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("api_tokens").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("token_command_ceilings").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [previews, executions, receipts, audits, quotes, tokens, tokenCeilings].map((row) => Number(row.count));
}

async function securityAuditCount(): Promise<number> {
  const row = await sql<{ count: string }>`select count(*)::text as count from security_audit_entries`.execute(db);
  return Number(row.rows[0]!.count);
}

function commandFeatureEnabledInRelease(commandType: CommandCatalogType): boolean {
  if (commandType === "COMPLETE_CLEANING") return currentReleaseFeatures.cleaningWorkflow;
  if (commandType === "CORRECT_HISTORICAL_STAY_ARRANGEMENTS") return currentReleaseFeatures.historicalStayArrangementCorrection;
  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") return currentReleaseFeatures.membershipConversionVoidCorrection;
  return true;
}

async function runAuthorizer(
  principal: AuthPrincipal,
  commandType: CommandCatalogType,
  mode: "EXECUTE" | "READ" = "EXECUTE",
  stage: CommandAuthorizationStage = mode === "EXECUTE" ? "PREVIEW" : "RECEIPT"
) {
  const request = metadata(`auth-${commandType.toLowerCase()}-${mode.toLowerCase()}-${stage.toLowerCase()}`);
  return withCommandAuthorizationAudit(db, () => db.transaction().execute((trx) => authorizeCommandAccess(db, trx, principal, {
    propertyId: demo.propertyId,
    commandType,
    stage,
    idempotencyKey: request.idempotencyKey,
    correlationId: request.correlationId,
    mode
  })));
}

async function expectDeniedWithOneSecurityAudit(
  action: () => Promise<unknown>,
  expected: { code?: string; statusCode?: number; denialReason?: string } = {}
) {
  const before = await securityAuditCount();
  await expect(action()).rejects.toMatchObject({
    ...(expected.code ? { code: expected.code } : {}),
    ...(expected.statusCode ? { statusCode: expected.statusCode } : {})
  });
  const after = await securityAuditCount();
  expect(after).toBe(before + 1);
  if (expected.denialReason) {
    const latest = await sql<{ denial_reason: string }>`
      select denial_reason
      from security_audit_entries
      order by created_at desc
      limit 1
    `.execute(db);
    expect(latest.rows[0]?.denial_reason).toBe(expected.denialReason);
  }
}

async function expectTokenLifecycleDeniedWithoutWrites(
  action: () => Promise<unknown>,
  expected: { code?: string; denialReason?: string } = {}
) {
  const before = await protocolQuoteAndTokenCounts();
  const auditBefore = await securityAuditCount();
  await expect(action()).rejects.toMatchObject({
    code: expected.code ?? "INSUFFICIENT_ACCESS",
    statusCode: 403
  });
  expect(await protocolQuoteAndTokenCounts()).toEqual(before);
  expect(await securityAuditCount()).toBe(auditBefore + 1);
  if (expected.denialReason) {
    const latest = await db.selectFrom("security_audit_entries")
      .select("denial_reason")
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(latest.denial_reason).toBe(expected.denialReason);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function holdExecutionAdvisoryLock(lockKey: string): Promise<{ release: () => Promise<void> }> {
  let releaseBlocker!: () => void;
  let reportLocked!: () => void;
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
  const blocker = db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    reportLocked();
    await blockerGate;
    await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
  });
  await locked;
  return {
    release: async () => {
      releaseBlocker();
      await blocker;
    }
  };
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
  const operatorSessionId = newId("session");
  const administratorSessionId = newId("session");
  await insertSession(demo.operatorSubjectId, operatorSessionId);
  await insertSession(demo.administratorSubjectId, administratorSessionId);
  await grant(demo.operatorSubjectId, ordinaryCommands);
  await grant(demo.administratorSubjectId, administratorCommands);
  operatorPrincipal = {
    subjectId: demo.operatorSubjectId,
    credentialId: operatorSessionId,
    credentialType: "SESSION",
    displayName: "Demo Operator",
    ...authScope({ credentialType: "SESSION" })
  };
  administratorPrincipal = {
    subjectId: demo.administratorSubjectId,
    credentialId: administratorSessionId,
    credentialType: "SESSION",
    displayName: "Demo Administrator",
    ...authScope({ credentialType: "SESSION", profile: "administrator" })
  };
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe("exact command permissions on PostgreSQL", () => {
  it("covers every catalog command in the operator/admin authorization stage matrix", async () => {
    expect(commandTypes).toHaveLength(33);
    expect(commandCatalogTypes).toHaveLength(39);
    await grant(demo.operatorSubjectId, historicalReadCommands);
    await grant(demo.administratorSubjectId, historicalReadCommands);

    const ordinarySet = new Set<string>(ordinaryCommands);
    const administratorSet = new Set<string>(administratorCommands);
    const ordinaryReadSet = new Set<string>([...ordinaryCommands, ...historicalReadCommands]);
    const administratorReadSet = new Set<string>([...administratorCommands, ...historicalReadCommands]);
    const historicalReadSet = new Set<string>(historicalReadCommands);
    const systemDerivedSet = new Set<string>(systemDerivedCommandTypes);

    const expectStageDecision = async (
      principal: AuthPrincipal,
      commandType: CommandCatalogType,
      mode: "EXECUTE" | "READ",
      stage: CommandAuthorizationStage,
      allowed: boolean,
      granted: boolean
    ) => {
      if (allowed) {
        await expect(runAuthorizer(principal, commandType, mode, stage), `${commandType} ${mode} ${stage}`).resolves.toBeUndefined();
        return;
      }
      await expectDeniedWithOneSecurityAudit(
        () => runAuthorizer(principal, commandType, mode, stage),
        {
          code: "INSUFFICIENT_ACCESS",
          statusCode: 403,
          denialReason: mode === "EXECUTE" && granted && !commandFeatureEnabledInRelease(commandType)
            ? "FEATURE_DISABLED"
            : "SUBJECT_COMMAND_GRANT_MISSING"
        }
      );
    };

    for (const commandType of commandCatalogTypes) {
      const isDirectQuote = commandType === "CREATE_QUOTE";
      const isHistoricalReadOnly = historicalReadSet.has(commandType);
      const ordinaryExecuteAllowed = !isDirectQuote
        && !isHistoricalReadOnly
        && ordinarySet.has(commandType)
        && commandFeatureEnabledInRelease(commandType);
      const administratorExecuteAllowed = !isDirectQuote
        && !isHistoricalReadOnly
        && administratorSet.has(commandType)
        && commandFeatureEnabledInRelease(commandType);
      const ordinaryReadAllowed = isDirectQuote
        || ordinaryReadSet.has(commandType);
      const administratorReadAllowed = isDirectQuote
        || administratorReadSet.has(commandType);

      if (!isDirectQuote) {
        for (const stage of executeAuthorizationStages) {
          await expectStageDecision(
            operatorPrincipal,
            commandType,
            "EXECUTE",
            stage,
            ordinaryExecuteAllowed,
            ordinarySet.has(commandType) || historicalReadSet.has(commandType)
          );
          await expectStageDecision(
            administratorPrincipal,
            commandType,
            "EXECUTE",
            stage,
            administratorExecuteAllowed,
            administratorSet.has(commandType) || historicalReadSet.has(commandType)
          );
        }
      }

      for (const stage of readAuthorizationStages) {
        await expectStageDecision(
          operatorPrincipal,
          commandType,
          "READ",
          stage,
          ordinaryReadAllowed,
          isDirectQuote || ordinaryReadSet.has(commandType)
        );
        await expectStageDecision(
          administratorPrincipal,
          commandType,
          "READ",
          stage,
          administratorReadAllowed,
          isDirectQuote || administratorReadSet.has(commandType)
        );
      }

      if (systemDerivedSet.has(commandType)) {
        expect(ordinarySet.has(commandType), commandType).toBe(false);
        expect(administratorSet.has(commandType), commandType).toBe(false);
        expect(ordinaryReadSet.has(commandType), commandType).toBe(false);
        expect(administratorReadSet.has(commandType), commandType).toBe(false);
      }
    }
  });

  it("keeps agent-demo ordinary, stores an independent administrator, and preserves historical read grants in snapshots", async () => {
    const agentGrants = await db.selectFrom("subject_command_grants")
      .select("command_type")
      .where("subject_id", "=", demo.agentSubjectId)
      .where("property_id", "=", demo.propertyId)
      .orderBy("command_type")
      .execute();
    expect(agentGrants.map((row) => row.command_type)).toEqual([...ordinaryCommands].sort());
    expect(agentGrants.map((row) => row.command_type)).not.toContain("ISSUE_TOKEN");
    expect(agentGrants.map((row) => row.command_type)).not.toContain("CORRECT_ORDER_OCCUPANT");

    const adminGrants = await db.selectFrom("subject_command_grants")
      .select("command_type")
      .where("subject_id", "=", demo.administratorSubjectId)
      .where("property_id", "=", demo.propertyId)
      .execute();
    expect(adminGrants.map((row) => row.command_type)).toEqual(expect.arrayContaining([
      "ISSUE_TOKEN",
      "ROTATE_TOKEN",
      "REVOKE_TOKEN",
      "CORRECT_ORDER_OCCUPANT",
      "COMPLETE_CLEANING",
      "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
    ]));

    await grant(demo.operatorSubjectId, ["PLACE_INTERNAL_USE", "RELEASE_INTERNAL_USE", "BACKFILL_COMPLETED_STAY"]);
    const snapshot = await loadPropertyCommandGrantSnapshot(db, demo.operatorSubjectId);
    const operatorSnapshot = snapshot.get(demo.propertyId);
    expect(operatorSnapshot?.has("PLACE_INTERNAL_USE")).toBe(true);
    expect(operatorSnapshot?.has("RELEASE_INTERNAL_USE")).toBe(true);
    expect(operatorSnapshot?.has("BACKFILL_COMPLETED_STAY")).toBe(true);
    await expect(runAuthorizer(operatorPrincipal, "PLACE_INTERNAL_USE", "READ")).resolves.toBeUndefined();
    await expectDeniedWithOneSecurityAudit(
      () => runAuthorizer(operatorPrincipal, "PLACE_INTERNAL_USE", "EXECUTE"),
      { code: "INSUFFICIENT_ACCESS", statusCode: 403, denialReason: "SUBJECT_COMMAND_GRANT_MISSING" }
    );
  });

  it("does not let staff distinguish existing Token-management targets from missing targets", async () => {
    const existingTokenId = newId("token");
    await insertToken({
      id: existingTokenId,
      subjectId: demo.operatorSubjectId,
      secret: newOpaqueSecret("qtp"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["REPRICE_ORDER"]
    });

    const cases = [
      {
        commandType: "ISSUE_TOKEN" as const,
        existingInput: {
          propertyId: demo.propertyId,
          subjectId: demo.operatorSubjectId,
          label: "Existing target",
          accessCeiling: "WRITE" as const,
          commandCeiling: ["REPRICE_ORDER" as const],
          expiresAt: "2099-01-01T00:00:00.000Z",
          tokenSecret: newOpaqueSecret("qtp")
        },
        missingInput: {
          propertyId: demo.propertyId,
          subjectId: "subject_missing_token_management_oracle",
          label: "Missing target",
          accessCeiling: "WRITE" as const,
          commandCeiling: ["REPRICE_ORDER" as const],
          expiresAt: "2099-01-01T00:00:00.000Z",
          tokenSecret: newOpaqueSecret("qtp")
        }
      },
      {
        commandType: "ROTATE_TOKEN" as const,
        existingInput: {
          propertyId: demo.propertyId,
          tokenId: existingTokenId,
          commandCeiling: ["REPRICE_ORDER" as const],
          expiresAt: "2099-01-01T00:00:00.000Z",
          tokenSecret: newOpaqueSecret("qtp")
        },
        missingInput: {
          propertyId: demo.propertyId,
          tokenId: "token_missing_token_management_oracle",
          commandCeiling: ["REPRICE_ORDER" as const],
          expiresAt: "2099-01-01T00:00:00.000Z",
          tokenSecret: newOpaqueSecret("qtp")
        }
      },
      {
        commandType: "REVOKE_TOKEN" as const,
        existingInput: { propertyId: demo.propertyId, tokenId: existingTokenId },
        missingInput: { propertyId: demo.propertyId, tokenId: "token_missing_token_management_oracle" }
      }
    ];

    for (const testCase of cases) {
      for (const [targetKind, input] of [["existing", testCase.existingInput], ["missing", testCase.missingInput]] as const) {
        await expectTokenLifecycleDeniedWithoutWrites(
          () => createCommandPreview(db, operatorPrincipal, {
            commandType: testCase.commandType,
            input
          } as CommandEnvelope, metadata(`staff-${testCase.commandType.toLowerCase()}-${targetKind}`)),
          { denialReason: "SUBJECT_COMMAND_GRANT_MISSING" }
        );
      }
    }
  });

  it("persists only the explicitly requested ceiling when issuing a WRITE Token", async () => {
    await grant(demo.operatorSubjectId, historicalReadCommands);
    const preview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.operatorSubjectId,
        label: "Historical recovery issue",
        accessCeiling: "WRITE",
        commandCeiling: ["REPRICE_ORDER"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("historical-recovery-issue-preview"));
    const persistedCommandCeiling = ["REPRICE_ORDER"];
    expect(preview.preview.effect).toMatchObject({
      subjectId: demo.operatorSubjectId,
      subjectDisplayName: "Demo Operator",
      commandCeiling: ["REPRICE_ORDER"],
      persistedCommandCeiling
    });

    const receipt = await confirmCommandPreview(db, administratorPrincipal, preview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "ISSUE_TOKEN",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "EXPLICIT_TOKEN_CEILING", note: "仅签发显式选择的命令范围" }
    }, metadata("historical-recovery-issue-confirm"));
    expect(receipt.result).toMatchObject({
      subjectId: demo.operatorSubjectId,
      subjectDisplayName: "Demo Operator",
      commandCeiling: ["REPRICE_ORDER"],
      persistedCommandCeiling
    });
    const rows = await db.selectFrom("token_command_ceilings")
      .select("command_type")
      .where("token_id", "=", receipt.result!.tokenId as string)
      .orderBy("command_type")
      .execute();
    expect(rows.map((row) => row.command_type)).toEqual(persistedCommandCeiling);
  });

  it("rotates to the explicit narrowed ceiling without inheriting hidden recovery capabilities", async () => {
    const disabledFeatureCommand = "CORRECT_HISTORICAL_STAY_ARRANGEMENTS" as const;
    await grant(demo.operatorSubjectId, [...historicalReadCommands, disabledFeatureCommand]);
    const oldTokenId = newId("token");
    const previousExpiresAt = "2099-01-01T00:00:00.000Z";
    const expiresAt = "2098-01-01T00:00:00.000Z";
    const previousPersistedCommandCeiling = [
      "CREATE_ORDER",
      "REPRICE_ORDER",
      ...historicalReadCommands,
      disabledFeatureCommand
    ].sort() as CommandCatalogType[];
    await insertToken({
      id: oldTokenId,
      subjectId: demo.operatorSubjectId,
      secret: newOpaqueSecret("qtp"),
      expiresAt: previousExpiresAt,
      commandCeiling: previousPersistedCommandCeiling
    });

    try {
      const preview = await createCommandPreview(db, administratorPrincipal, {
        commandType: "ROTATE_TOKEN",
        input: {
          propertyId: demo.propertyId,
          tokenId: oldTokenId,
          commandCeiling: ["REPRICE_ORDER"],
          expiresAt,
          tokenSecret: newOpaqueSecret("qtp")
        }
      }, metadata("historical-recovery-rotate-preview"));
      const persistedCommandCeiling = ["REPRICE_ORDER"];
      expect(preview.preview.effect).toMatchObject({
        tokenId: oldTokenId,
        subjectId: demo.operatorSubjectId,
        subjectDisplayName: "Demo Operator",
        previousCommandCeiling: ["CREATE_ORDER", "REPRICE_ORDER"],
        commandCeiling: ["REPRICE_ORDER"],
        previousPersistedCommandCeiling,
        persistedCommandCeiling,
        previousExpiresAt,
        expiresAt,
        historicalReadCeilingPreserved: false,
        operation: "ROTATE"
      });

      const receipt = await confirmCommandPreview(db, administratorPrincipal, preview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "ROTATE_TOKEN",
        confirmation: true,
        expectedEffectHash: preview.preview.effectHash,
        reason: { code: "EXPLICIT_TOKEN_CEILING", note: "轮换后只保留显式选择的命令范围" }
      }, metadata("historical-recovery-rotate-confirm"));
      expect(receipt.result).toMatchObject({
        rotatedFromTokenId: oldTokenId,
        subjectId: demo.operatorSubjectId,
        subjectDisplayName: "Demo Operator",
        previousCommandCeiling: ["CREATE_ORDER", "REPRICE_ORDER"],
        commandCeiling: ["REPRICE_ORDER"],
        previousPersistedCommandCeiling,
        persistedCommandCeiling,
        previousExpiresAt,
        expiresAt,
        historicalReadCeilingPreserved: false
      });
      const replacementTokenId = receipt.result!.tokenId as string;
      const rows = await db.selectFrom("token_command_ceilings")
        .select("command_type")
        .where("token_id", "=", replacementTokenId)
        .orderBy("command_type")
        .execute();
      expect(rows.map((row) => row.command_type)).toEqual(persistedCommandCeiling);

      const replacementPrincipal: AuthPrincipal = {
        subjectId: demo.operatorSubjectId,
        credentialId: replacementTokenId,
        credentialType: "TOKEN",
        displayName: "Demo Operator",
        ...authScope({ credentialType: "TOKEN" })
      };
      await expectDeniedWithOneSecurityAudit(
        () => runAuthorizer(replacementPrincipal, "PLACE_INTERNAL_USE", "READ"),
        { code: "INSUFFICIENT_ACCESS", statusCode: 403, denialReason: "TOKEN_COMMAND_CEILING_MISSING" }
      );
      await expectDeniedWithOneSecurityAudit(
        () => runAuthorizer(replacementPrincipal, disabledFeatureCommand, "READ"),
        { code: "INSUFFICIENT_ACCESS", statusCode: 403, denialReason: "TOKEN_COMMAND_CEILING_MISSING" }
      );
      await expectDeniedWithOneSecurityAudit(
        () => runAuthorizer(replacementPrincipal, disabledFeatureCommand, "EXECUTE"),
        { code: "INSUFFICIENT_ACCESS", statusCode: 403, denialReason: "TOKEN_COMMAND_CEILING_MISSING" }
      );
      await expectDeniedWithOneSecurityAudit(
        () => runAuthorizer(replacementPrincipal, "CREATE_ORDER", "EXECUTE"),
        { code: "INSUFFICIENT_ACCESS", statusCode: 403, denialReason: "TOKEN_COMMAND_CEILING_MISSING" }
      );
      await expect(runAuthorizer(replacementPrincipal, "REPRICE_ORDER", "EXECUTE")).resolves.toBeUndefined();
    } finally {
      await revoke(demo.operatorSubjectId, disabledFeatureCommand);
    }
  });

  it("returns 403 for a missing exact grant before writing protocol, business, or idempotency facts", async () => {
    const requestMetadata = {
      idempotencyKey: metadata("missing-correction-grant").idempotencyKey,
      correlationId: metadata("missing-correction-correlation").correlationId
    };
    const before = await protocolAndBusinessCounts();
    const securityAuditBefore = await sql<{ count: string }>`select count(*)::text as count from security_audit_entries`.execute(db);

    await expect(createCommandPreview(db, operatorPrincipal, {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId: demo.propertyId,
        orderId: "order_must_not_be_resolved_before_authorization",
        occupantId: "occupant_private_reference",
        expectedPriorSnapshot: { fullName: "敏感原姓名", nickname: "原昵称", phone: null, documentNumber: null },
        correctedSnapshot: { fullName: "敏感新姓名", nickname: "新昵称", phone: null, documentNumber: null }
      }
    }, requestMetadata)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });

    expect(await protocolAndBusinessCounts()).toEqual(before);
    const securityAuditAfter = await sql<{ count: string }>`select count(*)::text as count from security_audit_entries`.execute(db);
    expect(Number(securityAuditAfter.rows[0]!.count)).toBe(Number(securityAuditBefore.rows[0]!.count) + 1);
    const denialAudits = await sql<{
      property_id: string;
      subject_id: string;
      command_type: string;
      stage: string;
      denial_reason: string;
      credential_type: string;
      credential_fingerprint: string;
      correlation_id: string;
      idempotency_key_hash: string;
      metadata: unknown;
    }>`
      select property_id, subject_id, command_type, stage, denial_reason,
             credential_type, credential_fingerprint, correlation_id,
             idempotency_key_hash, metadata
      from security_audit_entries
      order by created_at desc
      limit 1
    `.execute(db);
    expect(denialAudits.rows).toEqual([
      expect.objectContaining({
        property_id: demo.propertyId,
        subject_id: demo.operatorSubjectId,
        command_type: "CORRECT_ORDER_OCCUPANT",
        stage: "PREVIEW",
        denial_reason: "SUBJECT_COMMAND_GRANT_MISSING",
        credential_type: "SESSION",
        credential_fingerprint: expect.stringMatching(/^[a-f0-9]{16,64}$/),
        correlation_id: requestMetadata.correlationId,
        idempotency_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    const serializedAudit = JSON.stringify(denialAudits.rows[0]);
    expect(serializedAudit).not.toContain(operatorPrincipal.credentialId);
    expect(serializedAudit).not.toContain(requestMetadata.idempotencyKey);
    expect(serializedAudit).not.toContain("敏感原姓名");
    expect(serializedAudit).not.toContain("敏感新姓名");
  });

  it("allows ordinary staff to reprice while reserving occupant correction for administrators", async () => {
    const fixture = await createOrderFixture("profile", "2034-03-01");
    const reprice = await createCommandPreview(db, operatorPrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        targetCurrentContractAmountMinor: fixture.amountMinor + 1_000
      }
    }, metadata("ordinary-reprice"));
    expect(reprice.preview.commandType).toBe("REPRICE_ORDER");

    const occupant = (await getOrderView(db, fixture.orderId)).occupants.find((candidate) => candidate.id === fixture.occupantId)!;
    const correction: CommandEnvelope = {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        occupantId: fixture.occupantId,
        expectedPriorSnapshot: {
          fullName: occupant.fullName,
          nickname: occupant.nickname,
          phone: occupant.phone,
          documentNumber: occupant.documentNumber
        },
        correctedSnapshot: {
          fullName: "权限测试同行人（已核对）",
          nickname: "已核对",
          phone: null,
          documentNumber: null
        }
      }
    };
    await expect(createCommandPreview(db, operatorPrincipal, correction, metadata("ordinary-correction")))
      .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
    expect((await createCommandPreview(db, administratorPrincipal, correction, metadata("administrator-correction"))).preview.commandType)
      .toBe("CORRECT_ORDER_OCCUPANT");
  });

  it("authorizes Confirm against the stored command after its grant is revoked even when the body names an allowed command", async () => {
    const fixture = await createOrderFixture("revocation", "2034-04-01");
    const prepared = await createCommandPreview(db, operatorPrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        targetCurrentContractAmountMinor: fixture.amountMinor + 2_000
      }
    }, metadata("revoked-reprice-preview"));
    const confirmMetadata = metadata("revoked-reprice-confirm");
    const beforeConfirm = await protocolAndBusinessCounts();
    const auditBefore = await securityAuditCount();
    await revoke(demo.operatorSubjectId, "REPRICE_ORDER");

    await expect(confirmCommandPreview(db, operatorPrincipal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, confirmMetadata)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
    expect(await protocolAndBusinessCounts()).toEqual(beforeConfirm);
    expect(await securityAuditCount()).toBe(auditBefore + 1);
    const denial = await db.selectFrom("security_audit_entries")
      .select(["property_id", "command_type", "stage", "denial_reason"])
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(denial).toEqual({
      property_id: demo.propertyId,
      command_type: "REPRICE_ORDER",
      stage: "CONFIRM",
      denial_reason: "SUBJECT_COMMAND_GRANT_MISSING"
    });
    await expect(getReceipt(db, operatorPrincipal, prepared.receipt.receiptId))
      .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
  });

  it("replays a Confirm receipt without a stored Preview only while its exact grant remains active", async () => {
    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const previewId = `preview_historical_confirm_${sequence}`;
    const replayMetadata = metadata("historical-confirm-replay");
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "REPRICE_ORDER" as const,
      confirmation: true,
      expectedEffectHash: "a".repeat(64),
      reason: { code: "HISTORICAL_EXACT_REPLAY", note: "历史确认精确回放" }
    };
    const commandId = `command_historical_confirm_${sequence}`;
    const receiptId = `receipt_historical_confirm_${sequence}`;
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: demo.operatorSubjectId,
        credential_id: operatorPrincipal.credentialId,
        property_id: demo.propertyId,
        command_type: confirmation.commandType,
        idempotency_key: replayMetadata.idempotencyKey,
        request_hash: stableHash({ previewId, confirmation }),
        correlation_id: replayMetadata.correlationId,
        state: "REJECTED",
        completed_at: new Date()
      }).execute();
      await trx.insertInto("command_receipts").values({
        id: receiptId,
        command_id: commandId,
        execution_status: "NOT_EXECUTED",
        business_committed: false,
        result: null,
        error: {
          code: "PREVIEW_STALE",
          message: "Historical terminal rejection",
          correlationId: replayMetadata.correlationId,
          retryable: false,
          commandId,
          receiptId
        },
        resource_refs: JSON.stringify([]),
        fact_refs: JSON.stringify([]),
        committed_at: new Date()
      }).execute();
    });

    const beforeReplay = await protocolAndBusinessCounts();
    await expect(confirmCommandPreview(
      db,
      operatorPrincipal,
      previewId,
      confirmation,
      replayMetadata
    )).resolves.toMatchObject({ receiptId, commandId, executionStatus: "NOT_EXECUTED", businessCommitted: false });
    expect(await protocolAndBusinessCounts()).toEqual(beforeReplay);

    const auditBeforeRevocation = await securityAuditCount();
    await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
    try {
      await expect(confirmCommandPreview(
        db,
        operatorPrincipal,
        previewId,
        confirmation,
        replayMetadata
      )).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
      expect(await protocolAndBusinessCounts()).toEqual(beforeReplay);
      expect(await securityAuditCount()).toBe(auditBeforeRevocation + 1);
      const denial = await db.selectFrom("security_audit_entries")
        .select(["property_id", "command_type", "stage", "denial_reason"])
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      expect(denial).toEqual({
        property_id: demo.propertyId,
        command_type: "REPRICE_ORDER",
        stage: "REPLAY",
        denial_reason: "SUBJECT_COMMAND_GRANT_MISSING"
      });
    } finally {
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }

    const beforeMissing = await protocolAndBusinessCounts();
    await expect(confirmCommandPreview(
      db,
      operatorPrincipal,
      "preview_missing_authorized_confirm",
      confirmation,
      metadata("missing-authorized-confirm")
    )).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND", statusCode: 404 });
    expect(await protocolAndBusinessCounts()).toEqual(beforeMissing);
  });

  it("allows an in-flight Confirm that wins before revocation, then blocks later reads after the grant is revoked", async () => {
    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const fixture = await createOrderFixture("confirm-before-revocation", "2034-04-10");
    const prepared = await createCommandPreview(db, operatorPrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        targetCurrentContractAmountMinor: fixture.amountMinor + 2_500
      }
    }, metadata("confirm-before-revocation-preview"));
    const confirmMetadata = metadata("confirm-before-revocation-confirm");
    const receipt = await confirmCommandPreview(db, operatorPrincipal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "REPRICE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CONFIRM_WINS", note: "Confirm commits before the exact grant is revoked" }
    }, confirmMetadata);
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
    try {
      await expect(getReceipt(db, operatorPrincipal, receipt.receiptId))
        .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
      await expect(getCommand(db, operatorPrincipal, receipt.commandId))
        .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
      await expect(findCommandResult(db, operatorPrincipal, demo.propertyId, "REPRICE_ORDER", confirmMetadata.idempotencyKey))
        .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
    } finally {
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }
  });

  it("rolls back and releases a single business connection before writing exactly one denial audit", async () => {
    const singleConnectionDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 250 })
      })
    });
    const request = metadata("single-connection-denial");
    const before = await protocolAndBusinessCounts();
    const auditBefore = await securityAuditCount();
    try {
      await expect(createCommandPreview(singleConnectionDb, operatorPrincipal, {
        commandType: "CORRECT_ORDER_OCCUPANT",
        input: {
          propertyId: demo.propertyId,
          orderId: "order_single_connection_denial",
          occupantId: "occupant_single_connection_denial",
          expectedPriorSnapshot: { fullName: "不得读取", nickname: "不得读取", phone: null, documentNumber: null },
          correctedSnapshot: { fullName: "不得写入", nickname: "不得写入", phone: null, documentNumber: null }
        }
      }, request)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
    } finally {
      await singleConnectionDb.destroy();
    }
    expect(await protocolAndBusinessCounts()).toEqual(before);
    expect(await securityAuditCount()).toBe(auditBefore + 1);
  });

  it("returns 404 and writes one security audit for cross-subject Confirm without protocol artifacts", async () => {
    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const fixture = await createOrderFixture("cross-subject-confirm", "2034-05-01");
    const prepared = await createCommandPreview(db, operatorPrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        targetCurrentContractAmountMinor: fixture.amountMinor + 3_000
      }
    }, metadata("cross-subject-preview"));
    const before = await protocolAndBusinessCounts();
    const auditBefore = await securityAuditCount();

    await expect(confirmCommandPreview(db, administratorPrincipal, prepared.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "REPRICE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CROSS_SUBJECT", note: "不得确认其他主体的 Preview" }
    }, metadata("cross-subject-confirm"))).rejects.toMatchObject({ statusCode: 404 });

    expect(await protocolAndBusinessCounts()).toEqual(before);
    expect(await securityAuditCount()).toBe(auditBefore + 1);
    const latest = await db.selectFrom("security_audit_entries")
      .select(["subject_id", "command_type", "stage", "denial_reason"])
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(latest).toEqual({
      subject_id: demo.administratorSubjectId,
      command_type: "REPRICE_ORDER",
      stage: "CONFIRM",
      denial_reason: "SUBJECT_SCOPE_MISSING"
    });
  });

  it("uses the stored property for same-subject cross-property Token Confirm visibility", async () => {
    const propertyB = "property_confirm_identity_b";
    const tokenId = "token_confirm_identity_b";
    await db.insertInto("properties").values({
      id: propertyB,
      code: "CONFIRM-B",
      name: "Confirm identity B",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    await db.insertInto("subject_property_grants").values({
      subject_id: demo.administratorSubjectId,
      property_id: propertyB,
      access_level: "WRITE"
    }).execute();
    await db.insertInto("subject_command_grants").values({
      subject_id: demo.administratorSubjectId,
      property_id: propertyB,
      command_type: "ISSUE_TOKEN"
    }).execute();
    await db.insertInto("api_tokens").values({
      id: tokenId,
      subject_id: demo.administratorSubjectId,
      label: "Confirm identity B",
      secret_hash: sha256(newOpaqueSecret("qtp")),
      access_ceiling: "WRITE",
      property_scope: propertyB,
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
      rotated_from_id: null,
      replaced_by_id: null
    }).execute();
    await db.insertInto("token_command_ceilings").values({
      token_id: tokenId,
      subject_id: demo.administratorSubjectId,
      property_id: propertyB,
      command_type: "ISSUE_TOKEN"
    }).execute();
    const propertyBPrincipal: AuthPrincipal = {
      subjectId: demo.administratorSubjectId,
      credentialId: tokenId,
      credentialType: "TOKEN",
      displayName: "Demo Administrator",
      propertyAccess: new Map([[propertyB, "WRITE"]]),
      propertyCommandGrants: new Map([[propertyB, new Set(["ISSUE_TOKEN"])]]),
      tokenCommandCeiling: new Set(["ISSUE_TOKEN"])
    };
    const prepared = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.operatorSubjectId,
        label: "Stored property identity",
        accessCeiling: "READ",
        commandCeiling: [],
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("cross-property-confirm-preview"));
    const before = await protocolAndBusinessCounts();
    const auditBefore = await securityAuditCount();

    await expect(confirmCommandPreview(db, propertyBPrincipal, prepared.preview.previewId, {
      propertyId: propertyB,
      commandType: "ISSUE_TOKEN",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CROSS_PROPERTY", note: "不得用 B 物业 Token 确认 A 物业 Preview" }
    }, metadata("cross-property-confirm"))).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });

    expect(await protocolAndBusinessCounts()).toEqual(before);
    expect(await securityAuditCount()).toBe(auditBefore + 1);
    const denial = await db.selectFrom("security_audit_entries")
      .select(["property_id", "subject_id", "command_type", "stage", "denial_reason"])
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(denial).toEqual({
      property_id: demo.propertyId,
      subject_id: demo.administratorSubjectId,
      command_type: "ISSUE_TOKEN",
      stage: "CONFIRM",
      denial_reason: "PROPERTY_SCOPE_MISSING"
    });
  });

  it("revalidates authorization before returning UNKNOWN for busy Quote, Preview, and Confirm locks", async () => {
    const revokedSessionId = newId("session");
    await insertSession(demo.operatorSubjectId, revokedSessionId);
    const revokedSessionPrincipal: AuthPrincipal = {
      subjectId: demo.operatorSubjectId,
      credentialId: revokedSessionId,
      credentialType: "SESSION",
      displayName: "Revoked busy Quote session",
      ...authScope({ credentialType: "SESSION" })
    };
    const quoteMetadata = metadata("busy-quote-revoked-session");
    const quoteLock = await holdExecutionAdvisoryLock(
      `qintopia:command:${demo.operatorSubjectId}:${demo.propertyId}:CREATE_QUOTE:${quoteMetadata.idempotencyKey}`
    );
    try {
      await db.updateTable("web_sessions")
        .set({ revoked_at: "2034-01-01T00:00:00.000Z" })
        .where("id", "=", revokedSessionId)
        .execute();
      const before = await protocolQuoteAndTokenCounts();
      const auditBefore = await securityAuditCount();
      await expect(executeQuoteCommand(db, revokedSessionPrincipal, {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.roomId,
        stayType: "TRANSIENT",
        arrivalDate: "2034-06-01",
        departureDate: "2034-06-02",
        pricingPolicyVersionId: demo.transientPolicyId
      }, quoteMetadata)).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", statusCode: 401 });
      expect(await protocolQuoteAndTokenCounts()).toEqual(before);
      expect(await securityAuditCount()).toBe(auditBefore + 1);
    } finally {
      await quoteLock.release();
    }

    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const previewMetadata = metadata("busy-preview-revoked-grant");
    const previewLock = await holdExecutionAdvisoryLock(
      `qintopia:command:${demo.operatorSubjectId}:${demo.propertyId}:PREVIEW:REPRICE_ORDER:${previewMetadata.idempotencyKey}`
    );
    try {
      await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
      const before = await protocolQuoteAndTokenCounts();
      const auditBefore = await securityAuditCount();
      await expect(createCommandPreview(db, operatorPrincipal, {
        commandType: "REPRICE_ORDER",
        input: {
          propertyId: demo.propertyId,
          orderId: "order_busy_preview_must_not_resolve",
          targetCurrentContractAmountMinor: 1
        }
      }, previewMetadata)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
      expect(await protocolQuoteAndTokenCounts()).toEqual(before);
      expect(await securityAuditCount()).toBe(auditBefore + 1);
    } finally {
      await previewLock.release();
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }

    const fixture = await createOrderFixture("busy-confirm-revoked-grant", "2034-07-01");
    const prepared = await createCommandPreview(db, operatorPrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        targetCurrentContractAmountMinor: fixture.amountMinor + 4_000
      }
    }, metadata("busy-confirm-preview"));
    const confirmMetadata = metadata("busy-confirm-revoked-grant");
    const confirmLock = await holdExecutionAdvisoryLock(
      `qintopia:command:${demo.operatorSubjectId}:${demo.propertyId}:REPRICE_ORDER:${confirmMetadata.idempotencyKey}`
    );
    try {
      await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
      const before = await protocolQuoteAndTokenCounts();
      const auditBefore = await securityAuditCount();
      await expect(confirmCommandPreview(db, operatorPrincipal, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "REPRICE_ORDER",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "BUSY_CONFIRM", note: "busy confirm must revalidate exact grants" }
      }, confirmMetadata)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
      expect(await protocolQuoteAndTokenCounts()).toEqual(before);
      expect(await securityAuditCount()).toBe(auditBefore + 1);
    } finally {
      await confirmLock.release();
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }
  });

  it("keeps busy foreign Confirm indistinguishable from a missing Preview", async () => {
    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const fixture = await createOrderFixture("busy-foreign-confirm", "2034-08-01");
    const prepared = await createCommandPreview(db, operatorPrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        targetCurrentContractAmountMinor: fixture.amountMinor + 5_000
      }
    }, metadata("busy-foreign-preview"));
    const confirmMetadata = metadata("busy-foreign-confirm");
    const callerLock = await holdExecutionAdvisoryLock(
      `qintopia:command:${demo.administratorSubjectId}:${demo.propertyId}:REPRICE_ORDER:${confirmMetadata.idempotencyKey}`
    );
    try {
      const before = await protocolQuoteAndTokenCounts();
      const auditBefore = await securityAuditCount();
      const confirmation = {
        propertyId: demo.propertyId,
        commandType: "REPRICE_ORDER" as const,
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "BUSY_FOREIGN", note: "foreign busy Preview must not be an existence oracle" }
      };
      await expect(confirmCommandPreview(db, administratorPrincipal, prepared.preview.previewId, confirmation, confirmMetadata))
        .rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND", statusCode: 404 });
      expect(await protocolQuoteAndTokenCounts()).toEqual(before);
      expect(await securityAuditCount()).toBe(auditBefore + 1);

      await expect(confirmCommandPreview(db, administratorPrincipal, "preview_missing_busy_foreign", confirmation, metadata("busy-missing-confirm")))
        .rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND", statusCode: 404 });
      expect(await protocolQuoteAndTokenCounts()).toEqual(before);
      expect(await securityAuditCount()).toBe(auditBefore + 1);
    } finally {
      await callerLock.release();
    }
  });

  it("revalidates a revoked exact grant before returning UNKNOWN for a busy resolution lock", async () => {
    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const originalMetadata = metadata("busy-resolve-original");
    const resolutionMetadata = metadata("busy-resolve-attempt");
    const lockKey = `qintopia:command:${demo.operatorSubjectId}:${demo.propertyId}:REPRICE_ORDER:${originalMetadata.idempotencyKey}`;
    let releaseBlocker!: () => void;
    let reportLocked!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const blocker = db.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
      reportLocked();
      await blockerGate;
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    });
    await locked;

    try {
      await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
      const before = await protocolAndBusinessCounts();
      const auditBefore = await securityAuditCount();
      await expect(resolveCommandResult(db, operatorPrincipal, {
        propertyId: demo.propertyId,
        commandType: "REPRICE_ORDER",
        idempotencyKey: originalMetadata.idempotencyKey
      }, resolutionMetadata)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
      expect(await protocolAndBusinessCounts()).toEqual(before);
      expect(await securityAuditCount()).toBe(auditBefore + 1);
      const denial = await db.selectFrom("security_audit_entries")
        .select(["command_type", "stage", "denial_reason"])
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      expect(denial).toEqual({
        command_type: "REPRICE_ORDER",
        stage: "RESOLVE",
        denial_reason: "SUBJECT_COMMAND_GRANT_MISSING"
      });
    } finally {
      releaseBlocker();
      await blocker;
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }
  });

  it("treats child Token expiry and command-ceiling escalation as audited authorization denials before protocol writes", async () => {
    const confirmIssue = async (principal: AuthPrincipal, preview: Awaited<ReturnType<typeof createCommandPreview>>, prefix: string) => {
      return confirmCommandPreview(db, principal, preview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "ISSUE_TOKEN",
        confirmation: true,
        expectedEffectHash: preview.preview.effectHash,
        reason: { code: "TOKEN_SCOPE_TEST", note: "Token scope must fail before protocol persistence" }
      }, metadata(prefix));
    };
    const tokenPrincipal = async (prefix: string, expiresAt: string, commandCeiling: readonly CommandCatalogType[]) => {
      const callerTokenId = newId("token");
      await insertToken({
        id: callerTokenId,
        subjectId: demo.administratorSubjectId,
        secret: newOpaqueSecret("qtp"),
        expiresAt,
        commandCeiling
      });
      return {
        subjectId: demo.administratorSubjectId,
        credentialId: callerTokenId,
        credentialType: "TOKEN",
        displayName: `Token scope administrator ${prefix}`,
        ...authScope({ credentialType: "TOKEN", profile: "administrator" })
      } satisfies AuthPrincipal;
    };
    const preparePreview = async (prefix: string) => {
      const principal = await tokenPrincipal(prefix, "2099-01-01T00:00:00.000Z", ["ISSUE_TOKEN", "REPRICE_ORDER"]);
      const preview = await createCommandPreview(db, principal, {
        commandType: "ISSUE_TOKEN",
        input: {
          propertyId: demo.propertyId,
          subjectId: demo.operatorSubjectId,
          label: `${prefix} child`,
          accessCeiling: "WRITE",
          commandCeiling: ["REPRICE_ORDER"],
          expiresAt: "2098-01-01T00:00:00.000Z",
          tokenSecret: newOpaqueSecret("qtp")
        }
      }, metadata(`${prefix}-preview`));
      return preview;
    };

    const expiryPreview = await preparePreview("expiry-ceiling");
    const expiryPrincipal = await tokenPrincipal(
      "expiry-confirm",
      "2097-01-01T00:00:00.000Z",
      ["ISSUE_TOKEN", "REPRICE_ORDER"]
    );
    const expiryBefore = await protocolAndBusinessCounts();
    const expiryAuditBefore = await securityAuditCount();
    await expect(confirmIssue(expiryPrincipal, expiryPreview, "expiry-ceiling-confirm"))
      .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
    expect(await protocolAndBusinessCounts()).toEqual(expiryBefore);
    expect(await securityAuditCount()).toBe(expiryAuditBefore + 1);

    const commandPreview = await preparePreview("command-ceiling");
    const commandPrincipal = await tokenPrincipal(
      "command-confirm",
      "2099-01-01T00:00:00.000Z",
      ["ISSUE_TOKEN"]
    );
    const commandBefore = await protocolAndBusinessCounts();
    const commandAuditBefore = await securityAuditCount();
    await expect(confirmIssue(commandPrincipal, commandPreview, "command-ceiling-confirm"))
      .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS", statusCode: 403 });
    expect(await protocolAndBusinessCounts()).toEqual(commandBefore);
    expect(await securityAuditCount()).toBe(commandAuditBefore + 1);
  });

  it("audits Token target ceiling and target downgrade denials before protocol or Token writes", async () => {
    await db.deleteFrom("subject_command_grants")
      .where("subject_id", "=", demo.operatorSubjectId)
      .where("property_id", "=", demo.propertyId)
      .where("command_type", "=", "CORRECT_ORDER_OCCUPANT")
      .execute();
    await expectTokenLifecycleDeniedWithoutWrites(
      () => createCommandPreview(db, administratorPrincipal, {
        commandType: "ISSUE_TOKEN",
        input: {
          propertyId: demo.propertyId,
          subjectId: demo.operatorSubjectId,
          label: "Escalating child Token",
          accessCeiling: "WRITE",
          commandCeiling: ["CORRECT_ORDER_OCCUPANT"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          tokenSecret: newOpaqueSecret("qtp")
        }
      }, metadata("target-admin-only-ceiling-preview")),
      { denialReason: "TOKEN_TARGET_COMMAND_CEILING_EXCEEDED" }
    );

    await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    const grantPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.operatorSubjectId,
        label: "Target grant downgrade",
        accessCeiling: "WRITE",
        commandCeiling: ["REPRICE_ORDER"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("target-grant-downgrade-preview"));
    try {
      await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
      await expectTokenLifecycleDeniedWithoutWrites(
        () => confirmCommandPreview(db, administratorPrincipal, grantPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "ISSUE_TOKEN",
          confirmation: true,
          expectedEffectHash: grantPreview.preview.effectHash,
          reason: { code: "TARGET_GRANT_DOWNGRADE", note: "Target grant was revoked after Preview" }
        }, metadata("target-grant-downgrade-confirm")),
        { denialReason: "TOKEN_TARGET_COMMAND_CEILING_EXCEEDED" }
      );
    } finally {
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }

    const accessPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.operatorSubjectId,
        label: "Target access downgrade",
        accessCeiling: "WRITE",
        commandCeiling: ["REPRICE_ORDER"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("target-access-downgrade-preview"));
    try {
      await db.updateTable("subject_property_grants")
        .set({ access_level: "READ" })
        .where("subject_id", "=", demo.operatorSubjectId)
        .where("property_id", "=", demo.propertyId)
        .execute();
      await expectTokenLifecycleDeniedWithoutWrites(
        () => confirmCommandPreview(db, administratorPrincipal, accessPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "ISSUE_TOKEN",
          confirmation: true,
          expectedEffectHash: accessPreview.preview.effectHash,
          reason: { code: "TARGET_ACCESS_DOWNGRADE", note: "Target access was downgraded after Preview" }
        }, metadata("target-access-downgrade-confirm")),
        { denialReason: "TOKEN_TARGET_ACCESS_CEILING_EXCEEDED" }
      );
    } finally {
      await db.updateTable("subject_property_grants")
        .set({ access_level: "WRITE" })
        .where("subject_id", "=", demo.operatorSubjectId)
        .where("property_id", "=", demo.propertyId)
        .execute();
    }

    const disabledPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.operatorSubjectId,
        label: "Target disabled",
        accessCeiling: "WRITE",
        commandCeiling: ["REPRICE_ORDER"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("target-disabled-preview"));
    try {
      await db.updateTable("subjects")
        .set({ status: "DISABLED" })
        .where("id", "=", demo.operatorSubjectId)
        .execute();
      await expectTokenLifecycleDeniedWithoutWrites(
        () => confirmCommandPreview(db, administratorPrincipal, disabledPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "ISSUE_TOKEN",
          confirmation: true,
          expectedEffectHash: disabledPreview.preview.effectHash,
          reason: { code: "TARGET_DISABLED", note: "Target subject was disabled after Preview" }
        }, metadata("target-disabled-confirm")),
        { code: "SUBJECT_DISABLED", denialReason: "TOKEN_TARGET_SUBJECT_DISABLED" }
      );
    } finally {
      await db.updateTable("subjects")
        .set({ status: "ACTIVE" })
        .where("id", "=", demo.operatorSubjectId)
        .execute();
    }

    const tokenId = newId("token");
    await insertToken({
      id: tokenId,
      subjectId: demo.operatorSubjectId,
      secret: newOpaqueSecret("qtp"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["REPRICE_ORDER"]
    });
    const rotatePreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ROTATE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        tokenId,
        commandCeiling: ["REPRICE_ORDER"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("rotate-target-downgrade-preview"));
    try {
      await revoke(demo.operatorSubjectId, "REPRICE_ORDER");
      await expectTokenLifecycleDeniedWithoutWrites(
        () => confirmCommandPreview(db, administratorPrincipal, rotatePreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "ROTATE_TOKEN",
          confirmation: true,
          expectedEffectHash: rotatePreview.preview.effectHash,
          reason: { code: "ROTATE_TARGET_DOWNGRADE", note: "Rotated Token ceiling must follow current target grants" }
        }, metadata("rotate-target-downgrade-confirm")),
        { denialReason: "TOKEN_TARGET_COMMAND_CEILING_EXCEEDED" }
      );
    } finally {
      await grant(demo.operatorSubjectId, ["REPRICE_ORDER"]);
    }

    for (const [suffix, revokedAt, expiresAt, denialReason] of [
      ["revoked", "2034-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "TOKEN_TARGET_REVOKED"],
      ["expired", null, "2020-01-01T00:00:00.000Z", "TOKEN_TARGET_EXPIRED"]
    ] as const) {
      const targetTokenId = newId("token");
      await insertToken({
        id: targetTokenId,
        subjectId: demo.operatorSubjectId,
        secret: newOpaqueSecret("qtp"),
        expiresAt,
        revokedAt,
        commandCeiling: ["REPRICE_ORDER"]
      });
      await expectTokenLifecycleDeniedWithoutWrites(
        () => createCommandPreview(db, administratorPrincipal, {
          commandType: "ROTATE_TOKEN",
          input: {
            propertyId: demo.propertyId,
            tokenId: targetTokenId,
            commandCeiling: ["REPRICE_ORDER"],
            expiresAt: "2099-01-01T00:00:00.000Z",
            tokenSecret: newOpaqueSecret("qtp")
          }
        }, metadata(`rotate-target-${suffix}-preview`)),
        { denialReason }
      );
    }
  });

  it("allows REVOKE_TOKEN to clean up a downgraded target Token but still denies disabled targets", async () => {
    await grant(demo.operatorSubjectId, ["REVOKE_TOKEN"]);
    const downgradedTokenId = newId("token");
    await insertToken({
      id: downgradedTokenId,
      subjectId: demo.operatorSubjectId,
      secret: newOpaqueSecret("qtp"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["REVOKE_TOKEN"]
    });
    const revokePreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "REVOKE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        tokenId: downgradedTokenId
      }
    }, metadata("revoke-downgraded-token-preview"));
    try {
      await db.updateTable("subject_property_grants")
        .set({ access_level: "READ" })
        .where("subject_id", "=", demo.operatorSubjectId)
        .where("property_id", "=", demo.propertyId)
        .execute();
      const receipt = await confirmCommandPreview(db, administratorPrincipal, revokePreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "REVOKE_TOKEN",
        confirmation: true,
        expectedEffectHash: revokePreview.preview.effectHash,
        reason: { code: "REVOKE_DOWNGRADED_TOKEN", note: "Downgraded target Token cleanup must remain available" }
      }, metadata("revoke-downgraded-token-confirm"));
      expect(receipt).toMatchObject({
        executionStatus: "EXECUTED",
        businessCommitted: true,
        result: { tokenId: downgradedTokenId, revoked: true }
      });
    } finally {
      await db.updateTable("subject_property_grants")
        .set({ access_level: "WRITE" })
        .where("subject_id", "=", demo.operatorSubjectId)
        .where("property_id", "=", demo.propertyId)
        .execute();
    }

    const disabledTokenId = newId("token");
    await insertToken({
      id: disabledTokenId,
      subjectId: demo.operatorSubjectId,
      secret: newOpaqueSecret("qtp"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["REVOKE_TOKEN"]
    });
    const disabledPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "REVOKE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        tokenId: disabledTokenId
      }
    }, metadata("revoke-disabled-target-preview"));
    try {
      await db.updateTable("subjects")
        .set({ status: "DISABLED" })
        .where("id", "=", demo.operatorSubjectId)
        .execute();
      await expectTokenLifecycleDeniedWithoutWrites(
        () => confirmCommandPreview(db, administratorPrincipal, disabledPreview.preview.previewId, {
          propertyId: demo.propertyId,
          commandType: "REVOKE_TOKEN",
          confirmation: true,
          expectedEffectHash: disabledPreview.preview.effectHash,
          reason: { code: "REVOKE_DISABLED_TARGET", note: "Disabled target subject remains an authorization denial" }
        }, metadata("revoke-disabled-target-confirm")),
        { code: "SUBJECT_DISABLED", denialReason: "TOKEN_TARGET_SUBJECT_DISABLED" }
      );
    } finally {
      await db.updateTable("subjects")
        .set({ status: "ACTIVE" })
        .where("id", "=", demo.operatorSubjectId)
        .execute();
    }
  });

  it("authorizes cross-managed Token rotations without reverse-order subject/token deadlocks", async () => {
    const subjectA = "subject_token_lock_order_a";
    const subjectB = "subject_token_lock_order_b";
    const sessionA = newId("session");
    const sessionB = newId("session");
    await db.insertInto("subjects").values([
      {
        id: subjectA,
        username: "token-lock-order-a",
        display_name: "Token Lock Order A",
        password_salt: "token-lock-order-a",
        password_hash: sha256("token-lock-order-a"),
        status: "ACTIVE",
        auth_version: 1
      },
      {
        id: subjectB,
        username: "token-lock-order-b",
        display_name: "Token Lock Order B",
        password_salt: "token-lock-order-b",
        password_hash: sha256("token-lock-order-b"),
        status: "ACTIVE",
        auth_version: 1
      }
    ]).execute();
    await db.insertInto("subject_property_grants").values([
      { subject_id: subjectA, property_id: demo.propertyId, access_level: "WRITE" },
      { subject_id: subjectB, property_id: demo.propertyId, access_level: "WRITE" }
    ]).execute();
    await grant(subjectA, ["ROTATE_TOKEN"]);
    await grant(subjectB, ["ROTATE_TOKEN"]);
    await insertSession(subjectA, sessionA);
    await insertSession(subjectB, sessionB);
    const principalA: AuthPrincipal = {
      subjectId: subjectA,
      credentialId: sessionA,
      credentialType: "SESSION",
      displayName: "Token Lock Order A",
      ...authScope({ credentialType: "SESSION", profile: "administrator" })
    };
    const principalB: AuthPrincipal = {
      subjectId: subjectB,
      credentialId: sessionB,
      credentialType: "SESSION",
      displayName: "Token Lock Order B",
      ...authScope({ credentialType: "SESSION", profile: "administrator" })
    };
    const tokenA = newId("token");
    const tokenB = newId("token");
    await insertToken({
      id: tokenA,
      subjectId: subjectA,
      secret: newOpaqueSecret("qtp"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["ROTATE_TOKEN"]
    });
    await insertToken({
      id: tokenB,
      subjectId: subjectB,
      secret: newOpaqueSecret("qtp"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["ROTATE_TOKEN"]
    });
    const authorizeRotation = (
      principal: AuthPrincipal,
      targetTokenId: string,
      prefix: string
    ) => db.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '3000ms'`.execute(trx);
      await authorizeCommandAccess(db, trx, principal, {
        propertyId: demo.propertyId,
        commandType: "ROTATE_TOKEN",
        stage: "PREVIEW",
        idempotencyKey: prefix,
        correlationId: prefix,
        mode: "EXECUTE",
        tokenLifecycleConstraint: {
          kind: "ROTATE_TOKEN",
          tokenId: targetTokenId,
          commandCeiling: ["ROTATE_TOKEN"],
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      });
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(Promise.all([
        authorizeRotation(principalA, tokenB, `lock-order-a-${attempt}`),
        authorizeRotation(principalB, tokenA, `lock-order-b-${attempt}`)
      ])).resolves.toEqual([undefined, undefined]);
    }
  });

  it("audits known revoked or expired credentials and disabled subjects without inventing an identity for unknown credentials", async () => {
    const revokedTokenSecret = newOpaqueSecret("qtp");
    const expiredTokenSecret = newOpaqueSecret("qtp");
    await insertToken({
      id: "token_known_revoked_audit",
      subjectId: demo.operatorSubjectId,
      secret: revokedTokenSecret,
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: "2026-01-01T00:00:00.000Z",
      commandCeiling: ["LOCK_MAINTENANCE"]
    });
    await insertToken({
      id: "token_known_expired_audit",
      subjectId: demo.operatorSubjectId,
      secret: expiredTokenSecret,
      expiresAt: "2020-01-01T00:00:00.000Z",
      commandCeiling: ["LOCK_MAINTENANCE"]
    });

    const disabledSubjectId = "subject_known_disabled_audit";
    const disabledTokenSecret = newOpaqueSecret("qtp");
    await db.insertInto("subjects").values({
      id: disabledSubjectId,
      username: "known-disabled-audit",
      display_name: "Known disabled audit subject",
      password_salt: "known-disabled-audit",
      password_hash: sha256("known-disabled-audit"),
      status: "DISABLED",
      auth_version: 1
    }).execute();
    await db.insertInto("subject_property_grants").values({
      subject_id: disabledSubjectId,
      property_id: demo.propertyId,
      access_level: "WRITE"
    }).execute();
    await grant(disabledSubjectId, ["LOCK_MAINTENANCE"]);
    await insertToken({
      id: "token_known_disabled_audit",
      subjectId: disabledSubjectId,
      secret: disabledTokenSecret,
      expiresAt: "2099-01-01T00:00:00.000Z",
      commandCeiling: ["LOCK_MAINTENANCE"]
    });

    const revokedSessionSecret = newOpaqueSecret("qts");
    const expiredSessionSecret = newOpaqueSecret("qts");
    await db.insertInto("web_sessions").values([
      {
        id: "session_known_revoked_audit",
        subject_id: demo.operatorSubjectId,
        secret_hash: sha256(revokedSessionSecret),
        expires_at: "2099-01-01T00:00:00.000Z",
        revoked_at: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "session_known_expired_audit",
        subject_id: demo.operatorSubjectId,
        secret_hash: sha256(expiredSessionSecret),
        expires_at: "2020-01-01T00:00:00.000Z",
        revoked_at: null
      }
    ]).execute();

    const apiDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 5 }) })
    });
    const app = await buildServer(apiDb);
    const request = (credential: { bearer?: string; session?: string }, prefix: string) => app.inject({
      method: "POST",
      url: "/api/v1/command-previews",
      headers: {
        ...(credential.bearer ? { authorization: `Bearer ${credential.bearer}` } : {}),
        "idempotency-key": `${prefix}-idempotency`,
        "x-correlation-id": `${prefix}-correlation`
      },
      ...(credential.session ? { cookies: { qintopia_session: credential.session } } : {}),
      payload: {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: "2096-01-01",
          departureDate: "2096-01-02",
          reason: "Authentication denial audit"
        }
      }
    });

    try {
      for (const [credential, prefix, expectedStatus, expectedSubject, denialReason] of [
        [{ bearer: revokedTokenSecret }, "known-revoked-token", 401, demo.operatorSubjectId, "TOKEN_REVOKED"],
        [{ bearer: expiredTokenSecret }, "known-expired-token", 401, demo.operatorSubjectId, "TOKEN_EXPIRED"],
        [{ bearer: disabledTokenSecret }, "known-disabled-subject", 403, disabledSubjectId, "SUBJECT_DISABLED"],
        [{ session: revokedSessionSecret }, "known-revoked-session", 401, demo.operatorSubjectId, "SESSION_REVOKED"],
        [{ session: expiredSessionSecret }, "known-expired-session", 401, demo.operatorSubjectId, "SESSION_EXPIRED"]
      ] as const) {
        const before = await securityAuditCount();
        const response = await request(credential, prefix);
        expect(response.statusCode, response.body).toBe(expectedStatus);
        expect(await securityAuditCount()).toBe(before + 1);
        const latest = await db.selectFrom("security_audit_entries")
          .select([
            "subject_id",
            "command_type",
            "stage",
            "denial_reason",
            "credential_fingerprint",
            "correlation_id",
            "idempotency_key_hash"
          ])
          .orderBy("created_at", "desc")
          .executeTakeFirstOrThrow();
        expect(latest).toEqual({
          subject_id: expectedSubject,
          command_type: "LOCK_MAINTENANCE",
          stage: "PREVIEW",
          denial_reason: denialReason,
          credential_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          correlation_id: `${prefix}-correlation`,
          idempotency_key_hash: sha256(`${prefix}-idempotency`)
        });
        expect(JSON.stringify(latest)).not.toContain(credential.bearer ?? credential.session);
      }

      const unknownBefore = await securityAuditCount();
      const unknown = await request({ bearer: newOpaqueSecret("qtp") }, "unknown-token");
      expect(unknown.statusCode).toBe(401);
      expect(await securityAuditCount()).toBe(unknownBefore);
    } finally {
      await app.close();
    }
  });

  it("allows Token listing with ROTATE or REVOKE exact grants while keeping targets ISSUE-only", async () => {
    await grant(demo.administratorSubjectId, ["ROTATE_TOKEN", "REVOKE_TOKEN"]);
    await db.insertInto("token_command_ceilings").values([
      {
        token_id: "token_demo_admin_write",
        subject_id: demo.administratorSubjectId,
        property_id: demo.propertyId,
        command_type: "ROTATE_TOKEN"
      },
      {
        token_id: "token_demo_admin_write",
        subject_id: demo.administratorSubjectId,
        property_id: demo.propertyId,
        command_type: "REVOKE_TOKEN"
      }
    ]).onConflict((oc) => oc.columns(["token_id", "command_type"]).doNothing()).execute();
    await revoke(demo.administratorSubjectId, "ISSUE_TOKEN");
    const apiDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 5 }) })
    });
    const app = await buildServer(apiDb);
    try {
      const auditBefore = await securityAuditCount();
      const tokens = await app.inject({
        method: "GET",
        url: `/api/v1/tokens?propertyId=${demo.propertyId}`,
        headers: { authorization: `Bearer ${demo.administratorWriteToken}` }
      });
      expect(tokens.statusCode, tokens.body).toBe(200);
      expect(await securityAuditCount()).toBe(auditBefore);

      const targets = await app.inject({
        method: "GET",
        url: `/api/v1/properties/${demo.propertyId}/token-targets`,
        headers: { authorization: `Bearer ${demo.administratorWriteToken}` }
      });
      expect(targets.statusCode, targets.body).toBe(403);
      expect(await securityAuditCount()).toBe(auditBefore + 1);
      const denial = await db.selectFrom("security_audit_entries")
        .select(["command_type", "stage", "denial_reason"])
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      expect(denial).toEqual({
        command_type: "ISSUE_TOKEN",
        stage: "COMMAND",
        denial_reason: "SUBJECT_COMMAND_GRANT_MISSING"
      });
    } finally {
      await app.close();
      await grant(demo.administratorSubjectId, ["ISSUE_TOKEN"]);
    }
  });

  it("routes Quote and Token authorization through uniform 404/403 denials with one audit", async () => {
    const apiDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 5 }) })
    });
    const app = await buildServer(apiDb);
    try {
      const hiddenPropertyId = "property_hidden_from_caller";
      const quoteAuditBefore = await securityAuditCount();
      const quote = await app.inject({
        method: "POST",
        url: "/api/v1/quotes",
        headers: {
          authorization: `Bearer ${demo.writeToken}`,
          "idempotency-key": "hidden-quote-idempotency",
          "x-correlation-id": "hidden-quote-correlation"
        },
        payload: {
          propertyId: hiddenPropertyId,
          inventoryUnitId: demo.secondRoomId,
          stayType: "TRANSIENT",
          arrivalDate: "2095-01-01",
          departureDate: "2095-01-02",
          pricingPolicyVersionId: demo.transientPolicyId
        }
      });
      expect(quote.statusCode, quote.body).toBe(404);
      expect(await securityAuditCount()).toBe(quoteAuditBefore + 1);

      const tokenAuditBefore = await securityAuditCount();
      const tokens = await app.inject({
        method: "GET",
        url: `/api/v1/tokens?propertyId=${demo.propertyId}`,
        headers: { authorization: `Bearer ${demo.writeToken}` }
      });
      expect(tokens.statusCode, tokens.body).toBe(403);
      expect(await securityAuditCount()).toBe(tokenAuditBefore + 1);

      const hiddenTokenAuditBefore = await securityAuditCount();
      const hiddenTokens = await app.inject({
        method: "GET",
        url: `/api/v1/tokens?propertyId=${hiddenPropertyId}`,
        headers: { authorization: `Bearer ${demo.writeToken}` }
      });
      expect(hiddenTokens.statusCode, hiddenTokens.body).toBe(404);
      expect(await securityAuditCount()).toBe(hiddenTokenAuditBefore + 1);
    } finally {
      await app.close();
    }
  });
});
