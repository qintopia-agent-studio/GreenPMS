import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { hashPassword, todayInTimeZone } from "@qintopia/domain";
import type { AuthPrincipal, CommandEnvelope, RoomStatusBoardDto } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview, executeQuoteCommand } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const agentSubjectId = "subject_demo_agent";
const publicPricingPolicyId = "policy_qintopia_public_2026_rev561_v1";
const commandUiWaitMs = 60_000;
const roomStatusTimelineDays = 30;
const ordinaryLodgingIntervalSelector = [
  ".room-status-interval-reserved",
  ".room-status-interval-in-house",
  ".room-status-interval-settled",
  ".room-status-interval-arrears"
].join(", ");
const operator = { username: "operator", password: "demo-pass-2026" };
const longStayFixturePrincipal: AuthPrincipal = {
  subjectId: agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Long-stay E2E fixture writer",
  propertyAccess: new Map([[propertyId, "WRITE"]])
};
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

function quoteResponse(page: Page, expected: { inventoryUnitId: string; arrivalDate: string; departureDate: string }) {
  return page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/v1/quotes") return false;
    const payload = response.request().postDataJSON() as Partial<typeof expected>;
    return payload.inventoryUnitId === expected.inventoryUnitId
      && payload.arrivalDate === expected.arrivalDate
      && payload.departureDate === expected.departureDate;
  }, { timeout: 30_000 });
}

async function createReservedOrderFixture(options: {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  guest: string;
  nickname: string;
  keyPrefix: string;
}): Promise<string> {
  const db = createDatabase(e2eDatabaseUrl);
  const key = `${options.keyPrefix}-${crypto.randomUUID()}`;
  try {
    const quoted = await executeQuoteCommand(db, longStayFixturePrincipal, {
        propertyId,
        inventoryUnitId: options.unitId,
        arrivalDate: options.arrivalDate,
        departureDate: options.departureDate,
        pricingPolicyVersionId: publicPricingPolicyId
    }, { idempotencyKey: `${key}-quote`, correlationId: `${key}-quote` });
    const preview = await createCommandPreview(db, longStayFixturePrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId,
        quoteId: quoted.quote.quoteId,
        primaryGuest: { fullName: options.guest, nickname: options.nickname },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quoted.quote.currentContractAmount.minorUnits
      }
    } as CommandEnvelope, { idempotencyKey: `${key}-preview`, correlationId: `${key}-preview` });
    const receipt = await confirmCommandPreview(db, longStayFixturePrincipal, preview.preview.previewId, {
      propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }, { idempotencyKey: `${key}-confirm`, correlationId: `${key}-confirm` });
    if (receipt.executionStatus !== "EXECUTED" || !receipt.businessCommitted) {
      throw new Error(`Failed to prepare reserved order fixture: ${receipt.error?.message ?? receipt.executionStatus}`);
    }
    const orderId = receipt.result?.orderId;
    if (typeof orderId !== "string") throw new Error("Reserved order fixture did not return an order id");
    return orderId;
  } finally {
    await db.destroy();
  }
}

async function createCompletedBackfillFixture(options: {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  guest: string;
  nickname: string;
  collected: boolean;
  keyPrefix: string;
}): Promise<void> {
  const db = createDatabase(e2eDatabaseUrl);
  const key = `${options.keyPrefix}-${crypto.randomUUID()}`;
  try {
    const quote = await createQuoteForTesting(db, {
      propertyId,
      inventoryUnitId: options.unitId,
      stayType: "TRANSIENT",
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      pricingPolicyVersionId: publicPricingPolicyId
    });
    const preview = await createCommandPreview(db, longStayFixturePrincipal, {
      commandType: "CREATE_ORDER",
      input: {
        propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: options.guest, nickname: options.nickname },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits,
        backfill: true,
        backfillReason: "房态历史床位图标回归",
        ...(options.collected ? {
          backfillCollection: {
            amountMinor: quote.currentContractAmount.minorUnits,
            method: "WECOM",
            transactionReference: `WX-${key}`,
            note: "房态历史床位图标回归"
          }
        } : {})
      }
    } as CommandEnvelope, { idempotencyKey: `${key}-preview`, correlationId: `${key}-preview` });
    const receipt = await confirmCommandPreview(db, longStayFixturePrincipal, preview.preview.previewId, {
      propertyId,
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "BACKFILL_STAY", note: "房态历史床位图标回归" }
    }, { idempotencyKey: `${key}-confirm`, correlationId: `${key}-confirm` });
    if (receipt.executionStatus !== "EXECUTED" || !receipt.businessCommitted) {
      throw new Error(`Failed to prepare completed backfill fixture: ${receipt.error?.message ?? receipt.executionStatus}`);
    }
  } finally {
    await db.destroy();
  }
}

async function createRemoteLongStayConflict(unitId: string, arrivalDate: string, departureDate: string): Promise<void> {
  await createReservedOrderFixture({
    unitId,
    arrivalDate,
    departureDate,
    guest: "长住窗口外冲突住客",
    nickname: "窗口外冲突",
    keyPrefix: "e2e-long-stay-remote-conflict"
  });
}

async function checkInOrderFixture(orderId: string): Promise<void> {
  const db = createDatabase(e2eDatabaseUrl);
  const key = `e2e-room-status-check-in-${crypto.randomUUID()}`;
  try {
    const preview = await createCommandPreview(db, longStayFixturePrincipal, {
      commandType: "CHECK_IN",
      input: { propertyId, orderId }
    } as CommandEnvelope, { idempotencyKey: `${key}-preview`, correlationId: `${key}-preview` });
    const receipt = await confirmCommandPreview(db, longStayFixturePrincipal, preview.preview.previewId, {
      propertyId,
      commandType: "CHECK_IN",
      confirmation: true,
      expectedEffectHash: preview.preview.effectHash,
      reason: { code: "CHECKED_IN", note: "Room-status mixed presentation fixture" }
    }, { idempotencyKey: `${key}-confirm`, correlationId: `${key}-confirm` });
    if (receipt.executionStatus !== "EXECUTED" || !receipt.businessCommitted) {
      throw new Error(`Failed to check in room-status fixture: ${receipt.error?.message ?? receipt.executionStatus}`);
    }
  } finally {
    await db.destroy();
  }
}

async function propertyOrderCount(): Promise<number> {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    const row = await db.selectFrom("orders")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("property_id", "=", propertyId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  } finally {
    await db.destroy();
  }
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
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", level: 2 })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible();
  return {
    board: await response.json() as RoomStatusBoardDto
  };
}

async function expectDesktopGrid(page: Page) {
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  return grid;
}

async function expectMobileRoomStatus(page: Page) {
  await expect(page.getByRole("heading", { name: "今日运营任务", exact: true })).toBeVisible();
  await expect(page.locator(".room-status-mobile")).toBeVisible();
  await expect(page.getByRole("button", { name: "新建住宿或锁房", exact: true })).toBeVisible();
}

async function expectResponsiveRoomStatus(page: Page): Promise<
  | { mode: "desktop"; gridRegion: Locator }
  | { mode: "mobile" }
> {
  const desktopRegion = page.getByRole("grid");
  const mobileShell = page.locator(".room-status-mobile");
  await expect(desktopRegion.or(mobileShell)).toBeVisible();
  if (await desktopRegion.isVisible()) {
    return { mode: "desktop", gridRegion: desktopRegion };
  }
  await expectMobileRoomStatus(page);
  return { mode: "mobile" };
}

function firstAvailableRoomStatusCell(page: Page, board: RoomStatusBoardDto): Locator {
  const candidate = board.rooms
    .flatMap((unit) => unit.days.map((day) => ({ unitId: unit.id, day })))
    .find(({ day }) => day.available);
  expect(candidate, "an available room-status cell is required").toBeTruthy();
  return roomCell(page, candidate!.unitId, candidate!.day.serviceDate);
}

async function openDayPopover(page: Page, cell: Locator): Promise<Locator> {
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  return popover;
}

