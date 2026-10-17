import { beforeEach, afterEach, expect, it } from "vitest";
import type { CommandEnvelope } from "@qintopia/contracts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { sql, type Kysely } from "kysely";
import { createDatabase, listMemberPage, getMemberView, propertyLocalToday, withPropertyClockForTesting, createCommandPreview, confirmCommandPreview, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { resetDatabase } from "../helpers/database.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { demo } from "../../packages/db/src/seed.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_test";
let db: Kysely<Database>;
beforeEach(async () => { db = await resetDatabase(url); });
afterEach(async () => { await db?.destroy(); });

it("orders by joining this property, keeps microseconds and stable ties, and can continue after a cursor is soft-deleted", async () => {
  const members = ["a", "b", "c", "d"].map(id => ({ id: `overview_${id}`, full_name: id, nickname: `目录${id}`, phone: `1880000000${id}`, wechat: id }));
  await db.insertInto("members").values(members).execute();
  for (const [index, member] of members.entries()) {
    await db.insertInto("member_property_links").values({ member_id: member.id, property_id: demo.propertyId,
      created_at: sql`'2026-10-17 01:00:00+00'::timestamptz + ${index < 2 ? 2 : index === 2 ? 1 : 0} * interval '1 microsecond'` }).execute();
  }
  const options = { directory: true, pageSize: 1 };
  const first = await listMemberPage(db, demo.propertyId, "目录", options);
  expect(first.members[0]!.member.id).toBe("overview_a");
  expect(first.members[0]!.directory?.entitlements).toEqual([]);
  const second = await listMemberPage(db, demo.propertyId, "目录", { ...options, beforeId: first.nextCursor! });
  expect(second.members[0]!.member.id).toBe("overview_b");
  const app = await buildServer(createDatabase(url));
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "demo-pass-2026" } });
  const cookies = { qintopia_session: login.cookies.find(c => c.name === "qintopia_session")!.value };
  const preview = await app.inject({ url: `/api/v1/members/overview_b/deletion-preview?propertyId=${demo.propertyId}`, cookies });
  const deleted = await app.inject({ method: "POST", url: "/api/v1/account-management", cookies, payload: { action: "DELETE_MEMBER", propertyId: demo.propertyId, requestId: "overview-delete", reason: "合成目录测试", confirmation: true, targetId: "overview_b", expectedVersion: preview.json().version } });
  expect(deleted.statusCode, deleted.body).toBe(200);
  await app.close();
  const rest = await listMemberPage(db, demo.propertyId, "目录", { directory: true, beforeId: second.nextCursor! });
  expect(rest.members.map(x => x.member.id)).toEqual(["overview_c", "overview_d"]);
  expect(rest.nextCursor).toBeNull();
  await expect(listMemberPage(db, demo.propertyId, undefined, { directory: true, beforeId: "other-property" })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
});

