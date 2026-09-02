import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  createDatabase,
  databaseReady,
  importQintopia2026ReferenceCatalog,
  loadBundledQintopia2026Catalog,
  loadReferenceCatalog,
  type Database
} from "@qintopia/db";
import { stableHash } from "@qintopia/domain";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.REFERENCE_CATALOG_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_reference_catalog";
const demoOwnerReadinessOptions = {
  identity: "maintenance-owner",
  staffProfileManifestName: "demo"
} as const;

let db: Kysely<Database>;

const coreTableNames = [
  "inventory_units",
  "pricing_policy_versions",
  "subjects",
  "subject_property_grants",
  "api_tokens",
  "web_sessions",
  "member_contracts",
  "entitlement_lots",
  "entitlement_ledger",
  "quotes",
  "orders",
  "stays",
  "stay_segments",
  "amendments",
  "pricing_revisions",
  "coverage_items",
  "inventory_room_days",
  "inventory_bed_days",
  "inventory_claims",
  "maintenance_locks",
  "collection_facts",
  "command_previews",
  "command_executions",
  "command_receipts",
  "audit_entries"
] as const satisfies ReadonlyArray<keyof Database>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function resetSuiteDatabase(): Promise<void> {
  if (db) await db.destroy();
  db = await resetDatabase(databaseUrl);
}

