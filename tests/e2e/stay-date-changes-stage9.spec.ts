import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  prepareStage9Acceptance,
  prepareStage9MobileAcceptance,
  type Stage9AcceptanceFixture,
  type Stage9ExtensionFixture,
  type Stage9MobileAcceptanceFixture,
  type Stage9StayFixture
} from "./setup-stage9-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const desktopUnitCodeOverrides = {
  "101": "A03",
  "102": "A04",
  "103": "B03",
  "104": "B04",
  "105": "C01",
  "106": "C02",
  "107": "C03",
  "108": "C04",
  "109": "A01",
  "201": "A02",
  "202": "B02",
  "203": "203",
  "204": "204",
  D01: "302",
  D02: "E02"
} as const;
const forbiddenProtocol = /Preview|Confirm|Receipt|Command|RESCHEDULE_STAY|EXTEND_STAY|order_[a-z0-9_]+|segment_[a-z0-9_]+/i;
const roomStatusTimelineDays = 30;
let fixture: Stage9AcceptanceFixture;
let mobileFixture: Stage9MobileAcceptanceFixture;

test.describe.configure({ mode: "serial" });

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function roomStatusTimelineDepartureDate(arrivalDate: string): string {
  return addDays(arrivalDate, roomStatusTimelineDays);
}

function roomCell(page: Page, stay: Stage9StayFixture, date: string): Locator {
  return page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.unitId}"][data-service-date="${date}"]`);
}

