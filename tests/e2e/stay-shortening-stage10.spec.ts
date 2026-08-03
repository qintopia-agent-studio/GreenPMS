import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  prepareStage10Acceptance,
  prepareStage10MobileAcceptance,
  type Stage10AcceptanceFixture,
  type Stage10MobileAcceptanceFixture,
  type Stage10StayFixture
} from "./setup-stage10-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const forbiddenProtocol = /Preview|Confirm|Receipt|Command|SHORTEN_STAY|EARLY_CHECK_OUT|(?:order|stay|segment|amendment|revision|claim|coverage|fact)_[a-z0-9_-]+/i;
let fixture: Stage10AcceptanceFixture;
let mobileFixture: Stage10MobileAcceptanceFixture;

test.describe.configure({ mode: "serial" });

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile";
}

function roomCell(page: Page, stay: Stage10StayFixture, date: string): Locator {
  return page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.unitId}"][data-service-date="${date}"]`);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function login(page: Page): Promise<void> {
  const activeFixture = mobileFixture ?? fixture;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(activeFixture.operator.username);
  await page.getByTestId("login-password").fill(activeFixture.operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true, level: 1 })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible({ timeout: 30_000 });
}

async function openOrder(page: Page, stay: Stage10StayFixture): Promise<void> {
  await page.goto(`/orders/${encodeURIComponent(stay.orderId)}`);
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
}

