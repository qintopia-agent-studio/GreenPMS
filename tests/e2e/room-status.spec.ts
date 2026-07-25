import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { hashPassword, todayInTimeZone } from "@qintopia/domain";
import type { RoomStatusBoardDto } from "@qintopia/contracts";
import { createDatabase } from "../../packages/db/src/database.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const commandUiWaitMs = 60_000;
const operator = { username: "operator", password: "demo-pass-2026" };
const readOnlyOperator = {
  id: "subject_e2e_room_status_reader",
  username: "room-status-reader",
  password: "room-status-read-2026",
  displayName: "Room Status Read Operator"
};
const revocationOperator = {
  id: "subject_e2e_room_status_revocation",
  username: "room-status-revocation",
  password: "room-status-revocation-2026",
  displayName: "Room Status Revocation Operator"
};
const restorationSwitchProperty = {
  id: "prop_e2e_restoration_switch",
  code: "ZZ-RESTORE",
  name: "Restoration Switch Fixture"
};

function isProject(testInfo: TestInfo, name: "desktop" | "mobile"): boolean {
  return testInfo.project.name === name || process.env.ROOM_STATUS_E2E_PROJECT === name;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

async function ensureReadOnlyPrincipal() {
  const db = createDatabase(e2eDatabaseUrl);
  const salt = "room-status-reader-e2e-v1";
  try {
    await db.insertInto("subjects").values({
      id: readOnlyOperator.id,
      username: readOnlyOperator.username,
      display_name: readOnlyOperator.displayName,
      password_salt: salt,
      password_hash: hashPassword(readOnlyOperator.password, salt),
      status: "ACTIVE",
      auth_version: 1
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({
      username: readOnlyOperator.username,
      display_name: readOnlyOperator.displayName,
      password_salt: salt,
      password_hash: hashPassword(readOnlyOperator.password, salt),
      status: "ACTIVE",
      auth_version: 1
    })).execute();
    await db.insertInto("subject_property_grants").values({
      subject_id: readOnlyOperator.id,
      property_id: propertyId,
      access_level: "READ"
    }).onConflict((conflict) => conflict.columns(["subject_id", "property_id"]).doUpdateSet({
      access_level: "READ"
    })).execute();
  } finally {
    await db.destroy();
  }
}

async function ensureRevocationPrincipal() {
  const db = createDatabase(e2eDatabaseUrl);
  const salt = "room-status-revocation-e2e-v1";
  try {
    await db.insertInto("subjects").values({
      id: revocationOperator.id,
      username: revocationOperator.username,
      display_name: revocationOperator.displayName,
      password_salt: salt,
      password_hash: hashPassword(revocationOperator.password, salt),
      status: "ACTIVE",
      auth_version: 1
    }).onConflict((conflict) => conflict.column("id").doUpdateSet({
      username: revocationOperator.username,
      display_name: revocationOperator.displayName,
      password_salt: salt,
      password_hash: hashPassword(revocationOperator.password, salt),
      status: "ACTIVE",
      auth_version: 1
    })).execute();
  } finally {
    await db.destroy();
  }
  await setPrincipalPropertyAccess(revocationOperator.username, "WRITE");
}

async function enableRestorationSwitchProperty() {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("properties").values({
        id: restorationSwitchProperty.id,
        code: restorationSwitchProperty.code,
        name: restorationSwitchProperty.name,
        timezone: "Asia/Shanghai",
        currency: "CNY"
      }).onConflict((conflict) => conflict.column("id").doNothing()).execute();
      await trx.insertInto("room_status_revisions").values({
        property_id: restorationSwitchProperty.id,
        revision: 0
      }).onConflict((conflict) => conflict.column("property_id").doNothing()).execute();
      const subject = await trx.selectFrom("subjects")
        .select("id")
        .where("username", "=", operator.username)
        .executeTakeFirstOrThrow();
      await trx.insertInto("subject_property_grants").values({
        subject_id: subject.id,
        property_id: restorationSwitchProperty.id,
        access_level: "WRITE"
      }).onConflict((conflict) => conflict.columns(["subject_id", "property_id"]).doUpdateSet({
        access_level: "WRITE"
      })).execute();
    });
  } finally {
    await db.destroy();
  }
}

async function removeRestorationSwitchProperty() {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    await db.transaction().execute(async (trx) => {
      const subject = await trx.selectFrom("subjects")
        .select("id")
        .where("username", "=", operator.username)
        .executeTakeFirst();
      if (subject) {
        await trx.deleteFrom("subject_property_grants")
          .where("subject_id", "=", subject.id)
          .where("property_id", "=", restorationSwitchProperty.id)
          .execute();
      }
      await trx.deleteFrom("room_status_revisions")
        .where("property_id", "=", restorationSwitchProperty.id)
        .execute();
      await trx.deleteFrom("properties")
        .where("id", "=", restorationSwitchProperty.id)
        .execute();
    });
  } finally {
    await db.destroy();
  }
}

async function setPrincipalPropertyAccess(username: string, accessLevel: "READ" | "WRITE" | null) {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    const subject = await db.selectFrom("subjects")
      .select("id")
      .where("username", "=", username)
      .executeTakeFirstOrThrow();
    if (accessLevel === null) {
      await db.deleteFrom("subject_property_grants")
        .where("subject_id", "=", subject.id)
        .where("property_id", "=", propertyId)
        .execute();
      return;
    }
    await db.insertInto("subject_property_grants").values({
      subject_id: subject.id,
      property_id: propertyId,
      access_level: accessLevel
    }).onConflict((conflict) => conflict.columns(["subject_id", "property_id"]).doUpdateSet({
      access_level: accessLevel
    })).execute();
  } finally {
    await db.destroy();
  }
}

async function makeReservedOrderOverdue(orderId: string, businessDate: string) {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("orders")
        .set({
          arrival_date: addDays(businessDate, -1),
          departure_date: addDays(businessDate, 2)
        })
        .where("id", "=", orderId)
        .where("status", "=", "RESERVED")
        .executeTakeFirstOrThrow();
      const revision = await trx.selectFrom("room_status_revisions")
        .select("revision")
        .where("property_id", "=", propertyId)
        .executeTakeFirstOrThrow();
      await trx.updateTable("room_status_revisions")
        .set({ revision: Number(revision.revision) + 1, updated_at: new Date() })
        .where("property_id", "=", propertyId)
        .execute();
    });
  } finally {
    await db.destroy();
  }
}