function roomStatusResponse(page: Page, arrivalDate: string, departureDate: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${propertyId}/room-status`
      && url.searchParams.get("arrivalDate") === arrivalDate
      && url.searchParams.get("departureDate") === departureDate
      && response.status() === 200;
  }, { timeout: 30_000 });
}

async function login(page: Page, options: { roomStatusRange?: boolean } = {}): Promise<void> {
  const activeFixture = mobileFixture ?? fixture;
  const restoredDepartureDate = roomStatusTimelineDepartureDate(activeFixture.rangeArrivalDate);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  if (options.roomStatusRange) {
    await page.evaluate(({ arrivalDate, departureDate }) => {
      window.sessionStorage.setItem(
        "qintopia.room-status-view.v1:subject_demo_operator:prop_qintopia_demo",
        JSON.stringify({
          version: 1,
          propertyId: "prop_qintopia_demo",
          range: { arrivalDate, departureDate },
          revision: "stage9-acceptance-range",
          savedAt: new Date().toISOString(),
          state: {
            filters: { search: "", roomTypeCode: "ALL", salesMode: "ALL", status: "ALL", kind: "ALL", minimumCapacity: null },
            expandedRoomIds: [],
            roomPageIndex: 0,
            dateWindowStart: 0,
            dateWindowSize: 30,
            dateWindowMode: "30",
            focusedCell: null,
            selection: null,
            scrollAnchor: { unitId: null, left: 0, top: 0 }
          }
        })
      );
    }, { arrivalDate: activeFixture.rangeArrivalDate, departureDate: restoredDepartureDate });
  }
  await page.getByTestId("login-username").fill(activeFixture.operator.username);
  await page.getByTestId("login-password").fill(activeFixture.operator.password);
  const response = options.roomStatusRange
    ? roomStatusResponse(page, activeFixture.rangeArrivalDate, restoredDepartureDate)
    : undefined;
  await page.getByTestId("login-submit").click();
  await response;
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible({ timeout: 30_000 });
}

async function openOrder(page: Page, stay: Stage9StayFixture): Promise<void> {
  await page.goto(`/orders/${encodeURIComponent(stay.orderId)}`);
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
}

async function fillRescheduleForm(page: Page, stay: Stage9AcceptanceFixture["external"], reason: string): Promise<Locator> {
  const form = page.getByRole("dialog", { name: "调整住宿日期", exact: true });
  await expect(form).toBeVisible();
  await form.getByTestId("stay-date-arrival").fill(stay.newArrivalDate);
  await form.getByTestId("stay-date-departure").fill(stay.newDepartureDate);
  await form.getByTestId("stay-date-reason").fill(reason);
  return form;
}

async function continueToReview(page: Page, action: "调整住宿日期" | "延长住宿"): Promise<Locator> {
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  const review = page.getByRole("dialog", { name: action, exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review).not.toContainText(forbiddenProtocol);
  return review;
}

async function confirmReview(page: Page, action: "调整住宿日期" | "延长住宿"): Promise<void> {
  const review = page.getByRole("dialog", { name: action, exact: true });
  await review.getByRole("button", { name: `确认${action}`, exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
}

async function openRoomStatusOrder(page: Page, stay: Stage9StayFixture): Promise<Locator> {
  const cell = roomCell(page, stay, stay.arrivalDate);
  if (await cell.count() === 0) {
    const historicalDepartureDate = roomStatusTimelineDepartureDate(stay.arrivalDate);
    const historicalResponse = roomStatusResponse(page, stay.arrivalDate, historicalDepartureDate);
    await page.getByTestId("arrival-date").fill(stay.arrivalDate);
    await historicalResponse;
  }
  await expect(cell).toBeVisible({ timeout: 30_000 });
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", stay.unitId);
  await popover.getByRole("button", { name: new RegExp(stay.nickname) }).click();
  const context = page.locator(".room-status-order-context");
  await expect(context).toContainText(stay.nickname, { timeout: 30_000 });
  return context;
}

async function extendHistoricalStay(page: Page, stay: Stage9ExtensionFixture, reason: string): Promise<void> {
  await openOrder(page, stay);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = page.getByRole("dialog", { name: "调整退房日期", exact: true });
  const context = form.getByTestId("stay-date-order-context");
  await expect(context).toContainText("当前住宿日期 · 在住");
  await expect(context).toContainText(stay.nickname);
  await expect(context).toContainText(stay.unitCode);
  await expect(context).toContainText(`${stay.arrivalDate} 至 ${stay.departureDate}`);
  await expect(form.getByTestId("stay-date-arrival")).toBeDisabled();
  await expect(form.getByTestId("stay-date-arrival")).toHaveValue(stay.arrivalDate);
  await form.getByTestId("stay-date-departure").fill(stay.newDepartureDate);
  await form.getByTestId("stay-date-reason").fill(reason);
  await expect(form.getByTestId("stay-date-price-preview")).toContainText("调整后订单金额", { timeout: 30_000 });
  await expect(form.getByTestId("stay-date-new-amount")).toHaveText(stay.expectedContractYuan === "" ? "¥0.00" : `¥${Number(stay.expectedContractYuan).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`);
  const review = await continueToReview(page, "延长住宿");
  await expect(review).toContainText("原住宿日期");
  await expect(review).toContainText("新住宿日期");
  await expect(review).toContainText("原合同金额");
  await expect(review).toContainText("政策基础金额");
  await expect(review).toContainText("订单新金额");
  await expect(review).toContainText(reason);
  await confirmReview(page, "延长住宿");
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿已延长");
  await expect(page.getByText(`${stay.arrivalDate} 至 ${stay.newDepartureDate}`, { exact: true }).first()).toBeVisible();

  const orderResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(stay.orderId)}`);
  expect(orderResponse.ok()).toBe(true);
  const orderView = await orderResponse.json() as {
    order: { arrival_date: string; departure_date: string; status: string };
    pricingRevisions: Array<{ current_contract_amount_minor: number }>;
  };
  expect(orderView.order).toMatchObject({
    arrival_date: stay.arrivalDate,
    departure_date: stay.newDepartureDate,
    status: "CHECKED_IN"
  });
  expect(orderView.pricingRevisions).toHaveLength(2);
  expect(orderView.pricingRevisions[0]?.current_contract_amount_minor).toBe(Number(stay.originalContractYuan) * 100);
  expect(orderView.pricingRevisions[1]?.current_contract_amount_minor).toBe(Number(stay.expectedContractYuan) * 100);

  const boardResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/properties/${propertyId}/room-status`
    && response.status() === 200);
  await page.goto("/");
  await boardResponse;
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })).toBeVisible();
  const currentDayCell = roomCell(page, stay, fixture.businessDate);
  await expect(currentDayCell).toContainText(stay.nickname);
  await expect(currentDayCell).toHaveClass(/has-direct-lodging/);
  await expect(currentDayCell).toHaveClass(/room-status-day-in-house/);
  await expect(roomCell(page, stay, stay.newDepartureDate)).not.toHaveClass(/has-direct-lodging/);
}

test.beforeAll(async ({}, workerInfo) => {
  if (workerInfo.project.name === "mobile") {
    mobileFixture = await prepareStage9MobileAcceptance(e2eDatabaseUrl, {
      reset: true,
      suffix: `${workerInfo.project.name}-${workerInfo.workerIndex}`,
      unitCodeOverride: "201"
    });
    return;
  }
  fixture = await prepareStage9Acceptance(e2eDatabaseUrl, {
    reset: false,
    dayOffset: 2,
    suffix: `${workerInfo.project.name}-${workerInfo.workerIndex}`,
    unitCodeOverrides: desktopUnitCodeOverrides
  });
});

test("4.2 desktop WECOM reschedule shows the recalculated amount before review", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 first-step price visibility");
  await login(page);
  await openOrder(page, fixture.earlyArrival);
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  const form = await fillRescheduleForm(page, fixture.earlyArrival as Stage9AcceptanceFixture["external"], "客人提前一天到店");
  const price = form.getByTestId("stay-date-price-preview");
  await expect(price).toBeVisible({ timeout: 30_000 });
  const original = await form.getByTestId("stay-date-original-amount").textContent();
  const recalculated = await form.getByTestId("stay-date-new-amount").textContent();
  expect(original).toMatch(/¥/);
  expect(recalculated).toMatch(/¥/);
  expect(recalculated).not.toBe(original);
  await expect(form.getByRole("button", { name: "继续核对", exact: true })).toBeEnabled();
  const toggle = form.getByTestId("stay-date-wecom-adjust-toggle");
  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(20);
  expect(box!.height).toBeLessThanOrEqual(20);
  await expect(toggle).not.toBeChecked();
  await expect(form.getByTestId("stay-date-wecom-amount")).toHaveCount(0);
});

test("4.2 desktop external-channel reschedule returns to the draft, records the channel reason, and refreshes", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 external reschedule");
  await login(page);
  await openOrder(page, fixture.external);
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  let form = await fillRescheduleForm(page, fixture.external, "客人调整出行日期");
  await form.getByTestId("stay-date-channel-amount").fill(fixture.external.targetContractYuan);
  await form.getByTestId("stay-date-channel-reason").fill(fixture.external.channelPriceDifferenceReason);
  const previewRequest = page.waitForRequest((request) => request.method() === "POST"
    && new URL(request.url()).pathname === "/api/v1/command-previews"
    && (request.postDataJSON() as { commandType?: string }).commandType === "RESCHEDULE_STAY");
  let review = await continueToReview(page, "调整住宿日期");
  expect((await previewRequest).postDataJSON()).toMatchObject({
    commandType: "RESCHEDULE_STAY",
    input: {
      targetCurrentContractAmountMinor: Number(fixture.external.targetContractYuan) * 100,
      channelPriceDifferenceReason: fixture.external.channelPriceDifferenceReason
    }
  });
  await expect(review).toContainText("原住宿日期");
  await expect(review).toContainText("新住宿日期");
  await expect(review).not.toContainText("原合同金额");
  await expect(review).toContainText("政策基础金额");
  await expect(review).toContainText("本单渠道应结金额");
  await expect(review).toContainText("与政策基础金额差额");
  await expect(review).toContainText("渠道价格差异说明");
  await expect(review).not.toContainText("已登记净收款");
  await expect(review).not.toContainText("待补收参考");
  await expect(review).not.toContainText("建议退款");
  await expect(review).toContainText(fixture.external.channelPriceDifferenceReason);
  await review.getByTestId("command-return-to-edit").click();
  form = page.getByRole("dialog", { name: "调整住宿日期", exact: true });
  await expect(form.getByTestId("stay-date-arrival")).toHaveValue(fixture.external.newArrivalDate);
  await expect(form.getByTestId("stay-date-departure")).toHaveValue(fixture.external.newDepartureDate);
  await expect(form.getByTestId("stay-date-channel-amount")).toHaveValue(fixture.external.targetContractYuan);
  await expect(form.getByTestId("stay-date-channel-reason")).toHaveValue(fixture.external.channelPriceDifferenceReason);
  review = await continueToReview(page, "调整住宿日期");
  await confirmReview(page, "调整住宿日期");
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿日期已调整");
  await expect(page.getByText(`${fixture.external.newArrivalDate} 至 ${fixture.external.newDepartureDate}`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("调整住宿日期", { exact: true }).last()).toBeVisible();
  const orderResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(fixture.external.orderId)}`);
  expect(orderResponse.ok()).toBe(true);
  const orderView = await orderResponse.json() as { pricingRevisions: Array<{ reason: { code: string; note: string } }> };
  expect(orderView.pricingRevisions.at(-1)?.reason).toEqual({
    code: "RESCHEDULE_STAY_CHANNEL_CONTRACT",
    note: fixture.external.channelPriceDifferenceReason
  });
});