function roomCell(page: Page, unitId: string, serviceDate: string): Locator {
  return page.locator(
    `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
  );
}

function roomRow(page: Page, unitId: string): Locator {
  return page.locator(`[data-room-status-row="${unitId}"]`);
}

async function expectOrdinaryLodgingCellPresentation(
  cell: Locator,
  status: "RESERVED" | "IN_HOUSE",
  nickname: string,
  granularity: "ROOM" | "BED"
): Promise<void> {
  await expect(cell.locator(".room-status-direct-occupants")).toContainText(nickname);
  const statusClass = status === "RESERVED" ? "reserved" : "in-house";
  if (granularity === "BED") {
    await expect(cell.locator(`.room-status-bed-slot.is-occupied.is-${statusClass}`)).toHaveCount(1);
    await expect(cell.locator(".room-status-bed-slot svg")).toHaveCount(0);
    await expect(cell.locator(".room-status-direct-room-block")).toHaveCount(0);
    await expect(cell.locator(".room-status-direct-count")).toHaveCount(0);
    await expect(cell.locator(".room-status-direct-status-label"))
      .toHaveText(status === "IN_HOUSE" ? "在住" : "预订");
  } else {
    await expect(cell.locator(`.room-status-direct-room-block.is-${statusClass}`)).toHaveCount(1);
    await expect(cell.locator(".room-status-direct-room-block svg")).toHaveCount(0);
    await expect(cell.locator(".room-status-bed-slot")).toHaveCount(0);
    await expect(cell.locator(".room-status-direct-count")).toHaveText(/^\d+\/(?:\d+|\?)$/);
    await expect(cell.locator(".room-status-direct-status-label")).toHaveCount(0);
  }
  await expect(cell.locator(".room-status-bed-state")).toHaveCount(0);
  await expect(cell.locator(ordinaryLodgingIntervalSelector))
    .toHaveCount(0);

  const presentation = await cell.evaluate((element) => {
    const style = getComputedStyle(element);
    const colorMatch = style.backgroundColor.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    const rgbMatch = style.backgroundColor.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/);
    const bodyColor = colorMatch
      ? colorMatch.slice(1, 4).map((component) => Number(component) * 255)
      : rgbMatch?.slice(1, 4).map(Number) ?? null;
    const bodyAlpha = colorMatch?.[4] ?? rgbMatch?.[4];
    return {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      bodyColor,
      bodyAlpha: bodyAlpha === undefined ? 1 : Number(bodyAlpha)
    };
  });
  expect(presentation.backgroundImage, "ordinary lodging must not add a leading status strip")
    .toBe("none");
  expect(presentation.backgroundColor).not.toMatch(/transparent|\/ 0(?:\)|,)/);
  expect(presentation.bodyColor, `expected a resolved opaque sRGB body in ${presentation.backgroundColor}`).not.toBeNull();
  expect(presentation.bodyAlpha).toBe(1);
  const [bodyRed, bodyGreen, bodyBlue] = presentation.bodyColor!;
  if (status === "RESERVED") {
    // At 22% #F97316 over the normal surface, these gaps are about 50 and 30.
    // The lower bounds reject the old 9-10% faint treatment.
    expect(bodyRed! - bodyBlue!).toBeGreaterThanOrEqual(40);
    expect(bodyRed! - bodyGreen!).toBeGreaterThanOrEqual(20);
  } else {
    // At 22% #0969DA over the normal surface, these gaps are about 46 and 25.
    expect(bodyBlue! - bodyRed!).toBeGreaterThanOrEqual(40);
    expect(bodyBlue! - bodyGreen!).toBeGreaterThanOrEqual(20);
  }
}

async function openRoomStatusWriteDrawer(
  page: Page,
  unitId: string,
  serviceDate: string,
  action: "创建订单" | "维修锁房"
): Promise<Locator> {
  const cell = roomCell(page, unitId, serviceDate);
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toBeVisible();
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", unitId);
  await expect(popover).toHaveAttribute("data-selection-kind", "day");
  await popover.getByRole("button", { name: action, exact: true }).click();
  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
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
  expectedEffect: readonly string[],
  onBeforeConfirm?: () => void
) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: commandUiWaitMs });
  for (const value of expectedEffect) await expect(effect).toContainText(value, { timeout: commandUiWaitMs });

  await expect(page.getByTestId("reason-note")).toHaveCount(0);
  const confirmButton = page.getByTestId("confirm-command");
  await expect(confirmButton).toBeEnabled();
  await tabTo(page, confirmButton, "业务确认按钮");
  const confirmedPromise = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  onBeforeConfirm?.();
  await page.keyboard.press("Enter");
  const receipt = await (await confirmedPromise).json() as { resourceRefs: string[]; result?: { orderId?: string } };
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: commandUiWaitMs });
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  return receipt;
}

async function previewAndConfirm(page: Page, expectedEffect: readonly string[]) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: commandUiWaitMs });
  for (const value of expectedEffect) await expect(effect).toContainText(value, { timeout: commandUiWaitMs });
  if (await page.evaluate(() => innerWidth < 576)) {
    const formControls = page.locator(".room-status-page input, .room-status-page select, .room-status-page textarea");
    for (let index = 0; index < await formControls.count(); index += 1) {
      expect(parseFloat(await formControls.nth(index).evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    }
  }
  await expect(page.getByTestId("reason-note")).toHaveCount(0);
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  const confirmedPromise = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await page.getByTestId("confirm-command").click();
  const receipt = await (await confirmedPromise).json() as { resourceRefs: string[]; result?: { orderId?: string } };
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: commandUiWaitMs });
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  return receipt;
}

async function createFreeStayForToday(page: Page, options: {
  unitId: string;
  guest: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
}) {
  const drawer = await openRoomStatusWriteDrawer(page, options.unitId, options.arrivalDate, "创建订单");
  await drawer.getByLabel("入住日期", { exact: true }).fill(options.arrivalDate);
  await drawer.getByLabel("退房日期", { exact: true }).fill(options.departureDate);
  await expect(page.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  const freeQuoteResponse = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/v1/quotes") return false;
    const payload = response.request().postDataJSON() as { stayType?: string };
    return payload.stayType === "FREE" && response.status() === 200;
  });
  await drawer.getByRole("button", { name: "创建免费入住", exact: true }).click();
  await freeQuoteResponse;
  await expect(page.getByTestId("free-stay-reason")).toBeVisible();
  await page.getByTestId("primary-guest-name").fill(options.guest);
  await page.getByTestId("free-stay-reason").fill(`Room-status OPEN_ORDER fixture: ${options.guest}`);
  await expect(page.getByTestId("booking-channel-code")).toHaveCount(0);
  await page.getByTestId("free-stay-category-code").selectOption("RECEPTION");
  const createOrder = page.getByTestId("create-order");
  await expect(createOrder).toBeDisabled();
  await expect(page.getByTestId("command-effect")).toHaveCount(0);
  await page.getByTestId("primary-guest-nickname").fill(options.nickname);
  await createOrder.click();
  const receipt = await previewAndConfirm(page, [
    options.guest,
    options.nickname,
    "接待"
  ]);
  const orderId = receipt.result?.orderId;
  expect(orderId).toBeTruthy();
  return orderId!;
}

test.beforeAll(async () => {
  await ensureReadOnlyPrincipal();
});

test("visual acceptance source badges keep category, color and cell layout stable", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop grid source-badge coverage");
  test.skip(process.env.ROOM_STATUS_VISUAL_E2E !== "1", "requires the isolated room-status visual fixture");
  await page.setViewportSize({ width: 1440, height: 900 });
  const { board } = await login(page);
  const serviceDate = addDays(todayInTimeZone("Asia/Shanghai"), 1);
  const expectations = [
    { code: "C04", badge: "Y", title: "游牧岛", tone: "channel", color: "rgb(49, 95, 120)", foreground: "rgb(255, 255, 255)" },
    { code: "C02", badge: "X", title: "携程", tone: "channel", color: "rgb(49, 95, 120)", foreground: "rgb(255, 255, 255)" },
    { code: "E01", badge: "M", title: "美团", tone: "channel", color: "rgb(49, 95, 120)", foreground: "rgb(255, 255, 255)" },
    { code: "C03", badge: "F", title: "免费入住", tone: "free", color: "rgb(124, 58, 237)", foreground: "rgb(255, 255, 255)" },
    { code: "D04", badge: "H", title: "会员权益", tone: "member", color: "rgb(250, 204, 21)", foreground: "rgb(63, 42, 0)" }
  ] as const;

  for (const expected of expectations) {
    const unit = board.rooms.find((candidate) => candidate.code === expected.code);
    expect(unit, `visual fixture must expose ${expected.code}`).toBeTruthy();
    const cell = roomCell(page, unit!.id, serviceDate);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute("data-room-status-source-count", "1");
    await expect(cell).toHaveAccessibleName(new RegExp(expected.title));
    const badge = cell.locator(`.room-status-source-badge.is-${expected.tone}`);
    await expect(badge).toHaveText(expected.badge);
    await expect(badge).toHaveCSS("background-color", expected.color);
    await expect(badge).toHaveCSS("color", expected.foreground);
    const layout = await cell.evaluate((element) => {
      const badge = element.querySelector<HTMLElement>(".room-status-source-badge");
      const occupants = element.querySelector<HTMLElement>(".room-status-direct-occupants, .room-status-bed-occupants");
      const summary = element.querySelector<HTMLElement>(".room-status-direct-occupancy-summary, .room-status-bed-occupancy-summary");
      const attention = element.querySelector<HTMLElement>(".room-status-bed-attention-tags");
      if (!badge || !occupants || !summary) throw new Error("source badge cell presentation is incomplete");
      const overlaps = (left: DOMRect, right: DOMRect) => left.left < right.right
        && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      const badgeRect = badge.getBoundingClientRect();
      return {
        badgeOverlapsOccupants: overlaps(badgeRect, occupants.getBoundingClientRect()),
        badgeOverlapsSummary: overlaps(badgeRect, summary.getBoundingClientRect()),
        badgeOverlapsAttention: attention ? overlaps(badgeRect, attention.getBoundingClientRect()) : false
      };
    });
    expect(layout).toEqual({
      badgeOverlapsOccupants: false,
      badgeOverlapsSummary: false,
      badgeOverlapsAttention: false
    });
  }

  const compactLayoutMatrix = await page.evaluate(() => {
    const cases = [
      { id: "four-sources", sources: ["H", "F", "M", "X"], attention: [] },
      { id: "three-sources-one-attention", sources: ["H", "F", "M"], attention: ["欠款"] },
      { id: "overflow-one-attention", sources: ["H", "F", "+2"], attention: ["欠款"] },
      { id: "two-sources-multiple-attention", sources: ["H", "F"], attention: ["未退", "+2"] }
    ];
    const overlaps = (left: DOMRect, right: DOMRect) => left.left < right.right
      && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const inside = (outer: DOMRect, inner: DOMRect) => inner.left >= outer.left
      && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;

    return cases.map((fixture) => {
      const cell = document.createElement("div");
      cell.className = "room-status-day-cell has-bed-occupancy has-bed-slot-states is-bed-split-parent has-attention-occupancy";
      cell.style.cssText = "position:fixed;left:0;top:0;width:88px;--room-status-interval-lanes:1;--room-status-row-height:80px";
      cell.innerHTML = `
        <span class="room-status-source-badges">${fixture.sources.map((label) => `<span class="room-status-source-badge ${label.startsWith("+") ? "is-overflow" : "is-channel"}">${label}</span>`).join("")}</span>
        <span class="room-status-bed-attention-tags">${fixture.attention.map((label) => `<span class="room-status-bed-attention-tag ${label.startsWith("+") ? "is-overflow" : ""}">${label}</span>`).join("")}</span>
        <span class="room-status-bed-occupants"><span>春风</span><span>山海</span><span>星河</span><span>云端</span></span>
        <span class="room-status-bed-occupancy-summary"><span class="room-status-bed-slots"><span class="room-status-bed-slot is-in-house"></span><span class="room-status-bed-slot is-reserved"></span><span class="room-status-bed-slot is-settled"></span><span class="room-status-bed-slot"></span></span><span class="room-status-bed-occupancy">4/4</span></span>`;
      document.body.append(cell);
      const bounds = cell.getBoundingClientRect();
      const sources = cell.querySelector<HTMLElement>(".room-status-source-badges")!.getBoundingClientRect();
      const attention = cell.querySelector<HTMLElement>(".room-status-bed-attention-tags")!.getBoundingClientRect();
      const occupants = cell.querySelector<HTMLElement>(".room-status-bed-occupants")!.getBoundingClientRect();
      const summary = cell.querySelector<HTMLElement>(".room-status-bed-occupancy-summary")!.getBoundingClientRect();
      const result = {
        id: fixture.id,
        sourcesInside: inside(bounds, sources),
        attentionInside: fixture.attention.length === 0 || inside(bounds, attention),
        sourcesOverlapAttention: fixture.attention.length > 0 && overlaps(sources, attention),
        sourcesOverlapOccupants: overlaps(sources, occupants),
        attentionOverlapsOccupants: fixture.attention.length > 0 && overlaps(attention, occupants),
        badgesOverlapSummary: overlaps(sources, summary) || (fixture.attention.length > 0 && overlaps(attention, summary)),
        occupantsOverlapSummary: overlaps(occupants, summary)
      };
      cell.remove();
      return result;
    });
  });
  expect(compactLayoutMatrix).toEqual([
    "four-sources",
    "three-sources-one-attention",
    "overflow-one-attention",
    "two-sources-multiple-attention"
  ].map((id) => ({
    id,
    sourcesInside: true,
    attentionInside: true,
    sourcesOverlapAttention: false,
    sourcesOverlapOccupants: false,
    attentionOverlapsOccupants: false,
    badgesOverlapSummary: false,
    occupantsOverlapSummary: false
  })));
});

test("desktop room-status matrix drives a typed Block journey and restores the workbench", async ({ page, browser }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status workbench coverage");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { board } = await login(page);
  const gridRegion = await expectDesktopGrid(page);
  const observerContext = await browser.newContext({
    baseURL: process.env.ROOM_STATUS_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? "4173"}`,
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
  expect(board.range.departureDate).toBe(addDays(board.range.arrivalDate, roomStatusTimelineDays));
  expect(board.dates).toHaveLength(roomStatusTimelineDays);
  const visibleBuildingRowCount = new Set(board.rooms.map((room) => room.buildingCode?.trim() || "未分栋")).size;
  await expect(gridRegion.getByRole("row")).toHaveCount(1 + board.rooms.length + visibleBuildingRowCount);
  const roomId = "unit_room_104";
  const bedAId = "unit_room_104_bed_a";
  const bedBId = "unit_room_104_bed_b";
  const splitRoom = board.rooms.find((room) => room.id === roomId);
  const bedA = splitRoom?.children.find((unit) => unit.id === bedAId);
  const bedB = splitRoom?.children.find((unit) => unit.id === bedBId);
  const availableStartIndex = board.dates.findIndex((date, index) => {
    const nextDate = board.dates[index + 1];
    if (!nextDate || !bedA || !bedB) return false;
    return [bedA, bedB].every((unit) => [date, nextDate].every((serviceDate) => {
      const day = unit.days.find((candidate) => candidate.serviceDate === serviceDate);
      return day?.available && day.conflicts.length === 0 && day.intervalIds.length === 0;
    }));
  });
  expect(availableStartIndex, "104-A and 104-B require two consecutive available nights").toBeGreaterThanOrEqual(0);
  const arrivalDate = board.dates[availableStartIndex]!;
  const departureDate = addDays(arrivalDate, 2);

  const expandRoom = roomRow(page, roomId).getByRole("button", { name: /^展开.*床位$/ });
  const expandObserverRoom = roomRow(observerPage, roomId).getByRole("button", { name: /^展开.*床位$/ });
  await expect(expandRoom).toBeVisible();
  await expect(expandObserverRoom).toBeVisible();
  await expandRoom.click();
  await expandObserverRoom.click();
  await expect(roomRow(page, bedAId)).toBeVisible();
  await expect(roomRow(page, bedBId)).toBeVisible();
  await expect(roomRow(observerPage, bedAId)).toBeVisible();

  const bedAStart = roomCell(page, bedAId, arrivalDate);
  await expect(bedAStart).toHaveAccessibleName(/104.*床位 A.*可售.*可以安排/);
  await bedAStart.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("[data-room-status-cell='true']:focus")).toHaveAttribute("data-service-date", addDays(arrivalDate, 1));
  expect(await page.locator("[data-room-status-cell='true']:focus").evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAttribute("aria-selected", "true");
  await expect(roomCell(page, bedAId, addDays(arrivalDate, 1))).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  const rangePopover = page.getByTestId("room-status-quick-popover");
  await expect(rangePopover).toBeVisible();
  await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
  await expect(rangePopover).toContainText("2晚");
  const actionRegion = page.locator(".room-status-context-actions");
  const maintenanceTrigger = rangePopover.getByRole("button", { name: "维修锁房", exact: true });
  await tabTo(page, maintenanceTrigger, "放置维修锁房动作");
  await page.keyboard.press("Enter");
  const businessReason = `E2E room-status parent-child block ${arrivalDate}`;
  const maintenanceReason = page.getByLabel("维修原因");
  await tabTo(page, maintenanceReason, "维修原因");
  await page.keyboard.type(businessReason);
  const continueButton = page.getByRole("button", { name: "继续核对", exact: true });
  await tabTo(page, continueButton, "继续核对按钮");
  await page.keyboard.press("Enter");
  let propagatedResponse: ReturnType<Page["waitForResponse"]> | undefined;
  const receipt = await keyboardPreviewAndConfirm(page, [
    "104-A",
    businessReason
  ], () => {
    propagatedResponse = observerPage.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (url.pathname !== `/api/v1/properties/${propertyId}/room-status` || response.status() !== 200) return false;
      const candidate = await response.json() as RoomStatusBoardDto;
      return candidate.rooms.flatMap((room) => [room, ...room.children])
        .some((unit) => unit.intervals.some((interval) => interval.reason === businessReason));
    });
  });
  expect(receipt.resourceRefs).toEqual([expect.stringMatching(/^maint_/)]);
  expect(propagatedResponse).toBeDefined();
  const propagationStartedAt = performance.now();
  const observerResponse = await propagatedResponse!;
  expect(observerResponse.status()).toBe(200);
  expect(performance.now() - propagationStartedAt, "second workbench projection propagation").toBeLessThanOrEqual(5_000);
  await observerPage.bringToFront();
  const renderedResponse = observerPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/v1/properties/${propertyId}/room-status` && response.status() === 200;
  });
  await observerPage.getByRole("button", { name: "刷新房态", exact: true }).click();
  await renderedResponse;
  const observerParentInterval = roomRow(observerPage, roomId).locator(".room-status-interval-maintenance");
  await expect(observerParentInterval).toHaveCount(0);
  const bedAInterval = roomRow(page, bedAId).locator(".room-status-interval-maintenance");
  const parentInterval = roomRow(page, roomId).locator(".room-status-interval-maintenance");
  await expect(bedAInterval, "the committing workbench refreshes after the command closes").toBeVisible();
  await expect(parentInterval).toHaveCount(0);
  await expect(bedAStart).toBeFocused();
  expect(await bedAStart.evaluate((element) => element.matches(":focus-visible"))).toBe(true);

  await expect(bedAInterval).toBeVisible();
  await expect(parentInterval).toHaveCount(0);
  await expect(bedAInterval).toHaveAccessibleName(/维修/);
  await expect(roomCell(page, roomId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排.*已有住宿，不能重复安排/);
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排.*已有住宿，不能重复安排/);
  await expect(roomCell(page, bedBId, arrivalDate)).toHaveAccessibleName(/可售.*可以安排/);

  await bedAStart.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Enter");
  await rangePopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  const relatedSources = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "选区内住宿或锁房" })
  });
  await expect(relatedSources).toContainText("维修");
  await expect(relatedSources).toContainText(
    `${Number(arrivalDate.slice(5, 7))}月${Number(arrivalDate.slice(8, 10))}日至${Number(departureDate.slice(5, 7))}月${Number(departureDate.slice(8, 10))}日`
  );
  await expect(relatedSources).not.toContainText(/MAINTENANCE|unit_room_|Block|Receipt/);

  await page.getByRole("dialog", { name: "选中对象上下文" }).locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await bedAInterval.click();
  await rangePopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  const sourceSection = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "住宿或锁房记录" })
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

  await page.getByRole("dialog", { name: "选中对象上下文" }).locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  const bedBStart = roomCell(page, bedBId, arrivalDate);
  const siblingPopover = await openDayPopover(page, bedBStart);
  await siblingPopover.getByRole("button", { name: "维修锁房", exact: true }).click();
  const siblingReason = `E2E sibling bed block ${arrivalDate}`;
  await page.getByLabel("维修原因").fill(siblingReason);
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  const siblingReceipt = await previewAndConfirm(page, [
    "104-B",
    siblingReason
  ]);
  expect(siblingReceipt.resourceRefs).toEqual([expect.stringMatching(/^maint_/)]);

  const bedBInterval = roomRow(page, bedBId).locator(".room-status-interval-maintenance");
  await expect(bedAInterval).toBeVisible();
  await expect(bedBInterval).toBeVisible();
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排/);
  await expect(roomCell(page, bedBId, arrivalDate)).toHaveAccessibleName(/维修.*当前不可安排/);

  await expect(page.getByRole("dialog", { name: "选中对象上下文" })).toBeHidden();
  const parentStart = roomCell(page, roomId, arrivalDate);
  const parentPopover = await openDayPopover(page, parentStart);
  await parentPopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  await expect(conflictSection.locator(".room-status-conflict-list > li")).toHaveCount(2);
  await expect(conflictSection).toContainText("已有住宿，不能重复安排");
  await expect(conflictSection).not.toContainText(/unit_room_|Block|Claim|conflict/i);
  await expect(actionRegion.getByRole("button", { name: "释放维修锁房", exact: true })).toHaveCount(2);
  for (const action of ["创建正常住宿订单", "创建免费入住", "放置维修锁房"]) {
    await expect(actionRegion.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId("confirm-command")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("room-status-desktop-blocking-conflict.png"), fullPage: true });

  await page.getByRole("dialog", { name: "选中对象上下文" }).locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await bedBInterval.click();
  await rangePopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  await actionRegion.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  const siblingReleaseReceipt = await previewAndConfirm(page, [
    "完整释放这条维修锁房"
  ]);
  expect(siblingReleaseReceipt.resourceRefs).toEqual([expect.stringMatching(/^maint_/)]);
  await expect(bedBInterval).toHaveCount(0);
  await expect(bedAInterval).toBeVisible();

  await page.getByRole("dialog", { name: "选中对象上下文" }).locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await bedAInterval.click();
  await rangePopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  await actionRegion.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  const releaseReceipt = await previewAndConfirm(page, [
    "完整释放这条维修锁房"
  ]);
  expect(releaseReceipt.resourceRefs).toEqual([expect.stringMatching(/^maint_/)]);
  await expect(bedAInterval).toHaveCount(0);
  await expect(parentInterval).toHaveCount(0);
  await expect(roomCell(page, roomId, arrivalDate)).toHaveAccessibleName(/可售.*可以安排/);
  await expect(roomCell(page, bedAId, arrivalDate)).toHaveAccessibleName(/可售.*可以安排/);

  await page.getByRole("dialog", { name: "选中对象上下文" }).locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  const search = page.getByLabel("搜索房间或床位");
  const filteredResponse = roomStatusResponse(page);
  await search.fill("104");
  await filteredResponse;
  await expect(roomRow(page, roomId)).toBeVisible();
  await expect(roomRow(page, "unit_room_101")).toHaveCount(0);
  await roomCell(page, bedBId, arrivalDate).click();

  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expectDesktopGrid(page);
  await expect(page.locator(".room-status-return-notice")).toHaveCount(0);
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
  await expect(page.locator(".room-status-return-notice")).toContainText("当前筛选或日期范围已变化");
  await expect(roomRow(page, roomId).getByRole("button", { name: /^展开.*床位$/ })).toBeVisible();
  await expect(roomRow(page, bedBId)).toHaveCount(0);
  await expect(page.locator("[data-room-status-cell='true'][aria-selected='true']")).toHaveCount(0);
  await expect(roomRow(page, roomId).locator("[data-room-status-cell='true']").first()).toBeFocused();
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

test("split-bed parent shows debt, status slots, ratio, and nicknames without overlap", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop split-bed debt presentation coverage");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const serviceDate = board.businessDate;
  const room = board.rooms.find((candidate) => candidate.salesMode === "BED_SPLIT"
    && candidate.capacity === 4
    && candidate.children.filter((child) => {
      const day = child.days.find((item) => item.serviceDate === serviceDate);
      return day?.available && day.conflicts.length === 0;
    }).length >= 2);
  expect(room, "two available beds today are required for mixed debt presentation").toBeTruthy();
  const availableBeds = room!.children.filter((child) => {
    const day = child.days.find((item) => item.serviceDate === serviceDate);
    return day?.available && day.conflicts.length === 0;
  });
  const emptySplitRoom = board.rooms.find((candidate) => candidate.salesMode === "BED_SPLIT"
    && candidate.bedSlotStates.filter((slot) => slot.serviceDate === serviceDate).length === candidate.children.length
    && candidate.bedSlotStates
      .filter((slot) => slot.serviceDate === serviceDate)
      .every((slot) => slot.status === "AVAILABLE"));
  expect(emptySplitRoom, "an all-available split room is required for empty slot presentation").toBeTruthy();
  const emptyParentCell = roomCell(page, emptySplitRoom!.id, serviceDate);
  await expect(emptyParentCell).toHaveAttribute(
    "data-bed-occupancy-ratio",
    `0/${emptySplitRoom!.physicalBedCount ?? "?"}`
  );
  await expect(emptyParentCell.locator(".room-status-bed-slot")).toHaveCount(emptySplitRoom!.children.length);
  await expect(emptyParentCell.locator(".room-status-bed-slot.is-occupied")).toHaveCount(0);
  const inHouseBed = availableBeds[0]!;
  const reservedBed = availableBeds[1]!;
  const departureDate = addDays(serviceDate, 1);

  const expandBeds = roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='false']");
  await expandBeds.click();
  const inHouseOrderId = await createFreeStayForToday(page, {
    unitId: inHouseBed.id,
    guest: "Mixed Status In-house Guest",
    nickname: "在住青岚",
    arrivalDate: serviceDate,
    departureDate
  });
  await checkInOrderFixture(inHouseOrderId);
  await createReservedOrderFixture({
    unitId: reservedBed.id,
    arrivalDate: serviceDate,
    departureDate,
    guest: "Mixed Status Reserved Guest",
    nickname: "预订橙光",
    keyPrefix: "e2e-room-status-debt"
  });

  const refreshed = roomStatusResponse(page);
  await page.getByRole("button", { name: "刷新房态", exact: true }).click();
  const refreshedBoard = await (await refreshed).json() as RoomStatusBoardDto;
  const refreshedRoom = refreshedBoard.rooms.find((candidate) => candidate.id === room!.id);
  expect(refreshedRoom).toBeTruthy();
  const statuses = refreshedRoom!.intervals
    .filter((interval) => interval.startDate <= serviceDate && serviceDate < interval.endDate)
    .map((interval) => interval.status);
  expect(statuses).toContain("IN_HOUSE");
  expect(statuses).toContain("RESERVED");
  expect(refreshedRoom!.intervals.some((interval) => interval.attention === "ARREARS"
    && interval.startDate <= serviceDate && serviceDate < interval.endDate)).toBe(true);

  await expectOrdinaryLodgingCellPresentation(
    roomCell(page, inHouseBed.id, serviceDate),
    "IN_HOUSE",
    "在住青岚",
    "BED"
  );
  await expectOrdinaryLodgingCellPresentation(
    roomCell(page, reservedBed.id, serviceDate),
    "RESERVED",
    "预订橙光",
    "BED"
  );
  for (const cell of [
    roomCell(page, inHouseBed.id, serviceDate),
    roomCell(page, reservedBed.id, serviceDate),
    roomCell(page, room!.id, serviceDate)
  ]) {
    const overlay = cell.locator(".room-status-today-overlay");
    await expect(cell).toHaveClass(/is-today/);
    await expect(overlay).toHaveCount(1);
    await expect(overlay).toHaveCSS("pointer-events", "none");
    const todayPresentation = await cell.evaluate((element) => {
      const overlay = element.querySelector<HTMLElement>(".room-status-today-overlay");
      const occupants = element.querySelector<HTMLElement>(".room-status-direct-occupants, .room-status-bed-occupants");
      const summary = element.querySelector<HTMLElement>(".room-status-direct-occupancy-summary, .room-status-bed-occupancy-summary");
      if (!overlay) throw new Error("today overlay is missing");
      const cellBounds = element.getBoundingClientRect();
      const overlayBounds = overlay.getBoundingClientRect();
      const style = getComputedStyle(overlay);
      return {
        edgeGaps: [
          Math.abs(cellBounds.left - overlayBounds.left),
          Math.abs(cellBounds.right - overlayBounds.right),
          Math.abs(cellBounds.top - overlayBounds.top),
          Math.abs(cellBounds.bottom - overlayBounds.bottom)
        ],
        backgroundColor: style.backgroundColor,
        zIndex: style.zIndex,
        occupantsZIndex: occupants ? getComputedStyle(occupants).zIndex : null,
        summaryZIndex: summary ? getComputedStyle(summary).zIndex : null
      };
    });
    expect(Math.max(...todayPresentation.edgeGaps)).toBeLessThanOrEqual(1.1);
    expect(todayPresentation.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(todayPresentation.zIndex).toBe("1");
    expect(Number(todayPresentation.occupantsZIndex)).toBeGreaterThan(1);
    expect(Number(todayPresentation.summaryZIndex)).toBeGreaterThan(1);
  }
  const todayCells = page.locator(".room-status-day-cell.is-today");
  await expect(page.locator(".room-status-day-cell.is-today > .room-status-today-overlay"))
    .toHaveCount(await todayCells.count());
  // A concrete bed is already a single sellable unit; a room-level denominator is misleading here.
  await expect(roomCell(page, inHouseBed.id, serviceDate).locator(".room-status-direct-count")).toHaveCount(0);
  await expect(roomCell(page, reservedBed.id, serviceDate).locator(".room-status-direct-count")).toHaveCount(0);
  await expect(roomRow(page, room!.id).locator(ordinaryLodgingIntervalSelector))
    .toHaveCount(0);

  const collapseBeds = roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='true']");
  if (await collapseBeds.count()) await collapseBeds.click();
  const parentCell = roomCell(page, room!.id, serviceDate);
  await expect(parentCell).toHaveAttribute("data-bed-occupancy-ratio", "2/4");
  await expect(parentCell.locator(".room-status-bed-occupants > span")).toHaveText(["在住青岚", "预订橙光"]);
  await expect(parentCell.locator(".room-status-bed-attention-tag")).toHaveText("欠款");

  const slots = parentCell.locator(".room-status-bed-slot");
  await expect(slots).toHaveCount(4);
  const expectedCodes = room!.children
    .slice()
    .sort((left, right) => left.code.localeCompare(right.code, "en", { numeric: true }))
    .slice(0, 4)
    .map((bed) => bed.code.split("-").at(-1)?.trim().toUpperCase() || bed.code);
  expect(await slots.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-bed-code"))))
    .toEqual(expectedCodes);
  await expect(slots.filter({ has: page.locator("svg") })).toHaveCount(0);
  await expect(parentCell.locator(".room-status-bed-slot.is-in-house")).toHaveCount(1);
  await expect(parentCell.locator(".room-status-bed-slot.is-reserved")).toHaveCount(1);
  await expect(parentCell.locator(".room-status-bed-slot:not(.is-occupied)")).toHaveCount(2);

  const presentation = await parentCell.evaluate((cell) => {
    const attention = cell.querySelector<HTMLElement>(".room-status-bed-attention-tags");
    const occupants = cell.querySelector<HTMLElement>(".room-status-bed-occupants");
    const summary = cell.querySelector<HTMLElement>(".room-status-bed-occupancy-summary");
    const inHouse = cell.querySelector<HTMLElement>(".room-status-bed-slot.is-in-house");
    const reserved = cell.querySelector<HTMLElement>(".room-status-bed-slot.is-reserved");
    const available = cell.querySelector<HTMLElement>(".room-status-bed-slot:not(.is-occupied)");
    if (!attention || !occupants || !summary || !inHouse || !reserved || !available) {
      throw new Error("mixed bed presentation is incomplete");
    }
    const overlaps = (left: DOMRect, right: DOMRect) => left.left < right.right
      && left.right > right.left
      && left.top < right.bottom
      && left.bottom > right.top;
    const attentionRect = attention.getBoundingClientRect();
    return {
      attentionOverlapsOccupants: overlaps(attentionRect, occupants.getBoundingClientRect()),
      attentionOverlapsSummary: overlaps(attentionRect, summary.getBoundingClientRect()),
      inHouseBackground: getComputedStyle(inHouse).backgroundColor,
      reservedBackground: getComputedStyle(reserved).backgroundColor,
      availableBackground: getComputedStyle(available).backgroundColor,
      availableBorderStyle: getComputedStyle(available).borderStyle,
      parentBackground: getComputedStyle(cell).backgroundColor,
      parentBackgroundImage: getComputedStyle(cell).backgroundImage
    };
  });
  expect(presentation.attentionOverlapsOccupants).toBe(false);
  expect(presentation.attentionOverlapsSummary).toBe(false);
  expect(presentation.inHouseBackground).toBe("rgb(9, 105, 218)");
  expect(presentation.reservedBackground).toBe("rgb(249, 115, 22)");
  expect(presentation.availableBackground).toBe("rgba(0, 0, 0, 0)");
  expect(presentation.availableBorderStyle).toBe("solid");
  expect(presentation.parentBackground).toBe("rgb(255, 255, 255)");
  expect(presentation.parentBackgroundImage).toBe("none");

  const historicalArrival = addDays(serviceDate, -3);
  const historicalDeparture = addDays(serviceDate, -2);
  await createCompletedBackfillFixture({
    unitId: inHouseBed.id,
    arrivalDate: historicalArrival,
    departureDate: historicalDeparture,
    guest: "Historical Settled Guest",
    nickname: "历史结清",
    collected: true,
    keyPrefix: "e2e-room-status-history-settled"
  });
  await createCompletedBackfillFixture({
    unitId: reservedBed.id,
    arrivalDate: historicalArrival,
    departureDate: historicalDeparture,
    guest: "Historical Arrears Guest",
    nickname: "历史欠款",
    collected: false,
    keyPrefix: "e2e-room-status-history-arrears"
  });
  const historicalResponse = roomStatusResponse(page, {
    arrivalDate: historicalArrival,
    departureDate: addDays(historicalArrival, roomStatusTimelineDays)
  });
  await page.getByRole("textbox", { name: "起始日期" }).fill(historicalArrival);
  await historicalResponse;
  const historicalParentCell = roomCell(page, room!.id, historicalArrival);
  const settledHistoricalSlot = historicalParentCell.locator(".room-status-bed-slot[data-bed-status='SETTLED']");
  const arrearsHistoricalSlot = historicalParentCell.locator(".room-status-bed-slot[data-bed-status='ARREARS']");
  await expect(settledHistoricalSlot).toHaveCount(1);
  await expect(arrearsHistoricalSlot).toHaveCount(1);
  await expect(settledHistoricalSlot).toHaveClass(/is-settled/);
  // ARREARS keeps its source status in data-bed-status, but shares the completed-green lifecycle treatment.
  await expect(arrearsHistoricalSlot).toHaveClass(/is-settled/);
  await expect(settledHistoricalSlot.locator("svg")).toHaveCount(1);
  await expect(arrearsHistoricalSlot.locator("svg")).toHaveCount(1);
  await expect(settledHistoricalSlot).toHaveAttribute("aria-label", /已结单/);
  await expect(arrearsHistoricalSlot).toHaveAttribute("aria-label", /已结单/);
  const historicalPresentation = await historicalParentCell.evaluate((cell) => {
    const settled = cell.querySelector<HTMLElement>(".room-status-bed-slot[data-bed-status='SETTLED']");
    const arrears = cell.querySelector<HTMLElement>(".room-status-bed-slot[data-bed-status='ARREARS']");
    const attentionTags = [...cell.querySelectorAll<HTMLElement>(".room-status-bed-attention-tag")]
      .map((tag) => tag.textContent?.trim());
    if (!settled || !arrears) throw new Error("historical settled and arrears slots are required");
    return {
      settledBackground: getComputedStyle(settled).backgroundColor,
      arrearsBackground: getComputedStyle(arrears).backgroundColor,
      attentionTags
    };
  });
  expect(historicalPresentation.settledBackground).toBe("rgb(40, 122, 75)");
  expect(historicalPresentation.arrearsBackground).toBe("rgb(40, 122, 75)");
  expect(historicalPresentation.attentionTags).toEqual(["欠款"]);

  await roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='false']").click();
  const historicalArrearsCell = roomCell(page, reservedBed.id, historicalArrival);
  const historicalArrearsPopover = await openDayPopover(page, historicalArrearsCell);
  await expect(historicalArrearsPopover.locator(".room-status-mark")).toContainText("已结单");
  await expect(historicalArrearsPopover.locator(".room-status-mobile-attention")).toHaveText("欠款");
  await expect(historicalArrearsPopover.getByText("欠款", { exact: true })).toHaveCount(1);
  await historicalArrearsPopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  const historicalArrearsContext = page.getByRole("dialog", { name: "选中对象上下文" });
  await expect(historicalArrearsContext.locator(".room-status-context-header-actions .room-status-mark"))
    .toContainText("已结单");
  await expect(historicalArrearsContext.locator(".room-status-context-header-actions .room-status-mobile-attention"))
    .toHaveText("欠款");
  await expect(historicalArrearsContext.locator(".room-status-context-header-actions").getByText("欠款", { exact: true }))
    .toHaveCount(1);
  await historicalArrearsContext.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
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

  const initialExpandBeds = parentRow.locator(".room-status-expand-button[aria-expanded='false']");
  await expect(initialExpandBeds).toBeVisible();
  await initialExpandBeds.click();

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
    await expect(parentCell.locator(".room-status-bed-occupants > span")).toHaveText(visibleOccupants);
    await expect(parentCell.locator(".room-status-bed-occupants")).not.toContainText(/\+[123]/);
  }

  await parentRow.locator(".room-status-expand-button[aria-expanded='true']").click();

  const parentCell = roomCell(page, room!.id, serviceDate!);
  await expect(parentCell).toHaveText(/4\/4/);
  await expect(parentCell).not.toHaveAttribute("title");
  await expect(parentCell).toHaveAccessibleName(/占用 4\/4.*山风.*同名住客.*同名住客.*北辰/);
  await expect(parentCell).not.toHaveAccessibleName(/阻断|Claim|order_/i);
  const nicknameLabels = parentCell.locator(".room-status-bed-occupants > span");
  await expect(nicknameLabels).toHaveText(
    occupants.map((occupant) => occupant.nickname)
  );
  await expect(parentCell.locator(".room-status-bed-occupants")).not.toContainText(/\+[123]/);
  const occupiedBounds = await roomRow(page, room!.id).boundingBox();
  expect(occupiedBounds!.height).toBe(initialRowBounds!.height);

  const truncatedNickname = nicknameLabels.first();
  const completeNickname = nicknameLabels.nth(1);
  expect(await truncatedNickname.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await completeNickname.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  await truncatedNickname.hover();
  await expect(page.getByRole("tooltip")).toHaveText(occupants[0]!.nickname);
  await page.mouse.move(1, 1);
  await expect(page.getByRole("tooltip")).toBeHidden();
  await completeNickname.hover();
  await expect(page.getByRole("tooltip"), "a complete nickname must not open redundant help text").toHaveCount(0);
  await truncatedNickname.focus();
  await expect(page.getByRole("tooltip")).toHaveText(occupants[0]!.nickname);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(truncatedNickname).toBeFocused();

  await page.mouse.move(1, 1);
  await page.locator(".room-status-grid-scroll").focus();
  await parentCell.focus();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect((await roomRow(page, room!.id).boundingBox())!.height).toBe(occupiedBounds!.height);
  await page.keyboard.press("Enter");
  const quickPopover = page.getByTestId("room-status-quick-popover");
  await expect(quickPopover).toBeVisible();
  await expect(parentCell).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(quickPopover).toBeHidden();
  await expect(parentCell).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(parentCell).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(parentCell).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect((await roomRow(page, room!.id).boundingBox())!.height).toBe(occupiedBounds!.height);

  const wholeRoomNickname = "云岫";
  await createFreeStayForToday(page, {
    unitId: room!.id,
    guest: "Whole-room Legal Name",
    nickname: wholeRoomNickname,
    arrivalDate: wholeRoomServiceDate!,
    departureDate: addDays(wholeRoomServiceDate!, 1)
  });
  const wholeRoomCell = roomCell(page, room!.id, wholeRoomServiceDate!);
  // A whole-room reservation in a bed-split room is still one ordinary lodging,
  // not a mixed-bed parent summary: it keeps the orange date-cell treatment.
  await expectOrdinaryLodgingCellPresentation(wholeRoomCell, "RESERVED", wholeRoomNickname, "ROOM");
  await expect(roomRow(page, room!.id).locator(ordinaryLodgingIntervalSelector))
    .toHaveCount(0);

  await page.mouse.move(1, 1);
  const expandBeds = roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='false']");
  await expect(expandBeds).toBeVisible();
  await expandBeds.click();
  for (const bed of room!.children) {
    const childCell = roomCell(page, bed.id, wholeRoomServiceDate!);
    await expect(childCell).toHaveAttribute("data-whole-room-occupied", "true");
    await expect(childCell).toHaveClass(/is-whole-room-occupied-bed/);
    await expect(childCell).toHaveAccessibleName(/整房占用.*当前不可安排/);
    await expect(childCell).not.toHaveAccessibleName(/预订|在住/);
    await expect(childCell.locator(".room-status-mark, .room-status-direct-occupants, .room-status-direct-occupancy-summary"))
      .toHaveCount(0);
  }
  for (let index = 0; index < occupants.length; index += 1) {
    const childRow = roomRow(page, room!.children[index]!.id);
    await expect(roomCell(page, room!.children[index]!.id, serviceDate!)).toHaveAccessibleName(
      new RegExp(occupants[index]!.nickname)
    );
    await expect(childRow.locator(".room-status-interval").filter({
      hasText: occupants[index]!.nickname
    })).toHaveCount(0);
  }
  await truncatedNickname.hover();
  await expect(page.getByRole("tooltip")).toHaveText(occupants[0]!.nickname);
  await page.screenshot({ path: testInfo.outputPath("room-status-bed-occupancy-nicknames.png") });
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);

  const collapseBeds = roomRow(page, room!.id).locator(".room-status-expand-button[aria-expanded='true']");
  await collapseBeds.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("tooltip")).toBeHidden();

  await page.setViewportSize({ width: 375, height: 812 });
  const occupancyToggle = page.getByTestId("mobile-room-status-occupancies-toggle");
  await expect(occupancyToggle).toBeVisible();
  if (await occupancyToggle.getAttribute("aria-expanded") === "false") await occupancyToggle.click();
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

test("desktop delays the range-loading notice without delaying write blocking", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop range-loading presentation coverage");
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const toolbarArrival = page.getByTestId("arrival-date");
  const committedRange = page.getByTestId("room-status-board-range");
  const fastRequestedArrival = addDays(board.range.arrivalDate, 1);
  const fastRequestedDeparture = addDays(fastRequestedArrival, roomStatusTimelineDays);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.removeAttribute("data-range-loading-observed");
    const observer = new MutationObserver(() => {
      if (!document.querySelector("[data-testid='room-status-range-loading']")) return;
      root.setAttribute("data-range-loading-observed", "true");
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 2_000);
  });
  const fastResponse = roomStatusResponse(page, {
    arrivalDate: fastRequestedArrival,
    departureDate: fastRequestedDeparture
  });
  await toolbarArrival.fill(fastRequestedArrival);
  await fastResponse;
  await expect(committedRange).toHaveAttribute("data-range-arrival", fastRequestedArrival, { timeout: 15_000 });
  await expect(committedRange).toHaveAttribute("data-range-departure", fastRequestedDeparture, { timeout: 15_000 });
  await page.waitForTimeout(300);
  expect(
    await page.locator("html").getAttribute("data-range-loading-observed"),
    "a fast range query must not mount the delayed loading notice for even one frame"
  ).toBeNull();

  const requestedArrival = addDays(fastRequestedArrival, 1);
  const requestedDeparture = addDays(requestedArrival, roomStatusTimelineDays);
  let releaseRequest = () => {};
  let markRequestSeen = () => {};
  const requestSeen = new Promise<void>((resolve) => { markRequestSeen = resolve; });
  const heldRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const routePattern = `**/api/v1/properties/${propertyId}/room-status*`;
  await page.route(routePattern, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("arrivalDate") === requestedArrival
      && url.searchParams.get("departureDate") === requestedDeparture) {
      markRequestSeen();
      await heldRequest;
    }
    try {
      await route.continue();
    } catch (error) {
      if (!String(error).includes("Route is already handled")) throw error;
    }
  });

  try {
    const response = roomStatusResponse(page, {
      arrivalDate: requestedArrival,
      departureDate: requestedDeparture
    });
    await toolbarArrival.fill(requestedArrival);
    await requestSeen;
    await expect(page.locator(".room-status-workspace")).toHaveAttribute("inert", "");
    expect(
      await page.getByTestId("room-status-range-loading").count(),
      "write blocking must start before the delayed loading notice is presented"
    ).toBe(0);
    await expect(page.getByTestId("room-status-range-loading")).toBeVisible();
    await expect(committedRange).toHaveAttribute("data-range-departure", fastRequestedDeparture);
    releaseRequest();
    await response;
    await expect(committedRange).toHaveAttribute("data-range-arrival", requestedArrival, { timeout: 15_000 });
    await expect(committedRange).toHaveAttribute("data-range-departure", requestedDeparture, { timeout: 15_000 });
    await expect(page.getByTestId("room-status-range-loading")).toBeHidden();
    await expect(page.locator(".room-status-workspace")).not.toHaveAttribute("inert", "");
  } finally {
    releaseRequest();
    await page.unroute(routePattern);
  }
});

test("desktop range selection, fixed 30-night start-date navigation, filtered-empty and range-loading fail closed", async ({ page }, testInfo: TestInfo) => {
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
  const rangePopover = page.getByTestId("room-status-quick-popover");
  await expect(rangePopover).toBeVisible();
  await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
  await rangePopover.getByRole("button", { name: "创建订单", exact: true }).click();
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
  const writeDrawer = page.locator("dialog.room-status-write-drawer");
  await writeDrawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  const visibleDialogs = page.locator("dialog:visible");
  await expect(visibleDialogs).toHaveCount(0, { timeout: 15_000 });

  const search = page.getByLabel("搜索房间或床位");
  await expect(search).toBeEditable({ timeout: 15_000 });
  await search.fill("不存在的房源");
  await expect(search).toHaveValue("不存在的房源");
  const filteredEmpty = page.locator("[data-room-status-state='filtered-empty']");
  await expect(filteredEmpty).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-room-status-cell='true'][aria-selected='true']")).toHaveCount(0);
  await expect(page.locator("[data-room-status-cell='true']:focus")).toHaveCount(0);
  await expect(page.locator(".room-status-context-actions").getByRole("button")).toHaveCount(0);
  const clearFilters = filteredEmpty.getByRole("button", { name: "清除筛选", exact: true });
  await clearFilters.focus();
  await page.keyboard.press("Enter");
  await expect(filteredEmpty).toBeHidden();
  await expect(search).toBeFocused();

  const toolbarArrival = page.getByTestId("arrival-date");
  await expect(page.getByTestId("departure-date")).toHaveCount(0);
  const requestedArrival = addDays(board.range.arrivalDate, 1);
  const requestedDeparture = addDays(requestedArrival, roomStatusTimelineDays);
  let releaseRequest = () => {};
  let markRequestSeen = () => {};
  let targetRequestCount = 0;
  const requestSeen = new Promise<void>((resolve) => { markRequestSeen = resolve; });
  const heldRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const routePattern = `**/api/v1/properties/${propertyId}/room-status*`;
  await page.route(routePattern, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("arrivalDate") === requestedArrival
      && url.searchParams.get("departureDate") === requestedDeparture) {
      targetRequestCount += 1;
      markRequestSeen();
      await heldRequest;
    }
    try {
      await route.continue();
    } catch (error) {
      if (!String(error).includes("Route is already handled")) throw error;
    }
  });

  try {
    const committedRange = page.getByTestId("room-status-board-range");
    const response = roomStatusResponse(page, {
      arrivalDate: requestedArrival,
      departureDate: requestedDeparture
    });
    await toolbarArrival.fill(requestedArrival);
    await requestSeen;
    await expect(page.getByTestId("room-status-range-loading")).toBeVisible();
    await expect(committedRange).toHaveAttribute("data-range-departure", board.range.departureDate);
    await expect(page.locator(".room-status-workspace")).toHaveAttribute("inert", "");
    await expect(page.locator(".room-status-context-actions").getByRole("button", { name: /创建|放置|释放|完成清洁/ })).toHaveCount(0);
    await page.waitForTimeout(4_250);
    expect(targetRequestCount, "the 4-second poll must coalesce behind an in-flight range query").toBe(1);
    releaseRequest();
    await response;
    await expect(committedRange).toHaveAttribute("data-range-arrival", requestedArrival, { timeout: 15_000 });
    await expect(committedRange).toHaveAttribute("data-range-departure", requestedDeparture, { timeout: 15_000 });
    await expect(page.getByTestId("room-status-range-loading")).toBeHidden();
    await expect(page.locator(".room-status-workspace")).not.toHaveAttribute("inert", "");
  } finally {
    releaseRequest();
    await page.unroute(routePattern);
  }
});

test("desktop long stays stay actionable beyond the 30-night board and fail visibly on remote conflicts", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop long-stay browser coverage");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  const longArrival = addDays(todayInTimeZone("Asia/Shanghai"), 60);
  const displayedDeparture = addDays(longArrival, roomStatusTimelineDays);
  const boardResponse = roomStatusResponse(page, { arrivalDate: longArrival, departureDate: displayedDeparture });
  await page.getByTestId("arrival-date").fill(longArrival);
  const longWindowBoard = await (await boardResponse).json() as RoomStatusBoardDto;
  expect(longWindowBoard.dates).toHaveLength(roomStatusTimelineDays);

  const reservedFixtureCodes = new Set(["101", "102", "103", "104", "201", "205", "A01", "A02", "A03", "B01", "B02", "D01"]);
  const candidate = longWindowBoard.rooms.find((room) => (
    !reservedFixtureCodes.has(room.code)
    && room.allowedActions.some((action) => action.enabled && action.code === "CREATE_ORDER")
    && room.days.length === roomStatusTimelineDays
    && room.days.every((day) => day.available && day.conflicts.length === 0)
  ));
  expect(candidate, "an unoccupied room outside shared E2E fixtures is required for long-stay browser coverage").toBeTruthy();

  let quoteRequestCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") {
      quoteRequestCount += 1;
    }
  });

  const quickPopover = await openDayPopover(page, roomCell(page, candidate!.id, longArrival));
  await quickPopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  const selectionDrawer = page.locator("dialog.room-status-view-drawer");
  await expect(selectionDrawer).toBeVisible();
  const departure117 = addDays(longArrival, 117);
  await selectionDrawer.getByLabel("退房日期", { exact: true }).fill(departure117);
  await expect(selectionDrawer.getByRole("button", { name: "创建正常住宿订单", exact: true })).toBeVisible();

  const initialQuote = quoteResponse(page, {
    inventoryUnitId: candidate!.id,
    arrivalDate: longArrival,
    departureDate: departure117
  });
  await selectionDrawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  expect((await initialQuote).ok()).toBe(true);

  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible();
  const departureInput = drawer.getByLabel("退房日期", { exact: true });
  const quoteFor = async (departureDate: string) => {
    const response = quoteResponse(page, {
      inventoryUnitId: candidate!.id,
      arrivalDate: longArrival,
      departureDate
    });
    await departureInput.fill(departureDate);
    return response;
  };

  await expect(drawer.getByText("房态当前只显示其中 30 夜，住宿日期仍按完整区间核对。", { exact: true })).toBeVisible();
  await expect(drawer.getByTestId("quote-result")).toContainText("117 晚");
  await drawer.getByTestId("primary-guest-nickname").fill("长住浏览器验证");
  await drawer.getByTestId("primary-guest-name").fill("长住浏览器验证住客");
  await drawer.getByTestId("booking-channel-code").selectOption("WECOM");
  await expect(drawer.getByTestId("create-order")).toBeEnabled();

  const departure366 = addDays(longArrival, 366);
  const accepted366 = await quoteFor(departure366);
  expect(accepted366.ok()).toBe(true);
  await expect(drawer.getByTestId("quote-result")).toContainText("366 晚");
  await expect(drawer.getByTestId("room-status-selection-date-error")).toBeHidden();

  const quoteRequestsBeforeOverLimit = quoteRequestCount;
  await departureInput.fill(addDays(longArrival, 367));
  await expect(drawer.getByTestId("room-status-selection-date-error")).toContainText("住宿日期最长 366 夜。");
  await expect(drawer.getByTestId("quote-result")).toHaveCount(0);
  await expect(drawer.getByTestId("create-order")).toBeDisabled();
  await expect.poll(() => quoteRequestCount).toBe(quoteRequestsBeforeOverLimit);

  await departureInput.fill("");
  await expect(drawer.getByTestId("quote-result")).toHaveCount(0);
  await expect(drawer.getByTestId("create-order")).toBeDisabled();

  await departureInput.fill(addDays(longArrival, -1));
  await expect(drawer.getByTestId("room-status-selection-date-error")).toContainText("退房日期必须晚于入住日期。");
  await expect(drawer.getByTestId("quote-result")).toHaveCount(0);
  await expect(drawer.getByTestId("create-order")).toBeDisabled();

  const accepted117Again = await quoteFor(departure117);
  expect(accepted117Again.ok()).toBe(true);
  await expect(drawer.getByTestId("quote-result")).toContainText("117 晚");

  const remoteConflictArrival = addDays(longArrival, 45);
  const remoteConflictDeparture = addDays(remoteConflictArrival, 1);
  expect(remoteConflictArrival > displayedDeparture).toBe(true);
  await createRemoteLongStayConflict(candidate!.id, remoteConflictArrival, remoteConflictDeparture);
  const ordersBeforeFailedTargetQuote = await propertyOrderCount();

  const failedQuote = await quoteFor(addDays(longArrival, 116));
  expect(failedQuote.ok()).toBe(false);
  const quoteFailure = drawer.getByRole("alert").filter({ hasText: "报价失败" });
  await expect(quoteFailure).toBeVisible();
  await expect(quoteFailure).toContainText(remoteConflictArrival);
  await expect(quoteFailure).toContainText(remoteConflictDeparture);
  await expect(quoteFailure).toContainText(/已有住宿|不能重复安排/);
  await expect(drawer.getByLabel("入住日期", { exact: true })).toHaveValue(longArrival);
  await expect(departureInput).toHaveValue(addDays(longArrival, 116));
  await expect(drawer.getByTestId("primary-guest-nickname")).toHaveValue("长住浏览器验证");
  await expect(drawer.getByTestId("primary-guest-name")).toHaveValue("长住浏览器验证住客");
  await expect(drawer.getByTestId("booking-channel-code")).toHaveValue("WECOM");
  expect(await propertyOrderCount()).toBe(ordersBeforeFailedTargetQuote);
});

test("desktop write draft stays stable across three room-status freshness windows", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status freshness stability coverage");
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 720 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const candidate = board.rooms
    .flatMap((room) => room.days.map((day) => ({ room, day })))
    .find(({ room, day }) => room.kind === "ROOM"
      && day.available
      && day.conflicts.length === 0
      && room.allowedActions.some((action) => action.code === "CREATE_ORDER" && action.enabled));
  expect(candidate, "an available room is required for the freshness stability draft").toBeTruthy();

  const drawer = await openRoomStatusWriteDrawer(page, candidate!.room.id, candidate!.day.serviceDate, "创建订单");
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  await expect(drawer.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  await drawer.getByTestId("primary-guest-name").fill("房态静默续期验证住客");
  const nickname = drawer.getByTestId("primary-guest-nickname");
  await nickname.fill("静默续期草稿");
  await drawer.getByTestId("booking-channel-code").selectOption("WECOM");
  const createButton = drawer.getByTestId("create-order");
  await expect(createButton).toBeEnabled();
  const drawerBody = drawer.locator(".modal-body");
  const initialScrollTop = await drawerBody.evaluate((element) => {
    element.scrollTop = Math.min(40, Math.max(0, element.scrollHeight - element.clientHeight));
    return element.scrollTop;
  });
  await nickname.focus();

  const roomStatusRoutePattern = `**/api/v1/properties/${propertyId}/room-status?*`;
  const delayedRefreshes: Array<{ startedAt: number; fulfilledAt: number }> = [];
  const delayedResponseMs = 1_500;
  await page.route(roomStatusRoutePattern, async (route) => {
    const startedAt = Date.now();
    // Fetching first keeps this a real API response; only its delivery is delayed.
    const response = await route.fetch();
    await new Promise<void>((resolve) => setTimeout(resolve, delayedResponseMs));
    await route.fulfill({ response });
    delayedRefreshes.push({ startedAt, fulfilledAt: Date.now() });
  });
  let stability: {
    disabledStates: boolean[];
    focusLost: boolean;
    value: string;
    scrollTop: number;
    drawerConnected: boolean;
  };
  try {
    stability = await page.evaluate(async ({ durationMs }) => {
      const button = document.querySelector<HTMLButtonElement>("[data-testid='create-order']");
      const input = document.querySelector<HTMLInputElement>("[data-testid='primary-guest-nickname']");
      const body = document.querySelector<HTMLElement>("dialog.room-status-write-drawer .modal-body");
      if (!button || !input || !body) throw new Error("write draft controls are unavailable");
      const disabledStates = [button.disabled];
      let focusLost = document.activeElement !== input;
      const observeButtonState = () => disabledStates.push(button.disabled);
      const observer = new MutationObserver(observeButtonState);
      observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
      const focusProbe = window.setInterval(() => {
        if (document.activeElement !== input) focusLost = true;
        observeButtonState();
      }, 40);
      await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
      window.clearInterval(focusProbe);
      observer.disconnect();
      return {
        disabledStates,
        focusLost,
        value: input.value,
        scrollTop: body.scrollTop,
        drawerConnected: body.isConnected
      };
    }, { durationMs: 18_000 });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }

  expect(delayedRefreshes.length, "the open draft must cross at least three five-second freshness windows")
    .toBeGreaterThanOrEqual(3);
  expect(delayedRefreshes.length, "a 1.5-second response delay must not turn renewal into a tight refresh loop")
    .toBeLessThanOrEqual(10);
  expect(delayedRefreshes.every((renewal) => renewal.fulfilledAt - renewal.startedAt >= delayedResponseMs - 100)).toBe(true);
  const renewalGapsAfterDelivery = delayedRefreshes.slice(1)
    .map((renewal, index) => renewal.startedAt - delayedRefreshes[index]!.fulfilledAt);
  expect(renewalGapsAfterDelivery, "each delayed renewal after the first must be measured")
    .toHaveLength(delayedRefreshes.length - 1);
  expect(
    renewalGapsAfterDelivery.every((gap) => gap >= 250),
    `renewals must not immediately loop after delivery; observed gaps: ${renewalGapsAfterDelivery.join(", ")}ms`
  )
    .toBe(true);
  expect(stability.disabledStates.every((disabled) => !disabled)).toBe(true);
  expect(stability.focusLost).toBe(false);
  expect(stability.value).toBe("静默续期草稿");
  expect(stability.scrollTop).toBe(initialScrollTop);
  expect(stability.drawerConnected).toBe(true);
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /房态.*失败|房态.*过期/ })).toHaveCount(0);
  await expect(createButton).toBeEnabled();
});

test("desktop keeps room status writable when the client clock is ahead of the server", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status clock-skew coverage");
  await page.addInitScript(() => {
    const systemNow = Date.now.bind(Date);
    Date.now = () => systemNow() + 60_000;
  });
  await page.setViewportSize({ width: 1440, height: 720 });
  let roomStatusResponses = 0;
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${propertyId}/room-status`
      && response.status() === 200) roomStatusResponses += 1;
  });

  const { board } = await login(page);
  await expectDesktopGrid(page);
  const cell = firstAvailableRoomStatusCell(page, board);
  const popover = await openDayPopover(page, cell);
  await expect(popover.getByRole("button", { name: "创建订单", exact: true })).toBeEnabled();
  await expect(popover.getByRole("button", { name: "维修锁房", exact: true })).toBeEnabled();
  const responsesBeforeRenewal = roomStatusResponses;

  await page.waitForTimeout(7_000);

  expect(roomStatusResponses).toBeGreaterThan(responsesBeforeRenewal);
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("button", { name: "创建订单", exact: true })).toBeEnabled();
  await expect(popover.getByRole("button", { name: "维修锁房", exact: true })).toBeEnabled();
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0);
});