async function login(
  page: Page,
  credentials = operator
): Promise<{ board: RoomStatusBoardDto }> {
  await page.goto(process.env.ROOM_STATUS_E2E_BASE_URL ?? "/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(credentials.username);
  await page.getByTestId("login-password").fill(credentials.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  const response = await responsePromise;
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  return {
    board: await response.json() as RoomStatusBoardDto
  };
}

async function expectDesktopGrid(page: Page) {
  const region = page.getByRole("region", { name: /房态二维网格/ });
  await expect(region).toBeVisible();
  await expect(region.getByRole("grid")).toBeVisible();
  return region;
}

function roomCell(page: Page, unitId: string, serviceDate: string): Locator {
  return page.locator(
    `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
  );
}

function roomRow(page: Page, unitId: string): Locator {
  return page.locator(`[data-room-status-row="${unitId}"]`);
}

async function assertNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ["violations"] })
    .analyze();
  expect(results.violations).toEqual([]);
}

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function tabTo(page: Page, target: Locator, description: string, maximumTabs = 320) {
  await expect(target, description).toBeVisible();
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach ${description} after ${maximumTabs} Tab presses`);
}

async function assertFocusedCellAboveMobileNavigation(page: Page) {
  const focusedCell = page.locator("[data-room-status-cell='true']:focus");
  const navigation = page.locator(".mobile-navigation");
  await expect(focusedCell).toHaveCount(1);
  await expect(navigation).toBeVisible();
  expect(await focusedCell.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  const geometry = await page.evaluate(() => {
    const cell = document.querySelector<HTMLElement>("[data-room-status-cell='true']:focus");
    const nav = document.querySelector<HTMLElement>(".mobile-navigation");
    if (!cell || !nav) return null;
    return { cellBottom: cell.getBoundingClientRect().bottom, navigationTop: nav.getBoundingClientRect().top };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.cellBottom).toBeLessThanOrEqual(geometry!.navigationTop - 4);
}

async function keyboardPreviewAndConfirm(
  page: Page,
  reason: string,
  expectedEffect: readonly string[],
  onBeforeConfirm?: () => void
) {
  const previewButton = page.getByTestId("create-command-preview");
  await tabTo(page, previewButton, "生成服务端预览按钮");
  await page.keyboard.press("Enter");
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: commandUiWaitMs });
  for (const value of expectedEffect) await expect(effect).toContainText(value, { timeout: commandUiWaitMs });

  const reasonNote = page.getByTestId("reason-note");
  await tabTo(page, reasonNote, "确认原因说明");
  await page.keyboard.type(reason);
  const confirmButton = page.getByTestId("confirm-command");
  await expect(confirmButton).toBeEnabled();
  await tabTo(page, confirmButton, "高风险确认按钮");
  onBeforeConfirm?.();
  await page.keyboard.press("Enter");
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toContainText("业务写入已提交", { timeout: commandUiWaitMs });
  await expect(receipt).toContainText("EXECUTED", { timeout: commandUiWaitMs });
  return receipt;
}

async function previewAndConfirm(page: Page, reason: string, expectedEffect: readonly string[]) {
  await page.getByTestId("create-command-preview").click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: commandUiWaitMs });
  for (const value of expectedEffect) await expect(effect).toContainText(value, { timeout: commandUiWaitMs });
  if (await page.evaluate(() => innerWidth < 576)) {
    const formControls = page.locator(".room-status-page input, .room-status-page select, .room-status-page textarea");
    for (let index = 0; index < await formControls.count(); index += 1) {
      expect(parseFloat(await formControls.nth(index).evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    }
  }
  await expect(page.getByTestId("confirm-command")).toBeDisabled();
  await page.getByTestId("reason-note").fill(reason);
  await page.getByTestId("confirm-command").click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible({ timeout: commandUiWaitMs });
  const businessOrderReceipt = receipt.getByRole("heading", { name: /^(会员)?住宿订单已创建$/ });
  if (await businessOrderReceipt.count()) {
    await expect(businessOrderReceipt).toBeVisible();
    await expect(receipt).not.toContainText(/EXECUTED|Receipt|业务写入已提交/);
  } else {
    await expect(receipt).toContainText("业务写入已提交", { timeout: commandUiWaitMs });
    await expect(receipt).toContainText("EXECUTED", { timeout: commandUiWaitMs });
  }
  return receipt;
}

async function finishReceipt(page: Page) {
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByTestId("command-receipt")).toBeHidden();
}

async function createFreeStayForToday(page: Page, options: {
  unitId: string;
  guest: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
}) {
  await page.getByTestId("room-status-unit-select").selectOption(options.unitId);
  await page.getByLabel("入住日期", { exact: true }).fill(options.arrivalDate);
  await page.getByLabel("退房日期", { exact: true }).fill(options.departureDate);
  await expect(page.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  const freeQuoteResponse = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/v1/quotes") return false;
    const payload = response.request().postDataJSON() as { stayType?: string };
    return payload.stayType === "FREE" && response.status() === 200;
  });
  await page.getByRole("button", { name: "创建免费入住", exact: true }).click();
  await freeQuoteResponse;
  await expect(page.getByTestId("free-stay-reason")).toBeVisible();
  await page.getByTestId("primary-guest-name").fill(options.guest);
  await page.getByTestId("free-stay-reason").fill(`Room-status OPEN_ORDER fixture: ${options.guest}`);
  await page.getByTestId("booking-channel-code").selectOption("WECOM");
  const createOrder = page.getByTestId("create-order");
  await expect(createOrder).toBeDisabled();
  await expect(page.getByTestId("command-effect")).toHaveCount(0);
  await page.getByTestId("primary-guest-nickname").fill(options.nickname);
  await createOrder.click();
  const receipt = await previewAndConfirm(page, `Create room-status OPEN_ORDER fixture ${options.guest}`, [
    options.guest,
    options.nickname,
    "企业微信"
  ]);
  const orderLink = receipt.getByRole("link", { name: /查看订单/ });
  await expect(orderLink).toBeVisible();
  const orderHref = await orderLink.getAttribute("href");
  const orderId = orderHref?.match(/^\/orders\/(order_[^/?#]+)$/)?.[1];
  expect(orderId).toBeTruthy();
  const refreshedBoard = roomStatusResponse(page);
  await finishReceipt(page);
  await refreshedBoard;
  return orderId!;
}

test.beforeAll(async () => {
  await ensureReadOnlyPrincipal();
});

test("desktop room-status matrix drives a typed Block journey and restores the workbench", async ({ page, browser }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status workbench coverage");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { board } = await login(page);
  const gridRegion = await expectDesktopGrid(page);
  const observerContext = await browser.newContext({
    baseURL: process.env.ROOM_STATUS_E2E_BASE_URL ?? "http://127.0.0.1:4173",
    viewport: { width: 1024, height: 768 }
  });
  const observerPage = await observerContext.newPage();
  await login(observerPage);
  await expectDesktopGrid(observerPage);

  expect(board.propertyId).toBe(propertyId);
  expect(board.projectionState).toBe("READY");
  expect(board.accessLevel).toBe("WRITE");
  expect(board.rooms).toHaveLength(44);
  expect(board.rooms.reduce((count, room) => count + room.children.length, 0)).toBe(46);
  expect(board.dates.length).toBeGreaterThan(0);
  expect(board.dates.length).toBeLessThanOrEqual(31);
  await expect(gridRegion.getByRole("row")).toHaveCount(45);
  await expect(page.getByText("投影完整", { exact: true })).toBeVisible();

  const today = todayInTimeZone("Asia/Shanghai");
  const arrivalDate = addDays(today, 9);
  const departureDate = addDays(today, 11);
  const roomId = "unit_room_104";
  const bedAId = "unit_room_104_bed_a";
  const bedBId = "unit_room_104_bed_b";

  const expandRoom = roomRow(page, roomId).getByRole("button", { name: /^展开.*床位$/ });
  await expect(expandRoom).toBeVisible();
  await expandRoom.click();
  await expect(roomRow(page, bedAId)).toBeVisible();
  await expect(roomRow(page, bedBId)).toBeVisible();

  const bedAStart = roomCell(page, bedAId, arrivalDate);
  await expect(bedAStart).toHaveAccessibleName(/104.*床位 A.*可售.*可以安排/);
  await bedAStart.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("[data-room-status-cell='true']:focus")).toHaveAttribute("data-service-date", addDays(arrivalDate, 1));
  expect(await page.locator("[data-room-status-cell='true']:focus").evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(arrivalDate);
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(departureDate);
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAttribute("aria-selected", "true");
  await expect(roomCell(page, bedAId, addDays(arrivalDate, 1))).toHaveAttribute("aria-selected", "true");

  const actionRegion = page.locator(".room-status-context-actions");
  for (const action of ["创建正常住宿订单", "创建免费入住", "放置维修锁房"]) {
    await expect(actionRegion.getByRole("button", { name: action, exact: true })).toBeEnabled();
  }

  const maintenanceTrigger = actionRegion.getByRole("button", { name: "放置维修锁房", exact: true });
  await tabTo(page, maintenanceTrigger, "放置维修锁房动作");
  await page.keyboard.press("Enter");
  const businessReason = `E2E room-status parent-child block ${arrivalDate}`;
  const maintenanceReason = page.getByLabel("维修原因");
  await tabTo(page, maintenanceReason, "维修原因");
  await page.keyboard.type(businessReason);
  const continueButton = page.getByRole("button", { name: "继续生成 Preview", exact: true });
  await tabTo(page, continueButton, "继续生成 Preview 按钮");
  await page.keyboard.press("Enter");
  let propagationStartedAt = 0;
  let propagatedResponse: ReturnType<Page["waitForResponse"]> | undefined;
  const receipt = await keyboardPreviewAndConfirm(page, "Confirm the E2E maintenance block", [
    "104-A",
    `[${arrivalDate}, ${departureDate})`,
    businessReason
  ], () => {
    propagationStartedAt = performance.now();
    propagatedResponse = observerPage.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (url.pathname !== `/api/v1/properties/${propertyId}/room-status` || response.status() !== 200) return false;
      const candidate = await response.json() as RoomStatusBoardDto;
      return candidate.rooms.flatMap((room) => [room, ...room.children])
        .some((unit) => unit.intervals.some((interval) => interval.reason === businessReason));
    });
  });
  await expect(receipt.locator("code").filter({ hasText: /^maint_/ })).toHaveCount(1);
  expect(propagatedResponse).toBeDefined();
  const observerResponse = await propagatedResponse!;
  const observerBoard = await observerResponse.json() as RoomStatusBoardDto;
  await expect(observerPage.locator(".room-status-freshness")).toContainText(`revision ${observerBoard.revision}`);
  expect(performance.now() - propagationStartedAt, "second workbench revision visibility").toBeLessThanOrEqual(5_000);
  const bedAInterval = roomRow(page, bedAId).locator(".room-status-interval-maintenance");
  const parentInterval = roomRow(page, roomId).locator(".room-status-interval-maintenance");
  await expect(receipt).toBeVisible();
  await expect(bedAInterval, "the committing workbench refreshes while its Receipt remains open").toBeVisible();
  await expect(parentInterval).toBeVisible();
  const finishButton = page.getByRole("button", { name: "完成", exact: true });
  await tabTo(page, finishButton, "Receipt 完成按钮");
  await page.keyboard.press("Enter");
  await expect(receipt).toBeHidden();
  await expect(bedAStart).toBeFocused();
  expect(await bedAStart.evaluate((element) => element.matches(":focus-visible"))).toBe(true);

  await expect(bedAInterval).toBeVisible();
  await expect(parentInterval).toBeVisible();
  await expect(bedAInterval).toHaveAccessibleName(/维修/);
  await expect(parentInterval).toHaveAccessibleName(/维修/);
  await expect(roomCell(page, roomId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排.*已有住宿，不能重复安排/);
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排.*已有住宿，不能重复安排/);
  await expect(roomCell(page, bedBId, arrivalDate)).toHaveAccessibleName(/可售.*可以安排/);

  await bedAStart.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  const relatedSources = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "选区关联来源事实" })
  });
  await expect(relatedSources).toContainText("维修");
  await expect(relatedSources).toContainText("住宿日期");
  await expect(relatedSources).not.toContainText(/MAINTENANCE|unit_room_|Block|Receipt/);

  await bedAInterval.click();
  const sourceSection = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "来源事实" })
  });
  await expect(sourceSection).toContainText("维修");
  await expect(sourceSection).toContainText(businessReason);
  await expect(sourceSection).toContainText("住宿日期");
  await expect(sourceSection).not.toContainText(/unit_room_|Block|Claim/);
  const conflictSection = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "日期占用" })
  });
  await expect(conflictSection.locator(".room-status-conflict-list > li")).toHaveCount(1);
  await expect(conflictSection).toContainText("已有住宿，不能重复安排");
  await expect(conflictSection).not.toContainText(/unit_room_|Block|Claim|conflict/i);
  await page.screenshot({ path: testInfo.outputPath("room-status-desktop-typed-source-active.png"), fullPage: true });

  const bedBStart = roomCell(page, bedBId, arrivalDate);
  await bedBStart.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  await actionRegion.getByRole("button", { name: "放置维修锁房", exact: true }).click();
  const siblingReason = `E2E sibling bed block ${arrivalDate}`;
  await page.getByLabel("维修原因").fill(siblingReason);
  await page.getByRole("button", { name: "继续生成 Preview", exact: true }).click();
  const siblingReceipt = await previewAndConfirm(page, "Confirm simultaneous sibling-bed occupancy", [
    "104-B",
    `[${arrivalDate}, ${departureDate})`,
    siblingReason
  ]);
  await expect(siblingReceipt.locator("code").filter({ hasText: /^maint_/ })).toHaveCount(1);
  await finishReceipt(page);

  const bedBInterval = roomRow(page, bedBId).locator(".room-status-interval-maintenance");
  await expect(bedAInterval).toBeVisible();
  await expect(bedBInterval).toBeVisible();
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排/);
  await expect(roomCell(page, bedBId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排/);

  const parentStart = roomCell(page, roomId, arrivalDate);
  await parentStart.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(conflictSection.locator(".room-status-conflict-list > li")).toHaveCount(2);
  await expect(conflictSection).toContainText("已有住宿，不能重复安排");
  await expect(conflictSection).not.toContainText(/unit_room_|Block|Claim|conflict/i);
  await expect(actionRegion).toContainText("服务端未为当前对象下发可执行动作");
  for (const action of ["创建正常住宿订单", "创建免费入住", "放置维修锁房"]) {
    await expect(actionRegion.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId("confirm-command")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("room-status-desktop-blocking-conflict.png"), fullPage: true });

  await bedBStart.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  await bedBInterval.click();
  await actionRegion.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  const siblingReleaseReceipt = await previewAndConfirm(page, "Release the sibling-bed E2E maintenance interval", [
    "RELEASE_MAINTENANCE",
    `[${arrivalDate}, ${departureDate})`
  ]);
  await expect(siblingReleaseReceipt.locator("code").filter({ hasText: /^maint_/ })).toHaveCount(1);
  await finishReceipt(page);
  await expect(bedBInterval).toHaveCount(0);
  await expect(bedAInterval).toBeVisible();

  await bedAStart.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Shift+ArrowRight");
  await bedAInterval.click();
  await actionRegion.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  const releaseReceipt = await previewAndConfirm(page, "Release the first E2E maintenance interval", [
    "RELEASE_MAINTENANCE",
    `[${arrivalDate}, ${departureDate})`
  ]);
  await expect(releaseReceipt.locator("code").filter({ hasText: /^maint_/ })).toHaveCount(1);
  await finishReceipt(page);
  await expect(bedAInterval).toHaveCount(0);
  await expect(parentInterval).toHaveCount(0);
  await expect(roomCell(page, roomId, arrivalDate)).toHaveAccessibleName(/可售.*可以安排/);
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAccessibleName(/可售.*可以安排/);

  const search = page.getByLabel("搜索房间或床位");
  await search.fill("104");
  await expect(page.getByText("1 间房", { exact: true })).toBeVisible();
  await roomCell(page, bedBId, arrivalDate).click();

  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expectDesktopGrid(page);
  await expect(page.getByRole("status").filter({ hasText: /已恢复上次房态范围|房态 revision 已变化/ })).toBeVisible();
  await expect(page.getByLabel("搜索房间或床位")).toHaveValue("104");
  await expect(roomRow(page, roomId).getByRole("button", { name: /^收起.*床位$/ })).toBeVisible();
  await expect(roomCell(page, bedBId, arrivalDate)).toHaveAttribute("aria-selected", "true");
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("room-status-desktop-typed-source.png"), fullPage: true });

  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  const corruptedSnapshotSaved = await page.evaluate(() => {
    const key = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .find((candidate) => candidate?.startsWith("qintopia.room-status-view.v1:"));
    if (!key) return false;
    const snapshot = JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: { expandedRoomIds?: string[] } };
    if (!snapshot.state) return false;
    snapshot.state.expandedRoomIds = [];
    sessionStorage.setItem(key, JSON.stringify(snapshot));
    return true;
  });
  expect(corruptedSnapshotSaved).toBe(true);
  const fallbackResponse = roomStatusResponse(page);
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await fallbackResponse;
  await expectDesktopGrid(page);
  await expect(page.locator(".room-status-return-notice")).toContainText("原焦点或选区在当前筛选、展开、分页或日期窗口中已不可见");
  await expect(roomRow(page, roomId).getByRole("button", { name: /^展开.*床位$/ })).toBeVisible();
  await expect(roomRow(page, bedBId)).toHaveCount(0);
  await expect(page.locator("[data-room-status-cell='true'][aria-selected='true']")).toHaveCount(0);
  await expect(roomCell(page, roomId, board.dates[0]!)).toBeFocused();
  await observerContext.close();
});

