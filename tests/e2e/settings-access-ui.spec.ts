import { expect, test, type Page } from "@playwright/test";
import type { AccountManagementContext, CommandCapability } from "@qintopia/contracts";
import type { PrincipalDto, TokenDto, TokenTargetDto } from "../../apps/web/src/types";
import { installDashboardUiFixture } from "../helpers/dashboard-ui-fixture";

async function accessFixture(page: Page, options: { canIssue?: boolean; emptyTargets?: boolean } = {}) {
  const base = await installDashboardUiFixture(page);
  const writes: string[] = [];
  const actions: CommandCapability[] = ["ROTATE_TOKEN", "REVOKE_TOKEN", "CREATE_ORDER", ...(options.canIssue === false ? [] : ["ISSUE_TOKEN" as const])];
  const principal: PrincipalDto = { subjectId: "ui-access-admin", displayName: "设置界面样例", credentialType: "SESSION", propertyAccess: { "ui-a": "WRITE" }, propertyCommandGrants: { "ui-a": actions }, allowedActions: { "ui-a": actions } };
  const targets: TokenTargetDto[] = options.emptyTargets ? [] : [{ subjectId: principal.subjectId, displayName: principal.displayName, accessLevel: "WRITE", commandGrants: actions }];
  const token: TokenDto = { subjectId: principal.subjectId, displayName: principal.displayName, id: "ui-synthetic-token", label: "界面样例密钥", access_ceiling: "WRITE", property_scope: "ui-a", expires_at: "2035-01-01T00:00:00.000Z", revoked_at: null, rotated_from_id: null, replaced_by_id: null, created_at: "2026-01-01T00:00:00.000Z", commandCeiling: ["CREATE_ORDER"], persistedCommandCeiling: ["CREATE_ORDER"], historicalReadCeilingPreserved: false };
  const accounts: AccountManagementContext = {
    self: { id: principal.subjectId, username: "ui-admin", displayName: principal.displayName, version: "1" }, canManageStaff: true, canDeleteMember: false,
    accounts: [{ id: "ui-staff", username: "ui-staff", displayName: "界面样例员工", version: "1", status: "ACTIVE", lastLoginAt: null, activeSessions: 0, canDelete: false }], history: []
  };
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") { writes.push(path); return route.abort("blockedbyclient"); }
    if (path === "/api/v1/me") return route.fulfill({ json: principal });
    if (path === "/api/v1/tokens") return route.fulfill({ json: { tokens: [token] } });
    if (path === "/api/v1/properties/ui-a/token-targets") return route.fulfill({ json: { subjects: targets } });
    if (path === "/api/v1/account-management") return route.fulfill({ json: accounts });
    return route.fallback();
  });
  return { base, writes };
}

type ClipboardFixture = Window & { clipboardMode: "success" | "failure" | "pending"; clipboardCalls: number; releaseClipboard: (success: boolean) => void };

