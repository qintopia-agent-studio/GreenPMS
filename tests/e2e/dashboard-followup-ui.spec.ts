import { expect, test } from "@playwright/test";
import { dashboardFixture, installDashboardUiFixture } from "../helpers/dashboard-ui-fixture";

test("follow-up cards expand below their row, preserve position and distinguish retained owner", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  await page.route("**/dashboard/details?**", async route => {
    const url = new URL(route.request().url());
    const summary = dashboardFixture(url);
    const metric = url.searchParams.get("metric");
    const pageNumber = Number(url.searchParams.get("page") ?? 0);
    await route.fulfill({ json: {
      asOf: summary.asOf, definitionVersion: summary.definitionVersion, range: summary.range,
      changedSinceSummary: false, page: pageNumber, pageSize: 1, total: 2,
      items: [{ id: `${metric}-${pageNumber}`, metric, date: summary.businessDate, label: "经营跟进样例", orderId: `ui-order-${pageNumber}`, memberId: null, unitId: null, units: 1,
        amountMinor: metric === "DEBT" ? "160000" : metric === "RETAINED" ? "90000" : null,
        currency: metric === "TODAY_ORDERS" ? null : "CNY", registeredAt: "2026-10-09T01:30:00Z", businessDate: null, reason: "界面回归样例",
        retainedOwnerName: metric === "RETAINED" ? "大树（王先生）" : undefined,
        orderSummary: { occupants: [{ name: `小溪${pageNumber + 1}（林女士）`, isPrimary: true }, { name: "小叶", isPrimary: false }],
          rooms: [{ roomCode: "F05-2", buildingCode: "F栋" }, { roomCode: "F06-1", buildingCode: "F栋" }], arrivalDate: "2026-10-15", departureDate: "2026-10-22", status: metric === "TODAY_ORDERS" ? "CANCELLED" : "CHECKED_OUT" }
      }]
    } });
  });
  await page.goto("/dashboard");
  const cards = page.locator(".dashboard-current-followups > div > button");
  const titles = ["今日新增订单明细", "住宿欠款明细", "客户留存待用明细"] as const;
  for (let index = 0; index < titles.length; index++) {
    const card = cards.nth(index);
    await card.focus();
    const before = await page.evaluate(() => scrollY);
    await card.press("Enter");
    const panel = page.getByRole("region", { name: titles[index]! });
    await expect(panel).toContainText("小溪1（林女士）");
    await expect(card).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(before);
    await expect(page.locator(".dashboard-inline-details")).toHaveCount(1);
    await expect(page.locator(".dashboard-details")).toHaveCount(0);
    const gap = await panel.evaluate(node => node.getBoundingClientRect().top - document.querySelector(".dashboard-current-followups")!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(30);
    await expect(panel).toContainText("F05-2");
    await expect(panel).toContainText("F06-1");
    if (index === 0) {
      await expect(panel).toContainText("09:30:00");
      await expect(panel).toContainText("已取消");
      await expect(panel).toContainText("2026-10-15");
    } else if (index === 1) {
      await expect(panel).toContainText("¥1,600.00");
    } else {
      await expect(panel).toContainText("¥900.00");
      const owner = panel.locator('td[data-label="资金归属客户"]');
      await expect(owner).toHaveText("大树（王先生）");
      await expect(owner).not.toContainText("小溪");
      await expect(panel.getByRole("link", { name: "查看来源订单" })).toHaveAttribute("href", "/orders/ui-order-0");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByRole("button", { name: "下一页" }).click();
    await expect(panel).toContainText("小溪2（林女士）");
  }
  const retained = page.getByRole("region", { name: titles[2] });
  await retained.getByRole("button", { name: "收起明细" }).click();
  await expect(cards.nth(2)).toBeFocused();
  await expect(retained).toHaveCount(0);
  await cards.first().click();
  await expect(page.getByRole("region", { name: titles[0] })).toBeVisible();
  await cards.first().click();
  await expect(page.locator(".dashboard-inline-details")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("each follow-up card shows its own empty state after a retry", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  await page.goto("/dashboard");
  const cards = page.locator(".dashboard-current-followups > div > button");
  await expect(cards).toHaveCount(3);
  fixture.fail = true;
  await cards.first().click();
  const first = page.getByRole("region", { name: "今日新增订单明细" });
  await expect(first.getByRole("alert")).toBeVisible();
  fixture.fail = false;
  await page.route("**/dashboard/details?**", async route => {
    const summary = dashboardFixture(new URL(route.request().url()));
    await route.fulfill({ json: { asOf: summary.asOf, definitionVersion: summary.definitionVersion, range: summary.range, changedSinceSummary: true, page: 0, pageSize: 50, total: 0, items: [] } });
  });
  await first.getByRole("button", { name: "重试" }).click();
  await expect(first).toContainText("今天暂无新增住宿订单");
  await expect(first).toContainText("明细已更新");
  await cards.nth(1).click();
  await expect(page.getByRole("region", { name: "住宿欠款明细" })).toContainText("当前没有住宿欠款记录");
  await cards.nth(2).click();
  await expect(page.getByRole("region", { name: "客户留存待用明细" })).toContainText("当前没有可用的客户留存");
  await expect(page.locator(".dashboard-details")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
