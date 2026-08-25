import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { resetE2eDatabase } from "./reset-database.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const operator = { username: "operator", password: "demo-pass-2026" };

interface RoomStatusFixtureUnit {
  id: string;
  code: string;
  allowedActions: Array<{ code: string; enabled: boolean }>;
  days: Array<{
    serviceDate: string;
    status: string;
    available: boolean;
    intervalIds: string[];
    conflicts: unknown[];
  }>;
  intervals: Array<{
    status: string;
    sourceStartDate: string;
    sourceEndDate: string;
    references: Array<{ type: string; id: string }>;
  }>;
  children: RoomStatusFixtureUnit[];
}

interface RoomStatusFixtureBoard {
  businessDate: string;
  rooms: RoomStatusFixtureUnit[];
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeDates(arrivalDate: string, departureDate: string): string[] {
  const dates: string[] = [];
  for (let cursor = arrivalDate; cursor < departureDate; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

function roomCell(page: Page, unitId: string, serviceDate: string) {
  return page.locator(`[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`);
}

function candidateForCrossTodayBackfill(
  board: RoomStatusFixtureBoard,
  arrivalDate: string,
  departureDate: string
): RoomStatusFixtureUnit | undefined {
  return board.rooms.find((unit) => {
    if (unit.children.length > 0) return false;
    if (!unit.allowedActions.some((action) => action.code === "BACKFILL_ORDER" && action.enabled)) return false;
    const days = rangeDates(arrivalDate, departureDate).map((date) => unit.days.find((day) => day.serviceDate === date));
    return days.every((day) => day
      && day.conflicts.length === 0
      && day.intervalIds.length === 0
      && (day.serviceDate < board.businessDate ? day.status === "AVAILABLE" : day.available));
  });
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(operator.username);
  await page.getByTestId("login-password").fill(operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible({ timeout: 30_000 });
}

async function setBoardRange(page: Page, arrivalDate: string): Promise<RoomStatusFixtureBoard> {
  const departureDate = addDays(arrivalDate, 30);
  const rangeResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname.endsWith("/room-status")
      && url.searchParams.get("arrivalDate") === arrivalDate
      && url.searchParams.get("departureDate") === departureDate
      && response.ok();
  });
  await page.getByTestId("arrival-date").fill(arrivalDate);
  const response = await rangeResponse;
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("room-status-board-range")).toHaveAttribute("data-range-arrival", arrivalDate);
  return response.json() as Promise<RoomStatusFixtureBoard>;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await resetE2eDatabase(e2eDatabaseUrl);
});