test("property switching flushes the latest debounced restoration snapshot", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop property-switch restoration coverage");
  await enableRestorationSwitchProperty();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await expectDesktopGrid(page);

    const switchedBoard = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/v1/properties/${restorationSwitchProperty.id}/room-status`
        && response.status() === 200;
    });
    const expandedRoomId = await page.evaluate(async (nextPropertyId) => {
      const expandButton = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded='false']")]
        .find((button) => button.getAttribute("aria-label")?.endsWith("床位"));
      const row = expandButton?.closest<HTMLElement>("[data-room-status-row]");
      const propertySelect = document.querySelector<HTMLSelectElement>("[data-testid='property-select']");
      if (!expandButton || !row?.dataset.roomStatusRow || !propertySelect) {
        throw new Error("room-status expansion and property controls are required");
      }
      expandButton.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
      if (expandButton.getAttribute("aria-expanded") !== "true") {
        throw new Error("room expansion did not commit before the property switch");
      }
      propertySelect.value = nextPropertyId;
      propertySelect.dispatchEvent(new Event("change", { bubbles: true }));
      return row.dataset.roomStatusRow;
    }, restorationSwitchProperty.id);
    await switchedBoard;
    await expect(page.getByTestId("property-select")).toHaveValue(restorationSwitchProperty.id);

    const restoredExpansion = await page.evaluate(({ originalPropertyId, roomId }) => {
      const suffix = `:${encodeURIComponent(originalPropertyId)}`;
      const key = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
        .find((candidate) => candidate?.startsWith("qintopia.room-status-view.v1:") && candidate.endsWith(suffix));
      if (!key) return false;
      const snapshot = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
        state?: { expandedRoomIds?: string[] };
      };
      return snapshot.state?.expandedRoomIds?.includes(roomId) ?? false;
    }, { originalPropertyId: propertyId, roomId: expandedRoomId });
    expect(restoredExpansion).toBe(true);
  } finally {
    await page.close();
    await removeRestorationSwitchProperty();
  }
});

test("split-bed parent cells show occupied-to-total ratio and every guest nickname", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop split-bed occupancy summary coverage");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const room = board.rooms.find((candidate) => candidate.salesMode === "BED_SPLIT"
    && candidate.capacity === 4
    && candidate.children.length >= 4
    && board.dates.some((date) => candidate.children.slice(0, 4)
      .every((child) => child.days.find((day) => day.serviceDate === date)?.available)));
  expect(room, "an available four-bed room is required for occupancy summary coverage").toBeTruthy();
  const serviceDate = board.dates.find((date) => room!.children.slice(0, 4)
    .every((child) => child.days.find((day) => day.serviceDate === date)?.available));
  expect(serviceDate).toBeTruthy();
  const departureDate = addDays(serviceDate!, 1);
  const wholeRoomServiceDate = board.dates.slice(0, 14).find((date) => date !== serviceDate
    && room!.children.every((child) => child.days.find((day) => day.serviceDate === date)?.available));
  expect(wholeRoomServiceDate, "a second visible whole-room date is required").toBeTruthy();
  const occupants = [
    { guest: "Occupancy Legal Name One", nickname: `山风${"甲".repeat(120)}` },
    { guest: "Occupancy Legal Name Two", nickname: "同名住客" },
    { guest: "Occupancy Legal Name Three", nickname: "同名住客" },
    { guest: "Occupancy Legal Name Four", nickname: "北辰" }
  ];
  const parentRow = roomRow(page, room!.id);
  await expect(parentRow).toContainText("整房/单床");
  await expect(parentRow).not.toContainText("支持整房及单床销售");
  const initialRowBounds = await parentRow.boundingBox();
  expect(initialRowBounds).toBeTruthy();

  for (let index = 0; index < occupants.length; index += 1) {
    const occupant = occupants[index]!;
    const bed = room!.children[index]!;
    await createFreeStayForToday(page, {
      unitId: bed.id,
      guest: occupant.guest,
      nickname: occupant.nickname,
      arrivalDate: serviceDate!,
      departureDate
    });
    const parentCell = roomCell(page, room!.id, serviceDate!);
    await expect(parentCell).toHaveAttribute("data-bed-occupancy-ratio", `${index + 1}/4`);
    const visibleOccupants = occupants.slice(0, index + 1).map((candidate) => candidate.nickname);
    const visibleLines = Array.from({ length: Math.ceil(visibleOccupants.length / 2) }, (_, lineIndex) =>
      visibleOccupants.slice(lineIndex * 2, lineIndex * 2 + 2).join("、"));
    await expect(parentCell.locator(".room-status-bed-occupants > span")).toHaveText(visibleLines);
    await expect(parentCell.locator(".room-status-bed-occupants")).not.toContainText(/\+[123]/);
  }

  const parentCell = roomCell(page, room!.id, serviceDate!);
  await expect(parentCell).toHaveText(/4\/4/);
  await expect(parentCell).not.toHaveAttribute("title");
  await expect(parentCell).toHaveAccessibleName(/已占 4\/4.*山风.*同名住客.*同名住客.*北辰/);
  await expect(parentCell).not.toHaveAccessibleName(/阻断|Claim|order_/i);
  await parentCell.hover();
  await expect(page.getByRole("tooltip")).toContainText("已占 4/4");
  await expect(page.getByRole("tooltip")).toContainText("山风");
  await expect(page.getByRole("tooltip")).toContainText("同名住客");
  await expect(page.getByRole("tooltip")).toContainText("北辰");
  await expect(page.getByRole("tooltip")).toContainText("免费入住");
  await expect(page.getByRole("tooltip")).toContainText(`${Number(serviceDate!.slice(5, 7))}月${Number(serviceDate!.slice(8, 10))}日`);
  await expect(page.getByRole("tooltip")).not.toContainText(/阻断|Claim|order_/i);
  const gridScroll = page.locator(".room-status-grid-scroll");
  const horizontalScroll = await gridScroll.evaluate((element) => {
    const before = element.scrollLeft;
    element.scrollLeft = before + 120;
    return { before, after: element.scrollLeft };
  });
  expect(horizontalScroll.after).toBeGreaterThan(horizontalScroll.before);
  await expect(page.getByRole("tooltip"), "scrolling closes a fixed tooltip before it can detach from its cell").toBeHidden();
  await gridScroll.evaluate((element, left) => {
    element.scrollLeft = left;
  }, horizontalScroll.before);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.move(1, 1);
  await parentCell.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await expect(page.getByRole("tooltip"), "page scrolling closes a fixed tooltip before it can detach from its cell").toBeHidden();
  await page.mouse.move(1, 1);
  await parentCell.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.setViewportSize({ width: 1430, height: 900 });
  await expect(page.getByRole("tooltip"), "viewport resize closes a fixed tooltip before it can detach from its cell").toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(1, 1);
  await parentCell.hover();
  await expect(parentCell.locator(".room-status-bed-occupants > span")).toHaveText([
    occupants.slice(0, 2).map((occupant) => occupant.nickname).join("、"),
    occupants.slice(2, 4).map((occupant) => occupant.nickname).join("、")
  ]);
  await expect(parentCell.locator(".room-status-bed-occupants")).not.toContainText(/\+[123]/);
  await expect(parentCell).toContainText("已预订");
  const occupiedBounds = await roomRow(page, room!.id).boundingBox();
  expect(occupiedBounds!.height).toBeGreaterThan(initialRowBounds!.height);

  await page.mouse.move(1, 1);
  await page.locator(".room-status-grid-scroll").focus();
  await parentCell.focus();
  await expect(page.getByRole("tooltip")).toContainText("已占 4/4");
  expect((await roomRow(page, room!.id).boundingBox())!.height).toBe(occupiedBounds!.height);
  await page.keyboard.press("Space");
  await expect(parentCell).toHaveAttribute("aria-selected", "true");
  await parentCell.hover();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  await expect(page.getByRole("tooltip"), "focused trigger keeps its tooltip open after pointer leave").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip"), "first Escape closes the tooltip before clearing selection").toBeHidden();
  await expect(parentCell).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(parentCell).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(parentCell).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("北辰");
  expect((await roomRow(page, room!.id).boundingBox())!.height).toBe(occupiedBounds!.height);

  await page.setViewportSize({ width: 1440, height: 260 });
  await parentCell.scrollIntoViewIfNeeded();
  await parentCell.hover();
  const constrainedTooltip = page.getByTestId("bed-occupancy-tooltip");
  await expect(constrainedTooltip).toBeVisible();
  const tooltipGeometry = await constrainedTooltip.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(tooltipGeometry.top).toBeGreaterThanOrEqual(11);
  expect(tooltipGeometry.bottom).toBeLessThanOrEqual(249);
  expect(tooltipGeometry.scrollHeight).toBeGreaterThan(tooltipGeometry.clientHeight);
  await page.keyboard.press("Tab");
  await expect(constrainedTooltip, "the long occupant list is keyboard reachable from its trigger cell").toBeFocused();
  await page.keyboard.press("PageDown");
  await expect.poll(() => constrainedTooltip.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(constrainedTooltip, "scrolling the tooltip itself keeps the anchored tooltip open").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(constrainedTooltip).toBeHidden();
  await expect(parentCell).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(1, 1);

  await parentCell.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  const forwardTabProbe = await parentCell.evaluate((trigger) => {
    const selector = [
      "a[href]",
      "area[href]",
      "button",
      "input",
      "select",
      "textarea",
      "iframe",
      "[contenteditable='true']",
      "[tabindex]"
    ].join(",");
    const tooltip = document.querySelector<HTMLElement>("[data-testid='bed-occupancy-tooltip']");
    const tabStops = [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => {
      if (tooltip?.contains(element) || element.tabIndex < 0 || element.matches(":disabled")) return false;
      if (element.closest("[hidden], [inert]")) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    });
    const next = tabStops[tabStops.indexOf(trigger as HTMLElement) + 1];
    if (!next) return false;
    next.dataset.forwardTabProbe = "true";
    return true;
  });
  expect(forwardTabProbe, "the occupied trigger must have a following logical tab stop").toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip"), "forward Tab leaves the tooltip without wrapping to the page start").toBeHidden();
  await expect(page.locator("[data-forward-tab-probe='true']")).toBeFocused();

  const wholeRoomNickname = "云岫";
  await createFreeStayForToday(page, {
    unitId: room!.id,
    guest: "Whole-room Legal Name",
    nickname: wholeRoomNickname,
    arrivalDate: wholeRoomServiceDate!,
    departureDate: addDays(wholeRoomServiceDate!, 1)
  });
  const wholeRoomCell = roomCell(page, room!.id, wholeRoomServiceDate!);
  await expect(wholeRoomCell.locator(".room-status-whole-room-occupants")).toHaveText(wholeRoomNickname);
  await expect(wholeRoomCell.locator(".room-status-whole-room-count")).toHaveText("1人");
  await expect(roomRow(page, room!.id).locator(".room-status-interval").filter({ hasText: wholeRoomNickname })).toHaveCount(0);

  await page.mouse.move(1, 1);
  const expandBeds = roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='false']");
  await expect(expandBeds).toBeVisible();
  await expandBeds.click();
  for (let index = 0; index < occupants.length; index += 1) {
    const childRow = roomRow(page, room!.children[index]!.id);
    await expect(roomCell(page, room!.children[index]!.id, serviceDate!)).toHaveAccessibleName(
      new RegExp(occupants[index]!.nickname)
    );
    await expect(childRow.locator(".room-status-interval").filter({
      hasText: occupants[index]!.nickname
    })).toHaveCount(0);
  }
  await parentCell.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("room-status-bed-occupancy-nicknames.png") });
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);

  const collapseBeds = roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='true']");
  await collapseBeds.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("tooltip")).toBeHidden();

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileOccupancy = page.locator(".room-status-mobile-occupancies li")
    .filter({ hasText: room!.code })
    .filter({ hasText: "4/4" });
  await expect(mobileOccupancy).toContainText("4/4");
  await expect(mobileOccupancy.locator("[data-mobile-bed-occupant-line]")).toHaveText([
    occupants.slice(0, 2).map((occupant) => occupant.nickname).join("、"),
    occupants.slice(2, 4).map((occupant) => occupant.nickname).join("、")
  ]);
  await expect(mobileOccupancy).not.toContainText(/\+[123]|order_|Claim|阻断/i);
  await assertNoPageOverflow(page);

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(mobileOccupancy.locator("[data-mobile-bed-occupant-line]")).toHaveText([
    occupants.slice(0, 2).map((occupant) => occupant.nickname).join("、"),
    occupants.slice(2, 4).map((occupant) => occupant.nickname).join("、")
  ]);
  await assertNoPageOverflow(page);
});

test("desktop range selection, field errors, filtered-empty and range-loading fail closed", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status interaction-state coverage");
  test.setTimeout(120_000);
  const { board } = await login(page);
  await expectDesktopGrid(page);

  let candidate: { unitId: string; arrivalDate: string; departureDate: string } | undefined;
  for (const room of board.rooms) {
    for (let index = 0; index <= board.dates.length - 3; index += 1) {
      const dates = board.dates.slice(index, index + 3);
      if (dates.length === 3 && dates.every((date) => room.days.find((day) => day.serviceDate === date)?.available)) {
        candidate = { unitId: room.id, arrivalDate: dates[0]!, departureDate: addDays(dates[2]!, 1) };
        break;
      }
    }
    if (candidate) break;
  }
  expect(candidate, "three consecutive available room nights are required for mouse selection").toBeTruthy();

  const firstCell = roomCell(page, candidate!.unitId, candidate!.arrivalDate);
  const finalServiceDate = addDays(candidate!.departureDate, -1);
  const finalCell = roomCell(page, candidate!.unitId, finalServiceDate);
  await finalCell.scrollIntoViewIfNeeded();
  const firstBox = await firstCell.boundingBox();
  const finalBox = await finalCell.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(finalBox).not.toBeNull();
  await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height - 8);
  await page.mouse.down();
  await page.mouse.move(finalBox!.x + finalBox!.width / 2, finalBox!.y + finalBox!.height - 8, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(candidate!.arrivalDate);
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(candidate!.departureDate);

  await page.getByLabel("退房日期", { exact: true }).fill(candidate!.arrivalDate);
  const selectionDateError = page.getByTestId("room-status-selection-date-error");
  await expect(selectionDateError).toBeVisible();
  const selectionErrorId = await selectionDateError.getAttribute("id");
  expect(selectionErrorId).toBeTruthy();
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveAttribute("aria-describedby", selectionErrorId!);
  await page.getByLabel("退房日期", { exact: true }).fill(candidate!.departureDate);
  await expect(selectionDateError).toBeHidden();

  const search = page.getByLabel("搜索房间或床位");
  await search.focus();
  await page.keyboard.type("不存在的房源");
  const filteredEmpty = page.locator("[data-room-status-state='filtered-empty']");
  await expect(filteredEmpty).toBeVisible();
  await expect(page.locator("[data-room-status-cell='true'][aria-selected='true']")).toHaveCount(0);
  await expect(page.locator("[data-room-status-cell='true']:focus")).toHaveCount(0);
  await expect(page.locator(".room-status-context-actions").getByRole("button")).toHaveCount(0);
  const clearFilters = filteredEmpty.getByRole("button", { name: "清除筛选", exact: true });
  await clearFilters.focus();
  await page.keyboard.press("Enter");
  await expect(filteredEmpty).toBeHidden();
  await expect(search).toBeFocused();

  const toolbarArrival = page.getByTestId("arrival-date");
  const toolbarDeparture = page.getByTestId("departure-date");
  await toolbarDeparture.fill(board.range.arrivalDate);
  const toolbarDateError = page.getByTestId("room-status-range-error");
  await expect(toolbarDateError).toBeFocused();
  const toolbarErrorId = await toolbarDateError.getAttribute("id");
  expect(toolbarErrorId).toBeTruthy();
  await expect(toolbarArrival).toHaveAttribute("aria-invalid", "true");
  await expect(toolbarDeparture).toHaveAttribute("aria-describedby", toolbarErrorId!);
  await toolbarDeparture.fill(board.range.departureDate);
  await expect(toolbarDateError).toBeHidden();

  const requestedDeparture = addDays(board.range.departureDate, 1);
  let releaseRequest = () => {};
  let markRequestSeen = () => {};
  let targetRequestCount = 0;
  const requestSeen = new Promise<void>((resolve) => { markRequestSeen = resolve; });
  const heldRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const routePattern = `**/api/v1/properties/${propertyId}/room-status*`;
  await page.route(routePattern, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("arrivalDate") === board.range.arrivalDate
      && url.searchParams.get("departureDate") === requestedDeparture) {
      targetRequestCount += 1;
      markRequestSeen();
      await heldRequest;
    }
    await route.continue();
  });

  try {
    const committedRange = page.getByTestId("room-status-board-range");
    const response = roomStatusResponse(page, {
      arrivalDate: board.range.arrivalDate,
      departureDate: requestedDeparture
    });
    await toolbarDeparture.fill(requestedDeparture);
    await requestSeen;
    await expect(page.getByTestId("room-status-range-loading")).toBeVisible();
    await expect(page.locator(".room-status-toolbar")).toContainText("数据时点");
    await expect(page.locator(".room-status-toolbar")).toContainText("正在载入新范围，旧事实不可操作");
    await expect(committedRange).toHaveAttribute("data-range-departure", board.range.departureDate);
    await expect(page.locator(".room-status-workspace")).toHaveAttribute("inert", "");
    await expect(page.locator(".room-status-context-actions").getByRole("button", { name: /创建|放置|释放|完成清洁/ })).toHaveCount(0);
    await page.waitForTimeout(4_250);
    expect(targetRequestCount, "the 4-second poll must coalesce behind an in-flight range query").toBe(1);
    releaseRequest();
    await response;
    await expect(committedRange).toHaveAttribute("data-range-departure", requestedDeparture, { timeout: 15_000 });
    await expect(page.getByTestId("room-status-range-loading")).toBeHidden();
    await expect(page.locator(".room-status-workspace")).not.toHaveAttribute("inert", "");
  } finally {
    releaseRequest();
    await page.unroute(routePattern);
  }
});

test("desktop stale and unknown states fail closed without mocked room-status data", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status network-state coverage");
  await login(page);
  await expectDesktopGrid(page);
  const today = todayInTimeZone("Asia/Shanghai");
  await roomCell(page, "unit_room_201", addDays(today, 2)).click();
  await expect(page.getByRole("button", { name: "创建正常住宿订单", exact: true })).toBeVisible();

  try {
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "刷新房态", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "当前房态已陈旧或刷新失败" })).toBeVisible();
    await expect(page.locator(".room-status-context-actions")).toContainText("服务端未为当前对象下发可执行动作");
    await expect(page.getByRole("button", { name: "创建正常住宿订单", exact: true })).toHaveCount(0);

    await page.context().setOffline(false);
    const refreshed = roomStatusResponse(page);
    await page.getByRole("button", { name: "刷新房态", exact: true }).click();
    await refreshed;
    await expect(page.getByRole("alert").filter({ hasText: "当前房态已陈旧或刷新失败" })).toBeHidden();

    await page.getByRole("link", { name: "订单", exact: true }).click();
    await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await page.getByRole("link", { name: "房态", exact: true }).click();
    await expect(page.getByText("状态未知，未显示为可售", { exact: true })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);

    await page.context().setOffline(false);
    const recovered = roomStatusResponse(page);
    await page.getByRole("button", { name: "重试查询", exact: true }).click();
    await recovered;
    await expectDesktopGrid(page);
    await expect(page.getByText("状态未知，未显示为可售", { exact: true })).toBeHidden();
  } finally {
    await page.context().setOffline(false);
  }
});

test("a real delayed 403 clears the board, command draft, restoration and stable references", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop delayed permission-revocation coverage");
  test.setTimeout(120_000);
  await ensureRevocationPrincipal();
  let countRoomStatusRequest: ((request: Request) => void) | undefined;
  try {
    const { board } = await login(page, revocationOperator);
    await expectDesktopGrid(page);
    const serviceDate = board.dates[Math.min(5, board.dates.length - 1)]!;
    const candidate = board.rooms.find((room) => room.days.some((day) => day.serviceDate === serviceDate && day.available)
      && room.allowedActions.some((action) => action.code === "LOCK_MAINTENANCE" && action.enabled));
    expect(candidate, "an available room is required for the permission-revocation draft").toBeTruthy();

    await page.getByTestId("room-status-unit-select").selectOption(candidate!.id);
    await page.getByLabel("入住日期", { exact: true }).fill(serviceDate);
    await page.getByLabel("退房日期", { exact: true }).fill(addDays(serviceDate, 1));
    await page.getByRole("button", { name: "放置维修锁房", exact: true }).click();
    const businessReason = `Permission revocation draft ${candidate!.id}`;
    await page.getByLabel("维修原因").fill(businessReason);
    await page.getByRole("button", { name: "继续生成 Preview", exact: true }).click();
    await page.getByTestId("create-command-preview").click();
    await expect(page.getByTestId("command-effect")).toContainText(businessReason);
    const confirmationDraft = "This reason must disappear after the real 403";
    await page.getByTestId("reason-note").fill(confirmationDraft);
    await expect(page.getByRole("dialog")).toBeVisible();

    const deniedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/v1/properties/${propertyId}/room-status` && response.status() === 403;
    });
    let roomStatusRequestCount = 0;
    countRoomStatusRequest = (request) => {
      if (new URL(request.url()).pathname === `/api/v1/properties/${propertyId}/room-status`) roomStatusRequestCount += 1;
    };
    page.on("request", countRoomStatusRequest);
    await setPrincipalPropertyAccess(revocationOperator.username, null);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await deniedResponse;

    await expect(page.getByRole("alert").filter({ hasText: "无权查看当前物业房态" })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("reason-note")).toHaveCount(0);
    await expect(page.getByTestId("command-effect")).toHaveCount(0);
    await expect(page.getByTestId("inventory-command-recovery")).toHaveCount(0);
    await expect(page.locator(".room-status-return-notice")).toHaveCount(0);
    await expect(page.getByText(businessReason, { exact: false })).toHaveCount(0);
    await expect(page.getByText(confirmationDraft, { exact: false })).toHaveCount(0);
    await expect(page.getByText(candidate!.id, { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .some((key) => key?.startsWith("qintopia.room-status-view.v1:")))).toBe(false);
    const requestCountAfterDenial = roomStatusRequestCount;
    await page.waitForTimeout(4_250);
    expect(roomStatusRequestCount, "permission denial must stop automatic room-status polling").toBe(requestCountAfterDenial);
    await expect(page.getByRole("alert").filter({ hasText: "无权查看当前物业房态" })).toBeVisible();
  } finally {
    if (countRoomStatusRequest) page.off("request", countRoomStatusRequest);
    await setPrincipalPropertyAccess(revocationOperator.username, "WRITE");
  }
});

