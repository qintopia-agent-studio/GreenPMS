import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { RoomStatusBoardDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import { createRoomStatusViewState, serializeRoomStatusRestoration } from "../../apps/web/src/room-status/roomStatusState.ts";

const baseUrl = process.env.ROOM_STATUS_E2E_BASE_URL ?? "/";
const propertyId = "prop_qintopia_demo";
const operatorSubjectId = "subject_demo_operator";
const operator = { username: "operator", password: "demo-pass-2026" };
const operatorRestorationKey = `qintopia.room-status-view.v1:${operatorSubjectId}:${propertyId}`;

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatChineseDate(value: string): string {
  const [, month = "", day = ""] = /^(?:\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? [];
  return `${Number(month)}月${Number(day)}日`;
}

function roomStatusResponse(page: Page) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${propertyId}/room-status`
      && response.status() === 200;
  });
}

async function login(page: Page): Promise<RoomStatusBoardDto> {
  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-username").fill(operator.username);
  await page.getByTestId("login-password").fill(operator.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  const response = await responsePromise;
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", level: 2 })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible();
  return response.json() as Promise<RoomStatusBoardDto>;
}

function roomCell(page: Page, unitId: string, serviceDate: string): Locator {
  return page.locator(
    `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
  );
}

function roomRow(page: Page, unitId: string): Locator {
  return page.locator(`[data-room-status-row="${unitId}"]`);
}

async function openMaintenanceDrawer(page: Page, candidate: ReturnType<typeof findWritableNight>): Promise<Locator> {
  const cell = roomCell(page, candidate.unitId, candidate.arrivalDate);
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toBeVisible();
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", candidate.unitId);
  await expect(popover).toHaveAttribute("data-selection-kind", "day");
  await popover.getByRole("button", { name: "维修锁房", exact: true }).click();
  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("开始日期", { exact: true })).toHaveValue(candidate.arrivalDate);
  await expect(drawer.getByLabel("结束日期", { exact: true })).toHaveValue(candidate.departureDate);
  return drawer;
}

async function tabTo(page: Page, target: Locator, description: string): Promise<void> {
  await expect(target, description).toBeVisible();
  const maximumTabs = await page.locator([
    "a[href]:visible",
    "button:not([disabled]):visible",
    "input:not([disabled]):visible",
    "select:not([disabled]):visible",
    "textarea:not([disabled]):visible",
    "[tabindex]:not([tabindex='-1']):visible"
  ].join(", ")).count() + 1;
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach ${description} after ${maximumTabs} Tab presses`);
}

async function expectFullyHitTestable(target: Locator, description: string): Promise<void> {
  await expect(target, description).toBeVisible();
  const geometry = await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    let clipLeft = viewport?.offsetLeft ?? 0;
    let clipTop = viewport?.offsetTop ?? 0;
    let clipRight = clipLeft + (viewport?.width ?? window.innerWidth);
    let clipBottom = clipTop + (viewport?.height ?? window.innerHeight);

    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if (!clipsX && !clipsY) continue;
      const ancestorBox = ancestor.getBoundingClientRect();
      if (clipsX) {
        clipLeft = Math.max(clipLeft, ancestorBox.left);
        clipRight = Math.min(clipRight, ancestorBox.right);
      }
      if (clipsY) {
        clipTop = Math.max(clipTop, ancestorBox.top);
        clipBottom = Math.min(clipBottom, ancestorBox.bottom);
      }
    }

    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const insetX = Math.min(Math.max(2, box.width * 0.1), box.width / 2);
    const insetY = Math.min(Math.max(2, box.height * 0.1), box.height / 2);
    const points = [
      { x: centerX, y: centerY },
      { x: box.left + insetX, y: centerY },
      { x: box.right - insetX, y: centerY },
      { x: centerX, y: box.top + insetY },
      { x: centerX, y: box.bottom - insetY }
    ];
    const hitResults = points.map(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return {
        matches: hit === element || (hit !== null && element.contains(hit)),
        description: hit instanceof HTMLElement
          ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${hit.className ? `.${String(hit.className).replaceAll(" ", ".")}` : ""}`
          : String(hit)
      };
    });
    const style = getComputedStyle(element);
    const focusMargin = element.matches(":focus-visible")
      ? Math.max(
          0,
          Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset),
          style.boxShadow === "none" || style.boxShadow.includes("inset") ? 0 : 3
        )
      : 0;
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      clip: { left: clipLeft, top: clipTop, right: clipRight, bottom: clipBottom },
      focusMargin,
      hitResults
    };
  });

  expect(geometry.box.width, `${description} width`).toBeGreaterThan(0);
  expect(geometry.box.height, `${description} height`).toBeGreaterThan(0);
  const focusEdgeTolerance = 3;
  expect(geometry.box.left - geometry.focusMargin, `${description} left edge`).toBeGreaterThanOrEqual(geometry.clip.left - focusEdgeTolerance);
  expect(geometry.box.top - geometry.focusMargin, `${description} top edge`).toBeGreaterThanOrEqual(geometry.clip.top - focusEdgeTolerance);
  expect(geometry.box.right + geometry.focusMargin, `${description} right edge`).toBeLessThanOrEqual(geometry.clip.right + focusEdgeTolerance);
  expect(geometry.box.bottom + geometry.focusMargin, `${description} bottom edge`).toBeLessThanOrEqual(geometry.clip.bottom + focusEdgeTolerance);
  for (const [index, hit] of geometry.hitResults.entries()) {
    expect(hit.matches, `${description} hit point ${index + 1} was covered by ${hit.description}`).toBe(true);
  }
}

