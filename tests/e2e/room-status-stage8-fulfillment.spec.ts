import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { RoomStatusBoardDto, RoomStatusUnitDto } from "@qintopia/contracts";
import { prepareStage8Acceptance, type Stage8AcceptanceFixture, type Stage8StayFixture } from "./setup-stage8-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const forbiddenProtocol = /Preview|Confirm|Receipt|Command|RESERVED|CHECKED_IN|IN_HOUSE|CHECKED_OUT|cleaning_[a-z0-9_]+|order_[a-z0-9_]+/i;
let fixture: Stage8AcceptanceFixture;

test.describe.configure({ mode: "serial" });

function isDesktop(testInfo: TestInfo) {
  return testInfo.project.name === "desktop";
}

function isMobile(testInfo: TestInfo) {
  return testInfo.project.name === "mobile";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(({ arrivalDate, departureDate }) => {
    window.sessionStorage.setItem(
      "qintopia.room-status-view.v1:subject_demo_operator:prop_qintopia_demo",
      JSON.stringify({
        version: 1,
        propertyId: "prop_qintopia_demo",
        range: { arrivalDate, departureDate },
        revision: "stage8-acceptance-range",
        savedAt: new Date().toISOString(),
        state: {
          filters: { search: "", roomTypeCode: "ALL", salesMode: "ALL", status: "ALL", kind: "ALL", minimumCapacity: null },
          expandedRoomIds: [],
          roomPageIndex: 0,
          dateWindowStart: 0,
          dateWindowSize: 14,
          dateWindowMode: "AUTO",
          focusedCell: null,
          selection: null,
          scrollAnchor: { unitId: null, left: 0, top: 0 }
        }
      })
    );
  }, { arrivalDate: fixture.arrivalDate, departureDate: addDays(fixture.departureDate, 1) });
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible({ timeout: 30_000 });
}

async function fulfill(page: Page, action: "入住" | "退房", options: {
  loseCommittedResponse?: boolean;
  lateRecorded?: { plannedDepartureDate: string; businessDate: string };
  operatorNote?: string;
} = {}) {
  await page.getByRole("button", { name: action, exact: true }).click();
  await confirmFulfillmentDialog(page, action, options);
}