test("a real WRITE to READ downgrade invalidates an open Preview without hiding the board", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop dynamic access-downgrade coverage");
  test.setTimeout(120_000);
  await ensureRevocationPrincipal();
  const businessReason = `Access downgrade Preview ${crypto.randomUUID()}`;
  try {
    const { board } = await login(page, revocationOperator);
    await expectDesktopGrid(page);
    const serviceDate = board.dates[Math.min(6, board.dates.length - 1)]!;
    const candidate = board.rooms.find((room) => room.days.some((day) => day.serviceDate === serviceDate && day.available)
      && room.allowedActions.some((action) => action.code === "LOCK_MAINTENANCE" && action.enabled));
    expect(candidate, "an available room is required for the WRITE to READ downgrade").toBeTruthy();

    await page.getByTestId("room-status-unit-select").selectOption(candidate!.id);
    await page.getByLabel("入住日期", { exact: true }).fill(serviceDate);
    await page.getByLabel("退房日期", { exact: true }).fill(addDays(serviceDate, 1));
    await page.getByRole("button", { name: "放置维修锁房", exact: true }).click();
    await page.getByLabel("维修原因").fill(businessReason);
    await page.getByRole("button", { name: "继续生成 Preview", exact: true }).click();
    const previewResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/v1/command-previews"
      && response.status() === 200
    ));
    await page.getByTestId("create-command-preview").click();
    const previewResponse = await previewResponsePromise;
    const prepared = await previewResponse.json() as {
      preview: { previewId: string; effectHash: string };
    };
    await page.getByTestId("reason-note").fill("The narrowed READ grant must invalidate this open Preview");
    await expect(page.getByTestId("confirm-command")).toBeEnabled();

    await setPrincipalPropertyAccess(revocationOperator.username, "READ");
    const narrowedResponsePromise = page.waitForResponse(async (response) => {
      if (response.request().method() !== "GET"
        || new URL(response.url()).pathname !== `/api/v1/properties/${propertyId}/room-status`
        || response.status() !== 200) return false;
      return ((await response.json()) as RoomStatusBoardDto).accessLevel === "READ";
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const narrowedResponse = await narrowedResponsePromise;
    expect((await narrowedResponse.json() as RoomStatusBoardDto).accessLevel).toBe("READ");

    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByText(`${revocationOperator.displayName} · READ`, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "写入已暂停" })).toBeVisible();
    await expect(page.getByTestId("confirm-command")).toBeDisabled();
    await expect(page.locator(".room-status-context-actions").getByRole("button", { name: /创建|放置|释放|完成清洁/ })).toHaveCount(0);

    const confirmResponse = await page.request.post(`/api/v1/command-previews/${prepared.preview.previewId}/confirm`, {
      headers: {
        "Idempotency-Key": `e2e-access-downgrade-${crypto.randomUUID()}`,
        "X-Correlation-ID": `e2e-access-downgrade-${crypto.randomUUID()}`
      },
      data: {
        propertyId,
        commandType: "LOCK_MAINTENANCE",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "ACCESS_DOWNGRADE", note: "READ access cannot confirm a prior WRITE Preview" }
      }
    });
    expect(confirmResponse.status()).toBe(403);

    const db = createDatabase(e2eDatabaseUrl);
    try {
      const blocks = await db.selectFrom("maintenance_locks")
        .select("id")
        .where("property_id", "=", propertyId)
        .where("reason", "=", businessReason)
        .execute();
      expect(blocks).toHaveLength(0);
    } finally {
      await db.destroy();
    }
    await page.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    await setPrincipalPropertyAccess(revocationOperator.username, "WRITE");
  }
});

