import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandCapability, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  createDatabase,
  databaseReady,
  executeQuoteCommand,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { newOpaqueSecret, ordinaryStaffCommandGrants, sha256 } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { demo, seedDemo } from "../../packages/db/src/seed.ts";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.RUNTIME_DATABASE_ROLE_ADMIN_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
const databaseName = `qintopia_runtime_database_role_${process.pid}`;
const dangerousRoleName = `qintopia_runtime_inherited_${process.pid}`;
const runtimePassword = `runtime-role-test-${process.pid}`;
const ownerUrl = new URL(adminUrl);
ownerUrl.pathname = `/${databaseName}`;
const runtimeUrl = new URL(ownerUrl);
runtimeUrl.username = "qintopia_runtime";
runtimeUrl.password = runtimePassword;

const runtimeCommandGrants = [...ordinaryStaffCommandGrants] as const satisfies readonly CommandCapability[];
const tokenManagementCommands = ["ISSUE_TOKEN", "ROTATE_TOKEN", "REVOKE_TOKEN"] as const satisfies readonly CommandCapability[];
const administratorRuntimeCommands = [
  ...runtimeCommandGrants,
  ...tokenManagementCommands,
  "CORRECT_ORDER_OCCUPANT",
  "CORRECT_HISTORICAL_STAY_ARRANGEMENTS"
] as const satisfies readonly CommandCapability[];
const noTokenCommandCeiling = [] as const satisfies readonly CommandCapability[];
const demoRuntimeReadinessOptions = { staffProfileManifestName: "demo" } as const;

function principal(options: {
  credentialId: string;
  accessLevel: "READ" | "WRITE";
  propertyCommandGrants: readonly CommandCapability[];
  tokenCommandCeiling: readonly CommandCapability[];
}): AuthPrincipal {
  const grants = new Set(options.propertyCommandGrants);
  return {
    subjectId: demo.agentSubjectId,
    credentialId: options.credentialId,
    credentialType: "TOKEN",
    displayName: "Demo Agent",
    propertyAccess: new Map([[demo.propertyId, options.accessLevel]]),
    propertyCommandGrants: new Map([[demo.propertyId, grants]]),
    tokenCommandCeiling: new Set(options.tokenCommandCeiling)
  };
}

const readPrincipal = principal({
  credentialId: "token_demo_read",
  accessLevel: "READ",
  propertyCommandGrants: noTokenCommandCeiling,
  tokenCommandCeiling: noTokenCommandCeiling
});

const writePrincipal = principal({
  credentialId: "token_demo_write",
  accessLevel: "WRITE",
  propertyCommandGrants: runtimeCommandGrants,
  tokenCommandCeiling: runtimeCommandGrants
});

const administratorPrincipal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Demo Administrator",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]]),
  propertyCommandGrants: new Map([[demo.propertyId, new Set(administratorRuntimeCommands)]]),
  tokenCommandCeiling: new Set(administratorRuntimeCommands)
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function shiftLocalDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function executeRuntime(
  envelope: CommandEnvelope,
  prefix: string,
  actor: AuthPrincipal = writePrincipal
): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, actor, envelope, metadata(`${prefix}-preview`));
  const receipt = await confirmCommandPreview(db, actor, prepared.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : envelope.commandType === "COMPLETE_STAY"
        ? { code: "COMPLETE_STAY", note: String(envelope.input.reasonNote ?? "") }
        : { code: "RUNTIME_DATABASE_GUARD", note: `Runtime role ${envelope.commandType} journey` }
  }, metadata(`${prefix}-confirm`));
  expect(receipt, JSON.stringify(receipt.error)).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  return receipt;
}

async function withClient<T>(connectionString: string, callback: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(): Promise<void> {
  await withClient(adminUrl, async (admin) => {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
  });
}

async function recreateDatabase(): Promise<void> {
  await dropDatabase();
  await withClient(adminUrl, async (admin) => {
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qintopia_runtime') THEN
          CREATE ROLE qintopia_runtime LOGIN;
        END IF;
      END
      $$
    `);
    await admin.query(`DROP ROLE IF EXISTS "${dangerousRoleName}"`);
    await admin.query(`CREATE ROLE "${dangerousRoleName}" NOLOGIN`);
    await admin.query(`GRANT "${dangerousRoleName}" TO qintopia_runtime`);
  });
}

async function runMigrations(): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "packages/db/src/migrate.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: runtimeUrl.toString(),
        MIGRATION_DATABASE_URL: ownerUrl.toString(),
        RUNTIME_DATABASE_PASSWORD: runtimePassword
      }
    }
  );
}

async function installCommandAuthorizationFixtures(ownerDb: Kysely<Database>): Promise<void> {
  for (const commandType of runtimeCommandGrants) {
    await sql`
      INSERT INTO subject_command_grants (subject_id, property_id, command_type)
      VALUES (${demo.agentSubjectId}, ${demo.propertyId}, ${commandType})
      ON CONFLICT DO NOTHING
    `.execute(ownerDb);
    await sql`
      INSERT INTO token_command_ceilings (token_id, subject_id, property_id, command_type)
      VALUES (${"token_demo_write"}, ${demo.agentSubjectId}, ${demo.propertyId}, ${commandType})
      ON CONFLICT DO NOTHING
    `.execute(ownerDb);
  }
}

async function expectRuntimeQueryToFail(statement: string, pattern = /permission denied|must be owner|must have CREATEROLE|not owner|may lock authorization rows/i) {
  await expect(withClient(runtimeUrl.toString(), (client) => client.query(statement))).rejects.toThrow(pattern);
}

async function expectRuntimeTransactionToFail(
  statements: readonly string[],
  pattern = /same-transaction typed command evidence|runtime .* requires|runtime .* must/i
) {
  await expect(withClient(runtimeUrl.toString(), async (client) => {
    await client.query("BEGIN");
    try {
      for (const statement of statements) await client.query(statement);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  })).rejects.toThrow(pattern);
}

interface TokenGuardProbe {
  tokenId: string;
  commandId: string;
  receiptId: string;
  auditId: string;
}

function tokenGuardProbe(label: string): TokenGuardProbe {
  sequence += 1;
  const suffix = `${label.replaceAll(/[^a-z0-9]+/gi, "_")}_${process.pid}_${sequence}`;
  return {
    tokenId: `token_guard_${suffix}`,
    commandId: `command_guard_${suffix}`,
    receiptId: `receipt_guard_${suffix}`,
    auditId: `audit_guard_${suffix}`
  };
}

async function insertIssueTokenEvidence(
  client: pg.Client,
  probe: TokenGuardProbe,
  options: {
    commandType?: string;
    executionSubjectId?: string;
    executionCredentialId?: string;
    executionPropertyId?: string;
    receiptTokenId?: string;
    receiptSubjectId?: string;
    receiptAccessCeiling?: string;
    receiptExpiresAt?: string;
    receiptRotatedFromTokenId?: string;
    receiptCommandCeiling?: readonly string[];
    receiptPersistedCommandCeiling?: readonly string[];
    receiptPreviousCommandCeiling?: readonly string[];
    receiptPreviousPersistedCommandCeiling?: readonly string[];
    receiptPreviousExpiresAt?: string;
    receiptHistoricalReadCeilingPreserved?: boolean;
    auditAction?: string;
    auditCredentialId?: string;
    omitExecution?: boolean;
    omitReceipt?: boolean;
    omitAudit?: boolean;
  } = {}
): Promise<void> {
  const commandType = options.commandType ?? "ISSUE_TOKEN";
  if (!options.omitExecution) {
    await client.query(`
      INSERT INTO command_executions (
        id, subject_id, credential_id, property_id, command_type,
        idempotency_key, request_hash, correlation_id, state, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $1, repeat('a', 64), $1, 'APPLIED', now())
    `, [
      probe.commandId,
      options.executionSubjectId ?? demo.administratorSubjectId,
      options.executionCredentialId ?? "token_demo_admin_write",
      options.executionPropertyId ?? demo.propertyId,
      commandType
    ]);
  }
  if (!options.omitReceipt && !options.omitExecution) {
    const commandCeiling = options.receiptCommandCeiling ?? ["REPRICE_ORDER"];
    const result = {
      tokenId: options.receiptTokenId ?? probe.tokenId,
      subjectId: options.receiptSubjectId ?? demo.administratorSubjectId,
      subjectDisplayName: "Demo Administrator",
      label: probe.tokenId,
      accessCeiling: options.receiptAccessCeiling ?? "WRITE",
      expiresAt: options.receiptExpiresAt ?? "2029-01-01T00:00:00.000Z",
      commandCeiling,
      persistedCommandCeiling: options.receiptPersistedCommandCeiling ?? commandCeiling,
      ...(options.receiptRotatedFromTokenId
        ? {
            rotatedFromTokenId: options.receiptRotatedFromTokenId,
            previousCommandCeiling: options.receiptPreviousCommandCeiling ?? commandCeiling,
            previousPersistedCommandCeiling: options.receiptPreviousPersistedCommandCeiling ?? commandCeiling,
            previousExpiresAt: options.receiptPreviousExpiresAt ?? "2030-01-01T00:00:00.000Z",
            historicalReadCeilingPreserved: options.receiptHistoricalReadCeilingPreserved ?? false
          }
        : {})
    };
    await client.query(`
      INSERT INTO command_receipts (
        id, command_id, execution_status, business_committed,
        result, error, resource_refs, fact_refs, committed_at
      ) VALUES ($1, $2, 'EXECUTED', true, $3::jsonb, NULL, $4::jsonb, '[]'::jsonb, now())
    `, [
      probe.receiptId,
      probe.commandId,
      JSON.stringify(result),
      JSON.stringify([probe.tokenId, demo.administratorSubjectId])
    ]);
  }
  if (!options.omitAudit && !options.omitExecution) {
    await client.query(`
      INSERT INTO audit_entries (
        id, subject_id, credential_id, action, decision, command_id,
        correlation_id, reason, target_refs, metadata
      ) VALUES ($1, $2, $3, $4, 'ALLOWED', $5, $5, NULL, $6::jsonb, '{}'::jsonb)
    `, [
      probe.auditId,
      options.executionSubjectId ?? demo.administratorSubjectId,
      options.auditCredentialId ?? options.executionCredentialId ?? "token_demo_admin_write",
      options.auditAction ?? commandType,
      probe.commandId,
      JSON.stringify([probe.tokenId])
    ]);
  }
}

async function insertProbedToken(
  client: pg.Client,
  probe: TokenGuardProbe,
  commandCeiling: readonly string[] = ["REPRICE_ORDER"],
  expiresAt = "2029-01-01T00:00:00.000Z"
): Promise<void> {
  await client.query(`
    INSERT INTO api_tokens (
      id, subject_id, label, secret_hash, access_ceiling, property_scope,
      expires_at, revoked_at, rotated_from_id, replaced_by_id
    ) VALUES ($1, $2, $1, $3, 'WRITE', $4, $5, NULL, NULL, NULL)
  `, [probe.tokenId, demo.administratorSubjectId, sha256(newOpaqueSecret("qtp")), demo.propertyId, expiresAt]);
  for (const commandType of commandCeiling) {
    await client.query(`
      INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
      VALUES ($1, $2, $3, $4)
    `, [probe.tokenId, demo.administratorSubjectId, demo.propertyId, commandType]);
  }
}

async function insertProbedRotatedToken(
  client: pg.Client,
  probe: TokenGuardProbe,
  sourceTokenId: string,
  commandCeiling: readonly string[] = ["REPRICE_ORDER"]
): Promise<void> {
  await client.query(`
    INSERT INTO api_tokens (
      id, subject_id, label, secret_hash, access_ceiling, property_scope,
      expires_at, revoked_at, rotated_from_id, replaced_by_id
    ) VALUES ($1, $2, $1, $3, 'WRITE', $4, '2029-01-01T00:00:00.000Z', NULL, $5, NULL)
  `, [probe.tokenId, demo.administratorSubjectId, sha256(newOpaqueSecret("qtp")), demo.propertyId, sourceTokenId]);
  for (const commandType of commandCeiling) {
    await client.query(`
      INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
      VALUES ($1, $2, $3, $4)
    `, [probe.tokenId, demo.administratorSubjectId, demo.propertyId, commandType]);
  }
  await client.query(`
    UPDATE api_tokens
    SET revoked_at = now(), replaced_by_id = $1
    WHERE id = $2
  `, [probe.tokenId, sourceTokenId]);
}

async function expectTokenGuardProbeToRollback(
  label: string,
  attack: (client: pg.Client, probe: TokenGuardProbe) => Promise<void>,
  probe = tokenGuardProbe(label),
  expectedProtocolResidue = 0
): Promise<TokenGuardProbe> {
  await expect(withClient(runtimeUrl.toString(), async (client) => {
    await client.query("BEGIN");
    try {
      await attack(client, probe);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  }), label).rejects.toThrow(/runtime Token mutations require same-transaction typed command evidence/i);

  const residue = await sql<{
    token_count: number;
    ceiling_count: number;
    execution_count: number;
    receipt_count: number;
    audit_count: number;
  }>`
    SELECT
      (SELECT count(*)::integer FROM api_tokens WHERE id = ${probe.tokenId}) AS token_count,
      (SELECT count(*)::integer FROM token_command_ceilings WHERE token_id = ${probe.tokenId}) AS ceiling_count,
      (SELECT count(*)::integer FROM command_executions WHERE id = ${probe.commandId}) AS execution_count,
      (SELECT count(*)::integer FROM command_receipts WHERE id = ${probe.receiptId}) AS receipt_count,
      (SELECT count(*)::integer FROM audit_entries WHERE id = ${probe.auditId}) AS audit_count
  `.execute(db);
  expect(residue.rows[0], `${label} residue`).toEqual({
    token_count: 0,
    ceiling_count: 0,
    execution_count: expectedProtocolResidue,
    receipt_count: expectedProtocolResidue,
    audit_count: expectedProtocolResidue
  });
  return probe;
}

beforeAll(async () => {
  await recreateDatabase();
  await runMigrations();
  const ownerDb = createDatabase(ownerUrl.toString());
  try {
    await seedDemo(ownerDb, { includeProtocolFixturePolicy: true });
    await installCommandAuthorizationFixtures(ownerDb);
  } finally {
    await ownerDb.destroy();
  }
  db = createDatabase(runtimeUrl.toString());
});

afterAll(async () => {
  if (db) await db.destroy();
  await dropDatabase();
  await withClient(adminUrl, async (admin) => {
    await admin.query(`REVOKE "${dangerousRoleName}" FROM qintopia_runtime`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${dangerousRoleName}"`);
  });
});