test("desktop rejects a slow room-status renewal across wall-clock rollback without a write-gate loop", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status slow-renewal boundary coverage");
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const systemNow = Date.now.bind(Date);
    let offsetMs = 0;
    (window as unknown as { setRoomStatusClockOffset: (value: number) => void }).setRoomStatusClockOffset = (value) => {
      offsetMs = value;
    };
    Date.now = () => systemNow() + offsetMs;
  });
  await page.setViewportSize({ width: 1440, height: 720 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const candidate = board.rooms
    .flatMap((room) => room.days.map((day) => ({ room, day })))
    .find(({ room, day }) => room.kind === "ROOM"
      && day.available
      && day.conflicts.length === 0
      && room.allowedActions.some((action) => action.code === "CREATE_ORDER" && action.enabled));
  expect(candidate, "an available room is required for the slow-renewal draft").toBeTruthy();

  const drawer = await openRoomStatusWriteDrawer(page, candidate!.room.id, candidate!.day.serviceDate, "创建订单");
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  await expect(drawer.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  await drawer.getByTestId("primary-guest-name").fill("房态慢响应验证住客");
  const nickname = drawer.getByTestId("primary-guest-nickname");
  await nickname.fill("慢响应草稿");
  await drawer.getByTestId("booking-channel-code").selectOption("WECOM");
  const createButton = drawer.getByTestId("create-order");
  await expect(createButton).toBeEnabled();
  const drawerBody = drawer.locator(".modal-body");
  const initialScrollTop = await drawerBody.evaluate((element) => {
    element.scrollTop = Math.min(40, Math.max(0, element.scrollHeight - element.clientHeight));
    return element.scrollTop;
  });
  await nickname.focus();

  const roomStatusRoutePattern = `**/api/v1/properties/${propertyId}/room-status?*`;
  const delayedResponseMs = 2_500;
  let delayedRenewalStarted!: () => void;
  let delayedRenewalFulfilled!: () => void;
  const delayedRenewalStartedPromise = new Promise<void>((resolve) => { delayedRenewalStarted = resolve; });
  const delayedRenewalFulfilledPromise = new Promise<void>((resolve) => { delayedRenewalFulfilled = resolve; });
  let delayedRenewalCount = 0;
  await page.route(roomStatusRoutePattern, async (route) => {
    // Keep the response real. The local request budget makes this delay cross
    // the three-second install headroom independently of machine clock skew.
    const response = await route.fetch();
    delayedRenewalCount += 1;
    delayedRenewalStarted();
    await new Promise<void>((resolve) => setTimeout(resolve, delayedResponseMs));
    await route.fulfill({ response });
    delayedRenewalFulfilled();
  });

  await delayedRenewalStartedPromise;
  await page.evaluate(() => {
    (window as unknown as { setRoomStatusClockOffset: (value: number) => void })
      .setRoomStatusClockOffset(-60_000);
  });
  const slowRenewalStability = await page.evaluate(async ({ durationMs }) => {
    const button = document.querySelector<HTMLButtonElement>("[data-testid='create-order']");
    const body = document.querySelector<HTMLElement>("dialog.room-status-write-drawer .modal-body");
    if (!button || !body) throw new Error("slow-renewal draft controls are unavailable");
    const disabledStates = [button.disabled];
    let focusLost = false;
    const sample = () => {
      const currentButton = document.querySelector<HTMLButtonElement>("[data-testid='create-order']");
      const currentInput = document.querySelector<HTMLInputElement>("[data-testid='primary-guest-nickname']");
      if (!currentButton || !currentInput) throw new Error("slow-renewal draft controls were removed");
      disabledStates.push(currentButton.disabled);
      if (document.activeElement !== currentInput) focusLost = true;
    };
    const timer = window.setInterval(sample, 40);
    await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
    window.clearInterval(timer);
    sample();
    return {
      disabledStates,
      focusLost,
      value: document.querySelector<HTMLInputElement>("[data-testid='primary-guest-nickname']")?.value,
      scrollTop: body.scrollTop,
      drawerConnected: body.isConnected
    };
  }, { durationMs: delayedResponseMs + 300 });

  try {
    await delayedRenewalFulfilledPromise;
    expect(delayedRenewalCount, "the slow boundary must cover at least one rejected renewal before recovery")
      .toBeGreaterThanOrEqual(1);
    expect(delayedRenewalCount, "the slow boundary must not start a tight refresh loop before recovery")
      .toBeLessThanOrEqual(2);
    await expect(createButton).toBeDisabled();
    await expect(page.locator(".room-status-stale-notice")).toHaveCount(1);
    await expect(page.locator(".room-status-stale-notice")).toContainText("正在更新房态，更新完成前暂不能写入。");
    await expect(page.locator(".room-status-quick-gate")).toHaveCount(0);

    const transitions = slowRenewalStability.disabledStates
      .filter((state, index, states) => index === 0 || state !== states[index - 1]);
    expect(transitions, "a rejected renewal may close writes once, but must not reopen them before recovery")
      .toEqual([false, true]);
    expect(slowRenewalStability.focusLost).toBe(false);
    expect(slowRenewalStability.value).toBe("慢响应草稿");
    expect(slowRenewalStability.scrollTop).toBe(initialScrollTop);
    expect(slowRenewalStability.drawerConnected).toBe(true);
  } finally {
    await page.unroute(roomStatusRoutePattern);
  }

  await expect(createButton, "after network recovery, the client must renew without a manual refresh").toBeEnabled({ timeout: 15_000 });
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0);
  await expect(nickname).toHaveValue("慢响应草稿");
  await expect(nickname).toBeFocused();
  expect(await drawerBody.evaluate((element) => element.scrollTop)).toBe(initialScrollTop);
});