test("READ Web principal receives the real projection without business write actions", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop READ authorization coverage");
  test.setTimeout(120_000);
  const { board } = await login(page, readOnlyOperator);
  await expectDesktopGrid(page);
  expect(board.accessLevel).toBe("READ");
  expect(board.rooms.flatMap((room) => [room, ...room.children]).every((unit) => unit.allowedActions.every((action) => action.code === "OPEN_ORDER")
    && unit.intervals.every((interval) => interval.allowedActions.every((action) => action.code === "OPEN_ORDER")))).toBe(true);
  await expect(page.getByText(`${readOnlyOperator.displayName} · READ`, { exact: true })).toBeVisible();

  const today = todayInTimeZone("Asia/Shanghai");
  await roomCell(page, "unit_room_201", addDays(today, 3)).click();
  const actionRegion = page.locator(".room-status-context-actions");
  await expect(actionRegion).toContainText("服务端未为当前对象下发可执行动作");
  for (const action of ["创建正常住宿订单", "创建免费入住", "放置维修锁房"]) {
    await expect(actionRegion.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }
  await assertNoA11yViolations(page);
});

test("room-status responsive layouts keep the matrix bounded through tablet and 200 percent zoom", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "single desktop browser responsive coverage");
  test.setTimeout(120_000);
  const { board } = await login(page);

  for (const viewport of [
    { width: 1440, height: 900, name: "1440" },
    { width: 1024, height: 768, name: "1024" },
    { width: 768, height: 1024, name: "768" }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const gridRegion = await expectDesktopGrid(page);
    const context = page.locator(".room-status-context");
    await expect(context).toBeVisible();
    await assertNoPageOverflow(page);
    expect(await page.locator(".room-status-grid-header").evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
    expect(await page.locator(".room-status-resource-header").evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
    const gridBox = await gridRegion.boundingBox();
    const contextBox = await context.boundingBox();
    expect(gridBox).not.toBeNull();
    expect(contextBox).not.toBeNull();
    if (viewport.width >= 1200) {
      expect(contextBox!.x).toBeGreaterThan(gridBox!.x + gridBox!.width - 2);
    } else {
      expect(contextBox!.y).toBeGreaterThanOrEqual(gridBox!.y + gridBox!.height - 2);
    }
    if (viewport.width === 768) {
      await roomCell(page, board.rooms[0]!.id, board.dates[0]!).focus();
      for (let index = 0; index < 8; index += 1) await page.keyboard.press("ArrowDown");
      await assertFocusedCellAboveMobileNavigation(page);
    }
    await page.screenshot({ path: testInfo.outputPath(`room-status-${viewport.name}.png`), fullPage: true });
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
    screenWidth: 1440,
    screenHeight: 1800
  });
  await page.reload();
  await expectDesktopGrid(page);
  expect(await page.evaluate(() => ({ cssWidth: window.innerWidth, pixelRatio: window.devicePixelRatio })))
    .toEqual({ cssWidth: 720, pixelRatio: 2 });
  await assertNoPageOverflow(page);
  await page.locator("[data-room-status-cell='true']").first().focus();
  for (let index = 0; index < 8; index += 1) await page.keyboard.press("ArrowDown");
  await assertFocusedCellAboveMobileNavigation(page);
  await assertNoA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("room-status-200-percent-zoom.png"), fullPage: true });
});

