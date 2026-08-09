import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CreateQuoteCommandInputDto } from "@qintopia/contracts";
import {
  executeQuoteCommand,
  findCommandResult,
  getCommand,
  getReceipt,
  resolveCommandResult,
  type Database
} from "@qintopia/db";
import { stableHash } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.QUOTE_COMMAND_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_quote_command";

const readPrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_read",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "READ"]])
};

const baseInput: CreateQuoteCommandInputDto = {
  propertyId: demo.propertyId,
  inventoryUnitId: demo.roomId,
  stayType: "TRANSIENT",
  arrivalDate: "2028-08-10",
  departureDate: "2028-08-12",
  pricingPolicyVersionId: demo.transientPolicyId,
  memberContractId: demo.memberContractId
};

let db: Kysely<Database>;

function metadata(key: string) {
  return { idempotencyKey: key, correlationId: `correlation-${key}` };
}

async function artifactCounts() {
  const [quotes, executions, receipts, audits] = await Promise.all([
    db.selectFrom("quotes").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("audit_entries").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [quotes, executions, receipts, audits].map((row) => Number(row.count));
}

async function waitForUnknown(idempotencyKey: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", idempotencyKey);
    if (result.executionStatus === "UNKNOWN") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the active CREATE_QUOTE command lock");
}

async function waitForBlockedQuoteOwner() {
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
          and query ilike '%quotes%'
      ) as waiting
    `.execute(db);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the CREATE_QUOTE owner to reach the quote insert blocker");
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("recoverable CREATE_QUOTE command on PostgreSQL", () => {
  it("durably fences an absent Quote key, replays that fence, and blocks a delayed Quote", async () => {
    const commandMetadata = metadata("quote-recovery-fence");
    const fenced = await resolveCommandResult(
      db,
      readPrincipal,
      {
        propertyId: demo.propertyId,
        commandType: "CREATE_QUOTE",
        idempotencyKey: commandMetadata.idempotencyKey
      },
      metadata("quote-recovery-fence-resolution")
    );
    const replay = await resolveCommandResult(
      db,
      readPrincipal,
      {
        propertyId: demo.propertyId,
        commandType: "CREATE_QUOTE",
        idempotencyKey: commandMetadata.idempotencyKey
      },
      metadata("quote-recovery-fence-retry")
    );

    expect(fenced).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      correlationId: "correlation-quote-recovery-fence-resolution",
      error: { code: "COMMAND_INTERRUPTED", retryable: false },
      resourceRefs: [],
      factRefs: []
    });
    expect(replay).toEqual(fenced);
    expect(await artifactCounts()).toEqual([0, 1, 1, 1]);

    await expect(executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", retryable: false });
    expect(await artifactCounts()).toEqual([0, 1, 1, 1]);
    await expect(findCommandResult(
      db,
      readPrincipal,
      demo.propertyId,
      "CREATE_QUOTE",
      commandMetadata.idempotencyKey
    )).resolves.toEqual(fenced);
  });

  it("requires both command headers before creating any artifact", async () => {
    await expect(executeQuoteCommand(db, readPrincipal, baseInput, {
      idempotencyKey: undefined,
      correlationId: "missing-idempotency"
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(executeQuoteCommand(db, readPrincipal, baseInput, {
      idempotencyKey: "missing-correlation",
      correlationId: undefined
    })).rejects.toMatchObject({ code: "CORRELATION_ID_REQUIRED" });
    expect(await artifactCounts()).toEqual([0, 0, 0, 0]);
  });

  it("commits one Quote, execution, permanent Receipt, and audit reference then replays and recovers them", async () => {
    const commandMetadata = { ...metadata("quote-replay"), idempotencyKey: " quote-replay " };
    const first = await executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata);
    const replay = await executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata);
    const recovered = await findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", commandMetadata.idempotencyKey);
    const byCommand = await getCommand(db, readPrincipal, first.receipt.commandId);
    const byReceipt = await getReceipt(db, readPrincipal, first.receipt.receiptId);

    expect(replay).toEqual(first);
    expect(recovered).toEqual(first.receipt);
    expect(byCommand).toEqual(first.receipt);
    expect(byReceipt).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: commandMetadata.correlationId,
      result: { quote: first.quote },
      resourceRefs: [first.quote.quoteId],
      factRefs: []
    });

    const [quote, execution, receipt, audit] = await Promise.all([
      db.selectFrom("quotes").selectAll().executeTakeFirstOrThrow(),
      db.selectFrom("command_executions").selectAll().executeTakeFirstOrThrow(),
      db.selectFrom("command_receipts").selectAll().executeTakeFirstOrThrow(),
      db.selectFrom("audit_entries").selectAll().executeTakeFirstOrThrow()
    ]);
    expect(quote).toMatchObject({ id: first.quote.quoteId, requester_subject_id: readPrincipal.subjectId });
    expect(execution).toMatchObject({
      id: first.receipt.commandId,
      credential_id: "token_demo_read",
      command_type: "CREATE_QUOTE",
      request_hash: stableHash(baseInput),
      correlation_id: commandMetadata.correlationId,
      state: "APPLIED"
    });
    expect(receipt).toMatchObject({ id: first.receipt.receiptId, command_id: execution.id, resource_refs: [quote.id], fact_refs: [] });
    expect(audit).toMatchObject({
      action: "CREATE_QUOTE",
      decision: "ALLOWED",
      command_id: execution.id,
      correlation_id: commandMetadata.correlationId,
      reason: null,
      target_refs: [quote.id],
      metadata: { quoteInputHash: first.quote.inputHash }
    });
    expect(await artifactCounts()).toEqual([1, 1, 1, 1]);

    await db.updateTable("api_tokens")
      .set({ revoked_at: new Date() })
      .where("id", "=", readPrincipal.credentialId)
      .execute();
    await expect(resolveCommandResult(
      db,
      readPrincipal,
      {
        propertyId: demo.propertyId,
        commandType: "CREATE_QUOTE",
        idempotencyKey: commandMetadata.idempotencyKey
      },
      metadata("quote-existing-revoked-recovery")
    )).rejects.toMatchObject({ code: "TOKEN_REVOKED", retryable: false });
  });

  it("canonicalizes an omitted paid stay type before hashing and persistence", async () => {
    const input: CreateQuoteCommandInputDto = {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_104",
      arrivalDate: "2026-07-26",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: demo.publicPricingPolicyId
    };
    const result = await executeQuoteCommand(db, readPrincipal, input, metadata("quote-derived-type"));
    expect(result.quote).toMatchObject({
      stayType: "CUSTOM",
      currentContractAmount: { minorUnits: 176_000 },
      cashLines: [expect.objectContaining({
        lineKind: "STAY_TOTAL",
        pricingBandAnchorNights: 7,
        amount: { currency: "CNY", minorUnits: 176_000 }
      })],
      pricingExplanation: {
        durationBand: {
          segments: [expect.objectContaining({
            pricingProductCode: "shared_bath_quad_whole_room",
            nights: 10,
            anchorAmount: { currency: "CNY", minorUnits: 123_200 }
          })]
        }
      }
    });
    const execution = await db.selectFrom("command_executions").select("request_hash").executeTakeFirstOrThrow();
    expect(execution.request_hash).toBe(stableHash({ ...input, stayType: "CUSTOM" }));
  });

  it("rejects a reused key with a different payload without changing the committed result", async () => {
    const commandMetadata = metadata("quote-conflict");
    const first = await executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata);
    await expect(executeQuoteCommand(db, readPrincipal, {
      ...baseInput,
      departureDate: "2028-08-13"
    }, commandMetadata)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", retryable: false });
    expect(await artifactCounts()).toEqual([1, 1, 1, 1]);
    await expect(findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", commandMetadata.idempotencyKey))
      .resolves.toEqual(first.receipt);
  });

  it("keeps an expired Quote resolvable through its permanent Receipt resource reference", async () => {
    const first = await executeQuoteCommand(db, readPrincipal, baseInput, metadata("quote-permanent-reference"));
    await db.updateTable("quotes")
      .set({ expires_at: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where("id", "=", first.quote.quoteId)
      .execute();

    await executeQuoteCommand(db, readPrincipal, {
      ...baseInput,
      arrivalDate: "2028-08-13",
      departureDate: "2028-08-15"
    }, metadata("quote-after-expiry"));

    expect(await db.selectFrom("quotes").select("id").where("id", "=", first.quote.quoteId).executeTakeFirst())
      .toEqual({ id: first.quote.quoteId });
    expect(await getReceipt(db, readPrincipal, first.receipt.receiptId)).toEqual(first.receipt);
  });

  it("never cleans or counts Quotes outside the command property scope", async () => {
    const otherPropertyId = "prop_quote_scope_other";
    const otherUnitId = "unit_quote_scope_other";
    const otherPolicyId = "policy_quote_scope_other";
    const otherQuoteId = "quote_quote_scope_other_expired";
    await db.insertInto("properties").values({
      id: otherPropertyId, code: "Q-SCOPE", name: "Quote Scope Other", timezone: "Asia/Shanghai", currency: "CNY"
    }).execute();
    await db.insertInto("inventory_units").values({
      id: otherUnitId, property_id: otherPropertyId, kind: "ROOM", parent_room_id: null,
      code: "Q-201", name: "Quote Scope Room", active: true
    }).execute();
    await db.insertInto("pricing_policy_versions").values({
      id: otherPolicyId, property_id: otherPropertyId, code: "Q-SCOPE-TRANSIENT", version: 1,
      stay_type: "TRANSIENT", calculation_kind: "FLAT_NIGHTLY", nightly_rate_minor: 10_000,
      currency: "CNY", status: "PUBLISHED"
    }).execute();
    await db.insertInto("quotes").values({
      id: otherQuoteId,
      property_id: otherPropertyId,
      inventory_unit_id: otherUnitId,
      stay_type: "TRANSIENT",
      arrival_date: "2028-01-01",
      departure_date: "2028-01-02",
      policy_version_id: otherPolicyId,
      member_contract_id: null,
      requester_subject_id: readPrincipal.subjectId,
      input_hash: "a".repeat(64),
      coverage_set: [],
      cash_lines: [],
      cash_remainder_minor: 10_000,
      current_contract_amount_minor: 10_000,
      currency: "CNY",
      expires_at: "2020-01-01T00:00:00.000Z"
    }).execute();

    await executeQuoteCommand(db, readPrincipal, baseInput, metadata("quote-property-scope"));
    await expect(db.selectFrom("quotes").select("id").where("id", "=", otherQuoteId).executeTakeFirst())
      .resolves.toEqual({ id: otherQuoteId });
  });

  it("serializes concurrent same-key requests to one Quote and one Receipt", async () => {
    const commandMetadata = metadata("quote-concurrent");
    const outcomes = await Promise.allSettled([
      executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata),
      executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata)
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of fulfilled) expect(result).toEqual(fulfilled[0]);
    for (const error of rejected) expect(error).toMatchObject({ code: "COMMAND_STATUS_UNKNOWN", retryable: true });
    expect(await executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata)).toEqual(fulfilled[0]);
    expect(await artifactCounts()).toEqual([1, 1, 1, 1]);
  });

  it("replays a completed key while a different Quote command holds the quota lock", async () => {
    const completedMetadata = metadata("quote-completed-before-quota-owner");
    const completed = await executeQuoteCommand(db, readPrincipal, baseInput, completedMetadata);
    const blockerLock = "qintopia:test:quote-replay-before-quota";
    await sql.raw(`
      CREATE OR REPLACE FUNCTION block_second_quote_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${blockerLock}', 0::bigint));
        RETURN NEW;
      END $$;
      CREATE TRIGGER block_second_quote_command_before_insert BEFORE INSERT ON quotes
      FOR EACH ROW EXECUTE FUNCTION block_second_quote_command();
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

    const ownerMetadata = metadata("quote-different-quota-owner");
    const owner = executeQuoteCommand(db, readPrincipal, {
      ...baseInput,
      arrivalDate: "2028-08-16",
      departureDate: "2028-08-18"
    }, ownerMetadata);
    try {
      await waitForBlockedQuoteOwner();
      await waitForUnknown(ownerMetadata.idempotencyKey);
      await expect(Promise.race([
        executeQuoteCommand(db, readPrincipal, baseInput, completedMetadata),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Completed replay waited for an unrelated quota lock")), 1_000))
      ])).resolves.toEqual(completed);
    } finally {
      releaseBlocker();
    }
    await blocker;
    await owner;
  });

  it("reports UNKNOWN while the owner is active and resolves to its durable Receipt", async () => {
    const blockerLock = "qintopia:test:quote-command-blocker";
    await sql.raw(`
      CREATE OR REPLACE FUNCTION block_quote_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${blockerLock}', 0::bigint));
        RETURN NEW;
      END $$;
      CREATE TRIGGER block_quote_command_before_insert BEFORE INSERT ON quotes
      FOR EACH ROW EXECUTE FUNCTION block_quote_command();
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

    const commandMetadata = metadata("quote-in-flight");
    const owner = executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata);
    try {
      await waitForBlockedQuoteOwner();
      expect(await waitForUnknown(commandMetadata.idempotencyKey))
        .toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
      expect(await resolveCommandResult(
        db,
        readPrincipal,
        {
          propertyId: demo.propertyId,
          commandType: "CREATE_QUOTE",
          idempotencyKey: commandMetadata.idempotencyKey
        },
        metadata("quote-in-flight-recovery")
      )).toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
      expect(await artifactCounts()).toEqual([0, 0, 0, 0]);
      const retryOutcomes = await Promise.race([
        Promise.allSettled(Array.from({ length: 24 }, () => (
          executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata)
        ))),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Quote retries exhausted the connection pool")), 2_000))
      ]);
      expect(retryOutcomes).toHaveLength(24);
      for (const outcome of retryOutcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "COMMAND_STATUS_UNKNOWN", retryable: true });
      }
      await expect(Promise.race([
        db.selectFrom("properties").select("id").where("id", "=", demo.propertyId).executeTakeFirstOrThrow(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Quote retries starved an unrelated query")), 1_000))
      ])).resolves.toMatchObject({ id: demo.propertyId });
    } finally {
      releaseBlocker();
    }
    await blocker;
    const result = await owner;
    expect(await findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", commandMetadata.idempotencyKey))
      .toEqual(result.receipt);
    expect(await artifactCounts()).toEqual([1, 1, 1, 1]);
  });

  it("rolls back Quote, execution, Receipt, and audit when either pricing or Receipt persistence fails", async () => {
    const pricingFailureMetadata = metadata("quote-pricing-failure");
    await expect(executeQuoteCommand(db, readPrincipal, {
      ...baseInput,
      stayType: "WEEKLY"
    }, pricingFailureMetadata)).rejects.toMatchObject({ code: "PRICING_POLICY_UNCONFIGURED" });
    expect(await artifactCounts()).toEqual([0, 0, 0, 0]);
    await expect(findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", pricingFailureMetadata.idempotencyKey))
      .resolves.toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });

    await sql.raw(`
      CREATE OR REPLACE FUNCTION fail_quote_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced quote receipt failure'; END $$;
      CREATE TRIGGER fail_quote_receipt_before_insert BEFORE INSERT ON command_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_quote_receipt();
    `).execute(db);
    const receiptFailureMetadata = metadata("quote-receipt-failure");
    await expect(executeQuoteCommand(db, readPrincipal, baseInput, receiptFailureMetadata)).rejects.toBeDefined();
    expect(await artifactCounts()).toEqual([0, 0, 0, 0]);
    await expect(findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", receiptFailureMetadata.idempotencyKey))
      .resolves.toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
    await sql.raw("DROP TRIGGER fail_quote_receipt_before_insert ON command_receipts").execute(db);
    await expect(executeQuoteCommand(db, readPrincipal, baseInput, receiptFailureMetadata))
      .resolves.toMatchObject({ receipt: { executionStatus: "EXECUTED", businessCommitted: true } });
    expect(await artifactCounts()).toEqual([1, 1, 1, 1]);
  });

  it("rolls back every artifact when the final audit insert fails", async () => {
    await sql.raw(`
      CREATE OR REPLACE FUNCTION fail_quote_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced quote audit failure'; END $$;
      CREATE TRIGGER fail_quote_audit_before_insert BEFORE INSERT ON audit_entries
      FOR EACH ROW EXECUTE FUNCTION fail_quote_audit();
    `).execute(db);
    const commandMetadata = metadata("quote-audit-failure");
    await expect(executeQuoteCommand(db, readPrincipal, baseInput, commandMetadata)).rejects.toBeDefined();
    expect(await artifactCounts()).toEqual([0, 0, 0, 0]);
    await expect(findCommandResult(db, readPrincipal, demo.propertyId, "CREATE_QUOTE", commandMetadata.idempotencyKey))
      .resolves.toEqual({ executionStatus: "UNKNOWN", businessCommitted: false });
  });
});
