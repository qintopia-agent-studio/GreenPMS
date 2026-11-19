import { createHash, createHmac } from "node:crypto";

export class MemberSmsRejected extends Error {}

export interface MemberSms {
  defaults?: {sign:string; template:string};
  sendCode(phone: string, code: string, settings?: {sign:string; template:string}): Promise<void>;
}

// Tencent Cloud SMS v2021-01-11, SendSms with the TC3-HMAC-SHA256 authorization header.
export function tencentMemberSms(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch): MemberSms | undefined {
  const { WECHAT_MEMBER_SMS_SECRET_ID: id, WECHAT_MEMBER_SMS_SECRET_KEY: key, WECHAT_MEMBER_SMS_SDK_APP_ID: app,
    WECHAT_MEMBER_SMS_SIGN_NAME: sign, WECHAT_MEMBER_SMS_TEMPLATE_ID: template } = env;
  if (![id, key, app, sign, template].some(Boolean)) return;
  if (!id || !key || !app) throw new Error("会员短信需要腾讯云 API 密钥、短信应用 ID、已审核签名和验证码模板 ID。");

  const host = "sms.tencentcloudapi.com", contentType = "application/json; charset=utf-8";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (secret: Buffer | string, value: string) => createHmac("sha256", secret).update(value).digest();

  return { defaults: {sign:sign ?? "",template:template ?? ""}, async sendCode(phone, code, settings) {
    const signName = settings?.sign ?? sign, templateId = settings?.template ?? template;
    if (!signName || !templateId) throw new Error("会员短信签名和模板尚未配置");
    const payload = JSON.stringify({ PhoneNumberSet: [phone], SmsSdkAppId: app, SignName: signName, TemplateId: templateId, TemplateParamSet: [code] });
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const scope = date + "/sms/tc3_request";
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:sendsms\n`;
    const signed = "content-type;host;x-tc-action";
    const canonical = ["POST", "/", "", canonicalHeaders, signed, hash(payload)].join("\n");
    const toSign = ["TC3-HMAC-SHA256", timestamp, scope, hash(canonical)].join("\n");
    const signingKey = hmac(hmac(hmac("TC3" + key, date), "sms"), "tc3_request");
    const signature = hmac(signingKey, toSign).toString("hex");
    const response = await transport("https://" + host, { method: "POST", redirect: "error", signal: AbortSignal.timeout(7000),
      headers: { "Content-Type": contentType, "X-TC-Action": "SendSms", "X-TC-Version": "2021-01-11", "X-TC-Region": "ap-guangzhou",
        "X-TC-Timestamp": String(timestamp), Authorization: `TC3-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signed}, Signature=${signature}` }, body: payload });
    if (!response.ok) throw new Error("腾讯云短信接口暂不可用");
    const result = await response.json() as { Response?: { Error?: unknown; SendStatusSet?: { Code?: string; PhoneNumber?: string }[] } };
    const statuses = result.Response?.SendStatusSet;
    if (result.Response?.Error || (statuses?.length === 1 && statuses[0]?.PhoneNumber === phone && statuses[0].Code && statuses[0].Code !== "Ok")) {
      throw new MemberSmsRejected("腾讯云未确认受理此条验证码");
    }
    if (statuses?.length !== 1 || statuses[0]?.Code !== "Ok" || statuses[0]?.PhoneNumber !== phone) {
      throw new Error("腾讯云未确认受理此条验证码");
    }
  } };
}
