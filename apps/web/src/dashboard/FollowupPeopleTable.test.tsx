import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { FollowupPeopleTable } from "./FollowupPeopleTable";
import { sampleDetails } from "./preview/sample";

it("今日创建的未来及取消订单仍显示创建时间、住期和各自状态", () => {
  const data = sampleDetails("sample-a", "metric=TODAY_ORDERS", "complete");
  const html = renderToStaticMarkup(<MemoryRouter><FollowupPeopleTable items={data.items} metric="TODAY_ORDERS" timezone="Asia/Shanghai" /></MemoryRouter>);
  expect(html).toContain("2026/10/12");
  expect(html).toContain("09:30:00");
  expect(html).toContain("2026-10-15");
  expect(html).toContain("2026-10-22");
  expect(html).toContain("已取消");
  expect(html).toContain("小叶");
  expect(html).toContain('href="/orders/sample-TODAY_ORDERS-order-2"');
});

it("欠款明细展示逐单原金额、房床和实际住客", () => {
  const data = sampleDetails("sample-a", "metric=DEBT", "complete");
  const html = renderToStaticMarkup(<MemoryRouter><FollowupPeopleTable items={data.items} metric="DEBT" timezone="Asia/Shanghai" /></MemoryRouter>);
  expect(html).toContain("¥1,600.00");
  expect(html).toContain("¥1,280.00");
  expect(html).toContain("¥800.00");
  expect(html).toContain("202-1床");
  expect(html).toContain("阿青（青女士）");
});

it("留存按登记归属客户展示，缺归属时不拿来源住客代替", () => {
  const data = sampleDetails("sample-a", "metric=RETAINED", "complete");
  const render = () => renderToStaticMarkup(<MemoryRouter><FollowupPeopleTable items={data.items} metric="RETAINED" timezone="Asia/Shanghai" /></MemoryRouter>);
  expect(render()).toContain("大树（王先生）");
  expect(render()).toContain("小溪（林女士）");
  expect(render()).toContain("¥900.00");
  expect(render()).toContain("查看来源订单");
  data.items[0]!.retainedOwnerName = null;
  expect(render()).toContain("资金归属待核对");
  expect(render()).not.toContain("大树（王先生）");
  expect(render()).toContain("小溪（林女士）");
});