test("room-status reload LCP and a real 90-night grid stay within the interaction budgets", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status performance coverage");
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const target = window as Window & { __roomStatusLcp?: number; __roomStatusLcpSupported?: boolean };
    target.__roomStatusLcp = 0;
    target.__roomStatusLcpSupported = PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint");
    if (!target.__roomStatusLcpSupported) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) target.__roomStatusLcp = Math.max(target.__roomStatusLcp ?? 0, entry.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  await login(page);

  const supported = await page.evaluate(() => (window as Window & { __roomStatusLcpSupported?: boolean }).__roomStatusLcpSupported === true);
  test.skip(!supported, "Chromium did not expose the buffered largest-contentful-paint observer");
  const lcpSamples: number[] = [];
  for (let sample = 0; sample < 4; sample += 1) {
    const response = roomStatusResponse(page);
    await page.reload();
    await response;
    await expectDesktopGrid(page);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(
      () => page.evaluate(() => (window as Window & { __roomStatusLcp?: number }).__roomStatusLcp ?? 0),
      { timeout: 2_500, message: `reload ${sample + 1} should publish an LCP entry` }
    ).toBeGreaterThan(0);
    lcpSamples.push(await page.evaluate(() => (window as Window & { __roomStatusLcp?: number }).__roomStatusLcp ?? 0));
  }
  const sortedLcp = [...lcpSamples].sort((left, right) => left - right);
  const p75 = sortedLcp[Math.ceil(sortedLcp.length * 0.75) - 1]!;
  expect(p75, `LCP samples: ${lcpSamples.map((value) => value.toFixed(1)).join(", ")}`).toBeLessThanOrEqual(2_500);

  const today = todayInTimeZone("Asia/Shanghai");
  const departureDate = addDays(today, 90);
  const response = roomStatusResponse(page, { arrivalDate: today, departureDate });
  const startedAt = performance.now();
  await page.getByTestId("departure-date").fill(departureDate);
  await response;
  const committedRange = page.getByTestId("room-status-board-range");
  await expect(committedRange).toHaveAttribute("data-range-arrival", today);
  await expect(committedRange).toHaveAttribute("data-range-departure", departureDate);
  const grid = committedRange.getByRole("region", { name: /房态二维网格/ });
  await expect(grid).toBeVisible();
  const firstCell = grid.locator("[data-room-status-cell='true']").first();
  const firstUnitId = await firstCell.getAttribute("data-unit-id");
  expect(firstUnitId).toBeTruthy();
  await firstCell.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-room-status-cell='true']:focus")).toHaveCount(1);
  const elapsedMs = performance.now() - startedAt;
  expect(elapsedMs, "90-night request through keyboard-interactive grid").toBeLessThanOrEqual(2_000);

  const selectionArrival = addDays(today, 1);
  await page.keyboard.press("Space");
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.locator("[data-room-status-cell='true']:focus"))
      .toHaveAttribute("data-service-date", addDays(today, index + 2));
  }
  await expect(page.locator("[data-room-status-cell='true']:focus"))
    .toHaveAttribute("data-service-date", addDays(today, 15));
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(selectionArrival);
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(addDays(today, 16));
  const crossWindowTarget = roomCell(page, firstUnitId!, addDays(today, 15));
  await expect(crossWindowTarget).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => crossWindowTarget.evaluate((element) => element.matches(":focus-visible")))
    .toBe(true);
});

