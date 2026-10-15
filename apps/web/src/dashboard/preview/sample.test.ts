import { describe, expect, it } from "vitest";
import { sampleDashboard } from "./sample";

describe("合成看板逐日资金", () => {
  it("完整日期区间逐日展示，合计与每日整数分一致", () => {
    const data = sampleDashboard("sample-a", "", "complete");
    expect(data.moneyTrend).toHaveLength(30);
    expect(data.moneyTrend[0]?.date).toBe(data.range.from);
    expect(data.moneyTrend.at(-1)?.date).toBe(data.range.to);
    for (const key of ["collectedMinor", "refundedMinor", "correctedMinor", "netMinor"] as const) {
      const sum = data.moneyTrend.reduce((value, day) => value + BigInt(day.money[0]![key]!), 0n);
      expect(sum.toString()).toBe(data.money[0]![key]);
    }
    expect(data.moneyTrend.some(day => BigInt(day.money[0]!.correctedMinor) < 0n)).toBe(true);
    expect(data.moneyTrend.filter(day => BigInt(day.money[0]!.collectedMinor) > 0n).length).toBeGreaterThan(1);
  });

  it("日期切换取相同日期的相同金额，不影响现场余额", () => {
    const month = sampleDashboard("sample-a", "", "complete");
    const week = sampleDashboard("sample-a", "from=2026-10-05&to=2026-10-11", "complete");
    expect(week.moneyTrend).toEqual(month.moneyTrend.slice(-7));
    expect(week.current).toEqual(month.current);
    expect(week.money).not.toEqual(month.money);
  });

  it("单日自定义与零值场景均保留真实日期数量", () => {
    const single = sampleDashboard("sample-a", "from=2026-10-01&to=2026-10-01", "complete");
    expect(single.moneyTrend).toHaveLength(1);
    expect(single.money).toEqual(single.moneyTrend[0]?.money);
    const zero = sampleDashboard("sample-a", "", "zero");
    expect(zero.moneyTrend).toHaveLength(30);
    expect(zero.moneyTrend.every(day => day.money.every(row => row.collectedMinor === "0" && row.refundedMinor === "0" && row.correctedMinor === "0" && row.netMinor === "0"))).toBe(true);
  });

  it("住宿筛选不改变资金趋势与当前余额", () => {
    const original = sampleDashboard("sample-a", "", "complete");
    const filtered = sampleDashboard("sample-a", "building=A栋&source=MEMBER", "complete");
    expect(filtered.moneyTrend).toEqual(original.moneyTrend);
    expect(filtered.current).toEqual(original.current);
  });
});


it("31条登记无需证件或人工核对即可全部计入住宿时长", () => {
  const data = sampleDashboard("sample-a", "", "unlinked");
  expect(data.community.current.registered).toMatchObject({total:31,paid:26,volunteer:5});
  expect(data.community.duration.reduce((sum,row)=>sum+row.current,0)).toBe(31);
  expect(data.community.durationCoverage?.current).toMatchObject({registrationBased:30,pendingRegistrations:0,issues:[]});
});
