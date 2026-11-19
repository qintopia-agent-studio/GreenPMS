import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemberNoticeRules } from "@qintopia/contracts";
import { deliverBookingResults } from "../../apps/api/src/wechat-booking-delivery.ts";
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
const service: WechatService = { sendFields: vi.fn(async () => 0), recognize: async code => "wx-" + code, following: async () => true, token: async () => "test-token", send,
  subscriptionSignature: async () => ({ appId: config.appId, timestamp: 1, nonceStr: "test", signature: "test" }) };
const sendCode = vi.fn(async (_phone: string, _code: string) => {});
const root = "/api/wechat/member", headers = { origin: config.origin };
const phone = "13800000000", cookieName = "__Host-greenpms-member";
type Cookies = Record<string, string>;
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
function requestCode(cookies: Cookies, number = phone, origin = config.origin) {
  return app.inject({ method: "POST", url: root + "/sms/request", cookies, headers: { origin }, payload: { phone: number } });
}
function verify(cookies: Cookies, code: string, number = phone) {
  return app.inject({ method: "POST", url: root + "/sms/verify", cookies, headers, payload: { phone: number, code } });
}
async function issue(cookies: Cookies, number = phone) {
  const previous = sendCode.mock.calls.length;
  const response = await requestCode(cookies, number);
  expect(response.statusCode, response.body).toBe(202);
  expect(response.json()).toEqual({ retryAfterSeconds: 60 });
  expect(sendCode).toHaveBeenCalledTimes(previous + 1);
  const [destination, code] = sendCode.mock.calls.at(-1)!;
  expect(destination).toMatch(/^\+861\d{10}$/);
  expect(code).toMatch(/^\d{6}$/);
  return code;
}
async function bind(user: string, member: string = demo.memberId) {
  const cookies = await authorize(user);
  const { phone: number } = await owner.selectFrom("members").select("phone").where("id", "=", member).executeTakeFirstOrThrow();
  const result = await verify(cookies, await issue(cookies, number), number);
  expect(result.statusCode, result.body).toBe(200);
  return { [cookieName]: result.cookies.find(c => c.name === cookieName)!.value };
}
async function elapse(seconds: number) {
  await owner.updateTable("wechat_member_sms_challenges").set({ issued_at: sql`issued_at - ${seconds} * interval '1 second'` }).execute();
}
async function deleteTestMember(id: string) {
  const propertyId = demo.propertyId;
  const preview = await app.inject({url: "/api/v1/members/" + id + "/deletion-preview?propertyId=" + propertyId, cookies: staff});
  const deleted = await app.inject({method: "POST", url: "/api/v1/account-management", cookies: staff, payload: {action: "DELETE_MEMBER", propertyId,
    targetId: id, expectedVersion: preview.json().version, confirmation: true, requestId: "wechat-delete-" + id, reason: "测试误建档案"}});
  expect(deleted.statusCode, deleted.body).toBe(200);
}
async function correct(commandType: string, input: object) {
  const propertyId = demo.propertyId;
  const meta = (key: string) => ({ "idempotency-key": key, "x-correlation-id": key });
  const prepared = await app.inject({ method: "POST", url: "/api/v1/command-previews", cookies: staff, headers: meta(commandType + "-preview"),
    payload: { commandType, input: { ...input, propertyId } } });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const preview = prepared.json().preview;
  const confirmed = await app.inject({ method: "POST", url: "/api/v1/command-previews/" + preview.previewId + "/confirm", cookies: staff, headers: meta(commandType + "-confirm"),
    payload: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "DATA_ENTRY_CORRECTION", note: "已核对测试档案" } } });
  expect(confirmed.json(), confirmed.body).toMatchObject({ businessCommitted: true });
  return confirmed.json().result;
}
beforeEach(async () => {
  send.mockReset().mockResolvedValue(0);
  vi.mocked(service.sendFields).mockReset().mockResolvedValue(0);
  sendCode.mockReset().mockResolvedValue(undefined);
  owner = await resetTestDatabase();
  runtime = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
  app = await buildServer(runtime, { wechatMember: { config, service, sms: { sendCode } } });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "demo-pass-2026" } });
  staff = { qintopia_session: login.cookies.find(c => c.name === "qintopia_session")!.value };
  expiry = (await owner.selectFrom("entitlement_lots").select("expires_on").where("id", "=", demo.roomLotId).executeTakeFirstOrThrow()).expires_on;
}, 90_000);
afterEach(async () => { await app?.close(); await owner?.destroy(); });