describe.sequential("API runtime database role", () => {
  it("logs in separately from the migration owner with non-DDL role attributes", async () => {
    await withClient(runtimeUrl.toString(), async (client) => {
      const identity = await client.query<{
        current_user: string;
        session_user: string;
        migration_count: string;
      }>(`
        SELECT
          current_user,
          session_user,
          (SELECT count(*)::text FROM schema_migrations WHERE name = '047_runtime_database_role.sql') AS migration_count
      `);
      expect(identity.rows[0]).toEqual({
        current_user: "qintopia_runtime",
        session_user: "qintopia_runtime",
        migration_count: "1"
      });

      const role = await client.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolcanlogin: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(`
        SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin, rolreplication, rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user
      `);
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolcanlogin: true,
        rolreplication: false,
        rolbypassrls: false
      });

      const dangerousMembership = await client.query<{ inherited: boolean }>(`
        SELECT pg_has_role(current_user, $1, 'MEMBER') AS inherited
      `, [dangerousRoleName]);
      expect(dangerousMembership.rows[0]?.inherited).toBe(false);
    });

    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("keeps ISSUE, self-ROTATE, and self-REVOKE Token lifecycle mutations protocol-bound and readiness-safe", async () => {
    const issuePreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.administratorSubjectId,
        label: "Runtime guard self-managed administrator",
        accessCeiling: "WRITE",
        commandCeiling: tokenManagementCommands,
        expiresAt: "2029-12-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("runtime-token-issue-preview"));
    const issued = await confirmCommandPreview(db, administratorPrincipal, issuePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "ISSUE_TOKEN",
      confirmation: true,
      expectedEffectHash: issuePreview.preview.effectHash,
      reason: { code: "RUNTIME_TOKEN_GUARD", note: "Issue must carry complete same-transaction evidence" }
    }, metadata("runtime-token-issue-confirm"));
    const issuedTokenId = issued.result?.tokenId;
    expect(typeof issuedTokenId).toBe("string");
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);

    const issuedPrincipal: AuthPrincipal = {
      ...administratorPrincipal,
      credentialId: issuedTokenId as string,
      tokenCommandCeiling: new Set(tokenManagementCommands)
    };
    const rotatePreview = await createCommandPreview(db, issuedPrincipal, {
      commandType: "ROTATE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        tokenId: issuedTokenId,
        commandCeiling: tokenManagementCommands,
        expiresAt: "2029-06-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata("runtime-token-self-rotate-preview"));
    const rotated = await confirmCommandPreview(db, issuedPrincipal, rotatePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "ROTATE_TOKEN",
      confirmation: true,
      expectedEffectHash: rotatePreview.preview.effectHash,
      reason: { code: "RUNTIME_TOKEN_GUARD", note: "Self-rotation keeps the old credential valid for this transaction" }
    }, metadata("runtime-token-self-rotate-confirm"));
    const rotatedTokenId = rotated.result?.tokenId;
    expect(typeof rotatedTokenId).toBe("string");
    expect(rotated.result).toMatchObject({ rotatedFromTokenId: issuedTokenId });
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);

    const rotatedPrincipal: AuthPrincipal = {
      ...administratorPrincipal,
      credentialId: rotatedTokenId as string,
      tokenCommandCeiling: new Set(tokenManagementCommands)
    };
    const revokePreview = await createCommandPreview(db, rotatedPrincipal, {
      commandType: "REVOKE_TOKEN",
      input: { propertyId: demo.propertyId, tokenId: rotatedTokenId }
    }, metadata("runtime-token-self-revoke-preview"));
    const revoked = await confirmCommandPreview(db, rotatedPrincipal, revokePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "REVOKE_TOKEN",
      confirmation: true,
      expectedEffectHash: revokePreview.preview.effectHash,
      reason: { code: "RUNTIME_TOKEN_GUARD", note: "Self-revocation keeps the old credential valid for this transaction" }
    }, metadata("runtime-token-self-revoke-confirm"));
    expect(revoked.result).toMatchObject({ tokenId: rotatedTokenId, revoked: true });
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("rejects typed runtime rotation evidence that preserves a disabled original capability", async () => {
    const preservedCommand = "COMPLETE_CLEANING";
    await withClient(ownerUrl.toString(), (owner) => owner.query(`
      INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
      VALUES ('token_demo_admin_write', $1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [demo.administratorSubjectId, demo.propertyId, preservedCommand]));
    const sourceBefore = await db.selectFrom("api_tokens")
      .select(["revoked_at", "replaced_by_id", "expires_at"])
      .where("id", "=", "token_demo_admin_write")
      .executeTakeFirstOrThrow();
    const sourceCeiling = await db.selectFrom("token_command_ceilings")
      .select("command_type")
      .where("token_id", "=", "token_demo_admin_write")
      .orderBy("command_type")
      .execute();
    const probe = tokenGuardProbe("preserved-disabled-history");
    const persistedCommandCeiling = ["ROTATE_TOKEN", preservedCommand].sort();

    try {
      await expect(withClient(runtimeUrl.toString(), async (client) => {
        await client.query("BEGIN");
        try {
          await insertProbedRotatedToken(client, probe, "token_demo_admin_write", persistedCommandCeiling);
          await insertIssueTokenEvidence(client, probe, {
            commandType: "ROTATE_TOKEN",
            receiptRotatedFromTokenId: "token_demo_admin_write",
            receiptCommandCeiling: ["ROTATE_TOKEN"],
            receiptPersistedCommandCeiling: persistedCommandCeiling,
            receiptPreviousCommandCeiling: sourceCeiling
              .map((row) => row.command_type)
              .filter((commandType) => commandType !== preservedCommand),
            receiptPreviousPersistedCommandCeiling: sourceCeiling.map((row) => row.command_type),
            receiptPreviousExpiresAt: new Date(sourceBefore.expires_at).toISOString(),
            receiptHistoricalReadCeilingPreserved: true
          });
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
        }
      })).rejects.toThrow(/runtime Token mutations require same-transaction typed command evidence/i);

      const residue = await sql<{ token_count: number; ceiling_count: number; execution_count: number }>`
        SELECT
          (SELECT count(*)::integer FROM api_tokens WHERE id = ${probe.tokenId}) AS token_count,
          (SELECT count(*)::integer FROM token_command_ceilings WHERE token_id = ${probe.tokenId}) AS ceiling_count,
          (SELECT count(*)::integer FROM command_executions WHERE id = ${probe.commandId}) AS execution_count
      `.execute(db);
      expect(residue.rows[0]).toEqual({ token_count: 0, ceiling_count: 0, execution_count: 0 });
      await expect(db.selectFrom("api_tokens")
        .select(["revoked_at", "replaced_by_id", "expires_at"])
        .where("id", "=", "token_demo_admin_write")
        .executeTakeFirstOrThrow()).resolves.toEqual(sourceBefore);
    } finally {
      await withClient(ownerUrl.toString(), (owner) => owner.query(`
        DELETE FROM token_command_ceilings
        WHERE token_id = 'token_demo_admin_write'
          AND command_type = $1
      `, [preservedCommand]));
    }
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("rejects a migration-owner session that only SET ROLEs to qintopia_runtime", async () => {
    const disguisedOwnerUrl = new URL(ownerUrl);
    disguisedOwnerUrl.searchParams.set("options", "-c role=qintopia_runtime");
    const disguisedOwnerDb = createDatabase(disguisedOwnerUrl.toString());
    try {
      await expect(databaseReady(disguisedOwnerDb, demoRuntimeReadinessOptions)).resolves.toBe(false);
    } finally {
      await disguisedOwnerDb.destroy();
    }
  });

  it("fails readiness when qintopia_runtime owns a database object", async () => {
    await withClient(ownerUrl.toString(), async (owner) => {
      await owner.query("CREATE TABLE runtime_owned_readiness_probe(id text)");
      await owner.query("ALTER TABLE runtime_owned_readiness_probe OWNER TO qintopia_runtime");
    });
    try {
      await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(false);
    } finally {
      await withClient(ownerUrl.toString(), (owner) => owner.query("DROP TABLE runtime_owned_readiness_probe"));
    }
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("allows representative API command DML through the runtime role", async () => {
    const membershipPreview = await createCommandPreview(db, writePrincipal, {
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId: demo.memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, metadata("runtime-create-membership-order-preview"));
    const membershipReceipt = await confirmCommandPreview(db, writePrincipal, membershipPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_MEMBERSHIP_ORDER",
      confirmation: true,
      expectedEffectHash: membershipPreview.preview.effectHash,
      reason: { code: "CREATE_MEMBERSHIP_ORDER", note: "Runtime role existing membership-order flow" }
    }, metadata("runtime-create-membership-order-confirm"));
    expect(membershipReceipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: { membershipOrderId: expect.stringMatching(/^membership_order_/) }
    });

    const quoted = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-11-01",
      departureDate: "2028-11-02",
      pricingPolicyVersionId: demo.transientPolicyId
    }, metadata("runtime-quote"));

    const preview = await createCommandPreview(db, writePrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quoted.quote.quoteId,
        primaryGuest: { fullName: "Runtime Role Guest", nickname: "Runtime Role" },
        additionalGuests: [{ fullName: "Runtime Additional Guest", nickname: "Runtime Additional" }],
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quoted.quote.currentContractAmount.minorUnits
      }
    }, metadata("runtime-create-order-preview"));
    const receipt = await confirmCommandPreview(db, writePrincipal, preview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata("runtime-create-order-confirm"));

    expect(receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: { orderId: expect.stringMatching(/^order_/) }
    });

    const orderId = receipt.result!.orderId as string;
    const repriced = await createCommandPreview(db, writePrincipal, {
      commandType: "REPRICE_ORDER",
      input: {
        propertyId: demo.propertyId,
        orderId,
        targetCurrentContractAmountMinor: quoted.quote.currentContractAmount.minorUnits + 100
      }
    }, metadata("runtime-reprice-preview"));
    const repriceReceipt = await confirmCommandPreview(db, writePrincipal, repriced.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "REPRICE_ORDER",
      confirmation: true,
      expectedEffectHash: repriced.preview.effectHash,
      reason: { code: "RUNTIME_DATABASE_GUARD", note: "Positive typed order projection guard coverage" }
    }, metadata("runtime-reprice-confirm"));
    expect(repriceReceipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    await expect(db.selectFrom("orders")
      .select(["version", "current_revision_id"])
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow()).resolves.toMatchObject({
      version: 2,
      current_revision_id: expect.stringMatching(/^revision_/)
    });

    const additionalOccupantId = (receipt.result!.occupants as Array<{ id: string }>)[1]!.id;
    const correctionPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        occupantId: additionalOccupantId,
        expectedPriorSnapshot: {
          fullName: "Runtime Additional Guest",
          nickname: "Runtime Additional",
          phone: null,
          documentNumber: null
        },
        correctedSnapshot: {
          fullName: "Runtime Additional Guest",
          nickname: "Runtime Corrected",
          phone: null,
          documentNumber: null
        }
      }
    }, metadata("runtime-correct-occupant-preview"));
    const correctionReceipt = await confirmCommandPreview(db, administratorPrincipal, correctionPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CORRECT_ORDER_OCCUPANT",
      confirmation: true,
      expectedEffectHash: correctionPreview.preview.effectHash,
      reason: { code: "DATA_ENTRY_CORRECTION", note: "Runtime role row-lock coverage" }
    }, metadata("runtime-correct-occupant-confirm"));
    expect(correctionReceipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      result: {
        orderId,
        occupantId: additionalOccupantId,
        occupant: { nickname: "Runtime Corrected" }
      }
    });

    const movePreview = await createCommandPreview(db, writePrincipal, {
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: demo.roomId,
        effectiveDate: "2028-11-01"
      }
    }, metadata("runtime-move-unit-preview"));
    await expect(confirmCommandPreview(db, writePrincipal, movePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "MOVE_UNIT",
      confirmation: true,
      expectedEffectHash: movePreview.preview.effectHash,
      reason: { code: "RUNTIME_DATABASE_GUARD", note: "Runtime role target inventory lock coverage" }
    }, metadata("runtime-move-unit-confirm"))).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });

    const bedQuote = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedAId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-11-03",
      departureDate: "2028-11-04",
      pricingPolicyVersionId: demo.transientPolicyId
    }, metadata("runtime-bed-quote"));
    const bedPreview = await createCommandPreview(db, writePrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: bedQuote.quote.quoteId,
        primaryGuest: { fullName: "Runtime Bed Guest", nickname: "Runtime Bed" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: bedQuote.quote.currentContractAmount.minorUnits
      }
    }, metadata("runtime-bed-order-preview"));
    await expect(confirmCommandPreview(db, writePrincipal, bedPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: bedPreview.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata("runtime-bed-order-confirm"))).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });

    const memberQuote = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-11-05",
      departureDate: "2028-11-06",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberContractId: demo.memberContractId
    }, metadata("runtime-member-quote"));
    const memberPreview = await createCommandPreview(db, writePrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: memberQuote.quote.quoteId,
        primaryGuest: { fullName: "Runtime Member Guest", nickname: "Runtime Member" }
      }
    }, metadata("runtime-member-order-preview"));
    await expect(confirmCommandPreview(db, writePrincipal, memberPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: memberPreview.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, metadata("runtime-member-order-confirm"))).resolves.toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });

    const maintenancePreview = await createCommandPreview(db, writePrincipal, {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: "2028-11-10",
        departureDate: "2028-11-11",
        reason: "Runtime typed maintenance fixture"
      }
    }, metadata("runtime-maintenance-preview"));
    const maintenanceReceipt = await confirmCommandPreview(db, writePrincipal, maintenancePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "LOCK_MAINTENANCE",
      confirmation: true,
      expectedEffectHash: maintenancePreview.preview.effectHash,
      reason: { code: "RUNTIME_DATABASE_GUARD", note: "Positive typed maintenance guard coverage" }
    }, metadata("runtime-maintenance-confirm"));
    expect(maintenanceReceipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
  });

  it("keeps ordinary member and lodging money/lifecycle journeys executable through the runtime role", async () => {
    const memberReceipt = await executeRuntime({
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "Runtime Member Lifecycle",
        nickname: "Runtime Member",
        identityCardNumber: "RUNTIME-MEMBER-LIFECYCLE",
        phone: "13900009701",
        wechat: "runtime-member-lifecycle"
      }
    }, "runtime-member-lifecycle-create");
    const memberId = memberReceipt.result!.memberId as string;
    const membershipOrder = await executeRuntime({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId: demo.propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        agreedPriceMinor: 93_600
      }
    }, "runtime-member-lifecycle-order");
    const membershipOrderId = membershipOrder.result!.membershipOrderId as string;
    const payment = await executeRuntime({
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId,
        amountMinor: 93_000,
        transactionReference: "WX-RUNTIME-MEMBER-ORIGINAL"
      }
    }, "runtime-member-lifecycle-payment");
    await executeRuntime({
      commandType: "CORRECT_MEMBERSHIP_PAYMENT",
      input: {
        propertyId: demo.propertyId,
        membershipOrderId,
        originalPaymentFactId: payment.result!.paymentFactId as string,
        correctedAmountMinor: 93_600,
        correctedTransactionReference: "WX-RUNTIME-MEMBER-CORRECTED",
        note: "受限运行账号会员收款更正回归"
      }
    }, "runtime-member-lifecycle-correct-payment");
    await executeRuntime({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId: demo.propertyId, membershipOrderId }
    }, "runtime-member-lifecycle-activate");
    await expect(db.selectFrom("membership_orders")
      .select(["status", "contract_id"])
      .where("id", "=", membershipOrderId)
      .executeTakeFirstOrThrow()).resolves.toMatchObject({
      status: "ACTIVE",
      contract_id: expect.stringMatching(/^contract_/)
    });

    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const memberArrivalDate = shiftLocalDate(businessDate, 10);
    const memberDepartureDate = shiftLocalDate(memberArrivalDate, 1);
    const memberQuote = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedBId,
      stayType: "TRANSIENT",
      arrivalDate: memberArrivalDate,
      departureDate: memberDepartureDate,
      pricingPolicyVersionId: demo.transientPolicyId,
      memberId
    }, metadata("runtime-member-id-quote"));
    await executeRuntime({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: memberQuote.quote.quoteId,
        primaryGuest: { fullName: "Runtime Member Lifecycle", nickname: "Runtime Member" }
      }
    }, "runtime-member-id-order");

    const departureDate = shiftLocalDate(businessDate, 1);
    const lodgingQuote = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_a01",
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate,
      pricingPolicyVersionId: demo.transientPolicyId
    }, metadata("runtime-lodging-lifecycle-quote"));
    const lodging = await executeRuntime({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: lodgingQuote.quote.quoteId,
        primaryGuest: { fullName: "Runtime Lodging Lifecycle", nickname: "Runtime Lodging" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: lodgingQuote.quote.currentContractAmount.minorUnits
      }
    }, "runtime-lodging-lifecycle-order");
    const orderId = lodging.result!.orderId as string;
    const firstCollection = await executeRuntime({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 100,
        method: "BANK_TRANSFER",
        transactionReference: "RUNTIME-LODGING-FIRST",
        note: "入住前首笔收款"
      }
    }, "runtime-lodging-first-collection");
    await executeRuntime({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, "runtime-lodging-check-in");
    await executeRuntime({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: lodgingQuote.quote.currentContractAmount.minorUnits - 100,
        method: "BANK_TRANSFER",
        transactionReference: "RUNTIME-LODGING-BALANCE",
        note: "入住后补足收款"
      }
    }, "runtime-lodging-balance-collection");
    const refund = await executeRuntime({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 50,
        referencesFactId: firstCollection.factRefs[0]!,
        method: "BANK_TRANSFER",
        transactionReference: "RUNTIME-LODGING-REFUND",
        note: "受限运行账号退款回归"
      }
    }, "runtime-lodging-refund");
    await executeRuntime({
      commandType: "REVERSE_FACT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        reversesFactId: refund.factRefs[0]!,
        note: "撤销误录退款"
      }
    }, "runtime-lodging-reverse-refund");
    await withPropertyClockForTesting(new Date(`${departureDate}T04:00:00.000Z`), () => executeRuntime({
      commandType: "CHECK_OUT",
      input: { propertyId: demo.propertyId, orderId }
    }, "runtime-lodging-check-out"));
    await expect(db.selectFrom("orders as order")
      .innerJoin("stays as stay", "stay.order_id", "order.id")
      .select(["order.status as orderStatus", "stay.status as stayStatus"])
      .where("order.id", "=", orderId)
      .executeTakeFirstOrThrow()).resolves.toEqual({
      orderStatus: "CHECKED_OUT",
      stayStatus: "COMPLETED"
    });

    const maintenanceArrivalDate = shiftLocalDate(businessDate, 20);
    const maintenanceDepartureDate = shiftLocalDate(maintenanceArrivalDate, 1);
    const maintenance = await executeRuntime({
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: "unit_room_a02",
        arrivalDate: maintenanceArrivalDate,
        departureDate: maintenanceDepartureDate,
        reason: "受限运行账号维修释放回归"
      }
    }, "runtime-maintenance-release-lock");
    await executeRuntime({
      commandType: "RELEASE_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        maintenanceLockId: maintenance.result!.maintenanceLockId as string
      }
    }, "runtime-maintenance-release");
  });

  it("keeps every supported Stay terminal transition executable through the runtime role", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const createRuntimeStay = async (
      prefix: string,
      arrivalDate: string,
      departureDate: string
    ): Promise<string> => {
      const quoted = await executeQuoteCommand(db, readPrincipal, {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        stayType: "TRANSIENT",
        arrivalDate,
        departureDate,
        pricingPolicyVersionId: demo.transientPolicyId
      }, metadata(`${prefix}-quote`));
      const created = await executeRuntime({
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: quoted.quote.quoteId,
          primaryGuest: { fullName: `Runtime ${prefix}`, nickname: prefix },
          bookingChannelCode: "WECOM",
          channelOrderReference: null,
          targetCurrentContractAmountMinor: quoted.quote.currentContractAmount.minorUnits
        }
      }, `${prefix}-create`);
      return created.result!.orderId as string;
    };

    const cancellationArrival = shiftLocalDate(businessDate, 30);
    const cancellationOrderId = await createRuntimeStay(
      "stay-cancel",
      cancellationArrival,
      shiftLocalDate(cancellationArrival, 1)
    );
    await executeRuntime({
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: cancellationOrderId }
    }, "runtime-stay-cancel");

    const noShowArrival = shiftLocalDate(businessDate, -1);
    const noShowOrderId = await withPropertyClockForTesting(
      new Date(`${noShowArrival}T04:00:00.000Z`),
      () => createRuntimeStay("stay-no-show", noShowArrival, shiftLocalDate(businessDate, 1))
    );
    await executeRuntime({
      commandType: "MARK_NO_SHOW",
      input: { propertyId: demo.propertyId, orderId: noShowOrderId }
    }, "runtime-stay-no-show");

    const revokeArrival = businessDate;
    const revokeOrderId = await createRuntimeStay(
      "stay-revoke-check-in",
      revokeArrival,
      shiftLocalDate(revokeArrival, 2)
    );
    await executeRuntime({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: revokeOrderId }
    }, "runtime-stay-revoke-check-in-start");
    await executeRuntime({
      commandType: "REVOKE_CHECK_IN",
      input: {
        propertyId: demo.propertyId,
        orderId: revokeOrderId,
        unusedRoomConfirmed: true
      }
    }, "runtime-stay-revoke-check-in");

    const shortenArrival = shiftLocalDate(businessDate, -1);
    const shortenOrderId = await withPropertyClockForTesting(
      new Date(`${shortenArrival}T04:00:00.000Z`),
      () => createRuntimeStay("stay-shorten-complete", shortenArrival, shiftLocalDate(businessDate, 1))
    );
    await executeRuntime({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: shortenOrderId }
    }, "runtime-stay-shorten-check-in");
    await executeRuntime({
      commandType: "SHORTEN_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: shortenOrderId,
        newDepartureDate: businessDate
      }
    }, "runtime-stay-shorten-complete");

    const completeArrival = shiftLocalDate(businessDate, -2);
    const completeDeparture = shiftLocalDate(completeArrival, 1);
    const completeOrderId = await withPropertyClockForTesting(
      new Date(`${completeArrival}T04:00:00.000Z`),
      () => createRuntimeStay("stay-complete", completeArrival, completeDeparture)
    );
    const completionReason = "受限运行账号核对计划中住宿直接完成";
    await executeRuntime({
      commandType: "COMPLETE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId: completeOrderId,
        actualStayCompletedConfirmed: true,
        reasonNote: completionReason
      }
    }, "runtime-stay-complete");

    await expect(db.selectFrom("orders as order")
      .innerJoin("stays as stay", "stay.order_id", "order.id")
      .select(["order.id", "order.status as orderStatus", "stay.status as stayStatus"])
      .where("order.id", "in", [
        cancellationOrderId,
        noShowOrderId,
        revokeOrderId,
        shortenOrderId,
        completeOrderId
      ])
      .execute()).resolves.toEqual(expect.arrayContaining([
      { id: cancellationOrderId, orderStatus: "CANCELLED", stayStatus: "CANCELLED" },
      { id: noShowOrderId, orderStatus: "NO_SHOW", stayStatus: "NO_SHOW" },
      { id: revokeOrderId, orderStatus: "CHECK_IN_REVOKED", stayStatus: "CHECK_IN_REVOKED" },
      { id: shortenOrderId, orderStatus: "CHECKED_OUT", stayStatus: "COMPLETED" },
      { id: completeOrderId, orderStatus: "CHECKED_OUT", stayStatus: "COMPLETED" }
    ]));
  });

  it("keeps in-house stay collection conversion executable through the runtime role", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = shiftLocalDate(businessDate, 1);
    const phone = "13900009702";
    const documentNumber = "RUNTIME-CONVERSION-MEMBER";
    const member = await executeRuntime({
      commandType: "CREATE_MEMBER",
      input: {
        propertyId: demo.propertyId,
        fullName: "Runtime Conversion Member",
        nickname: "Runtime Convert",
        identityCardNumber: documentNumber,
        phone,
        wechat: "runtime-conversion-member"
      }
    }, "runtime-conversion-member");
    const memberId = member.result!.memberId as string;
    const quote = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedCId,
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate,
      pricingPolicyVersionId: demo.transientPolicyId
    }, metadata("runtime-conversion-quote"));
    const stay = await executeRuntime({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quote.quoteId,
        primaryGuest: {
          fullName: "Runtime Conversion Member",
          nickname: "Runtime Convert",
          phone,
          documentNumber
        },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quote.quote.currentContractAmount.minorUnits
      }
    }, "runtime-conversion-stay");
    const orderId = stay.result!.orderId as string;
    const collection = await executeRuntime({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: quote.quote.currentContractAmount.minorUnits,
        method: "WECOM",
        transactionReference: "WX-RUNTIME-CONVERSION-SOURCE",
        note: "住宿实收转会员"
      }
    }, "runtime-conversion-collection");
    await executeRuntime({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId }
    }, "runtime-conversion-check-in");
    const conversion = await executeRuntime({
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      input: {
        propertyId: demo.propertyId,
        orderId,
        memberId,
        membershipProductId: "membership_product_shared_bath_quad_v1",
        collectionFactIds: [collection.factRefs[0]!],
        agreedPriceMinor: quote.quote.currentContractAmount.minorUnits,
        priceAdjustmentReason: "按本次真实住宿实收确认会员成交价"
      }
    }, "runtime-conversion-confirm");
    expect(conversion.result).toMatchObject({
      orderId,
      memberId,
      membershipOrderId: expect.stringMatching(/^membership_order_/)
    });
  });

  it("allows a typed historical correction to shift a completed stay across partially overlapping dates in the same room", async () => {
    const arrivalDate = "2026-08-01";
    const departureDate = "2026-08-03";
    const correctedArrivalDate = "2026-08-02";
    const correctedDepartureDate = "2026-08-04";
    const reason = "Runtime historical correction overlap regression";
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: demo.transientPolicyId
    });
    const createPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "Runtime 历史纠正", nickname: "历史纠正" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits,
        backfill: true,
        backfillReason: reason,
        backfillCollection: {
          amountMinor: quote.currentContractAmount.minorUnits,
          method: "WECOM",
          transactionReference: `WX-RUNTIME-HISTORICAL-${process.pid}`
        }
      }
    }, metadata("runtime-historical-create-preview"));
    const created = await confirmCommandPreview(db, administratorPrincipal, createPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: createPreview.preview.effectHash,
      reason: { code: "BACKFILL_STAY", note: reason }
    }, metadata("runtime-historical-create-confirm"));
    expect(created).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const orderId = created.result!.orderId as string;
    const order = await db.selectFrom("orders")
      .select(["version", "arrival_date", "departure_date"])
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    expect(order).toMatchObject({ arrival_date: arrivalDate, departure_date: departureDate });

    const correctionPreview = await createCommandPreview(db, administratorPrincipal, {
      commandType: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      input: {
        propertyId: demo.propertyId,
        correctionSet: [{
          orderId,
          expectedVersion: order.version,
          target: {
            inventoryUnitId: demo.secondRoomId,
            arrivalDate: correctedArrivalDate,
            departureDate: correctedDepartureDate
          }
        }],
        evidenceNote: "运行时角色同房部分重叠日期凭据已复核"
      }
    }, metadata("runtime-historical-correction-preview"));
    const corrected = await confirmCommandPreview(db, administratorPrincipal, correctionPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      confirmation: true,
      expectedEffectHash: correctionPreview.preview.effectHash,
      reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "管理员按历史凭据纠正同房住宿日期" }
    }, metadata("runtime-historical-correction-confirm"));

    expect(corrected).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    await expect(db.selectFrom("orders")
      .select(["version", "arrival_date", "departure_date"])
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow()).resolves.toEqual({
      version: order.version + 1,
      arrival_date: correctedArrivalDate,
      departure_date: correctedDepartureDate
    });
  });

  it("denies runtime DDL, role changes, trigger bypasses, TEMP objects, and protected fact mutation", async () => {
    const appendOnlyTablesWithoutRuntimeUpdate = [
      "pricing_policy_versions",
      "amendments",
      "admin_membership_payment_evidence_claims",
      "historical_stay_arrangement_corrections",
      "member_profile_corrections",
      "membership_effective_date_corrections",
      "historical_membership_backfills",
      "membership_payment_reclassifications",
      "membership_void_reconversions",
      "security_audit_entries",
      "command_receipts",
      "audit_entries",
      "order_occupant_corrections"
    ];
    for (const tableName of appendOnlyTablesWithoutRuntimeUpdate) {
      await expectRuntimeQueryToFail(`UPDATE ${tableName} SET created_at = created_at WHERE false`);
      await expectRuntimeQueryToFail(`DELETE FROM ${tableName} WHERE false`);
    }

    const lockOnlyAppendTables = [
      { tableName: "stay_segments", protectedColumn: "id", requireExistingRow: true },
      { tableName: "pricing_revisions", protectedColumn: "id", requireExistingRow: true },
      { tableName: "entitlement_ledger", protectedColumn: "fact_id", requireExistingRow: true },
      { tableName: "collection_facts", protectedColumn: "fact_id", requireExistingRow: false },
      { tableName: "membership_payment_facts", protectedColumn: "fact_id", requireExistingRow: true },
      { tableName: "stay_collection_membership_transfers", protectedColumn: "id", requireExistingRow: false }
    ] as const;
    for (const { tableName, protectedColumn, requireExistingRow } of lockOnlyAppendTables) {
      await expect(withClient(runtimeUrl.toString(), (client) => client.query(
        `UPDATE ${tableName} SET created_at = created_at WHERE false`
      ))).resolves.toMatchObject({ rowCount: 0 });
      await expectRuntimeQueryToFail(`UPDATE ${tableName} SET ${protectedColumn} = ${protectedColumn} WHERE false`);
      await expectRuntimeQueryToFail(`DELETE FROM ${tableName} WHERE false`);
      if (requireExistingRow) {
        await expectRuntimeQueryToFail(
          `UPDATE ${tableName} SET created_at = created_at WHERE ctid = (SELECT ctid FROM ${tableName} LIMIT 1)`,
          /is append-only/i
        );
      }
    }

    const occupant = await db.selectFrom("order_occupants").select("id").executeTakeFirstOrThrow();
    await expectRuntimeQueryToFail(
      `UPDATE order_occupants SET created_at = created_at WHERE id = '${occupant.id.replaceAll("'", "''")}'`,
      /order_occupants is append-only/i
    );
    await expect(withClient(runtimeUrl.toString(), (client) => client.query(
      "UPDATE inventory_units SET created_at = created_at WHERE false"
    ))).resolves.toMatchObject({ rowCount: 0 });
    await expectRuntimeQueryToFail("UPDATE inventory_units SET active = active WHERE false");
    await expectRuntimeQueryToFail("UPDATE inventory_units SET name = name WHERE false");
    await expectRuntimeQueryToFail(
      `UPDATE inventory_units SET created_at = created_at + interval '1 second' WHERE id = '${demo.secondRoomId}'`,
      /immutable/i
    );
    await expectRuntimeQueryToFail(
      `UPDATE inventory_units SET created_at = created_at WHERE id = '${demo.secondRoomId}'`,
      /runtime inventory unit updates are forbidden/i
    );

    await expectRuntimeQueryToFail("UPDATE api_tokens SET secret_hash = repeat('0', 64) WHERE false");
    await expectRuntimeQueryToFail("UPDATE subjects SET status = status WHERE false");
    await expectRuntimeQueryToFail("UPDATE subject_property_grants SET access_level = access_level WHERE false");
    await expectRuntimeQueryToFail(`UPDATE subject_command_grants SET created_at = created_at WHERE subject_id = '${demo.agentSubjectId}' AND property_id = '${demo.propertyId}' AND command_type = 'CREATE_ORDER'`);
    await expectRuntimeQueryToFail("DELETE FROM subject_command_grants WHERE false");
    await expectRuntimeQueryToFail(`UPDATE token_command_ceilings SET created_at = created_at WHERE token_id = 'token_demo_write' AND subject_id = '${demo.agentSubjectId}' AND property_id = '${demo.propertyId}' AND command_type = 'CREATE_ORDER'`);
    await expectRuntimeQueryToFail("DELETE FROM token_command_ceilings WHERE false");
    await expectRuntimeQueryToFail(
      "INSERT INTO admin_membership_payment_evidence_claims(normalized_reference, membership_payment_fact_id, command_id, correction_type) VALUES ('RUNTIME-FORBIDDEN', 'missing-fact', 'missing-command', 'BACKFILL_HISTORICAL_MEMBERSHIP')"
    );
    await expectRuntimeQueryToFail("SELECT qintopia_guard_admin_membership_payment_evidence()");
    await expectRuntimeQueryToFail("SELECT qintopia_claim_admin_membership_payment_evidence()");
    await expectRuntimeQueryToFail("ALTER TABLE collection_facts ADD COLUMN runtime_forbidden text");
    await expectRuntimeQueryToFail("CREATE TABLE runtime_forbidden(id text)");
    await expectRuntimeQueryToFail("DROP TABLE properties");
    await expectRuntimeQueryToFail("CREATE FUNCTION runtime_forbidden() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
    await expectRuntimeQueryToFail("CREATE TRIGGER runtime_forbidden BEFORE INSERT ON collection_facts FOR EACH STATEMENT EXECUTE FUNCTION qintopia_prevent_fact_mutation()");
    await expectRuntimeQueryToFail("DROP TRIGGER collection_facts_append_only ON collection_facts");
    await expectRuntimeQueryToFail("ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_append_only");
    await expectRuntimeQueryToFail("ALTER ROLE qintopia_runtime CREATEROLE");
    await expectRuntimeQueryToFail("CREATE TEMP TABLE runtime_temp(id text)");
  });

  it("rejects direct runtime Token and ceiling mutations with full transaction rollback", async () => {
    await expectTokenGuardProbeToRollback("direct-token-insert", async (client, probe) => {
      await insertProbedToken(client, probe, []);
    });

    const before = await db.selectFrom("api_tokens")
      .select(["revoked_at", "replaced_by_id"])
      .where("id", "=", "token_demo_write")
      .executeTakeFirstOrThrow();
    await expectRuntimeTransactionToFail([
      "UPDATE api_tokens SET revoked_at = now() WHERE id = 'token_demo_write'"
    ], /runtime Token mutations require same-transaction typed command evidence/i);
    await expect(db.selectFrom("api_tokens")
      .select(["revoked_at", "replaced_by_id"])
      .where("id", "=", "token_demo_write")
      .executeTakeFirstOrThrow()).resolves.toEqual(before);

    await expectRuntimeTransactionToFail([
      `INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
       VALUES ('token_demo_read', '${demo.agentSubjectId}', '${demo.propertyId}', 'REPRICE_ORDER')`
    ], /runtime Token mutations require same-transaction typed command evidence/i);
    await expect(db.selectFrom("token_command_ceilings")
      .select("token_id")
      .where("token_id", "=", "token_demo_read")
      .where("command_type", "=", "REPRICE_ORDER")
      .executeTakeFirst()).resolves.toBeUndefined();
  });

  it("rejects incomplete, stale, mistyped, cross-scope, and non-exact Token evidence atomically", async () => {
    const mismatchedPropertyId = `property_token_guard_mismatch_${process.pid}`;
    await withClient(ownerUrl.toString(), (owner) => owner.query(`
      INSERT INTO properties(id, code, name, timezone, currency)
      VALUES ($1, $2, 'Token guard mismatch', 'Asia/Shanghai', 'CNY')
      ON CONFLICT DO NOTHING
    `, [mismatchedPropertyId, `TG-${process.pid}`]));

    const probes: Array<{
      label: string;
      evidence?: Parameters<typeof insertIssueTokenEvidence>[2];
      persistedCeiling?: readonly string[];
      tokenExpiresAt?: string;
    }> = [
      { label: "missing-execution", evidence: { omitExecution: true } },
      { label: "missing-receipt", evidence: { omitReceipt: true } },
      { label: "missing-audit", evidence: { omitAudit: true } },
      { label: "system-derived-command", evidence: { commandType: "REFRESH_MEMBER_COVERAGE" } },
      { label: "wrong-human-command", evidence: { commandType: "CREATE_ORDER" } },
      {
        label: "ordinary-caller",
        evidence: {
          executionSubjectId: demo.agentSubjectId,
          executionCredentialId: "token_demo_write"
        }
      },
      { label: "cross-token-receipt", evidence: { receiptTokenId: "token_receipt_mismatch" } },
      { label: "cross-subject-receipt", evidence: { receiptSubjectId: demo.agentSubjectId } },
      { label: "cross-property-execution", evidence: { executionPropertyId: mismatchedPropertyId } },
      { label: "access-mismatched-receipt", evidence: { receiptAccessCeiling: "READ" } },
      { label: "expiry-mismatched-receipt", evidence: { receiptExpiresAt: "2028-01-01T00:00:00.000Z" } },
      { label: "audit-action-mismatch", evidence: { auditAction: "REVOKE_TOKEN" } },
      { label: "audit-credential-mismatch", evidence: { auditCredentialId: "token_demo_write" } },
      {
        label: "caller-ceiling-escalation",
        evidence: { receiptCommandCeiling: ["COMPLETE_CLEANING"] },
        persistedCeiling: ["COMPLETE_CLEANING"]
      },
      {
        label: "caller-expiry-escalation",
        evidence: { receiptExpiresAt: "2031-01-01T00:00:00.000Z" },
        tokenExpiresAt: "2031-01-01T00:00:00.000Z"
      },
      { label: "missing-ceiling-row", persistedCeiling: [] },
      {
        label: "extra-ceiling-row",
        evidence: { receiptCommandCeiling: ["REPRICE_ORDER"] },
        persistedCeiling: ["REPRICE_ORDER", "CREATE_ORDER"]
      }
    ];

    for (const { label, evidence, persistedCeiling, tokenExpiresAt } of probes) {
      await expectTokenGuardProbeToRollback(label, async (client, probe) => {
        await insertProbedToken(client, probe, persistedCeiling, tokenExpiresAt);
        await insertIssueTokenEvidence(client, probe, evidence);
      });
    }

    const rotationProbe = tokenGuardProbe("rotation-source-mismatch");
    const sourceBefore = await db.selectFrom("api_tokens")
      .select(["revoked_at", "replaced_by_id"])
      .where("id", "=", "token_demo_admin_write")
      .executeTakeFirstOrThrow();
    await expectTokenGuardProbeToRollback("rotation-source-mismatch", async (client, probe) => {
      await insertProbedRotatedToken(client, probe, "token_demo_admin_write");
      await insertIssueTokenEvidence(client, probe, {
        commandType: "ROTATE_TOKEN",
        receiptRotatedFromTokenId: "token_demo_write"
      });
    }, rotationProbe);
    await expect(db.selectFrom("api_tokens")
      .select(["revoked_at", "replaced_by_id"])
      .where("id", "=", "token_demo_admin_write")
      .executeTakeFirstOrThrow()).resolves.toEqual(sourceBefore);

    const staleProbe = tokenGuardProbe("stale-evidence");
    await withClient(runtimeUrl.toString(), async (client) => {
      await client.query("BEGIN");
      try {
        await insertIssueTokenEvidence(client, staleProbe);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    await expectTokenGuardProbeToRollback("stale-evidence", async (client, probe) => {
      await insertProbedToken(client, probe);
    }, staleProbe, 1);
  });

  it("rejects a direct runtime update of the orders projection without same-transaction command evidence", async () => {
    const order = await db.selectFrom("orders").select(["id", "version"]).orderBy("created_at").executeTakeFirstOrThrow();
    await expectRuntimeQueryToFail(
      `UPDATE orders SET version = version + 1, updated_at = now() WHERE id = '${order.id.replaceAll("'", "''")}'`,
      /runtime order projection updates require same-transaction typed command evidence/i
    );
    await expect(db.selectFrom("orders").select("version").where("id", "=", order.id).executeTakeFirstOrThrow())
      .resolves.toEqual({ version: order.version });
  });

  it("rejects shape-valid direct updates of every mutable runtime projection without typed command evidence", async () => {
    const draftMembershipOrderId = `membership_order_runtime_guard_${process.pid}`;
    const cleaningTaskId = `cleaning_runtime_guard_${process.pid}`;
    const coverageFactId = `fact_runtime_coverage_attack_${process.pid}`;

    const fixtures = await withClient(ownerUrl.toString(), async (owner) => {
      await owner.query(`
        INSERT INTO membership_orders (
          id, property_id, member_id, product_id, product_code, product_version, product_name,
          listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
          currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code,
          allowed_inventory_kind, status, activated_at, valid_from, valid_until, contract_id,
          entitlement_lot_id, version, created_by_command_id, activated_by_command_id
        )
        SELECT $1, property_id, member_id, product_id, product_code, product_version, product_name,
          listed_price_minor, agreed_price_minor, price_adjustment_minor, price_adjustment_reason,
          currency, entitlement_unit_kind, entitlement_units, allowed_room_type_code,
          allowed_inventory_kind, 'DRAFT', NULL, NULL, NULL, NULL, NULL, 1,
          $2, NULL
        FROM membership_orders
        WHERE status = 'ACTIVE'
        ORDER BY created_at, id
        LIMIT 1
      `, [draftMembershipOrderId, `command_runtime_membership_fixture_${process.pid}`]);
      await owner.query(`
        INSERT INTO cleaning_tasks (
          id, property_id, order_id, stay_id, inventory_unit_id, room_id, service_date,
          status, version, created_by_command_id, completed_by_command_id, completed_at
        )
        SELECT $1, order_row.property_id, order_row.id, stay_row.id, segment.inventory_unit_id,
          CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
          segment.arrival_date, 'PENDING', 1, amendment.command_id, NULL, NULL
        FROM orders AS order_row
        JOIN stays AS stay_row ON stay_row.order_id = order_row.id
        JOIN LATERAL (
          SELECT candidate.*
          FROM stay_segments AS candidate
          WHERE candidate.stay_id = stay_row.id
          ORDER BY candidate.sequence DESC
          LIMIT 1
        ) AS segment ON true
        JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
        JOIN amendments AS amendment ON amendment.id = segment.amendment_id
        ORDER BY order_row.created_at DESC, order_row.id DESC
        LIMIT 1
      `, [cleaningTaskId]);
      return owner.query<{
        contract_id: string | null;
        lot_id: string | null;
        stay_id: string | null;
        coverage_id: string | null;
        room_claim_id: string | null;
        bed_claim_id: string | null;
        order_claim_id: string | null;
        maintenance_lock_id: string | null;
      }>(`
        SELECT
          (SELECT id FROM member_contracts ORDER BY id LIMIT 1) AS contract_id,
          (SELECT id FROM entitlement_lots ORDER BY id LIMIT 1) AS lot_id,
          (SELECT id FROM stays WHERE status = 'PLANNED' ORDER BY id LIMIT 1) AS stay_id,
          (SELECT id FROM coverage_items WHERE status = 'HELD' ORDER BY id LIMIT 1) AS coverage_id,
          (SELECT whole_claim_id FROM inventory_room_days WHERE whole_claim_id IS NOT NULL ORDER BY room_id, service_date LIMIT 1) AS room_claim_id,
          (SELECT bed_claim_id FROM inventory_bed_days WHERE bed_claim_id IS NOT NULL ORDER BY bed_id, service_date LIMIT 1) AS bed_claim_id,
          (SELECT id FROM inventory_claims WHERE active AND source_type = 'ORDER_SEGMENT' ORDER BY id LIMIT 1) AS order_claim_id,
          (SELECT id FROM maintenance_locks WHERE status = 'ACTIVE' ORDER BY id LIMIT 1) AS maintenance_lock_id
      `);
    });
    const fixture = fixtures.rows[0]!;
    expect(fixture).toEqual({
      contract_id: expect.any(String),
      lot_id: expect.any(String),
      stay_id: expect.any(String),
      coverage_id: expect.any(String),
      room_claim_id: expect.any(String),
      bed_claim_id: expect.any(String),
      order_claim_id: expect.any(String),
      maintenance_lock_id: expect.any(String)
    });

    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await expectRuntimeTransactionToFail([
      `UPDATE membership_orders SET version = version + 1, updated_at = now() WHERE id = ${literal(draftMembershipOrderId)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE member_contracts SET version = version + 1 WHERE id = ${literal(fixture.contract_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE entitlement_lots SET version = version + 1 WHERE id = ${literal(fixture.lot_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE stays SET status = 'IN_HOUSE' WHERE id = ${literal(fixture.stay_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE coverage_items SET status = 'RELEASED', updated_at = now() WHERE id = ${literal(fixture.coverage_id!)}`,
      `INSERT INTO entitlement_ledger (
        fact_id, lot_id, entry_type, quantity_delta, service_date, order_id,
        coverage_id, reason, command_id
      )
      SELECT ${literal(coverageFactId)}, coverage.lot_id, 'RELEASE', 1,
        coverage.service_date, coverage.order_id, coverage.id,
        'runtime direct update attack', hold.command_id
      FROM coverage_items AS coverage
      JOIN entitlement_ledger AS hold
        ON hold.coverage_id = coverage.id
        AND hold.entry_type = 'HOLD'
      WHERE coverage.id = ${literal(fixture.coverage_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE inventory_room_days SET whole_claim_id = NULL, version = version + 1, updated_at = now()
       WHERE whole_claim_id = ${literal(fixture.room_claim_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE inventory_bed_days SET bed_claim_id = NULL, version = version + 1, updated_at = now()
       WHERE bed_claim_id = ${literal(fixture.bed_claim_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE inventory_claims SET active = false, released_at = now()
       WHERE id = ${literal(fixture.order_claim_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE inventory_room_days AS day_row
       SET whole_claim_id = NULL, version = day_row.version + 1, updated_at = now()
       FROM inventory_claims AS claim
       WHERE claim.source_type = 'MAINTENANCE'
         AND claim.source_id = ${literal(fixture.maintenance_lock_id!)}
         AND claim.active
         AND day_row.whole_claim_id = claim.id`,
      `UPDATE inventory_bed_days AS day_row
       SET bed_claim_id = NULL, version = day_row.version + 1, updated_at = now()
       FROM inventory_claims AS claim
       WHERE claim.source_type = 'MAINTENANCE'
         AND claim.source_id = ${literal(fixture.maintenance_lock_id!)}
         AND claim.active
         AND day_row.bed_claim_id = claim.id`,
      `UPDATE inventory_claims SET active = false, released_at = now()
       WHERE source_type = 'MAINTENANCE'
         AND source_id = ${literal(fixture.maintenance_lock_id!)}
         AND active`,
      `UPDATE maintenance_locks
       SET status = 'RELEASED', version = version + 1,
         released_by_command_id = created_by_command_id, released_at = now()
       WHERE id = ${literal(fixture.maintenance_lock_id!)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE cleaning_tasks
       SET status = 'COMPLETED', version = version + 1,
         completed_by_command_id = created_by_command_id, completed_at = now()
       WHERE id = ${literal(cleaningTaskId)}`
    ]);
    await expectRuntimeTransactionToFail([
      `UPDATE room_status_revisions SET revision = revision + 1, updated_at = now()
       WHERE property_id = ${literal(demo.propertyId)}`
    ]);

    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("binds a completed Stay transition to both its source state and exact command type", async () => {
    const arrivalDate = "2040-01-01";
    const departureDate = "2040-01-02";
    const quoted = await executeQuoteCommand(db, readPrincipal, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: demo.transientPolicyId
    }, metadata("runtime-stay-source-command-quote"));
    const created = await executeRuntime({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quoted.quote.quoteId,
        primaryGuest: { fullName: "Runtime Stay Source Guard", nickname: "Source Guard" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quoted.quote.currentContractAmount.minorUnits
      }
    }, "runtime-stay-source-command-order");
    const orderId = created.result!.orderId as string;
    const stay = await db.selectFrom("stays").select(["id", "status"]).where("order_id", "=", orderId).executeTakeFirstOrThrow();
    expect(stay.status).toBe("PLANNED");

    const suffix = `${process.pid}-${++sequence}`;
    const commandId = `command_runtime_wrong_checkout_${suffix}`;
    const amendmentId = `amend_runtime_wrong_checkout_${suffix}`;
    const receiptId = `receipt_runtime_wrong_checkout_${suffix}`;
    const auditId = `audit_runtime_wrong_checkout_${suffix}`;
    await expect(withClient(runtimeUrl.toString(), async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`
          INSERT INTO command_executions (
            id, subject_id, credential_id, property_id, command_type,
            idempotency_key, request_hash, correlation_id, state, completed_at
          ) VALUES ($1, $2, 'token_demo_write', $3, 'CHECK_OUT', $1, repeat('d', 64), $1, 'APPLIED', now())
        `, [commandId, demo.agentSubjectId, demo.propertyId]);
        await client.query(`
          INSERT INTO amendments (
            id, order_id, sequence, amendment_type, reason_code, reason_note,
            prior_version, new_version, payload, command_id
          )
          SELECT $1, id, version + 1, 'CHECK_OUT', 'RUNTIME_DATABASE_GUARD',
            'A checkout command must not complete a planned Stay', version, version + 1,
            jsonb_build_object(
              'orderId', id,
              'fromStatus', 'CHECKED_IN',
              'toStatus', 'CHECKED_OUT',
              'businessDate', departure_date,
              'effectiveDate', departure_date,
              'recordingMode', 'ON_SCHEDULE'
            ),
            $2
          FROM orders
          WHERE id = $3
        `, [amendmentId, commandId, orderId]);
        await client.query("UPDATE stays SET status = 'COMPLETED' WHERE id = $1", [stay.id]);
        await client.query(`
          INSERT INTO command_receipts (
            id, command_id, execution_status, business_committed,
            result, error, resource_refs, fact_refs, committed_at
          ) VALUES ($1, $2, 'EXECUTED', true, '{}'::jsonb, NULL, '[]'::jsonb, '[]'::jsonb, now())
        `, [receiptId, commandId]);
        await client.query(`
          INSERT INTO audit_entries (
            id, subject_id, credential_id, action, decision, command_id,
            correlation_id, reason, target_refs, metadata
          ) VALUES ($1, $2, 'token_demo_write', 'CHECK_OUT', 'ALLOWED', $3, $3, NULL, '[]'::jsonb, '{}'::jsonb)
        `, [auditId, demo.agentSubjectId, commandId]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    })).rejects.toThrow(/exact source state and command type/i);

    await expect(db.selectFrom("stays").select("status").where("id", "=", stay.id).executeTakeFirstOrThrow())
      .resolves.toEqual({ status: "PLANNED" });
  });

  it("rejects forged SYSTEM_DERIVED evidence and rolls back the complete entitlement attack", async () => {
    const commandId = `command_runtime_derived_attack_${process.pid}`;
    const factId = `fact_runtime_derived_attack_${process.pid}`;
    const receiptId = `receipt_runtime_derived_attack_${process.pid}`;
    const auditId = `audit_runtime_derived_attack_${process.pid}`;
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

    const before = await db.selectFrom("member_contracts")
      .innerJoin("entitlement_lots", "entitlement_lots.contract_id", "member_contracts.id")
      .select([
        "member_contracts.version as contract_version",
        "entitlement_lots.version as lot_version"
      ])
      .where("member_contracts.id", "=", demo.memberContractId)
      .where("entitlement_lots.id", "=", demo.roomLotId)
      .executeTakeFirstOrThrow();

    await expectRuntimeTransactionToFail([
      `INSERT INTO command_executions (
        id, subject_id, credential_id, property_id, command_type,
        idempotency_key, request_hash, correlation_id, state, completed_at
      ) VALUES (
        ${literal(commandId)}, ${literal(demo.agentSubjectId)}, 'token_demo_write',
        ${literal(demo.propertyId)}, 'ADJUST_MEMBER_ENTITLEMENT', ${literal(commandId)},
        repeat('c', 64), ${literal(commandId)}, 'APPLIED', now()
      )`,
      `INSERT INTO entitlement_ledger (
        fact_id, lot_id, entry_type, quantity_delta, service_date, order_id,
        coverage_id, reason, command_id
      ) VALUES (
        ${literal(factId)}, ${literal(demo.roomLotId)}, 'ADJUST', 1, NULL, NULL,
        NULL, 'forged runtime system-derived adjustment', ${literal(commandId)}
      )`,
      `INSERT INTO command_receipts (
        id, command_id, execution_status, business_committed, result, error,
        resource_refs, fact_refs, committed_at
      ) VALUES (
        ${literal(receiptId)}, ${literal(commandId)}, 'EXECUTED', true,
        jsonb_build_object('entitlementLotId', ${literal(demo.roomLotId)}, 'adjustmentFactId', ${literal(factId)}),
        NULL, jsonb_build_array(${literal(demo.memberContractId)}, ${literal(demo.roomLotId)}),
        jsonb_build_array(${literal(factId)}), now()
      )`,
      `INSERT INTO audit_entries (
        id, subject_id, credential_id, action, decision, command_id,
        correlation_id, reason, target_refs, metadata
      ) VALUES (
        ${literal(auditId)}, ${literal(demo.agentSubjectId)}, 'token_demo_write',
        'ADJUST_MEMBER_ENTITLEMENT', 'ALLOWED', ${literal(commandId)}, ${literal(commandId)},
        jsonb_build_object('code', 'FORGED_SYSTEM_DERIVED'),
        jsonb_build_array(${literal(demo.memberContractId)}, ${literal(demo.roomLotId)}),
        '{}'::jsonb
      )`,
      `UPDATE member_contracts SET version = version + 1 WHERE id = ${literal(demo.memberContractId)}`,
      `UPDATE entitlement_lots SET version = version + 1 WHERE id = ${literal(demo.roomLotId)}`
    ], /same-transaction typed command evidence/i);

    const after = await db.selectFrom("member_contracts")
      .innerJoin("entitlement_lots", "entitlement_lots.contract_id", "member_contracts.id")
      .select([
        "member_contracts.version as contract_version",
        "entitlement_lots.version as lot_version"
      ])
      .where("member_contracts.id", "=", demo.memberContractId)
      .where("entitlement_lots.id", "=", demo.roomLotId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);

    const residue = await sql<{
      execution_count: number;
      fact_count: number;
      receipt_count: number;
      audit_count: number;
    }>`
      SELECT
        (SELECT count(*)::integer FROM command_executions WHERE id = ${commandId}) AS execution_count,
        (SELECT count(*)::integer FROM entitlement_ledger WHERE fact_id = ${factId}) AS fact_count,
        (SELECT count(*)::integer FROM command_receipts WHERE id = ${receiptId}) AS receipt_count,
        (SELECT count(*)::integer FROM audit_entries WHERE id = ${auditId}) AS audit_count
    `.execute(db);
    expect(residue.rows[0]).toEqual({
      execution_count: 0,
      fact_count: 0,
      receipt_count: 0,
      audit_count: 0
    });
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("never expands existing token ceilings during profile reconciliation and retains historical recovery ceilings", async () => {
    const historicalCommandId = `command_runtime_historical_${process.pid}`;
    const demoManifest = [
      { subjectId: demo.operatorSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.agentSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.administratorSubjectId, propertyId: demo.propertyId, profile: "ADMIN" }
    ];
    const promotedManifest = [
      { subjectId: demo.operatorSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.agentSubjectId, propertyId: demo.propertyId, profile: "ADMIN" },
      { subjectId: demo.administratorSubjectId, propertyId: demo.propertyId, profile: "ADMIN" }
    ];

    await withClient(ownerUrl.toString(), async (owner) => {
      await owner.query(`
        INSERT INTO command_executions (
          id, subject_id, credential_id, property_id, command_type,
          idempotency_key, request_hash, correlation_id, state, completed_at
        ) VALUES ($1, $2, 'token_demo_write', $3, 'PLACE_INTERNAL_USE',
          $4, repeat('a', 64), $4, 'APPLIED', now())
      `, [historicalCommandId, demo.agentSubjectId, demo.propertyId, historicalCommandId]);
      await owner.query(`
        INSERT INTO subject_command_grants(subject_id, property_id, command_type)
        VALUES ($1, $2, 'PLACE_INTERNAL_USE')
        ON CONFLICT DO NOTHING
      `, [demo.agentSubjectId, demo.propertyId]);
      await owner.query(`
        INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
        VALUES ('token_demo_write', $1, $2, 'PLACE_INTERNAL_USE')
        ON CONFLICT DO NOTHING
      `, [demo.agentSubjectId, demo.propertyId]);
      await owner.query(`
        DELETE FROM token_command_ceilings
        WHERE token_id = 'token_demo_write'
          AND command_type = 'REPRICE_ORDER'
      `);

      const before = await owner.query<{ command_type: string }>(`
        SELECT command_type
        FROM token_command_ceilings
        WHERE token_id = 'token_demo_write'
        ORDER BY command_type
      `);
      await owner.query(
        "SELECT qintopia_reconcile_staff_profile_manifest($1, $2::jsonb)",
        ["runtime-test-admin", JSON.stringify(promotedManifest)]
      );
      const after = await owner.query<{ command_type: string }>(`
        SELECT command_type
        FROM token_command_ceilings
        WHERE token_id = 'token_demo_write'
        ORDER BY command_type
      `);
      expect(after.rows).toEqual(before.rows);
      expect(after.rows).toContainEqual({ command_type: "PLACE_INTERNAL_USE" });
      expect(after.rows).not.toContainEqual({ command_type: "REPRICE_ORDER" });
      expect(after.rows).not.toContainEqual({ command_type: "ISSUE_TOKEN" });
      expect(await owner.query<{ granted: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM subject_command_grants
          WHERE subject_id = $1
            AND property_id = $2
            AND command_type = 'ISSUE_TOKEN'
        ) AS granted
      `, [demo.agentSubjectId, demo.propertyId]).then((result) => result.rows[0]?.granted)).toBe(true);

      await owner.query(`
        INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
        VALUES ('token_demo_write', $1, $2, 'REPRICE_ORDER')
        ON CONFLICT DO NOTHING
      `, [demo.agentSubjectId, demo.propertyId]);
      await owner.query(
        "SELECT qintopia_reconcile_staff_profile_manifest($1, $2::jsonb)",
        ["demo", JSON.stringify(demoManifest)]
      );
    });

    await expectRuntimeQueryToFail(
      "SELECT qintopia_reconcile_staff_profile_manifest('runtime-forbidden', '[]'::jsonb)"
    );
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("removes disabled-feature ceilings without adding them to other Tokens during reconciliation", async () => {
    const preservedCommand = "COMPLETE_CLEANING";
    const demoManifest = [
      { subjectId: demo.operatorSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.agentSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.administratorSubjectId, propertyId: demo.propertyId, profile: "ADMIN" }
    ];
    await withClient(ownerUrl.toString(), async (owner) => {
      await owner.query("BEGIN");
      try {
        await owner.query(`
          INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
          VALUES ('token_demo_admin_write', $1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [demo.administratorSubjectId, demo.propertyId, preservedCommand]);
        await owner.query(`
          DELETE FROM token_command_ceilings
          WHERE token_id = 'token_demo_write'
            AND command_type = $1
        `, [preservedCommand]);
        await owner.query(
          "SELECT qintopia_reconcile_staff_profile_manifest($1, $2::jsonb)",
          ["runtime-disabled-feature-preservation", JSON.stringify(demoManifest)]
        );

        const preserved = await owner.query<{ command_type: string }>(`
          SELECT command_type
          FROM token_command_ceilings
          WHERE token_id = 'token_demo_admin_write'
            AND command_type = $1
        `, [preservedCommand]);
        expect(preserved.rows).toEqual([]);
        const notExpanded = await owner.query<{ command_type: string }>(`
          SELECT command_type
          FROM token_command_ceilings
          WHERE token_id = 'token_demo_write'
            AND command_type = $1
        `, [preservedCommand]);
        expect(notExpanded.rows).toEqual([]);
      } finally {
        await owner.query("ROLLBACK");
      }
    });
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("narrows existing administrator token ceilings when the profile is downgraded to staff", async () => {
    const historicalCommandId = `command_runtime_admin_historical_${process.pid}`;
    const demoManifest = [
      { subjectId: demo.operatorSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.agentSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.administratorSubjectId, propertyId: demo.propertyId, profile: "ADMIN" }
    ];
    const downgradedManifest = [
      { subjectId: demo.operatorSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.agentSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
      { subjectId: demo.administratorSubjectId, propertyId: demo.propertyId, profile: "STAFF" }
    ];
    const administratorOnlyCeilings = [
      "CORRECT_ORDER_OCCUPANT",
      "ISSUE_TOKEN",
      "ROTATE_TOKEN",
      "REVOKE_TOKEN"
    ];

    await withClient(ownerUrl.toString(), async (owner) => {
      await owner.query("BEGIN");
      try {
        const originalCeilings = await owner.query<{ command_type: string }>(`
          SELECT command_type
          FROM token_command_ceilings
          WHERE token_id = 'token_demo_admin_write'
          ORDER BY command_type
        `);
        expect(originalCeilings.rows.map((row) => row.command_type)).toEqual(expect.arrayContaining([
          "CREATE_ORDER",
          "REPRICE_ORDER",
          ...administratorOnlyCeilings
        ]));

        await owner.query(`
          INSERT INTO command_executions (
            id, subject_id, credential_id, property_id, command_type,
            idempotency_key, request_hash, correlation_id, state, completed_at
          ) VALUES ($1, $2, 'token_demo_admin_write', $3, 'PLACE_INTERNAL_USE',
            $1, repeat('b', 64), $1, 'APPLIED', now())
        `, [historicalCommandId, demo.administratorSubjectId, demo.propertyId]);
        await owner.query(`
          INSERT INTO subject_command_grants(subject_id, property_id, command_type)
          VALUES ($1, $2, 'PLACE_INTERNAL_USE')
          ON CONFLICT DO NOTHING
        `, [demo.administratorSubjectId, demo.propertyId]);
        await owner.query(`
          INSERT INTO token_command_ceilings(token_id, subject_id, property_id, command_type)
          VALUES ('token_demo_admin_write', $1, $2, 'PLACE_INTERNAL_USE')
          ON CONFLICT DO NOTHING
        `, [demo.administratorSubjectId, demo.propertyId]);

        await owner.query(
          "SELECT qintopia_reconcile_staff_profile_manifest($1, $2::jsonb)",
          ["runtime-test-staff-downgrade", JSON.stringify(downgradedManifest)]
        );

        const downgradedCeilings = await owner.query<{ command_type: string }>(`
          SELECT command_type
          FROM token_command_ceilings
          WHERE token_id = 'token_demo_admin_write'
          ORDER BY command_type
        `);
        expect(downgradedCeilings.rows).toEqual(expect.arrayContaining([
          { command_type: "CREATE_ORDER" },
          { command_type: "REPRICE_ORDER" },
          { command_type: "PLACE_INTERNAL_USE" }
        ]));
        for (const commandType of administratorOnlyCeilings) {
          expect(downgradedCeilings.rows).not.toContainEqual({ command_type: commandType });
        }
      } finally {
        await owner.query("ROLLBACK");
      }
    });

    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });

  it("fails readiness for role membership, extra column grants, profile drift, and a missing runtime guard", async () => {
    await withClient(ownerUrl.toString(), (owner) => owner.query(`GRANT "${dangerousRoleName}" TO qintopia_runtime`));
    try {
      await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(false);
    } finally {
      await withClient(ownerUrl.toString(), (owner) => owner.query(`REVOKE "${dangerousRoleName}" FROM qintopia_runtime`));
    }
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);

    await withClient(ownerUrl.toString(), (owner) => owner.query("GRANT UPDATE (secret_hash) ON api_tokens TO qintopia_runtime"));
    try {
      await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(false);
    } finally {
      await withClient(ownerUrl.toString(), (owner) => owner.query("REVOKE UPDATE (secret_hash) ON api_tokens FROM qintopia_runtime"));
    }
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);

    await withClient(ownerUrl.toString(), (owner) => owner.query(`
      UPDATE staff_profile_reconciliation_state
      SET projection_hash = repeat('0', 64)
      WHERE singleton
    `));
    try {
      await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(false);
    } finally {
      const demoManifest = [
        { subjectId: demo.operatorSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
        { subjectId: demo.agentSubjectId, propertyId: demo.propertyId, profile: "STAFF" },
        { subjectId: demo.administratorSubjectId, propertyId: demo.propertyId, profile: "ADMIN" }
      ];
      await withClient(ownerUrl.toString(), (owner) => owner.query(
        "SELECT qintopia_reconcile_staff_profile_manifest($1, $2::jsonb)",
        ["demo", JSON.stringify(demoManifest)]
      ));
    }
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);

    await withClient(ownerUrl.toString(), (owner) => owner.query(
      "DROP TRIGGER orders_runtime_projection_guard ON orders"
    ));
    try {
      await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(false);
    } finally {
      await withClient(ownerUrl.toString(), (owner) => owner.query(`
        CREATE CONSTRAINT TRIGGER orders_runtime_projection_guard
        AFTER UPDATE ON orders
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_order_projection_update()
      `));
    }
    await expect(databaseReady(db, demoRuntimeReadinessOptions)).resolves.toBe(true);
  });
});
