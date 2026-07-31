import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { RoomStatusBoardDto } from "@qintopia/contracts";
import { prepareU2Acceptance, type U2AcceptanceFixture } from "./setup-u2-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const fixtureDayOffset = 7;
let fixture: U2AcceptanceFixture;

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop" || process.env.ROOM_STATUS_E2E_PROJECT === "desktop";
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile" || process.env.ROOM_STATUS_E2E_PROJECT === "mobile";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatChineseDate(value: string): string {
  const [, , month = "", day = ""] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? [];
  return `${Number(month)}月${Number(day)}日`;
}

function roomStatusResponse(page: Page, expectedRange?: { arrivalDate: string; departureDate: string }) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${propertyId}/room-status`
      && (!expectedRange || (url.searchParams.get("arrivalDate") === expectedRange.arrivalDate
        && url.searchParams.get("departureDate") === expectedRange.departureDate))
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
  return page.locator(`[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`);
}

async function login(page: Page): Promise<RoomStatusBoardDto> {
  await page.goto(process.env.ROOM_STATUS_E2E_BASE_URL ?? "/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(fixture.operator.username);
  await page.getByTestId("login-password").fill(fixture.operator.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  const response = await responsePromise;
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible();
  return response.json() as Promise<RoomStatusBoardDto>;
}

async function showRange(page: Page, nights = 20, expectDesktopBoard = true): Promise<void> {
  const departureDate = addDays(fixture.dates.arrivalDate, nights);
  const mobileRangeToggle = page.getByTestId("mobile-room-status-range-toggle");
  if (await mobileRangeToggle.isVisible()) await mobileRangeToggle.click();
  await page.getByTestId("departure-date").fill(departureDate);
  const arrivalResponse = roomStatusResponse(page, { arrivalDate: fixture.dates.arrivalDate, departureDate });
  await page.getByTestId("arrival-date").fill(fixture.dates.arrivalDate);
  await arrivalResponse;
  if (expectDesktopBoard) {
    await expect(page.getByTestId("room-status-board-range"))
      .toHaveAttribute("data-range-arrival", fixture.dates.arrivalDate);
  }
  const occupancyToggle = page.getByTestId("mobile-room-status-occupancies-toggle");
  if (await occupancyToggle.isVisible() && await occupancyToggle.getAttribute("aria-expanded") === "false") {
    await occupancyToggle.click();
  }
}

async function refreshCurrentRange(page: Page): Promise<void> {
  const range = {
    arrivalDate: await page.getByTestId("arrival-date").inputValue(),
    departureDate: await page.getByTestId("departure-date").inputValue()
  };
  const refreshed = roomStatusResponse(page, range);
  await page.getByRole("button", { name: "刷新房态", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await refreshed;
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0);
  await expect(page.locator(".room-status-toolbar")).toContainText("投影完整");
}

async function openWholeRoomPopover(page: Page): Promise<{ trigger: Locator; popover: Locator }> {
  const trigger = roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate);
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", fixture.wholeRoom.roomId);
  await expect(popover).toHaveAttribute("data-selection-kind", "day");
  return { trigger, popover };
}

async function expectDayPopover(popover: Locator, unitId: string): Promise<void> {
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", unitId);
  await expect(popover).toHaveAttribute("data-selection-kind", "day");
}

async function selectQuickPopoverOrder(popover: Locator, nickname: string): Promise<void> {
  const orderOption = popover.locator(".room-status-quick-orders button").filter({ hasText: nickname });
  await expect(orderOption).toHaveCount(1);
  await orderOption.click();
}

async function dragRoomStatusRange(page: Page, unitId: string, startDate: string, endDate: string): Promise<void> {
  const start = roomCell(page, unitId, startDate);
  const end = roomCell(page, unitId, endDate);
  await start.scrollIntoViewIfNeeded();
  await end.scrollIntoViewIfNeeded();
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  expect(startBox).not.toBeNull();
  expect(endBox).not.toBeNull();
  await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + endBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", unitId);
  await expect(popover).toHaveAttribute("data-selection-kind", "range");
}

test.beforeAll(async ({}, workerInfo) => {
  fixture = await prepareU2Acceptance(e2eDatabaseUrl, {
    reset: false,
    dayOffset: fixtureDayOffset
      + (workerInfo.project.name === "mobile" ? 10 : 0)
      + workerInfo.workerIndex * 20
  });
});

test("U2 desktop empty cell popover stays in view and Escape restores the exact cell and both scroll axes", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 quick-popover coverage");
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await showRange(page);
  await page.getByTestId("date-window-mode-21").click();
  await expect(page.getByTestId("date-window-mode-21")).toHaveAttribute("aria-pressed", "true");

  const targetDate = addDays(fixture.dates.arrivalDate, 10);
  const target = page.locator(`.room-status-day-available[data-room-status-cell="true"][data-service-date="${targetDate}"]`).first();
  const upperTarget = roomCell(page, fixture.stage6.emptyCreationRoomId, targetDate);
  const scrollport = page.locator(".room-status-grid-scroll");
  await scrollport.evaluate((element) => {
    element.scrollLeft = Math.min(element.scrollWidth - element.clientWidth, 180);
    element.scrollTop = 0;
  });
  await target.scrollIntoViewIfNeeded();
  const targetUnitId = await target.getAttribute("data-unit-id");
  const targetAccessibleName = await target.getAttribute("aria-label");
  expect(targetUnitId).toBeTruthy();
  expect(targetAccessibleName).toBeTruthy();
  const targetUnitLabel = targetAccessibleName!.split("，")[0]!;
  await target.focus();
  const before = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  });

  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  const viewDrawer = page.locator("dialog.room-status-view-drawer");
  const writeDrawer = page.locator("dialog.room-status-write-drawer");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", targetUnitId!);
  await expect(popover).toHaveAttribute("data-selection-kind", "day");
  await expect(popover.locator("header strong")).toHaveText(targetUnitLabel);
  await expect(viewDrawer).toBeHidden();
  await expect(writeDrawer).toBeHidden();
  await expect(popover.getByRole("button", { name: "创建住宿", exact: true })).toBeVisible();
  await expect(popover.getByRole("button", { name: "维修锁房", exact: true })).toBeVisible();
  await expect(popover.getByRole("button", { name: "查看房态记录", exact: true })).toBeVisible();
  await expect(popover).not.toContainText(/清洁|房务/);

  const geometry = await popover.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const rowElement = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    const title = element.querySelector<HTMLElement>("header strong");
    const close = element.querySelector<HTMLElement>("header .room-status-icon-button");
    if (!rowElement || !title || !close) throw new Error("快捷操作框缺少房源行、标题或关闭按钮");
    const row = rowElement.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      popoverWidth: box.width,
      rowTop: row.top,
      rowBottom: row.bottom,
      titleFits: title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight,
      titleEndsBeforeClose: titleBox.right <= closeBox.left,
      width: window.innerWidth,
      height: window.innerHeight
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(7);
  expect(geometry.top).toBeGreaterThanOrEqual(7);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width - 7);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height - 7);
  expect(geometry.popoverWidth).toBeLessThanOrEqual(280);
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.rowBottom + 7);
  expect(geometry.titleFits).toBe(true);
  expect(geometry.titleEndsBeforeClose).toBe(true);

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(target).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  })).toEqual(before);

  await page.setViewportSize({ width: 1280, height: 720 });
  await upperTarget.scrollIntoViewIfNeeded();
  await upperTarget.evaluate((element) => {
    const grid = element.closest<HTMLElement>(".room-status-grid-scroll");
    const row = element.closest<HTMLElement>("[data-room-status-row]");
    if (!grid || !row) throw new Error("房态格缺少网格或房源行");
    grid.scrollTop += row.getBoundingClientRect().bottom - grid.getBoundingClientRect().bottom + 8;
  });
  await upperTarget.focus();
  await page.keyboard.press("Enter");
  await expectDayPopover(popover, fixture.stage6.emptyCreationRoomId);
  const upperGeometry = await popover.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const rowElement = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    if (!rowElement) throw new Error("快捷操作框缺少房源行");
    return { bottom: box.bottom, rowTop: rowElement.getBoundingClientRect().top };
  });
  expect(upperGeometry.bottom).toBeLessThanOrEqual(upperGeometry.rowTop - 7);
  await popover.getByRole("button", { name: "维修锁房", exact: true }).click();
  await expect(writeDrawer).toBeVisible();
  await expect(writeDrawer.getByLabel("开始日期", { exact: true })).toHaveValue(targetDate);
  await expect(writeDrawer.getByLabel("结束日期", { exact: true })).toHaveValue(addDays(targetDate, 1));
  await writeDrawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(writeDrawer).toBeHidden();
});

test("U2 desktop order popover opens an overlay drawer without shrinking the board and restores focus", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 drawer coverage");
  test.setTimeout(120_000);
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    if (page.url() === "about:blank") {
      await login(page);
      await showRange(page);
    }
    const boardWidth = await page.locator(".room-status-grid-section").evaluate((element) => element.getBoundingClientRect().width);
    const { trigger, popover } = await openWholeRoomPopover(page);
    await expect(popover.locator(".room-status-quick-orders button")).toHaveCount(1);
    await expect(popover.getByRole("button", { name: "查看房态记录", exact: true })).toBeVisible();
    const selectedOrder = orderResponse(page, fixture.wholeRoom.orderId);
    await selectQuickPopoverOrder(popover, fixture.wholeRoom.nicknames[0]!);
    await selectedOrder;

    const drawer = page.locator("dialog.modal-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".modal-header button")).toBeFocused();
    const context = drawer.locator(".room-status-order-context");
    await expect(context.getByRole("heading", { name: "小川的住宿订单", exact: true })).toBeVisible();
    await expect(context.getByRole("heading", { name: "原始预订安排", exact: true })).toBeVisible();
    await expect(context.getByRole("heading", { name: "当前住宿安排", exact: true })).toBeVisible();
    await expect(context.getByRole("heading", { name: "入住与退房结果", exact: true })).toBeVisible();
    await expect(context.getByRole("heading", { name: "住宿安排变更历史", exact: true })).toBeVisible();
    await expect(context).not.toContainText(/order_|INITIAL|Segment|Amendment|payload|Fact ID|Receipt ID|Command ID|Correlation ID|Claim|Revision|渠道合同价/);
    expect(await page.locator(".room-status-grid-section").evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(boardWidth, 1);

    const drawerGeometry = await drawer.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, width: box.width, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
    });
    expect(drawerGeometry.top).toBeCloseTo(0, 0);
    expect(drawerGeometry.right).toBeCloseTo(drawerGeometry.viewportWidth, 0);
    expect(drawerGeometry.bottom).toBeCloseTo(drawerGeometry.viewportHeight, 0);
    expect(drawerGeometry.width).toBeGreaterThanOrEqual(420);
    expect(drawerGeometry.width).toBeLessThanOrEqual(480);

    const correctionAction = context.getByRole("button", { name: "更正资料", exact: true }).first();
    await expect(correctionAction).toBeEnabled();
    const polledOrder = orderResponse(page, fixture.wholeRoom.orderId);
    await polledOrder;
    await expect(correctionAction).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});

test("U2 quick popover repositions after room-row or page geometry changes without a viewport event", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 dynamic-placement coverage");
  await page.setViewportSize({ width: 1366, height: 900 });
  await login(page);
  await showRange(page);
  await page.getByTestId("date-window-mode-21").click();

  const targetDate = addDays(fixture.dates.arrivalDate, 10);
  const target = page.locator(`.room-status-day-available[data-room-status-cell="true"][data-service-date="${targetDate}"]`).first();
  await target.scrollIntoViewIfNeeded();
  const targetUnitId = await target.getAttribute("data-unit-id");
  expect(targetUnitId).toBeTruthy();
  await target.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expectDayPopover(popover, targetUnitId!);
  const originalRowHeight = await popover.evaluate((element) => {
    const row = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    if (!row) throw new Error("快捷操作框缺少房源行");
    const popoverBox = element.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (popoverBox.top < rowBox.bottom + 7) throw new Error("测试房源行下方没有足够的初始空间");
    const original = row.style.height;
    row.style.height = `${rowBox.height + 220}px`;
    return original;
  });

  await expect.poll(() => popover.evaluate((element) => {
    const row = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    if (!row) throw new Error("快捷操作框缺少房源行");
    const popoverBox = element.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return popoverBox.top >= rowBox.bottom + 7 || popoverBox.bottom <= rowBox.top - 7;
  })).toBe(true);
  await popover.evaluate((element, height) => {
    const row = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    if (row) row.style.height = height;
  }, originalRowHeight);

  await popover.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".room-status-workspace");
    if (!workspace) throw new Error("快捷操作框缺少房态工作区");
    const notice = document.createElement("div");
    notice.dataset.u2LayoutShift = "true";
    notice.style.height = "100px";
    workspace.before(notice);
  });
  await expect.poll(() => popover.evaluate((element) => {
    const row = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    if (!row) throw new Error("快捷操作框缺少房源行");
    const popoverBox = element.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return popoverBox.top >= rowBox.bottom + 7 || popoverBox.bottom <= rowBox.top - 7;
  })).toBe(true);
  await page.locator("[data-u2-layout-shift=true]").evaluate((element) => element.remove());
});

test("U2 quick popover contains a legal 200-character unbroken occupant label", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 long-label coverage");
  await page.setViewportSize({ width: 1366, height: 900 });
  await login(page);
  await showRange(page);

  const { popover } = await openWholeRoomPopover(page);
  const longLabel = "U".repeat(200);
  await popover.locator(".room-status-quick-orders strong").evaluate((element, value) => {
    element.textContent = value;
  }, longLabel);
  await expect(popover.locator(".room-status-quick-orders strong")).toHaveText(longLabel);
  const geometry = await popover.evaluate((element) => {
    const button = element.querySelector<HTMLElement>(".room-status-quick-orders button");
    const label = element.querySelector<HTMLElement>(".room-status-quick-orders strong");
    if (!button || !label) throw new Error("快捷操作框缺少订单按钮或住客名称");
    return {
      popoverWidth: element.getBoundingClientRect().width,
      popoverFits: element.scrollWidth <= element.clientWidth,
      buttonFits: button.scrollWidth <= button.clientWidth,
      labelFits: label.scrollWidth <= label.clientWidth
    };
  });
  expect(geometry).toEqual({ popoverWidth: 280, popoverFits: true, buttonFits: true, labelFits: true });
});

test("U2 selecting a new room-status cell invalidates the old order drawer before opening the quick popover", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 stale-drawer coverage");
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page);
  await showRange(page);
  const selectedOrder = orderResponse(page, fixture.wholeRoom.orderId);
  const { popover } = await openWholeRoomPopover(page);
  await selectQuickPopoverOrder(popover, fixture.wholeRoom.nicknames[0]!);
  await selectedOrder;
  const drawer = page.locator("dialog.modal-drawer");
  await expect(drawer).toBeVisible();

  const other = roomCell(page, fixture.stage6.emptyCreationRoomId, fixture.dates.arrivalDate);
  await other.focus();
  await page.keyboard.press("Enter");
  const layeredPopover = page.getByTestId("room-status-quick-popover");
  await expectDayPopover(layeredPopover, fixture.stage6.emptyCreationRoomId);
  await expect(drawer).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(layeredPopover).toBeHidden();
  await expect(drawer).toBeHidden();
  await expect(other).toBeFocused();
});

test("U2 a delayed response for an invalidated order cannot reopen or overwrite the new room-status selection", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 stale-order-response coverage");
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page);
  await showRange(page);

  let releaseOldOrderResponse: (() => void) | undefined;
  const oldOrderResponseReleased = new Promise<void>((resolve) => {
    releaseOldOrderResponse = resolve;
  });
  let settleOldOrderRoute: (() => void) | undefined;
  let rejectOldOrderRoute: ((error: unknown) => void) | undefined;
  const oldOrderRouteSettled = new Promise<void>((resolve, reject) => {
    settleOldOrderRoute = resolve;
    rejectOldOrderRoute = reject;
  });
  await page.route(`**/api/v1/orders/${fixture.wholeRoom.orderId}`, async (route) => {
    await oldOrderResponseReleased;
    try {
      await route.continue();
      settleOldOrderRoute?.();
    } catch (error) {
      if (error instanceof Error && error.message.includes("Route is already handled")) {
        settleOldOrderRoute?.();
        return;
      }
      rejectOldOrderRoute?.(error);
    }
  });

  const oldOrderRequestSettled = new Promise<"response" | "failed">((resolve) => {
    const matchesOldOrderRequest = (method: string, rawUrl: string) => {
      const url = new URL(rawUrl);
      return method === "GET"
        && url.pathname === `/api/v1/orders/${fixture.wholeRoom.orderId}`;
    };
    const cleanup = () => {
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    };
    const onResponse = (response: import("@playwright/test").Response) => {
      const url = new URL(response.url());
      if (!matchesOldOrderRequest(response.request().method(), url.toString()) || response.status() !== 200) return;
      cleanup();
      resolve("response");
    };
    const onRequestFailed = (request: import("@playwright/test").Request) => {
      if (!matchesOldOrderRequest(request.method(), request.url())) return;
      cleanup();
      resolve("failed");
    };
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);
  });

  const { popover } = await openWholeRoomPopover(page);
  await selectQuickPopoverOrder(popover, fixture.wholeRoom.nicknames[0]!);
  const drawer = page.locator("dialog.room-status-view-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("正在载入权威订单上下文");

  const other = roomCell(page, fixture.stage6.emptyCreationRoomId, fixture.dates.arrivalDate);
  await other.click();
  const replacementPopover = page.getByTestId("room-status-quick-popover");
  await expectDayPopover(replacementPopover, fixture.stage6.emptyCreationRoomId);
  await expect(drawer).toBeHidden();

  releaseOldOrderResponse?.();
  await Promise.all([oldOrderRequestSettled, oldOrderRouteSettled]);
  await page.unroute(`**/api/v1/orders/${fixture.wholeRoom.orderId}`);
  await expect(drawer).toBeHidden();
  await expect(replacementPopover).toBeVisible();
  await expect(replacementPopover).toHaveAttribute("data-unit-id", fixture.stage6.emptyCreationRoomId);
  await expect(other).toHaveClass(/is-selected/);
});

test("U2 desktop parent room lists each exact order and an outside click keeps the new focus", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 parent-order coverage");
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page);
  await showRange(page);

  const parent = roomCell(page, fixture.splitBed.roomId, fixture.dates.arrivalDate);
  await parent.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expectDayPopover(popover, fixture.splitBed.roomId);
  await expect(popover.locator(".room-status-quick-orders button")).toHaveCount(2);
  await expect(popover).toContainText("山峰");
  await expect(popover).toContainText("小满");
  await expect(popover).not.toContainText(/order_|订单 order/);

  await page.keyboard.press("Escape");
  await expect(parent).toBeFocused();
  await page.keyboard.press("Enter");
  const dateMode = page.getByTestId("date-window-mode-7");
  await dateMode.click();
  await expect(popover).toBeHidden();
  await expect(dateMode).toBeFocused();
});

test("U2 replaces a stale drag range with the clicked cell or exact Stay", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 mutually-exclusive selection coverage");
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page);
  await showRange(page);
  await page.getByTestId("date-window-mode-21").click();
  await expect(page.getByTestId("date-window-mode-21")).toHaveAttribute("aria-pressed", "true");

  const emptyRoomId = fixture.stage6.emptyCreationRoomId;
  const emptyTargetDate = addDays(fixture.dates.arrivalDate, 9);
  const staleStartDate = addDays(fixture.dates.arrivalDate, 10);
  const staleEndDate = addDays(staleStartDate, 1);
  const staleStart = roomCell(page, emptyRoomId, staleStartDate);
  const staleEnd = roomCell(page, emptyRoomId, staleEndDate);
  const selectionDrawer = page.locator("dialog.room-status-write-drawer");
  const popover = page.getByTestId("room-status-quick-popover");

  await dragRoomStatusRange(page, emptyRoomId, staleStartDate, staleEndDate);
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-selection-kind", "range");
  await expect(selectionDrawer).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(staleStart).toHaveClass(/is-selected/);
  await expect(staleEnd).toHaveClass(/is-selected/);

  const emptyTarget = roomCell(page, emptyRoomId, emptyTargetDate);
  await emptyTarget.click();
  await expectDayPopover(popover, emptyRoomId);
  await expect(staleStart).not.toHaveClass(/is-selected/);
  await expect(staleEnd).not.toHaveClass(/is-selected/);
  await expect(emptyTarget).toHaveClass(/is-selected/);
  await expect(page.locator(".room-status-day-cell.is-selected")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(emptyTarget).toHaveClass(/is-selected/);

  await dragRoomStatusRange(page, emptyRoomId, staleStartDate, staleEndDate);
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await refreshCurrentRange(page);
  const uniqueCell = roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate);
  await uniqueCell.focus();
  await page.keyboard.press("Enter");
  await expectDayPopover(popover, fixture.wholeRoom.roomId);
  await expect(popover.locator(".room-status-quick-orders button")).toHaveCount(1);
  await expect(staleStart).not.toHaveClass(/is-selected/);
  await expect(staleEnd).not.toHaveClass(/is-selected/);
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    await expect(roomCell(page, fixture.wholeRoom.roomId, addDays(fixture.dates.arrivalDate, dayOffset)))
      .toHaveClass(/is-stay-selected/);
  }
  const wholeRoomOrder = orderResponse(page, fixture.wholeRoom.orderId);
  await selectQuickPopoverOrder(popover, fixture.wholeRoom.nicknames[0]!);
  await wholeRoomOrder;
  const uniqueOrderDrawer = page.locator("dialog.room-status-view-drawer");
  await expect(uniqueOrderDrawer).toBeVisible();
  await expect(staleStart).not.toHaveClass(/is-selected/);
  await expect(staleEnd).not.toHaveClass(/is-selected/);
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    await expect(roomCell(page, fixture.wholeRoom.roomId, addDays(fixture.dates.arrivalDate, dayOffset)))
      .toHaveClass(/is-stay-selected/);
  }
  const wholeRoomSelectedCount = await page.locator(".room-status-day-cell.is-stay-selected").count();
  expect(wholeRoomSelectedCount).toBeGreaterThan(1);
  await uniqueOrderDrawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(uniqueOrderDrawer).toBeHidden();
  await expect(roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate)).toHaveClass(/is-selected/);
  await expect(page.locator(".room-status-day-cell.is-selected")).toHaveCount(wholeRoomSelectedCount);
  await expect(page.locator(".room-status-day-cell.is-stay-selected")).toHaveCount(wholeRoomSelectedCount);

  await dragRoomStatusRange(page, emptyRoomId, staleStartDate, staleEndDate);
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await refreshCurrentRange(page);
  const parent = roomCell(page, fixture.splitBed.roomId, fixture.dates.arrivalDate);
  await parent.focus();
  await page.keyboard.press("Enter");
  await expectDayPopover(popover, fixture.splitBed.roomId);
  await expect(popover.locator(".room-status-quick-orders button")).toHaveCount(2);
  await expect(staleStart).not.toHaveClass(/is-selected/);
  await expect(staleEnd).not.toHaveClass(/is-selected/);
  await expect(parent).toHaveClass(/is-selected/);
  await expect(page.locator(".room-status-day-cell.is-stay-selected")).toHaveCount(0);

  const selectedOrder = orderResponse(page, fixture.splitBed.bedAOrderId);
  await selectQuickPopoverOrder(popover, "山峰");
  await selectedOrder;
  const drawer = page.locator("dialog.room-status-view-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByRole("button", { name: /收起1栋 101.*床位/ })).toHaveAttribute("aria-expanded", "true");
  for (let dayOffset = 0; dayOffset < 5; dayOffset += 1) {
    await expect(roomCell(page, fixture.splitBed.bedAId, addDays(fixture.dates.arrivalDate, dayOffset)))
      .toHaveClass(/is-stay-selected/);
  }
  const bedStaySelectedCount = await page.locator(".room-status-day-cell.is-stay-selected").count();
  expect(bedStaySelectedCount).toBeGreaterThan(1);
  await drawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(staleStart).not.toHaveClass(/is-selected/);
  await expect(staleEnd).not.toHaveClass(/is-selected/);
  await expect(parent).toHaveClass(/is-selected/);
  await expect(page.locator(".room-status-day-cell.is-stay-selected")).toHaveCount(bedStaySelectedCount);
  await expect(page.locator(".room-status-day-cell.is-selected")).toHaveCount(bedStaySelectedCount + 1);
  await expect(page.locator(
    `[data-room-status-cell="true"][data-unit-id="${fixture.splitBed.bedAId}"].is-selected`
  )).toHaveCount(bedStaySelectedCount);
});

test("U2 desktop write drawer is modal and restores its cell, selection, focus, and scroll snapshot", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 write-drawer coverage");
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page);
  await showRange(page);
  await page.getByTestId("date-window-mode-21").click();

  const targetDate = addDays(fixture.dates.arrivalDate, 10);
  const rangeEndDate = addDays(targetDate, 1);
  const target = roomCell(page, fixture.stage6.emptyCreationRoomId, targetDate);
  const rangeEnd = roomCell(page, fixture.stage6.emptyCreationRoomId, rangeEndDate);
  const other = roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate);
  const scrollport = page.locator(".room-status-grid-scroll");
  await target.scrollIntoViewIfNeeded();
  await scrollport.evaluate((element) => {
    element.scrollLeft = Math.min(element.scrollWidth - element.clientWidth, 220);
    element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, 75);
  });
  await target.scrollIntoViewIfNeeded();
  await rangeEnd.scrollIntoViewIfNeeded();
  await refreshCurrentRange(page);
  await target.scrollIntoViewIfNeeded();
  await rangeEnd.scrollIntoViewIfNeeded();
  await target.focus();
  const before = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  });

  const quotePayloads: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") {
      quotePayloads.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  const drawer = page.locator("dialog.modal-drawer");
  await dragRoomStatusRange(page, fixture.stage6.emptyCreationRoomId, targetDate, rangeEndDate);
  const rangePopover = page.getByTestId("room-status-quick-popover");
  await expect(rangePopover).toBeVisible();
  await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
  await expect(rangePopover).toContainText(`${formatChineseDate(targetDate)}至${formatChineseDate(addDays(rangeEndDate, 1))}`);
  await expect(rangePopover).toContainText("2晚");
  await expect(drawer).toBeHidden();
  await page.waitForTimeout(300);
  expect(quotePayloads).toHaveLength(0);
  const placement = await rangePopover.evaluate((element) => {
    const popover = element.getBoundingClientRect();
    const rowElement = document.querySelector<HTMLElement>(`[data-room-status-row="${element.getAttribute("data-unit-id") ?? ""}"]`);
    const meta = element.querySelector<HTMLElement>(".room-status-quick-meta");
    const close = element.querySelector<HTMLElement>("header .room-status-icon-button");
    if (!rowElement || !meta || !close) throw new Error("快捷操作框缺少房源行、范围摘要或关闭按钮");
    const row = rowElement.getBoundingClientRect();
    const metaBox = meta.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    return {
      width: popover.width,
      top: popover.top,
      bottom: popover.bottom,
      rowTop: row.top,
      rowBottom: row.bottom,
      metaFits: meta.scrollWidth <= meta.clientWidth && meta.scrollHeight <= meta.clientHeight,
      metaEndsBeforeClose: metaBox.right <= closeBox.left
    };
  });
  expect(placement.width).toBeLessThanOrEqual(280);
  expect(
    placement.top >= placement.rowBottom + 7 || placement.bottom <= placement.rowTop - 7,
    `快捷操作框不得覆盖触发房源行：${JSON.stringify(placement)}`
  ).toBe(true);
  expect(placement.metaFits).toBe(true);
  expect(placement.metaEndsBeforeClose).toBe(true);
  await rangePopover.getByRole("button", { name: "创建住宿", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/room-status-write-drawer/);
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(targetDate);
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(addDays(rangeEndDate, 1));
  await expect.poll(() => quotePayloads).toHaveLength(1);
  expect(quotePayloads[0]).toEqual(expect.objectContaining({
    inventoryUnitId: fixture.stage6.emptyCreationRoomId,
    arrivalDate: targetDate,
    departureDate: addDays(rangeEndDate, 1)
  }));
  expect(await drawer.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(drawer.locator(".modal-footer")).toBeVisible();
  await expect(page.getByTestId("create-order")).toBeVisible();
  await expect(target).toHaveClass(/is-selected/);

  let outsideInteractionBlocked = false;
  try {
    await other.click({ trial: true, timeout: 1_000 });
  } catch {
    outsideInteractionBlocked = true;
  }
  expect(outsideInteractionBlocked).toBe(true);

  await drawer.getByRole("button", { name: "关闭办理区域", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/room-status-view-drawer/);
  expect(await drawer.evaluate((element) => element.matches(":modal"))).toBe(false);
  await other.click({ trial: true });

  await drawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(rangeEnd).toBeFocused();
  await expect(target).toHaveClass(/is-selected/);
  await expect(rangeEnd).toHaveClass(/is-selected/);
  await expect.poll(() => page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  })).toEqual(before);

  await dragRoomStatusRange(page, fixture.stage6.emptyCreationRoomId, targetDate, rangeEndDate);
  await expect(rangePopover).toBeVisible();
  await rangePopover.getByRole("button", { name: "维修锁房", exact: true }).click();
  const maintenanceDrawer = page.locator("dialog.room-status-write-drawer");
  await expect(maintenanceDrawer).toBeVisible();
  await expect(maintenanceDrawer.getByRole("heading", { name: /维修锁房/ })).toBeVisible();
  await expect(maintenanceDrawer.getByLabel("开始日期", { exact: true })).toHaveValue(targetDate);
  await expect(maintenanceDrawer.getByLabel("结束日期", { exact: true })).toHaveValue(addDays(rangeEndDate, 1));
  expect(await maintenanceDrawer.evaluate((element) => element.matches(":modal"))).toBe(true);
  await maintenanceDrawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(maintenanceDrawer).toBeHidden();
  await expect(rangeEnd).toBeFocused();
  await expect(target).toHaveClass(/is-selected/);
  await expect(rangeEnd).toHaveClass(/is-selected/);
  await expect.poll(() => page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  })).toEqual(before);
});

test("U2 full order page uses four Chinese business layers and never exposes machine identifiers", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 order-detail coverage");
  await page.setViewportSize({ width: 1440, height: 800 });
  await login(page);
  await showRange(page);
  const { popover } = await openWholeRoomPopover(page);
  const selectedOrder = orderResponse(page, fixture.wholeRoom.orderId);
  await selectQuickPopoverOrder(popover, fixture.wholeRoom.nicknames[0]!);
  await selectedOrder;
  await page.getByRole("button", { name: "查看完整订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${fixture.wholeRoom.orderId}$`));

  const main = page.locator("main");
  for (const heading of ["原始预订安排", "当前住宿安排", "入住与退房结果", "住宿安排变更历史"]) {
    await expect(main.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(main.getByText("订单金额", { exact: true }).first()).toBeVisible();
  await expect(main.getByText("已登记净收款", { exact: true }).first()).toBeVisible();
  await expect(main.getByText(fixture.wholeRoom.orderId, { exact: true })).toHaveCount(0);
  await expect(main).not.toContainText(/INITIAL|Segment ID|Amendments|payload|Fact ID|Receipt ID|Command ID|Correlation ID|Claim|Revision|currentContractAmount|netRecordedCollection|collectionDifference|渠道合同价/);
});

