import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  type Database
} from "@qintopia/db";
import { verifyPassword } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import {
  productionAcceptancePurgeSpec,
  purgeProductionAcceptanceData,
  type ProductionAcceptancePurgeSpec
} from "../../scripts/purge-production-acceptance-data.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.PRODUCTION_ACCEPTANCE_PURGE_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_production_acceptance_purge";

const principal: AuthPrincipal = {
  subjectId: demo.operatorSubjectId,
  credentialId: "session_purge_integration",
  credentialType: "SESSION",
  displayName: "Demo Operator",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function createAcceptanceOrder(unitId: string, index: number): Promise<string> {
  const arrivalDate = `2026-09-${String(index + 1).padStart(2, "0")}`;
  const departureDate = `2026-09-${String(index + 2).padStart(2, "0")}`;
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.publicPricingPolicyId
  });
  const envelope: CommandEnvelope = {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Purge Guest ${index}`, nickname: `Purge ${index}` },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  };
  const preview = await createCommandPreview(db, principal, envelope, metadata(`purge-preview-${index}`));
  const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: { code: "CREATE_STANDARD_ORDER", note: "" }
  }, metadata(`purge-confirm-${index}`));
  return receipt.result!.orderId as string;
}

async function fixtureSpec(): Promise<ProductionAcceptancePurgeSpec> {
  await db.insertInto("web_sessions").values({
    id: principal.credentialId,
    subject_id: demo.operatorSubjectId,
    secret_hash: "f".repeat(64),
    expires_at: new Date("2099-01-01T00:00:00.000Z"),
    revoked_at: null
  }).execute();
  const rooms = await db.selectFrom("inventory_units")
    .select("id")
    .where("kind", "=", "ROOM")
    .where("active", "=", true)
    .orderBy("id")
    .limit(7)
    .execute();
  expect(rooms).toHaveLength(7);
  const orderIds: string[] = [];
  for (const [index, room] of rooms.entries()) orderIds.push(await createAcceptanceOrder(room.id, index));

  const countEntries = await Promise.all(Object.keys(productionAcceptancePurgeSpec.expectedCounts).map(async (table) => {
    const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(table)}`.execute(db);
    return [table, Number(result.rows[0]?.count ?? -1)] as const;
  }));
  const catalogEntries = await Promise.all(Object.keys(productionAcceptancePurgeSpec.preservedCounts).map(async (table) => {
    const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(table)}`.execute(db);
    return [table, Number(result.rows[0]?.count ?? -1)] as const;
  }));
  const sourceRows = await sql<{
    order_id: string;
    created_at_utc: string;
    create_command_id: string;
    credential_id: string;
  }>`
    SELECT booking.id AS order_id,
           to_char(booking.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_utc,
           amendment.command_id AS create_command_id,
           command.credential_id
      FROM orders AS booking
      JOIN amendments AS amendment ON amendment.order_id = booking.id
       AND amendment.sequence = 1 AND amendment.amendment_type = 'CREATE_ORDER'
      JOIN command_executions AS command ON command.id = amendment.command_id
     ORDER BY booking.id
  `.execute(db);
  const pricingPolicies = await db.selectFrom("pricing_policy_versions").select("id").orderBy("id").execute();
  const roomRevision = await db.selectFrom("room_status_revisions").select("revision").where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow();

  return {
    ...productionAcceptancePurgeSpec,
    orderIds,
    orderSources: sourceRows.rows.map((row) => ({
      orderId: row.order_id,
      createdAtUtc: row.created_at_utc,
      createCommandId: row.create_command_id,
      credentialId: row.credential_id
    })),
    sourceCreatedBeforeExclusive: "2099-01-01T00:00:00.000Z",
    expectedCounts: Object.fromEntries(countEntries) as unknown as ProductionAcceptancePurgeSpec["expectedCounts"],
    preservedCounts: Object.fromEntries(catalogEntries) as unknown as ProductionAcceptancePurgeSpec["preservedCounts"],
    preservedPricingPolicyIds: pricingPolicies.map(({ id }) => id),
    preservedRoomStatusRevision: Number(roomRevision.revision)
  };
}

async function coreCounts() {
  const [orders, members, subjects, inventory, policies] = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("members").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("subjects").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pricing_policy_versions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [orders, members, subjects, inventory, policies].map(({ count }) => Number(count));
}

beforeEach(async () => {
  sequence = 0;
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  await db.destroy();
});

describe("production acceptance purge", () => {
  it("keeps an inspection and full dry-run read-only, then applies the exact snapshot while preserving catalogs", async () => {
    const spec = await fixtureSpec();
    const before = await coreCounts();
    const inspection = await purgeProductionAcceptanceData({ databaseUrl, mode: "inspect", testSpec: spec });
    expect(inspection).toMatchObject({ mode: "inspect", committed: false, deletionCounts: {} });
    expect(await coreCounts()).toEqual(before);

    const dryRun = await purgeProductionAcceptanceData({ databaseUrl, mode: "dry-run", testSpec: spec });
    expect(dryRun).toMatchObject({ mode: "dry-run", committed: false });
    expect(dryRun.approvalToken).toBe(inspection.approvalToken);
    expect(await coreCounts()).toEqual(before);

    const directory = await mkdtemp(join(tmpdir(), "qintopia-purge-password-"));
    const passwordFile = join(directory, "operator-password");
    const password = "production-test-only-password-7391";
    try {
      await writeFile(passwordFile, password, { mode: 0o600 });
      await chmod(passwordFile, 0o600);
      const applied = await purgeProductionAcceptanceData({
        databaseUrl,
        mode: "apply",
        applyConfirmation: "DELETE_EXACT_QINTOPIA_ACCEPTANCE_SNAPSHOT",
        applicationStoppedConfirmation: "CONFIRMED",
        demoSeedDisabledConfirmation: "CONFIRMED",
        approvalToken: inspection.approvalToken,
        operatorPasswordFile: passwordFile,
        operatorDisplayName: "QinTopia Operator",
        testSpec: spec
      });
      expect(applied).toMatchObject({ mode: "apply", committed: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(await coreCounts()).toEqual([0, 0, 1, before[3], before[4]]);
    const operator = await db.selectFrom("subjects")
      .select(["display_name", "password_salt", "password_hash", "auth_version"])
      .where("id", "=", demo.operatorSubjectId)
      .executeTakeFirstOrThrow();
    expect(operator).toMatchObject({ display_name: "QinTopia Operator", auth_version: 2 });
    await expect(verifyPassword(password, operator.password_salt, operator.password_hash)).resolves.toBe(true);
    expect(await db.selectFrom("subject_property_grants").selectAll().execute()).toEqual([
      expect.objectContaining({ subject_id: demo.operatorSubjectId, property_id: demo.propertyId, access_level: "WRITE" })
    ]);
  });

  it("rolls back with zero writes when an expected count is wrong", async () => {
    const spec = await fixtureSpec();
    const before = await coreCounts();
    const wrongSpec: ProductionAcceptancePurgeSpec = {
      ...spec,
      expectedCounts: { ...spec.expectedCounts, orders: spec.expectedCounts.orders + 1 }
    };
    await expect(purgeProductionAcceptanceData({ databaseUrl, mode: "dry-run", testSpec: wrongSpec }))
      .rejects.toThrow(/order count does not match the allowlist|orders expected/);
    expect(await coreCounts()).toEqual(before);
  });

  it("rejects unknown business data before any truncation", async () => {
    const spec = await fixtureSpec();
    await db.insertInto("members").values({
      id: "member_unknown_must_survive_failed_purge",
      identity_card_number: "UNKNOWN-PURGE-IDENTITY",
      full_name: "Unknown",
      phone: "13900000000",
      wechat: "unknown-purge"
    }).execute();
    const before = await coreCounts();
    await expect(purgeProductionAcceptanceData({ databaseUrl, mode: "dry-run", testSpec: spec }))
      .rejects.toThrow(/members expected 1 rows, observed 2/);
    expect(await coreCounts()).toEqual(before);
    await expect(db.selectFrom("members").select("id").where("id", "=", "member_unknown_must_survive_failed_purge").executeTakeFirst()).resolves.toBeTruthy();
  });
});
