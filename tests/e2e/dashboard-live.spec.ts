import { expect, test, type Page, type Response } from "@playwright/test";
import type { DashboardDetailsResponse, DashboardResponse } from "@qintopia/contracts";

const isSummary = (response: Response) => /\/api\/v1\/properties\/[^/]+\/dashboard\?/.test(response.url()) && response.request().method() === "GET";
const isDetails = (response: Response) => /\/dashboard\/details\?/.test(response.url());

async function login(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("login-submit")).toBeEnabled();
  await page.getByLabel("账号", { exact: true }).fill("operator");
  await page.getByLabel("密码", { exact: true }).fill("demo-pass-2026");
  const response = page.waitForResponse(isSummary);
  await page.getByTestId("login-submit").click();
  const summary = await response;
  expect(summary.status()).toBe(200);
  expect(summary.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  return await summary.json() as DashboardResponse;
}

async function readAfter(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse(isSummary);
  await action();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  return await result.json() as DashboardResponse;
}

function previousDate(date: string, days: number) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return result.toISOString().slice(0, 10);
}

test("real login, server filters, fact drilldown and logout use the preserved API", async ({ page }, info) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()) && !request.url().includes("/auth/")) writes.push(`${request.method()} ${request.url()}`);
  });
  const initial = await login(page);
  await expect(page.locator(".dashboard-kpi").nth(1).locator("strong")).toHaveText(initial.history.paidUnitNights.toLocaleString("zh-CN"));
  const current = await page.locator(".dashboard-current-grid").innerText();
  const week = await readAfter(page, () => page.getByRole("button", { name: "近7天", exact: true }).click());
  expect(week.range).toEqual({ from: previousDate(initial.businessDate, 7), to: previousDate(initial.businessDate, 1) });
  expect(week.current).toEqual(initial.current);
  expect(await page.locator(".dashboard-current-grid").innerText()).toBe(current);
  if (initial.filters.buildings.length) {
    const filtered = await readAfter(page, () => page.getByLabel("楼栋", { exact: true }).selectOption(initial.filters.buildings[0]!));
    expect(filtered.breakdown.every(row => row.building === initial.filters.buildings[0])).toBe(true);
    expect(filtered.money).toEqual(week.money);
    expect(filtered.current).toEqual(week.current);
    await page.getByLabel("楼栋", { exact: true }).selectOption("");
    await expect(page.getByLabel("楼栋", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  }
  const future = await readAfter(page, () => page.getByLabel("未来天数").selectOption("30"));
  expect(future.future).toHaveLength(30);
  expect(future.future[0]!.date).toBe(initial.businessDate);
  await expect(page.locator(".dashboard-future-day")).toHaveCount(30);
  await readAfter(page, () => page.getByRole("button", { name: "近30天", exact: true }).click());
  const detailsResponse = page.waitForResponse(isDetails);
  await page.getByRole("button", { name: /收退款登记净额/ }).click();
  const detailsHttp = await detailsResponse;
  expect(detailsHttp.status()).toBe(200);
  const details = await detailsHttp.json() as DashboardDetailsResponse;
  const region = page.getByRole("region", { name: "收退款登记 · 组成明细" });
  await expect(region.getByRole("heading")).toBeFocused();
  await expect(region).toContainText(`${details.total} 条`);
  await expect(region.locator("tbody tr")).toHaveCount(Math.max(details.items.length, 1));
  if (details.items.length) {
    await expect(region.locator("tbody tr").first()).toContainText(details.items[0]!.label);
    const order = details.items.find(item => item.orderId);
    if (order) {
      const link = region.locator(`a[href="/orders/${encodeURIComponent(order.orderId!)}"]`).first();
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/orders/${encodeURIComponent(order.orderId!)}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
    }
  } else {
    await expect(region).toContainText("该范围内没有符合条件的记录");
  }
  await info.attach("live-dashboard-facts", { body: JSON.stringify({ propertyId: initial.propertyId, range: initial.range, detailsCount: details.total, businessWrites: writes.length }), contentType: "application/json" });
  await page.locator('button[aria-label="退出登录"]:visible').click();
  await expect(page.getByTestId("login-submit")).toBeVisible();
  expect((await page.request.get(`/api/v1/properties/${initial.propertyId}/dashboard`)).status()).toBe(401);
  await page.goBack();
  await expect(page.getByTestId("dashboard-page")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("keyboard drilldown returns focus and real charts reflow with bundled Chinese fonts", async ({ page, browserName }, info) => {
  await login(page);
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  const trigger = page.getByRole("button", { name: /付费住宿单元夜/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const region = page.getByRole("region", { name: "付费住宿单元夜 · 组成明细" });
  await expect(region.getByRole("heading")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(region.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(region).toHaveCount(0);
  await expect(trigger).toBeFocused();
  for (const width of info.project.name === "mobile" ? [390, 320] : [934, 1440]) {
    await page.setViewportSize({ width, height: 1526 });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/agent-browser/dashboard-live-${width}.png`, fullPage: true });
  }
  if (info.project.name === "desktop") {
    // Browser zoom reduces the CSS viewport; CSS zoom alone does not update media queries.
    await page.setViewportSize({ width: 467, height: 763 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await readAfter(page, () => page.getByRole("button", { name: "近7天", exact: true }).click());
    await expect(page.getByRole("button", { name: "近7天", exact: true })).toBeInViewport();
    await page.screenshot({ path: "/tmp/agent-browser/dashboard-live-200-percent-equivalent.png", fullPage: true });
  }
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
});

test("real 30-second deadline preserves old facts, retries and clears a revoked session", async ({ page }) => {
  test.setTimeout(75_000);
  const initial = await login(page);
  const current = await page.locator(".dashboard-current-grid").innerText();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pattern = "**/api/v1/properties/*/dashboard?**";
  await page.route(pattern, async route => { started(); await gate; await route.abort().catch(() => {}); });
  try {
    const startedAt = Date.now();
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await held;
    await expect(page.getByRole("alert")).toContainText("数据已过期，刷新失败", { timeout: 40_000 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
    expect(await page.locator(".dashboard-current-grid").innerText()).toBe(current);
    await expect(page.locator(".dashboard-kpi").nth(1).locator("strong")).toHaveText(initial.history.paidUnitNights.toLocaleString("zh-CN"));
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await readAfter(page, () => page.getByRole("button", { name: "重新读取", exact: true }).click());
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await page.request.post("/api/v1/auth/logout")).status()).toBe(204);
  const rejected = page.waitForResponse(isSummary);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByTestId("session-expired")).toBeVisible();
  await expect(page.getByTestId("dashboard-page")).toHaveCount(0);
});
