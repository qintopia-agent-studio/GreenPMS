import { expect, test, type Page, type Request } from "@playwright/test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resetE2eDatabase } from "./reset-database.ts";
import type { QuickActionsAcceptanceFixture, QuickActionStayFixture } from "./setup-quick-actions-acceptance.ts";

const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
let fixture: QuickActionsAcceptanceFixture;
const orderReadRetried = new WeakSet<Page>();
const networkDiagnostics = new WeakMap<Page, object[]>();

// Each journey has an independent page; only the first writes its own C01 order.
// Keep failures local so the remaining scenarios still provide evidence.
test.describe.configure({ mode: "default" });
test.skip(({ isMobile }) => isMobile, "Desktop click popover; mobile keeps its existing order panel interaction.");

test.beforeAll(async ({}, testInfo) => {
  test.setTimeout(180_000);
  await resetE2eDatabase(databaseUrl);
  // Execute the domain-backed fixture under the same Node/tsx runtime as the
  // reset script, avoiding Playwright's CommonJS transform of dynamic DB imports.
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createDatabase } from "./packages/db/src/database.ts";
    import { populateQuickActionsAcceptance } from "./tests/e2e/setup-quick-actions-acceptance.ts";
    const url = process.env.E2E_DATABASE_URL;
    const db = createDatabase(url);
    try {
      const fixture = await populateQuickActionsAcceptance(db, new URL(url).pathname.slice(1));
      process.stdout.write(JSON.stringify(fixture));
    } finally { await db.destroy(); }
  `], {
    cwd: process.cwd(), env: { ...process.env, E2E_DATABASE_URL: databaseUrl },
    timeout: 120_000, maxBuffer: 10 * 1024 * 1024
  });
  fixture = JSON.parse(stdout) as QuickActionsAcceptanceFixture;
  const fixturePath = testInfo.outputPath("quick-actions-fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
  await testInfo.attach("quick-actions-fixture", { path: fixturePath, contentType: "application/json" });
});

test.beforeEach(async ({ page }) => {
  const records: object[] = [];
  const starts = new WeakMap<Request, number>();
  networkDiagnostics.set(page, records);
  const tracked = (url: string) => url.includes("/api/v1/");
  page.on("request", (request) => {
    if (!tracked(request.url())) return;
    starts.set(request, Date.now());
    records.push({ event: "request", url: request.url() });
  });
  page.on("response", (response) => {
    if (!tracked(response.url())) return;
    records.push({ event: "response", url: response.url(), status: response.status(), durationMs: Date.now() - (starts.get(response.request()) ?? Date.now()) });
  });
  page.on("requestfailed", (request) => {
    if (!tracked(request.url())) return;
    records.push({ event: "requestfailed", url: request.url(), failure: request.failure(), durationMs: Date.now() - (starts.get(request) ?? Date.now()) });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const networkPath = testInfo.outputPath("quick-actions-network.json");
  await writeFile(networkPath, JSON.stringify(networkDiagnostics.get(page) ?? [], null, 2));
  await testInfo.attach("quick-actions-network", { path: networkPath, contentType: "application/json" });
});

async function login(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("login-username")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(({ from, toExclusive }) => {
    sessionStorage.setItem("qintopia.room-status-view.v1:subject_demo_operator:prop_qintopia_demo", JSON.stringify({
      version: 1, propertyId: "prop_qintopia_demo", range: { arrivalDate: from, departureDate: toExclusive },
      revision: "quick-actions-acceptance", savedAt: new Date().toISOString(),
      state: {
        filters: { search: "", roomTypeCode: "ALL", salesMode: "ALL", status: "ALL", kind: "ALL", minimumCapacity: null },
        expandedRoomIds: [], roomPageIndex: 0, dateWindowStart: 0, dateWindowSize: 30, dateWindowMode: "30",
        focusedCell: null, selection: null, scrollAnchor: { unitId: null, left: 0, top: 0 }
      }
    }));
  }, fixture.dateWindow);
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })).toBeVisible({ timeout: 30_000 });
}

async function openCell(page: Page, unitCode: string, unitId: string, date: string): Promise<void> {
  const currentPopover = page.getByTestId("room-status-quick-popover");
  if (await currentPopover.isVisible()) await currentPopover.getByRole("button", { name: "关闭快捷操作", exact: true }).click();
  await page.getByLabel("搜索房间或床位", { exact: true }).fill(unitCode);
  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${date}"]`);
  await expect(cell).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
  await cell.click();
  await expect(currentPopover).toBeVisible();
}