async function fillShortenDraft(
  page: Page,
  stay: Stage10StayFixture,
  reason: string
): Promise<Locator> {
  const form = page.getByRole("dialog", { name: "调整退房日期", exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByTestId("stay-date-arrival")).toBeDisabled();
  await expect(form.getByTestId("stay-date-arrival")).toHaveValue(stay.arrivalDate);
  await form.getByTestId("stay-date-departure").fill(stay.newDepartureDate);
  await form.getByTestId("stay-date-reason").fill(reason);
  return form;
}

async function fillShortenForm(
  page: Page,
  stay: Stage10StayFixture,
  reason: string
): Promise<Locator> {
  const form = await fillShortenDraft(page, stay, reason);
  await expect(form.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  await expect(form.getByTestId("stay-date-price-preview")).toContainText("原住宿日期");
  await expect(form.getByTestId("stay-date-price-preview")).toContainText("新住宿日期");
  await expect(form.getByTestId("stay-date-price-preview")).toContainText("完整新晚数");
  await expect(form.getByRole("button", { name: "继续核对", exact: true })).toBeEnabled();
  return form;
}

async function waitForPrice(form: Locator): Promise<void> {
  await expect(form.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole("button", { name: "继续核对", exact: true })).toBeEnabled();
}

async function assertRoomStatusAfterShortening(
  page: Page,
  stay: Stage10StayFixture,
  businessDate: string,
  options: { checkedOut?: boolean } = {}
): Promise<void> {
  const boardResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/v1/properties/${propertyId}/room-status` && response.status() === 200;
  }, { timeout: 30_000 });
  await page.goto("/");
  await boardResponse;
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true, level: 1 })).toBeVisible();
  const currentCell = roomCell(page, stay, businessDate);
  if (options.checkedOut) {
    await expect(currentCell).toHaveClass(/room-status-day-available/);
    await expect(currentCell).not.toHaveClass(/has-direct-lodging|is-stay-selected/);
  } else {
    await expect(currentCell).toContainText(stay.nickname);
    await expect(currentCell).toHaveClass(/room-status-day-in-house/);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await currentCell.focus();
    await expect(currentCell).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("room-status-quick-popover")).toBeVisible();
    await expect(currentCell).toHaveAttribute("aria-expanded", "true");
    for (let serviceDate = businessDate; serviceDate < stay.newDepartureDate; serviceDate = addDays(serviceDate, 1)) {
      await expect(roomCell(page, stay, serviceDate)).toHaveClass(/is-stay-selected/);
    }
  }
  await expect(roomCell(page, stay, stay.newDepartureDate)).toHaveClass(/room-status-day-available/);
  await expect(roomCell(page, stay, stay.newDepartureDate)).not.toHaveClass(/has-direct-lodging|is-stay-selected/);
  await expect(roomCell(page, stay, addDays(stay.departureDate, -1))).toHaveClass(/room-status-day-available/);
  await expect(page.locator("body")).not.toContainText(forbiddenProtocol);
}

async function assertScrollPositionStable(page: Page): Promise<void> {
  const initial = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return window.scrollY;
  });
  expect(initial).toBeGreaterThan(0);
  const final = await page.evaluate(async () => new Promise<number>((resolve) => {
    window.setTimeout(() => resolve(window.scrollY), 8_000);
  }));
  expect(final).toBe(initial);
}

async function getOrderView(page: Page, stay: Stage10StayFixture) {
  const response = await page.request.get(`/api/v1/orders/${encodeURIComponent(stay.orderId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{
    order: { status: string; departure_date: string };
    stay: { status: string };
    arrangementHistory: Array<{ type: string }>;
    amendments: Array<{ amendment_type: string }>;
    pricingRevisions: Array<{
      current_contract_amount_minor: number;
      pricing_basis: string;
      reason: { code: string; note: string };
    }>;
    coverageSet: Array<Record<string, unknown>>;
    collectionFacts: Array<{ fact_type: string; amount_minor: number; net_effect_minor: number }>;
    amounts: {
      currentContractAmount: { minorUnits: number };
      netRecordedCollection: { minorUnits: number };
      collectionDifference: { minorUnits: number };
      refundReferenceAmount: { minorUnits: number };
    };
  }>;
}

async function expectNoInternalProtocol(page: Page, scope: Locator = page.locator("body")): Promise<void> {
  await expect(scope).not.toContainText(forbiddenProtocol);
}

async function continueToReview(page: Page, title: "缩短住宿" | "提前退房"): Promise<Locator> {
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  const review = page.getByRole("dialog", { name: title, exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review).not.toContainText(forbiddenProtocol);
  return review;
}

async function confirmReview(page: Page, title: "缩短住宿" | "提前退房"): Promise<void> {
  const review = page.getByRole("dialog", { name: title, exact: true });
  await review.getByTestId("confirm-command").click();
  await expect(review).toBeHidden({ timeout: 30_000 });
}

test.beforeAll(async ({}, workerInfo) => {
  if (workerInfo.project.name === "mobile") {
    mobileFixture = await prepareStage10MobileAcceptance(e2eDatabaseUrl, {
      suffix: `stage10-${workerInfo.project.name}-${workerInfo.workerIndex}`,
      unitCode: "109"
    });
    return;
  }
  fixture = await prepareStage10Acceptance(e2eDatabaseUrl, {
    reset: false,
    suffix: `stage10-${workerInfo.project.name}-${workerInfo.workerIndex}`
  });
});

test("4.3 desktop shortening reprices the full stay and remains in house", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 shortening");
  const stay = fixture.inHouseShortening;
  await login(page);
  await openOrder(page, stay);
  await expect(page.getByRole("button", { name: "调整退房日期", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = await fillShortenForm(page, stay, "住客确认提前一天结束后续住宿");
  await expect(form.getByRole("textbox", { name: "提前离店原因", exact: true })).toHaveCount(0);
  const originalAmount = await form.getByTestId("stay-date-original-amount").textContent();
  const newAmount = await form.getByTestId("stay-date-new-amount").textContent();
  expect(originalAmount).toMatch(/¥/);
  expect(newAmount).toMatch(/¥/);
  expect(newAmount).not.toBe(originalAmount);
  const review = await continueToReview(page, "缩短住宿");
  await expect(review).toContainText("请核对缩短住宿或提前退房");
  await expect(review).toContainText("住客确认提前一天结束后续住宿");
  await expect(review).toContainText("订单新金额");
  await confirmReview(page, "缩短住宿");
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿已缩短");

  const view = await getOrderView(page, stay);
  expect(view.order).toMatchObject({ status: "CHECKED_IN", departure_date: stay.newDepartureDate });
  expect(view.stay.status).toBe("IN_HOUSE");
  expect(view.arrangementHistory.at(-1)?.type).toBe("SHORTENING");
  expect(view.pricingRevisions).toHaveLength(2);
  await assertScrollPositionStable(page);
  await assertRoomStatusAfterShortening(page, stay, fixture.businessDate);
});

test("4.3 desktop early checkout shows only a refund reference and completes atomically", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 early checkout");
  const stay = fixture.earlyCheckout;
  await login(page);
  await openOrder(page, stay);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = await fillShortenForm(page, stay, "住客行程变化，确认今天提前离店");
  await expect(form.getByRole("textbox", { name: "提前离店原因", exact: true })).toBeVisible();
  await expect(form.getByTestId("stay-date-refund-reference")).toBeVisible();
  await expect(form.getByTestId("stay-date-refund-note")).toContainText("目前尚未登记退款");
  const review = await continueToReview(page, "提前退房");
  await expect(review).toContainText("请核对提前退房");
  await expect(review).toContainText("建议退款");
  await expect(review).toContainText("目前尚未登记退款");
  await expect(review).toContainText("住客行程变化，确认今天提前离店");
  await confirmReview(page, "提前退房");
  await expect(page.getByTestId("command-result-notice")).toContainText("提前退房已完成");

  const view = await getOrderView(page, stay);
  expect(view.order).toMatchObject({ status: "CHECKED_OUT", departure_date: stay.newDepartureDate });
  expect(view.stay.status).toBe("COMPLETED");
  expect(view.amounts.refundReferenceAmount.minorUnits).toBe(
    stay.recordedCollectionMinor - view.amounts.currentContractAmount.minorUnits
  );
  expect(view.amounts.refundReferenceAmount.minorUnits).toBeGreaterThan(0);
  expect(view.collectionFacts.map((fact) => fact.fact_type)).toEqual(["COLLECTION"]);
  expect(view.arrangementHistory.at(-1)?.type).toBe("EARLY_CHECK_OUT");
  expect(view.amendments.slice(-2).map((amendment) => amendment.amendment_type)).toEqual(["SHORTEN_STAY", "CHECK_OUT"]);
  await assertRoomStatusAfterShortening(page, stay, fixture.businessDate, { checkedOut: true });
});

test("4.3 arrival-day stays fail closed with a Chinese operator message", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 arrival-day gate");
  const stay = fixture.arrivalDayBlocked;
  await login(page);
  await openOrder(page, stay);
  await expect(page.getByRole("button", { name: "缩短住宿", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "提前退房", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "调整退房日期", exact: true })).toBeVisible();
  const blockedReasonHint = page.getByRole("note", { name: /入住当天暂不办理缩短或提前退房/ }).first();
  await expect(blockedReasonHint).toBeVisible();
  await blockedReasonHint.focus();
  const blockedReason = page.getByRole("tooltip").filter({ hasText: /入住当天暂不办理缩短或提前退房/ }).first();
  await expect(blockedReason).toBeVisible();
  await expect(blockedReason).toContainText(/当前版本尚未开放撤销入住/);
  await expectNoInternalProtocol(page);
});

test("4.3 retrospective shortening is visibly rejected without a confirmation path", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 retrospective gate");
  const stay = fixture.retrospectiveBlocked;
  await login(page);
  const before = await getOrderView(page, stay);
  await openOrder(page, stay);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = await fillShortenDraft(page, stay, "尝试追溯修改已经履行的住宿日期");
  const error = form.getByRole("alert").filter({ hasText: "新的退房日期不能早于当前营业日期" });
  await expect(error).toBeVisible();
  await expect(form.getByRole("button", { name: "继续核对", exact: true })).toBeDisabled();
  await expect(form.getByTestId("stay-date-price-preview")).toHaveCount(0);
  await expectNoInternalProtocol(page, form);
  await form.getByRole("button", { name: "取消", exact: true }).click();
  const after = await getOrderView(page, stay);
  expect(after.order).toEqual(before.order);
  expect(after.stay).toEqual(before.stay);
  expect(after.amendments).toEqual(before.amendments);
  expect(after.pricingRevisions).toEqual(before.pricingRevisions);
  expect(after.coverageSet).toEqual(before.coverageSet);
  expect(after.collectionFacts).toEqual(before.collectionFacts);
});

test("4.3 collection states show a refund reference only when net collection exceeds the new amount", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 collection matrix");
  await login(page);
  const cases = [
    { stay: fixture.balancedCollection, label: "当前记录无差额", expectedDifferenceMinor: 0 },
    { stay: fixture.supplementCollection, label: "待补收参考", expectedDifferenceMinor: 100 }
  ] as const;
  for (const item of cases) {
    await openOrder(page, item.stay);
    await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
    const form = await fillShortenForm(page, item.stay, `${item.stay.nickname}资金状态核对`);
    await expect(form.getByTestId("stay-date-price-preview")).toContainText(item.label);
    await expect(form.getByTestId("stay-date-refund-reference")).toHaveCount(0);
    await expect(form.getByTestId("stay-date-refund-note")).toHaveCount(0);
    const review = await continueToReview(page, "缩短住宿");
    await expect(review.getByTestId("command-effect")).not.toContainText("建议退款");
    await confirmReview(page, "缩短住宿");
    const view = await getOrderView(page, item.stay);
    expect(view.amounts.netRecordedCollection.minorUnits).toBe(item.stay.recordedCollectionMinor);
    expect(view.amounts.collectionDifference.minorUnits).toBe(item.expectedDifferenceMinor);
    expect(view.amounts.refundReferenceAmount.minorUnits).toBe(0);
    expect(view.collectionFacts.map((fact) => fact.fact_type)).toEqual(["COLLECTION"]);
    await expectNoInternalProtocol(page);
  }
});

test("4.3 CTRIP shortening requires a new channel amount and enforces the 15 percent explanation gate", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 external-channel pricing");
  const stay = fixture.externalChannel;
  await login(page);
  await openOrder(page, stay);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = await fillShortenDraft(page, stay, "携程住客确认缩短住宿");
  await expect(form.getByTestId("stay-date-channel-amount")).toHaveValue("");
  await expect(form.getByTestId("stay-date-wecom-adjust-toggle")).toHaveCount(0);
  const rejectedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/command-previews"
    && (response.request().postDataJSON() as { commandType?: string }).commandType === "SHORTEN_STAY"
    && response.status() >= 400);
  await form.getByTestId("stay-date-channel-amount").fill(stay.targetContractYuan);
  const rejected = await rejectedResponse;
  expect(rejected.status()).toBe(400);
  const rejectedBody = await rejected.json() as { code: string; message: string };
  expect(rejectedBody).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(rejectedBody.message).toContain("15%");
  const blocked = form.getByRole("alert").filter({ hasText: "暂时无法核对新金额" });
  await expect(blocked).toBeVisible();
  await expect(form.locator("#channel-difference-hint")).toContainText(/超过 15% 时必须填写/);
  await expect(form.getByRole("button", { name: "继续核对", exact: true })).toBeDisabled();

  const previewRequest = page.waitForRequest((request) => request.method() === "POST"
    && new URL(request.url()).pathname === "/api/v1/command-previews"
    && (request.postDataJSON() as { commandType?: string }).commandType === "SHORTEN_STAY");
  await form.getByTestId("stay-date-channel-reason").fill(stay.channelPriceDifferenceReason);
  await waitForPrice(form);
  expect((await previewRequest).postDataJSON()).toMatchObject({
    commandType: "SHORTEN_STAY",
    input: {
      orderId: stay.orderId,
      newDepartureDate: stay.newDepartureDate,
      targetCurrentContractAmountMinor: Number(stay.targetContractYuan) * 100,
      channelPriceDifferenceReason: stay.channelPriceDifferenceReason
    }
  });
  const review = await continueToReview(page, "缩短住宿");
  await expect(review).toContainText("本单渠道应结金额");
  await expect(review).not.toContainText("已登记净收款");
  await expect(review).not.toContainText("待补收参考");
  await expect(review).not.toContainText("建议退款");
  await expect(review).toContainText("渠道价格差异说明");
  await expect(review).toContainText(stay.channelPriceDifferenceReason);
  await confirmReview(page, "缩短住宿");
  await page.reload();
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  for (const section of [page.getByTestId("order-amounts"), page.getByTestId("arrangement-history")]) {
    await expect(section).toContainText("政策基础金额");
    await expect(section).toContainText("本单渠道应结金额");
    await expect(section).toContainText("与政策基础金额差额");
    await expect(section).toContainText("渠道价格差异说明");
    await expect(section).not.toContainText("已登记净收款");
    await expect(section).not.toContainText("待补收参考");
    await expect(section).not.toContainText("多收差额");
    await expect(section).not.toContainText("建议退款");
  }
  const view = await getOrderView(page, stay);
  expect(view.pricingRevisions.at(-1)).toMatchObject({
    pricing_basis: "CHANNEL_CONTRACT",
    current_contract_amount_minor: Number(stay.targetContractYuan) * 100,
    reason: { code: "SHORTEN_STAY_CHANNEL_CONTRACT", note: stay.channelPriceDifferenceReason }
  });
  expect(view.collectionFacts).toHaveLength(0);
  await expectNoInternalProtocol(page);
});

test("4.3 WECOM shortening supports an explicit manual price without channel fields", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 WECOM manual pricing");
  const stay = fixture.wecomManualPrice;
  await login(page);
  await openOrder(page, stay);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = await fillShortenDraft(page, stay, "企微住客缩短并重新协商金额");
  await expect(form.getByTestId("stay-date-channel-amount")).toHaveCount(0);
  await expect(form.getByTestId("stay-date-wecom-adjust-toggle")).not.toBeChecked();
  await form.getByTestId("stay-date-wecom-adjust-toggle").check();
  await expect(form.getByTestId("stay-date-wecom-amount")).toBeVisible();
  await form.getByTestId("stay-date-wecom-amount").fill(stay.targetContractYuan);
  const previewRequest = page.waitForRequest((request) => request.method() === "POST"
    && new URL(request.url()).pathname === "/api/v1/command-previews"
    && (request.postDataJSON() as { commandType?: string }).commandType === "SHORTEN_STAY");
  await form.getByTestId("stay-date-wecom-reason").fill(stay.manualPriceAdjustmentReason);
  await waitForPrice(form);
  expect((await previewRequest).postDataJSON()).toMatchObject({
    commandType: "SHORTEN_STAY",
    input: {
      orderId: stay.orderId,
      newDepartureDate: stay.newDepartureDate,
      targetCurrentContractAmountMinor: Number(stay.targetContractYuan) * 100,
      manualPriceAdjustmentReason: stay.manualPriceAdjustmentReason
    }
  });
  const review = await continueToReview(page, "缩短住宿");
  await expect(review).toContainText("人工调价原因");
  await expect(review).toContainText(stay.manualPriceAdjustmentReason);
  await expect(review).not.toContainText("渠道订单号");
  await confirmReview(page, "缩短住宿");
  const view = await getOrderView(page, stay);
  expect(view.pricingRevisions.at(-1)).toMatchObject({
    pricing_basis: "MANUAL_ADJUSTMENT",
    current_contract_amount_minor: Number(stay.targetContractYuan) * 100,
    reason: { code: "SHORTEN_STAY_MANUAL_PRICE", note: stay.manualPriceAdjustmentReason }
  });
  expect(view.collectionFacts).toHaveLength(0);
  await expectNoInternalProtocol(page);
});

