import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AuthPrincipal, RoomStatusBoardDto } from "@qintopia/contracts";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { getOrderView } from "../../packages/db/src/orders.ts";
import {
  prepareStage7Acceptance,
  stage7ReadOnlyOperator,
  type Stage7AcceptanceFixture
} from "./setup-stage7-acceptance.ts";
import { authScope } from "../helpers/auth-principals.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const operator = { username: "operator", password: "demo-pass-2026" };
const administrator = { username: "admin", password: "demo-pass-2026" };
const externalOperator: AuthPrincipal = {
  subjectId: "subject_demo_agent",
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope({ propertyId })
};
const externalAdministrator: AuthPrincipal = {
  subjectId: "subject_demo_administrator",
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Demo Administrator",
  ...authScope({ propertyId, profile: "administrator" })
};
const fixtureDayOffset = 365;
let fixture: Stage7AcceptanceFixture;

function isDesktopProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop" || process.env.ROOM_STATUS_E2E_PROJECT === "desktop";
}

function isMobileProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile" || process.env.ROOM_STATUS_E2E_PROJECT === "mobile";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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

function roomRow(page: Page, unitId: string): Locator {
  return page.locator(`[data-room-status-row="${unitId}"]`);
}

function orderContext(page: Page, _orderId?: string): Locator {
  return page.locator(".room-status-order-context:visible").last();
}

function orderDrawer(page: Page): Locator {
  return page.getByRole("dialog", { name: "订单详情", exact: true });
}