test("U2 desktop sidebar keeps 176px and 60px states across routes and reload", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop-only U2 sidebar coverage");
  await page.setViewportSize({ width: 1440, height: 800 });
  await login(page);
  const sidebar = page.locator(".sidebar");
  expect(await sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(176, 1);

  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(60, 1);
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(60, 1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(60, 1);
  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(176, 1);
});

test("U2 mobile order context is full-screen, machine-free, and returns focus to the occupancy", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile-only U2 order-context coverage");
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await expect(page.locator(".room-status-toolbar")).toHaveCount(0);
  await expect(page.locator(".room-status-grid-section")).toBeHidden();
  await page.getByRole("button", { name: "查看住宿安排说明", exact: true }).click();
  await expect(page.getByText("这里按房间和日期列出当前查看范围内的已预订和在住占用，用于核对每天的占用情况；它不是今日待办，也不会直接创建订单。", { exact: true })).toBeVisible();
  await showRange(page, 7, false);
  await expect(page.getByTestId("sidebar-toggle")).toBeHidden();
  for (const viewport of [{ width: 375, height: 812 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(viewport);
    const occupancy = page.locator(".room-status-mobile-occupancies li").filter({ hasText: "小川" }).first();
    const trigger = occupancy.getByRole("button", { name: "查看订单信息", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "订单上下文", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText(/order_|INITIAL|Segment|Amendment|payload|Fact ID|Receipt ID|Command ID|Correlation ID|Claim|Revision|渠道合同价/);
    const geometry = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.left).toBeCloseTo(0, 0);
    expect(geometry.top).toBeCloseTo(0, 0);
    expect(geometry.right).toBeCloseTo(geometry.width, 0);
    expect(geometry.bottom).toBeCloseTo(geometry.height, 0);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});

test("U2 order context remains reachable at 200 percent desktop zoom", async ({ browser }, testInfo) => {
  test.skip(!isDesktop(testInfo), "single dedicated 2x desktop context for U2 zoom coverage");
  const zoomContext = await browser.newContext({
    baseURL: process.env.ROOM_STATUS_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? "4173"}`,
    viewport: { width: 720, height: 450 },
    screen: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false
  });
  const page = await zoomContext.newPage();
  try {
    await login(page);
    await showRange(page, 7, false);
    expect(await page.evaluate(() => ({
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
      pixelRatio: window.devicePixelRatio
    }))).toEqual({ cssWidth: 720, cssHeight: 450, pixelRatio: 2 });

    const occupancy = page.locator(".room-status-mobile-occupancies li").filter({ hasText: "小川" }).first();
    const trigger = occupancy.getByRole("button", { name: "查看订单信息", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "订单上下文", exact: true });
    await expect(dialog).toBeVisible();
    const geometry = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageScrollWidth: document.documentElement.scrollWidth
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    await expect(dialog.getByRole("button", { name: "查看完整订单", exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await zoomContext.close();
  }
});
