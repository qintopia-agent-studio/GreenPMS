/** Read-only acceptance against an explicitly selected local demo server.
 * Never resets fixtures or submits membership/payment commands.
 */
import { expect, test } from "@playwright/test";

test.skip(process.env.MEMBER_HEADER_E2E !== "true", "Explicit local member header acceptance opt-in required");

test.beforeEach(async ({ page }, info) => {
  const baseURL = info.project.use.baseURL;
  if (!baseURL || !["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname)) {
    throw new Error("Local demo acceptance only");
  }
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: "admin", password: "demo-pass-2026" }
  });
  expect(login.ok()).toBe(true);
  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "会员档案", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
});

test("member actions stay together with refresh at the far right on desktop and mobile", async ({ page }, info) => {
  const widths = info.project.name === "mobile" ? [360, 393] : [900, 1024, 1280];
  const header = page.locator(".members-page > header");
  const actions = header.getByRole("group", { name: "会员档案操作", exact: true });
  const create = actions.getByRole("button", { name: "新建会员", exact: true });
  const refresh = actions.getByRole("button", { name: "刷新", exact: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(create).toBeVisible();
    await expect(refresh).toBeVisible();
    const headerBox = await header.boundingBox();
    const createBox = await create.boundingBox();
    const refreshBox = await refresh.boundingBox();
    if (!headerBox || !createBox || !refreshBox) throw new Error("Member header geometry unavailable");
    expect(Math.abs(createBox.y - refreshBox.y)).toBeLessThanOrEqual(1);
    expect(refreshBox.x - createBox.x - createBox.width).toBeGreaterThanOrEqual(7);
    expect(refreshBox.x - createBox.x - createBox.width).toBeLessThanOrEqual(9);
    expect(Math.abs(refreshBox.x + refreshBox.width - headerBox.x - headerBox.width)).toBeLessThanOrEqual(1);
    expect(refreshBox.height).toBeGreaterThanOrEqual(info.project.name === "mobile" ? 44 : 40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await header.screenshot({ path: info.outputPath(`member-header-${width}.png`) });
  }
});

test("both local refresh and browser reload preserve the applied member search", async ({ page }) => {
  const query = "未匹配会员-刷新验收";
  await page.getByTestId("member-search-query").fill(query);
  await page.getByRole("search", { name: "搜索会员", exact: true }).getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  const url = page.url();
  expect(new URL(url).searchParams.get("q")).toBe(query);
  await page.evaluate(() => { document.documentElement.dataset.memberRefreshProbe = "same-document"; });
  const response = page.waitForResponse((result) => {
    const requested = new URL(result.url());
    return requested.pathname === "/api/v1/members" && requested.searchParams.get("query") === query;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => document.documentElement.dataset.memberRefreshProbe)).toBe("same-document");
  await expect(page.getByTestId("member-search-query")).toHaveValue(query);
  await page.reload();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  expect(page.url()).toBe(url);
  await expect(page.getByTestId("member-search-query")).toHaveValue(query);
});