async function login(
  page: Page,
  credentials: { username: string; password: string } = operator
): Promise<RoomStatusBoardDto> {
  await page.goto(process.env.ROOM_STATUS_E2E_BASE_URL ?? "/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(credentials.username);
  await page.getByTestId("login-password").fill(credentials.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  const response = await responsePromise;
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toBeVisible();
  return response.json() as Promise<RoomStatusBoardDto>;
}

async function loginMobile(
  page: Page,
  credentials: { username: string; password: string } = operator
): Promise<RoomStatusBoardDto> {
  await page.goto(process.env.ROOM_STATUS_E2E_BASE_URL ?? "/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(credentials.username);
  await page.getByTestId("login-password").fill(credentials.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  const response = await responsePromise;
  await expect(page.getByRole("heading", { name: "今日运营任务", exact: true, level: 1 })).toBeVisible();
  await expect(page.locator(".room-status-mobile")).toBeVisible();
  return response.json() as Promise<RoomStatusBoardDto>;
}

async function showFixtureRange(page: Page, options: { clipped?: boolean; nights?: number } = {}): Promise<void> {
  const rangeStart = options.clipped ? addDays(fixture.dates.arrivalDate, 1) : fixture.dates.arrivalDate;
  const requestedRangeEnd = options.nights
    ? addDays(rangeStart, options.nights)
    : options.clipped
      ? addDays(fixture.dates.departureDate, -1)
      : addDays(fixture.dates.departureDate, 2);

  const mobileRangeToggle = page.getByTestId("mobile-room-status-range-toggle");
  const mobile = (page.viewportSize()?.width ?? 0) <= 767;
  const rangeEnd = mobile ? requestedRangeEnd : addDays(rangeStart, 30);
  if (mobile) {
    await expect(mobileRangeToggle).toBeVisible();
    await mobileRangeToggle.click();
    const departureResponse = roomStatusResponse(page);
    await page.getByTestId("departure-date").fill(rangeEnd);
    await departureResponse;
  }
  const arrivalResponse = roomStatusResponse(page);
  await page.getByTestId("arrival-date").fill(rangeStart);
  await arrivalResponse;
  const boardRange = page.getByTestId("room-status-board-range");
  if (await boardRange.count()) {
    await expect(boardRange).toHaveAttribute("data-range-arrival", rangeStart);
    await expect(boardRange).toHaveAttribute("data-range-departure", rangeEnd);
  }
  else await expect(page.getByTestId("arrival-date")).toHaveValue(rangeStart);
  const occupancyToggle = page.getByTestId("mobile-room-status-occupancies-toggle");
  if (await occupancyToggle.isVisible() && await occupancyToggle.getAttribute("aria-expanded") === "false") {
    await occupancyToggle.click();
  }
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
  const orderOptions = popover.locator(".room-status-quick-orders button");
  await expect(orderOptions).toHaveCount(1);
  await orderOptions.click();
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

test.beforeAll(async ({}, workerInfo) => {
  fixture = await prepareStage7Acceptance(e2eDatabaseUrl, {
    reset: false,
    dayOffset: fixtureDayOffset
      + (workerInfo.project.name === "mobile" ? 30 : 0)
      + workerInfo.workerIndex * 60
  });
});

test("whole-room cells open the exact order and adjacent same-nickname orders never merge", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 order context coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await showFixtureRange(page);

  const wholeRoomContext = await selectOccupiedCell(
    page,
    fixture.wholeRoom.roomId,
    fixture.dates.arrivalDate,
    fixture.wholeRoom.orderId
  );
  await expect(wholeRoomContext).toContainText("小川");
  await expect(wholeRoomContext).toContainText("阿宁");
  for (let offset = 0; offset < 5; offset += 1) {
    await expect(roomCell(page, fixture.wholeRoom.roomId, addDays(fixture.dates.arrivalDate, offset)))
      .toHaveClass(/is-stay-selected/);
  }
  await closeOrderContext(wholeRoomContext);

  const [first, second] = fixture.adjacentSameNickname;
  const firstContext = await selectOccupiedCell(page, first!.roomId, fixture.dates.arrivalDate, first!.orderId);
  await expect(firstContext).toContainText("小满");
  await expect(roomCell(page, first!.roomId, fixture.dates.arrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, second!.roomId, fixture.dates.arrivalDate)).not.toHaveClass(/is-stay-selected/);
  await closeOrderContext(firstContext);

  const secondContext = await selectOccupiedCell(page, second!.roomId, fixture.dates.arrivalDate, second!.orderId);
  await expect(secondContext).toContainText("小满");
  await expect(roomCell(page, second!.roomId, fixture.dates.arrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, first!.roomId, fixture.dates.arrivalDate)).not.toHaveClass(/is-stay-selected/);
  await expect(page.locator(".room-status-order-context:visible")).toHaveCount(1);
  await expect(secondContext).not.toContainText(first!.orderId);
});

test("split-bed parent refuses to guess while each expanded bed opens its own order", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 split-bed ambiguity coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await showFixtureRange(page);

  const parentCell = roomCell(page, fixture.splitBed.roomId, fixture.dates.arrivalDate);
  await parentCell.focus();
  await page.keyboard.press("Enter");
  await expect(parentCell).toHaveAttribute("data-bed-occupancy-ratio", "2/4");
  await expect(page.locator(".room-status-order-context")).toHaveCount(0);
  await expect(page.locator(".room-status-day-cell.is-stay-selected")).toHaveCount(0);
  const parentPopover = page.getByTestId("room-status-quick-popover");
  await expect(parentPopover).toHaveAttribute("data-unit-id", fixture.splitBed.roomId);
  await expect(parentPopover).toHaveAttribute("data-selection-kind", "day");
  await expect(parentPopover.locator(".room-status-quick-orders button")).toHaveCount(2);
  await expect(parentPopover).toContainText("山峰");
  await expect(parentPopover).toContainText("小满");
  await expect(parentPopover).not.toContainText(/order_|订单 order/);
  await expect(page.getByTestId("member-search")).toHaveCount(0);
  await expect(page.getByTestId("create-order")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /报价/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const expandButton = roomRow(page, fixture.splitBed.roomId).getByRole("button", { name: /^展开.*床位$/ });
  await expandButton.click();
  await expect(roomRow(page, fixture.splitBed.bedAId)).toBeVisible();
  for (let offset = 0; offset < 5; offset += 1) {
    const serviceDate = addDays(fixture.dates.arrivalDate, offset);
    await expect(roomCell(page, fixture.splitBed.bedAId, serviceDate)).toContainText("山峰");
    await expect(roomCell(page, fixture.splitBed.bedAId, serviceDate)).not.toContainText("小满");
    await expect(roomCell(page, fixture.splitBed.bedBId, serviceDate)).toContainText("小满");
    await expect(roomCell(page, fixture.splitBed.bedBId, serviceDate)).not.toContainText("山峰");
  }
  const bedAContext = await selectOccupiedCell(
    page,
    fixture.splitBed.bedAId,
    fixture.dates.arrivalDate,
    fixture.splitBed.bedAOrderId
  );
  await expect(bedAContext).toContainText("山峰");
  await expect(roomCell(page, fixture.splitBed.bedAId, fixture.dates.arrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.splitBed.bedBId, fixture.dates.arrivalDate)).not.toHaveClass(/is-stay-selected/);
  await closeOrderContext(bedAContext);

  const bedBContext = await selectOccupiedCell(
    page,
    fixture.splitBed.bedBId,
    fixture.dates.arrivalDate,
    fixture.splitBed.bedBOrderId
  );
  await expect(bedBContext).toContainText("小满");
  await expect(roomCell(page, fixture.splitBed.bedBId, fixture.dates.arrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.splitBed.bedAId, fixture.dates.arrivalDate)).not.toHaveClass(/is-stay-selected/);
});

test("selecting either side of a move highlights one Stay across rows and a clipped date window", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 stable Stay identity coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await showFixtureRange(page, { clipped: true });

  const visibleOldRoomDate = addDays(fixture.dates.arrivalDate, 1);
  const contextFromOriginalRoom = await selectOccupiedCell(
    page,
    fixture.movedStay.fromRoomId,
    visibleOldRoomDate,
    fixture.movedStay.orderId
  );
  await expect(contextFromOriginalRoom.getByRole("heading", { name: "小满的住宿订单", exact: true })).toBeVisible();
  await expect(contextFromOriginalRoom).toContainText("B01");
  await expect(contextFromOriginalRoom).toContainText("B02");
  await expect(contextFromOriginalRoom).toContainText(fixture.dates.arrivalDate);
  await expect(contextFromOriginalRoom).toContainText(fixture.dates.departureDate);

  await expect(roomCell(page, fixture.movedStay.fromRoomId, visibleOldRoomDate)).toHaveClass(/is-stay-selected/);
  for (let offset = 2; offset < 4; offset += 1) {
    await expect(roomCell(page, fixture.movedStay.toRoomId, addDays(fixture.dates.arrivalDate, offset)))
      .toHaveClass(/is-stay-selected/);
  }
  await expect(roomCell(page, fixture.movedStay.fromRoomId, fixture.dates.moveDate)).not.toHaveClass(/is-stay-selected/);
  await closeOrderContext(contextFromOriginalRoom);

  const unrelatedOrder = fixture.adjacentSameNickname[0]!;
  const unrelatedContext = await selectOccupiedCell(
    page,
    unrelatedOrder.roomId,
    visibleOldRoomDate,
    unrelatedOrder.orderId
  );
  await expect(roomCell(page, unrelatedOrder.roomId, visibleOldRoomDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.movedStay.fromRoomId, visibleOldRoomDate)).not.toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.movedStay.toRoomId, addDays(fixture.dates.arrivalDate, 2))).not.toHaveClass(/is-stay-selected/);
  await closeOrderContext(unrelatedContext);

  const visibleNewRoomDate = addDays(fixture.dates.arrivalDate, 3);
  const contextFromNewRoom = await selectOccupiedCell(
    page,
    fixture.movedStay.toRoomId,
    visibleNewRoomDate,
    fixture.movedStay.orderId
  );
  await expect(contextFromNewRoom.getByRole("heading", { name: "小满的住宿订单", exact: true })).toBeVisible();
  await expect(page.locator(".room-status-order-context:visible")).toHaveCount(1);
  await expect(roomCell(page, fixture.movedStay.fromRoomId, visibleOldRoomDate)).toHaveClass(/is-stay-selected/);
  for (let offset = 2; offset < 4; offset += 1) {
    await expect(roomCell(page, fixture.movedStay.toRoomId, addDays(fixture.dates.arrivalDate, offset)))
      .toHaveClass(/is-stay-selected/);
  }
  await expect(roomCell(page, fixture.movedStay.fromRoomId, fixture.dates.moveDate)).not.toHaveClass(/is-stay-selected/);
});

test("moving the selected Stay in room status restores it on the latest room", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7R return identity coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await showFixtureRange(page);

  const filteredBoard = roomStatusResponse(page);
  await page.getByLabel("搜索房间或床位", { exact: true }).fill("B02");
  await filteredBoard;
  await expect(roomRow(page, fixture.movedStay.fromRoomId)).toHaveCount(0);

  const selectedDate = fixture.dates.moveDate;
  const context = await selectOccupiedCell(
    page,
    fixture.movedStay.toRoomId,
    selectedDate,
    fixture.movedStay.orderId
  );
  const roomStatusUrl = page.url();
  await context.getByRole("button", { name: "换房", exact: true }).click();
  await expect(page).toHaveURL(roomStatusUrl);
  const moveDrawer = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(moveDrawer).toBeVisible();
  await expect(moveDrawer.getByTestId("move-unit-order-context")).toContainText("小满");
  await moveDrawer.getByTestId("move-unit-id").selectOption(fixture.movedStay.fromRoomId);
  await moveDrawer.getByTestId("move-effective-date").fill(selectedDate);
  await moveDrawer.getByTestId("move-unit-reason").fill("阶段 7R 返回房态选择回归");
  await expect(moveDrawer.getByTestId("move-unit-preview")).toBeVisible({ timeout: 30_000 });
  await moveDrawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const moveReview = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(moveReview.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await moveReview.getByTestId("confirm-command").click();
  await expect(moveReview).toBeHidden({ timeout: 30_000 });

  const restoredContext = orderContext(page, fixture.movedStay.orderId);
  await expect(restoredContext).toBeVisible();
  await expect(page.getByLabel("搜索房间或床位", { exact: true })).toHaveValue("");
  await expect(roomCell(page, fixture.movedStay.toRoomId, selectedDate)).not.toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.movedStay.fromRoomId, fixture.dates.arrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.movedStay.fromRoomId, selectedDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.movedStay.fromRoomId, selectedDate)).toBeFocused();
  for (const otherOrder of fixture.adjacentSameNickname) {
    await expect(roomCell(page, otherOrder.roomId, fixture.dates.arrivalDate)).not.toHaveClass(/is-stay-selected/);
    await expect(restoredContext).not.toContainText(otherOrder.orderId);
  }
});