it("binds a verified WeChat session to one member, projects only entitlements and enforces tenant and staff boundaries", async () => {
  expect(await databaseReady(runtime, { staffProfileManifestName: "demo" })).toBe(true);
  expect((await app.inject({ url: root, cookies: staff })).json()).toEqual({ status: "SIGNED_OUT" });
  expect((await app.inject({ url: root + "/callback?code=unused&state=wrong" })).headers.location).toContain("auth-failed");
  const unbound = await authorize("alice"), bob = await authorize("bob");
  expect((await app.inject({ url: root, cookies: unbound })).json()).toEqual({ status: "UNBOUND", smsAvailable: true });
  expect((await requestCode(staff)).statusCode).toBe(403);
  expect((await requestCode(unbound, phone, "https://other.example")).statusCode).toBe(403);
  const code = await issue(unbound, "+86 138-0000-0000");
  expect((await verify(bob, code)).statusCode).toBe(400);
  expect((await verify(unbound, code, "13900000000")).statusCode).toBe(400);
  const bound = await verify(unbound, code);
  expect(bound.statusCode, bound.body).toBe(200);
  const alice = { [cookieName]: bound.cookies.find(c => c.name === cookieName)!.value };
  expect(alice).not.toEqual(unbound);
  expect((await app.inject({ url: root, cookies: unbound })).json().status).toBe("SIGNED_OUT");
  const binding = await owner.selectFrom("wechat_member_bindings").select(["id","verified_by","verification"]).executeTakeFirstOrThrow();
  expect(binding).toMatchObject({ verified_by: null, verification: "SMS_OTP" });
  const payload = { action: "REVOKE", bindingId: binding.id };
  expect((await app.inject({ method: "POST", url: staffUrl(demo.memberId), headers: { authorization: "Bearer " + demo.administratorWriteToken }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: staffUrl(demo.memberId).replace(demo.propertyId, "other"), cookies: staff, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: staffUrl(demo.memberId), cookies: staff, payload: { action: "BIND", method: "IN_PERSON", code: "1234567890" } })).statusCode).toBe(400);
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
  expect((await app.inject({ url: root, cookies: await authorize("alice") })).json().status).toBe("BOUND");
  expect(sendCode).toHaveBeenCalledTimes(1);
  expect((await app.inject({ method: "POST", url: staffUrl(demo.memberId), cookies: staff, payload })).statusCode).toBe(200);
  expect((await app.inject({ url: root, cookies: alice })).json().status).toBe("SIGNED_OUT");
});
const ops = (area: string) => "/api/v1/properties/" + demo.propertyId + "/member-" + area;
async function publishRules(rules?: Partial<MemberNoticeRules>, version = 0) {
  const current = await app.inject({ url: ops("notifications"), cookies: staff });
  expect(current.statusCode, current.body).toBe(200);
  return app.inject({
    method: "POST",
    url: ops("notifications"),
    cookies: staff,
    payload: { version, rules: { ...current.json().rules, ...rules } }
  });
}
async function stayPayload(start: number, nights: number) {
  const arrival = shiftMemberDate(await propertyLocalToday(runtime, demo.propertyId), start);
  return {
    arrival,
    departure: shiftMemberDate(arrival, nights),
    roomType: "shared_bath_single",
    kind: "ROOM",
    requestKey: crypto.randomUUID()
  };
}
function submit(cookies: Cookies, payload: Awaited<ReturnType<typeof stayPayload>>) {
  return app.inject({ method: "POST", url: root + "/bookings", cookies, headers, payload });
}
async function decide(id: string, unit?: string) {
  return app.inject({
    method: "POST",
    url: ops("bookings/" + id + "/decision"),
    cookies: staff,
    payload: unit ? { action: "CONFIRM", unitId: unit } : { action: "DECLINE" }
  });
}
async function firstUnit(id: string) {
  const r = await app.inject({ url: ops("bookings/" + id + "/units"), cookies: staff });
  expect(r.statusCode, r.body).toBe(200);
  return r.json()[0].id as string;
}
const resultTemplate = {
  template: "booking-test",
  fields: { phrase1: "status", date2: "arrival", thing3: "room" }
} as const;
it("只在排房时建单占房及预留完整权益，重复提交幂等，权益不足仅提示联系客服", async () => {
  const alice = await bind("booking-alice"),
    foreign = await authorize("unbound");
  const form = await stayPayload(5, 2);
  expect((await submit(foreign, form)).statusCode).toBe(403);
  const short = await submit(alice, await stayPayload(2, 3));
  expect(short.statusCode, short.body).toBe(409);
  expect(short.json().message).toContain("权益不足，请联系服务号客服");
  const available = await app.inject({ url: root + "/bookings", cookies: alice });
  expect(available.json().rooms).toContainEqual(expect.objectContaining({ code: form.roomType, kind: "ROOM" }));
  const baselineOrders = await owner.selectFrom("orders").select("id").execute();
  const retry={...form,requestKey:crypto.randomUUID()};
  const requests = await Promise.all([
    submit(alice, form),
    submit(alice, retry)
  ]);
  expect(requests[0]?.statusCode, requests[0]?.body).toBe(200);
  const id = requests[0]!.json().id;
  expect(requests[1]!.json()).toMatchObject({ id, status: "PENDING" });
  const competing = await submit(alice, await stayPayload(12, 2));
  expect(competing.json().status).toBe("PENDING");
  const otherId = competing.json().id;
  expect(await owner.selectFrom("orders").select("id").execute()).toEqual(baselineOrders);
  expect((await app.inject({ url: root, cookies: alice })).json().view.cards[0]).toMatchObject({
    available: 2,
    held: 0
  });
  const [unit, otherUnit] = await Promise.all([firstUnit(id), firstUnit(otherId)]);
  const saved = await publishRules({ booking: resultTemplate });
  expect(saved.statusCode, saved.body).toBe(200);
  const opted = await app.inject({
    method: "POST",
    url: root + "/subscription",
    cookies: alice,
    headers,
    payload: { enabled: true, template: "booking-test", kind: "booking" }
  });
  expect(opted.statusCode, opted.body).toBe(200);
  const confirm = await decide(id, unit);
  expect(confirm.statusCode, confirm.body).toBe(200);
  expect(confirm.json()).toMatchObject({ status: "CONFIRMED", orderId: expect.any(String) });
  expect((await submit(alice,retry)).json()).toMatchObject({id,status:"CONFIRMED"});
  expect((await submit(alice,form)).json()).toMatchObject({id,status:"CONFIRMED"});
  expect((await decide(id, unit)).json()).toEqual(confirm.json());
  expect((await decide(id)).statusCode).toBe(409);
  expect((await decide(id, "other-unit")).statusCode).toBe(409);
  const failed = await decide(otherId, otherUnit);
  expect(failed.statusCode, failed.body).toBe(409);
  expect(failed.json().message).toContain("权益不足");
  expect(await owner.selectFrom("orders").select("id").execute()).toHaveLength(baselineOrders.length + 1);
  expect((await app.inject({ url: root, cookies: alice })).json().view.cards[0]).toMatchObject({
    available: 0,
    held: 2
  });
  const mine = await app.inject({ url: root + "/bookings?id=" + id, cookies: alice });
  expect(mine.json().bookings[0]).toMatchObject({ id, status: "CONFIRMED" });
  expect(mine.body).not.toMatch(/price|payment|currency|amount|open_id|member_id|phone/i);
  expect(service.sendFields).toHaveBeenCalledTimes(1);
  expect(service.sendFields).toHaveBeenCalledWith(
    "test-token",
    "wx-booking-alice",
    "booking-test",
    expect.objectContaining({ phrase1: { value: "已确认" } }),
    config.origin + "/member-center#booking=" + id
  );
  const interactions = await app.inject({ url: ops("interactions") + "?memberId=" + demo.memberId, cookies: staff });
  expect(interactions.json().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "预订已确认",
        state: "ACCEPTED",
        template: "booking-test",
        content: expect.objectContaining({ phrase1: "已确认" })
      })
    ])
  );
  expect(interactions.body).not.toContain(sendCode.mock.calls[0]![1]);
  expect(
    await owner
      .selectFrom("wechat_member_interactions")
      .select("event_key")
      .where("booking_id", "=", otherId)
      .where("kind", "!=", "提交住宿预订")
      .execute()
  ).toHaveLength(0);
  const attention = (await app.inject({ url: root + "/bookings?id=" + otherId, cookies: alice })).json().bookings[0]
    .attention;
  expect(attention).toContain("权益不足，请联系服务号客服");
});
it("管理员发布可预览的提醒规则，旧版不可覆盖，运营能看到跳过和受理结果", async () => {
  const alice = await bind("rules-alice");
  const settings = await publishRules({ leadDays: [15], booking: resultTemplate });
  expect(settings.statusCode, settings.body).toBe(200);
  expect(settings.json().version).toBe(1);
  expect((await publishRules({ leadDays: [12] })).statusCode).toBe(409);
  expect((await publishRules({ booking: { template: "foreign", fields: { amount1: "status" } } }, 1)).statusCode).toBe(
    400
  );
  const operator = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "operator", password: "demo-pass-2026" }
  });
  const user = { qintopia_session: operator.cookies.find((c) => c.name === "qintopia_session")!.value };
  expect((await app.inject({ url: ops("notifications"), cookies: user })).statusCode).toBe(403);
  expect((await app.inject({ url: ops("interactions"), cookies: user })).statusCode).toBe(200);
  expect(
    (await app.inject({ url: ops("interactions").replace(demo.propertyId, "other"), cookies: user })).statusCode
  ).toBe(403);
  expect((await app.inject({ url: root, cookies: alice })).json().leadDays).toEqual([15]);
  await run(15);
  expect(
    (await app.inject({ url: ops("interactions") + "?state=SKIPPED", cookies: user })).json().items[0].detail
  ).toContain("授权");
  await app.inject({
    method: "POST",
    url: root + "/subscription",
    cookies: alice,
    headers,
    payload: { enabled: true, template: "expiry-test" }
  });
  await run(60);
  await run(15);
  await run(15);
  expect(send.mock.calls.map((args) => args[4])).toEqual([15]);
  const req = await submit(alice, await stayPayload(1, 1));
  expect((await decide(req.json().id)).json().status).toBe("DECLINED");
  expect(service.sendFields).not.toHaveBeenCalled();
  const logs = (await app.inject({ url: ops("interactions"), cookies: staff })).json().items;
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "预订未能安排", state: "SKIPPED" }),
      expect.objectContaining({
        kind: "权益到期",
        state: "ACCEPTED",
        content: expect.objectContaining({ number3: "15" })
      })
    ])
  );
});
it("同时确认只生成一张订单，已提交给微信但回执未知时不重发", async () => {
  const alice = await bind("racer");
  await publishRules({ booking: resultTemplate });
  await app.inject({
    method: "POST",
    url: root + "/subscription",
    cookies: alice,
    headers,
    payload: { enabled: true, template: "booking-test", kind: "booking" }
  });
  vi.mocked(service.sendFields).mockRejectedValueOnce(new Error("lost response"));
  const b = await submit(alice, await stayPayload(3, 1));
  const id = b.json().id,
    unit = await firstUnit(id);
  const results = await Promise.all([decide(id, unit), decide(id, unit)]);
  expect(
    results.some((r) => r.statusCode === 200),
    results.map((r) => r.body).join(" / ")
  ).toBe(true);
  expect(
    results.every((r) => [200, 409].includes(r.statusCode)),
    results.map((r) => r.body).join(" / ")
  ).toBe(true);
  await deliverBookingResults(runtime, config, service);
  const events = await owner
    .selectFrom("wechat_member_interactions")
    .select(["state", "content"])
    .where("event_key", "=", "booking:" + id)
    .execute();
  expect(events).toHaveLength(1);
  expect(events[0]!.state).toBe("UNKNOWN");
  expect(service.sendFields).toHaveBeenCalledTimes(1);
  await publishRules({ booking: null }, 1);
  expect(
    (
      await owner
        .selectFrom("wechat_member_interactions")
        .select("content")
        .where("event_key", "=", "booking:" + id)
        .executeTakeFirstOrThrow()
    ).content
  ).toEqual(events[0]!.content);
  expect((await app.inject({ url: root, cookies: alice })).json().view.cards[0]).toMatchObject({
    available: 1,
    held: 1
  });
});
it("床夜会员按床位排房，另一个已绑定会员打开同一链接只能看到自己的记录", async () => {
  const roomMember = await bind("room-reader"),
    bedMember = "self-service-bed";
  await owner
    .insertInto("members")
    .values({
      id: bedMember,
      full_name: "床夜测试会员",
      nickname: "测试",
      phone: "19600001016",
      wechat: "未登记个人微信号",
      identity_card_number: null
    })
    .execute();
  await owner
    .insertInto("member_property_links")
    .values({ property_id: demo.propertyId, member_id: bedMember })
    .execute();
  const { membershipOrderId } = await correct("CREATE_MEMBERSHIP_ORDER", {
    memberId: bedMember,
    membershipProductId: "membership_product_shared_bath_quad_v1",
    agreedPriceMinor: 93600
  });
  await correct("RECORD_MEMBERSHIP_PAYMENT", {
    membershipOrderId,
    amountMinor: 1,
    transactionReference: "WX-bed-self-service"
  });
  await correct("ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId });
  const bed = await bind("bed-reader", bedMember);
  const options = (await app.inject({ url: root + "/bookings", cookies: bed })).json().rooms;
  expect(options).toHaveLength(1);
  expect(options[0].kind).toBe("BED");
  const form = { ...(await stayPayload(4, 1)), roomType: options[0].code, kind: "BED" };
  expect((await submit(bed, { ...form, kind: "ROOM" })).statusCode).toBe(409);
  const applied = await submit(bed, form);
  expect(applied.statusCode, applied.body).toBe(200);
  const id = applied.json().id;
  const foreign = await app.inject({ url: root + "/bookings?id=" + id, cookies: roomMember });
  expect(foreign.json().bookings).toEqual([]);
  const result = await decide(id, await firstUnit(id));
  expect(result.statusCode, result.body).toBe(200);
  const coverage = await owner
    .selectFrom("coverage_items")
    .select(["unit_kind", "status"])
    .where("order_id", "=", result.json().orderId)
    .execute();
  expect(coverage).toEqual([{ unit_kind: "BED_NIGHT", status: "HELD" }]);
});

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
  await elapse(61);
  const expired = await issue(bob);
  await elapse(301);
  expect((await verify(bob, expired)).statusCode).toBe(400);
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
  await deleteTestMember(id);
  expect((await app.inject({url: root, cookies: original})).json().status).toBe("SIGNED_OUT");
  await elapse(61);
  const correct = await bind("alice");
  expect((await app.inject({url: root, cookies: correct})).json().view.cards).toHaveLength(1);
});