test("mobile room status uses task tabs and a full-screen fact detail instead of the matrix", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "mobile"), "mobile room-status task coverage");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  let touchCandidate: { unitId: string; startDate: string; endDate: string } | undefined;
  for (const room of board.rooms) {
    for (let index = 0; index < board.dates.length - 1; index += 1) {
      const startDate = board.dates[index]!;
      const endDate = board.dates[index + 1]!;
      if (room.days.find((day) => day.serviceDate === startDate)?.available
        && room.days.find((day) => day.serviceDate === endDate)?.available) {
        touchCandidate = { unitId: room.id, startDate, endDate };
        break;
      }
    }
    if (touchCandidate) break;
  }
  expect(touchCandidate, "two available nights are required for touch selection").toBeTruthy();
  const touchToggle = page.getByRole("button", { name: "触控选区", exact: true });
  await expect(touchToggle).toBeVisible();
  await touchToggle.click();
  const touchStart = roomCell(page, touchCandidate!.unitId, touchCandidate!.startDate);
  const touchEnd = roomCell(page, touchCandidate!.unitId, touchCandidate!.endDate);
  const touchStartBox = await touchStart.boundingBox();
  const touchEndBox = await touchEnd.boundingBox();
  expect(touchStartBox).not.toBeNull();
  expect(touchEndBox).not.toBeNull();
  const touchPointer = {
    pointerId: 73,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: touchStartBox!.x + touchStartBox!.width / 2,
    clientY: touchStartBox!.y + touchStartBox!.height - 8
  };
  await touchStart.dispatchEvent("pointerdown", touchPointer);
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      pointerId: 73,
      pointerType: "touch",
      buttons: 1,
      clientX: x,
      clientY: y
    }));
  }, { x: touchEndBox!.x + touchEndBox!.width / 2, y: touchEndBox!.y + touchEndBox!.height - 8 });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 73,
      pointerType: "touch",
      button: 0,
      buttons: 0
    }));
  });
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(touchCandidate!.startDate);
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(addDays(touchCandidate!.endDate, 1));
  await expect(page.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });

  const today = todayInTimeZone("Asia/Shanghai");
  const arrivalDate = today;
  const departureDate = addDays(today, 3);
  const maintenanceSelectionQuote = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/v1/quotes") return false;
    const payload = response.request().postDataJSON() as { inventoryUnitId?: string; arrivalDate?: string; departureDate?: string; stayType?: string };
    return payload.inventoryUnitId === "unit_room_205"
      && payload.arrivalDate === arrivalDate
      && payload.departureDate === departureDate
      && payload.stayType === undefined
      && response.status() === 200;
  });
  await page.getByTestId("room-status-unit-select").selectOption("unit_room_205");
  await page.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await page.getByLabel("退房日期", { exact: true }).fill(departureDate);
  await maintenanceSelectionQuote;
  await page.getByRole("button", { name: "放置维修锁房", exact: true }).click();
  const businessReason = `E2E mobile exception ${arrivalDate}`;
  await page.getByLabel("维修原因").fill(businessReason);
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await previewAndConfirm(page, "Confirm the mobile task fixture", ["205", businessReason]);
  await finishReceipt(page);

  const guest = `Room Status Arrival ${today}`;
  const orderDepartureDate = addDays(today, 2);
  const orderId = await createFreeStayForToday(page, {
    unitId: "unit_room_201",
    guest,
    nickname: guest,
    arrivalDate: today,
    departureDate: orderDepartureDate
  });

  const overdueGuest = `Room Status Overdue Arrival ${today}`;
  const overdueUnit = board.rooms.find((room) => !["unit_room_201", "unit_room_205"].includes(room.id)
    && [today, addDays(today, 1)].every((date) => room.days.find((day) => day.serviceDate === date)?.available));
  expect(overdueUnit, "an available room is required for the overdue RESERVED mobile task").toBeTruthy();
  const overdueOrderId = await createFreeStayForToday(page, {
    unitId: overdueUnit!.id,
    guest: overdueGuest,
    nickname: overdueGuest,
    arrivalDate: today,
    departureDate: orderDepartureDate
  });
  await makeReservedOrderOverdue(overdueOrderId, today);
  const overdueRefresh = roomStatusResponse(page);
  await page.getByRole("button", { name: "刷新房态", exact: true }).click();
  await overdueRefresh;

  const shiftedArrivalDate = addDays(today, 14);
  const shiftedDepartureDate = addDays(today, 28);
  const shiftedResponse = roomStatusResponse(page, {
    arrivalDate: shiftedArrivalDate,
    departureDate: shiftedDepartureDate
  });
  await page.getByRole("button", { name: "查看后一日期窗口", exact: true }).click();
  await shiftedResponse;
  await expect(page.getByTestId("arrival-date")).toHaveValue(shiftedArrivalDate);
  await expect(page.getByTestId("departure-date")).toHaveValue(shiftedDepartureDate);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("heading", { name: "今日运营任务" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.locator(".room-status-context")).toBeHidden();
  await expect(page.getByRole("tablist", { name: "房态任务分类" })).toBeVisible();
  for (const tab of ["今日到店", "在住", "今日离店", "异常"]) {
    await expect(page.getByRole("tab", { name: new RegExp(tab) })).toBeVisible();
  }

  await page.getByRole("tab", { name: /今日到店/ }).click();
  const arrivalTask = page.locator(".room-status-mobile-task-list > li").filter({ hasText: guest });
  await expect(arrivalTask).toHaveCount(1);
  await arrivalTask.locator(".room-status-mobile-task-open").click();
  const orderDetail = page.getByRole("dialog", { name: /201.*任务详情/ });
  await expect(orderDetail).toContainText(`[${today}, ${orderDepartureDate})`);
  await orderDetail.getByRole("button", { name: "打开订单", exact: true }).click();
  const mobileOrderContext = page.locator(".room-status-order-context").filter({
    has: page.getByRole("heading", { name: `订单 ${orderId}`, exact: true })
  });
  await expect(mobileOrderContext).toBeVisible();
  await expect(mobileOrderContext).toContainText(guest);
  await mobileOrderContext.getByRole("button", { name: "查看完整订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: guest, exact: true })).toBeVisible();
  await expect(page.getByText(orderId, { exact: true })).toBeVisible();

  const restoredResponse = roomStatusResponse(page, {
    arrivalDate: shiftedArrivalDate,
    departureDate: shiftedDepartureDate
  });
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await restoredResponse;
  await expect(page.getByRole("heading", { name: "今日运营任务" })).toBeVisible();
  await expect(page.getByTestId("arrival-date")).toHaveValue(shiftedArrivalDate);
  await expect(page.getByTestId("departure-date")).toHaveValue(shiftedDepartureDate);
  await expect(page.locator(".room-status-return-notice")).toBeVisible();
  const restoredSnapshot = await page.evaluate(() => {
    const key = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .find((candidate) => candidate?.startsWith("qintopia.room-status-view.v1:"));
    return key ? JSON.parse(sessionStorage.getItem(key) ?? "null") as {
      range?: { arrivalDate?: string; departureDate?: string };
      state?: { selection?: unknown };
    } : null;
  });
  expect(restoredSnapshot?.range).toEqual({ arrivalDate: shiftedArrivalDate, departureDate: shiftedDepartureDate });
  expect(restoredSnapshot?.state?.selection).toBeNull();

  await page.getByRole("tab", { name: /异常/ }).click();
  const overdueTask = page.locator(".room-status-mobile-task-list > li").filter({ hasText: overdueGuest });
  await expect(overdueTask).toHaveCount(1);
  await expect(overdueTask).toContainText("已预订");
  await expect(overdueTask).not.toContainText(overdueOrderId);
  await overdueTask.locator(".room-status-mobile-task-open").click();
  const overdueDetail = page.getByRole("dialog", { name: /任务详情/ }).filter({ hasText: overdueGuest });
  await expect(overdueDetail).not.toContainText(overdueOrderId);
  await expect(overdueDetail).not.toContainText(/Claim|阻断|Receipt|RESERVED|CHECKED_IN/);
  await expect(overdueDetail).toContainText(`计划到店日 ${addDays(today, -1)} 已早于营业日 ${today}，订单仍处于已预订`);
  await overdueDetail.getByRole("button", { name: "返回任务列表", exact: true }).click();

  const task = page.locator(".room-status-mobile-task-list > li").filter({ hasText: "205" }).filter({ hasText: "维修" });
  await expect(task).toHaveCount(1);
  await expect(task).toContainText(`来源完整区间 ${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日至${Number(departureDate.slice(5, 7))}月${Number(departureDate.slice(8, 10))}日`);
  await expect(task.getByRole("button", { name: "释放维修锁房", exact: true })).toHaveCount(1);
  await task.locator(".room-status-mobile-task-open").click();

  const detail = page.getByRole("dialog", { name: /205.*任务详情/ });
  await expect(detail).toBeVisible();
  const detailBox = await detail.boundingBox();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.x).toBeLessThanOrEqual(1);
  expect(detailBox!.y).toBeLessThanOrEqual(1);
  expect(detailBox!.width).toBeGreaterThanOrEqual(374);
  expect(detailBox!.height).toBeGreaterThanOrEqual(811);
  await expect(detail).toContainText("房源与日期");
  await expect(detail).toContainText("来源事实");
  await expect(detail).toContainText("任务显示区间");
  await expect(detail).toContainText("来源完整区间");
  await expect(detail).toContainText(`[${arrivalDate}, ${departureDate})`);
  await expect(detail).toContainText(businessReason);
  await expect(detail).toContainText("数据新鲜度");
  await expect(detail.getByRole("button", { name: "返回任务列表", exact: true })).toHaveCount(1);
  await expect(detail.getByRole("button", { name: "释放维修锁房", exact: true })).toHaveCount(1);
  await expect(detail.locator(".room-status-mobile-detail-actions .room-status-button:not(.room-status-button-secondary):not([disabled])")).toHaveCount(1);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(await detail.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await detail.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("room-status-mobile-detail-375.png"), fullPage: true });

  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(task.locator(".room-status-mobile-task-open")).toBeFocused();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "房态任务分类" })).toBeVisible();
  await assertNoPageOverflow(page);
  const mobileInputs = page.locator(".room-status-toolbar input, .room-status-toolbar select, .room-status-context input, .room-status-context select");
  const inputCount = await mobileInputs.count();
  for (let index = 0; index < inputCount; index += 1) {
    expect(parseFloat(await mobileInputs.nth(index).evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  }
  await assertNoA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("room-status-mobile-reflow-320.png"), fullPage: true });

  await task.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  await previewAndConfirm(page, "Release the mobile task fixture", [
    "RELEASE_MAINTENANCE",
    `[${arrivalDate}, ${departureDate})`
  ]);
  await finishReceipt(page);
  await expect(task).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const activeTab = active.getAttribute("role") === "tab" && active.getAttribute("aria-selected") === "true";
    return activeTab || active.classList.contains("room-status-mobile-task-open");
  }), { message: "a completed mobile task returns focus to the active tab or the next task" }).toBe(true);
});