test("desktop stops repeated low-freshness renewals and requires one manual retry", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status repeated low-freshness failure coverage");
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 720 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const candidate = board.rooms
    .flatMap((room) => room.days.map((day) => ({ room, day })))
    .find(({ room, day }) => room.kind === "ROOM"
      && day.available
      && day.conflicts.length === 0
      && room.allowedActions.some((action) => action.code === "CREATE_ORDER" && action.enabled));
  expect(candidate, "an available room is required for the repeated low-freshness draft").toBeTruthy();

  const drawer = await openRoomStatusWriteDrawer(page, candidate!.room.id, candidate!.day.serviceDate, "创建订单");
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  await expect(drawer.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  await drawer.getByTestId("primary-guest-name").fill("房态连续慢响应验证住客");
  const nickname = drawer.getByTestId("primary-guest-nickname");
  await nickname.fill("连续慢响应草稿");
  await drawer.getByTestId("booking-channel-code").selectOption("WECOM");
  const createButton = drawer.getByTestId("create-order");
  await expect(createButton).toBeEnabled();
  const drawerBody = drawer.locator(".modal-body");
  const initialScrollTop = await drawerBody.evaluate((element) => {
    element.scrollTop = Math.min(40, Math.max(0, element.scrollHeight - element.clientHeight));
    return element.scrollTop;
  });
  await nickname.focus();

  const roomStatusRoutePattern = `**/api/v1/properties/${propertyId}/room-status?*`;
  const delayedResponseMs = 3_250;
  let firstDelayedRenewalStarted!: () => void;
  const firstDelayedRenewalStartedPromise = new Promise<void>((resolve) => { firstDelayedRenewalStarted = resolve; });
  let delayedRenewalCount = 0;
  await page.route(roomStatusRoutePattern, async (route) => {
    // The real five-second response is delivered after the local request has
    // consumed enough of its budget that every attempt must be rejected.
    const response = await route.fetch();
    delayedRenewalCount += 1;
    const renewalNumber = delayedRenewalCount;
    if (renewalNumber === 1) firstDelayedRenewalStarted();
    await new Promise<void>((resolve) => setTimeout(resolve, delayedResponseMs));
    await route.fulfill({ response });
  });

  // Trigger the first delayed response explicitly. Waiting for whichever
  // background timer happens to survive quote setup makes this boundary flaky.
  await page.getByRole("button", { name: "刷新房态", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  await firstDelayedRenewalStartedPromise;
  const stability = await page.evaluate(async ({ durationMs }) => {
    const body = document.querySelector<HTMLElement>("dialog.room-status-write-drawer .modal-body");
    if (!body) throw new Error("repeated low-freshness drawer is unavailable");
    const disabledStates: boolean[] = [];
    let focusLost = false;
    const sample = () => {
      const button = document.querySelector<HTMLButtonElement>("[data-testid='create-order']");
      const input = document.querySelector<HTMLInputElement>("[data-testid='primary-guest-nickname']");
      if (!button || !input) throw new Error("repeated low-freshness draft controls were removed");
      disabledStates.push(button.disabled);
      if (document.activeElement !== input) focusLost = true;
    };
    sample();
    const timer = window.setInterval(sample, 40);
    await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
    window.clearInterval(timer);
    sample();
    return {
      disabledStates,
      focusLost,
      value: document.querySelector<HTMLInputElement>("[data-testid='primary-guest-nickname']")?.value,
      scrollTop: body.scrollTop,
      drawerConnected: body.isConnected
    };
  }, { durationMs: 13_000 });

  try {
    const failureNotice = page.locator(".room-status-stale-notice");
    await expect(failureNotice).toContainText(
      "房态刷新失败，当前仍显示上次成功结果。刷新成功前不能发起补录或其他写入。",
      { timeout: 15_000 }
    );
    await expect(failureNotice).toHaveAttribute("role", "alert");
    await expect(failureNotice.getByRole("button", { name: "重试刷新", exact: true })).toHaveCount(1);
    await expect(createButton).toBeDisabled();
    await expect(page.locator(".room-status-quick-gate")).toHaveCount(0);
    const stoppedRenewalCount = delayedRenewalCount;
    expect(stoppedRenewalCount, "manual retry must require at least three delivered low-freshness attempts")
      .toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(1_000);
    expect(delayedRenewalCount, "the final failure state must stop background retries")
      .toBe(stoppedRenewalCount);

    const transitions = stability.disabledStates
      .filter((state, index, states) => index === 0 || state !== states[index - 1]);
    expect(transitions, "writes may close once but must not reopen while low-freshness retries fail")
      .toEqual([false, true]);
    expect(stability.focusLost).toBe(false);
    expect(stability.value).toBe("连续慢响应草稿");
    expect(stability.scrollTop).toBe(initialScrollTop);
    expect(stability.drawerConnected).toBe(true);
  } finally {
    await page.unroute(roomStatusRoutePattern);
  }

  const refreshed = roomStatusResponse(page);
  await page.locator(".room-status-stale-notice")
    .getByRole("button", { name: "重试刷新", exact: true })
    .click({ timeout: 5_000 });
  await refreshed;
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator(".room-status-stale-notice")).toHaveCount(0);
  await expect(nickname).toHaveValue("连续慢响应草稿");
  await expect(nickname).toBeFocused();
  expect(await drawerBody.evaluate((element) => element.scrollTop)).toBe(initialScrollTop);
});

test("desktop cancels a low-freshness retry when a replacement range query fails", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status retry-scope coverage");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 720 });
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const roomStatusRoutePattern = `**/api/v1/properties/${propertyId}/room-status?*`;
  const initialArrivalDate = board.range.arrivalDate;
  const replacementArrivalDate = addDays(initialArrivalDate, roomStatusTimelineDays);
  let requestCount = 0;
  let secondLowFreshnessDelivered!: () => void;
  let replacementFailed!: () => void;
  const secondLowFreshnessDeliveredPromise = new Promise<void>((resolve) => {
    secondLowFreshnessDelivered = resolve;
  });
  const replacementFailedPromise = new Promise<void>((resolve) => {
    replacementFailed = resolve;
  });
  await page.route(roomStatusRoutePattern, async (route) => {
    requestCount += 1;
    const url = new URL(route.request().url());
    if (url.searchParams.get("arrivalDate") === replacementArrivalDate) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "ROOM_STATUS_TEST_FAILURE", message: "replacement query failed" })
      });
      replacementFailed();
      return;
    }
    const response = await route.fetch();
    await new Promise<void>((resolve) => setTimeout(resolve, 3_250));
    await route.fulfill({ response });
    if (requestCount === 2) secondLowFreshnessDelivered();
  });

  try {
    await page.getByRole("button", { name: "刷新房态", exact: true })
      .evaluate((element: HTMLButtonElement) => element.click());
    await secondLowFreshnessDeliveredPromise;
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "查看后 30 夜", exact: true }).click();
    await replacementFailedPromise;
    const failureNotice = page.locator(".room-status-stale-notice");
    await expect(failureNotice).toContainText(
      "房态刷新失败，当前仍显示上次成功结果。刷新成功前不能发起补录或其他写入。"
    );
    await expect(failureNotice).toHaveAttribute("role", "alert");
    const stoppedRequestCount = requestCount;
    await page.waitForTimeout(1_500);
    expect(requestCount, "a retry from the previous range must not wake after the replacement query fails")
      .toBe(stoppedRequestCount);
  } finally {
    await page.unroute(roomStatusRoutePattern);
  }
});