async function previewAndConfirm(page: Page): Promise<{ resourceRefs: string[] }> {
  await expect(page.getByTestId("command-effect")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("reason-note")).toHaveCount(0);
  const refreshedPromise = roomStatusResponse(page);
  const confirmedPromise = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await page.getByTestId("confirm-command").click();
  const receipt = await (await confirmedPromise).json() as { resourceRefs: string[] };
  await refreshedPromise;
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  return receipt;
}

function findFiveNightDragCandidate(board: RoomStatusBoardDto) {
  for (const room of board.rooms) {
    if (!room.allowedActions.some((action) => action.code === "LOCK_MAINTENANCE" && action.enabled)) continue;
    for (let index = 0; index <= board.dates.length - 5; index += 1) {
      const dates = board.dates.slice(index, index + 5);
      if (dates.every((date) => {
        const day = room.days.find((candidate) => candidate.serviceDate === date);
        return day?.available && day.conflicts.length === 0 && day.intervalIds.length === 0;
      })) {
        return {
          unitId: room.id,
          dragStart: dates[0]!,
          blockStart: dates[1]!,
          blockEnd: dates[4]!,
          dragEnd: dates[4]!
        };
      }
    }
  }
  throw new Error("No room has five consecutive available nights for the interval-overlay drag fixture");
}

function findWritableNight(board: RoomStatusBoardDto) {
  for (const room of board.rooms) {
    if (!room.allowedActions.some((action) => action.code === "LOCK_MAINTENANCE" && action.enabled)) continue;
    const day = room.days.find((candidate) => candidate.available
      && candidate.conflicts.length === 0
      && candidate.intervalIds.length === 0);
    if (day) return { unitId: room.id, arrivalDate: day.serviceDate, departureDate: addDays(day.serviceDate, 1) };
  }
  throw new Error("No room has an available night for the maintenance draft");
}

function findLastWritableNight(board: RoomStatusBoardDto) {
  for (const room of [...board.rooms].reverse()) {
    if (!room.allowedActions.some((action) => action.code === "LOCK_MAINTENANCE" && action.enabled)) continue;
    const day = [...room.days].reverse().find((candidate) => candidate.available && candidate.conflicts.length === 0);
    if (day) return { unitId: room.id, serviceDate: day.serviceDate };
  }
  throw new Error("No late-grid available night exists for sticky evidence");
}

