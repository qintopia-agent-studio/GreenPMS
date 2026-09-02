import type { AuthPrincipal, CommandEnvelope, CommandType } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, createDatabase, executeQuoteCommand, type Database } from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { pathToFileURL } from "node:url";
import { newId, ordinaryStaffCommandGrants, sha256 } from "@qintopia/domain";
import { demo } from "../../packages/db/src/seed.ts";
import { authScope } from "./auth-principals.ts";

async function runCommand(db: Kysely<Database>, principal: AuthPrincipal, commandType: CommandType, input: Record<string, unknown>, reference: string) {
  const preview = await createCommandPreview(db, principal, { commandType, input } as CommandEnvelope, {
    idempotencyKey: `${reference}-preview`,
    correlationId: reference
  });
  return confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: demo.propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "RESTORE_FIXTURE", note: "Create deterministic non-empty backup/restore acceptance facts" }
  }, {
    idempotencyKey: `${reference}-confirm`,
    correlationId: reference
  });
}

async function relationExists(db: Kysely<Database>, relationName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT to_regclass(${`public.${relationName}`}) IS NOT NULL AS exists
  `.execute(db);
  return result.rows[0]?.exists === true;
}

async function ensureCommandAuthorizationCompatibility(db: Kysely<Database>, credentialId: string): Promise<string[]> {
  const createdRelations: string[] = [];
  if (!await relationExists(db, "subject_command_grants")) {
    await sql`
      CREATE TABLE subject_command_grants (
        subject_id text NOT NULL,
        property_id text NOT NULL,
        command_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (subject_id, property_id, command_type)
      )
    `.execute(db);
    createdRelations.push("subject_command_grants");
  }
  if (!await relationExists(db, "token_command_ceilings")) {
    await sql`
      CREATE TABLE token_command_ceilings (
        token_id text NOT NULL,
        subject_id text NOT NULL,
        property_id text NOT NULL,
        command_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (token_id, command_type)
      )
    `.execute(db);
    createdRelations.push("token_command_ceilings");
  }
  await db.insertInto("subject_command_grants")
    .values(ordinaryStaffCommandGrants.map((commandType) => ({
      subject_id: demo.agentSubjectId,
      property_id: demo.propertyId,
      command_type: commandType
    })))
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db.insertInto("token_command_ceilings")
    .values(ordinaryStaffCommandGrants.map((commandType) => ({
      token_id: credentialId,
      subject_id: demo.agentSubjectId,
      property_id: demo.propertyId,
      command_type: commandType
    })))
    .execute();
  return createdRelations;
}

export async function createRestoreFixture(reference: string): Promise<void> {
  const db = createDatabase();
  let createdLegacyTransferCompatibilityTable = false;
  let createdCommandAuthorizationCompatibilityRelations: string[] = [];
  try {
    const credentialId = newId("token");
    await db.insertInto("api_tokens").values({
      id: credentialId,
      subject_id: demo.agentSubjectId,
      label: "Restore verification fixture",
      secret_hash: sha256(reference),
      access_ceiling: "WRITE",
      property_scope: demo.propertyId,
      expires_at: "2100-01-01T00:00:00.000Z",
      revoked_at: null,
      rotated_from_id: null,
      replaced_by_id: null
    }).execute();
    createdCommandAuthorizationCompatibilityRelations = await ensureCommandAuthorizationCompatibility(db, credentialId);
    const principal: AuthPrincipal = {
      subjectId: demo.agentSubjectId,
      credentialId,
      credentialType: "TOKEN",
      displayName: "Restore Fixture Agent",
      ...authScope()
    };
    const inventoryUnitId = newId("unit");
    await db.insertInto("inventory_units").values({
      id: inventoryUnitId,
      property_id: demo.propertyId,
      kind: "ROOM",
      parent_room_id: null,
      code: reference,
      name: "Restore verification room",
      active: true
    }).execute();
    const policyId = newId("policy");
    await db.insertInto("pricing_policy_versions").values({
      id: policyId,
      property_id: demo.propertyId,
      code: `RESTORE-FIXTURE-${policyId}`,
      version: 1,
      stay_type: "TRANSIENT",
      calculation_kind: "FLAT_NIGHTLY",
      nightly_rate_minor: 10_000,
      product_anchor_rates_minor: null,
      effective_from: null,
      effective_until: null,
      rounding_rule: null,
      currency: "CNY",
      status: "PUBLISHED"
    }).execute();
    const quote = await executeQuoteCommand(db, principal, {
      propertyId: demo.propertyId,
      inventoryUnitId,
      stayType: "TRANSIENT",
      arrivalDate: "2099-01-10",
      departureDate: "2099-01-12",
      pricingPolicyVersionId: policyId
    }, {
      idempotencyKey: `${reference}-quote`,
      correlationId: reference
    });
    const created = await runCommand(db, principal, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.quote.quoteId,
      primaryGuest: { fullName: "Restore Verification Guest", nickname: "Restore Guest", documentNumber: reference },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.quote.currentContractAmount.minorUnits
    }, `${reference}-create-order`);
    const orderId = created.result?.orderId;
    if (typeof orderId !== "string") throw new Error("Restore fixture CREATE_ORDER returned no orderId");
    const transferTable = await sql<{ exists: boolean }>`
      SELECT to_regclass('stay_collection_membership_transfers') IS NOT NULL AS exists
    `.execute(db);
    if (!transferTable.rows[0]?.exists) {
      await sql`
        CREATE TABLE stay_collection_membership_transfers (
          id text PRIMARY KEY,
          order_id text NOT NULL
        )
      `.execute(db);
      createdLegacyTransferCompatibilityTable = true;
    }
    const firstCollection = await runCommand(db, principal, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 6_000,
      method: "BANK_TRANSFER",
      transactionReference: `${reference}-COLLECTION-1`,
      note: "Restore verification first collection"
    }, `${reference}-collection-1`);
    await runCommand(db, principal, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 4_000,
      method: "WECOM",
      transactionReference: `${reference}-COLLECTION-2`,
      note: "Restore verification second collection"
    }, `${reference}-collection-2`);
    const collectionFactId = firstCollection.factRefs[0];
    if (!collectionFactId) throw new Error("Restore fixture COLLECTION returned no factId");
    await runCommand(db, principal, "RECORD_REFUND", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: 4_000,
      referencesFactId: collectionFactId,
      method: "BANK_TRANSFER",
      transactionReference: `${reference}-REFUND-1`,
      note: "Restore verification referenced refund"
    }, `${reference}-refund-1`);
  } finally {
    if (createdLegacyTransferCompatibilityTable) {
      await sql`DROP TABLE IF EXISTS stay_collection_membership_transfers`.execute(db);
    }
    if (createdCommandAuthorizationCompatibilityRelations.includes("token_command_ceilings")) {
      await sql`DROP TABLE IF EXISTS token_command_ceilings`.execute(db);
    }
    if (createdCommandAuthorizationCompatibilityRelations.includes("subject_command_grants")) {
      await sql`DROP TABLE IF EXISTS subject_command_grants`.execute(db);
    }
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reference = process.env.RESTORE_FIXTURE_REFERENCE;
  if (!reference) throw new Error("RESTORE_FIXTURE_REFERENCE is required");
  void createRestoreFixture(reference).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
