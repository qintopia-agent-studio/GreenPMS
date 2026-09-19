import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { sha256 } from "@qintopia/domain";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import { createDatabase, createCommandPreview, confirmCommandPreview, getOrderView, getReceipt, type Database } from "@qintopia/db";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { readRoomCatalog } from "../../packages/db/src/room-catalog.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { loadInventoryUnit } from "../../packages/db/src/inventory.ts";
import { listOrders } from "../../packages/db/src/order-list.ts";
import { buildServer } from "../../apps/api/src/server.ts";

const url = process.env.CATALOG_SNAPSHOT_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_catalog_snapshot";
let owner: Kysely<Database>, db: Kysely<Database>;
let sequence = 0, orderId: string;
const admin: AuthPrincipal = { subjectId: demo.administratorSubjectId, credentialId: "session_catalog_snapshot",
  credentialType: "SESSION", displayName: "合成管理员", ...authScope({ credentialType: "SESSION", profile: "administrator" }) };
const metadata = () => ({ idempotencyKey: `snapshot-${++sequence}`, correlationId: `snapshot-${sequence}` });
async function prepare(envelope: CommandEnvelope) { return createCommandPreview(db, admin, envelope, metadata()); }
async function confirm(prepared: Awaited<ReturnType<typeof prepare>>, key = metadata()) {
  return confirmCommandPreview(db, admin, prepared.preview.previewId, { propertyId: demo.propertyId,
    commandType: prepared.preview.commandType, confirmation: true, expectedEffectHash: prepared.preview.effectHash,
    reason: { code: prepared.preview.commandType === "CREATE_ORDER" ? "CREATE_STANDARD_ORDER" : prepared.preview.commandType, note: prepared.preview.commandType === "CREATE_ORDER" ? "" : "合成回归" } }, key);
}
async function execute(envelope: CommandEnvelope) {
  const receipt = await confirm(await prepare(envelope));
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}

