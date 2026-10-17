import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Stage7AcceptanceFixture } from "./setup-stage7-acceptance";
import { openQuickPopoverOrderDrawer } from "./quick-popover-helpers";
const propertyId = "prop_qintopia_demo";
let fixture: Stage7AcceptanceFixture;
// Run domain fixture creation under tsx; Playwright's CommonJS loader cannot
// execute the catalog's dynamic ESM imports used by the quote service.
test.beforeAll(async ({}, workerInfo) => {
  if (workerInfo.project.name === "mobile") return;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import fixtureModule from './tests/e2e/setup-stage7-acceptance.ts';
    const fixture = await fixtureModule.prepareStage7Acceptance(process.env.E2E_DATABASE_URL ?? 'postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e', {reset: false, dayOffset: 1460});
    process.stdout.write(JSON.stringify(fixture));
  `], { cwd: process.cwd(), env: process.env, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  fixture = JSON.parse(stdout);
});

function roomStatusResponse(page: Page) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${propertyId}/room-status`
      && response.status() === 200;
  });
}

function orderResponse(page: Page, orderId: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/orders/${orderId}`
      && response.status() === 200;
  }, { timeout: 15_000 });
}

function roomCell(page: Page, unitId: string, serviceDate: string): Locator {
  return page.locator(
    `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
  );
}

function orderContext(page: Page, _orderId?: string): Locator {
  return page.locator(".room-status-order-context:visible").last();
}

function orderDrawer(page: Page): Locator {
  return page.getByRole("dialog", { name: "订单详情", exact: true });
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  const loaded = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  await loaded;
  await expect(page.getByRole("grid")).toBeVisible();
}

async function showFixtureRange(page: Page): Promise<void> {
  const loaded = roomStatusResponse(page);
  await page.getByTestId("arrival-date").fill(fixture.dates.arrivalDate);
  await loaded;
  await expect(page.getByTestId("room-status-board-range"))
    .toHaveAttribute("data-range-arrival", fixture.dates.arrivalDate);
}

async function selectOccupiedCell(
  page: Page,
  unitId: string,
  serviceDate: string,
  orderId: string
): Promise<Locator> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const cell = roomCell(page, unitId, serviceDate);
  await cell.focus();
  await expect(cell).toBeFocused();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", unitId);
  await expect(popover).toHaveAttribute("data-selection-kind", "day");
  await openQuickPopoverOrderDrawer(popover);
  const context = orderContext(page, orderId);
  await expect(context).toBeVisible();
  await expect(context.getByRole("heading", { name: "完整住宿", exact: true }))
    .toBeVisible({ timeout: 15_000 });
  await expect(context).not.toContainText(orderId);
  return context;
}

async function closeOrderContext(context: Locator): Promise<void> {
  await context.getByRole("button", { name: "关闭订单详情", exact: true }).click();
  await expect(context).toBeHidden();
}

for (const width of [1280, 1920]) {
  test(`navigation restores the selected room without opening order details at ${width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop navigation coverage");
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await showFixtureRange(page);
    const stay = fixture.wholeRoom;
    const date = fixture.dates.arrivalDate;
    const context = await selectOccupiedCell(page, stay.roomId, date, stay.orderId);
    await closeOrderContext(context);

    await page.getByRole("link", { name: "工作台", exact: true }).click();
    await expect(page).toHaveURL(/\/today$/);
    const orderLoaded = orderResponse(page, stay.orderId);
    await page.getByRole("link", { name: "房态", exact: true }).click();
    await orderLoaded;
    // The reopen control appears only after the pending order load has settled.
    await expect(page.getByRole("button", { name: "打开订单详情", exact: true })).toBeVisible();
    await expect(orderContext(page)).toBeHidden();
    await expect(orderDrawer(page)).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("return-without-drawer.png") });
    await expect(page.getByTestId("arrival-date")).toHaveValue(date);
    await expect(roomCell(page, stay.roomId, date)).toHaveClass(/is-stay-selected/);

    await page.getByRole("button", { name: "打开订单详情", exact: true }).click();
    await expect(orderContext(page)).toBeVisible();
    // Reloading with an open order must also restore only the browsing position.
    const reloadedOrder = orderResponse(page, stay.orderId);
    await page.reload();
    await reloadedOrder;
    await expect(page.getByRole("button", { name: "打开订单详情", exact: true })).toBeVisible();
    await expect(orderContext(page)).toBeHidden();

    await page.getByRole("button", { name: "打开订单详情", exact: true }).click();
    await expect(orderContext(page)).toBeVisible();
    await page.getByRole("button", { name: "查看完整订单", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orders/${stay.orderId}$`));
    await page.getByRole("link", { name: "返回房态", exact: true }).click();
    await expect(orderContext(page)).toBeVisible();
    await expect(roomCell(page, stay.roomId, date)).toHaveClass(/is-stay-selected/);
  });
}