test("a restoration mounted at 375px restores its focused date cell and scroll anchor after expanding to desktop", async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();

  const arrivalDate = todayInTimeZone("Asia/Shanghai");
  const departureDate = addDays(arrivalDate, 14);
  const targetUnitId = "unit_room_e_gen_03";
  const targetDate = addDays(arrivalDate, 10);
  const selection = {
    unitId: targetUnitId,
    anchorDate: targetDate,
    focusDate: targetDate,
    arrivalDate: targetDate,
    departureDate: addDays(targetDate, 1)
  };
  await page.evaluate(({ key, value }) => window.sessionStorage.setItem(key, value), {
    key: operatorRestorationKey,
    value: serializeRoomStatusRestoration({
      version: 1,
      propertyId,
      range: { arrivalDate, departureDate },
      revision: "0",
      savedAt: new Date().toISOString(),
      state: createRoomStatusViewState({
        focusedCell: { unitId: targetUnitId, serviceDate: targetDate },
        selection,
        scrollAnchor: { unitId: targetUnitId, left: 640, top: 2_800 }
      })
    })
  });

  await page.getByTestId("login-username").fill(operator.username);
  await page.getByTestId("login-password").fill(operator.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  await responsePromise;
  await expect(page.getByRole("heading", { name: "今日运营任务" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.locator(".room-status-return-notice")).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  const target = roomCell(page, targetUnitId, targetDate);
  const scroll = page.locator(".room-status-grid-scroll");
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute("aria-selected", "true");

  const geometry = await page.evaluate(({ unitId, serviceDate }) => {
    const container = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    const cell = document.querySelector<HTMLElement>(
      `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
    );
    if (!container || !cell) return null;
    const containerBox = container.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    return {
      windowScrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      maximumScrollLeft: Math.max(0, container.scrollWidth - container.clientWidth),
      container: { left: containerBox.left, top: containerBox.top, right: containerBox.right, bottom: containerBox.bottom },
      cell: { left: cellBox.left, top: cellBox.top, right: cellBox.right, bottom: cellBox.bottom }
    };
  }, { unitId: targetUnitId, serviceDate: targetDate });
  expect(geometry).not.toBeNull();
  expect(geometry!.scrollTop).toBe(0);
  expect(geometry!.windowScrollY).toBeGreaterThan(0);
  expect(geometry!.scrollLeft).toBe(Math.min(640, geometry!.maximumScrollLeft));
  expect(geometry!.cell.top).toBeGreaterThanOrEqual(0);
  expect(geometry!.cell.bottom).toBeLessThanOrEqual(geometry!.viewportHeight + 1);
  expect(geometry!.cell.left).toBeGreaterThanOrEqual(geometry!.container.left + 200);
  expect(geometry!.cell.right).toBeLessThanOrEqual(geometry!.container.right + 1);
  await expect(scroll).toBeVisible();
  await expectFullyHitTestable(target, "restored room-status cell");
  await page.screenshot({ path: testInfo.outputPath("mobile-first-restoration-expanded-desktop.png") });
});

test("sticky date and resource headers remain aligned after the horizontal grid axis reaches its end", async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await login(page);
  expect(board.dates).toHaveLength(30);
  const targetIdentity = findLastWritableNight(board);
  const scroll = page.locator(".room-status-grid-scroll");
  const target = roomCell(page, targetIdentity.unitId, targetIdentity.serviceDate);
  await expect(target).toBeVisible({ timeout: 5_000 });

  const browserMaximumScroll = await scroll.evaluate((element) => {
    element.scrollLeft = Number.MAX_SAFE_INTEGER;
    return { left: element.scrollLeft, top: element.scrollTop };
  });
  expect(browserMaximumScroll.left).toBeGreaterThan(0);
  expect(browserMaximumScroll.top).toBe(0);
  await page.keyboard.press("Tab");
  await target.focus();
  await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await expect(target).toBeFocused();
  expect(await target.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await scroll.evaluate((element, maximum) => {
    element.scrollLeft = maximum.left;
  }, browserMaximumScroll);
  await expect.poll(() => scroll.evaluate((element, maximum) => (
    Math.abs(element.scrollLeft - maximum.left) <= 1 && element.scrollTop === 0
  ), browserMaximumScroll)).toBe(true);

  const stickyGeometry = await page.evaluate(({ unitId, serviceDate }) => {
    const scrollport = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    const dateHeader = document.querySelector<HTMLElement>(".room-status-date-header:last-child");
    const resourceHeader = document.querySelector<HTMLElement>(".room-status-resource-header");
    const cell = document.querySelector<HTMLElement>(
      `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
    );
    const resourceCell = cell?.closest(".room-status-grid-row")?.querySelector<HTMLElement>(".room-status-resource-cell");
    if (!scrollport || !dateHeader || !resourceHeader || !cell || !resourceCell) return null;
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const hit = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const candidate = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return candidate === element || (candidate !== null && element.contains(candidate));
    };
    return {
      windowScrollY: window.scrollY,
      scrollLeft: scrollport.scrollLeft,
      scrollTop: scrollport.scrollTop,
      scrollport: box(scrollport),
      dateHeader: box(dateHeader),
      resourceHeader: box(resourceHeader),
      resourceCell: box(resourceCell),
      cell: box(cell),
      hits: {
        dateHeader: hit(dateHeader),
        resourceHeader: hit(resourceHeader),
        resourceCell: hit(resourceCell),
        cell: hit(cell)
      }
    };
  }, targetIdentity);

  expect(stickyGeometry).not.toBeNull();
  expect(stickyGeometry!.scrollLeft).toBeGreaterThanOrEqual(browserMaximumScroll.left - 1);
  expect(stickyGeometry!.scrollTop).toBe(0);
  expect(stickyGeometry!.windowScrollY).toBeGreaterThan(0);
  expect(stickyGeometry!.dateHeader.top).toBeGreaterThanOrEqual(stickyGeometry!.scrollport.top - 1);
  expect(stickyGeometry!.resourceHeader.left).toBeGreaterThanOrEqual(stickyGeometry!.scrollport.left - 1);
  expect(stickyGeometry!.resourceCell.left).toBeGreaterThanOrEqual(stickyGeometry!.scrollport.left - 1);
  expect(stickyGeometry!.cell.top).toBeGreaterThanOrEqual(stickyGeometry!.dateHeader.bottom - 1);
  expect(stickyGeometry!.cell.left).toBeGreaterThanOrEqual(stickyGeometry!.resourceCell.right - 1);
  expect(stickyGeometry!.hits.resourceCell).toBe(true);
  expect(stickyGeometry!.hits.cell).toBe(true);
  await expectFullyHitTestable(target, "focused end-of-grid cell");
  await page.screenshot({ path: testInfo.outputPath("room-status-sticky-grid-end-viewport.png") });
});

test("a short 200 percent reflow keeps critical controls reachable outside intentional scrollports", async ({ browser }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single dedicated 2x desktop context for 200 percent zoom");
  test.setTimeout(90_000);
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
    expect(await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
      visualWidth: window.visualViewport?.width,
      visualHeight: window.visualViewport?.height,
      compactShell: window.matchMedia("(max-width: 860px)").matches,
      tabletRoomStatus: window.matchMedia("(max-width: 767px) and (min-width: 576px)").matches
    }))).toEqual({
      width: 720,
      height: 450,
      pixelRatio: 2,
      visualWidth: 720,
      visualHeight: 450,
      compactShell: true,
      tabletRoomStatus: true
    });
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.locator(".room-status-mobile")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(721);
    await page.screenshot({ path: testInfo.outputPath("room-status-200-percent-short-toolbar-viewport.png") });

    const mobileCreate = page.getByRole("button", { name: "新建住宿或锁房", exact: true });
    await page.locator("#main-content").focus();
    await tabTo(page, mobileCreate, "200 percent mobile create action");
    expect(await mobileCreate.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expectFullyHitTestable(mobileCreate, "200 percent mobile create action");
    await mobileCreate.click();
    const createDialog = page.getByRole("dialog", { name: "新建住宿或锁房", exact: true });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole("button", { name: "关闭", exact: true }).click();
    const activeNavigation = page.locator(".mobile-navigation").getByRole("link", { name: "房态", exact: true });
    await expectFullyHitTestable(activeNavigation, "200 percent fixed room-status navigation");
    await page.screenshot({ path: testInfo.outputPath("room-status-200-percent-short-context-viewport.png") });
  } finally {
    await zoomContext.close();
  }
});