test("READ order context keeps navigation but exposes no business write entry", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 READ authorization coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await login(page, stage7ReadOnlyOperator);
  expect(board.accessLevel).toBe("READ");
  await showFixtureRange(page);

  const context = await selectOccupiedCell(
    page,
    fixture.wholeRoom.roomId,
    fixture.dates.arrivalDate,
    fixture.wholeRoom.orderId
  );
  await expect(context).toContainText("只读");
  await expect(orderDrawer(page).getByRole("button", { name: "查看完整订单", exact: true })).toBeVisible();
  await expect(context.getByRole("button", { name: "更正资料", exact: true })).toHaveCount(0);
  await expect(context.getByRole("button", {
    name: /办理入住|办理退房|缩短住宿|续住|换房|取消订单|标记未到|记录收款|记录退款|登记收款|登记退款|收款|退款/
  })).toHaveCount(0);
});

test("external collection and full refund refresh amounts and refund availability without a room-status revision bump", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 external money refresh coverage");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await showFixtureRange(page);

  const context = await selectOccupiedCell(
    page,
    fixture.wholeRoom.roomId,
    fixture.dates.arrivalDate,
    fixture.wholeRoom.orderId
  );
  await expect(context.getByRole("button", { name: "更正资料", exact: true })).toHaveCount(0);
  const transactionReference = `STAGE7-EXTERNAL-COLLECTION-${crypto.randomUUID()}`;
  const collectionKey = `stage7-external-collection-${crypto.randomUUID()}`;
  const db = createDatabase(e2eDatabaseUrl);
  try {
    const before = await getOrderView(db, fixture.wholeRoom.orderId, "WRITE");
    const collectionPreview = await createCommandPreview(db, externalOperator, {
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId,
        orderId: fixture.wholeRoom.orderId,
        amountMinor: 1_234,
        method: "BANK_TRANSFER",
        transactionReference,
        note: "阶段七外部收款刷新"
      }
    }, { idempotencyKey: `${collectionKey}-preview`, correlationId: collectionKey });
    const collection = await confirmCommandPreview(db, externalOperator, collectionPreview.preview.previewId, {
      propertyId,
      commandType: "RECORD_COLLECTION",
      confirmation: true,
      expectedEffectHash: collectionPreview.preview.effectHash,
      reason: { code: "EXTERNAL_COLLECTION", note: "另一位操作员记录收款" }
    }, { idempotencyKey: `${collectionKey}-confirm`, correlationId: collectionKey });
    expect(collection).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const refreshedBoard = roomStatusResponse(page);
    const refreshedOrder = orderResponse(page, fixture.wholeRoom.orderId);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await Promise.all([refreshedBoard, refreshedOrder]);
    await expect(context).toContainText(transactionReference);
    await expect(context.getByRole("button", { name: "登记退款", exact: true })).toBeVisible();

    const refundReference = `STAGE7-EXTERNAL-REFUND-${crypto.randomUUID()}`;
    const refundKey = `stage7-external-refund-${crypto.randomUUID()}`;
    const refundPreview = await createCommandPreview(db, externalOperator, {
      commandType: "RECORD_REFUND",
      input: {
        propertyId,
        orderId: fixture.wholeRoom.orderId,
        amountMinor: 1_234,
        referencesFactId: collection.factRefs[0]!,
        method: "BANK_TRANSFER",
        transactionReference: refundReference,
        note: "阶段七外部全额退款刷新"
      }
    }, { idempotencyKey: `${refundKey}-preview`, correlationId: refundKey });
    const refund = await confirmCommandPreview(db, externalOperator, refundPreview.preview.previewId, {
      propertyId,
      commandType: "RECORD_REFUND",
      confirmation: true,
      expectedEffectHash: refundPreview.preview.effectHash,
      reason: { code: "EXTERNAL_REFUND", note: "另一位操作员记录全额退款" }
    }, { idempotencyKey: `${refundKey}-confirm`, correlationId: refundKey });
    expect(refund).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });

    const refundBoard = roomStatusResponse(page);
    const refundOrder = orderResponse(page, fixture.wholeRoom.orderId);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await Promise.all([refundBoard, refundOrder]);
    await expect(context).toContainText(refundReference);
    await expect(context.getByRole("button", { name: "登记退款", exact: true })).toHaveCount(0);
    expect((await getOrderView(db, fixture.wholeRoom.orderId, "WRITE")).collectionFacts.length)
      .toBe(before.collectionFacts.length + 2);
  } finally {
    await db.destroy();
  }
});