test("desktop stale and unknown states fail closed without mocked room-status data", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "desktop room-status network-state coverage");
  const { board } = await login(page);
  await expectDesktopGrid(page);

  const preservedCell = firstAvailableRoomStatusCell(page, board);
  const preservedAccessibleName = await preservedCell.getAttribute("aria-label");
  const roomStatusRoutePattern = `**/api/v1/properties/${propertyId}/room-status?*`;
  let releaseRefresh!: () => void;
  let markRefreshIntercepted!: () => void;
  let markRefreshFulfilled!: () => void;
  const heldRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshIntercepted = new Promise<void>((resolve) => { markRefreshIntercepted = resolve; });
  const refreshFulfilled = new Promise<void>((resolve) => { markRefreshFulfilled = resolve; });
  let holdNextRefresh = true;
  await page.route(roomStatusRoutePattern, async (route) => {
    if (!holdNextRefresh) {
      await route.continue();
      return;
    }
    holdNextRefresh = false;
    const response = await route.fetch();
    markRefreshIntercepted();
    await heldRefresh;
    await route.fulfill({ response });
    markRefreshFulfilled();
  });
  try {
    await page.getByRole("button", { name: "刷新房态", exact: true }).click();
    await refreshIntercepted;
    await expect(page.getByRole("button", { name: "刷新房态", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "正在刷新", exact: true })).toHaveCount(0);
    await page.waitForTimeout(Math.max(0, Date.parse(board.freshUntil) - Date.now() + 200));

    await expect(page.locator(".room-status-mark-stale, .room-status-day-stale, .room-status-interval-stale")).toHaveCount(0);
    await expect(page.locator(".room-status-stale-notice")).toHaveCount(1);
    await expect(page.locator(".room-status-stale-notice")).toContainText("正在更新房态");
    await expect(preservedCell).toHaveAttribute("aria-label", preservedAccessibleName!);
    const refreshingPopover = await openDayPopover(page, preservedCell);
    await expect(refreshingPopover).toContainText("可售");
    await expect(refreshingPopover.getByRole("button", { name: "创建订单", exact: true })).toBeDisabled();
    await expect(refreshingPopover.getByRole("button", { name: "维修锁房", exact: true })).toBeDisabled();
    await expect(refreshingPopover.locator(".room-status-quick-gate")).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    releaseRefresh();
    await refreshFulfilled;
    await page.unroute(roomStatusRoutePattern);
  }
  await expect(page.getByRole("button", { name: "刷新房态", exact: true })).toBeVisible();

  const quickPopover = await openDayPopover(page, preservedCell);
  await quickPopover.getByRole("button", { name: "创建订单", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建正常住宿订单", exact: true })).toBeVisible();

  try {
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "刷新房态", exact: true })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(page.getByRole("alert").filter({ hasText: "房态刷新失败" })).toBeVisible();
    await expect(page.locator(".room-status-mark-stale, .room-status-day-stale, .room-status-interval-stale")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "创建订单", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建正常住宿订单", exact: true })).toBeDisabled();

    await page.context().setOffline(false);
    const refreshed = roomStatusResponse(page);
    await page.getByRole("button", { name: "刷新房态", exact: true })
      .evaluate((element: HTMLButtonElement) => element.click());
    await refreshed;
    await expect(page.getByRole("alert").filter({ hasText: "房态刷新失败" })).toBeHidden();
    const restoredContext = page.getByRole("dialog", { name: "创建订单", exact: true });
    await restoredContext.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
    await expect(restoredContext).toBeHidden();

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

    const maintenanceDrawer = await openRoomStatusWriteDrawer(page, candidate!.id, serviceDate, "维修锁房");
    const businessReason = `Permission revocation draft ${candidate!.id}`;
    await maintenanceDrawer.getByLabel("维修原因").fill(businessReason);
    await maintenanceDrawer.getByRole("button", { name: "继续核对", exact: true }).click();
    await expect(page.getByTestId("command-effect")).toContainText(businessReason, { timeout: 15_000 });
    await expect(page.getByTestId("reason-note")).toHaveCount(0);
    await expect(page.locator("dialog.modal-wide")).toBeVisible();

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

    const maintenanceDrawer = await openRoomStatusWriteDrawer(page, candidate!.id, serviceDate, "维修锁房");
    await maintenanceDrawer.getByLabel("维修原因").fill(businessReason);
    const previewResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/v1/command-previews"
      && response.status() === 200
    ));
    await maintenanceDrawer.getByRole("button", { name: "继续核对", exact: true }).click();
    const previewResponse = await previewResponsePromise;
    const prepared = await previewResponse.json() as {
      preview: { previewId: string; effectHash: string };
    };
    await expect(page.getByTestId("reason-note")).toHaveCount(0);
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
    await expect(page.locator("dialog.modal-wide")).toBeVisible();
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
    await page.getByRole("button", { name: "返回修改", exact: true }).click();
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

  const quickPopover = await openDayPopover(page, firstAvailableRoomStatusCell(page, board));
  await quickPopover.getByRole("button", { name: "查看房态记录", exact: true }).click();
  const actionRegion = page.locator(".room-status-context-actions");
  await expect(actionRegion).toContainText("当前账号只有查看权限，不能补录住宿或执行其他写入");
  for (const action of ["创建正常住宿订单", "创建免费入住", "放置维修锁房"]) {
    await expect(actionRegion.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }
  await assertNoA11yViolations(page);
});

