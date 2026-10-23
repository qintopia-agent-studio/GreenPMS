import { expect, test } from "@playwright/test";
import { dashboardFixture, installDashboardUiFixture } from "../helpers/dashboard-ui-fixture";

test("reception details expand beside the card, paginate, switch and restore focus", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  await page.route("**/dashboard/details?**", async route => {
    const url = new URL(route.request().url());
    const summary = dashboardFixture(url);
    const metric = url.searchParams.get("metric");
    const pageNumber = Number(url.searchParams.get("page") ?? 0);
    await route.fulfill({ json: { asOf: summary.asOf, definitionVersion: summary.definitionVersion, range: summary.range, changedSinceSummary: false, page: pageNumber, pageSize: 1, total: 2,
      items: [{ id: `${metric}-${pageNumber}`, date: summary.businessDate, metric, label: "接待样例", orderId: `ui-order-${pageNumber}`, memberId: null, unitId: "ui-room", units: 1, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "界面回归样例",
        reception: { occupants: [{ name: `小溪${pageNumber + 1}（林女士）`, isPrimary: true }, { name: "小叶", isPrimary: false }], roomCode: "F05-2", buildingCode: "F栋", arrivalDate: "2026-10-01", departureDate: "2026-10-09", status: metric === "ARRIVAL" ? "RESERVED" : "CHECKED_IN" }
      }] } });
  });
  await page.goto("/dashboard");
  const arrival = page.locator(".community-today button").first();
  const departure = page.locator(".community-today button").last();
  await arrival.focus();
  const before = await page.evaluate(() => scrollY);
  await arrival.press("Enter");
  const panel = page.getByRole("region", { name: "待到店明细" });
  await expect(panel).toContainText("小溪1（林女士）");
  await expect(arrival).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(before);
  expect(await panel.evaluate(node => node.closest('.dashboard-current-scene') !== null)).toBe(true);
  expect(await panel.evaluate(node => node.getBoundingClientRect().top - document.querySelector('.community-snapshot')!.getBoundingClientRect().bottom)).toBeLessThan(30);
  await expect(page.locator(".dashboard-details")).toHaveCount(0);
  await expect(panel).toContainText("小叶");
  await expect(panel).toContainText("F05-2");
  await expect(panel.getByRole("link", { name: "查看订单" })).toHaveAttribute("href", "/orders/ui-order-0");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole("button", { name: "下一页" }).click();
  await expect(panel).toContainText("小溪2（林女士）");
  await departure.click();
  const leaving = page.getByRole("region", { name: "待离店明细" });
  await expect(leaving).toContainText("小溪1（林女士）");
  await expect(leaving).toContainText("在住 · 待离店");
  await expect(panel).toHaveCount(0);
  await leaving.getByRole("button", { name: "收起明细" }).click();
  await expect(departure).toBeFocused();
  await expect(leaving).toHaveCount(0);
  await arrival.click();
  await expect(panel).toBeVisible();
  await arrival.click();
  await expect(panel).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("reception read failures can retry and empty results stay local", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  await page.goto("/dashboard");
  await expect(page.locator(".community-today button").first()).toBeVisible();
  fixture.fail = true;
  await page.locator(".community-today button").first().click();
  const panel = page.getByRole("region", { name: "待到店明细" });
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel).not.toContainText("今天暂无");
  fixture.fail = false;
  await page.route("**/dashboard/details?**", async route => {
    const summary = dashboardFixture(new URL(route.request().url()));
    await route.fulfill({ json: { asOf: summary.asOf, definitionVersion: summary.definitionVersion, range: summary.range, changedSinceSummary: true, page: 0, pageSize: 50, total: 0, items: [] } });
  });
  await panel.getByRole("button", { name: "重试" }).click();
  await expect(panel).toContainText("今天暂无待到店订单");
  await expect(panel).toContainText("明细已更新");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".dashboard-details")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