test("occupant correction Preview and Confirm refresh both order context and room-status nickname", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 correction workflow coverage");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, administrator);
  await showFixtureRange(page);

  const db = createDatabase(e2eDatabaseUrl);
  const originalOccupant = await db.selectFrom("order_occupants")
    .select(["full_name", "nickname", "phone", "document_number"])
    .where("id", "=", fixture.wholeRoom.primaryOccupantId)
    .executeTakeFirstOrThrow();
  const memberBefore = await db.selectFrom("members").selectAll().orderBy("id").execute();
  await db.destroy();

  const context = await selectOccupiedCell(
    page,
    fixture.wholeRoom.roomId,
    fixture.dates.arrivalDate,
    fixture.wholeRoom.orderId
  );
  await context.getByRole("button", { name: "更正资料", exact: true }).first().click();
  const correctionDialog = page.getByRole("dialog", { name: "更正住宿人资料", exact: true });
  await expect(correctionDialog).toBeVisible();
  await page.getByTestId("occupant-correction-nickname").fill("小河");
  await page.getByTestId("occupant-correction-full-name").fill("阶段七更正后住客");
  await page.getByTestId("occupant-correction-phone").fill("13900000007");
  await page.getByTestId("occupant-correction-document-number").fill("STAGE7-CORRECTED-001");
  await page.getByTestId("occupant-correction-reason").fill("人工验收：修正录入错误");
  await correctionDialog.getByRole("button", { name: "继续核对更正", exact: true }).click();

  const correctionEffect = page.getByTestId("command-effect");
  await expect(correctionEffect).toBeVisible({ timeout: 15_000 });
  await expect(correctionEffect).toContainText("小河");
  await expect(correctionEffect).toContainText("阶段七更正后住客");
  await expect(correctionEffect).toContainText("人工验收：修正录入错误");
  await expect(page.getByTestId("reason-note")).toHaveCount(0);

  const refreshedBoard = roomStatusResponse(page);
  const refreshedOrder = orderResponse(page, fixture.wholeRoom.orderId);
  await page.getByTestId("confirm-command").click();
  await Promise.all([refreshedBoard, refreshedOrder]);
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-receipt")).toBeHidden();

  const refreshedContext = orderContext(page, fixture.wholeRoom.orderId);
  await expect(refreshedContext).toContainText("小河");
  await expect(refreshedContext).toContainText("阶段七更正后住客");
  await expect(refreshedContext).toContainText("人工验收：修正录入错误");
  await expect(roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate)
    .locator(".room-status-direct-occupants")).toContainText("小河");

  const verificationDb = createDatabase(e2eDatabaseUrl);
  try {
    const immutableOriginal = await verificationDb.selectFrom("order_occupants")
      .select(["full_name", "nickname", "phone", "document_number"])
      .where("id", "=", fixture.wholeRoom.primaryOccupantId)
      .executeTakeFirstOrThrow();
    expect(immutableOriginal).toEqual(originalOccupant);
    const correction = await verificationDb.selectFrom("order_occupant_corrections")
      .select(["corrected_full_name", "corrected_nickname", "corrected_phone", "corrected_document_number", "reason_note"])
      .where("occupant_id", "=", fixture.wholeRoom.primaryOccupantId)
      .executeTakeFirstOrThrow();
    expect(correction).toEqual({
      corrected_full_name: "阶段七更正后住客",
      corrected_nickname: "小河",
      corrected_phone: "13900000007",
      corrected_document_number: "STAGE7-CORRECTED-001",
      reason_note: "人工验收：修正录入错误"
    });
    expect(await verificationDb.selectFrom("members").selectAll().orderBy("id").execute()).toEqual(memberBefore);
  } finally {
    await verificationDb.destroy();
  }
});

