import { describe, expect, it } from "vitest";
import { parseChannelYuanToMinor, parsePositiveStayFinalYuanToMinor, parseStayFinalYuanToMinor, supportsDecimalStayFinalAmount } from "./channel-amount";

describe("渠道金额精确到分", () => {
  it.each([["1610.28",161028],["277.20",27720],["387.5",38750],["0.01",1],["0",0],["21474836.00",2147483600]] as const)("%s 精确转分", (input,minor) => {
    expect(parseChannelYuanToMinor(input)).toBe(minor);
  });
  it.each(["", "1.001", "-0.01", "1e2", "Infinity", "21474836.01", "99999999999999999999", "1,000.20"])("拒绝非法精度或范围 %s", input => {
    expect(parseChannelYuanToMinor(input)).toBeUndefined();
  });
});


describe("普通住宿手工最终金额边界", () => {
  it("正金额入口拒绝各种零值并保留一分钱边界", () => {
    for (const text of ["0", "0.0", "0.00", "00.00", " 0 "]) expect(parsePositiveStayFinalYuanToMinor(text)).toBeUndefined();
    expect(parsePositiveStayFinalYuanToMinor("0.01")).toBe(1);
    expect(parseStayFinalYuanToMinor("0")).toBe(0);
  });
  it.each([["387.5",38750],["387.50",38750],["387.05",38705],["0",0],["21474836.00",2147483600]] as const)("%s 精确到整数分", (text,minor) => expect(parseStayFinalYuanToMinor(text)).toBe(minor));
  it.each(["387.501","-1","1e2","NaN","Infinity","21474836.01","", "387."])("拒绝非法文本 %s", text => expect(parseStayFinalYuanToMinor(text)).toBeUndefined());
  it("只向普通WECOM或既有渠道开放，不放开免费及会员", () => {
    expect(supportsDecimalStayFinalAmount({booking_channel_code:"WECOM",stay_type:"TRANSIENT"})).toBe(true);
    expect(supportsDecimalStayFinalAmount({booking_channel_code:null})).toBe(false);
    for (const extra of [{stay_type:"FREE"},{member_id:"member"},{member_contract_id:"contract"}]) {
      expect(supportsDecimalStayFinalAmount({booking_channel_code:"WECOM",...extra})).toBe(false);
    }
  });
});
