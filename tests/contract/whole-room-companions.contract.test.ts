import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { createDatabase, databaseReady, propertyLocalToday, type Database } from "@qintopia/db";
import { newId } from "@qintopia/domain";
import { assertOrderView } from "../../apps/web/src/orderViewValidation.ts";
import { receiptHasCommandEvidence } from "../../apps/web/src/ui.tsx";
import type { CommandType } from "@qintopia/contracts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const url = "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_companions_contract";
let owner: Kysely<Database>;
let runtime: Kysely<Database>;
let app: FastifyInstance;
let cookie: string;
let seq = 0;
const propertyId = demo.propertyId;
const guest = { fullName: "同住测试", nickname: "同住人", phone: null, documentNumber: null };
const headers = () => ({ "idempotency-key": `companion-${++seq}`, "x-correlation-id": `companion-${seq}` });
async function preview(commandType: CommandType, input: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/command-previews", cookies: { qintopia_session: cookie }, headers: headers(), payload: { commandType, input: { propertyId, ...input } } });
}
async function confirm(commandType: CommandType, proposed: any, key = headers()) {
  const reason = commandType === "CREATE_ORDER" && proposed.preview.effect.temporaryOtherRoomReason
    ? { code: "TEMPORARY_OTHER_ROOM", note: proposed.preview.effect.temporaryOtherRoomReason }
    : { code: commandType === "CREATE_ORDER" ? "CREATE_STANDARD_ORDER" : commandType, note: commandType === "CREATE_ORDER" ? "" : "补录或纠正误录" };
  return app.inject({ method: "POST", url: `/api/v1/command-previews/${proposed.preview.previewId}/confirm`, cookies: { qintopia_session: cookie }, headers: key, payload: { propertyId, commandType, confirmation: true, expectedEffectHash: proposed.preview.effectHash, reason } });
}
async function command(commandType: CommandType, input: Record<string, unknown>) {
  const proposed = await preview(commandType, input);
  expect(proposed.statusCode, proposed.body).toBe(200);
  const response = await confirm(commandType, proposed.json());
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json(), response.body).toMatchObject({ businessCommitted: true });
  if (commandType === "MANAGE_ORDER_OCCUPANTS") expect(receiptHasCommandEvidence(commandType, response.json(), input, proposed.json().preview.effect, proposed.json().preview.effectHash)).toBe(true);
  return response.json();
}
async function reservation(inventoryUnitId: string = demo.roomId, arrivalDate = "2027-01-01", departureDate = "2027-01-03") {
  const quote = await createQuoteForTesting(owner, { propertyId, inventoryUnitId, stayType: "TRANSIENT", arrivalDate, departureDate, pricingPolicyVersionId: demo.publicPricingPolicyId });
  return command("CREATE_ORDER", { quoteId: quote.quoteId, bookingChannelCode: "WECOM", primaryGuest: { fullName: "主入住测试", nickname: "主入住人" } });
}
async function view(orderId: string) {
  const response = await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, cookies: { qintopia_session: cookie } });
  expect(response.statusCode, response.body).toBe(200);
  assertOrderView(response.json());
  return response.json();
}
beforeAll(async () => {
  process.env.LOG_LEVEL = "error";
  owner = await resetDatabase(url);
  runtime = createDatabase(runtimeDatabaseUrlForTesting(url));
  app = await buildServer(runtime);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "operator", password: "demo-pass-2026" } });
  expect(login.statusCode, login.body).toBe(200);
  cookie = login.cookies.find((entry) => entry.name === "qintopia_session")!.value;
});
afterAll(async () => { await app?.close(); await owner?.destroy(); });