test("mouse drag selection keeps extending while the pointer crosses a continuous interval overlay", async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await login(page);
  await expect(page.getByRole("grid")).toBeVisible();
  expect(board.dates).toHaveLength(30);
  const candidate = findFiveNightDragCandidate(board);
  const businessReason = `Room-status overlay drag ${randomUUID()}`;

  const row = roomRow(page, candidate.unitId);
  const interval = row.getByRole("button", {
    name: `维修/锁房，${formatChineseDate(candidate.blockStart)}至${formatChineseDate(candidate.blockEnd)}`,
    exact: true
  });
  try {
    const blockStartCell = roomCell(page, candidate.unitId, candidate.blockStart);
    const blockEndCell = roomCell(page, candidate.unitId, addDays(candidate.blockEnd, -1));
    const blockStartBox = await blockStartCell.boundingBox();
    const blockEndBox = await blockEndCell.boundingBox();
    expect(blockStartBox).not.toBeNull();
    expect(blockEndBox).not.toBeNull();
    await page.mouse.move(blockStartBox!.x + blockStartBox!.width / 2, blockStartBox!.y + blockStartBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(blockEndBox!.x + blockEndBox!.width / 2, blockEndBox!.y + blockEndBox!.height / 2, { steps: 8 });
    await page.mouse.up();
    const actionPopover = page.getByTestId("room-status-quick-popover");
    await expect(actionPopover).toHaveAttribute("data-selection-kind", "range");
    await actionPopover.getByRole("button", { name: "维修锁房", exact: true }).click();
    await page.getByLabel("维修原因").fill(businessReason);
    await page.getByRole("button", { name: "继续核对", exact: true }).click();
    const placementReceipt = await previewAndConfirm(page);
    expect(placementReceipt.resourceRefs).toEqual([expect.stringMatching(/^maint_/)]);

    const startCell = roomCell(page, candidate.unitId, candidate.dragStart);
    const endCell = roomCell(page, candidate.unitId, candidate.dragEnd);
    await expect(interval).toHaveCount(1);
    const gridScroller = page.locator(".room-status-grid-scroll");
    const resourceCell = row.locator(".room-status-resource-cell");
    const initialIntervalBox = await interval.boundingBox();
    const initialResourceBox = await resourceCell.boundingBox();
    expect(initialIntervalBox).not.toBeNull();
    expect(initialResourceBox).not.toBeNull();
    const scrollDelta = Math.max(1, Math.ceil(
      initialIntervalBox!.x + initialIntervalBox!.width / 2
      - (initialResourceBox!.x + initialResourceBox!.width / 2)
    ));
    await gridScroller.evaluate((element, delta) => {
      element.scrollLeft = Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + delta);
    }, scrollDelta);
    await expect.poll(async () => {
      const intervalBox = await interval.boundingBox();
      const frozenBox = await resourceCell.boundingBox();
      if (!intervalBox || !frozenBox) return 0;
      return Math.min(intervalBox.x + intervalBox.width, frozenBox.x + frozenBox.width)
        - Math.max(intervalBox.x, frozenBox.x);
    }).toBeGreaterThan(4);
    const overlappedIntervalBox = await interval.boundingBox();
    const frozenResourceBox = await resourceCell.boundingBox();
    expect(overlappedIntervalBox).not.toBeNull();
    expect(frozenResourceBox).not.toBeNull();
    const overlapLeft = Math.max(overlappedIntervalBox!.x, frozenResourceBox!.x);
    const overlapRight = Math.min(
      overlappedIntervalBox!.x + overlappedIntervalBox!.width,
      frozenResourceBox!.x + frozenResourceBox!.width
    );
    const frozenColumnOwnsOverlap = await page.evaluate(({ x, y }) => (
      document.elementFromPoint(x, y)?.closest(".room-status-resource-cell") !== null
    ), {
      x: (overlapLeft + overlapRight) / 2,
      y: overlappedIntervalBox!.y + overlappedIntervalBox!.height / 2
    });
    expect(frozenColumnOwnsOverlap, "the frozen room column must cover and own hits over an overlapping interval").toBe(true);

    await expect(startCell).toHaveAccessibleName(/可售.*可以安排/);
    await expect(endCell).toHaveAccessibleName(/可售.*可以安排/);

    await endCell.evaluate((element) => element.scrollIntoView({ block: "nearest", inline: "end" }));
    await expectFullyHitTestable(startCell, "drag selection start cell before pointer input");
    await expectFullyHitTestable(endCell, "drag selection end cell before pointer input");

    const boxes = {
      start: await startCell.boundingBox(),
      interval: await interval.boundingBox(),
      end: await endCell.boundingBox()
    };
    expect(boxes.start).not.toBeNull();
    expect(boxes.interval).not.toBeNull();
    expect(boxes.end).not.toBeNull();
    const pointerY = boxes.interval!.y + boxes.interval!.height / 2;
    const overlayHit = await page.evaluate(({ x, y }) => (
      document.elementFromPoint(x, y)?.closest(".room-status-interval")?.classList.contains("room-status-interval-maintenance") ?? false
    ), { x: boxes.interval!.x + boxes.interval!.width / 2, y: pointerY });
    expect(overlayHit, "the pointer path must cross the actual interval button, not a bare date cell").toBe(true);

    await page.mouse.move(boxes.start!.x + boxes.start!.width / 2, pointerY);
    await page.mouse.down();
    await page.mouse.move(boxes.interval!.x + boxes.interval!.width / 2, pointerY, { steps: 8 });
    await page.mouse.move(boxes.end!.x + boxes.end!.width / 2, pointerY, { steps: 8 });
    await page.mouse.up();

    const rangePopover = page.getByTestId("room-status-quick-popover");
    await expect(rangePopover).toBeVisible();
    await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
    for (const date of board.dates.filter((date) => date >= candidate.dragStart && date <= candidate.dragEnd)) {
      await expect(roomCell(page, candidate.unitId, date)).toHaveAttribute("aria-selected", "true");
    }
    await expectFullyHitTestable(startCell, "drag selection start cell");
    await expectFullyHitTestable(endCell, "drag selection end cell");
    await page.screenshot({ path: testInfo.outputPath("mouse-drag-crosses-interval-overlay.png") });
    await page.keyboard.press("Escape");
    await expect(rangePopover).toBeHidden();
  } finally {
    if (await interval.count() === 1) {
      await interval.click();
      const actionPopover = page.getByTestId("room-status-quick-popover");
      await actionPopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
      await page.locator(".room-status-context-actions").getByRole("button", { name: "释放维修锁房", exact: true }).click();
      const releaseReceipt = await previewAndConfirm(page);
      expect(releaseReceipt.resourceRefs).toEqual([expect.stringMatching(/^maint_/)]);
      await expect(interval).toHaveCount(0);
    }
  }
});

