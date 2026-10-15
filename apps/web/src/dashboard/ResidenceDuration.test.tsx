import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ResidenceDuration } from "./ResidenceDuration";
import { sampleDashboard } from "./preview/sample";

const complete = () => ({ pendingRegistrations: 0, pendingOrders: 0, issues: [] });
function render(data: ReturnType<typeof sampleDashboard>, perspective: "current" | "all" = "current") {
  return renderToStaticMarkup(<MemoryRouter><ResidenceDuration data={data} perspective={perspective} onPerspectiveChange={() => {}} /></MemoryRouter>);
}
describe("residence duration evidence presentation", () => {
  it("does not present the one-person partial sample as a complete population with five zero bands", () => {
    const data = sampleDashboard("sample-a", "", "zero");
    data.community.duration = [{ nights: 1, current: 1, all: 0 }];
    data.community.durationCoverage = { current: { pendingRegistrations: 30, pendingOrders: 0, issues: [{ orderId: "order-a", reason: "缺少跨订单身份依据" }] }, all: complete() };
    const html = render(data);
    expect(html).toContain("已核对 1 人 · 时长结构尚不完整");
    expect(html).toContain("30 条住宿登记");
    expect(html.match(/<b>待核对<\/b>/g)).toHaveLength(5);
    expect(html).not.toContain("<b>0人</b>");
    expect(html).toContain('href="/orders/order-a"');
    expect(html).toContain("不与已核对人数相加");
  });
  it("shows true zero bands for complete data and clearly states the period cutoff and person-trip unit", () => {
    const data = sampleDashboard("sample-a", "", "zero");
    data.businessDate = "2026-10-15"; data.range = { from: "2026-09-01", to: "2026-09-30" };
    data.community.duration = [{ nights: 41, current: 0, all: 2 }];
    data.community.durationCoverage = { current: complete(), all: complete() };
    const html = render(data, "all");
    expect(html).toContain("已统计 2 人次");
    expect(html).toContain("统计截至 2026-09-30");
    expect(html).toContain("使用页面顶部日期筛选");
    expect(html).toContain("不只算期间内的夜数");
    expect(html.match(/<b>0人次<\/b>/g)).toHaveLength(5);
    expect(html).not.toContain("时长结构尚不完整");
  });
  it("distinguishes all-unresolved, legacy coverage-unknown, and genuine empty populations", () => {
    const data = sampleDashboard("sample-a", "", "zero");
    data.community.duration = [];
    data.community.durationCoverage = { current: { pendingRegistrations: 0, pendingOrders: 2, issues: [{ orderId: "order-a", reason: "时间线待核对" }] }, all: complete() };
    expect(render(data)).toContain("2 个订单");
    expect(render(data)).toContain("不代表没有人在住");
    expect(render(data, "all")).toContain("所选期间没有实际住宿记录");
    delete data.community.durationCoverage;
    expect(render(data)).toContain("暂不能确认是否包含全部住客");
    expect(render(data)).not.toContain("当前没有实际在住人员");
  });
});