test("an external occupant correction refreshes the open context and remains visible without machine references", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 external revision coverage");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, administrator);
  await showFixtureRange(page);

  await roomRow(page, fixture.splitBed.roomId).getByRole("button", { name: /^展开.*床位$/ }).click();
  const context = await selectOccupiedCell(
    page,
    fixture.splitBed.bedBId,
    fixture.dates.arrivalDate,
    fixture.splitBed.bedBOrderId
  );
  await expect(context).toContainText("小满");
  await context.getByRole("button", { name: "更正资料", exact: true }).click();
  const staleDialog = page.getByRole("dialog", { name: "更正住宿人资料", exact: true });
  await page.getByTestId("occupant-correction-nickname").fill("旧表单昵称");
  await page.getByTestId("occupant-correction-reason").fill("该表单应因外部更正而失效");

  const db = createDatabase(e2eDatabaseUrl);
  try {
    const current = await getOrderView(db, fixture.splitBed.bedBOrderId, "WRITE");
    const occupant = current.occupants[0]!;
    const key = `stage7-external-correction-${crypto.randomUUID()}`;
    const prepared = await createCommandPreview(db, externalAdministrator, {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId,
        orderId: fixture.splitBed.bedBOrderId,
        occupantId: occupant.id,
        expectedPriorSnapshot: {
          fullName: occupant.fullName,
          nickname: occupant.nickname,
          phone: occupant.phone,
          documentNumber: occupant.documentNumber
        },
        correctedSnapshot: {
          fullName: occupant.fullName,
          nickname: "秋实",
          phone: occupant.phone,
          documentNumber: occupant.documentNumber
        }
      }
    }, { idempotencyKey: `${key}-preview`, correlationId: key });
    const receipt = await confirmCommandPreview(db, externalAdministrator, prepared.preview.previewId, {
      propertyId,
      commandType: "CORRECT_ORDER_OCCUPANT",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "EXTERNAL_DATA_CORRECTION", note: "另一位操作员核对后更正" }
    }, { idempotencyKey: `${key}-confirm`, correlationId: key });
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
  } finally {
    await db.destroy();
  }

  const refreshedBoard = roomStatusResponse(page);
  const refreshedOrder = orderResponse(page, fixture.splitBed.bedBOrderId);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await Promise.all([refreshedBoard, refreshedOrder]);
  await expect(context).toContainText("秋实");
  await expect(roomCell(page, fixture.splitBed.bedBId, fixture.dates.arrivalDate)).toHaveAccessibleName(/秋实/);
  await expect(staleDialog).toBeHidden();
  await expect(page.getByRole("alert").filter({ hasText: "原更正表单已关闭" })).toBeVisible();

  const correctionAmendment = context.getByRole("region", { name: "资料更正记录", exact: true }).getByRole("listitem")
    .filter({ hasText: "另一位操作员核对后更正" });
  await expect(correctionAmendment).toContainText(externalAdministrator.displayName);
  await expect(correctionAmendment).toContainText("昵称：小满 → 秋实");
});

