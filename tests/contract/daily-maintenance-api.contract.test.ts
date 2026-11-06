import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDatabase, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { createBusinessApi } from "../helpers/business-api.ts";

let db: Kysely<Database>;
let app: FastifyInstance;
let api: ReturnType<typeof createBusinessApi>;
const interval = { arrivalDate: "2028-08-01", departureDate: "2028-08-03" };
const lockInput = { ...interval, inventoryUnitId: demo.bedAId, reason: "Synthetic scheduled repair" };
const snapshot = async () => ({
  locks: await db.selectFrom("maintenance_locks").selectAll().orderBy("id").execute(),
  claims: await db.selectFrom("inventory_claims").selectAll().orderBy("id").execute(),
  orders: await db.selectFrom("orders").selectAll().orderBy("id").execute(),
  stays: await db.selectFrom("stays").selectAll().orderBy("id").execute(),
  cash: await db.selectFrom("collection_facts").selectAll().orderBy("fact_id").execute()
});
async function availability() {
  return api.get(`/api/v1/properties/${demo.propertyId}/availability?${new URLSearchParams(interval)}`);
}
beforeEach(async () => {
  db = await resetTestDatabase();
  app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
  await app.ready();
  api = createBusinessApi(app);
});
afterEach(async () => { await app?.close(); await db?.destroy(); });

describe("daily maintenance through the public API", () => {
  it("locks and fully releases a bed, preserves lodging and cash, and recovers each original receipt", async () => {
    const original = await snapshot();
    const locked = await api.execute("LOCK_MAINTENANCE", lockInput, "daily-maintenance-lock", { snapshot });
    const maintenanceLockId = locked.result!.maintenanceLockId as string;
    expect(locked.resourceRefs).toContain(maintenanceLockId);
    const active = (await snapshot()).claims.filter(row => row.source_id === maintenanceLockId && row.active);
    expect(active).toHaveLength(2);
    expect(active.every(row => row.source_type === "MAINTENANCE" && row.inventory_unit_id === demo.bedAId)).toBe(true);
    const occupied = await availability();
    for (const id of [demo.roomId, demo.bedAId]) {
      expect(occupied.units.find((unit: { id: string }) => unit.id === id)).toMatchObject({ available: false });
    }
    expect(occupied.units.find((unit: { id: string }) => unit.id === demo.bedBId)).toMatchObject({ available: true });

    await api.execute("RELEASE_MAINTENANCE", { maintenanceLockId }, "daily-maintenance-release", { snapshot });
    const after = await snapshot();
    expect(after.locks).toHaveLength(1); // Keep history after releasing the entire interval.
    expect(after.claims.filter(row => row.source_id === maintenanceLockId && row.active)).toHaveLength(0);
    expect(after.orders).toEqual(original.orders);
    expect(after.stays).toEqual(original.stays);
    expect(after.cash).toEqual(original.cash);
    const released = await availability();
    for (const id of [demo.roomId, demo.bedAId]) {
      expect(released.units.find((unit: { id: string }) => unit.id === id)).toMatchObject({ available: true });
    }
  });

  it("rejects a stale bed preview after another caller locks its parent room without adding claims", async () => {
    const prepared = await api.preview("LOCK_MAINTENANCE", lockInput, "daily-maintenance-loser-preview");
    await api.execute("LOCK_MAINTENANCE", { ...lockInput, inventoryUnitId: demo.roomId },
      "daily-maintenance-winner", { snapshot });
    const before = await snapshot();
    const receipt = await api.confirm(prepared.preview, "daily-maintenance-loser-confirm", undefined, 409);
    expect(receipt).toMatchObject({ commandType: "LOCK_MAINTENANCE", executionStatus: "NOT_EXECUTED",
      businessCommitted: false, error: { code: "PREVIEW_STALE" } });
    expect(await api.get(`/api/v1/receipts/${receipt.receiptId}`)).toEqual(receipt);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects read-only credentials and missing human confirmation, and rechecks command permission at commit", async () => {
    const before = await snapshot();
    const denied = await app.inject({ method: "POST", url: "/api/v1/command-previews",
      headers: { authorization: `Bearer ${demo.readToken}`, "idempotency-key": "daily-readonly-lock", "x-correlation-id": "daily-denial" },
      payload: { commandType: "LOCK_MAINTENANCE", input: { propertyId: demo.propertyId, ...lockInput } } });
    expect(denied.statusCode, denied.body).toBe(403);
    const prepared = await api.preview("LOCK_MAINTENANCE", lockInput, "daily-permission-preview");
    const request = { method: "POST" as const, url: `/api/v1/command-previews/${prepared.preview.previewId}/confirm`,
      headers: { ...api.headers, "idempotency-key": "daily-permission-confirm", "x-correlation-id": "daily-permission" },
      payload: { propertyId: demo.propertyId, commandType: "LOCK_MAINTENANCE", confirmation: false,
        expectedEffectHash: prepared.preview.effectHash, reason: { code: "LOCK_MAINTENANCE", note: "Synthetic consent check" } } };
    const missingConsent = await app.inject(request);
    expect(missingConsent.statusCode, missingConsent.body).toBe(400);
    const mismatched = await api.confirm({ ...prepared.preview, effectHash: "0".repeat(64) }, "daily-effect-mismatch", undefined, 409);
    expect(mismatched).toMatchObject({ commandType: "LOCK_MAINTENANCE", executionStatus: "NOT_EXECUTED",
      businessCommitted: false, error: { code: "CONFIRMATION_MISMATCH" } });
    expect(await api.get(`/api/v1/command-results?propertyId=${demo.propertyId}&commandType=LOCK_MAINTENANCE&idempotencyKey=daily-effect-mismatch`)).toEqual(mismatched);
    expect(await snapshot()).toEqual(before);
    await db.deleteFrom("token_command_ceilings").where("token_id", "=", "token_demo_write")
      .where("command_type", "=", "LOCK_MAINTENANCE").execute();
    const revoked = await app.inject({ ...request, payload: { ...request.payload, confirmation: true } });
    expect(revoked.statusCode, revoked.body).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});
