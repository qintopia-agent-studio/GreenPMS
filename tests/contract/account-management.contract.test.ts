import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { AccountManagementContext, AccountManagementRequest, MemberDeletionPreview } from "@qintopia/contracts";
import { createDatabase, databaseReady, propertyLocalToday, reconcileStaffProfileManifest, type Database } from "@qintopia/db";
import { newId, sha256 } from "@qintopia/domain";
import type { CommandType } from "@qintopia/contracts";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";

const databaseUrl = process.env.ACCOUNT_MANAGEMENT_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_account_management_test";
const propertyId = demo.propertyId;
let owner: Kysely<Database>;
let runtime: Kysely<Database>;
let app: FastifyInstance;
let adminCookie: string;
let staffCookie: string;
let sequence = 0;

async function login(username = "admin", password = "demo-pass-2026") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode, response.body).toBe(200);
  return response.cookies.find((cookie) => cookie.name === "qintopia_session")!.value;
}
async function context(cookie = adminCookie) {
  const response = await app.inject({ method: "GET", url: `/api/v1/account-management?propertyId=${propertyId}`, cookies: { qintopia_session: cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AccountManagementContext>();
}
function request(action: AccountManagementRequest["action"], extra: Partial<AccountManagementRequest> = {}): AccountManagementRequest {
  return { action, propertyId, requestId: `management-${++sequence}`, reason: "录入错误测试", confirmation: true, ...extra };
}
async function manage(body: AccountManagementRequest, cookie = adminCookie) {
  return app.inject({ method: "POST", url: "/api/v1/account-management", cookies: { qintopia_session: cookie }, payload: body });
}
async function createStaff() {
  const username = `employee_${++sequence}`;
  const body = request("CREATE_STAFF", { username, displayName: "验收员工", newPassword: "test-password-2026" });
  const response = await manage(body);
  expect(response.statusCode, response.body).toBe(200);
  return { username, id: response.json().targetId as string, body };
}
async function createMember() {
  const id = newId("member");
  const phone = `196${String(++sequence).padStart(8, "0")}`;
  await owner.insertInto("members").values({ id, full_name: "误建会员", nickname: "误建", phone, wechat: "test", identity_card_number: null }).execute();
  await owner.insertInto("member_property_links").values({ member_id: id, property_id: propertyId }).execute();
  return { id, phone };
}
async function deletion(id: string) {
  const response = await app.inject({ method: "GET", url: `/api/v1/members/${id}/deletion-preview?propertyId=${propertyId}`, cookies: { qintopia_session: adminCookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MemberDeletionPreview>();
}
async function command(commandType: CommandType, input: Record<string, unknown>) {
  const headers = () => ({ "idempotency-key": `account-command-${++sequence}`, "x-correlation-id": `account-command-${sequence}` });
  const preview = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies: { qintopia_session: adminCookie }, headers: headers(), payload: { commandType, input: { propertyId, ...input } } });
  expect(preview.statusCode, preview.body).toBe(200);
  const result = await app.inject({ method: "POST", url: `/api/v1/command-previews/${preview.json().preview.previewId}/confirm`, cookies: { qintopia_session: adminCookie }, headers: headers(), payload: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.json().preview.effectHash, reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : { code: commandType, note: "9.6 回归" } } });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json(), result.body).toMatchObject({ businessCommitted: true });
  return result.json().result as Record<string, unknown>;
}

async function activeMembership() {
  const member = await createMember();
  const demoPurchase = await owner.selectFrom("membership_orders").select("product_id").where("id", "=", demo.membershipOrderId).executeTakeFirstOrThrow();
  const product = await owner.selectFrom("membership_products").selectAll().where("id", "=", demoPurchase.product_id).executeTakeFirstOrThrow();
  const created = await command("CREATE_MEMBERSHIP_ORDER", { memberId: member.id, membershipProductId: product.id, agreedPriceMinor: product.list_price_minor });
  const membershipOrderId = created.membershipOrderId as string;
  await command("RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId, amountMinor: 1000, transactionReference: `DELETE-PAY-${++sequence}` });
  await command("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId });
  const purchase = await owner.selectFrom("membership_orders").selectAll().where("id", "=", membershipOrderId).executeTakeFirstOrThrow();
  return { member, product, purchase };
}

async function memberReservation(contractId: string) {
  const arrivalDate = await propertyLocalToday(owner, propertyId);
  const departure = new Date(`${arrivalDate}T00:00:00Z`);
  departure.setUTCDate(departure.getUTCDate() + 2);
  const quote = await createQuoteForTesting(owner, { propertyId, inventoryUnitId: "unit_room_d_gen_01", stayType: "TRANSIENT", arrivalDate, departureDate: departure.toISOString().slice(0, 10), pricingPolicyVersionId: demo.publicPricingPolicyId, memberContractId: contractId });
  return command("CREATE_ORDER", { quoteId: quote.quoteId, primaryGuest: { fullName: "误建会员", nickname: "删除预订核查" } });
}

beforeAll(async () => {
  process.env.LOG_LEVEL = "silent";
  process.env.LOGIN_RATE_LIMIT_MAX = "1000";
  process.env.ACCOUNT_MANAGEMENT_RATE_LIMIT_MAX = "1000";
  owner = await resetDatabase(databaseUrl);
  runtime = createDatabase(runtimeDatabaseUrlForTesting(databaseUrl));
  app = await buildServer(runtime);
  await app.ready();
  adminCookie = await login(); staffCookie = await login("operator");
});
afterAll(async () => { await app?.close(); await owner?.destroy(); });

describe("9.6 account management with the restricted runtime identity", () => {
  it("exposes staff management only to a current administrator session", async () => {
    expect((await context()).canManageStaff).toBe(true);
    const staff = await context(staffCookie);
    expect(staff.canManageStaff).toBe(false); expect(staff.accounts).toEqual([]);
    const denied = await manage(request("CREATE_STAFF", { username: "denied_user", displayName: "拒绝", newPassword: "test-password-2026" }), staffCookie);
    expect(denied.statusCode).toBe(403);
    const token = await app.inject({ method: "GET", url: `/api/v1/account-management?propertyId=${propertyId}`, headers: { authorization: `Bearer ${demo.administratorWriteToken}` } });
    expect(token.statusCode).toBe(403);
    const foreign = await app.inject({ method: "GET", url: "/api/v1/account-management?propertyId=prop_foreign", cookies: { qintopia_session: adminCookie } });
    expect(foreign.statusCode).toBe(403);
  });

  it("cannot substitute the stored session digest for possession of an administrator's session secret", async () => {
    const session = await owner.selectFrom("web_sessions").selectAll().where("secret_hash", "=", sha256(adminCookie)).executeTakeFirstOrThrow();
    await expect(sql`SELECT qintopia_manage_account(${session.subject_id},${session.id},${session.secret_hash},${propertyId},
      ${newId("audit")},'forged-management-session',${"a".repeat(64)},'DELETE_MEMBER',${JSON.stringify({ targetId: demo.memberId, expectedVersion: "1", confirmation: true, reason: "forged" })}::jsonb)`.execute(runtime)).rejects.toThrow(/MANAGEMENT_SESSION/);
  });

  it("creates STAFF exactly once, preserves permissions on reconciliation, and returns no credentials", async () => {
    const staff = await createStaff();
    const repeated = await manage(staff.body);
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.json().targetId).toBe(staff.id);
    expect((await manage({ ...staff.body, newPassword: "different-password-2026" })).statusCode).toBe(409);
    expect(await owner.selectFrom("staff_profile_assignments").select("profile").where("subject_id", "=", staff.id).executeTakeFirst()).toEqual({ profile: "STAFF" });
    await reconcileStaffProfileManifest(owner, "demo");
    expect((await context()).accounts.some((account) => account.id === staff.id)).toBe(true);
    const operations = await owner.selectFrom("account_management_operations").selectAll().where("target_id", "=", staff.id).execute();
    expect(operations).toHaveLength(1);
    expect(JSON.stringify(operations)).not.toContain("test-password-2026");
    expect(repeated.body).not.toMatch(/password|salt|hash/i);
    expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
  });

  it("rejects role injection, missing confirmation, short passwords, and administrator targets", async () => {
    const payload = { ...request("CREATE_STAFF", { username: "injected_admin", displayName: "角色注入", newPassword: "test-password-2026" }), profile: "ADMIN" };
    expect((await app.inject({ method: "POST", url: "/api/v1/account-management", cookies: { qintopia_session: adminCookie }, payload })).statusCode).toBe(400);
    expect((await manage(request("CREATE_STAFF", { username: "short_password", displayName: "短密码", newPassword: "short" }))).statusCode).toBe(400);
    expect((await manage({ ...request("DELETE_STAFF", { targetId: demo.operatorSubjectId, expectedVersion: "1" }), confirmation: false } as unknown as AccountManagementRequest)).statusCode).toBe(400);
    for (const action of ["DISABLE_STAFF", "DELETE_STAFF", "RESET_PASSWORD"] as const) {
      const response = await manage(request(action, { targetId: demo.administratorSubjectId, expectedVersion: "1", ...(action === "RESET_PASSWORD" ? { newPassword: "test-password-2026" } : {}) }));
      expect(response.statusCode, response.body).toBe(403);
    }
  });

  it("deletes only unused employees and retains the deletion audit", async () => {
    const empty = await createStaff();
    expect((await manage(request("DELETE_STAFF", { targetId: empty.id, expectedVersion: "1" }))).statusCode).toBe(200);
    expect(await owner.selectFrom("subjects").select("id").where("id", "=", empty.id).executeTakeFirst()).toBeUndefined();
    expect((await owner.selectFrom("account_management_operations").select("action").where("target_id", "=", empty.id).execute()).map((row) => row.action)).toContain("DELETE_STAFF");
    const used = await createStaff(); await login(used.username, "test-password-2026");
    const rejected = await manage(request("DELETE_STAFF", { targetId: used.id, expectedVersion: "1" }));
    expect(rejected.statusCode, rejected.body).toBe(409);
  });

  it("keeps initialized staff identities so their deployment manifest remains valid", async () => {
    expect((await context()).accounts.find((account) => account.id === demo.operatorSubjectId)?.canDelete).toBe(false);
    const response = await manage(request("DELETE_STAFF", { targetId: demo.operatorSubjectId, expectedVersion: "1" }));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().message).toContain("初始化账号");
    expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
  });

  it("disables credentials atomically, does not resurrect them on enable, and resets passwords", async () => {
    const staff = await createStaff();
    const tokenSecret = `qtp_step96_${staff.id}`;
    await owner.insertInto("api_tokens").values({ id: newId("token"), subject_id: staff.id, label: "测试 Token", secret_hash: sha256(tokenSecret), access_ceiling: "READ", property_scope: propertyId, expires_at: new Date("2030-01-01"), revoked_at: null, rotated_from_id: null, replaced_by_id: null }).execute();
    const cookie = await login(staff.username, "test-password-2026");
    const disabled = await manage(request("DISABLE_STAFF", { targetId: staff.id, expectedVersion: "1" }));
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { authorization: `Bearer ${tokenSecret}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: staff.username, password: "test-password-2026" } })).statusCode).toBe(401);
    expect((await manage(request("ENABLE_STAFF", { targetId: staff.id, expectedVersion: "1" }))).statusCode).toBe(409);
    expect((await manage(request("ENABLE_STAFF", { targetId: staff.id, expectedVersion: "2" }))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { authorization: `Bearer ${tokenSecret}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: cookie } })).statusCode).toBe(401);
    const secondCookie = await login(staff.username, "test-password-2026");
    expect((await manage(request("RESET_PASSWORD", { targetId: staff.id, expectedVersion: "3", newPassword: "replacement-password-2026" }))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: secondCookie } })).statusCode).toBe(401);
    await login(staff.username, "replacement-password-2026");
  });

  it("requires the current password for self service and revokes every old session", async () => {
    const staff = await createStaff();
    const cookie = await login(staff.username, "test-password-2026");
    const otherCookie = await login(staff.username, "test-password-2026");
    const change = request("CHANGE_PASSWORD", { targetId: staff.id, expectedVersion: "1", currentPassword: "wrong", newPassword: "self-changed-password-2026" });
    expect((await manage(change, cookie)).statusCode).toBe(400);
    expect((await manage({ ...change, requestId: `change-${++sequence}`, currentPassword: "test-password-2026" }, cookie)).statusCode).toBe(200);
    for (const old of [cookie, otherCookie]) expect((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: old } })).statusCode).toBe(401);
    await login(staff.username, "self-changed-password-2026");
  });

  it("deletes an empty member, hides all everyday reads, reuses the phone, and keeps history", async () => {
    const member = await createMember(); const preview = await deletion(member.id);
    const body = request("DELETE_MEMBER", { targetId: member.id, expectedVersion: preview.version });
    expect(preview.canDelete).toBe(true);
    expect((await manage(body)).statusCode).toBe(200);
    expect((await manage(body)).statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/v1/members/${member.id}?propertyId=${propertyId}`, cookies: { qintopia_session: staffCookie } });
    expect(detail.statusCode).toBe(404);
    for (const url of ["/api/v1/meta", `/api/v1/members?propertyId=${propertyId}`]) {
      const response = await app.inject({ method: "GET", url, cookies: { qintopia_session: staffCookie } });
      expect(response.statusCode).toBe(200); expect(response.body).not.toContain(member.id);
    }
    const old = await owner.selectFrom("members").selectAll().where("id", "=", member.id).executeTakeFirstOrThrow();
    expect(old.deleted_at).not.toBeNull(); expect(old.phone).toBe(member.phone);
    await owner.insertInto("members").values({ id: newId("member"), full_name: "重建", nickname: "新会员", phone: member.phone, wechat: "test", identity_card_number: null }).execute();
    expect((await context()).history.some((item) => item.targetId === member.id && item.reason === "录入错误测试")).toBe(true);
  });

  it("rejects linked members, stale previews, and direct runtime mutation", async () => {
    const legacy = await createMember();
    await owner.insertInto("member_contracts").values({ id: newId("contract"), property_id: propertyId, member_id: legacy.id, member_name: "旧会员", status: "ACTIVE", valid_from: "2026-01-01", valid_until: "2027-01-01", version: 1 }).execute();
    const linked = await deletion(legacy.id); expect(linked.canDelete).toBe(false);
    expect((await manage(request("DELETE_MEMBER", { targetId: legacy.id, expectedVersion: linked.version }))).statusCode).toBe(409);
    const member = await createMember();
    expect((await manage(request("DELETE_MEMBER", { targetId: member.id, expectedVersion: "stale" }))).statusCode).toBe(409);
    await expect(runtime.updateTable("members").set({ deleted_at: new Date() }).where("id", "=", member.id).execute()).rejects.toThrow(/permission denied/);
    await expect(runtime.updateTable("subjects").set({ status: "DISABLED" }).where("id", "=", demo.administratorSubjectId).execute()).rejects.toThrow(/permission denied/);
    await expect(runtime.insertInto("account_management_operations").values({ id: "fake", actor_subject_id: demo.administratorSubjectId, credential_id: "fake", property_id: propertyId, request_id: "fake", request_hash: "a".repeat(64), action: "DELETE_MEMBER", target_id: member.id, reason: "fake", result: {} }).execute()).rejects.toThrow(/permission denied/);
  });

  it("rechecks a member's new business link after waiting for its lock", async () => {
    const member = await createMember(); const preview = await deletion(member.id);
    let release!: () => void; let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    const insertion = owner.transaction().execute(async (trx) => {
      await trx.selectFrom("members").select("id").where("id", "=", member.id).forUpdate().execute();
      await trx.insertInto("member_contracts").values({ id: newId("contract"), property_id: propertyId, member_id: member.id, member_name: "误建会员", status: "ACTIVE", valid_from: "2026-01-01", valid_until: "2027-01-01", version: 1 }).execute();
      locked(); await releaseLock;
    });
    await lockReady;
    const deleting = manage(request("DELETE_MEMBER", { targetId: member.id, expectedVersion: preview.version }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release(); await insertion;
    expect((await deleting).statusCode).toBe(409);
    expect((await owner.selectFrom("members").select("deleted_at").where("id", "=", member.id).executeTakeFirstOrThrow()).deleted_at).toBeNull();
  });

  it("rejects new business references to a deleted member", async () => {
    const member = await createMember(); const preview = await deletion(member.id);
    expect((await manage(request("DELETE_MEMBER", { targetId: member.id, expectedVersion: preview.version }))).statusCode).toBe(200);
    await expect(owner.insertInto("member_contracts").values({ id: newId("contract"), property_id: propertyId, member_id: member.id, member_name: "误建会员", status: "ACTIVE", valid_from: "2026-01-01", valid_until: "2027-01-01", version: 1 }).execute()).rejects.toThrow(/deleted or is unavailable/);
    const before = await owner.selectFrom("account_management_operations").select(sql<number>`count(*)::integer`.as("count")).executeTakeFirstOrThrow();
    expect(before.count).toBeGreaterThan(0);
  });

  it("preserves real member command receipts and supports profile correction after phone reuse", async () => {
    const phone = `197${String(++sequence).padStart(8, "0")}`;
    const input = { fullName: "误建记录", nickname: "误建", phone, wechat: "test" };
    const created = await command("CREATE_MEMBER", input);
    const memberId = created.memberId as string;
    const preview = await deletion(memberId);
    expect((await manage(request("DELETE_MEMBER", { targetId: memberId, expectedVersion: preview.version }))).statusCode).toBe(200);
    const recreated = await command("CREATE_MEMBER", input);
    expect(recreated.memberId).not.toBe(memberId);
    const profile = { ...input, identityCardNumber: null };
    await command("CORRECT_MEMBER_PROFILE", { memberId: recreated.memberId, expectedPriorProfile: profile, correctedProfile: { ...profile, nickname: "正确会员" }, evidenceNote: "核对真实会员" });
    const product = await owner.selectFrom("membership_products").select(["id", "list_price_minor"]).executeTakeFirstOrThrow();
    await command("CREATE_MEMBERSHIP_ORDER", { memberId: recreated.memberId, membershipProductId: product.id, agreedPriceMinor: product.list_price_minor });
    const linked = await deletion(recreated.memberId as string);
    expect(linked.canDelete).toBe(true);
    expect((await manage(request("DELETE_MEMBER", { targetId: recreated.memberId as string, expectedVersion: linked.version }))).statusCode).toBe(200);
  });

  it("voids unused purchased memberships and reverses only confirmed erroneous payments atomically", async () => {
    const { member, purchase } = await activeMembership();
    const original = await owner.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", purchase.id).execute();
    const preview = await deletion(member.id);
    expect(preview).toMatchObject({ canDelete: true, membershipOrderCount: 1, reversalAmountMinor: 1000 });
    const body = request("DELETE_MEMBER", { targetId: member.id, expectedVersion: preview.version });
    expect((await manage(body)).statusCode).toBe(400);
    expect((await manage({ ...body, confirmErroneousPayments: true }, staffCookie)).statusCode).toBe(403);
    const response = await manage({ ...body, requestId: `delete-paid-${++sequence}`, confirmErroneousPayments: true });
    expect(response.statusCode, response.body).toBe(200);
    const operationId = response.json().operationId as string;
    const payments = await owner.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", purchase.id).execute();
    expect(payments.find((p) => p.fact_id === original[0]!.fact_id)).toEqual(original[0]);
    expect(payments.reduce((sum, p) => sum + p.net_effect_minor, 0)).toBe(0);
    expect(payments.find((p) => p.fact_type === "REVERSAL")).toMatchObject({ deletion_operation_id: operationId, command_id: null, reverses_fact_id: original[0]!.fact_id });
    expect((await owner.selectFrom("membership_orders").select("status").where("id", "=", purchase.id).executeTakeFirstOrThrow()).status).toBe("VOIDED");
    expect((await owner.selectFrom("member_contracts").select("status").where("id", "=", purchase.contract_id!).executeTakeFirstOrThrow()).status).toBe("VOIDED");
    const ledger = await owner.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", purchase.entitlement_lot_id!).execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ entry_type: "VOID", quantity_delta: -purchase.entitlement_units, deletion_operation_id: operationId });
    await expect(runtime.insertInto("membership_payment_facts").values({ ...original[0]!, fact_id: newId("fact"), transaction_reference: `AFTER-DELETE-${++sequence}` }).execute()).rejects.toThrow(/deleted or is unavailable/);
  });

  it("rejects a deletion preview after another payment and rolls every deletion write back if audit fails", async () => {
    const { member, purchase } = await activeMembership();
    const old = await deletion(member.id);
    await command("RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId: purchase.id, amountMinor: 2000, transactionReference: `DELETE-NEW-PAY-${++sequence}` });
    expect((await manage(request("DELETE_MEMBER", { targetId: member.id, expectedVersion: old.version, confirmErroneousPayments: true }))).statusCode).toBe(409);
    const preview = await deletion(member.id);
    expect(preview.reversalAmountMinor).toBe(3000);
    await sql`CREATE FUNCTION test_reject_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$`.execute(owner);
    await sql`CREATE TRIGGER test_reject_delete_audit BEFORE INSERT ON audit_entries FOR EACH ROW WHEN (NEW.action='DELETE_MEMBER' AND NEW.decision='ALLOWED') EXECUTE FUNCTION test_reject_delete_audit()`.execute(owner);
    try {
      expect((await manage(request("DELETE_MEMBER", { targetId: member.id, expectedVersion: preview.version, confirmErroneousPayments: true }))).statusCode).toBe(500);
      expect((await deletion(member.id)).version).toBe(preview.version);
      expect(await owner.selectFrom("membership_payment_facts").select("fact_id").where("membership_order_id", "=", purchase.id).where("fact_type", "=", "REVERSAL").execute()).toHaveLength(0);
      expect(await owner.selectFrom("entitlement_ledger").select("fact_id").where("lot_id", "=", purchase.entitlement_lot_id!).execute()).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER test_reject_delete_audit ON audit_entries`.execute(owner);
      await sql`DROP FUNCTION test_reject_delete_audit()`.execute(owner);
    }
  });

  it("requires reservation cancellation before deleting an unused purchased member and preserves the cancelled order", async () => {
    const { member, purchase } = await activeMembership();
    const created = await memberReservation(purchase.contract_id!);
    const held = await deletion(member.id);
    expect(held.canDelete).toBe(false);
    expect(held.blockedReason).toContain("先取消");
    await command("CANCEL_ORDER", { orderId: created.orderId });
    const released = await deletion(member.id);
    expect(released.canDelete).toBe(true);
    const body = request("DELETE_MEMBER", { targetId: member.id, expectedVersion: released.version, confirmErroneousPayments: true });
    const removed = await manage(body);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await manage(body)).json()).toEqual(removed.json());
    expect((await owner.selectFrom("orders").select("status").where("id", "=", created.orderId as string).executeTakeFirstOrThrow()).status).toBe("CANCELLED");
    expect(await owner.selectFrom("coverage_items").select("status").where("order_id", "=", created.orderId as string).execute()).toEqual([{ status: "RELEASED" }, { status: "RELEASED" }]);
  });

  it("refuses deletion after check-in has consumed membership entitlement", async () => {
    const { member, purchase } = await activeMembership();
    const created = await memberReservation(purchase.contract_id!);
    await command("CHECK_IN", { orderId: created.orderId });
    const preview = await deletion(member.id);
    expect(preview.canDelete).toBe(false);
    expect(preview.blockedReason).toContain("核销");
    expect((await manage(request("DELETE_MEMBER", { targetId: member.id, expectedVersion: preview.version, confirmErroneousPayments: true }))).statusCode).toBe(409);
  });

  it("leaves no usable old-password session when login races a password reset", async () => {
    const staff = await createStaff();
    const [loggingIn, resetting] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: staff.username, password: "test-password-2026" } }),
      manage(request("RESET_PASSWORD", { targetId: staff.id, expectedVersion: "1", newPassword: "race-new-password-2026" }))
    ]);
    expect(resetting.statusCode, resetting.body).toBe(200);
    expect([200, 401]).toContain(loggingIn.statusCode);
    if (loggingIn.statusCode === 200) {
      const cookie = loggingIn.cookies.find((item) => item.name === "qintopia_session")!.value;
      expect((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { qintopia_session: cookie } })).statusCode).toBe(401);
    }
    await login(staff.username, "race-new-password-2026");
  });

  it("fails readiness when the member reference guard is disabled", async () => {
    expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
    await sql`ALTER TABLE orders DISABLE TRIGGER orders_active_member_guard`.execute(owner);
    try { expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(false); }
    finally { await sql`ALTER TABLE orders ENABLE TRIGGER orders_active_member_guard`.execute(owner); }
    expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
  });
});