test("fixed 30-night timeline keeps stable columns while desktop context opens and the viewport widens", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 fixed timeline geometry coverage");
  await page.setViewportSize({ width: 1440, height: 800 });
  await login(page);
  await showFixtureRange(page, { nights: 14 });

  const drawer = page.locator("dialog.modal-drawer");
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('[data-testid^="date-window-mode-"]')).toHaveCount(0);
  await expect(page.locator(".room-status-date-header")).toHaveCount(30);

  const trigger = roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate);
  const widthBeforeOrder = await trigger.evaluate((element) => element.getBoundingClientRect().width);
  expect(widthBeforeOrder).toBeCloseTo(94, 0);

  const context = await selectOccupiedCell(
    page,
    fixture.wholeRoom.roomId,
    fixture.dates.arrivalDate,
    fixture.wholeRoom.orderId
  );
  await expect(drawer).toBeVisible();
  await expect(page.locator(".room-status-date-header")).toHaveCount(30);
  expect(await trigger.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(widthBeforeOrder, 1);

  await closeOrderContext(context);
  await expect(drawer).toBeHidden();
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect(page.locator(".room-status-date-header")).toHaveCount(30);
  expect(await trigger.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(widthBeforeOrder, 1);
});

test("desktop drawer geometry, Escape focus, and full-order return preserve room-status context", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only Stage 7 responsive context coverage");
  test.setTimeout(120_000);
  const viewports = [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 800 }
  ];
  let scrollRefreshChecked = false;

  await page.setViewportSize(viewports[0]!);
  await login(page);
  await showFixtureRange(page);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const trigger = roomCell(page, fixture.wholeRoom.roomId, fixture.dates.arrivalDate);
    await expect(trigger).toBeVisible();
    const context = await selectOccupiedCell(
      page,
      fixture.wholeRoom.roomId,
      fixture.dates.arrivalDate,
      fixture.wholeRoom.orderId
    );
    const workspaceWidth = await page.locator(".room-status-workspace").evaluate((element) => element.getBoundingClientRect().width);
    const drawer = page.locator("dialog.modal-drawer");
    if (viewport.width <= 1366 || workspaceWidth < 1240) await expect(drawer).toBeVisible();
    else await expect(drawer).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".room-status-grid-scroll");
      const grid = document.querySelector<HTMLElement>("[role='grid']");
      if (!scroll || !grid) return null;
      const scrollBox = scroll.getBoundingClientRect();
      const visibleRows = [...grid.querySelectorAll<HTMLElement>("[data-room-status-row]")]
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.bottom > scrollBox.top && box.top < scrollBox.bottom;
        }).length;
      return {
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        visibleRows,
        drawerBox: document.querySelector<HTMLElement>("dialog.modal-drawer")?.getBoundingClientRect().toJSON() ?? null
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.scrollWidth).toBeLessThanOrEqual(geometry!.clientWidth + 1);
    expect(geometry!.visibleRows).toBeGreaterThanOrEqual(4);

    if (await drawer.count()) {
      expect(geometry!.drawerBox).not.toBeNull();
      expect(geometry!.drawerBox!.top).toBeCloseTo(0, 0);
      expect(geometry!.drawerBox!.right).toBeCloseTo(geometry!.clientWidth, 0);
      expect(geometry!.drawerBox!.bottom).toBeCloseTo(geometry!.clientHeight, 0);
      if (!scrollRefreshChecked) {
        scrollRefreshChecked = true;
        const drawerBody = drawer.locator(".modal-body");
        const scrollBeforeRefresh = await drawerBody.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        expect(scrollBeforeRefresh).toBeGreaterThan(0);
        const refreshedBoard = roomStatusResponse(page);
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await refreshedBoard;
        await expect(context).toBeVisible();
        expect(await drawerBody.evaluate((element) => element.scrollTop)).toBe(scrollBeforeRefresh);
      }
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();
    } else {
      await closeOrderContext(context);
    }
  }

  const expandButton = roomRow(page, fixture.splitBed.roomId).getByRole("button", { name: /^展开.*床位$/ });
  await expandButton.click();
  const triggerDate = addDays(fixture.dates.arrivalDate, 1);
  const bedCell = roomCell(page, fixture.splitBed.bedAId, triggerDate);
  const context = await selectOccupiedCell(
    page,
    fixture.splitBed.bedAId,
    triggerDate,
    fixture.splitBed.bedAOrderId
  );
  await orderDrawer(page).getByRole("button", { name: "查看完整订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${fixture.splitBed.bedAOrderId}$`));
  await expect(page.getByText(fixture.splitBed.bedAOrderId, { exact: true })).toHaveCount(0);

  const returnedBoard = roomStatusResponse(page);
  await page.getByRole("link", { name: "返回房态", exact: true }).click();
  await returnedBoard;
  await expect(page.getByTestId("arrival-date")).toHaveValue(fixture.dates.arrivalDate);
  await expect(roomRow(page, fixture.splitBed.bedAId)).toBeVisible();
  await expect(roomRow(page, fixture.splitBed.roomId).getByRole("button", { name: /^收起.*床位$/ })).toBeVisible();
  await expect(bedCell).toHaveClass(/is-stay-selected/);
  await expect(bedCell).toBeFocused();
  await expect(orderContext(page, fixture.splitBed.bedAOrderId)).toBeVisible();
});