describe.sequential("canonical command snapshots and operational catalog labels", () => {
  beforeAll(async () => {
    owner = await resetDatabase(url);
    await owner.insertInto("web_sessions").values({ id: admin.credentialId, subject_id: admin.subjectId,
      secret_hash: sha256("synthetic-snapshot-session"), expires_at: new Date("2030-01-01"), revoked_at: null }).execute();
    db = createDatabase(runtimeDatabaseUrlForTesting(url));
  }, 120000);
  afterAll(async () => { if (db) await db.destroy(); if (owner) await owner.destroy(); });

  it("commits A02 to B01 after the first building sort without altering canonical inventory", async () => {
    const before = await loadInventoryUnit(db, demo.propertyId, "unit_room_b01");
    const catalog = await readRoomCatalog(db, demo.propertyId);
    expect(catalog.version).toBe(0);
    await execute({ commandType: "MANAGE_ROOM_CATALOG", input: { propertyId: demo.propertyId,
      expectedVersion: catalog.version, action: "SET_BUILDING_ORDER", buildingOrder: [...catalog.buildingOrder!].reverse() } });
    expect(await loadInventoryUnit(db, demo.propertyId, "unit_room_b01")).toEqual(before);
    const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: "unit_room_a02",
      arrivalDate: "2028-09-13", departureDate: "2028-09-20", pricingPolicyVersionId: demo.publicPricingPolicyId });
    orderId = String((await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId,
      quoteId: quote.quoteId, primaryGuest: { fullName: "合成换房", nickname: "合成换房" }, bookingChannelCode: "WECOM" } })).result!.orderId);
    const draft = await prepare({ commandType: "MOVE_UNIT", input: { propertyId: demo.propertyId, orderId,
      newInventoryUnitId: "unit_room_b01", effectiveDate: "2028-09-13" } });
    expect(draft.preview.effect).toMatchObject({ toInventoryUnit: before });
    const result = await confirm(draft);
    expect(result.businessCommitted, JSON.stringify(result.error)).toBe(true);
    expect((await getReceipt(db, admin, result.receiptId)).businessCommitted).toBe(true);
  });

  it("uses renamed labels for current display and search while preserving raw snapshot names", async () => {
    const before = await getOrderView(db, orderId);
    const catalog = await readRoomCatalog(db, demo.propertyId);
    const type = catalog.types.find((item) => item.code === "private_bath_single")!;
    await execute({ commandType: "MANAGE_ROOM_CATALOG", input: { propertyId: demo.propertyId, expectedVersion: catalog.version,
      action: "SAVE_TYPE", typeCode: type.code, name: "回归专用单间", bathroom: type.bathroom, saleMode: type.saleMode,
      bedCount: type.bedCount, capacity: type.capacity } });
    const after = await getOrderView(db, orderId);
    expect(after.amendments).toEqual(before.amendments);
    expect(after.referencedInventoryUnits.map((unit) => unit.name)).toEqual(before.referencedInventoryUnits.map((unit) => unit.name));
    expect(after.referencedInventoryUnits.find((unit) => unit.id === "unit_room_b01")?.display_name).toBe("B01 回归专用单间");
    const listed = await listOrders(db, { propertyId: demo.propertyId, query: "回归专用单间", pageSize: 1 });
    expect(listed.orders.map((order) => order.id)).toEqual([orderId]);
    expect(listed.orders[0]!.current_unit_name).toBe("B01 回归专用单间");
    const app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(url)));
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, cookies: { qintopia_session: "synthetic-snapshot-session" } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().referencedInventoryUnits.find((unit: { id: string }) => unit.id === "unit_room_b01").display_name).toBe("B01 回归专用单间");
    } finally { await app.close(); }
  });

  it("projects renamed labels on newly created orders and filters before pagination", async () => {
    const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: "unit_room_b02",
      arrivalDate: "2028-09-13", departureDate: "2028-09-20", pricingPolicyVersionId: demo.publicPricingPolicyId });
    const created = await execute({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId,
      primaryGuest: { fullName: "更名后合成订单", nickname: "更名后合成订单" }, bookingChannelCode: "WECOM" } });
    const newOrderId = String(created.result!.orderId);
    const view = await getOrderView(db, newOrderId);
    expect(view.referencedInventoryUnits[0]!.display_name).toBe("B02 回归专用单间");
    expect(view.referencedInventoryUnits[0]!.name).toBe((await loadInventoryUnit(db, demo.propertyId, "unit_room_b02")).name);
    const first = await listOrders(db, { propertyId: demo.propertyId, query: "回归专用单间", pageSize: 1 });
    expect(first.orders.map((order) => order.id)).toEqual([newOrderId]);
    expect(first.nextCursor).toBe(newOrderId);
    const second = await listOrders(db, { propertyId: demo.propertyId, query: "回归专用单间", pageSize: 1, beforeId: first.nextCursor! });
    expect(second.orders.map((order) => order.id)).toEqual([orderId]);
    expect(second.nextCursor).toBeNull();
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: newOrderId } });
  });

  it.each([ ["23514", false], ["40001", true] ] as const)("persists and replays %s failures with safe diagnostics", async (code, retryable) => {
    const before = await getOrderView(db, orderId);
    const draft = await prepare({ commandType: "MOVE_UNIT", input: { propertyId: demo.propertyId, orderId,
      newInventoryUnitId: "unit_room_a02", effectiveDate: "2028-09-13" } });
    // Synthetic failure injection in an isolated database, with all real guards enabled.
    await sql.raw(`CREATE FUNCTION synthetic_catalog_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic private detail' USING ERRCODE = '${code}', CONSTRAINT = 'synthetic_catalog_constraint'; END $$`).execute(owner);
    await sql`CREATE TRIGGER synthetic_catalog_failure BEFORE INSERT ON amendments FOR EACH ROW EXECUTE FUNCTION synthetic_catalog_failure()`.execute(owner);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const key = metadata();
      const receipt = await confirm(draft, key);
      expect(receipt).toMatchObject({ businessCommitted: false, error: { code: "COMMAND_INTERRUPTED", retryable } });
      expect((await confirm(draft, key)).receiptId).toBe(receipt.receiptId);
      expect((await getReceipt(db, admin, receipt.receiptId)).error).toEqual(receipt.error);
      expect(await getOrderView(db, orderId)).toEqual(before);
      const output = logger.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain(`"sqlState":"${code}"`);
      expect(output).not.toContain("synthetic private detail");
    } finally {
      logger.mockRestore();
      await sql`DROP TRIGGER synthetic_catalog_failure ON amendments`.execute(owner);
      await sql`DROP FUNCTION synthetic_catalog_failure()`.execute(owner);
    }
  });

  it("keeps terminal order display and search on historical labels", async () => {
    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } });
    const view = await getOrderView(db, orderId);
    expect(view.referencedInventoryUnits.every((unit) => unit.display_name === undefined)).toBe(true);
    expect((await listOrders(db, { propertyId: demo.propertyId, query: "回归专用单间" })).orders).toEqual([]);
    const rows = await listOrders(db, { propertyId: demo.propertyId, orderIds: [orderId] });
    expect(rows.orders[0]!.current_unit_name).toBe(view.referencedInventoryUnits.find((unit) => unit.id === "unit_room_b01")!.name);
  });
});
