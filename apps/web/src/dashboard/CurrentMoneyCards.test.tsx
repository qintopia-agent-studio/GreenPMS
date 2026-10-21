import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentMoneyCards } from "./CurrentMoneyCards";
import { sampleDashboard } from "./preview/sample";

function fixture() {
  const data = sampleDashboard("sample-a", "", "zero");
  data.current.todaySales = { enabled: true, complete: true, reviewCount: 0, reason: "已确认", totals: [{ currency: "CNY", salesMinor: "0", refundsMinor: "0", correctedMinor: "0", netMinor: "0" }], breakdown: [], trend: [], sealedMonths: [] };
  data.current.paymentSync = { enabled: true, hasError: false, lastSyncedAt: "2026-10-12T01:40:00Z" };
  data.current.todayUnclaimed = [];
  return data;
}

describe("当前财务数据的零值与缺项", () => {
  it("只有同步正常且没有登记或待核对事实时，才说明今日暂无登记", () => {
    const data = fixture();
    const html = renderToStaticMarkup(<CurrentMoneyCards data={data} onDetail={() => {}} />);
    expect(html).toContain("今日暂无已确认业务");
    expect(html).toContain("今日暂无金额登记");
    expect(html).not.toContain("同步待核对");
    // 说明按钮独立于金额按钮，避免嵌套 button 造成浏览器 DOM 与 React 不一致。
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  });
  it("未认领退款保留负号，不把待认领金额加入已确认总额，也不冒充无登记", () => {
    const data = fixture();
    data.current.todayUnclaimed = [{currency:"CNY",amountMinor:"-12500",count:1}];
    const html = renderToStaticMarkup(<CurrentMoneyCards data={data} onDetail={() => {}} />);
    expect(html).toContain("今日待认领"); expect(html).toContain("¥−125.00");
    expect(html).toContain("¥0.00"); expect(html).not.toContain("今日暂无金额登记");
  });
  it.each([undefined, {enabled:false,lastSyncedAt:null,hasError:false}, {enabled:true,lastSyncedAt:null,hasError:false}, {enabled:true,lastSyncedAt:"2026-10-12T01:40:00Z",hasError:true}, {enabled:true,lastSyncedAt:"2026-10-11T01:40:00Z",hasError:false}])("同步未就绪时不把尚未同步说成没有交易：%j", sync => {
    const data = fixture();
    if (sync) data.current.paymentSync = sync; else delete data.current.paymentSync;
    const html = renderToStaticMarkup(<CurrentMoneyCards data={data} onDetail={() => {}} />);
    expect(html).toContain("同步待核对"); expect(html).not.toContain("今日暂无金额登记");
  });
});
