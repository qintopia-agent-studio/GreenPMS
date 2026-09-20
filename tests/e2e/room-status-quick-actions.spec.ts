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

function fixtureCell(page: Page, stay: QuickActionStayFixture) {
  return page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.unitId}"][data-service-date="${stay.arrivalDate}"]`);
}

// Each journey has an independent page; only the first writes its own C01 order.
// Keep failures local so the remaining scenarios still provide evidence.
test.describe.configure({ mode: "default" });
test.skip(({ isMobile }) => isMobile, "Desktop hover and click; mobile keeps its existing order panel interaction.");

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
  await cell.hover();
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
  await expect(quick.getByRole("tooltip")).toHaveCount(0);
  await quick.getByRole("group", { name: "提前退房（不可用）", exact: true }).hover();
  await expect(quick.getByRole("tooltip")).toHaveText("入住当天暂不办理缩短或提前退房。");
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

test("会员全覆盖、部分现金、升级和临时跨房型显示对应摘要与门禁", async ({ page }, testInfo) => {
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
  await expect(quick).toContainText("临时跨房型：续住或再次换房需另建订单。");
  await expect(quick.getByRole("button", { name: "换房", exact: true })).toHaveCount(0);
  await expect(quick.getByRole("button", { name: "调整退房日期", exact: true })).toBeDisabled();
  await expect(quick.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("b01-compact.png") });
  for (const label of ["提前退房", "调整退房日期"]) {
    const disabledAction = quick.getByRole("group", { name: `${label}（不可用）`, exact: true });
    await disabledAction.hover();
    await expect(quick.getByRole("tooltip")).toHaveCount(1);
    await expect(quick.getByRole("tooltip")).toHaveText("入住当天暂不办理缩短或提前退房。");
    if (label === "提前退房") await page.screenshot({ path: testInfo.outputPath("b01-disabled-tooltip.png") });
    await disabledAction.click();
    await expect(page.getByRole("dialog", { name: label, exact: true })).toHaveCount(0);
    await disabledAction.press("Escape");
    await expect(quick.getByRole("tooltip")).toHaveCount(0);
    await expect(quick).toBeVisible();
  }
  await page.getByRole("button", { name: "关闭快捷操作", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(quick.getByRole("group", { name: "提前退房（不可用）", exact: true })).toBeFocused();
  await expect(quick.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(quick.getByRole("tooltip")).toHaveCount(0);
  await expect(quick).toBeVisible();
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


test("悬浮联动房间日期高亮，抽屉遮罩点击只收起并恢复原焦点", async ({ page }, testInfo) => {
  await login(page);
  const search = page.getByLabel("搜索房间或床位", { exact: true });
  await search.fill("C");
  await search.focus();
  const first = fixtureCell(page, fixture.cases.todayUnpaid);
  const second = fixtureCell(page, fixture.cases.todayPaid);
  await expect(first).toBeVisible();
  const selectedBefore = await page.locator('[data-room-status-cell="true"][aria-selected="true"]').count();
  await second.hover();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toHaveAttribute("data-trigger", "hover");
  await expect(popover.locator(".room-status-quick-order-heading")).toContainText(fixture.cases.todayPaid.nickname, { timeout: 30_000 });
  await expect(search).toBeFocused();
  await expect(page.locator('[data-room-status-cell="true"][aria-selected="true"]')).toHaveCount(selectedBefore);
  await expect(page.locator(`[data-room-status-row="${fixture.cases.todayPaid.unitId}"] .room-status-resource-cell`)).toHaveClass(/is-cell-selection-row/);
  await expect(page.locator(".room-status-date-header.is-cell-selection-column strong")).toHaveText(fixture.cases.todayPaid.arrivalDate.slice(5));
  await popover.hover();
  await page.waitForTimeout(350); // Cross the dismiss grace period while inside the portal.
  await expect(popover).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("hover-card.png") });
  await page.mouse.move(10, 10);
  await expect(popover).toBeHidden();
  await expect(search).toBeFocused();
  await expect(page.locator(".is-cell-selection-row, .is-cell-selection-column")).toHaveCount(0);

  await first.click();
  const drawer = page.getByRole("dialog", { name: "订单详情", exact: true });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(drawer.getByRole("heading", { name: `${fixture.cases.todayUnpaid.nickname}的住宿订单`, exact: true })).toBeVisible({ timeout: 30_000 });
  const secondBounds = (await second.boundingBox())!;
  await page.mouse.move(secondBounds.x + secondBounds.width / 2, secondBounds.y + secondBounds.height / 2);
  await page.waitForTimeout(350);
  await expect(popover).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("drawer-backdrop.png") });
  await page.mouse.click(secondBounds.x + secondBounds.width / 2, secondBounds.y + secondBounds.height / 2);
  await expect(drawer).toBeHidden();
  await expect(first).toBeFocused();
  await expect(second).not.toHaveClass(/is-selected/);
  await second.click();
  await expect(drawer.getByRole("heading", { name: `${fixture.cases.todayPaid.nickname}的住宿订单`, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(popover).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("click-drawer.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(second).toBeFocused();

  // A passive preview must not hide or retarget the existing selected-order entry.
  await first.press("Enter");
  await expect(popover.locator(".room-status-quick-order-heading")).toContainText(fixture.cases.todayUnpaid.nickname, { timeout: 30_000 });
  await popover.getByRole("button", { name: "关闭快捷操作", exact: true }).click();
  await second.hover();
  await expect(popover).toHaveAttribute("data-trigger", "hover");
  const reopen = page.getByRole("button", { name: "打开订单详情", exact: true });
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(drawer.getByRole("heading", { name: `${fixture.cases.todayUnpaid.nickname}的住宿订单`, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(popover).toBeHidden();
});

test("未预加载的订单单击即开抽屉，读取完成后展示同一目标", async ({ page }) => {
  await login(page);
  const stay = fixture.cases.todayPaid;
  await page.getByLabel("搜索房间或床位", { exact: true }).fill(stay.unitCode);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/v1/orders/${stay.orderId}`, async (route) => {
    await gate;
    await route.continue();
  });
  const drawer = page.getByRole("dialog", { name: "订单详情", exact: true });
  try {
    await fixtureCell(page, stay).click();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("room-status-quick-popover")).toBeHidden();
    await expect(drawer.getByRole("heading", { name: `${stay.nickname}的住宿订单`, exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(drawer.getByRole("heading", { name: `${stay.nickname}的住宿订单`, exact: true })).toBeVisible({ timeout: 30_000 });
});

test("空房抽屉遮罩与悬浮定位保留拖选、键盘入口", async ({ page }) => {
  await login(page);
  await page.getByLabel("搜索房间或床位", { exact: true }).fill(fixture.emptyUnitCode);
  const from = page.locator(`[data-room-status-cell="true"][data-service-date="${fixture.businessDate}"]`);
  await expect(from).toBeVisible();
  const targetDate = new Date(`${fixture.businessDate}T00:00:00Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + 2);
  const end = page.locator(`[data-room-status-cell="true"][data-service-date="${targetDate.toISOString().slice(0, 10)}"]`);
  await from.hover();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  const a = (await from.boundingBox())!, b = (await end.boundingBox())!;
  await expect(page.locator(".room-status-resource-cell.is-cell-selection-row")).toContainText(fixture.emptyUnitCode);
  await expect(page.locator(".room-status-date-header.is-cell-selection-column strong")).toHaveText(fixture.businessDate.slice(5));
  await from.click();
  const context = page.getByRole("dialog", { name: "选中对象上下文", exact: true });
  await expect(context).toBeVisible();
  expect(await context.evaluate((element) => element.matches(":modal"))).toBe(true);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(context).toBeHidden();
  await expect(from).toBeFocused();
  await expect(from).toHaveClass(/is-selected/);
  await expect(end).not.toHaveClass(/is-selected/);
  await end.hover();
  await expect(popover).toBeVisible();
  await expect(page.locator(".room-status-date-header.is-cell-selection-column strong")).toHaveText(targetDate.toISOString().slice(5, 10));
  await page.mouse.move(10, 10);
  await expect(popover).toBeHidden();
  await expect(page.locator(".room-status-date-header.is-cell-selection-column strong")).toHaveText(fixture.businessDate.slice(5));
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await expect(popover).toBeHidden();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(popover).toHaveAttribute("data-trigger", "explicit");
  await expect(popover).toHaveAttribute("data-selection-kind", "range");
  await expect(page.locator("dialog.modal-drawer")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(end).toBeFocused();
  await from.focus();
  await from.press("Enter");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-trigger", "explicit");
  await popover.getByRole("button", { name: "预订", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "创建订单", exact: true })).toBeVisible();
});

test("同房多订单点击先在抽屉选目标，触屏点击保留快捷框", async ({ page, browser }) => {
  await login(page);
  await page.getByLabel("搜索房间或床位", { exact: true }).fill("101");
  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.multiOrderRoomUnitId}"][data-service-date="${fixture.businessDate}"]`);
  await cell.click();
  const chooser = page.getByRole("region", { name: "选择订单", exact: true });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button").filter({ hasText: fixture.cases.multiOrderB.nickname }).click();
  await expect(page.getByRole("dialog", { name: "订单详情", exact: true })).toContainText(fixture.cases.multiOrderB.nickname, { timeout: 30_000 });

  const touchContext = await browser.newContext({ hasTouch: true, baseURL: String(test.info().project.use.baseURL) });
  try {
    const touchPage = await touchContext.newPage();
    await login(touchPage);
    await touchPage.getByLabel("搜索房间或床位", { exact: true }).fill(fixture.cases.todayPaid.unitCode);
    await fixtureCell(touchPage, fixture.cases.todayPaid).tap();
    await expect(touchPage.getByTestId("room-status-quick-popover")).toHaveAttribute("data-trigger", "explicit");
    await expect(touchPage.getByRole("dialog", { name: "订单详情", exact: true })).toBeHidden();
    await touchPage.getByRole("button", { name: "关闭快捷操作", exact: true }).tap();
    await touchPage.getByLabel("搜索房间或床位", { exact: true }).fill(fixture.cases.temporaryOtherRoom.unitCode);
    await fixtureCell(touchPage, fixture.cases.temporaryOtherRoom).tap();
    const quick = touchPage.getByRole("region", { name: "订单快捷操作", exact: true });
    await expect(quick.locator(".room-status-quick-order-heading")).toContainText(fixture.cases.temporaryOtherRoom.nickname);
    await quick.getByRole("group", { name: "提前退房（不可用）", exact: true }).tap();
    await expect(quick.getByRole("tooltip")).toHaveText("入住当天暂不办理缩短或提前退房。");
    await expect(touchPage.getByRole("dialog", { name: "提前退房", exact: true })).toHaveCount(0);
  } finally { await touchContext.close(); }
});
