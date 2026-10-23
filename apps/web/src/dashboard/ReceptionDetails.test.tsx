import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ReceptionPeopleTable } from "./ReceptionDetails";
import { sampleDetails } from "./preview/sample";

it("接待名单展示全部住宿人、房床、订单日期与正确原单入口", () => {
  const data = sampleDetails("sample-a", "metric=DEPARTURE", "complete");
  const html = renderToStaticMarkup(<MemoryRouter><ReceptionPeopleTable items={data.items} /></MemoryRouter>);
  expect(html).toContain("小溪（林女士）");
  expect(html).toContain("小叶（叶先生）");
  expect(html).toContain("主住客");
  expect(html).toContain("同行人");
  expect(html).toContain("202-1床");
  expect(html).toContain("2026-09-25");
  expect(html).toContain("2026-10-12");
  expect(html).toContain("在住 · 待离店");
  expect(html).toContain('href="/orders/sample-DEPARTURE-order-0"');
});

it("旧版或缺项明细明确显示待补充，不以订单编号或会员代替住客", () => {
  const data = sampleDetails("sample-a", "metric=ARRIVAL", "partial");
  const first = data.items[0]!;
  delete first.reception;
  first.orderId = "order/with space";
  const html = renderToStaticMarkup(<MemoryRouter><ReceptionPeopleTable items={[first]} /></MemoryRouter>);
  expect(html).toContain("住客登记待补充");
  expect(html).toContain("房间待核对");
  expect(html).toContain("住宿日期待核对");
  expect(html).toContain("状态待核对");
  expect(html).toContain('href="/orders/order%2Fwith%20space"');
  expect(html).not.toContain("已预订");
});
