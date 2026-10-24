import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkbenchExceptionsState } from "./workbenchExceptionsReader";
import { WorkbenchExceptionsQueue } from "./workbenchExceptions";

function render(state: WorkbenchExceptionsState) {
  return renderToStaticMarkup(<MemoryRouter><WorkbenchExceptionsQueue state={state} retry={() => {}} firstPage={() => {}} nextPage={() => {}} /></MemoryRouter>);
}
const data = {
  propertyId: "sample-property", businessDate: "2026-10-24", asOf: "2026-10-24T03:00:00Z", totalOrders: 51, nextCursor: "sample-order",
  items: [{
    orderId: "sample-order", orderStatus: "CANCELLED", stayStatus: "CANCELLED", guestName: "演示住客", arrivalDate: "2026-03-01", departureDate: "2026-03-03", unitLabel: "样本 A01", orderHref: "/orders/sample-order",
    reasons: [
      { code: "REFUND_DUE" as const, category: "FUNDS" as const, message: "应退未退（已扣除有效留存）", amount: { currency: "CNY", minorUnits: 40000 } },
      { code: "INVENTORY_NOT_RELEASED" as const, category: "INVENTORY" as const, message: "已取消订单仍有库存占用", amount: null }
    ]
  }]
};

it("renders every server reason and amount on one order, while retaining the server's full total and date scope", () => {
  const html = render({ loading: false, page: 1, data });
  expect(html.match(/<article /g)).toHaveLength(1);
  expect(html).toContain("51 笔订单");
  expect(html).toContain("本页 1 笔 / 当前共 51 笔");
  expect(html).toContain("应退未退（已扣除有效留存）");
  expect(html).toContain("已取消订单仍有库存占用");
  expect(html).toContain("400.00");
  expect(html).toContain('href="/orders/sample-order"');
  expect(html).toContain("2026-03-01");
  expect(html).toContain("按门店当前营业日 2026-10-24 核对");
  expect(html).toContain("不随上方浏览日期变化");
  expect(html).not.toContain("CHECK_OUT");
  expect(html).not.toContain("办理退款");
});

it("distinguishes a failed next page from no exceptions and provides retry and first-page actions", () => {
  const html = render({ loading: false, page: 2, error: new Error("read unavailable") });
  expect(html).toContain("无法载入异常事项");
  expect(html).toContain("当前异常数量未知");
  expect(html).toContain("重新载入异常");
  expect(html).toContain("回到首页");
  expect(html).not.toContain("当前没有待处理异常");
  expect(html).not.toContain("0 笔订单");
});

it("distinguishes an empty page after concurrent updates from a confirmed zero total", () => {
  const emptyPage = render({ loading: false, page: 2, data: { ...data, items: [], nextCursor: null } });
  expect(emptyPage).toContain("本页暂无异常事项");
  expect(emptyPage).not.toContain("当前没有待处理异常");
  const zero = render({ loading: false, page: 1, data: { ...data, items: [], totalOrders: 0, nextCursor: null } });
  expect(zero).toContain("当前没有待处理异常");
  expect(zero).toContain("没有资金、库存或状态遗留时不计入异常");
});

it("shows an unknown/loading state instead of a false zero", () => {
  const html = render({ loading: true, page: 1 });
  expect(html).toContain("正在载入当前异常事项");
  expect(html).not.toContain("0 笔订单");
  expect(html).not.toContain("当前没有待处理异常");
});
