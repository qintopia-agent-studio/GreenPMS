import { describe, expect, it } from "vitest";
import { parseChannelYuanToMinor } from "./channel-amount";

describe("渠道金额精确到分", () => {
  it.each([["1610.28",161028],["277.20",27720],["387.5",38750],["0.01",1],["0",0],["21474836.00",2147483600]] as const)("%s 精确转分", (input,minor) => {
    expect(parseChannelYuanToMinor(input)).toBe(minor);
  });
  it.each(["", "1.001", "-0.01", "1e2", "Infinity", "21474836.01", "99999999999999999999", "1,000.20"])("拒绝非法精度或范围 %s", input => {
    expect(parseChannelYuanToMinor(input)).toBeUndefined();
  });
});