test("8.4 跨今天补录：一次确认直接成为在住并连续占用整段", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop browser journey");
  await login(page);

  const probe = await page.request.get(
    `/api/v1/properties/${propertyId}/room-status?arrivalDate=2026-01-01&departureDate=2026-01-31&page=0&pageSize=200`
  );
  expect(probe.ok(), await probe.text()).toBe(true);
  const { businessDate } = await probe.json() as Pick<RoomStatusFixtureBoard, "businessDate">;
  const arrivalDate = addDays(businessDate, -2);
  const departureDate = addDays(businessDate, 2);
  const nickname = `在住补录验收-${testInfo.workerIndex}`;

  const board = await setBoardRange(page, arrivalDate);
  const unit = candidateForCrossTodayBackfill(board, arrivalDate, departureDate);
  expect(unit, "需要一个跨今天空房用于补录").toBeDefined();
  if (!unit) throw new Error("No cross-today backfill candidate");

  const cell = roomCell(page, unit.id, arrivalDate);
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toBeVisible();
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible({ timeout: 10_000 });
  await expect(popover).toHaveAttribute("data-unit-id", unit.id);
  await popover.getByRole("button", { name: "补录住宿", exact: true }).click();

  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await drawer.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await drawer.getByLabel("退房日期", { exact: true }).fill(departureDate);
  await expect(drawer.getByTestId("quote-result")).toContainText("4 晚", { timeout: 30_000 });
  await drawer.getByTestId("primary-guest-nickname").fill(nickname);
  await drawer.getByTestId("primary-guest-name").fill("跨今天补录验收住客");
  await drawer.getByTestId("primary-guest-phone").fill("13800008404");
  await drawer.getByTestId("booking-channel-code").selectOption("WECOM");
  await expect(drawer.getByTestId("target-contract-amount")).not.toHaveValue("");
  await drawer.getByTestId("backfill-reason").fill("客人已从过去日期实际入住，现补录为当前在住");
  await drawer.getByTestId("backfill-amount").fill("1.00");
  await drawer.getByTestId("backfill-transaction-reference").fill(`WX-E2E-INHOUSE-${testInfo.workerIndex}`);

  const previewResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/v1/command-previews"
      && response.status() === 200
  ));
  await drawer.getByTestId("backfill-submit").click();
  const preview = await previewResponse;
  const previewRequest = preview.request().postDataJSON() as { commandType?: string; input?: Record<string, unknown> };
  expect(previewRequest.commandType).toBe("CREATE_ORDER");
  expect(previewRequest.input).toMatchObject({ propertyId, backfill: true, backfillReason: "客人已从过去日期实际入住，现补录为当前在住" });

  const review = page.getByRole("dialog", { name: "补录住宿", exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole("heading", { name: "请核对在住住宿补录", exact: true })).toBeVisible();
  await expect(review).toContainText("提交后直接成为在住");
  await expect(review).toContainText("已发生实收");
  await expect(review).not.toContainText("创建预订");
  await expect(review).not.toContainText("逐步办理入住");

  const confirmResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && /\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
      && response.status() === 200
  ));
  await review.getByRole("button", { name: "确认补录住宿", exact: true }).click();
  const confirmed = await confirmResponse;
  const receipt = await confirmed.json() as { result?: { orderId?: string; status?: string } };
  expect(receipt.result?.status).toBe("CHECKED_IN");
  const orderId = receipt.result?.orderId;
  expect(orderId).toBeTruthy();
  await expect(review).toContainText("订单已在住", { timeout: 30_000 });

  const orderResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(orderId!)}`);
  expect(orderResponse.ok(), await orderResponse.text()).toBe(true);
  const order = await orderResponse.json() as {
    order: { status: string };
    stay: { status: string };
    amounts: {
      currentContractAmount: { minorUnits: number };
      netRecordedCollection: { minorUnits: number };
    };
    collectionFacts: Array<{ fact_type: string; amount_minor: number; transaction_reference: string | null }>;
    allowedActions: Array<{ code: string; enabled: boolean; disabledReason: string | null }>;
  };
  expect(order.order.status).toBe("CHECKED_IN");
  expect(order.stay.status).toBe("IN_HOUSE");
  expect(order.amounts.netRecordedCollection.minorUnits).toBe(100);
  expect(order.amounts.currentContractAmount.minorUnits).toBeGreaterThan(100);
  expect(order.collectionFacts).toEqual([expect.objectContaining({
    fact_type: "COLLECTION",
    amount_minor: 100,
    transaction_reference: `WX-E2E-INHOUSE-${testInfo.workerIndex}`
  })]);
  expect(order.allowedActions).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "EXTEND_STAY", enabled: true }),
    expect.objectContaining({ code: "SHORTEN_STAY", enabled: true }),
    expect.objectContaining({ code: "MOVE_UNIT", enabled: true })
  ]));

  const statusResponse = await page.request.get(
    `/api/v1/properties/${propertyId}/room-status?arrivalDate=${arrivalDate}&departureDate=${departureDate}&page=0&pageSize=200`
  );
  expect(statusResponse.ok(), await statusResponse.text()).toBe(true);
  const statusBoard = await statusResponse.json() as RoomStatusFixtureBoard;
  const projected = statusBoard.rooms.find((candidate) => candidate.id === unit.id)
    ?.intervals.find((interval) => interval.references.some((reference) => reference.type === "ORDER" && reference.id === orderId));
  expect(projected).toMatchObject({
    status: "IN_HOUSE",
    sourceStartDate: arrivalDate,
    sourceEndDate: departureDate
  });
});