test("settings access shows copy success, failure and pending without submitting or accepting late results", async ({ page }) => {
  const fixture = await accessFixture(page);
  await page.addInitScript(() => {
    const state = window as unknown as ClipboardFixture;
    state.clipboardMode = "failure";
    state.clipboardCalls = 0;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {
      state.clipboardCalls += 1;
      if (state.clipboardMode === "failure") throw new DOMException("Synthetic clipboard rejection", "NotAllowedError");
      if (state.clipboardMode === "pending") return new Promise<void>((resolve, reject) => { state.releaseClipboard = success => success ? resolve() : reject(new Error("Synthetic delayed failure")); });
    } } });
  });
  await page.goto("/settings/tokens");
  await page.getByRole("button", { name: "签发密钥", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await expect(dialog.locator(".token-copy-feedback")).toHaveText("复制失败，请手动保存");
  await expect(dialog.locator(".token-copy-feedback")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "下一步", exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as ClipboardFixture).clipboardMode = "success"; });
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
  await expect(dialog.locator(".token-copy-feedback")).toHaveText("已复制");
  await page.evaluate(() => { (window as unknown as ClipboardFixture).clipboardMode = "pending"; });
  await dialog.getByRole("button", { name: "已复制", exact: true }).click();
  const pendingButton = dialog.getByRole("button", { name: "复制中…", exact: true });
  await expect(pendingButton).toBeDisabled();
  await expect(dialog.locator(".token-copy-feedback")).toHaveCount(0);
  await pendingButton.dispatchEvent("click");
  expect(await page.evaluate(() => (window as unknown as ClipboardFixture).clipboardCalls)).toBe(3);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => { (window as unknown as ClipboardFixture).clipboardMode = "success"; });
  await page.getByRole("button", { name: "签发密钥", exact: true }).click();
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await expect(dialog.locator(".token-copy-feedback")).toHaveText("已复制");
  await page.evaluate(async () => { (window as unknown as ClipboardFixture).releaseClipboard(false); await new Promise(resolve => setTimeout(resolve, 0)); });
  await expect(dialog.locator(".token-copy-feedback")).toHaveText("已复制");
  await expect(dialog.getByRole("checkbox", { name: /我已安全保存/ })).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "下一步", exact: true })).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.base.unexpected).toEqual([]);
});

test("settings access account menu toggles, handles keyboard and keeps internal scrolling open", async ({ page }) => {
  const fixture = await accessFixture(page);
  await page.goto("/settings/accounts");
  const trigger = page.getByRole("button", { name: "界面样例员工的更多操作", exact: true });
  const menu = page.getByRole("menu", { name: "界面样例员工的更多操作", exact: true });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "删除误建账号", exact: true })).toBeDisabled();
  await expect(menu).toContainText("仅可删除本页新建且从未使用的误建账号");
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "撤销全部会话", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "停用账号", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(menu).toBeVisible();
  // Constrain the popup, without making unrelated fixed app navigation cover
  // the trigger. The assertion below still requires genuine inner scrolling.
  await menu.evaluate(element => { element.style.maxHeight = "120px"; });
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await menu.evaluate(element => { element.scrollTop = 50; element.dispatchEvent(new Event("scroll")); });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await trigger.click();
  await menu.getByRole("menuitem", { name: "停用账号", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "停用账号", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("操作原因")).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.base.unexpected).toEqual([]);
});

test("settings access keeps phone token actions visible and permission details folded", async ({ page }, testInfo) => {
  const fixture = await accessFixture(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/settings/tokens");
  const row = page.getByRole("row").filter({ hasText: "界面样例密钥" });
  await expect(row.getByText("设置界面样例", { exact: true })).toBeVisible();
  await expect(row.getByText("有效", { exact: true })).toBeVisible();
  await expect(row.locator(".token-expiry-cell")).toContainText("2035");
  await expect(row.getByRole("button", { name: /^轮换访问密钥 / })).toBeVisible();
  await expect(row.getByRole("button", { name: /^撤销访问密钥 / })).toBeVisible();
  await expect(row.locator("details")).toHaveJSProperty("open", false);
  await expect(row.getByText("创建住宿订单", { exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await row.locator("details > summary").click();
  await expect(row.getByText("创建住宿订单", { exact: true })).toBeVisible();
  await expect(row.getByText("初始签发", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings-access-phone.png"), fullPage: true });
  expect(fixture.writes).toEqual([]);
  expect(fixture.base.unexpected).toEqual([]);
});

for (const reason of ["permission", "targets"] as const) {
  test(`settings access explains unavailable issuance for ${reason}`, async ({ page }) => {
    const fixture = await accessFixture(page, reason === "permission" ? { canIssue: false } : { emptyTargets: true });
    await page.goto("/settings/tokens");
    const message = reason === "permission" ? "当前账号没有签发访问密钥的权限。" : "暂无可使用的账号，当前无法签发访问密钥。";
    await expect(page.getByRole("button", { name: "签发密钥", exact: true })).toBeDisabled();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
    expect(fixture.base.unexpected).toEqual([]);
  });
}
