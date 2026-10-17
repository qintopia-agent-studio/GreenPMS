import { expect, test } from "@playwright/test";

const propertyId = "prop_qintopia_demo";
test("member overview keeps desktop list and default detail together, and mobile returns to search", async ({ page }, testInfo) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  const loaded = page.waitForResponse(response => response.url().includes("/api/v1/members?") && new URL(response.url()).searchParams.get("directory") === "true");
  await page.goto("/members");
  const response = await loaded;
  expect(response.ok()).toBe(true);
  const data = await response.json();
  await expect(page.locator(".member-list-sort")).toContainText("最近加入本店");
  for (const summary of data.members) {
    const item = page.getByTestId("member-list-item").filter({ has: page.locator("strong") }).and(page.locator(`[data-member-id="${summary.member.id}"]`));
    await expect(item).toContainText(summary.member.phone);
    await expect(item.locator(".member-list-benefit")).toHaveCount(summary.directory.entitlements.length);
    for (const entitlement of summary.directory.entitlements) {
      await expect(item).toContainText(entitlement.productName);
      if (entitlement.expiresOn) await expect(item).toContainText(entitlement.expiresOn);
    }
  }
  const desktop = testInfo.project.name === "desktop";
  if (desktop) {
    await expect(page.locator(".member-detail-stack")).toBeVisible();
    await expect(page.getByTestId("member-list-item").first()).toHaveAttribute("aria-pressed", "true");
    const second = page.getByTestId("member-list-item").nth(data.members.length > 1 ? 1 : 0);
    const id = await second.getAttribute("data-member-id");
    const detailLoaded = data.members.length > 1 ? page.waitForResponse(r => r.url().includes(`/api/v1/members/${id}?`)) : undefined;
    await second.click();
    if (detailLoaded) expect((await detailLoaded).ok()).toBe(true);
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(second).toBeFocused();
    await expect(page.locator(".member-detail-stack")).toBeVisible();
    await expect(page.getByRole("button", { name: "返回会员列表", exact: true })).toBeHidden();
  } else await expect(page.locator(".member-detail-stack")).toHaveCount(0);
  await expect(page.getByTestId("member-list-item")).toHaveCount(data.members.length);
  const geometry = await page.evaluate(() => ({
    page: document.querySelector(".members-page")!.getBoundingClientRect().width,
    list: document.querySelector(".member-directory-list")!.getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > window.innerWidth
  }));
  if (desktop) {
    expect(geometry.list).toBeGreaterThan(geometry.page * 0.35);
    expect(geometry.list).toBeLessThan(geometry.page * 0.42);
  }
  else expect(geometry.list).toBeGreaterThan(geometry.page * 0.95);
  expect(geometry.overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("member-directory.png"), fullPage: true });
  const profile = await (await page.request.get(`/api/v1/members/member_demo_profile?propertyId=${propertyId}`)).json();
  await page.getByTestId("member-search-query").fill(profile.member.phone);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByTestId("member-list-item")).toHaveCount(1);
  await page.getByTestId("member-list-item").click();
  await expect(page.getByTestId("arrange-member-stay")).toBeVisible();
  if (desktop) await expect(page.locator(".member-directory-list")).toBeVisible();
  else await expect(page.locator(".member-directory-list")).toBeHidden();
  if (!desktop) await expect(page.getByTestId("member-search-query")).toBeHidden();
  await expect(page.getByTestId("member-balance-summary")).toBeVisible();
  if (!desktop) await page.getByRole("button", { name: "返回会员列表", exact: true }).click();
  await expect(page.getByTestId("member-search-query")).toHaveValue(profile.member.phone);
  await expect(page.getByTestId("member-list-item")).toBeFocused();
  await page.getByTestId("member-list-item").press("Enter");
  await expect(page.getByTestId("arrange-member-stay")).toBeVisible();
  await page.getByTestId("arrange-member-stay").click();
  await expect(page).toHaveURL(/memberId=member_demo_profile/);
  await expect(page.getByRole("button", { name: "返回会员档案", exact: true })).toBeVisible();
  await expect(page.getByText(/正在为 .* 安排住宿/)).toBeVisible();
});

test("a failed overview is not presented as an empty member list", async ({ page }) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "operator", password: "demo-pass-2026" } });
  await page.route("**/api/v1/members?**", route => route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR", message: "目录暂不可用" } }));
  await page.goto("/members");
  await expect(page.getByRole("button", { name: "重新载入", exact: true })).toBeVisible();
  await expect(page.getByText("未找到会员", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/v1/members?**");
  await page.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(page.getByTestId("member-list-item").first()).toBeVisible();
});


test("desktop search selects its first result and clears detail for no matches", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop split layout");
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  await page.goto("/members");
  await expect(page.locator(".member-detail-stack")).toBeVisible();
  const { member } = await (await page.request.get(`/api/v1/members/member_demo_profile?propertyId=${propertyId}`)).json();
  await page.getByTestId("member-search-query").fill(member.phone);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByTestId("member-list-item")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: member.full_name, exact: true })).toBeVisible();
  await expect(page.getByTestId("member-list-item")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: member.full_name, exact: true })).toBeVisible();
  await page.getByTestId("member-search-query").fill("no-such-member-split-layout");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("未找到会员", { exact: true })).toBeVisible();
  await expect(page.locator(".member-detail-stack")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "搜索", exact: true })).toBeFocused();
});
