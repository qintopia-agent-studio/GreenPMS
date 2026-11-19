import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDatabase, databaseReady, propertyLocalToday, shiftMemberDate, withPropertyClockForTesting, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { runExpiryReminders } from "../../apps/api/src/wechat-member-reminders.ts";
import type { WechatMemberConfig, WechatService } from "../../apps/api/src/wechat-official-account.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const config: WechatMemberConfig = { appId: "test-app", secret: "test-secret", propertyId: demo.propertyId, origin: "https://member.example.test",
  reminder: { template: "expiry-test", fields: { thing1: "product", date2: "expiry", number3: "days" } } };
const send = vi.fn<WechatService["send"]>(async () => 0);
const service: WechatService = { recognize: async code => "wx-" + code, following: async () => true, token: async () => "test-token", send,
  subscriptionSignature: async () => ({ appId: config.appId, timestamp: 1, nonceStr: "test", signature: "test" }) };
const root = "/api/wechat/member", headers = { origin: config.origin };
const staffUrl = (id: string) => `/api/v1/wechat-member-bindings/${demo.propertyId}/${id}`;
let owner: Kysely<Database>, runtime: Kysely<Database>, app: FastifyInstance;
let staff: Record<string, string>;
let expiry: string;
async function authorize(user: string) {
  const login = await app.inject({ url: root + "/login" });
  const state = new URL(login.headers.location!).searchParams.get("state")!;
  expect(state).toMatch(/^[a-zA-Z0-9]{1,128}$/);
  const callback = await app.inject({ url: root + "/callback?" + new URLSearchParams({ state, code: user }), cookies: { [login.cookies[0]!.name]: state } });
  expect(callback.headers.location).toBe("/member-center");
  const cookie = callback.cookies.find(c => c.name === "__Host-greenpms-member")!;
  return { [cookie.name]: cookie.value };
}
async function pair(cookies: Record<string,string>) {
  const r = await app.inject({ method: "POST", url: root + "/pair", cookies, headers, payload: {} });
  expect(r.statusCode,r.body).toBe(200);
  return r.json().code as string;
}
beforeEach(async () => {
  send.mockReset().mockResolvedValue(0);
  owner = await resetTestDatabase();
  runtime = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
  app = await buildServer(runtime, { wechatMember: { config, service } });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "demo-pass-2026" } });
  staff = { qintopia_session: login.cookies.find(c => c.name === "qintopia_session")!.value };
  expiry = (await owner.selectFrom("entitlement_lots").select("expires_on").where("id", "=", demo.roomLotId).executeTakeFirstOrThrow()).expires_on;
}, 90_000);
afterEach(async () => { await app?.close(); await owner?.destroy(); });