test("Block drafts cannot leave the server-validated room-status selection", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop Block draft boundary coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await login(page);
  const candidate = findWritableNight(board);
  let previewRequestCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/command-previews") {
      previewRequestCount += 1;
    }
  });

  const dialog = await openMaintenanceDrawer(page, candidate);
  const from = dialog.getByLabel("开始日期");
  const to = dialog.getByLabel("结束日期");
  await expect(from).toHaveAttribute("min", candidate.arrivalDate);
  await expect(from).toHaveAttribute("max", candidate.arrivalDate);
  await expect(to).toHaveAttribute("min", candidate.departureDate);
  await expect(to).toHaveAttribute("max", candidate.departureDate);

  await from.fill(addDays(candidate.arrivalDate, -1));
  await dialog.getByLabel("维修原因").fill(`Out-of-window draft ${randomUUID()}`);
  expect(await from.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);
  await dialog.getByRole("button", { name: "继续核对", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(previewRequestCount).toBe(0);
});

test("a maintenance draft survives stale query conditions at 320px and resumes after fresh room status returns", async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await login(page);
  await expect(page.getByRole("grid")).toBeVisible();
  const candidate = findWritableNight(board);

  let dialog = await openMaintenanceDrawer(page, candidate);
  const businessReason = `Preserved at 320px ${randomUUID()}`;
  const reason = dialog.getByLabel("维修原因");
  const submit = dialog.getByRole("button", { name: "继续核对", exact: true });
  await reason.fill(businessReason);
  await expect(submit).toBeEnabled();

  await page.setViewportSize({ width: 320, height: 700 });
  dialog = page.getByRole("dialog", { name: /^维修锁房 ·/ });
  await expect(dialog).toBeVisible();
  await expect(reason).toHaveValue(businessReason);

  const compactMetrics = await dialog.evaluate((element) => {
    const visible = (candidate: Element): candidate is HTMLElement => {
      if (!(candidate instanceof HTMLElement)) return false;
      const style = getComputedStyle(candidate);
      return style.visibility !== "hidden" && style.display !== "none" && candidate.getClientRects().length > 0;
    };
    const controls = [...element.querySelectorAll("input, select, textarea")].filter(visible).map((control) => ({
      tag: control.tagName,
      fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
      height: control.getBoundingClientRect().height
    }));
    const buttons = [...element.querySelectorAll("button")].filter(visible).map((button) => {
      const box = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "button", width: box.width, height: box.height };
    });
    const root = document.documentElement;
    const dialogBox = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      controls,
      buttons,
      pageClientWidth: root.clientWidth,
      pageScrollWidth: root.scrollWidth,
      dialogClientWidth: element.clientWidth,
      dialogScrollWidth: element.scrollWidth,
      dialogLeft: dialogBox.left,
      dialogTop: dialogBox.top,
      dialogRight: dialogBox.right,
      dialogBottom: dialogBox.bottom,
      viewportLeft: viewport?.offsetLeft ?? 0,
      viewportTop: viewport?.offsetTop ?? 0,
      viewportRight: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
      viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
    };
  });
  expect(compactMetrics.controls.length).toBeGreaterThanOrEqual(3);
  for (const control of compactMetrics.controls) {
    expect(control.fontSize, `${control.tag} font size at 320px`).toBeGreaterThanOrEqual(16);
    expect(control.height, `${control.tag} touch height at 320px`).toBeGreaterThanOrEqual(44);
  }
  for (const button of compactMetrics.buttons) {
    expect(button.width, `${button.label} touch width at 320px`).toBeGreaterThanOrEqual(44);
    expect(button.height, `${button.label} touch height at 320px`).toBeGreaterThanOrEqual(44);
  }
  expect(compactMetrics.pageScrollWidth).toBeLessThanOrEqual(compactMetrics.pageClientWidth + 1);
  expect(compactMetrics.dialogScrollWidth).toBeLessThanOrEqual(compactMetrics.dialogClientWidth + 1);
  expect(compactMetrics.dialogLeft).toBeGreaterThanOrEqual(compactMetrics.viewportLeft - 1);
  expect(compactMetrics.dialogTop).toBeGreaterThanOrEqual(compactMetrics.viewportTop - 1);
  expect(compactMetrics.dialogRight).toBeLessThanOrEqual(compactMetrics.viewportRight + 1);
  expect(compactMetrics.dialogBottom).toBeLessThanOrEqual(compactMetrics.viewportBottom + 1);

  try {
    await page.context().setOffline(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(dialog.getByRole("alert").filter({ hasText: "草稿已保留，写入已暂停" })).toBeVisible();
    await expect(dialog.getByText("日期和原因草稿仍保留", { exact: false })).toBeVisible();
    await expect(reason).toHaveValue(businessReason);
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("draft-preserved-stale-at-320px.png") });

    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    await tabTo(page, cancel, "320px stale draft cancel action");
    await expect(cancel).toBeFocused();
    expect(await cancel.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    const modalBody = dialog.locator(".modal-body");
    await expectFullyHitTestable(cancel, "320px keyboard-reached stale draft cancel action");

    await modalBody.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect.poll(() => modalBody.evaluate((element) => (
      Math.abs(element.scrollTop - Math.max(0, element.scrollHeight - element.clientHeight)) <= 1
    ))).toBe(true);
    const bodyScroll = await modalBody.evaluate((element) => ({
      maximum: Math.max(0, element.scrollHeight - element.clientHeight),
      position: element.scrollTop
    }));
    expect(bodyScroll.position).toBeGreaterThanOrEqual(bodyScroll.maximum - 1);
    await expectFullyHitTestable(cancel, "320px scroll-end stale draft cancel action");
    await page.screenshot({ path: testInfo.outputPath("draft-preserved-stale-actions-at-320px.png") });

    await page.context().setOffline(false);
    const recoveredPromise = roomStatusResponse(page);
    await dialog.getByRole("button", { name: "重试刷新", exact: true }).click();
    await recoveredPromise;
    await expect(dialog.getByRole("alert").filter({ hasText: "草稿已保留，写入已暂停" })).toBeHidden();
    await expect(reason).toHaveValue(businessReason);
    await expect(submit).toBeEnabled();

    await tabTo(page, submit, "320px resumed Preview action");
    await expect(submit).toBeFocused();
    expect(await submit.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expectFullyHitTestable(submit, "320px resumed Preview action");
    await page.keyboard.press("Enter");
    const commandDialog = page.locator("dialog.modal-wide");
    await expect(commandDialog).toBeVisible();
    await expect(page.getByTestId("command-effect")).toBeVisible({ timeout: 15_000 });
    const confirmButton = page.getByTestId("confirm-command");
    await tabTo(page, confirmButton, "320px business confirmation action");
    expect(await confirmButton.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expectFullyHitTestable(confirmButton, "320px business confirmation action");
    await page.screenshot({ path: testInfo.outputPath("server-preview-at-320px.png") });
    await page.keyboard.press("Escape");
    await expect(commandDialog).toBeHidden();
  } finally {
    await page.context().setOffline(false);
  }
});