test("desktop order drawer keeps wheel scrolling inside the drawer at its middle and bottom", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only drawer wheel isolation coverage");
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page);
  await showFixtureRange(page);

  await selectOccupiedCell(
    page,
    fixture.wholeRoom.roomId,
    fixture.dates.arrivalDate,
    fixture.wholeRoom.orderId
  );
  const drawer = page.locator("dialog.modal-drawer");
  const drawerBody = drawer.locator(".modal-body");
  await expect(drawerBody).toBeVisible();

  const initial = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    const maximumWindowY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(160, maximumWindowY) });
    return {
      maximumWindowY,
      windowX: window.scrollX,
      windowY: window.scrollY,
      gridLeft: grid?.scrollLeft ?? 0,
      gridTop: grid?.scrollTop ?? 0
    };
  });
  expect(initial.maximumWindowY).toBeGreaterThan(0);

  const drawerMaximum = await drawerBody.evaluate((element) => Math.max(0, element.scrollHeight - element.clientHeight));
  expect(drawerMaximum).toBeGreaterThan(80);
  const drawerBox = await drawerBody.boundingBox();
  expect(drawerBox).not.toBeNull();
  await page.mouse.move(drawerBox!.x + drawerBox!.width / 2, drawerBox!.y + drawerBox!.height / 2);

  const middleBefore = await drawerBody.evaluate((element, maximum) => {
    element.scrollTop = Math.floor(maximum / 2);
    return element.scrollTop;
  }, drawerMaximum);
  const shellBeforeMiddleWheel = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  });
  await page.mouse.wheel(0, 120);
  await expect.poll(() => drawerBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(middleBefore);
  await expect.poll(() => page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  })).toEqual(shellBeforeMiddleWheel);

  await drawerBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const bottomBefore = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  });
  await page.mouse.wheel(0, 320);
  await expect.poll(() => drawerBody.evaluate((element) => (
    Math.abs(element.scrollTop - Math.max(0, element.scrollHeight - element.clientHeight)) <= 1
  ))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
    return { windowX: window.scrollX, windowY: window.scrollY, gridLeft: grid?.scrollLeft ?? 0, gridTop: grid?.scrollTop ?? 0 };
  })).toEqual(bottomBefore);
});