it("binds a verified WeChat session to one member, projects only entitlements and enforces tenant and staff boundaries", async () => {
  expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
  expect((await app.inject({ url: root, cookies: staff })).json()).toEqual({ status: "SIGNED_OUT" });
  expect((await app.inject({ url: root + "/callback?code=unused&state=wrong" })).headers.location).toContain("auth-failed");
  const alice = await authorize("alice"), bob = await authorize("bob");
  expect((await app.inject({ url: root, cookies: alice })).json()).toEqual({ status: "UNBOUND" });
  const code = await pair(alice);
  const payload = { action: "BIND", method: "REGISTERED_PHONE", code };
  const token = await app.inject({ method: "POST", url: staffUrl(demo.memberId), headers: { authorization: "Bearer " + demo.administratorWriteToken }, payload });
  expect(token.statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: staffUrl(demo.memberId).replace(demo.propertyId, "other"), cookies: staff, payload })).statusCode).toBe(403);
  const bound = await app.inject({ method: "POST", url: staffUrl(demo.memberId), cookies: staff, payload });
  expect(bound.statusCode,bound.body).toBe(200);
  expect((await app.inject({ method:"POST",url:staffUrl(demo.memberId),cookies:staff,payload })).statusCode).toBe(409);
  const response = await app.inject({ url: root, cookies: alice });
  expect(response.statusCode,response.body).toBe(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  const data = response.json();
  expect(data.status).toBe("BOUND");
  expect(data.view.cards[0]).toMatchObject({ unit: "ROOM_NIGHT", expiresOn: expiry });
  expect(Object.keys(data.view.cards[0]).sort()).toEqual(["available","expiresOn","held","product","reminderDates","rooms","startsOn","status","unit"]);
  expect(response.body).not.toMatch(/price|payment|currency|phone|amount|identity|room_id|open_id|member_id|transaction/i);
  expect((await app.inject({ url: root + "?memberId=" + demo.memberId, cookies: bob })).json().status).not.toBe("BOUND");
  expect((await app.inject({ url: root, cookies: bob })).json().status).toBe("UNBOUND");
  expect((await app.inject({ method: "POST", url: root + "/subscription", cookies: alice, headers: { origin: "https://other.example" }, payload: { enabled: true, template: "expiry-test" } })).statusCode).toBe(403);
});
async function bind(user: string, member: string = demo.memberId) {
  const cookies = await authorize(user);
  const code = await pair(cookies);
  const result = await app.inject({ method: "POST", url: staffUrl(member), cookies: staff, payload: { action: "BIND", method: "IN_PERSON", code } });
  expect(result.statusCode, result.body).toBe(200);
  return cookies;
}

function run(days: number, account = service) {
  const instant = new Date(shiftMemberDate(expiry, -days) + "T00:01:00+08:00");
  return withPropertyClockForTesting(instant, () => runExpiryReminders(runtime, config, account));
}

it("sends once at D-60 and D-30 in the property time zone, including overlapping runs, and retires old sessions", async () => {
  const alice = await bind("alice"), bob = await authorize("bob");
  await run(60); expect(send).not.toHaveBeenCalled();
  const opted = await app.inject({ method: "POST", url: root + "/subscription", cookies: alice, headers, payload: { enabled: true, template: "expiry-test" } });
  expect(opted.statusCode,opted.body).toBe(200);
  await run(61); await Promise.all([run(60),run(60)]); await run(59); await run(31);
  expect(send.mock.calls.map(args=>args[4])).toEqual([60]);
  await run(30); await run(30); await run(29); await run(0);
  expect(send.mock.calls.map(args=>args[4])).toEqual([60,30]);
  const notices = await owner.selectFrom("wechat_member_expiry_notices").select(["lead_days","state"]).orderBy("lead_days","desc").execute();
  expect(notices).toEqual([{lead_days:60,state:"ACCEPTED"},{lead_days:30,state:"ACCEPTED"}]);
  const clear = await app.inject({ method:"POST",url:root+"/unlink",cookies:alice,headers,payload:{} });
  expect(clear.statusCode,clear.body).toBe(200);
  expect((await app.inject({url:root,cookies:alice})).json().status).toBe("SIGNED_OUT");
  const expired = await pair(bob);
  await owner.updateTable("wechat_member_sessions").set({pairing_expires_at:sql`now()-interval '1 minute'`}).where("open_id","=","wx-bob").execute();
  expect((await app.inject({method:"POST",url:staffUrl(demo.memberId),cookies:staff,payload:{action:"BIND",method:"IN_PERSON",code:expired}})).statusCode).toBe(409);
});