test("4.2 desktop room-status entry restores selection, released dates are available, and the new interval highlights one Stay", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 room-status entry and selection");
  await login(page, { roomStatusRange: true });
  const oldFirst = roomCell(page, fixture.shift, fixture.shift.arrivalDate);
  await expect(oldFirst).toBeVisible();
  await openRoomStatusOrder(page, fixture.shift);
  const refreshAction = async (): Promise<Locator> => {
    const refreshed = roomStatusResponse(page, fixture.rangeArrivalDate, roomStatusTimelineDepartureDate(fixture.rangeArrivalDate));
    await page.getByRole("button", { name: "刷新房态", exact: true })
      .evaluate((element: HTMLButtonElement) => element.click());
    await refreshed;
    await expect(oldFirst).toHaveClass(/is-stay-selected/);
    const availableCell = roomCell(page, fixture.external, fixture.external.newDepartureDate);
    await availableCell.focus();
    await page.keyboard.press("Enter");
    const availablePopover = page.getByTestId("room-status-quick-popover");
    await expect(availablePopover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(availablePopover).toBeHidden();
    const context = await openRoomStatusOrder(page, fixture.shift);
    const action = context.getByRole("button", { name: "调整住宿日期", exact: true });
    await expect(action).toBeVisible();
    await expect(action).toBeEnabled({ timeout: 15_000 });
    return action;
  };
  let action = await refreshAction();
  await action.click();
  const form = await fillRescheduleForm(page, fixture.shift as Stage9AcceptanceFixture["external"], "房态入口改期");
  await form.press("Escape");
  await expect(form).toBeHidden();
  await expect(oldFirst).toBeFocused();
  action = await refreshAction();
  await action.click();
  await fillRescheduleForm(page, fixture.shift as Stage9AcceptanceFixture["external"], "房态入口改期");
  await continueToReview(page, "调整住宿日期");
  await confirmReview(page, "调整住宿日期");
  await expect(roomCell(page, fixture.shift, fixture.shift.arrivalDate)).not.toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.shift, fixture.shift.arrivalDate)).toHaveClass(/room-status-day-available/);
  await expect(roomCell(page, fixture.shift, fixture.shift.newArrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.shift, fixture.shift.newDepartureDate)).not.toHaveClass(/is-stay-selected/);
});