test("4.3 free and member shortening preserve their distinct zero-money and entitlement rules", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 free and member rules");
  await login(page);

  const free = fixture.freeStay;
  await openOrder(page, free);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const freeForm = await fillShortenForm(page, free, "免费接待行程提前结束");
  await expect(freeForm.getByTestId("stay-date-new-amount")).toHaveText("¥0.00");
  await expect(freeForm).toContainText("免费住宿保持 0 元");
  await expect(freeForm.getByTestId("stay-date-channel-amount")).toHaveCount(0);
  await expect(freeForm.getByTestId("stay-date-wecom-adjust-toggle")).toHaveCount(0);
  await expect(freeForm).not.toContainText("会员权益覆盖");
  await continueToReview(page, "缩短住宿");
  await confirmReview(page, "缩短住宿");
  const freeView = await getOrderView(page, free);
  expect(freeView.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(freeView.pricingRevisions.at(-1)?.pricing_basis).toBe("FREE");
  expect(freeView.collectionFacts).toHaveLength(0);

  const member = fixture.memberStay;
  const memberBefore = await page.request.get(`/api/v1/members/${encodeURIComponent(member.memberId)}?propertyId=${propertyId}`);
  expect(memberBefore.ok()).toBe(true);
  const memberProfileBefore = await memberBefore.json() as {
    availableBalance: Record<string, number>;
    lotBalances: Array<Record<string, unknown>>;
    ledger: Array<Record<string, unknown>>;
    contracts: Array<Record<string, unknown>>;
    lots: Array<Record<string, unknown>>;
  };
  const orderBefore = await getOrderView(page, member);
  expect(orderBefore.coverageSet).toHaveLength(5);
  expect(orderBefore.coverageSet.every((item) => item.status === "CONSUMED")).toBe(true);
  await openOrder(page, member);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const memberForm = await fillShortenForm(page, member, "会员住客确认提前结束后续住宿");
  await expect(memberForm.getByTestId("stay-date-channel-amount")).toHaveCount(0);
  await expect(memberForm.getByTestId("stay-date-wecom-adjust-toggle")).toHaveCount(0);
  await expect(memberForm).toContainText("核对页将显示会员权益覆盖晚数");
  const memberReview = await continueToReview(page, "缩短住宿");
  await expect(memberReview).toContainText("会员权益");
  await confirmReview(page, "缩短住宿");
  const orderAfter = await getOrderView(page, member);
  expect(orderAfter.coverageSet).toEqual(orderBefore.coverageSet);
  expect(orderAfter.collectionFacts).toEqual(orderBefore.collectionFacts);
  const memberAfter = await page.request.get(`/api/v1/members/${encodeURIComponent(member.memberId)}?propertyId=${propertyId}`);
  expect(memberAfter.ok()).toBe(true);
  const memberProfileAfter = await memberAfter.json() as typeof memberProfileBefore;
  expect(memberProfileAfter.availableBalance).toEqual(memberProfileBefore.availableBalance);
  expect(memberProfileAfter.lotBalances).toEqual(memberProfileBefore.lotBalances);
  expect(memberProfileAfter.ledger).toEqual(memberProfileBefore.ledger);
  expect(memberProfileAfter.contracts).toEqual(memberProfileBefore.contracts);
  expect(memberProfileAfter.lots).toEqual(memberProfileBefore.lots);
  await expectNoInternalProtocol(page);
});