async function openQuickOrder(page: Page, stay: QuickActionStayFixture) {
  await openCell(page, stay.unitCode, stay.unitId, stay.arrivalDate);
  const popover = page.getByTestId("room-status-quick-popover");
  const content = popover.getByRole("region", { name: "订单快捷操作", exact: true });
  const retry = popover.getByRole("button", { name: "重新载入", exact: true });
  await expect(content.or(retry)).toBeVisible({ timeout: 30_000 });
  if (await retry.isVisible()) {
    if (orderReadRetried.has(page)) throw new Error("A second order read failed; do not hide repeated failures with retries");
    orderReadRetried.add(page);
    networkDiagnostics.get(page)?.push({ event: "one-explicit-ui-read-retry", orderId: stay.orderId });
    test.info().annotations.push({ type: "read-recovery", description: `Retried the visible order read error once for ${stay.unitCode}` });
    await retry.click();
  }
  await expect(content.locator(".room-status-quick-order-heading")).toContainText(stay.nickname, { timeout: 30_000 });
  await expect(content).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  return content;
}

test("快捷收款直接填写、返回修改并确认后刷新资金摘要", async ({ page }) => {
  await login(page);
  const stay = fixture.cases.todayUnpaid;
  const quick = await openQuickOrder(page, stay);
  await expect(quick.locator(".room-status-quick-order-actions > div")).toHaveCount(4);
  await quick.getByRole("button", { name: "登记收款", exact: true }).click();
  const form = page.getByRole("dialog", { name: "登记收款", exact: true });
  await expect(form.getByTestId("fact-amount-yuan")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "订单详情", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await form.getByTestId("fact-amount-yuan").fill("100");
  await form.getByRole("combobox", { name: "收款方式", exact: true }).selectOption("BANK_TRANSFER");
  const transactionReference = `SYNTHETIC-QUICK-E2E-${stay.orderId}`;
  await form.getByTestId("transaction-reference").fill(transactionReference);
  await form.getByTestId("collection-note").fill("快捷收款验收");
  await form.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("command-return-to-edit").click();
  await expect(form.getByTestId("fact-amount-yuan")).toHaveValue("100");
  await expect(form.getByRole("combobox", { name: "收款方式", exact: true })).toHaveValue("BANK_TRANSFER");
  await expect(form.getByTestId("transaction-reference")).toHaveValue(transactionReference);
  await expect(form.getByTestId("collection-note")).toHaveValue("快捷收款验收");
  await form.getByTestId("fact-amount-yuan").fill(String(stay.contractAmountMinor / 100));
  await form.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByTestId("confirm-command")).toHaveCount(0, { timeout: 30_000 });
  await expect(form.getByRole("region", { name: "收款已登记", exact: true })).toBeVisible({ timeout: 30_000 });
  await form.getByRole("button", { name: "完成", exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/$/);
  const refreshed = await openQuickOrder(page, stay);
  await expect(refreshed.locator(".room-status-quick-order-actions").getByRole("button", { name: "查看账务", exact: true })).toBeVisible();
  await expect(refreshed.locator(".room-status-quick-order-facts").getByText("¥510.00", { exact: true })).toHaveCount(2);
  await expect(refreshed.locator(".room-status-quick-order-facts").getByText("¥0.00", { exact: true })).toHaveCount(1);
});

test("快捷日期与换房直达既有表单，今日应退直达退房核对", async ({ page }) => {
  await login(page);
  let quick = await openQuickOrder(page, fixture.cases.todayPaid);
  await expect(quick.getByRole("button", { name: "查看账务", exact: true })).toBeVisible();
  await quick.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  const reschedule = page.getByRole("dialog", { name: "调整住宿日期", exact: true });
  await expect(reschedule.getByTestId("stay-date-order-context")).toContainText(fixture.cases.todayPaid.nickname);
  await expect(reschedule.getByTestId("stay-date-arrival")).toHaveValue(fixture.cases.todayPaid.arrivalDate);
  await reschedule.getByRole("button", { name: "取消", exact: true }).click();
  quick = await openQuickOrder(page, fixture.cases.earlyCheckout);
  await expect(quick.getByRole("button", { name: "提前退房", exact: true })).toBeDisabled();
  await expect(quick).toContainText("入住当天暂不办理缩短或提前退房");
  await quick.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const departure = page.getByRole("dialog", { name: "调整退房日期", exact: true });
  await expect(departure.getByTestId("stay-date-order-context")).toContainText(fixture.cases.earlyCheckout.nickname);
  await expect(departure.getByTestId("stay-date-arrival")).toBeDisabled();
  await departure.getByRole("button", { name: "取消", exact: true }).click();
  quick = await openQuickOrder(page, fixture.cases.earlyCheckout);
  await quick.getByRole("button", { name: "换房", exact: true }).click();
  const move = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(move.getByTestId("move-unit-order-context")).toContainText(fixture.cases.earlyCheckout.nickname);
  await expect(move.getByTestId("move-unit-id")).toBeVisible();
  await move.getByRole("button", { name: "取消", exact: true }).click();
  quick = await openQuickOrder(page, fixture.cases.dueOutUnpaid);
  const checkoutRequest = page.waitForRequest((item) => item.method() === "POST"
    && new URL(item.url()).pathname.endsWith("/command-previews")
    && item.postDataJSON()?.commandType === "CHECK_OUT");
  await quick.getByRole("button", { name: "办理退房", exact: true }).click();
  const checkout = page.getByRole("dialog", { name: "办理退房", exact: true });
  await expect(checkout.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  expect((await checkoutRequest).postDataJSON().input.orderId).toBe(fixture.cases.dueOutUnpaid.orderId);
  await expect(checkout).toContainText("按计划办理退房");
  await expect(checkout.getByTestId("confirm-command")).toBeEnabled();
  await checkout.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("会员全覆盖、部分现金、升级和临时跨房型显示对应摘要与门禁", async ({ page }) => {
  await login(page);
  let quick = await openQuickOrder(page, fixture.cases.memberCovered);
  await expect(quick).toContainText("本次已核销");
  await expect(quick).toContainText("3 间夜");
  await expect(quick).toContainText("本次产品可用", { timeout: 30_000 });
  await expect(quick).toContainText("27 间夜");
  await expect(quick.getByRole("button", { name: "查看会员权益", exact: true })).toBeVisible();
  await expect(quick.locator('[aria-label="住宿资金摘要"]')).toHaveCount(0);
  quick = await openQuickOrder(page, fixture.cases.memberPartial);
  await expect(quick).toContainText("1 间夜");
  await expect(quick).toContainText("现金部分金额");
  await expect(quick.getByRole("button", { name: "登记收款", exact: true })).toBeVisible();
  quick = await openQuickOrder(page, fixture.cases.upgradedMember);
  await expect(quick).toContainText("后续会员收款在会员订单办理");
  await expect(quick.locator('[aria-label="住宿资金摘要"]')).toHaveCount(0);
  await expect(quick.getByRole("button", { name: "登记收款", exact: true })).toHaveCount(0);
  quick = await openQuickOrder(page, fixture.cases.temporaryOtherRoom);
  await expect(quick).toContainText("本次临时安排其他整房");
  await expect(quick.getByRole("button", { name: "换房", exact: true })).toHaveCount(0);
  await expect(quick.getByRole("button", { name: "调整退房日期", exact: true })).toBeDisabled();
  for (const stay of [fixture.cases.externalChannel, fixture.cases.freeStay]) {
    quick = await openQuickOrder(page, stay);
    await expect(quick.locator('[aria-label="住宿资金摘要"]')).toHaveCount(0);
    await expect(quick.getByRole("button", { name: "登记收款", exact: true })).toHaveCount(0);
  }
  quick = await openQuickOrder(page, fixture.cases.futureArrival);
  await expect(quick.getByRole("button", { name: "办理入住", exact: true })).toBeDisabled();
  await expect(quick).toContainText("尚未到计划入住日");
});

test("订单响应降为只读时快捷写入禁用而账务仍可查看", async ({ page }) => {
  await login(page);
  const stay = fixture.cases.todayPaid;
  await page.route(`**/api/v1/orders/${stay.orderId}`, async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    view.accessLevel = "READ";
    view.allowedActions = view.allowedActions.map((action: { code: string; enabled: boolean; disabledReason: string | null }) => ({
      ...action, enabled: false, disabledReason: action.disabledReason ?? "ACCESS_DENIED"
    }));
    await route.fulfill({ response, json: view });
  });
  const quick = await openQuickOrder(page, stay);
  for (const action of ["CHECK_IN", "RESCHEDULE_STAY", "MOVE_UNIT"]) {
    await expect(quick.locator(`[data-room-status-quick-action="${action}"]`)).toBeDisabled();
  }
  await expect(quick).toContainText("当前账号只有查看权限");
  await expect(quick.getByRole("button", { name: "查看账务", exact: true })).toBeEnabled();
});

test("同房多订单先选目标，迟到的甲订单响应不能覆盖乙订单或绑定甲的入住命令", async ({ page }) => {
  await login(page);
  let releaseFirstResponse: (() => void) | undefined;
  let observedFirstRequest: (() => void) | undefined;
  let completedFirstResponse: (() => void) | undefined;
  const firstRequested = new Promise<void>((resolve) => { observedFirstRequest = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstCompleted = new Promise<void>((resolve) => { completedFirstResponse = resolve; });
  const firstPattern = `**/api/v1/orders/${fixture.cases.multiOrderA.orderId}`;
  await page.route(firstPattern, async (route) => {
    const response = await route.fetch();
    observedFirstRequest?.();
    await firstReleased;
    try { await route.fulfill({ response }); } catch { /* The obsolete request may already be aborted. */ }
    finally { completedFirstResponse?.(); }
  }, { times: 1 });
  await openCell(page, "101", fixture.multiOrderRoomUnitId, fixture.businessDate);
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover.locator(".room-status-quick-orders button")).toHaveCount(2);
  await expect(popover.getByRole("region", { name: "订单快捷操作", exact: true })).toHaveCount(0);
  await popover.locator(".room-status-quick-orders button").filter({ hasText: fixture.cases.multiOrderA.nickname }).click();
  await firstRequested;
  await popover.locator(".room-status-quick-orders button").filter({ hasText: fixture.cases.multiOrderB.nickname }).click();
  const content = popover.getByRole("region", { name: "订单快捷操作", exact: true });
  await expect(content.locator(".room-status-quick-order-heading")).toContainText(fixture.cases.multiOrderB.nickname, { timeout: 30_000 });
  releaseFirstResponse?.();
  await firstCompleted;
  await expect(content.locator(".room-status-quick-order-heading")).not.toContainText(fixture.cases.multiOrderA.nickname);
  await expect(content.getByRole("button", { name: "查看账务", exact: true })).toBeVisible();
  const request = page.waitForRequest((item) => item.method() === "POST"
    && new URL(item.url()).pathname.endsWith("/command-previews")
    && item.postDataJSON()?.commandType === "CHECK_IN");
  await content.getByRole("button", { name: "办理入住", exact: true }).click();
  expect((await request).postDataJSON().input.orderId).toBe(fixture.cases.multiOrderB.orderId);
  await expect(page.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("dialog", { name: "办理入住", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