test("4.2 desktop checked-in member extension keeps old and added dates under the same Stay", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 checked-in member extension");
  await login(page, { roomStatusRange: true });
  await openOrder(page, fixture.memberInHouse);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = page.getByRole("dialog", { name: "调整退房日期", exact: true });
  await expect(form.getByTestId("stay-date-arrival")).toBeDisabled();
  await form.getByTestId("stay-date-departure").fill(fixture.memberInHouse.newDepartureDate);
  await form.getByTestId("stay-date-reason").fill("住客确认续住一晚");
  await expect(form.getByTestId("stay-date-channel-amount")).toHaveCount(0);
  const review = await continueToReview(page, "延长住宿");
  await expect(review).toContainText("会员权益覆盖");
  await expect(review).toContainText("未覆盖晚数");
  await expect(review).toContainText("未覆盖金额");
  await confirmReview(page, "延长住宿");
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿已延长");

  const boardResponse = roomStatusResponse(page, fixture.rangeArrivalDate, roomStatusTimelineDepartureDate(fixture.rangeArrivalDate));
  await page.goto("/");
  await boardResponse;
  const originalDay = roomCell(page, fixture.memberInHouse, fixture.memberInHouse.arrivalDate);
  await originalDay.focus();
  await page.keyboard.press("Enter");
  await expect(roomCell(page, fixture.memberInHouse, fixture.memberInHouse.arrivalDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.memberInHouse, fixture.memberInHouse.departureDate)).toHaveClass(/is-stay-selected/);
  await expect(roomCell(page, fixture.memberInHouse, fixture.memberInHouse.newDepartureDate)).not.toHaveClass(/is-stay-selected/);
  const orderResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(fixture.memberInHouse.orderId)}`);
  expect(orderResponse.ok()).toBe(true);
  const orderView = await orderResponse.json() as {
    coverageSet: Array<{ service_date: string; status: string }>;
  };
  expect(orderView.coverageSet).toEqual(expect.arrayContaining([
    expect.objectContaining({ service_date: fixture.memberInHouse.arrivalDate, status: "CONSUMED" }),
    expect.objectContaining({ service_date: fixture.memberInHouse.departureDate, status: "CONSUMED" })
  ]));
});

test("4.2 desktop departure pricing stays stable across room-status polling", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 room-status preview stability");
  await login(page, { roomStatusRange: true });
  const context = await openRoomStatusOrder(page, fixture.departureDay);
  await context.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = page.getByRole("dialog", { name: "调整退房日期", exact: true });
  let datePreviewRequests = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/v1/command-previews") return;
    const body = request.postDataJSON() as { commandType?: string };
    if (body.commandType === "EXTEND_STAY" || body.commandType === "SHORTEN_STAY") datePreviewRequests += 1;
  });

  await form.getByTestId("stay-date-departure").fill(fixture.departureDay.newDepartureDate);
  await form.getByTestId("stay-date-reason").fill("核对房态轮询不重复报价");
  await expect(form.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  const previewRequestsBeforePolling = datePreviewRequests;
  expect(previewRequestsBeforePolling).toBeGreaterThanOrEqual(1);

  await roomStatusResponse(page, fixture.departureDay.arrivalDate, roomStatusTimelineDepartureDate(fixture.departureDay.arrivalDate));
  await roomStatusResponse(page, fixture.departureDay.arrivalDate, roomStatusTimelineDepartureDate(fixture.departureDay.arrivalDate));
  await expect(form.getByTestId("stay-date-price-preview")).toBeVisible();
  await expect(form.getByTestId("stay-date-price-loading")).toHaveCount(0);
  expect(datePreviewRequests).toBe(previewRequestsBeforePolling);
  await form.getByRole("button", { name: "取消", exact: true }).click();
});

test("4.2 desktop planned-departure-day and overdue in-house stays extend with full repricing and room-status refresh", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 business-date extension boundaries");
  await login(page, { roomStatusRange: true });
  await extendHistoricalStay(page, fixture.departureDay, "计划退房日确认续住一晚");
  await extendHistoricalStay(page, fixture.overdue, "逾期住客确认续住至次日");
});

test("4.2 desktop result-unknown recovery only queries the original idempotency key", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 result recovery");
  await login(page);
  await openOrder(page, fixture.lateArrival);
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  await fillRescheduleForm(page, fixture.lateArrival as Stage9AcceptanceFixture["external"], "验证原结果恢复");
  const equalPrice = page.getByTestId("stay-date-price-preview");
  await expect(equalPrice).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("stay-date-new-amount")).toHaveText(await page.getByTestId("stay-date-original-amount").innerText());
  await continueToReview(page, "调整住宿日期");
  let confirmationKey = "";
  let confirmRequests = 0;
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    confirmRequests += 1;
    confirmationKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  const review = page.getByRole("dialog", { name: "调整住宿日期", exact: true });
  await review.getByRole("button", { name: "确认调整住宿日期", exact: true }).click();
  await expect(review.getByText("调整住宿日期结果需要查询", { exact: true })).toBeVisible();
  await review.getByTestId("command-close").click();
  let recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText("调整住宿日期结果需要恢复查询");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: fixture.lateArrival.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText("调整住宿日期结果需要恢复查询");
  expect(confirmRequests).toBe(1);
  await recovery.getByRole("button", { name: "查询调整住宿日期结果", exact: true }).click();
  const recoveryDialog = page.getByRole("dialog", { name: "恢复调整住宿日期结果", exact: true });
  await expect(recoveryDialog).toBeVisible();
  const recoveryRequest = page.waitForRequest((request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/v1/command-results/resolve") return false;
    const body = request.postDataJSON() as Partial<{
      propertyId: string;
      commandType: string;
      idempotencyKey: string;
    }>;
    return body.propertyId === propertyId
      && body.commandType === "RESCHEDULE_STAY"
      && body.idempotencyKey === confirmationKey;
  });
  await recoveryDialog.getByRole("button", { name: "查询原操作结果", exact: true }).click();
  await recoveryRequest;
  expect(confirmationKey).toMatch(/^web-confirm-reschedule_stay-/);
  expect(confirmRequests).toBe(1);
  await expect(recoveryDialog).toBeHidden({ timeout: 30_000 });
  await expect(recovery).toBeHidden();
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿日期已调整", { timeout: 30_000 });
  await expect(page.getByText(`${fixture.lateArrival.newArrivalDate} 至 ${fixture.lateArrival.newDepartureDate}`, { exact: true }).first()).toBeVisible();
});

test("4.2 desktop WECOM policy reset, inventory conflict, and Stage 11 multi-unit reschedule behave safely", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 9 failure-close cases");
  await login(page);
  await openOrder(page, fixture.wecomDeviation);
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  let form = await fillRescheduleForm(page, fixture.wecomDeviation as Stage9AcceptanceFixture["external"], "企微改期按新政策价");
  await expect(form.getByTestId("stay-date-price-preview")).toContainText("调整后订单金额", { timeout: 30_000 });
  await expect(form.getByTestId("stay-date-original-amount")).not.toHaveText(await form.getByTestId("stay-date-new-amount").innerText());
  await expect(form.getByTestId("stay-date-wecom-amount")).toHaveCount(0);
  let review = await continueToReview(page, "调整住宿日期");
  await expect(review).toContainText("政策基础金额");
  await confirmReview(page, "调整住宿日期");
  const wecomResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(fixture.wecomDeviation.orderId)}`);
  expect(wecomResponse.ok()).toBe(true);
  const wecomView = await wecomResponse.json() as {
    pricingRevisions: Array<{ pricing_basis: string; policy_base_amount_minor: number; current_contract_amount_minor: number; manual_adjustment_minor: number }>;
  };
  expect(wecomView.pricingRevisions.at(-1)).toMatchObject({
    pricing_basis: "POLICY",
    manual_adjustment_minor: 0
  });
  expect(wecomView.pricingRevisions.at(-1)?.current_contract_amount_minor)
    .toBe(wecomView.pricingRevisions.at(-1)?.policy_base_amount_minor);

  await openOrder(page, fixture.conflict);
  const conflictBeforeResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(fixture.conflict.orderId)}`);
  expect(conflictBeforeResponse.ok()).toBe(true);
  const conflictBefore = await conflictBeforeResponse.json() as { order: { arrival_date: string; departure_date: string; version: number }; pricingRevisions: unknown[] };
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  form = await fillRescheduleForm(page, fixture.conflict as Stage9AcceptanceFixture["external"], "验证库存冲突");
  await expect(form.getByText("调整后的住宿日期存在库存冲突", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole("button", { name: "继续核对", exact: true })).toBeDisabled();
  const conflictAfterResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(fixture.conflict.orderId)}`);
  expect(conflictAfterResponse.ok()).toBe(true);
  const conflictAfter = await conflictAfterResponse.json() as typeof conflictBefore;
  expect(conflictAfter.order).toMatchObject(conflictBefore.order);
  expect(conflictAfter.pricingRevisions).toHaveLength(conflictBefore.pricingRevisions.length);

  await openOrder(page, fixture.multiUnit);
  await expect(page.getByRole("button", { name: "调整住宿日期", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  const multiForm = page.getByRole("dialog", { name: "调整住宿日期", exact: true });
  await multiForm.getByTestId("stay-date-arrival").fill(addDays(fixture.multiUnit.arrivalDate, 1));
  await multiForm.getByTestId("stay-date-departure").fill(addDays(fixture.multiUnit.departureDate, 1));
  await multiForm.getByTestId("stay-date-reason").fill("多房源住宿整体顺延一天");
  await expect(multiForm.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  const multiTimeline = multiForm.getByTestId("stay-date-preview-timeline");
  await expect(multiTimeline).toBeVisible();
  await expect(multiTimeline).toContainText(fixture.multiUnit.unitCode);
  await expect(multiTimeline).toContainText(fixture.multiUnit.destinationUnitCode);
  await expect(multiForm.getByRole("button", { name: "继续核对", exact: true })).toBeEnabled();
});

test("4.2 mobile free-stay reschedule stays zero and requires no pricing input", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 9 free-stay rule smoke");
  await login(page);
  await openOrder(page, mobileFixture.free);
  await page.getByRole("button", { name: "调整住宿日期", exact: true }).click();
  const form = await fillRescheduleForm(page, mobileFixture.free as Stage9AcceptanceFixture["external"], "免费接待行程顺延");
  await expect(form.getByText("免费住宿保持 0 元", { exact: false })).toBeVisible();
  await expect(form.getByTestId("stay-date-channel-amount")).toHaveCount(0);
  await continueToReview(page, "调整住宿日期");
  const review = page.getByRole("dialog", { name: "调整住宿日期", exact: true });
  await expect(review).toContainText("¥0.00");
  await confirmReview(page, "调整住宿日期");
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿日期已调整");
});
