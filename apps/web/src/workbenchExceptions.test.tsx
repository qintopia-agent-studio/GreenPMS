import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkbenchExceptionsState } from "./workbenchExceptionsReader";
import { WorkbenchExceptionsQueue } from "./workbenchExceptions";
import type { WorkbenchExceptionGroup } from "@qintopia/contracts";

function render(state: WorkbenchExceptionsState, group: WorkbenchExceptionGroup = "BUSINESS") {
  return renderToStaticMarkup(<MemoryRouter><WorkbenchExceptionsQueue state={state} group={group} retry={() => {}} firstPage={() => {}} nextPage={() => {}} /></MemoryRouter>);
}
const data = {
  propertyId: "sample-property", businessDate: "2026-10-24", asOf: "2026-10-24T03:00:00Z", totalOrders: 51, nextCursor: "sample-order",
  items: [{
    orderId: "sample-order", orderStatus: "CANCELLED", stayStatus: "CANCELLED", guestName: "演示住客", arrivalDate: "2026-03-01", departureDate: "2026-03-03", unitLabel: "样本 A01", orderHref: "/orders/sample-order",
    reasons: [
      { code: "LIFECYCLE_INCONSISTENT" as const, category: "DATA" as const, message: "订单和住宿记录对不上，请查看入住、退房记录", amount: null },
      { code: "INVENTORY_NOT_RELEASED" as const, category: "INVENTORY" as const, message: "订单已取消，房间仍被占用", amount: null }
    ]
  }]
};

it("renders every server reason and amount on one order, while retaining the server's full total and date scope", () => {
  const html = render({ loading: false, page: 1, data });
  expect(html.match(/<article /g)).toHaveLength(1);
  expect(html).toContain("51 个订单");
  expect(html).toContain("本页 1 个订单 / 共 51 个订单");
  expect(html).toContain("订单和住宿记录对不上");
  expect(html).toContain("订单已取消，房间仍被占用");
  expect(html).toContain('href="/orders/sample-order"');
  expect(html).toContain("2026-03-01");
  expect(html).toContain("按今天（2026-10-24）查看");
  expect(html).toContain("不随上方日期切换");
  expect(html).not.toContain("CHECK_OUT");
  expect(html).not.toContain("办理退款");
});

it("distinguishes a failed next page from no exceptions and provides retry and first-page actions", () => {
  const html = render({ loading: false, page: 2, error: new Error("read unavailable") });
  expect(html).toContain("暂时看不到这些订单");
  expect(html).toContain("还不能确定有哪些问题");
  expect(html).toContain("重新加载");
  expect(html).toContain("回到首页");
  expect(html).not.toContain("目前没有业务异常");
  expect(html).not.toContain("0 个订单");
});

it("distinguishes an empty page after concurrent updates from a confirmed zero total", () => {
  const emptyPage = render({ loading: false, page: 2, data: { ...data, items: [], nextCursor: null } });
  expect(emptyPage).toContain("这一页没有订单了");
  expect(emptyPage).not.toContain("目前没有业务异常");
  const zero = render({ loading: false, page: 1, data: { ...data, items: [], totalOrders: 0, nextCursor: null } });
  expect(zero).toContain("目前没有业务异常");
  expect(zero).toContain("没有需要处理的入住、退房或房间问题");
});

it("shows an unknown/loading state instead of a false zero", () => {
  const html = render({ loading: true, page: 1 });
  expect(html).toContain("正在载入当前异常事项");
  expect(html).not.toContain("0 个订单");
  expect(html).not.toContain("目前没有业务异常");
});

it("shows order money separately from successful external refunds that need recording", () => {
  const financial = { ...data, items: [{ ...data.items[0]!, reasons: [{ code: "REFUND_DUE" as const, category: "FUNDS" as const, message: "订单已取消，还有钱没退，也没登记为客人留存", amount: { currency: "CNY", minorUnits: 40000 } }] }] };
  const html = render({ loading: false, page: 1, data: financial }, "FINANCIAL");
  expect(html).toContain("订单款项");
  expect(html).toContain("还有钱没退");
  expect(html).toContain("400.00");
  expect(html).not.toContain("企微已退款");
  expect(html).not.toContain("入住、退房和房间安排");
});