it("projects only formal lots, matches the detail balance including holds, and expires on the property date boundary", async () => {
  const view = await getMemberView(db, demo.propertyId, demo.memberId);
  const order = view.membershipOrders.find(x => x.order.entitlement_lot_id)!.order;
  const lot = view.lots.find(x => x.id === order.entitlement_lot_id)!;
  const read = () => listMemberPage(db, demo.propertyId, undefined, { memberId: demo.memberId, directory: true });
  const at = (date: string) => new Date(`${date}T04:00:00+08:00`);
  const before = at(order.valid_from!); before.setUTCDate(before.getUTCDate() - 1);
  const pending = await withPropertyClockForTesting(before, read);
  expect(pending.members[0]!.directory!.entitlements.find(x => x.orderId === order.id)).toMatchObject({ status: "PENDING", availableUnits: 0 });
  const first = await withPropertyClockForTesting(at(order.valid_from!), read);
  expect(first.members[0]!.directory!.entitlements).toHaveLength(view.membershipOrders.length);
  expect(first.members[0]!.directory!.entitlements.find(x => x.orderId === order.id)).toMatchObject({ status: "ACTIVE", availableUnits: view.lotBalances.find(x => x.lotId === lot.id)!.availableUnits, expiresOn: lot.expires_on });
  const principal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write", credentialType: "TOKEN" as const, displayName: "Agent", ...authScope() };
  let sequence = 0;
  async function confirm(envelope: CommandEnvelope) {
    const key = `overview-stay-${++sequence}`;
    const preview = await createCommandPreview(db, principal, envelope, { idempotencyKey: key, correlationId: key });
    return confirmCommandPreview(db, principal, preview.preview.previewId, { propertyId: demo.propertyId, commandType: envelope.commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: { code: envelope.commandType === "CREATE_ORDER" ? "CREATE_STANDARD_ORDER" : "TEST", note: envelope.commandType === "CREATE_ORDER" ? "" : "目录冻结释放测试" } }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  }
  const today = await propertyLocalToday(db, demo.propertyId);
  const shift = (days: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const unit = await db.selectFrom("inventory_units").select("id").where("property_id", "=", demo.propertyId).where("room_type_code", "=", order.allowed_room_type_code).where("kind", "=", "ROOM").executeTakeFirstOrThrow();
  const quote = await createQuoteForTesting(db, { propertyId: demo.propertyId, inventoryUnitId: unit.id, arrivalDate: shift(1), departureDate: shift(3), pricingPolicyVersionId: demo.publicPricingPolicyId, memberId: demo.memberId });
  const created = await confirm({ commandType: "CREATE_ORDER", input: { propertyId: demo.propertyId, quoteId: quote.quoteId, primaryGuest: { fullName: "合成住客", nickname: "合成住客" } } });
  expect(created.businessCommitted, JSON.stringify(created)).toBe(true);
  const held = await read();
  expect(held.members[0]!.directory!.entitlements.find(x => x.orderId === order.id)!.availableUnits).toBe(lot.total_units - 2);
  const cancelled = await confirm({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId: created.result!.orderId as string } });
  expect(cancelled.businessCommitted).toBe(true);
  const onExpiry = await withPropertyClockForTesting(at(lot.expires_on), read);
  expect(onExpiry.members[0]!.directory!.entitlements.find(x => x.orderId === order.id)).toMatchObject({ status: "ACTIVE", availableUnits: lot.total_units });
  const next = at(lot.expires_on); next.setUTCDate(next.getUTCDate() + 1);
  const expired = await withPropertyClockForTesting(next, read);
  expect(expired.members[0]!.directory!.entitlements.find(x => x.orderId === order.id)).toMatchObject({ status: "EXPIRED", availableUnits: 0 });
});

it("exposes directory fields through the authorized HTTP schema, distinguishes unissued orders, and leaves lightweight callers unchanged", async () => {
  const principal = { subjectId: demo.agentSubjectId, credentialId: "token_demo_write", credentialType: "TOKEN" as const, displayName: "Agent", ...authScope() };
  const command = { commandType: "CREATE_MEMBERSHIP_ORDER" as const, input: { propertyId: demo.propertyId, memberId: demo.memberId, membershipProductId: "membership_product_shared_bath_quad_v1", agreedPriceMinor: 93600 } };
  const preview = await createCommandPreview(db, principal, command, { idempotencyKey: "overview-create", correlationId: "overview-create" });
  const created = await confirmCommandPreview(db, principal, preview.preview.previewId, { propertyId: demo.propertyId, commandType: command.commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash, reason: { code: "TEST", note: "目录读模型测试" } }, { idempotencyKey: "overview-confirm", correlationId: "overview-confirm" });
  const app = await buildServer(createDatabase(url));
  try {
    const headers = { authorization: `Bearer ${demo.readToken}` };
    const response = await app.inject({ method: "GET", url: `/api/v1/members?propertyId=${demo.propertyId}&directory=true`, headers });
    expect(response.statusCode, response.body).toBe(200);
    const row = response.json().members.find((x: { member: { id: string } }) => x.member.id === demo.memberId);
    expect(row.directory.entitlements).toContainEqual(expect.objectContaining({ status: "PENDING", availableUnits: null, expiresOn: null, unitKind: "BED_NIGHT" }));
    const cancellation = await createCommandPreview(db, principal, { commandType: "CANCEL_MEMBERSHIP_ORDER", input: { propertyId: demo.propertyId, membershipOrderId: created.result!.membershipOrderId, reason: "测试取消未生效订单" } }, { idempotencyKey: "overview-cancel", correlationId: "overview-cancel" });
    const cancelled = await confirmCommandPreview(db, principal, cancellation.preview.previewId, { propertyId: demo.propertyId, commandType: "CANCEL_MEMBERSHIP_ORDER", confirmation: true, expectedEffectHash: cancellation.preview.effectHash, reason: { code: "TEST", note: "测试取消未生效订单" } }, { idempotencyKey: "overview-cancel-confirm", correlationId: "overview-cancel-confirm" });
    expect(cancelled.businessCommitted).toBe(true);
    const refreshed = await listMemberPage(db, demo.propertyId, undefined, { memberId: demo.memberId, directory: true });
    expect(refreshed.members[0]!.directory!.entitlements).toContainEqual(expect.objectContaining({ status: "CANCELLED", availableUnits: null, expiresOn: null }));
    expect((await listMemberPage(db, demo.propertyId)).members[0]).not.toHaveProperty("directory");
    expect((await app.inject({ method: "GET", url: "/api/v1/members?propertyId=other&directory=true", headers })).statusCode).toBe(403);
  } finally { await app.close(); }
});
