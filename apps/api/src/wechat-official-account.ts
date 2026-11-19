import { createHash, randomBytes } from "node:crypto";

import { memberFacingLabel } from "@qintopia/contracts";

export interface WechatMemberConfig {
  appId: string;
  secret: string;
  propertyId: string;
  origin: string;
  reminder?: { template: string; fields: Record<string, "product" | "expiry" | "days"> };
}

export function wechatMemberConfig(env: NodeJS.ProcessEnv = process.env): WechatMemberConfig | undefined {
  if (env.WECHAT_MEMBER_ENABLED !== "true") return;
  const { WECHAT_MEMBER_APP_ID: appId, WECHAT_MEMBER_APP_SECRET: secret, WECHAT_MEMBER_PROPERTY_ID: propertyId, WECHAT_MEMBER_ORIGIN: origin } = env;
  if (!appId || !secret || !propertyId || !origin || !/^https:\/\/[^/]+$/.test(origin) || new URL(origin).origin !== origin) {
    throw new Error("会员服务号需要 AppID、服务器密钥、门店和 HTTPS 网页域名。");
  }
  const config: WechatMemberConfig = { appId, secret, propertyId, origin };
  if (env.WECHAT_MEMBER_TEMPLATE_ID || env.WECHAT_MEMBER_TEMPLATE_FIELDS) {
    const fields: unknown = JSON.parse(env.WECHAT_MEMBER_TEMPLATE_FIELDS || "{}");
    if (!env.WECHAT_MEMBER_TEMPLATE_ID || !fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length
      || !Object.entries(fields).every(([key, meaning]) => (meaning === "product" && /^thing\d+$/.test(key))
        || (meaning === "expiry" && /^date\d+$/.test(key)) || (meaning === "days" && /^number\d+$/.test(key)))
      || !Object.values(fields).includes("expiry")) throw new Error("请按微信已批准的到期订阅模板配置字段。");
    config.reminder = { template: env.WECHAT_MEMBER_TEMPLATE_ID, fields: fields as NonNullable<WechatMemberConfig["reminder"]>["fields"] };
  }
  return config;
}

export interface WechatService {
  recognize(code: string): Promise<string>;
  subscriptionSignature(): Promise<{ appId: string; timestamp: number; nonceStr: string; signature: string }>;
  following(openId: string): Promise<boolean>;
  token(): Promise<string>;
  send(token: string, openId: string, product: string, expiry: string, days: number): Promise<number>;
}

export function officialAccount(config: WechatMemberConfig, transport: typeof fetch = fetch): WechatService {
  let credential: { value: string; until: number } | undefined;
  let jsTicket: typeof credential;
  async function request(path: string, query: Record<string, string>, body?: object): Promise<Record<string, unknown>> {
    const url = new URL(path, "https://api.weixin.qq.com");
    url.search = new URLSearchParams(query).toString();
    const response = await transport(url, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(7000),
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error("微信接口暂时不可用");
    const result = await response.json() as Record<string, unknown>;
    if (query.access_token === credential?.value && (result.errcode === 40014 || result.errcode === 42001)) credential = undefined;
    return result;
  }
  async function token() {
    if (credential && Date.now() < credential.until) return credential.value;
    const result = await request("/cgi-bin/stable_token", {}, { grant_type: "client_credential", appid: config.appId, secret: config.secret, force_refresh: false });
    if (typeof result.access_token !== "string" || typeof result.expires_in !== "number") throw new Error("微信接口凭据暂不可用");
    credential = { value: result.access_token, until: Date.now() + Math.max(0, result.expires_in - 120) * 1000 };
    return credential.value;
  }
  return {
    token,
    async recognize(code) {
      const data = await request("/sns/oauth2/access_token", { appid: config.appId, secret: config.secret, code, grant_type: "authorization_code" });
      if (typeof data.openid !== "string" || !data.openid || data.openid.length > 128) throw new Error("微信身份验证未完成");
      return data.openid;
    },
    async subscriptionSignature() {
      if (!jsTicket || jsTicket.until <= Date.now()) {
        const reply = await request("/cgi-bin/ticket/getticket", { access_token: await token(), type: "jsapi" });
        if (typeof reply.ticket !== "string" || typeof reply.expires_in !== "number") throw new Error("微信网页签名暂不可用");
        jsTicket = { value: reply.ticket, until: Date.now() + Math.max(0, reply.expires_in - 120) * 1000 };
      }
      const timestamp = Math.floor(Date.now() / 1000), nonceStr = randomBytes(16).toString("hex");
      const canonical = `jsapi_ticket=${jsTicket.value}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${config.origin}/member-center`;
      return { appId: config.appId, timestamp, nonceStr, signature: createHash("sha1").update(canonical).digest("hex") };
    },
    async following(openId) {
      const data = await request("/cgi-bin/user/info", { access_token: await token(), openid: openId, lang: "zh_CN" });
      if (!(data.subscribe === 0 || data.subscribe === 1) || (data.subscribe === 1 && data.openid !== openId)) throw new Error("微信关注状态暂不可用");
      return data.subscribe === 1;
    },
    async send(accessToken, openId, product, expiry, days) {
      const setting = config.reminder!;
      const [year, month, day] = expiry.split("-");
      const values = { product: Array.from(memberFacingLabel(product)).slice(0, 20).join(""), expiry: year + "年" + Number(month) + "月" + Number(day) + "日", days: String(days) };
      const data = Object.fromEntries(Object.entries(setting.fields).map(([key, meaning]) => [key, { value: values[meaning] }]));
      const reply = await request("/cgi-bin/message/subscribe/bizsend", { access_token: accessToken }, {
        touser: openId, template_id: setting.template, lang: "zh_CN", miniprogram_state: "formal", data
      });
      if (!Number.isSafeInteger(reply.errcode)) throw new Error("微信未返回明确的提交结果");
      return reply.errcode as number;
    }
  };
}