async function tableCounts() {
  const [
    properties,
    batches,
    catalogInventory,
    rates,
    memberships,
    executableInventory,
    policies,
    memberContracts,
    entitlementLots,
    coreTables
  ] = await Promise.all([
    db.selectFrom("properties").select("id").execute(),
    db.selectFrom("catalog_import_batches").select("id").execute(),
    db.selectFrom("inventory_catalog_entries").select("id").execute(),
    db.selectFrom("reference_rate_entries").select("id").execute(),
    db.selectFrom("reference_membership_products").select("id").execute(),
    db.selectFrom("inventory_units").select("id").execute(),
    db.selectFrom("pricing_policy_versions").select("id").execute(),
    db.selectFrom("member_contracts").select("id").execute(),
    db.selectFrom("entitlement_lots").select("id").execute(),
    Promise.all(coreTableNames.map(async (table) => {
      const result = await sql<{ count: number }>`SELECT count(*)::int AS count FROM ${sql.table(table)}`.execute(db);
      return [table, result.rows[0]?.count ?? 0] as const;
    }))
  ]);
  return {
    properties: properties.length,
    batches: batches.length,
    catalogInventory: catalogInventory.length,
    rates: rates.length,
    memberships: memberships.length,
    executableInventory: executableInventory.length,
    policies: policies.length,
    memberContracts: memberContracts.length,
    entitlementLots: entitlementLots.length,
    coreTables: Object.fromEntries(coreTables)
  };
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe.sequential("2026 reference catalog import", () => {
  it("rolls back the batch and all earlier children when a late child insert fails", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const fixtureBatchId = "catalog_rollback_fixture";
    const fixtureInventoryId = "catalog_rollback_fixture_inventory";
    await db.insertInto("catalog_import_batches").values({
      id: fixtureBatchId,
      property_id: demo.propertyId,
      source_document_token: "rollback-fixture",
      source_revision: 1,
      source_version_date: null,
      source_snapshot: JSON.stringify(snapshot),
      content_hash: "f".repeat(64),
      execution_state: "REFERENCE_ONLY",
      sealed_at: null
    }).execute();
    await db.insertInto("inventory_catalog_entries").values({
      id: fixtureInventoryId,
      import_batch_id: fixtureBatchId,
      type_code: "rollback_fixture",
      type_name: "Rollback fixture",
      bathroom_type: "SHARED",
      sell_unit_kind: "ROOM",
      physical_room_count: 1,
      units_per_room: null,
      sellable_unit_count: 1,
      electricity_included: false,
      execution_state: "REFERENCE_ONLY",
      source_sheet: "fixture",
      source_range: "A1"
    }).execute();
    await db.insertInto("reference_membership_products").values({
      id: `${snapshot.importId}:membership:membership_shared_bath_single_30_nights`,
      import_batch_id: fixtureBatchId,
      inventory_catalog_entry_id: fixtureInventoryId,
      product_code: "rollback_fixture",
      product_name: "Rollback fixture",
      price_minor: 1,
      currency: "CNY",
      sales_limit: 1,
      entitlement_nights: 1,
      validity_period: "P1Y",
      terms: JSON.stringify({ fixture: true }),
      execution_state: "REFERENCE_ONLY",
      source_sheet: "fixture",
      source_range: "A1"
    }).execute();
    await db.updateTable("catalog_import_batches").set({ sealed_at: sql<Date>`CURRENT_TIMESTAMP` }).where("id", "=", fixtureBatchId).execute();

    const before = await tableCounts();
    await expect(importQintopia2026ReferenceCatalog(db)).rejects.toThrow(/duplicate key|unique constraint/i);
    expect(await tableCounts()).toEqual(before);
    expect(await db.selectFrom("catalog_import_batches").select("id").where("id", "=", snapshot.importId).executeTakeFirst()).toBeUndefined();

    await resetSuiteDatabase();
  });

  it("serializes two first imports into one sealed reference-only batch", async () => {
    const before = await tableCounts();
    const concurrentDb = createDatabase(databaseUrl);
    let first;
    let second;
    try {
      [first, second] = await Promise.all([
        importQintopia2026ReferenceCatalog(db),
        importQintopia2026ReferenceCatalog(concurrentDb)
      ]);
    } finally {
      await concurrentDb.destroy();
    }

    expect(await databaseReady(db, demoOwnerReadinessOptions)).toBe(true);
    expect(first.batch.id).toBe(second.batch.id);
    expect(first.batch).toMatchObject({
      propertyId: demo.propertyId,
      sourceRevision: 561,
      sourceVersionDate: "2026-02-25",
      executionState: "REFERENCE_ONLY"
    });
    expect(first.batch).not.toHaveProperty("sourceDocumentToken");
    expect(first.inventoryEntries).toHaveLength(8);
    expect(first.rates).toHaveLength(32);
    expect(first.membershipProducts).toHaveLength(3);
    expect(first.unresolvedIssues.length).toBeGreaterThan(0);
    expect(first.inventoryEntries.reduce((sum, entry) => sum + entry.physicalRoomCount, 0)).toBe(44);
    expect(first.inventoryEntries.reduce((sum, entry) => sum + entry.sellableUnitCount, 0)).toBe(77);

    const quad = first.inventoryEntries.find((entry) => entry.typeCode === "shared_bath_quad");
    expect(quad).toMatchObject({
      sellUnitKind: "BED",
      unitsPerRoom: 4,
      physicalRoomCount: 10,
      sellableUnitCount: 40,
      separateElectricityCharge: false,
      executionState: "REFERENCE_ONLY"
    });
    expect(first.rates.find((rate) => rate.inventoryCatalogEntryId === quad?.id && rate.packageNights === 30)?.packageAmountMinor).toBe(78_000);
    expect(first.membershipProducts.every((product) => product.validityPeriod === "P1Y")).toBe(true);

    const batch = await db.selectFrom("catalog_import_batches")
      .select(["source_snapshot", "content_hash", "sealed_at"])
      .where("id", "=", first.batch.id)
      .executeTakeFirstOrThrow();
    const storedSnapshot = batch.source_snapshot as { unresolvedIssues?: unknown[] };
    expect(storedSnapshot.unresolvedIssues?.length).toBeGreaterThan(0);
    expect(batch.content_hash).toBe(first.batch.contentHash);
    expect(batch.sealed_at).not.toBeNull();

    expect(await tableCounts()).toEqual({
      ...before,
      batches: 1,
      catalogInventory: 8,
      rates: 32,
      memberships: 3
    });
  });

  it("replays idempotently without duplicating immutable facts", async () => {
    const first = await loadReferenceCatalog(db, demo.propertyId);
    const replay = await importQintopia2026ReferenceCatalog(db);
    expect(replay.batch.id).toBe(first?.batch.id);
    expect(await tableCounts()).toMatchObject({ batches: 1, catalogInventory: 8, rates: 32, memberships: 3 });
  });

  it("rejects missing and mismatched properties without any core or reference write", async () => {
    const beforeMissing = await tableCounts();
    await expect(importQintopia2026ReferenceCatalog(db, {
      propertyId: "prop_reference_missing",
      propertyCode: "QTP-MISSING"
    })).rejects.toThrow(/must exist before importing/);
    expect(await tableCounts()).toEqual(beforeMissing);

    await expect(importQintopia2026ReferenceCatalog(db, {
      propertyId: demo.propertyId,
      propertyCode: "QTP-WRONG"
    })).rejects.toThrow(/code does not match/);
    expect(await tableCounts()).toEqual(beforeMissing);

    await db.insertInto("properties").values([
      { id: "prop_reference_wrong_timezone", code: "QTP-WRONG-TZ", name: "Wrong timezone", timezone: "UTC", currency: "CNY" },
      { id: "prop_reference_wrong_currency", code: "QTP-WRONG-CCY", name: "Wrong currency", timezone: "Asia/Shanghai", currency: "USD" }
    ]).execute();
    const beforeIdentityChecks = await tableCounts();
    await expect(importQintopia2026ReferenceCatalog(db, {
      propertyId: "prop_reference_wrong_timezone",
      propertyCode: "QTP-WRONG-TZ"
    })).rejects.toThrow(/timezone does not match/);
    await expect(importQintopia2026ReferenceCatalog(db, {
      propertyId: "prop_reference_wrong_currency",
      propertyCode: "QTP-WRONG-CCY"
    })).rejects.toThrow(/currency does not match/);
    expect(await tableCounts()).toEqual(beforeIdentityChecks);
  });

  it("keeps sealed catalog rows immutable and rejects valid-looking child appends", async () => {
    const catalog = await loadReferenceCatalog(db, demo.propertyId);
    expect(catalog).toBeDefined();
    const batchId = catalog!.batch.id;
    const inventoryId = catalog!.inventoryEntries[0]!.id;
    const snapshot = await loadBundledQintopia2026Catalog();

    await expect(db.insertInto("catalog_import_batches").values({
      id: "catalog_illegally_presealed_fixture",
      property_id: demo.propertyId,
      source_document_token: "illegally-presealed-fixture",
      source_revision: 1,
      source_version_date: null,
      source_snapshot: JSON.stringify(snapshot),
      content_hash: "d".repeat(64),
      execution_state: "REFERENCE_ONLY",
      sealed_at: new Date()
    }).execute()).rejects.toThrow(/must be inserted unsealed/);

    await expect(db.updateTable("reference_rate_entries").set({ package_amount_minor: 1 }).where("id", "=", catalog!.rates[0]!.id).execute())
      .rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("catalog_import_batches").where("id", "=", batchId).execute())
      .rejects.toThrow(/append-only/);
    await expect(db.updateTable("catalog_import_batches").set({ source_revision: 562 }).where("id", "=", batchId).execute())
      .rejects.toThrow(/append-only except for one-way sealing/);
    await expect(db.updateTable("catalog_import_batches").set({ sealed_at: new Date() }).where("id", "=", batchId).execute())
      .rejects.toThrow(/append-only except for one-way sealing/);

    await expect(db.insertInto("inventory_catalog_entries").values({
      id: "sealed_extra_inventory",
      import_batch_id: batchId,
      type_code: "sealed_extra",
      type_name: "Sealed extra",
      bathroom_type: "SHARED",
      sell_unit_kind: "ROOM",
      physical_room_count: 1,
      units_per_room: null,
      sellable_unit_count: 1,
      electricity_included: false,
      execution_state: "REFERENCE_ONLY",
      source_sheet: "fixture",
      source_range: "A1"
    }).execute()).rejects.toThrow(/sealed or missing/);
    await expect(db.insertInto("reference_rate_entries").values({
      id: "sealed_extra_rate",
      import_batch_id: batchId,
      inventory_catalog_entry_id: inventoryId,
      package_nights: 1,
      package_amount_minor: 1,
      currency: "CNY",
      execution_state: "REFERENCE_ONLY",
      source_sheet: "fixture",
      source_range: "A1"
    }).execute()).rejects.toThrow(/sealed or missing/);
    await expect(db.insertInto("reference_membership_products").values({
      id: "sealed_extra_membership",
      import_batch_id: batchId,
      inventory_catalog_entry_id: inventoryId,
      product_code: "sealed_extra",
      product_name: "Sealed extra",
      price_minor: 1,
      currency: "CNY",
      sales_limit: 1,
      entitlement_nights: 1,
      validity_period: "P1Y",
      terms: JSON.stringify({ fixture: true }),
      execution_state: "REFERENCE_ONLY",
      source_sheet: "fixture",
      source_range: "A1"
    }).execute()).rejects.toThrow(/sealed or missing/);
  });

  it("does not load an unsealed batch", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    await db.insertInto("catalog_import_batches").values({
      id: "catalog_unsealed_fixture",
      property_id: demo.propertyId,
      source_document_token: "unsealed-fixture",
      source_revision: 1,
      source_version_date: null,
      source_snapshot: JSON.stringify(snapshot),
      content_hash: "e".repeat(64),
      execution_state: "REFERENCE_ONLY",
      sealed_at: null
    }).execute();
    expect(await loadReferenceCatalog(db, demo.propertyId, "catalog_unsealed_fixture")).toBeUndefined();
  });

  it("rejects sealed batches whose snapshot hash or persisted projection is inconsistent", async () => {
    const source = await loadBundledQintopia2026Catalog();
    const sourceToken = "KsxGwst1wiOTTfkaO9OcfFognog";
    const insertSealedBatch = async (contentHash: string) => {
      await db.insertInto("catalog_import_batches").values({
        id: source.importId,
        property_id: demo.propertyId,
        source_document_token: sourceToken,
        source_revision: source.source.revision,
        source_version_date: source.source.publicPriceVersionDate,
        source_snapshot: JSON.stringify(source),
        content_hash: contentHash,
        execution_state: "REFERENCE_ONLY",
        sealed_at: null
      }).execute();
      await db.updateTable("catalog_import_batches")
        .set({ sealed_at: sql<Date>`CURRENT_TIMESTAMP` })
        .where("id", "=", source.importId)
        .execute();
    };

    try {
      await resetSuiteDatabase();
      await insertSealedBatch("0".repeat(64));
      await expect(loadReferenceCatalog(db, demo.propertyId, source.importId))
        .rejects.toThrow(/content hash does not match/);

      await resetSuiteDatabase();
      await insertSealedBatch(stableHash(source));
      await expect(loadReferenceCatalog(db, demo.propertyId, source.importId))
        .rejects.toThrow(/sealed inventory rows do not match/);
    } finally {
      await resetSuiteDatabase();
    }
  });

  it("serializes child insertion and sealing across two real connections", async () => {
    const snapshot = await loadBundledQintopia2026Catalog();
    const concurrentDb = createDatabase(databaseUrl);
    const childFirstBatchId = "catalog_child_first_race_fixture";
    const sealFirstBatchId = "catalog_seal_first_race_fixture";
    const childInserted = deferred();
    const releaseChild = deferred();
    const sealUpdated = deferred();
    const releaseSeal = deferred();
    try {
      await db.insertInto("catalog_import_batches").values([
        {
          id: childFirstBatchId,
          property_id: demo.propertyId,
          source_document_token: "child-first-race",
          source_revision: 1,
          source_version_date: null,
          source_snapshot: JSON.stringify(snapshot),
          content_hash: "1".repeat(64),
          execution_state: "REFERENCE_ONLY",
          sealed_at: null
        },
        {
          id: sealFirstBatchId,
          property_id: demo.propertyId,
          source_document_token: "seal-first-race",
          source_revision: 1,
          source_version_date: null,
          source_snapshot: JSON.stringify(snapshot),
          content_hash: "2".repeat(64),
          execution_state: "REFERENCE_ONLY",
          sealed_at: null
        }
      ]).execute();

      const childTransaction = concurrentDb.transaction().execute(async (trx) => {
        await trx.insertInto("inventory_catalog_entries").values({
          id: "catalog_child_first_race_inventory",
          import_batch_id: childFirstBatchId,
          type_code: "child_first_race",
          type_name: "Child first race",
          bathroom_type: "SHARED",
          sell_unit_kind: "ROOM",
          physical_room_count: 1,
          units_per_room: null,
          sellable_unit_count: 1,
          electricity_included: false,
          execution_state: "REFERENCE_ONLY",
          source_sheet: "fixture",
          source_range: "A1"
        }).execute();
        childInserted.resolve();
        await releaseChild.promise;
      });
      await childInserted.promise;
      let childFirstSealSettled = false;
      const childFirstSeal = db.updateTable("catalog_import_batches")
        .set({ sealed_at: sql<Date>`CURRENT_TIMESTAMP` })
        .where("id", "=", childFirstBatchId)
        .execute()
        .finally(() => { childFirstSealSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(childFirstSealSettled).toBe(false);
      releaseChild.resolve();
      await Promise.all([childTransaction, childFirstSeal]);
      expect((await db.selectFrom("catalog_import_batches").select("sealed_at").where("id", "=", childFirstBatchId).executeTakeFirstOrThrow()).sealed_at).not.toBeNull();
      expect(await db.selectFrom("inventory_catalog_entries").select("id").where("id", "=", "catalog_child_first_race_inventory").executeTakeFirst()).toBeDefined();

      const sealTransaction = db.transaction().execute(async (trx) => {
        await trx.updateTable("catalog_import_batches")
          .set({ sealed_at: sql<Date>`CURRENT_TIMESTAMP` })
          .where("id", "=", sealFirstBatchId)
          .execute();
        sealUpdated.resolve();
        await releaseSeal.promise;
      });
      await sealUpdated.promise;
      let sealFirstChildSettled = false;
      const sealFirstChild = concurrentDb.insertInto("inventory_catalog_entries").values({
        id: "catalog_seal_first_race_inventory",
        import_batch_id: sealFirstBatchId,
        type_code: "seal_first_race",
        type_name: "Seal first race",
        bathroom_type: "SHARED",
        sell_unit_kind: "ROOM",
        physical_room_count: 1,
        units_per_room: null,
        sellable_unit_count: 1,
        electricity_included: false,
        execution_state: "REFERENCE_ONLY",
        source_sheet: "fixture",
        source_range: "A1"
      }).execute().finally(() => { sealFirstChildSettled = true; });
      const rejectedChild = expect(sealFirstChild).rejects.toThrow(/sealed or missing/);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sealFirstChildSettled).toBe(false);
      releaseSeal.resolve();
      await sealTransaction;
      await rejectedChild;
      expect(await db.selectFrom("inventory_catalog_entries").select("id").where("id", "=", "catalog_seal_first_race_inventory").executeTakeFirst()).toBeUndefined();
    } finally {
      releaseChild.resolve();
      releaseSeal.resolve();
      await concurrentDb.destroy();
      await resetSuiteDatabase();
    }
  });
});