async function confirmFulfillmentDialog(page: Page, action: "入住" | "退房", options: {
  loseCommittedResponse?: boolean;
  lateRecorded?: { plannedDepartureDate: string; businessDate: string };
  operatorNote?: string;
  beforeConfirm?: (dialog: Locator) => Promise<void>;
} = {}) {
  const dialog = page.getByRole("dialog", { name: `办理${action}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText(action === "入住" ? "已预订" : "在住");
  if (options.lateRecorded) {
    await expect(dialog).toContainText("迟录退房");
    await expect(dialog).toContainText(options.lateRecorded.plannedDepartureDate);
    await expect(dialog).toContainText(options.lateRecorded.businessDate);
    await expect(dialog).toContainText("订单金额");
    await expect(dialog).toContainText("保持不变");
  }
  await expect(dialog).not.toContainText(forbiddenProtocol);
  const reasonNote = dialog.getByTestId("reason-note");
  await expect(reasonNote).toBeVisible();
  await expect(dialog.getByText("办理备注（选填）", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("command-return-to-edit")).toHaveCount(0);
  if (options.operatorNote !== undefined) await reasonNote.fill(options.operatorNote);
  else await expect(reasonNote).toHaveValue("");
  await options.beforeConfirm?.(dialog);
  if (options.loseCommittedResponse) {
    await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "REQUEST_FAILED", message: "committed response lost", retryable: true })
      });
    }, { times: 1 });
  }
  await dialog.getByRole("button", { name: `确认办理${action}`, exact: true }).click();
  if (options.loseCommittedResponse) {
    await expect(dialog.getByText("刚才的操作结果需要查询", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(forbiddenProtocol);
    await dialog.getByRole("button", { name: "查询操作结果", exact: true }).click();
  }
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("command-result-notice")).toContainText(`办理${action}已完成，住宿状态已刷新`);
  await expect(page.getByTestId("command-result-notice")).not.toContainText(forbiddenProtocol);
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

async function openOrder(page: Page, stay: Stage8StayFixture) {
  await page.goto(`/orders/${encodeURIComponent(stay.orderId)}`);
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".order-unit")).toContainText(stay.unitCode);
}

async function verifyMemberProfile(page: Page, stay: Stage8StayFixture, coverageCount: number) {
  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "会员档案", exact: true })).toBeVisible();
  await page.getByTestId("member-search-query").fill(stay.nickname);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const memberItem = page.getByTestId("member-list-item").filter({ hasText: stay.nickname });
  await expect(memberItem).toHaveCount(1);
  await memberItem.click();
  await expect(page.locator(".member-profile-panel").getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible();
  await expect(page.getByTestId("member-balance-summary")).toContainText(`${30 - coverageCount} 间夜`);
  await expect(page.getByTestId("member-ledger-entry-consume")).toHaveCount(coverageCount);
}

function roomStatusResponse(page: Page, arrivalDate: string, departureDate: string, search?: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname.endsWith("/room-status")
      && url.searchParams.get("arrivalDate") === arrivalDate
      && url.searchParams.get("departureDate") === departureDate
      && (search === undefined || url.searchParams.get("search") === search)
      && response.status() === 200;
  });
}

async function showRange(page: Page, arrivalDate: string, departureDate: string) {
  await page.getByTestId("departure-date").fill(departureDate);
  const loaded = roomStatusResponse(page, arrivalDate, departureDate);
  await page.getByTestId("arrival-date").fill(arrivalDate);
  await loaded;
  await expect(page.getByTestId("arrival-date")).toHaveValue(arrivalDate);
  await expect(page.getByTestId("departure-date")).toHaveValue(departureDate);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".room-status-toolbar")).toContainText("投影完整");
}

async function showFixtureRange(page: Page) {
  await showRange(page, fixture.arrivalDate, addDays(fixture.departureDate, 1));
}

async function filterRoomStatus(page: Page, search: string, arrivalDate: string, departureDate: string) {
  const loaded = roomStatusResponse(page, arrivalDate, departureDate, search);
  await page.getByLabel("搜索房间或床位", { exact: true }).fill(search);
  await loaded;
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".room-status-toolbar")).toContainText("投影完整");
}

async function refreshCurrentRoomStatus(page: Page, arrivalDate: string, departureDate: string, search?: string) {
  const loaded = roomStatusResponse(page, arrivalDate, departureDate, search);
  await page.getByRole("button", { name: "刷新房态", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await loaded;
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0);
  await expect(page.locator(".room-status-toolbar")).toContainText("投影完整");
}

async function expectRoomStatusRoot(page: Page) {
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
}

function fulfillmentNote(result: Locator): Locator {
  return result.getByText("办理备注", { exact: true }).locator("xpath=following-sibling::dd");
}

function removeWriteActions(unit: RoomStatusUnitDto): void {
  unit.allowedActions = [];
  for (const interval of unit.intervals) interval.allowedActions = [];
  for (const child of unit.children) removeWriteActions(child);
}

function readOnlyRoomStatus(board: RoomStatusBoardDto): RoomStatusBoardDto {
  board.accessLevel = "READ";
  for (const task of board.operationalTasks) task.allowedActions = [];
  for (const room of board.rooms) removeWriteActions(room);
  return board;
}

async function openMobileOrderContext(page: Page, stay: Stage8StayFixture) {
  const row = page.locator(".room-status-mobile-occupancies li").filter({ hasText: stay.nickname }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "打开订单上下文", exact: true }).click();
  const context = page.locator(".room-status-order-context").filter({ hasText: stay.nickname });
  await expect(context).toBeVisible({ timeout: 30_000 });
  return context;
}

test.beforeAll(async ({}, workerInfo) => {
  fixture = await prepareStage8Acceptance(e2eDatabaseUrl, {
    reset: false,
    scenario: workerInfo.project.name === "mobile" ? "mobile" : "desktop"
  });
});

test("阶段 8 4.1 从房态页内入住后仍定位并选中完整 Stay", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 8 room-status restoration coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await showFixtureRange(page);
  await filterRoomStatus(page, fixture.restoration.unitCode, fixture.arrivalDate, addDays(fixture.departureDate, 1));
  await refreshCurrentRoomStatus(page, fixture.arrivalDate, addDays(fixture.departureDate, 1), fixture.restoration.unitCode);

  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.restoration.unitId}"][data-service-date="${fixture.arrivalDate}"]`);
  const selectedOrderResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/v1/orders/${fixture.restoration.orderId}`
      && response.status() === 200
  ), { timeout: 30_000 });
  await cell.dblclick();
  await selectedOrderResponse;
  const context = page.locator(".room-status-order-context").filter({ hasText: fixture.restoration.nickname });
  await expect(context).toBeVisible({ timeout: 30_000 });
  const checkInButton = context.getByRole("button", { name: "办理入住", exact: true });
  await expect(checkInButton).toBeVisible();
  await expect(checkInButton).toBeEnabled();

  await checkInButton.click();
  const blockedDialog = page.getByRole("dialog", { name: "办理入住" });
  await expect(blockedDialog.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  const roomStatusPattern = "**/api/v1/properties/*/room-status?*";
  await page.route(roomStatusPattern, async (route) => {
    const response = await route.fetch();
    const responseBody = readOnlyRoomStatus(await response.json() as RoomStatusBoardDto);
    await route.fulfill({ response, json: responseBody });
  });
  await roomStatusResponse(page, fixture.arrivalDate, addDays(fixture.departureDate, 1), fixture.restoration.unitCode);
  await expect(blockedDialog.getByRole("button", { name: "确认办理入住", exact: true })).toBeDisabled();
  await expectRoomStatusRoot(page);
  await blockedDialog.getByRole("button", { name: "取消", exact: true }).click();
  await context.getByRole("button", { name: "关闭订单上下文", exact: true }).click();
  await page.unroute(roomStatusPattern);
  await refreshCurrentRoomStatus(page, fixture.arrivalDate, addDays(fixture.departureDate, 1), fixture.restoration.unitCode);
  const reopenedOrderResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/v1/orders/${fixture.restoration.orderId}`
      && response.status() === 200
  ), { timeout: 30_000 });
  await cell.dblclick();
  await reopenedOrderResponse;
  await expect(context).toBeVisible();
  await expect(checkInButton).toBeEnabled();

  let delayedPoll = false;
  await page.route(roomStatusPattern, async (route) => {
    if (!delayedPoll) {
      delayedPoll = true;
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    }
    await route.continue();
  });
  await checkInButton.click();
  await expectRoomStatusRoot(page);
  await confirmFulfillmentDialog(page, "入住", {
    beforeConfirm: async (dialog) => {
      const staleNotice = page.locator(".room-status-stale-notice");
      await expect(staleNotice).toBeVisible({ timeout: 15_000 });
      await expect(checkInButton).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "确认办理入住", exact: true })).toBeEnabled();
    }
  });
  await page.unroute(roomStatusPattern);
  await expect(context).toContainText("在住");
  for (const date of [fixture.arrivalDate, addDays(fixture.arrivalDate, 1)]) {
    await expect(page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.restoration.unitId}"][data-service-date="${date}"]`)).toHaveClass(/is-stay-selected/);
  }
  await context.getByRole("button", { name: "查看完整订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${fixture.restoration.orderId}$`));
  const checkInResult = page.getByTestId("check-in-result");
  await expect(fulfillmentNote(checkInResult)).toHaveText("按计划办理入住");
});

