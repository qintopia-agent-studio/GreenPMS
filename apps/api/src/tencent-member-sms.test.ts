import { afterEach, expect, it, vi } from "vitest";
import { tencentMemberSms } from "./tencent-member-sms.ts";

const env = { WECHAT_MEMBER_SMS_SECRET_ID: "synthetic-id", WECHAT_MEMBER_SMS_SECRET_KEY: "synthetic-secret",
  WECHAT_MEMBER_SMS_SDK_APP_ID: "1400000000", WECHAT_MEMBER_SMS_SIGN_NAME: "测试签名", WECHAT_MEMBER_SMS_TEMPLATE_ID: "100000" };
const phone = "+8613800000000";
afterEach(() => vi.useRealTimers());

it("leaves an unconfigured sender disabled and rejects partial credentials", () => {
  expect(tencentMemberSms({})).toBeUndefined();
  expect(() => tencentMemberSms({ WECHAT_MEMBER_SMS_SECRET_ID: "partial" })).toThrow("已审核签名");
});

it("signs the exact domestic SendSms payload and accepts only the addressed receipt", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
  const transport = vi.fn<typeof fetch>(async () => Response.json({ Response: { SendStatusSet: [{ Code: "Ok", PhoneNumber: phone }] } }));
  await tencentMemberSms(env, transport)!.sendCode(phone, "012345");
  const [url, init] = transport.mock.calls[0]!;
  expect(url).toBe("https://sms.tencentcloudapi.com");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toMatchObject({ "X-TC-Action": "SendSms", "X-TC-Version": "2021-01-11", "X-TC-Timestamp": "1767323045",
    Authorization: "TC3-HMAC-SHA256 Credential=synthetic-id/2026-01-02/sms/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=0ad3b2db83afa1239e4fcdbc3d45fda8c119866cb66c21d4819c1e72e537cf3d" });
  expect(JSON.parse(String(init?.body))).toEqual({ PhoneNumberSet: [phone], SmsSdkAppId: "1400000000", SignName: "测试签名", TemplateId: "100000", TemplateParamSet: ["012345"] });
});

it.each([{ Error: { Code: "AuthFailure" } }, { SendStatusSet: [] }, { SendStatusSet: [{ Code: "FailedOperation", PhoneNumber: phone }] },
  { SendStatusSet: [{ Code: "Ok", PhoneNumber: "+8613900000000" }] }])("withholds success for a rejected or unrelated receipt", async response => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ Response: response }));
  await expect(tencentMemberSms(env, transport)!.sendCode(phone, "000001")).rejects.toThrow("未确认");
  expect(transport).toHaveBeenCalledTimes(1);
});