it("withholds an uncertain delivery on replay and clears a withdrawn WeChat authorization", async () => {
  const alice = await bind("alice");
  await app.inject({ method: "POST", url: root + "/subscription", cookies: alice, headers, payload: { enabled: true, template: "expiry-test" } });
  const unavailable = { ...service, following: async () => { throw new Error("temporarily unavailable"); } };
  await expect(run(60, unavailable)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  send.mockRejectedValueOnce(new Error("provider reply lost"));
  await run(60); await run(60);
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValueOnce(43101);
  await run(30); await run(30);
  expect(send).toHaveBeenCalledTimes(2);
  const rows = await owner.selectFrom("wechat_member_expiry_notices").select(["lead_days", "state", "error_code"]).orderBy("lead_days","desc").execute();
  expect(rows).toEqual([{ lead_days: 60, state: "UNKNOWN", error_code: null }, { lead_days: 30, state: "RETRY", error_code: 43101 }]);
  expect((await app.inject({url: root, cookies: alice})).json().subscribed).toBe(false);
});

it("retires old sessions when an empty profile is deleted, allowing verified binding to the correct member", async () => {
  const propertyId = demo.propertyId, id = "member-wechat-empty";
  await owner.insertInto("members").values({id, full_name: "测试会员", nickname: "测试", phone: "19600001000", wechat: "test-contact", identity_card_number: null}).execute();
  await owner.insertInto("member_property_links").values({member_id: id, property_id: propertyId}).execute();
  const original = await bind("alice", id);
  expect((await app.inject({url: root, cookies: original})).json().view.cards).toEqual([]);
  const preview = await app.inject({url: "/api/v1/members/" + id + "/deletion-preview?propertyId=" + propertyId, cookies: staff});
  const deleted = await app.inject({method: "POST", url: "/api/v1/account-management", cookies: staff, payload: {action: "DELETE_MEMBER", propertyId,
    targetId: id, expectedVersion: preview.json().version, confirmation: true, requestId: "wechat-correct-member", reason: "测试误建档案"}});
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect((await app.inject({url: root, cookies: original})).json().status).toBe("SIGNED_OUT");
  const correct = await bind("alice");
  expect((await app.inject({url: root, cookies: correct})).json().view.cards).toHaveLength(1);
});

it("uses the corrected contract end date for both future reminders and drops the old schedule", async () => {
  const member = await bind("corrected");
  const opted = await app.inject({ method: "POST", url: root + "/subscription", cookies: member, headers, payload: { enabled: true, template: "expiry-test" } });
  expect(opted.statusCode).toBe(200);
  const actualMembershipDate = shiftMemberDate(await propertyLocalToday(owner, demo.propertyId), -30);
  const commandType = "CORRECT_MEMBERSHIP_EFFECTIVE_DATE", propertyId = demo.propertyId;
  const meta = (key: string) => ({ "idempotency-key": key, "x-correlation-id": key });
  const prepared = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies: staff, headers: meta("wechat-correct-date-preview"),
    payload: { commandType, input: { propertyId, membershipOrderId: demo.membershipOrderId, actualMembershipDate, evidenceNote: "测试核对实际开始日期" } } });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const preview = prepared.json().preview;
  const confirmed = await app.inject({ method: "POST", url: "/api/v1/command-previews/" + preview.previewId + "/confirm", cookies: staff, headers: meta("wechat-correct-date-confirm"),
    payload: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "DATA_ENTRY_CORRECTION", note: "已核对模拟合同日期" } } });
  expect(confirmed.json(), confirmed.body).toMatchObject({ businessCommitted: true });
  const corrected = (await app.inject({ url: root, cookies: member })).json().view.cards[0];
  expect(corrected.expiresOn).not.toBe(expiry);
  expect(corrected.reminderDates).toEqual([shiftMemberDate(corrected.expiresOn, -60), shiftMemberDate(corrected.expiresOn, -30)]);
  await run(60); await run(30);
  expect(send).not.toHaveBeenCalled();
  for (const date of corrected.reminderDates) {
    await withPropertyClockForTesting(new Date(date + "T12:00:00+08:00"), () => runExpiryReminders(runtime, config, service));
  }
  expect(send.mock.calls.map(call => [call[3],call[4]])).toEqual([[corrected.expiresOn,60],[corrected.expiresOn,30]]);
});
