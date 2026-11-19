import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { officialAccount, wechatMemberConfig } from "./wechat-official-account.ts";

const env = {
  WECHAT_MEMBER_ENABLED: "true", WECHAT_MEMBER_APP_ID: "wx-test", WECHAT_MEMBER_APP_SECRET: "test-secret",
  WECHAT_MEMBER_PROPERTY_ID: "property-test", WECHAT_MEMBER_ORIGIN: "https://member.example.test"
};
it("requires an explicit HTTPS origin and only accepts entitlement fields from a configured template", () => {
  expect(wechatMemberConfig({})).toBeUndefined();
  expect(wechatMemberConfig(env)?.reminder).toBeUndefined();
  expect(() => wechatMemberConfig({ ...env, WECHAT_MEMBER_ORIGIN: "http://member.example.test" })).toThrow();
  expect(() => wechatMemberConfig({ ...env, WECHAT_MEMBER_TEMPLATE_ID: "t", WECHAT_MEMBER_TEMPLATE_FIELDS: '{"amount1":"price"}' })).toThrow();
});

it("uses the service account identity, signs the canonical member page and submits only the approved fields", async () => {
  const cfg = wechatMemberConfig({ ...env, WECHAT_MEMBER_TEMPLATE_ID: "expiry",
    WECHAT_MEMBER_TEMPLATE_FIELDS: '{"thing1":"product","date2":"expiry","number3":"days"}' })!;
  const sent: unknown[] = [];
  let credentials = 0;
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.weixin.qq.com");
    switch (url.pathname) {
      case "/sns/oauth2/access_token": return Response.json({ openid: "test-openid" });
      case "/cgi-bin/stable_token": credentials++; return Response.json({ access_token: "t" + credentials, expires_in: 7200 });
      case "/cgi-bin/ticket/getticket": return Response.json({ ticket: "ticket", expires_in: 7200 });
      case "/cgi-bin/user/info": return Response.json({ openid: "test-openid", subscribe: 1 });
      case "/cgi-bin/message/subscribe/bizsend":
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ errcode: 42001 });
      default: throw new Error("unexpected provider call");
    }
  });
  const account = officialAccount(cfg, transport);
  expect(await account.recognize("code")).toBe("test-openid");
  const signature = await account.subscriptionSignature();
  const message = `jsapi_ticket=ticket&noncestr=${signature.nonceStr}&timestamp=${signature.timestamp}&url=${cfg.origin}/member-center`;
  expect(signature.signature).toBe(createHash("sha1").update(message).digest("hex"));
  expect(await account.following("test-openid")).toBe(true);
  expect(await account.send(await account.token(), "test-openid", "2800元会员", "2026-12-01", 30)).toBe(42001);
  expect(sent).toEqual([{ touser: "test-openid", template_id: "expiry", lang: "zh_CN", miniprogram_state: "formal",
    data: { thing1: { value: "住宿会员权益" }, date2: { value: "2026年12月1日" }, number3: { value: "30" } } }]);
  expect(await account.token()).toBe("t2");
});