it("uses the corrected contract end date for both future reminders and drops the old schedule", async () => {
  const member = await bind("corrected");
  const opted = await app.inject({ method: "POST", url: root + "/subscription", cookies: member, headers, payload: { enabled: true, template: "expiry-test" } });
  expect(opted.statusCode).toBe(200);
  const actualMembershipDate = shiftMemberDate(await propertyLocalToday(owner, demo.propertyId), -30);
  await correct("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", { membershipOrderId: demo.membershipOrderId, actualMembershipDate, evidenceNote: "核对测试合同日期" });
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

it("commits failed attempts, throttles across OAuth sessions and consumes the latest challenge once", async () => {
  const first = await authorize("same"), next = await authorize("same"), other = await authorize("another");
  const original = await issue(first);
  expect((await requestCode(next, "13900001234")).json()).toEqual({ retryAfterSeconds: 60 });
  expect((await requestCode(other)).json()).toEqual({ retryAfterSeconds: 60 });
  expect(sendCode).toHaveBeenCalledTimes(1);
  const wrong = original === "000000" ? "000001" : "000000";
  for (let count = 0; count < 5; count++) expect((await verify(first, wrong)).statusCode).toBe(400);
  expect((await verify(first, original)).statusCode).toBe(400);
  await elapse(61);
  const second = await issue(first);
  await elapse(61);
  const otherCode = await issue(other);
  expect((await verify(first, second)).statusCode).toBe(400);
  await elapse(61);
  const latest = await issue(next);
  expect((await verify(other, otherCode)).statusCode).toBe(400);
  const race = await Promise.all([verify(next, latest), verify(next, latest)]);
  expect(race.map(r => r.statusCode).sort()).toEqual([200,403]);
  expect(await owner.selectFrom("wechat_member_bindings").select("id").execute()).toHaveLength(1);
});

it("keeps unmatched, ambiguous, cross-store and deleted profiles private and rechecks reassigned numbers", async () => {
  const user = await authorize("old-number");
  const old = await issue(user);
  const before = await owner.selectFrom("members").select(["full_name as fullName", "nickname", "identity_card_number as identityCardNumber", "phone", "wechat"])
    .where("id", "=", demo.memberId).executeTakeFirstOrThrow();
  await correct("CORRECT_MEMBER_PROFILE", { memberId: demo.memberId, expectedPriorProfile: before, correctedProfile: { ...before, phone: "13900001111" }, evidenceNote: "测试会员已核实变更手机号" });
  async function profile(id: string, number: string, property: string | null) {
    await owner.insertInto("members").values({ id, phone: number, full_name: id, nickname: id, wechat: id, identity_card_number: null }).execute();
    if (property) await owner.insertInto("member_property_links").values({ member_id: id, property_id: property }).execute();
  }
  await profile("wx-new-holder", phone, demo.propertyId);
  expect((await verify(user, old)).statusCode).toBe(400);
  await profile("wx-duplicate", "+86 (138) 0000-0000", demo.propertyId);
  const property = await owner.insertInto("properties").values({ id: "wx-other", code: "WX-OTHER", name: "测试其他门店", timezone: "Asia/Shanghai", currency: "CNY" }).returning("id").executeTakeFirstOrThrow();
  await profile("wx-elsewhere", "13800001111", property.id);
  await profile("wx-deleted", "13800002222", demo.propertyId);
  await deleteTestMember("wx-deleted");
  await elapse(61);
  for (const [i, number] of [phone, "13800001111", "13800002222", "13800003333"].entries()) {
    const account = await authorize("check-" + i);
    const requested = await requestCode(account, number);
    expect([requested.statusCode, requested.json()]).toEqual([202, { retryAfterSeconds: 60 }]);
    expect((await verify(account, old, number)).statusCode).toBe(400);
  }
  expect(sendCode).toHaveBeenCalledTimes(1);
  expect(await owner.selectFrom("wechat_member_bindings").select("id").execute()).toHaveLength(0);
  // An old profile can have a formatted number. Only this store's one remaining active match may receive a code.
  await deleteTestMember("wx-new-holder");
  await elapse(61);
  const latest = await issue(user, "0086 138-0000-0000");
  expect((await verify(user, latest)).statusCode).toBe(200);
  expect(await owner.selectFrom("wechat_member_bindings").select("member_id").executeTakeFirst()).toEqual({ member_id: "wx-duplicate" });
});

it("preserves an existing binding when another WeChat proves possession and allows rebind after unlink", async () => {
  const original = await bind("original"), next = await authorize("replacement");
  await elapse(61);
  const occupied = await issue(next);
  expect((await verify(next, occupied)).statusCode).toBe(409);
  expect((await app.inject({ url: root, cookies: original })).json().status).toBe("BOUND");
  expect((await app.inject({ url: root, cookies: next })).json().status).toBe("UNBOUND");
  await elapse(61);
  const beforeUnlink = await issue(next);
  expect((await app.inject({ method: "POST", url: root + "/unlink", cookies: original, headers, payload: {} })).statusCode).toBe(200);
  expect((await verify(next, beforeUnlink)).statusCode).toBe(400);
  await elapse(61);
  expect((await verify(next, await issue(next))).statusCode).toBe(200);
  expect((await app.inject({ url: root, cookies: await authorize("original") })).json().status).toBe("UNBOUND");
});

it("enforces each daily limit separately and stops sending past the limit even with a fresh session", async () => {
  const same = await authorize("quota");
  for (let attempt = 0; attempt < 5; attempt++) {
    await issue(same);
    await elapse(61);
  }
  expect((await requestCode(await authorize("fresh-wechat"))).statusCode).toBe(202);
  expect((await requestCode(await authorize("quota"), "13900008888")).statusCode).toBe(202);
  expect(sendCode).toHaveBeenCalledTimes(5);
  expect(await owner.selectFrom("wechat_member_sms_challenges").select("id").execute()).toHaveLength(5);
  await elapse(86_401);
  await issue(await authorize("quota"));
  expect(await owner.selectFrom("wechat_member_sms_challenges").select("id").execute()).toHaveLength(1);
});

it("leaves historical staff-verified bindings readable when Tencent SMS is unconfigured", async () => {
  await owner.insertInto("wechat_member_bindings").values({ id: "wxbind-historical", app_id: config.appId, property_id: demo.propertyId,
    member_id: demo.memberId, open_id: "wx-legacy", verified_by: demo.administratorSubjectId, verification: "IN_PERSON" }).execute();
  await app.close();
  runtime = createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl));
  app = await buildServer(runtime, { wechatMember: { config, service } });
  expect((await app.inject({ url: root, cookies: await authorize("legacy") })).json().status).toBe("BOUND");
  const unbound = await authorize("new");
  expect((await app.inject({ url: root, cookies: unbound })).json()).toEqual({ status: "UNBOUND", smsAvailable: false });
  expect((await requestCode(unbound)).statusCode).toBe(503);
  expect(sendCode).not.toHaveBeenCalled();
});
