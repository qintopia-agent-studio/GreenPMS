import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  findCommandResult,
  type Database
} from "@qintopia/db";
import { newOpaqueSecret, sha256 } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.COMMAND_PROTOCOL_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_command_protocol";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function waitForUnknown(commandType: string, idempotencyKey: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await findCommandResult(db, principal, demo.propertyId, commandType, idempotencyKey);
    if (result.executionStatus === "UNKNOWN") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the active command execution lock");
}

async function waitForBlockedEntitlementOwner() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ waiting: boolean }>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state = 'active'
          and wait_event_type = 'Lock'
          and query ilike '%member_contracts%'
      ) as waiting
    `.execute(db);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the command owner to reach the entitlement row blocker");
}

async function waitForInventoryLockWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ waiting: boolean }>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state = 'active'
          and wait_event_type = 'Lock'
          and query like '%inventory_room_days%'
      ) as waiting
    `.execute(db);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the owner Confirm to block on its inventory day");
}

async function waitForPreviewInsertLockWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ waiting: boolean }>`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state = 'active'
          and wait_event_type = 'Lock'
          and query like '%command_previews%'
      ) as waiting
    `.execute(db);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Preview insert blocker");
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("durable command protocol", () => {
  it("sanitizes a client-generated Token secret before any persistence and replays one durable result", async () => {
    const tokenSecret = newOpaqueSecret("qtp");
    const envelope: CommandEnvelope = {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label: "Recoverable client-held secret",
        accessCeiling: "READ",
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret
      }
    };
    const previewMetadata = metadata("token-preview");
    const preview = await createCommandPreview(db, principal, envelope, previewMetadata);
    const storedPreview = await db.selectFrom("command_previews")
      .select(["normalized_input", "effect", "basis_versions"])
      .where("id", "=", preview.preview.previewId)
      .executeTakeFirstOrThrow();

    expect(JSON.stringify({ preview, storedPreview })).not.toContain(tokenSecret);
    expect(storedPreview.normalized_input).toMatchObject({ tokenSecretHash: sha256(tokenSecret) });
    expect(storedPreview.normalized_input).not.toHaveProperty("tokenSecret");

    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "ISSUE_TOKEN" as const,
      confirmation: true as const,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "TOKEN_ACCEPTANCE", note: "Client retains the only raw Token secret" }
    };
    const confirmMetadata = metadata("token-confirm");
    const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
    const replay = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
    const recovered = await findCommandResult(db, principal, demo.propertyId, "ISSUE_TOKEN", confirmMetadata.idempotencyKey);
    const token = await db.selectFrom("api_tokens")
      .select("secret_hash")
      .where("id", "=", receipt.result!.tokenId as string)
      .executeTakeFirstOrThrow();
    const persistedArtifacts = await Promise.all([
      db.selectFrom("command_receipts").select(["result", "error"]).execute(),
      db.selectFrom("audit_entries").select(["reason", "metadata", "target_refs"]).execute()
    ]);

    expect(token.secret_hash).toBe(sha256(tokenSecret));
    expect(receipt.result).not.toHaveProperty("tokenSecret");
    expect(replay).toEqual(receipt);
    expect(recovered).toEqual(receipt);
    expect(JSON.stringify(persistedArtifacts)).not.toContain(tokenSecret);

    const weakEnvelope: CommandEnvelope = {
      ...envelope,
      input: { ...envelope.input, tokenSecret: `qtp_${"A".repeat(43)}` }
    };
    await expect(createCommandPreview(db, principal, weakEnvelope, metadata("weak-token")))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createCommandPreview(db, principal, {
      ...envelope,
      input: { ...envelope.input, expiresAt: "2031-01-01T00:00:00.000Z" }
    }, metadata("overlong-token"))).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });
  });

  it("serializes concurrent Token lifecycle confirmations without a shared-lock upgrade deadlock", async () => {
    const prepareIssue = async (label: string) => createCommandPreview(db, principal, {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: demo.propertyId,
        subjectId: demo.agentSubjectId,
        label,
        accessCeiling: "READ",
        expiresAt: "2029-01-01T00:00:00.000Z",
        tokenSecret: newOpaqueSecret("qtp")
      }
    }, metadata(`${label}-preview`));
    const [first, second] = await Promise.all([
      prepareIssue("Concurrent Token A"),
      prepareIssue("Concurrent Token B")
    ]);

    const confirmIssue = (prepared: Awaited<ReturnType<typeof prepareIssue>>, label: string) => confirmCommandPreview(
      db,
      principal,
      prepared.preview.previewId,
      {
        propertyId: demo.propertyId,
        commandType: "ISSUE_TOKEN",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "TOKEN_CONCURRENCY", note: `Confirm ${label} under one subject lock` }
      },
      metadata(`${label}-confirm`)
    );
    const receipts = await Promise.all([
      confirmIssue(first, "Token A"),
      confirmIssue(second, "Token B")
    ]);

    expect(receipts.every((receipt) => receipt.executionStatus === "EXECUTED" && receipt.businessCommitted)).toBe(true);
    expect(new Set(receipts.map((receipt) => receipt.result?.tokenId)).size).toBe(2);
  });

  it("fences concurrent same-key Preview creation without leaking a serialization failure", async () => {
    const blockerLock = "qintopia:test:preview-idempotency-owner";
    await sql.raw(`
      CREATE OR REPLACE FUNCTION block_preview_idempotency_owner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${blockerLock}', 0::bigint));
        RETURN NEW;
      END $$;
      CREATE TRIGGER block_preview_idempotency_owner_before_insert BEFORE INSERT ON command_previews
      FOR EACH ROW EXECUTE FUNCTION block_preview_idempotency_owner();
    `).execute(db);

    let releaseBlocker!: () => void;
    let reportLocked!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const blocker = db.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(hashtextextended(${blockerLock}, 0::bigint))`.execute(connection);
      reportLocked();
      await blockerGate;
      await sql`select pg_advisory_unlock(hashtextextended(${blockerLock}, 0::bigint))`.execute(connection);
    });
    await locked;

    const envelope: CommandEnvelope = {
      commandType: "LOCK_MAINTENANCE",
      input: {
        propertyId: demo.propertyId,
        inventoryUnitId: demo.secondRoomId,
        arrivalDate: "2028-06-20",
        departureDate: "2028-06-21",
        reason: "Concurrent Preview idempotency fence"
      }
    };
    const commandMetadata = metadata("preview-concurrent-same-key");
    const owner = createCommandPreview(db, principal, envelope, commandMetadata);
    try {
      await waitForPreviewInsertLockWait();
      await expect(createCommandPreview(db, principal, envelope, commandMetadata))
        .rejects.toMatchObject({ code: "COMMAND_STATUS_UNKNOWN", retryable: true });
    } finally {
      releaseBlocker();
      await blocker;
    }

    const completed = await owner;
    const replay = await createCommandPreview(db, principal, envelope, commandMetadata);
    expect(replay).toEqual(completed);
    const [executions, previews, receipts] = await Promise.all([
      db.selectFrom("command_executions").select("id")
        .where("command_type", "=", "PREVIEW:LOCK_MAINTENANCE")
        .where("idempotency_key", "=", commandMetadata.idempotencyKey)
        .execute(),
      db.selectFrom("command_previews").select("id").execute(),
      db.selectFrom("command_receipts")
        .innerJoin("command_executions", "command_executions.id", "command_receipts.command_id")
        .select("command_receipts.id")
        .where("command_executions.command_type", "=", "PREVIEW:LOCK_MAINTENANCE")
        .where("command_executions.idempotency_key", "=", commandMetadata.idempotencyKey)
        .execute()
    ]);
    expect(executions).toHaveLength(1);
    expect(previews).toHaveLength(1);
    expect(receipts).toHaveLength(1);
  });

  it("returns a durable PREVIEW_STALE Receipt when Token expiry crosses before Confirm", async () => {
    const baseNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    try {
      const tokenSecret = newOpaqueSecret("qtp");
      const preview = await createCommandPreview(db, principal, {
        commandType: "ISSUE_TOKEN",
        input: {
          propertyId: demo.propertyId,
          subjectId: demo.agentSubjectId,
          label: "Expiring Preview Token",
          accessCeiling: "READ",
          expiresAt: new Date(baseNow + 60_000).toISOString(),
          tokenSecret
        }
      }, metadata("expiring-token-preview"));
      now.mockReturnValue(baseNow + 120_000);

      const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "ISSUE_TOKEN",
        confirmation: true,
        expectedEffectHash: preview.preview.effectHash,
        reason: { code: "TOKEN_EXPIRY", note: "Confirm after the proposed Token expiry" }
      }, metadata("expiring-token-confirm"));

      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE", details: { causeCode: "VALIDATION_ERROR" } }
      });
      expect(await db.selectFrom("api_tokens").select("id").where("secret_hash", "=", sha256(tokenSecret)).executeTakeFirst())
        .toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it("expires a Preview durably and rejects confirmation with zero business writes", async () => {
    const baseNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    try {
      const preview = await createCommandPreview(db, principal, {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate: "2028-06-01",
          departureDate: "2028-06-02",
          reason: "Expired Preview acceptance"
        }
      }, metadata("ttl-preview"));
      now.mockReturnValue(baseNow + 601_000);

      const confirmMetadata = metadata("ttl-confirm");
      const confirmation = {
        propertyId: demo.propertyId,
        commandType: "LOCK_MAINTENANCE" as const,
        confirmation: true as const,
        expectedEffectHash: preview.preview.effectHash,
        reason: { code: "TTL_ACCEPTANCE", note: "Expired Preview must never apply" }
      };
      const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
      const replay = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
      const secondMetadata = metadata("ttl-second-confirm");
      const secondReceipt = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, secondMetadata);
      const storedPreview = await db.selectFrom("command_previews")
        .select(["status", "used_at"])
        .where("id", "=", preview.preview.previewId)
        .executeTakeFirstOrThrow();
      const [maintenanceLocks, inventoryClaims] = await Promise.all([
        db.selectFrom("maintenance_locks").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("inventory_claims").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
      ]);

      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE", details: { causeCode: "PREVIEW_EXPIRED" } },
        resourceRefs: [],
        factRefs: []
      });
      expect(replay).toEqual(receipt);
      expect(secondReceipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE", details: { causeCode: "PREVIEW_EXPIRED" } },
        resourceRefs: [],
        factRefs: []
      });
      expect(secondReceipt.receiptId).not.toBe(receipt.receiptId);
      expect(secondReceipt.commandId).not.toBe(receipt.commandId);
      expect(await findCommandResult(db, principal, demo.propertyId, "LOCK_MAINTENANCE", confirmMetadata.idempotencyKey)).toEqual(receipt);
      expect(await findCommandResult(db, principal, demo.propertyId, "LOCK_MAINTENANCE", secondMetadata.idempotencyKey)).toEqual(secondReceipt);
      expect(storedPreview).toEqual({ status: "EXPIRED", used_at: null });
      expect(Number(maintenanceLocks.count)).toBe(0);
      expect(Number(inventoryClaims.count)).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it("exposes UNKNOWN while a visible execution claim is blocked, then resolves to EXECUTED", async () => {
    const preview = await createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: demo.roomLotId,
        quantityDelta: 1,
        adjustmentReason: "Command recovery concurrency acceptance"
      }
    }, metadata("blocked-preview"));
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "ADJUST_MEMBER_ENTITLEMENT" as const,
      confirmation: true as const,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "RECOVERY_ACCEPTANCE", note: "Observe the durable in-flight state" }
    };
    const confirmMetadata = metadata("blocked-confirm");
    const ledgerCountBefore = await db.selectFrom("entitlement_ledger")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();

    let releaseBlocker!: () => void;
    let reportLocked!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("member_contracts")
        .select("id")
        .where("id", "=", demo.memberContractId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      reportLocked();
      await blockerGate;
    });
    await locked;

    const confirmationPromise = confirmCommandPreview(
      db,
      principal,
      preview.preview.previewId,
      confirmation,
      confirmMetadata
    );
    try {
      await waitForBlockedEntitlementOwner();
      expect(await waitForUnknown("ADJUST_MEMBER_ENTITLEMENT", confirmMetadata.idempotencyKey))
        .toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
      const ledgerCountDuring = await db.selectFrom("entitlement_ledger")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      expect(Number(ledgerCountDuring.count)).toBe(Number(ledgerCountBefore.count));
    } finally {
      releaseBlocker();
    }

    await blocker;
    const receipt = await confirmationPromise;
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    expect(await findCommandResult(db, principal, demo.propertyId, "ADJUST_MEMBER_ENTITLEMENT", confirmMetadata.idempotencyKey))
      .toEqual(receipt);
  });

  it("rejects more concurrent same-key retries than the pool size without starving unrelated queries", async () => {
    const preview = await createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: demo.roomLotId,
        quantityDelta: 1,
        adjustmentReason: "Connection pool resilience acceptance"
      }
    }, metadata("pool-preview"));
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "ADJUST_MEMBER_ENTITLEMENT" as const,
      confirmation: true as const,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "POOL_RESILIENCE", note: "Concurrent retry must not wait behind the active owner" }
    };
    const confirmMetadata = metadata("pool-confirm");

    let releaseBlocker!: () => void;
    let reportBlocked!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("member_contracts")
        .select("id")
        .where("id", "=", demo.memberContractId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      reportBlocked();
      await blockerGate;
    });
    await blocked;

    const owner = confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
    await waitForBlockedEntitlementOwner();
    await waitForUnknown("ADJUST_MEMBER_ENTITLEMENT", confirmMetadata.idempotencyKey);
    try {
      const retryOutcome = await Promise.race([
        Promise.allSettled(Array.from({ length: 24 }, () => (
          confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata)
        ))),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Same-key retries exhausted the connection pool")), 2_000))
      ]);
      expect(retryOutcome).toHaveLength(24);
      for (const outcome of retryOutcome) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(outcome.reason).toMatchObject({ code: "COMMAND_STATUS_UNKNOWN", retryable: true });
        }
      }

      const independentQuery = await Promise.race([
        db.selectFrom("properties").select("id").where("id", "=", demo.propertyId).executeTakeFirstOrThrow(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("An unrelated query could not obtain a pooled connection")), 1_000))
      ]);
      expect(independentQuery.id).toBe(demo.propertyId);
    } finally {
      releaseBlocker();
    }

    await blocker;
    await expect(owner).resolves.toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  });

  it("lets different idempotency keys for one subject complete without starving the pool behind a blocked owner", async () => {
    const prepareMaintenance = async (arrivalDate: string, departureDate: string, prefix: string) => {
      const preview = await createCommandPreview(db, principal, {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: demo.propertyId,
          inventoryUnitId: demo.secondRoomId,
          arrivalDate,
          departureDate,
          reason: `Pool isolation acceptance for ${arrivalDate}`
        }
      }, metadata(`${prefix}-preview`));
      return {
        previewId: preview.preview.previewId,
        confirmation: {
          propertyId: demo.propertyId,
          commandType: "LOCK_MAINTENANCE" as const,
          confirmation: true as const,
          expectedEffectHash: preview.preview.effectHash,
          reason: { code: "POOL_KEY_ISOLATION", note: `Confirm independent maintenance for ${arrivalDate}` }
        },
        confirmMetadata: metadata(`${prefix}-confirm`)
      };
    };

    const ownerDate = "2028-06-01";
    const ownerCommand = await prepareMaintenance(ownerDate, "2028-06-02", "different-key-owner");
    const competitors = [];
    for (let day = 2; day <= 19; day += 1) {
      const arrivalDate = `2028-06-${String(day).padStart(2, "0")}`;
      const departureDate = `2028-06-${String(day + 1).padStart(2, "0")}`;
      competitors.push(await prepareMaintenance(arrivalDate, departureDate, `different-key-${day}`));
    }

    await db.insertInto("inventory_room_days")
      .values({ room_id: demo.secondRoomId, service_date: ownerDate, whole_claim_id: null, version: 0 })
      .onConflict((oc) => oc.columns(["room_id", "service_date"]).doNothing())
      .execute();
    let releaseBlocker!: () => void;
    let reportBlocked!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("inventory_room_days")
        .select("room_id")
        .where("room_id", "=", demo.secondRoomId)
        .where("service_date", "=", ownerDate)
        .forUpdate()
        .executeTakeFirstOrThrow();
      reportBlocked();
      await blockerGate;
    });
    await blocked;

    const owner = confirmCommandPreview(
      db,
      principal,
      ownerCommand.previewId,
      ownerCommand.confirmation,
      ownerCommand.confirmMetadata
    );
    await waitForInventoryLockWait();
    expect(await findCommandResult(db, principal, demo.propertyId, "LOCK_MAINTENANCE", ownerCommand.confirmMetadata.idempotencyKey))
      .toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });

    const competingConfirmations = competitors.map((command) => confirmCommandPreview(
      db,
      principal,
      command.previewId,
      command.confirmation,
      command.confirmMetadata
    ));
    const allCompetitors = Promise.all(competingConfirmations);
    try {
      const independentQuery = await Promise.race([
        db.selectFrom("properties").select("id").where("id", "=", demo.propertyId).executeTakeFirstOrThrow(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Different-key commands starved an unrelated query")), 2_000))
      ]);
      expect(independentQuery.id).toBe(demo.propertyId);

      const receipts = await Promise.race([
        allCompetitors,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Different-key commands exhausted the connection pool")), 5_000))
      ]);
      expect(receipts).toHaveLength(18);
      expect(receipts.every((receipt) => receipt.executionStatus === "EXECUTED" && receipt.businessCommitted)).toBe(true);
      expect(await findCommandResult(db, principal, demo.propertyId, "LOCK_MAINTENANCE", ownerCommand.confirmMetadata.idempotencyKey))
        .toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
    } finally {
      releaseBlocker();
      await blocker;
      await owner;
      await Promise.allSettled(competingConfirmations);
    }

    await expect(findCommandResult(db, principal, demo.propertyId, "LOCK_MAINTENANCE", ownerCommand.confirmMetadata.idempotencyKey))
      .resolves.toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  });
});
