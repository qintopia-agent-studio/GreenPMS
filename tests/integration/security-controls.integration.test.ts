import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  databaseReady,
  findCommandResult,
  getCommand,
  getReceipt,
  type Database
} from "@qintopia/db";
import { newId, newOpaqueSecret, sha256 } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope, commandGrantsForProfile, emptyAuthScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const securityDatabaseUrl = process.env.SECURITY_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_security_integration";
const demoOwnerReadinessOptions = {
  identity: "maintenance-owner",
  staffProfileManifestName: "demo"
} as const;

let db: Kysely<Database>;
let sequence = 0;
const principal: AuthPrincipal = {
  subjectId: demo.administratorSubjectId,
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Demo Administrator",
  ...authScope({ profile: "administrator" })
};

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function execute(envelope: CommandEnvelope, prefix: string) {
  const preview = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  const confirmation = {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true as const,
    expectedEffectHash: preview.preview.effectHash,
    reason: { code: "SECURITY_ACCEPTANCE", note: `Security acceptance for ${prefix}` }
  };
  const confirmMetadata = metadata(`${prefix}-confirm`);
  const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
  return { preview, confirmation, confirmMetadata, receipt };
}

async function authorizationArtifactCounts() {
  const [executions, previews, receipts, audits, securityAudits] = await Promise.all([
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("security_audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [executions, previews, receipts, audits, securityAudits].map((row) => Number(row.count));
}

beforeAll(async () => {
  db = await resetDatabase(securityDatabaseUrl);
});

afterAll(async () => {
  await db.destroy();
});

describe("security controls on PostgreSQL", () => {
  it("accepts a client-held Token secret without persisting or returning it", async () => {
    const tokenSecret = newOpaqueSecret("qtp");
    const flow = await execute({
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Transient security token",
        accessCeiling: "WRITE",
        commandCeiling: commandGrantsForProfile("ordinary"),
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret
      }
    }, "transient-token");
    const tokenId = flow.receipt.result?.tokenId as string;

    const replay = await confirmCommandPreview(db, principal, flow.preview.preview.previewId, flow.confirmation, flow.confirmMetadata);
    expect(replay.receiptId).toBe(flow.receipt.receiptId);
    expect(replay.result).not.toHaveProperty("tokenSecret");
    expect((await getReceipt(db, principal, flow.receipt.receiptId)).result).not.toHaveProperty("tokenSecret");
    const persistedCommand = await getCommand(db, principal, flow.receipt.commandId);
    expect(persistedCommand).toHaveProperty("receiptId", flow.receipt.receiptId);
    if ("receiptId" in persistedCommand) expect(persistedCommand.result).not.toHaveProperty("tokenSecret");
    const recovered = await findCommandResult(db, principal, demo.propertyId, "ISSUE_TOKEN", flow.confirmMetadata.idempotencyKey);
    expect(recovered).toHaveProperty("result");
    if ("result" in recovered) {
      expect(recovered.result).not.toHaveProperty("tokenSecret");
    }

    const storedToken = await db.selectFrom("api_tokens").select("secret_hash").where("id", "=", tokenId).executeTakeFirstOrThrow();
    expect(storedToken.secret_hash).toBe(sha256(tokenSecret));
    const [receipts, previews, audits] = await Promise.all([
      db.selectFrom("command_receipts").select(["result", "error"]).execute(),
      db.selectFrom("command_previews").select(["normalized_input", "effect", "basis_versions"]).execute(),
      db.selectFrom("audit_entries").select(["reason", "metadata", "target_refs"]).execute()
    ]);
    expect(JSON.stringify({ receipts, previews, audits })).not.toContain(tokenSecret);
    expect(JSON.stringify(receipts)).not.toContain("qtp_");

    await db.updateTable("subject_property_grants").set({ access_level: "READ" })
      .where("subject_id", "=", demo.administratorSubjectId).where("property_id", "=", demo.propertyId).execute();
    try {
      await expect(getCommand(db, principal, flow.receipt.commandId)).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
    } finally {
      await db.updateTable("subject_property_grants").set({ access_level: "WRITE" })
        .where("subject_id", "=", demo.administratorSubjectId).where("property_id", "=", demo.propertyId).execute();
    }
    const outsidePrincipal: AuthPrincipal = {
      subjectId: demo.agentSubjectId,
      credentialId: "token_demo_write",
      credentialType: "TOKEN",
      displayName: "Demo Agent",
      ...emptyAuthScope()
    };
    await expect(getReceipt(db, outsidePrincipal, flow.receipt.receiptId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hashes a strong client-provided secret before the persistence boundary", async () => {
    const clientSecret = newOpaqueSecret("qtp");
    const flow = await execute({
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Client provisioned token",
        accessCeiling: "READ",
        commandCeiling: [],
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: clientSecret
      }
    }, "client-token");
    expect(flow.receipt.result).not.toHaveProperty("tokenSecret");
    const token = await db.selectFrom("api_tokens").select("secret_hash")
      .where("id", "=", flow.receipt.result?.tokenId as string).executeTakeFirstOrThrow();
    expect(token.secret_hash).toBe(sha256(clientSecret));
    expect(JSON.stringify(await getCommand(db, principal, flow.receipt.commandId))).not.toContain(clientSecret);
  });

  it("persists duplicate Token hash conflicts without rotating or revoking the source", async () => {
    const sourceSecret = newOpaqueSecret("qtp");
    const source = await execute({
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Duplicate rotation source",
        accessCeiling: "WRITE",
        commandCeiling: commandGrantsForProfile("ordinary"),
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: sourceSecret
      }
    }, "duplicate-hash-rotation-source");
    const sourceTokenId = source.receipt.result?.tokenId as string;

    const duplicateIssuePreview = await createCommandPreview(db, principal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Duplicate Token hash",
        accessCeiling: "WRITE",
        commandCeiling: commandGrantsForProfile("ordinary"),
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: sourceSecret
      }
    }, metadata("duplicate-hash-issue-preview"));
    const duplicateIssue = await confirmCommandPreview(db, principal, duplicateIssuePreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "ISSUE_TOKEN",
      confirmation: true,
      expectedEffectHash: duplicateIssuePreview.preview.effectHash,
      reason: { code: "DUPLICATE_HASH", note: "Duplicate Token hashes must produce a stable rejected Receipt" }
    }, metadata("duplicate-hash-issue-confirm"));
    expect(duplicateIssue).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "AGGREGATE_VERSION_CONFLICT" }
    });

    const rotationPreview = await createCommandPreview(db, principal, {
      commandType: "ROTATE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        tokenId: sourceTokenId,
        commandCeiling: commandGrantsForProfile("ordinary"),
        tokenSecret: sourceSecret
      }
    }, metadata("duplicate-hash-rotation-preview"));
    const rotationMetadata = metadata("duplicate-hash-rotation-confirm");
    const rejectedRotation = await confirmCommandPreview(db, principal, rotationPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "ROTATE_TOKEN",
      confirmation: true,
      expectedEffectHash: rotationPreview.preview.effectHash,
      reason: { code: "DUPLICATE_HASH", note: "A failed rotation must leave the source Token active" }
    }, rotationMetadata);
    expect(rejectedRotation).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "AGGREGATE_VERSION_CONFLICT" }
    });
    expect(await findCommandResult(db, principal, demo.propertyId, "ROTATE_TOKEN", rotationMetadata.idempotencyKey))
      .toMatchObject({ receiptId: rejectedRotation.receiptId, executionStatus: "NOT_EXECUTED" });
    const unchangedSource = await db.selectFrom("api_tokens").select(["revoked_at", "replaced_by_id"])
      .where("id", "=", sourceTokenId).executeTakeFirstOrThrow();
    expect(unchangedSource).toEqual({ revoked_at: null, replaced_by_id: null });
  });

  it("rejects foreign previews without audit pollution and revalidates a downgraded grant", async () => {
    const victimPreview = await createCommandPreview(db, principal, {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: "2026-12-01",
        departureDate: "2026-12-02",
        reason: "Foreign preview security test"
      }
    }, metadata("foreign-victim-preview"));
    const attackerSessionId = newId("session");
    await db.insertInto("web_sessions").values({
      id: attackerSessionId,
      subject_id: demo.operatorSubjectId,
      secret_hash: sha256(newOpaqueSecret("qts")),
      expires_at: "2029-01-01T00:00:00.000Z",
      revoked_at: null
    }).execute();
    const attacker: AuthPrincipal = {
      subjectId: demo.operatorSubjectId,
      credentialId: attackerSessionId,
      credentialType: "SESSION",
      displayName: "Demo Operator",
      ...authScope({ credentialType: "SESSION" })
    };
    const before = await Promise.all([
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    await expect(confirmCommandPreview(db, attacker, victimPreview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "LOCK_MAINTENANCE",
      confirmation: true,
      expectedEffectHash: victimPreview.preview.effectHash,
      reason: { code: "FOREIGN", note: "Must not observe or confirm another subject's Preview" }
    }, metadata("foreign-confirm"))).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    const after = await Promise.all([
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
    ]);
    expect(after.map((row) => Number(row.count))).toEqual(before.map((row) => Number(row.count)));

    const downgradePreview = await createCommandPreview(db, principal, {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: "2026-12-03",
        departureDate: "2026-12-04",
        reason: "Grant downgrade security test"
      }
    }, metadata("downgrade-preview"));
    await db.updateTable("subject_property_grants").set({ access_level: "READ" })
      .where("subject_id", "=", demo.administratorSubjectId).where("property_id", "=", demo.propertyId).execute();
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "LOCK_MAINTENANCE" as const,
      confirmation: true as const,
      expectedEffectHash: downgradePreview.preview.effectHash,
      reason: { code: "DOWNGRADED", note: "The current grant must be revalidated" }
    };
    const confirmMetadata = metadata("downgrade-confirm");
    const beforeDeniedConfirm = await authorizationArtifactCounts();
    try {
      await expect(confirmCommandPreview(db, principal, downgradePreview.preview.previewId, confirmation, confirmMetadata))
        .rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
      const afterDeniedConfirm = await authorizationArtifactCounts();
      expect(afterDeniedConfirm.slice(0, 4)).toEqual(beforeDeniedConfirm.slice(0, 4));
      expect(afterDeniedConfirm[4]).toBe(beforeDeniedConfirm[4]! + 1);
      expect(await db.selectFrom("maintenance_locks").select("id").where("arrival_date", "=", "2026-12-03").execute()).toHaveLength(0);
    } finally {
      await db.updateTable("subject_property_grants").set({ access_level: "WRITE" })
        .where("subject_id", "=", demo.administratorSubjectId).where("property_id", "=", demo.propertyId).execute();
    }
  });

  it("rejects confirmation after the credential used for Preview is revoked", async () => {
    const revocationWindowSecret = newOpaqueSecret("qtp");
    const issued = await execute({
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Revocation window token",
        accessCeiling: "WRITE",
        commandCeiling: ["LOCK_MAINTENANCE"],
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: revocationWindowSecret
      }
    }, "revocation-window-issue");
    const tokenId = issued.receipt.result?.tokenId as string;
    const revokedPrincipal: AuthPrincipal = {
      subjectId: demo.agentSubjectId,
      credentialId: tokenId,
      credentialType: "TOKEN",
      displayName: "Demo Agent",
      ...authScope()
    };
    const preview = await createCommandPreview(db, revokedPrincipal, {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: "2026-12-05",
        departureDate: "2026-12-06",
        reason: "Credential revocation security test"
      }
    }, metadata("revocation-window-preview"));

    await execute({
      commandType: "REVOKE_TOKEN",
      input: { propertyId: demo.propertyId, tokenId }
    }, "revocation-window-revoke");

    const beforeRevokedConfirm = await authorizationArtifactCounts();
    await expect(confirmCommandPreview(db, revokedPrincipal, preview.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "LOCK_MAINTENANCE",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "REVOKED_CREDENTIAL", note: "Revoked credentials must not confirm an existing Preview" }
    }, metadata("revocation-window-confirm"))).rejects.toMatchObject({ code: "TOKEN_REVOKED" });
    const afterRevokedConfirm = await authorizationArtifactCounts();
    expect(afterRevokedConfirm.slice(0, 4)).toEqual(beforeRevokedConfirm.slice(0, 4));
    expect(afterRevokedConfirm[4]).toBe(beforeRevokedConfirm[4]! + 1);
    expect(await db.selectFrom("maintenance_locks").select("id")
      .where("arrival_date", "=", "2026-12-05").execute()).toHaveLength(0);
  });

  it("protects command and Token identity while allowing normal state advancement and revocation", async () => {
    expect(await databaseReady(db, demoOwnerReadinessOptions)).toBe(true);
    const immutableSecret = newOpaqueSecret("qtp");
    const flow = await execute({
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Immutable security token",
        accessCeiling: "READ",
        commandCeiling: [],
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: immutableSecret
      }
    }, "immutable-token");
    const tokenId = flow.receipt.result?.tokenId as string;
    await expect(db.updateTable("command_executions").set({ correlation_id: "tampered" })
      .where("id", "=", flow.receipt.commandId).execute()).rejects.toThrow(/identity is immutable/);
    await expect(db.updateTable("api_tokens").set({ access_ceiling: "WRITE" })
      .where("id", "=", tokenId).execute()).rejects.toThrow(/identity is immutable/);
    await expect(db.updateTable("api_tokens").set({ secret_hash: "0".repeat(64) })
      .where("id", "=", tokenId).execute()).rejects.toThrow(/identity is immutable/);
    const replacementSecret = newOpaqueSecret("qtp");
    const rotation = await execute({
      commandType: "ROTATE_TOKEN",
      input: { propertyId: demo.propertyId, tokenId, commandCeiling: [], tokenSecret: replacementSecret }
    }, "immutable-token-rotation");
    const replacementTokenId = rotation.receipt.result?.tokenId as string;
    expect(await db.selectFrom("api_tokens").select(["revoked_at", "replaced_by_id"])
      .where("id", "=", tokenId).executeTakeFirstOrThrow()).toMatchObject({
      revoked_at: expect.any(Date),
      replaced_by_id: replacementTokenId
    });
    await db.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", replacementTokenId).execute();
    await expect(db.updateTable("api_tokens").set({ replaced_by_id: "token_demo_read" })
      .where("id", "=", replacementTokenId).execute()).rejects.toThrow(/state may only advance once/);
  });
});