test("room-status responsive layouts keep the matrix bounded through tablet and 200 percent zoom", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "desktop"), "single desktop browser responsive coverage");
  test.setTimeout(120_000);
  const { board } = await login(page);

  const quickPopover = await openDayPopover(page, firstAvailableRoomStatusCell(page, board));
  await quickPopover.getByRole("button", { name: "查看房态记录", exact: true }).click();

  for (const viewport of [
    { width: 1440, height: 900, name: "1440" },
    { width: 1024, height: 768, name: "1024" },
    { width: 768, height: 1024, name: "768" }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await assertNoPageOverflow(page);
    const layout = await expectResponsiveRoomStatus(page);
    if (layout.mode === "desktop") {
      const gridRegion = layout.gridRegion;
      const viewDrawer = page.locator("dialog.room-status-view-drawer");
      const context = page.locator(".room-status-context");
      expect(await page.locator(".room-status-grid-header-scroll").evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
      expect(await page.locator(".room-status-resource-header").evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
      const gridBox = await gridRegion.boundingBox();
      expect(gridBox).not.toBeNull();
      if (viewport.width >= 1024 || await viewDrawer.isVisible()) {
        await expect(viewDrawer).toBeVisible();
        await expect(context).toBeVisible();
        const drawerBox = await viewDrawer.boundingBox();
        expect(drawerBox).not.toBeNull();
        expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
        expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(drawerBox!.x).toBeLessThan(gridBox!.x + gridBox!.width);
      }
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
  await expectResponsiveRoomStatus(page);
  expect(await page.evaluate(() => ({ cssWidth: window.innerWidth, pixelRatio: window.devicePixelRatio })))
    .toEqual({ cssWidth: 720, pixelRatio: 2 });
  await assertNoPageOverflow(page);
  await assertNoA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("room-status-200-percent-zoom.png"), fullPage: true });
});

test("room-status reload LCP and a real fixed 30-night grid stay within the interaction budgets", async ({ page }, testInfo: TestInfo) => {
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

  const timelineStartDate = addDays(todayInTimeZone("Asia/Shanghai"), roomStatusTimelineDays);
  const departureDate = addDays(timelineStartDate, roomStatusTimelineDays);
  const response = roomStatusResponse(page, { arrivalDate: timelineStartDate, departureDate });
  const startedAt = performance.now();
  await page.getByTestId("arrival-date").fill(timelineStartDate);
  const refreshedResponse = await response;
  const committedRange = page.getByTestId("room-status-board-range");
  await expect(committedRange).toHaveAttribute("data-range-arrival", timelineStartDate);
  await expect(committedRange).toHaveAttribute("data-range-departure", departureDate);
  const grid = committedRange.getByRole("grid");
  await expect(grid).toBeVisible();
  const firstCell = grid.locator("[data-room-status-cell='true']").first();
  await firstCell.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-room-status-cell='true']:focus")).toHaveCount(1);
  const elapsedMs = performance.now() - startedAt;
  expect(elapsedMs, "30-night request through keyboard-interactive grid").toBeLessThanOrEqual(2_000);

  const refreshedBoard = await refreshedResponse.json() as RoomStatusBoardDto;
  expect(refreshedBoard.dates).toHaveLength(roomStatusTimelineDays);
  const selectionArrival = addDays(timelineStartDate, 1);
  const selectionDeparture = addDays(timelineStartDate, 16);
  const fullyAvailableRoom = refreshedBoard.rooms.find((room) => {
    const selectedDays = room.days
      .filter((day) => selectionArrival <= day.serviceDate && day.serviceDate < selectionDeparture);
    return room.allowedActions.some((action) => action.enabled && action.code === "CREATE_ORDER")
      && selectedDays.length === 15
      && selectedDays.every((day) => day.available && day.conflicts.length === 0);
  });
  expect(fullyAvailableRoom, "the keyboard range requires one room available for all 15 selected nights").toBeTruthy();
  const firstUnitId = fullyAvailableRoom!.id;
  const selectionStartCell = roomCell(page, firstUnitId, selectionArrival);
  await selectionStartCell.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await selectionStartCell.focus();
  await expect(selectionStartCell).toBeFocused();
  await page.keyboard.press("Escape");
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.locator("[data-room-status-cell='true']:focus"))
      .toHaveAttribute("data-service-date", addDays(timelineStartDate, index + 2));
  }
  await expect(page.locator("[data-room-status-cell='true']:focus"))
    .toHaveAttribute("data-service-date", addDays(timelineStartDate, 15));
  const crossWindowTarget = roomCell(page, firstUnitId!, addDays(timelineStartDate, 15));
  await expect.poll(() => crossWindowTarget.evaluate((element) => element.matches(":focus-visible")))
    .toBe(true);
  await page.keyboard.press("Enter");
  const rangePopover = page.getByTestId("room-status-quick-popover");
  await expect(rangePopover).toBeVisible();
  await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
  const createButton = rangePopover.getByRole("button", { name: "创建订单", exact: true });
  await expect(createButton).toBeVisible();
  await createButton.click();
  await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(selectionArrival);
  await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(selectionDeparture);
  await expect(crossWindowTarget).toHaveAttribute("aria-selected", "true");
});

