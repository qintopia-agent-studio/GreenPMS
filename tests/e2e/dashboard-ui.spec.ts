import { expect, test } from "@playwright/test";
import { installDashboardUiFixture } from "../helpers/dashboard-ui-fixture";

const heading = "经营概览";
test("dashboard fits desktop and narrow screens and renders bundled Chinese glyphs", async ({ page, browserName }, info) => {
  const fixture = await installDashboardUiFixture(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  for (const width of info.project.name === "mobile" ? [390, 320] : [897, 949, 1440]) {
    await page.setViewportSize({ width, height: 1018 });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "近7天", exact: true })).toBeInViewport();
    await page.screenshot({ path: `/tmp/agent-browser/dashboard-ui-${width}.png`, fullPage: true });
  }
  expect(await page.evaluate(() => document.fonts.check('600 24px "Noto Sans SC Variable"', "经营概览住宿退款"))).toBe(true);
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".dashboard h1" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.some(font => font.isCustomFont && font.familyName.includes("Noto Sans SC") && font.glyphCount >= 4)).toBe(true);
    await cdp.detach();
  }
  expect(errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("date filters, detail pagination, empty facts and stale-data recovery remain usable", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  const current = page.locator(".dashboard-current-grid");
  const currentText = await current.innerText();
  await page.getByRole("button", { name: "近7天", exact: true }).click();
  await expect(page.locator(".dashboard-history-heading")).toContainText("2026-10-02 至 2026-10-08");
  expect(await current.innerText()).toBe(currentText);
  await page.getByLabel("楼栋", { exact: true }).selectOption("一号楼");
  await expect(page.locator(".dashboard-kpi").nth(1).locator("strong")).toHaveText("21");
  await page.getByLabel("未来天数").selectOption("30");
  await expect(page.locator(".dashboard-future-day")).toHaveCount(30);
  await page.getByRole("button", { name: /付费住宿单元夜/ }).click();
  const detail = page.getByRole("region", { name: "付费住宿单元夜 · 组成明细" });
  await expect(detail.getByRole("heading")).toBeFocused();
  await expect(detail.getByText("界面样例事实 1", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: "查看订单" })).toHaveAttribute("href", "/orders/ui-order");
  await detail.getByRole("button", { name: "下一页" }).click();
  await expect(detail).toContainText("界面样例事实 2");
  await expect(detail).toContainText("数据可能变化");
  await expect(detail.getByRole("button", { name: "下一页" })).toBeDisabled();
  await detail.getByRole("button", { name: "关闭" }).click();
  await expect(detail).toHaveCount(0);
  await page.getByRole("button", { name: "查看免费占用明细" }).click();
  await expect(page.locator(".dashboard-details")).toContainText("该范围内没有符合条件的记录");
  await page.locator(".dashboard-details").getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await page.getByLabel("开始日期").fill("2026-09-01");
  await page.getByLabel("结束日期").fill("2026-09-03");
  await page.getByRole("button", { name: "应用日期" }).click();
  await expect(page.locator(".dashboard-history-heading")).toContainText("2026-09-01 至 2026-09-03");
  fixture.fail = true;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("数据已过期，刷新失败");
  expect(await current.innerText()).toBe(currentText);
  await expect(page.locator(".dashboard-kpi").nth(2)).toContainText("¥5,790.00");
  fixture.fail = false;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("late responses cannot cross property changes and expired sessions clear the dashboard", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  await page.setViewportSize({ width: 949, height: 1018 });
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  let release!: () => void;
  let held!: () => void;
  const started = new Promise<void>(resolve => { held = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.hold = async url => {
    if (url.pathname.includes("ui-a") && url.searchParams.get("from") === "2026-10-02") { held(); await gate; }
  };
  await page.getByRole("button", { name: "近7天", exact: true }).click();
  await started;
  await page.getByLabel("门店", { exact: true }).selectOption("ui-b");
  await expect(page.locator(".dashboard-current-card").first().locator("strong")).toHaveText("3 人");
  release();
  await expect(page.getByRole("button", { name: "近30天", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dashboard-history-heading")).toContainText("2026-09-09 至 2026-10-08");
  await expect(page.locator(".dashboard-current-card").first().locator("strong")).toHaveText("3 人");
  await page.route("**/api/v1/properties/ui-b/dashboard?**", route => route.fulfill({ status: 401, json: { code: "UNAUTHORIZED", message: "会话已过期" } }));
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.getByTestId("session-expired")).toBeVisible();
  await expect(page.getByTestId("dashboard-page")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("initial failure shows unavailable rather than zero and retries successfully", async ({ page }) => {
  const fixture = await installDashboardUiFixture(page);
  fixture.fail = true;
  await page.goto("/dashboard");
  await expect(page.getByRole("alert")).toContainText("经营数据暂不可用");
  await expect(page.locator(".dashboard-current-grid")).toHaveCount(0);
  fixture.fail = false;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.locator(".dashboard-current-card").first().locator("strong")).toHaveText("13 人");
  expect(fixture.unexpected).toEqual([]);
});