test("4.3 historical moves can shorten and Stage 11 safely clips future moves", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 10 move boundary");
  await login(page);
  const historical = fixture.historicalMove;
  await openOrder(page, historical);
  await expect(page.locator(".order-unit")).toContainText(historical.unitCode);
  await expect(page.locator(".order-unit")).toContainText(historical.destinationUnitCode);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const historicalForm = await fillShortenForm(page, historical, "已完成换房后的住客缩短后续住宿");
  await expect(historicalForm.getByTestId("stay-date-order-context")).toContainText(historical.destinationUnitCode);
  await continueToReview(page, "缩短住宿");
  await confirmReview(page, "缩短住宿");
  const historicalView = await getOrderView(page, historical);
  expect(historicalView.order).toMatchObject({ status: "CHECKED_IN", departure_date: historical.newDepartureDate });
  expect(historicalView.arrangementHistory.at(-1)?.type).toBe("SHORTENING");
  const boardResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/properties/${propertyId}/room-status`
    && response.status() === 200);
  await page.goto("/");
  await boardResponse;
  const destinationCurrent = page.locator(`[data-room-status-cell="true"][data-unit-id="${historical.destinationUnitId}"][data-service-date="${fixture.businessDate}"]`);
  await expect(destinationCurrent).toContainText(historical.nickname);
  await expect(destinationCurrent).toHaveClass(/room-status-day-in-house/);
  await expect(page.locator(`[data-room-status-cell="true"][data-unit-id="${historical.destinationUnitId}"][data-service-date="${historical.newDepartureDate}"]`)).toHaveClass(/room-status-day-available/);

  const future = fixture.futureMoveBlocked;
  await openOrder(page, future);
  await expect(page.getByRole("button", { name: "调整退房日期", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const futureForm = await fillShortenForm(page, future, "住客缩短住宿并取消尚未生效的换房安排");
  const futureTimeline = futureForm.getByTestId("stay-date-preview-timeline");
  await expect(futureTimeline).toContainText(future.unitCode);
  await expect(futureTimeline).not.toContainText(future.destinationUnitCode);
  await continueToReview(page, "缩短住宿");
  await confirmReview(page, "缩短住宿");
  const futureView = await getOrderView(page, future);
  expect(futureView.order).toMatchObject({ status: "CHECKED_IN", departure_date: future.newDepartureDate });
  expect(futureView.arrangementHistory.at(-1)?.type).toBe("SHORTENING");
  const futureDestinationCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${future.destinationUnitId}"][data-service-date="${future.newDepartureDate}"]`);
  await page.goto("/");
  await expect(futureDestinationCell).toHaveClass(/room-status-day-available/);
  await expect(futureDestinationCell).not.toContainText(future.nickname);
  await expectNoInternalProtocol(page);
});

test("4.3 mobile completes early checkout without exposing protocol details", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 10 early checkout");
  const stay = mobileFixture.earlyCheckout;
  await login(page);
  await openOrder(page, stay);
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  await fillShortenForm(page, stay, "手机端确认住客今天提前离店");
  await expect(page.getByTestId("stay-date-refund-reference")).toBeVisible();
  const review = await continueToReview(page, "提前退房");
  await expect(review).toContainText("目前尚未登记退款");
  await confirmReview(page, "提前退房");
  await expect(page.getByTestId("command-result-notice")).toContainText("提前退房已完成");
  const view = await getOrderView(page, stay);
  expect(view).toMatchObject({
    order: { status: "CHECKED_OUT", departure_date: stay.newDepartureDate },
    stay: { status: "COMPLETED" }
  });
  expect(view.amounts.refundReferenceAmount.minorUnits).toBeGreaterThan(0);
  expect(view.collectionFacts.map((fact) => fact.fact_type)).toEqual(["COLLECTION"]);
  await expectNoInternalProtocol(page);
});