test("mobile room status uses task tabs and a full-screen fact detail instead of the matrix", async ({ page }, testInfo: TestInfo) => {
  test.skip(!isProject(testInfo, "mobile"), "mobile room-status task coverage");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  const { board } = await login(page);
  await expectDesktopGrid(page);
  const initialContext = page.getByRole("dialog", { name: "选中对象上下文" });
  if (await initialContext.count()) {
    await initialContext.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  }

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
  const touchPopover = page.getByTestId("room-status-quick-popover");
  await expect(touchPopover).toBeVisible();
  await expect(touchPopover).toHaveAttribute("data-selection-kind", "range");
  await touchPopover.getByRole("button", { name: "创建订单", exact: true }).click();
  const touchDrawer = page.locator("dialog.room-status-write-drawer");
  await expect(touchDrawer.getByLabel("入住日期", { exact: true })).toHaveValue(touchCandidate!.startDate);
  await expect(touchDrawer.getByLabel("退房日期", { exact: true })).toHaveValue(addDays(touchCandidate!.endDate, 1));
  await expect(touchDrawer.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  await touchDrawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(touchDrawer).toBeHidden();

  const today = todayInTimeZone("Asia/Shanghai");
  const arrivalDate = today;
  const departureDate = addDays(today, 1);
  const maintenanceDrawer = await openRoomStatusWriteDrawer(page, "unit_room_205", arrivalDate, "维修锁房");
  await expect(maintenanceDrawer.getByLabel("开始日期", { exact: true })).toHaveValue(arrivalDate);
  await maintenanceDrawer.getByLabel("结束日期", { exact: true }).fill(departureDate);
  await expect(maintenanceDrawer.getByLabel("结束日期", { exact: true })).toHaveValue(departureDate);
  const businessReason = `E2E mobile exception ${arrivalDate}`;
  await maintenanceDrawer.getByLabel("维修原因").fill(businessReason);
  await maintenanceDrawer.getByRole("button", { name: "继续核对" }).click();
  await previewAndConfirm(page, ["205", businessReason]);

  const guest = `Room Status Arrival ${today}`;
  const orderDepartureDate = addDays(today, 2);
  const arrivalOrderId = await createFreeStayForToday(page, {
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

  const shiftedArrivalDate = board.range.departureDate;
  const shiftedDepartureDate = addDays(shiftedArrivalDate, roomStatusTimelineDays);
  const shiftedResponse = roomStatusResponse(page, {
    arrivalDate: shiftedArrivalDate,
    departureDate: shiftedDepartureDate
  });
  await page.getByRole("button", { name: "查看后 30 夜", exact: true }).click();
  await shiftedResponse;
  await expect(page.getByTestId("arrival-date")).toHaveValue(shiftedArrivalDate);
  await expect(page.getByTestId("departure-date")).toHaveCount(0);

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
  await expect(orderDetail).toContainText("完整业务周期");
  await expect(orderDetail).toContainText(
    `${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日至${Number(orderDepartureDate.slice(5, 7))}月${Number(orderDepartureDate.slice(8, 10))}日`
  );
  const selectedOrderResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/v1/orders/${arrivalOrderId}`
    && response.status() === 200
  ), { timeout: 30_000 });
  await orderDetail.getByRole("button", { name: "打开订单", exact: true }).click();
  await selectedOrderResponse;
  const mobileOrderDialog = page.getByRole("dialog", { name: "订单上下文", exact: true });
  const mobileOrderContext = mobileOrderDialog.locator(".room-status-order-context").filter({
    has: page.getByRole("heading", { name: `${guest}的住宿订单`, exact: true })
  });
  await expect(mobileOrderContext).toBeVisible({ timeout: 30_000 });
  await expect(mobileOrderContext).toContainText(guest);
  await mobileOrderDialog.getByRole("button", { name: "查看完整订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: guest, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "住宿状态", exact: true })).toBeVisible();

  const restoredResponse = roomStatusResponse(page);
  await page.getByRole("link", { name: "返回房态", exact: true }).click();
  const restoredBoard = await (await restoredResponse).json() as RoomStatusBoardDto;
  await expect(page.getByRole("heading", { name: "今日运营任务" })).toBeVisible();
  const restoredMobileRange = page.locator(".room-status-mobile-range");
  await expect(restoredMobileRange).toContainText(
    `${Number(restoredBoard.range.arrivalDate.slice(5, 7))}月${Number(restoredBoard.range.arrivalDate.slice(8, 10))}日`
  );
  await expect(restoredMobileRange).toContainText(
    `${Number(restoredBoard.range.departureDate.slice(5, 7))}月${Number(restoredBoard.range.departureDate.slice(8, 10))}日`
  );
  await expect(page.locator(".room-status-return-notice")).toContainText(
    "最新房态中找不到原住宿位置。已安全关闭订单上下文"
  );
  await expect.poll(() => page.evaluate(() => {
    const key = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .find((candidate) => candidate?.startsWith("qintopia.room-status-view.v1:"));
    const snapshot = key ? JSON.parse(sessionStorage.getItem(key) ?? "null") as {
      range?: { arrivalDate?: string; departureDate?: string };
      state?: { selection?: unknown };
    } : null;
    return { range: snapshot?.range, selection: snapshot?.state?.selection };
  })).toEqual({
    range: restoredBoard.range,
    selection: null
  });

  const restoredOrderDialog = page.getByRole("dialog", { name: "订单上下文", exact: true });
  await expect(restoredOrderDialog).toBeHidden();

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
  await expect(task).toContainText(`完整业务周期 ${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日至${Number(departureDate.slice(5, 7))}月${Number(departureDate.slice(8, 10))}日`);
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
  await expect(detail).toContainText("营业日期");
  await expect(detail).toContainText("当前显示日期");
  await expect(detail).toContainText("完整业务周期");
  await expect(detail).toContainText(
    `${Number(arrivalDate.slice(5, 7))}月${Number(arrivalDate.slice(8, 10))}日至${Number(departureDate.slice(5, 7))}月${Number(departureDate.slice(8, 10))}日`
  );
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
  await previewAndConfirm(page, [
    "完整释放这条维修锁房"
  ]);
  await expect(task).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const activeTab = active.getAttribute("role") === "tab" && active.getAttribute("aria-selected") === "true";
    return activeTab || active.classList.contains("room-status-mobile-task-open");
  }), { message: "a completed mobile task returns focus to the active tab or the next task" }).toBe(true);
});