test("375px mobile occupancy opens and closes the order context, then returns from the full order", async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo), "mobile-only Stage 7 order context coverage");
  await page.setViewportSize({ width: 375, height: 812 });
  await loginMobile(page);
  await showFixtureRange(page);

  const occupancy = page.locator(".room-status-mobile-occupancies li").filter({ hasText: "小川" }).first();
  const trigger = occupancy.getByRole("button", { name: "查看订单信息", exact: true });
  const selectedOrderResponse = orderResponse(page, fixture.wholeRoom.orderId);
  await trigger.click();
  await selectedOrderResponse;
  const context = orderContext(page, fixture.wholeRoom.orderId);
  await expect(context).toBeVisible();
  await expect(context).toContainText("小川");
  await expect(context).toContainText("阿宁");

  await page.keyboard.press("Escape");
  await expect(context).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(context).toBeVisible();
  await orderDrawer(page).getByRole("button", { name: "查看完整订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${fixture.wholeRoom.orderId}$`));
  await expect(page.getByText(fixture.wholeRoom.orderId, { exact: true })).toHaveCount(0);

  const returnedBoard = roomStatusResponse(page);
  await page.getByRole("link", { name: "返回房态", exact: true }).click();
  await returnedBoard;
  const [, month, day] = fixture.dates.arrivalDate.split("-");
  await expect(page.getByRole("region", { name: "查看房态日期", exact: true }))
    .toContainText(`${Number(month)}月${Number(day)}日`);
  await expect(orderContext(page, fixture.wholeRoom.orderId)).toBeVisible();
});

test("375px mobile split-bed summary keeps the parent neutral and opens each exact bed order", async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo), "mobile-only Stage 7 split-bed order context coverage");
  await page.setViewportSize({ width: 375, height: 812 });
  await loginMobile(page);
  await showFixtureRange(page);

  const occupancies = page.locator(".room-status-mobile-occupancies li");
  const parent = occupancies.filter({ hasText: "2/4" }).filter({ hasText: "山峰" }).first();
  await expect(parent).toBeVisible();
  await expect(parent.getByRole("button", { name: "查看订单信息", exact: true })).toHaveCount(0);

  const bedA = occupancies
    .filter({ has: page.locator("[data-mobile-bed-occupant-line]", { hasText: "山峰" }) })
    .filter({ has: page.getByRole("button", { name: "查看订单信息", exact: true }) })
    .first();
  const selectedOrderResponse = orderResponse(page, fixture.splitBed.bedAOrderId);
  await bedA.getByRole("button", { name: "查看订单信息", exact: true }).click();
  await selectedOrderResponse;
  const context = orderContext(page, fixture.splitBed.bedAOrderId);
  await expect(context).toBeVisible();
  await expect(context).toContainText("山峰");
  await expect(context).not.toContainText(fixture.splitBed.bedBOrderId);
});

test("320px READ mobile context exposes navigation but no correction or business action", async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo), "mobile-only Stage 7 READ authorization coverage");
  await page.setViewportSize({ width: 320, height: 720 });
  const board = await loginMobile(page, stage7ReadOnlyOperator);
  expect(board.accessLevel).toBe("READ");
  await showFixtureRange(page);

  const occupancy = page.locator(".room-status-mobile-occupancies li").filter({ hasText: "小川" }).first();
  const selectedOrderResponse = orderResponse(page, fixture.wholeRoom.orderId);
  await occupancy.getByRole("button", { name: "查看订单信息", exact: true }).click();
  await selectedOrderResponse;
  const context = orderContext(page, fixture.wholeRoom.orderId);
  await expect(context).toBeVisible();
  await expect(context).toContainText("只读");
  await expect(orderDrawer(page).getByRole("button", { name: "查看完整订单", exact: true })).toBeVisible();
  await expect(context.getByRole("button", { name: "更正资料", exact: true })).toHaveCount(0);
  await expect(context.getByRole("button", {
    name: /办理入住|办理退房|缩短住宿|续住|换房|取消订单|标记未到|记录收款|记录退款|登记收款|登记退款|收款|退款/
  })).toHaveCount(0);
  const geometry = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(geometry.bodyOverflow).toBe("hidden");
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
});
