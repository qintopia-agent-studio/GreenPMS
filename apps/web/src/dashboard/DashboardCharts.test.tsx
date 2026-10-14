import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardCharts } from "./DashboardCharts";
import { sampleDashboard } from "./preview/sample";

describe("daily money values in yuan", () => {
  it("converts all four columns from minor units, including negative and zero amounts", () => {
    const data = sampleDashboard("sample-a", "", "zero");
    data.moneyTrend = [{date: "2026-10-13", money:[{currency:"CNY", collectedMinor:"1200600", refundedMinor:"0", correctedMinor:"-390000", netMinor:"810600", reviewCount:0, reviewMinor:"0"}]}];
    const html = renderToStaticMarkup(<DashboardCharts data={data}/>);
    expect(html).toContain("逐日资金数据（元）");
    for (const value of ["¥12,006.00", "¥0.00", "¥−3,900.00", "¥8,106.00"]) expect(html).toContain(value);
    expect(html).not.toContain("整数分");
    expect(html).not.toContain("<td>1200600</td>");
    expect(data.moneyTrend[0]!.money[0]!.collectedMinor).toBe("1200600");
  });
  it("keeps cent precision, currency separation and unknown net amounts", () => {
    const data = sampleDashboard("sample-a", "", "zero");
    data.moneyTrend = [{date:"2026-10-13",money:[{currency:"CNY",collectedMinor:"9007199254740993",refundedMinor:"1",correctedMinor:"-1",netMinor:null,reviewCount:1,reviewMinor:"1"},{currency:"USD",collectedMinor:"12345",refundedMinor:"0",correctedMinor:"0",netMinor:"12345",reviewCount:0,reviewMinor:"0"}]}];
    const html=renderToStaticMarkup(<DashboardCharts data={data}/>);
    expect(html).toContain("¥90,071,992,547,409.93");
    expect(html).toContain("¥0.01");expect(html).toContain("¥−0.01");
    expect(html).toContain("待核对");expect(html).toContain("USD 123.45");
  });
});