test("阶段 8 4.1 普通、会员和免费住宿只在计划日期完成中文入住与普通退房", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 8 full fulfillment coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  await openOrder(page, fixture.futureCheckIn);
  await expect(page.getByText("已预订", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("check-in")).toHaveCount(0);
  const futureNotice = page.locator(".action-band").getByTestId("fulfillment-date-notice");
  await expect(futureNotice).toBeVisible();
  await expect(futureNotice).toContainText("暂不能办理入住");
  await expect(futureNotice).toContainText("不能提前办理入住");

  await openOrder(page, fixture.overdueCheckIn);
  await expect(page.getByText("已预订", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("check-in")).toHaveCount(0);
  const overdueArrivalNotice = page.locator(".action-band").getByTestId("fulfillment-date-notice");
  await expect(overdueArrivalNotice).toBeVisible();
  await expect(overdueArrivalNotice).toContainText("暂不能办理入住");
  await expect(overdueArrivalNotice).toContainText("不能按普通入住补办");

  for (const stay of [fixture.normal, fixture.member, fixture.free]) {
    await openOrder(page, stay);
    await expect(page.getByText("已预订", { exact: true }).first()).toBeVisible();
    await fulfill(page, "入住", { loseCommittedResponse: stay.orderId === fixture.normal.orderId });
    await expect(page.getByText("在住", { exact: true }).first()).toBeVisible();
    if (stay.orderId === fixture.member.orderId) {
      const coverage = page.getByRole("region", { name: "会员覆盖" });
      await expect(coverage.getByText("已核销", { exact: true })).toHaveCount(fixture.member.coverageCount);
      await expect(coverage.getByText("已冻结", { exact: true })).toHaveCount(0);
      await verifyMemberProfile(page, stay, fixture.member.coverageCount);
      await openOrder(page, stay);
    }
    await expect(page.getByTestId("check-out")).toHaveCount(0);
    const earlyDepartureNotice = page.locator(".action-band").getByTestId("fulfillment-date-notice");
    await expect(earlyDepartureNotice).toBeVisible();
    await expect(earlyDepartureNotice).toContainText("暂不能办理退房");
    await expect(earlyDepartureNotice).toContainText("当前版本暂不办理提前退房");
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  const checkoutRange = {
    arrivalDate: addDays(fixture.businessDate, -2),
    departureDate: addDays(fixture.businessDate, 1)
  };
  await showRange(page, checkoutRange.arrivalDate, checkoutRange.departureDate);
  await filterRoomStatus(page, fixture.plannedCheckout.unitCode, checkoutRange.arrivalDate, checkoutRange.departureDate);
  await refreshCurrentRoomStatus(page, checkoutRange.arrivalDate, checkoutRange.departureDate, fixture.plannedCheckout.unitCode);
  const plannedCheckoutCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.plannedCheckout.unitId}"][data-service-date="${addDays(fixture.businessDate, -1)}"]`);
  const plannedCheckoutOrder = page.waitForResponse((response) => (
    response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/v1/orders/${fixture.plannedCheckout.orderId}`
      && response.status() === 200
  ));
  await plannedCheckoutCell.dblclick();
  await plannedCheckoutOrder;
  const plannedCheckoutContext = page.locator(".room-status-order-context").filter({ hasText: fixture.plannedCheckout.nickname });
  await expect(plannedCheckoutContext).toBeVisible();
  const plannedCheckoutButton = plannedCheckoutContext.getByRole("button", { name: "办理退房", exact: true });
  await expect(plannedCheckoutButton).toBeEnabled();
  await plannedCheckoutButton.click();
  await expectRoomStatusRoot(page);
  await confirmFulfillmentDialog(page, "退房");

  await openOrder(page, fixture.plannedCheckout);
  await expect(page.getByText("已退房", { exact: true }).first()).toBeVisible();
  const plannedCheckoutResult = page.getByTestId("check-out-result");
  await expect(fulfillmentNote(plannedCheckoutResult)).toHaveText("按计划办理退房");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrollY = await page.evaluate(() => window.scrollY);
  expect(scrollY).toBeGreaterThan(0);
  const refreshed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname.endsWith(`/orders/${fixture.plannedCheckout.orderId}`)
      && response.status() === 200;
  });
  await refreshed;
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  }));
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(page.getByTestId("order-cleaning-tasks")).toHaveCount(0);
  await expect(page.getByText("待清洁", { exact: true })).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  await showFixtureRange(page);
  await filterRoomStatus(page, fixture.overdueCheckout.unitCode, fixture.arrivalDate, addDays(fixture.departureDate, 1));
  const overdueAvailableCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.overdueCheckout.unitId}"][data-service-date="${fixture.businessDate}"]`);
  await expect(overdueAvailableCell).toContainText("可售");
  await expect(overdueAvailableCell).not.toContainText(new RegExp(`在住|${fixture.overdueCheckout.nickname}`));

  await page.goto("/today");
  await page.getByRole("tab", { name: /异常/ }).click();
  const overdueQueueRow = page.locator(".queue-row").filter({ hasText: fixture.overdueCheckout.nickname });
  await expect(overdueQueueRow).toBeVisible();
  await overdueQueueRow.getByRole("link", { name: /查看订单/ }).click();
  await expect(page.getByRole("heading", { name: fixture.overdueCheckout.nickname, exact: true })).toBeVisible();
  await expect(page.getByText("在住", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("check-out")).toBeVisible();
  const overdueAmountsBefore = await page.getByTestId("order-amounts").locator("dd").allTextContents();
  await fulfill(page, "退房", {
    lateRecorded: {
      plannedDepartureDate: addDays(fixture.businessDate, -1),
      businessDate: fixture.businessDate
    }
  });
  await expect(page.getByText("已退房", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("order-amounts").locator("dd")).toHaveText(overdueAmountsBefore);
  const lateResult = page.getByTestId("check-out-result");
  await expect(lateResult).toContainText("迟录退房");
  await expect(lateResult).toContainText(addDays(fixture.businessDate, -1));
  await expect(lateResult).toContainText(fixture.businessDate);
  await expect(lateResult).toContainText("办理备注");
  await expect(lateResult).toContainText("迟录计划退房");
  await expect(page.getByTestId("order-cleaning-tasks")).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  await showFixtureRange(page);
  await filterRoomStatus(page, fixture.plannedCheckout.unitCode, fixture.arrivalDate, addDays(fixture.departureDate, 1));
  const releasedCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.plannedCheckout.unitId}"][data-service-date="${fixture.businessDate}"]`);
  await expect(releasedCell).toContainText("可售");
  await expect(releasedCell).not.toContainText(new RegExp(`在住|${fixture.plannedCheckout.nickname}`));
  await filterRoomStatus(page, fixture.overdueCheckout.unitCode, fixture.arrivalDate, addDays(fixture.departureDate, 1));
  const overdueReleasedCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.overdueCheckout.unitId}"][data-service-date="${fixture.businessDate}"]`);
  await expect(overdueReleasedCell).toContainText("可售");
  await expect(overdueReleasedCell).not.toContainText(new RegExp(`在住|${fixture.overdueCheckout.nickname}`));
});

test("阶段 8 4.1 保留的前一日待清洁历史不影响次日房态和订单详情", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop disabled cleaning workflow compatibility coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await openOrder(page, fixture.legacyCleaning);
  await expect(page.getByText("已退房", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("order-cleaning-tasks")).toHaveCount(0);
  await expect(page.getByText("待清洁", { exact: true })).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  await showFixtureRange(page);
  expect(fixture.arrivalDate).toBe(addDays(fixture.legacyCleaning.serviceDate, 1));
  const nextDayCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.legacyCleaning.unitId}"][data-service-date="${fixture.arrivalDate}"]`);
  await expect(nextDayCell).toContainText("可售");
  await expect(nextDayCell).not.toContainText("待清洁");
  await expect(page.locator(".room-status-interval-cleaning")).toHaveCount(0);
  await expect(page.getByText("待清洁", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "完成清洁", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(fixture.legacyCleaning.cleaningTaskId);
});

test("阶段 8 4.1 日期门禁原因归位且逾期在住不延长当前房态", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 8 date-gate and overdue-grid coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  for (const gated of [
    { stay: fixture.futureCheckIn, action: "入住", reason: "不能提前办理入住" },
    { stay: fixture.overdueCheckIn, action: "入住", reason: "不能按普通入住补办" },
    { stay: fixture.earlyCheckoutGate, action: "退房", reason: "当前版本暂不办理提前退房" }
  ] as const) {
    await openOrder(page, gated.stay);
    await expect(page.getByTestId(gated.action === "入住" ? "check-in" : "check-out")).toHaveCount(0);
    const notice = page.locator(".action-band").getByTestId("fulfillment-date-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`暂不能办理${gated.action}`);
    await expect(notice).toContainText(gated.reason);
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  await showFixtureRange(page);
  const overdueCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.overdueGrid.unitId}"][data-service-date="${fixture.businessDate}"]`);
  await expect(overdueCell).toContainText("可售");
  await expect(overdueCell).not.toContainText(new RegExp(`在住|${fixture.overdueGrid.nickname}`));

  await page.goto("/today");
  await page.getByRole("tab", { name: /异常/ }).click();
  const overdueQueueRow = page.locator(".queue-row").filter({ hasText: fixture.overdueGrid.nickname });
  await expect(overdueQueueRow).toBeVisible();
  await overdueQueueRow.getByRole("link", { name: /查看订单/ }).click();
  await expect(page.getByRole("heading", { name: fixture.overdueGrid.nickname, exact: true })).toBeVisible();
  await fulfill(page, "退房", {
    lateRecorded: {
      plannedDepartureDate: addDays(fixture.businessDate, -1),
      businessDate: fixture.businessDate
    }
  });

  await page.goto("/today");
  await page.getByRole("tab", { name: /异常/ }).click();
  await expect(page.locator(".queue-row").filter({ hasText: fixture.overdueGrid.nickname })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  await showFixtureRange(page);
  await expect(page.locator(`[data-room-status-cell="true"][data-unit-id="${fixture.overdueGrid.unitId}"][data-service-date="${fixture.businessDate}"]`)).toContainText("可售");
});

test("阶段 8 4.1 手机端履约使用相同中文核对和结果", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 8 fulfillment coverage");
  await login(page);

  await openOrder(page, fixture.futureCheckIn);
  const futureNotice = page.locator(".action-band").getByTestId("fulfillment-date-notice");
  await expect(futureNotice).toBeVisible();
  await expect(futureNotice).toContainText("暂不能办理入住");

  await page.goto("/");
  await showFixtureRange(page);
  const freeContext = await openMobileOrderContext(page, fixture.free);
  await freeContext.getByRole("button", { name: "办理入住", exact: true }).click();
  await expectRoomStatusRoot(page);
  await confirmFulfillmentDialog(page, "入住");
  await expect(freeContext).toContainText("在住");
  const freeContextDialog = page.getByRole("dialog", { name: "订单上下文" });
  await freeContextDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(freeContextDialog).toBeHidden();

  const checkoutContext = await openMobileOrderContext(page, fixture.plannedCheckout);
  await checkoutContext.getByRole("button", { name: "办理退房", exact: true }).click();
  await expectRoomStatusRoot(page);
  await confirmFulfillmentDialog(page, "退房");
  await expect(page.getByRole("dialog", { name: "订单上下文" })).toBeHidden();

  await expect(page.locator(".room-status-interval-cleaning")).toHaveCount(0);
  await expect(page.getByText("待清洁", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "完成清洁", exact: true })).toHaveCount(0);
});