describe("whole-room companion registration with restricted runtime", () => {
  it("is ready after migration and profile reconciliation", async () => {
    expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
  });
  it("adds, removes and re-adds companions without changing the booking facts or original receipt", async () => {
    const created = await reservation();
    const orderId = created.result.orderId;
    const before = await view(orderId);
    const added = await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
    expect(added.result).toMatchObject({ beforeCount: 1, afterCount: 2, arrivalDate: "2027-01-01", departureDate: "2027-01-03" });
    const current = await view(orderId);
    expect(current.occupants).toHaveLength(2);
    expect(current.occupants[1]).toMatchObject({ nickname: guest.nickname, role: "ADDITIONAL" });
    for (const field of ["pricingRevisions", "segments", "collectionFacts", "coverageSet", "amounts"]) {
      expect(current[field], field).toBeDefined();
      expect(current[field]).toEqual(before[field]);
    }
    await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "REMOVE", occupantId: added.result.occupantId });
    expect((await view(orderId)).occupants).toHaveLength(1);
    const readded = await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
    expect(readded.result.occupantId).not.toBe(added.result.occupantId);
    expect(await owner.selectFrom("order_occupants").select("id").where("order_id", "=", orderId).execute()).toHaveLength(3);
    expect(await owner.selectFrom("order_occupant_removals").select("id").where("order_id", "=", orderId).execute()).toHaveLength(1);
    const original = await owner.selectFrom("command_receipts").select("result").where("command_id", "=", created.commandId).executeTakeFirstOrThrow();
    expect(original.result).toEqual(created.result);
  });
  it("serializes competing previews and replays a confirmation exactly once", async () => {
    const { result: { orderId } } = await reservation(demo.roomId, "2027-02-01", "2027-02-03");
    const input = { orderId, action: "ADD", guest };
    const a = await preview("MANAGE_ORDER_OCCUPANTS", input);
    const b = await preview("MANAGE_ORDER_OCCUPANTS", { ...input, guest: { ...guest, nickname: "另一个人" } });
    expect(a.statusCode, a.body).toBe(200); expect(b.statusCode, b.body).toBe(200);
    const key = headers();
    const responses = await Promise.all([confirm("MANAGE_ORDER_OCCUPANTS", a.json(), key), confirm("MANAGE_ORDER_OCCUPANTS", b.json())]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => (response.json().error?.code ?? response.json().code) === "PREVIEW_STALE"), responses.map((response) => response.body).join("\n")).toHaveLength(1);
    if (responses[0]!.statusCode === 200) {
      expect((await confirm("MANAGE_ORDER_OCCUPANTS", a.json(), key)).json()).toEqual(responses[0]!.json());
    }
    expect((await view(orderId)).occupants).toHaveLength(2);
    await command("MANAGE_ORDER_OCCUPANTS", input);
    await command("MANAGE_ORDER_OCCUPANTS", input);
    const full = await preview("MANAGE_ORDER_OCCUPANTS", input);
    expect(full.statusCode, full.body).toBe(400);
    expect(full.json().message).toContain("最多可登记 4 人");
    expect((await view(orderId)).occupants).toHaveLength(4);
  });
  it("supports in-house registration and updates the room-status roster without changing capacity", async () => {
    const today = await propertyLocalToday(owner, propertyId);
    const departure = new Date(`${today}T00:00:00Z`); departure.setUTCDate(departure.getUTCDate() + 2);
    const { result: { orderId } } = await reservation(demo.roomId, today, departure.toISOString().slice(0, 10));
    await command("CHECK_IN", { orderId });
    const status = async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/properties/${propertyId}/room-status?arrivalDate=${today}&departureDate=${departure.toISOString().slice(0, 10)}&pageSize=200`, cookies: { qintopia_session: cookie } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const before = await status();
    await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest: { ...guest, nickname: "房态补录昵称" } });
    const after = await status();
    expect(JSON.stringify(after)).toContain("房态补录昵称");
    expect(after.revision).not.toEqual(before.revision);
    expect((await view(orderId)).order.status).toBe("CHECKED_IN");
  });
  it("rejects beds, terminal bookings and removal of the primary guest", async () => {
    const { result: { orderId: bedOrderId } } = await reservation(demo.bedAId, "2027-03-01", "2027-03-03");
    expect((await preview("MANAGE_ORDER_OCCUPANTS", { orderId: bedOrderId, action: "ADD", guest })).statusCode).toBe(400);
    const { result: { orderId } } = await reservation(demo.roomId, "2027-04-01", "2027-04-03");
    const primary = (await view(orderId)).occupants[0];
    expect((await preview("MANAGE_ORDER_OCCUPANTS", { orderId, action: "REMOVE", occupantId: primary.id })).statusCode).toBe(400);
    await command("CANCEL_ORDER", { orderId });
    expect((await preview("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest })).statusCode).toBe(409);
    expect((await view(orderId)).allowedActions.some((action: any) => action.code === "MANAGE_ORDER_OCCUPANTS" && action.enabled)).toBe(false);
  });
  it("rejects missing fields, cross-property and read-only requests", async () => {
    const { result: { orderId } } = await reservation(demo.roomId, "2027-05-01", "2027-05-03");
    for (const input of [{ orderId, action: "ADD" }, { orderId, action: "REMOVE" }, { orderId, action: "ADD", guest: { ...guest, nickname: " " } }, { orderId, action: "ADD", guest, occupantId: "injected" }]) {
      expect((await preview("MANAGE_ORDER_OCCUPANTS", input)).statusCode).toBe(400);
    }
    expect((await preview("MANAGE_ORDER_OCCUPANTS", { propertyId: "foreign", orderId, action: "ADD", guest })).statusCode).toBe(404);
    const denied = await app.inject({ method: "POST", url: "/api/v1/command-previews", headers: { ...headers(), authorization: `Bearer ${demo.readToken}` }, payload: { commandType: "MANAGE_ORDER_OCCUPANTS", input: { propertyId, orderId, action: "ADD", guest } } });
    expect(denied.statusCode, denied.body).toBe(403);
  });
  it("rejects an unaccompanied raw runtime insert and rolls back the whole transaction", async () => {
    const { result: { orderId } } = await reservation(demo.roomId, "2027-06-01", "2027-06-03");
    const commandId = newId("command");
    await expect(runtime.transaction().execute(async (trx) => {
      await trx.insertInto("command_executions").values({ id: commandId, subject_id: demo.operatorSubjectId, credential_id: "raw-test", property_id: propertyId, command_type: "MANAGE_ORDER_OCCUPANTS", idempotency_key: "raw-test", request_hash: "a".repeat(64), correlation_id: "raw-test", state: "EXECUTING", completed_at: null }).execute();
      await trx.insertInto("order_occupants").values({ id: "raw-companion", order_id: orderId, ordinal: 2, role: "ADDITIONAL", full_name: "伪造", nickname: "伪造", phone: null, document_number: null, created_by_command_id: commandId }).execute();
    })).rejects.toThrow(/companion change requires/);
    expect(await owner.selectFrom("command_executions").select("id").where("id", "=", commandId).executeTakeFirst()).toBeUndefined();
    expect((await view(orderId)).occupants).toHaveLength(1);
    await expect(sql`DELETE FROM order_occupants WHERE order_id = ${orderId}`.execute(runtime)).rejects.toThrow();
  });
  it("uses the smallest room capacity across a multi-room stay", async () => {
    const { result: { orderId } } = await reservation("unit_room_a01", "2027-07-01", "2027-07-05");
    await command("MOVE_UNIT", { orderId, newInventoryUnitId: demo.roomId, effectiveDate: "2027-07-03" });
    await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
    const rejected = await preview("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().message).toContain("最多可登记 2 人");
  });
  it("keeps correction history after removal and forbids editing a removed companion", async () => {
    const { result: { orderId } } = await reservation(demo.roomId, "2027-08-01", "2027-08-03");
    const added = await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
    const savedCookie = cookie;
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "demo-pass-2026" } });
    cookie = login.cookies.find((entry) => entry.name === "qintopia_session")!.value;
    try {
      const input = { orderId, occupantId: added.result.occupantId, expectedPriorSnapshot: guest, correctedSnapshot: { ...guest, nickname: "更正后的同住人" } };
      await command("CORRECT_ORDER_OCCUPANT", input);
      await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "REMOVE", occupantId: added.result.occupantId });
      const removed = await view(orderId);
      expect(removed.occupants).toHaveLength(1);
      expect(removed.occupantCorrections).toHaveLength(1);
      expect((await preview("CORRECT_ORDER_OCCUPANT", input)).statusCode).toBe(404);
    } finally { cookie = savedCookie; }
  });
  it("supports free whole-room stays without adding any charge", async () => {
    const quote = await createQuoteForTesting(owner, { propertyId, inventoryUnitId: demo.roomId, stayType: "FREE", arrivalDate: "2027-09-01", departureDate: "2027-09-03", pricingPolicyVersionId: demo.freePolicyId });
    const created = await command("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "免费主入住", nickname: "免费入住" }, freeStayCategoryCode: "RECEPTION", freeStayReason: "接待" });
    const orderId = created.result.orderId;
    const before = await view(orderId);
    await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
    expect((await view(orderId)).amounts).toEqual(before.amounts);
    expect((await view(orderId)).occupants).toHaveLength(2);
  });
  it("respects member room capacity and supports temporary-room companions without extra entitlements", async () => {
    const today = await propertyLocalToday(owner, propertyId);
    const shift = (days: number) => { const day = new Date(`${today}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); };
    const memberId = newId("member");
    await owner.insertInto("members").values({ id: memberId, full_name: "会员主入住", nickname: "会员", phone: "19900000123", wechat: "companion", identity_card_number: null }).execute();
    await owner.insertInto("member_property_links").values({ member_id: memberId, property_id: propertyId }).execute();
    const purchase = await command("CREATE_MEMBERSHIP_ORDER", { memberId, membershipProductId: "membership_product_shared_bath_single_v1", agreedPriceMinor: 162000 });
    await command("RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId: purchase.result.membershipOrderId, amountMinor: 100, transactionReference: "COMPANION-MEMBER-PAYMENT" });
    await command("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId: purchase.result.membershipOrderId });
    for (const temporary of [false, true]) {
      const quoted = await app.inject({ method: "POST", url: "/api/v1/quotes", cookies: { qintopia_session: cookie }, headers: headers(), payload: { propertyId, inventoryUnitId: temporary ? "unit_room_a01" : "unit_room_d_gen_01", stayType: "TRANSIENT", arrivalDate: shift(temporary ? 14 : 10), departureDate: shift(temporary ? 16 : 12), pricingPolicyVersionId: demo.publicPricingPolicyId, memberId, ...(temporary ? { temporaryOtherRoom: true } : {}) } });
      expect(quoted.statusCode, quoted.body).toBe(200);
      const quote = quoted.json().quote;
      const created = await command("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "会员主入住", nickname: "会员" }, ...(temporary ? { temporaryOtherRoomReason: "临时调整房间" } : {}) });
      const orderId = created.result.orderId;
      const before = await view(orderId);
      const ledger = await owner.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).execute();
      if (temporary) await command("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest });
      else expect((await preview("MANAGE_ORDER_OCCUPANTS", { orderId, action: "ADD", guest })).statusCode).toBe(400);
      const after = await view(orderId);
      expect(after.occupants).toHaveLength(temporary ? 2 : 1);
      expect(after.coverageSet).toEqual(before.coverageSet);
      expect(after.amounts).toEqual(before.amounts);
      expect(await owner.selectFrom("entitlement_ledger").selectAll().where("order_id", "=", orderId).execute()).toEqual(ledger);
    }
  });
});
