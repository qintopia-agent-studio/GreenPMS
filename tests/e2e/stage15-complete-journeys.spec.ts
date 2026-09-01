import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { prepareStage13Acceptance } from "./setup-stage13-acceptance.ts";
import {
  advanceStage15CompleteJourneyBusinessDate,
  inspectStage15CompleteJourney,
  prepareStage15CompleteJourney,
  type Stage15CompleteJourneyFixture
} from "./setup-stage15-journeys.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const preserveExistingDatabase = process.env.STAGE15_PRESERVE_EXISTING_DATABASE === "true";

const forbiddenProtocol = /Preview|Confirm|Receipt|Command|CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP|(?:order|stay|segment|amendment|revision|claim|coverage|fact|member|membership_order)_[a-z0-9_-]+/i;

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function serviceDates(arrivalDate: string, departureDate: string): string[] {
  const dates: string[] = [];
  for (let date = arrivalDate; date < departureDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function yuanInput(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

function yuanDisplay(minorUnits: number): string {
  return `¥${(minorUnits / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })).toBeVisible({ timeout: 30_000 });
}

async function waitForOrder(page: Page, nickname: string): Promise<void> {
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("无法载入订单", { exact: true })).toHaveCount(0);
}

async function assertScopedAxe(page: Page, selector: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .options({ resultTypes: ["violations"] })
    .analyze();
  expect(results.violations).toEqual([]);
}

async function createWecomInHouseBackfill(
  page: Page,
  fixture: Stage15CompleteJourneyFixture,
  nickname: string
): Promise<string> {
  await page.getByTestId("arrival-date").fill(fixture.arrivalDate);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
  const cell = page.locator(
    `.room-status-day-available[data-room-status-cell="true"][data-unit-id="${fixture.sourceUnit.id}"][data-service-date="${fixture.arrivalDate}"]`
  );
  await expect(cell).toBeVisible({ timeout: 30_000 });
  await cell.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await cell.click();

  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "补录住宿", exact: true }).click();
  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("入住日期", { exact: true }).fill(fixture.arrivalDate);
  await drawer.getByLabel("退房日期", { exact: true }).fill(fixture.initialDepartureDate);

  const quote = page.getByTestId("quote-result");
  await expect(quote).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("primary-guest-nickname").fill(nickname);
  await page.getByTestId("primary-guest-name").fill("阶段十五完整旅程住客");
  await page.getByTestId("primary-guest-phone").fill("13800001515");
  await page.getByTestId("primary-guest-document").fill("STAGE15-COMPLETE-JOURNEY-ID");
  await page.getByTestId("booking-channel-code").selectOption("WECOM");
  const policyAmountYuan = (await quote.getByText("政策基础金额", { exact: true }).locator("..").locator("strong").innerText())
    .replace(/[¥,]/g, "")
    .replace(/\.00$/, "");
  expect(Number(policyAmountYuan) * 100).toBe(fixture.expectedInitialAmountMinor);
  await page.getByTestId("target-contract-amount").fill(policyAmountYuan);
  await page.getByTestId("backfill-reason").fill("阶段 15 已在住订单补录，后续收退款按实际发生登记");
  await page.getByTestId("backfill-amount").fill("0");
  await expect(page.getByTestId("backfill-submit")).toBeEnabled();
  await page.getByTestId("backfill-submit").click();

  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 30_000 });
  await expect(effect).toContainText(nickname);
  await expect(effect).toContainText("企业微信");
  await expect(effect).not.toContainText(forbiddenProtocol);
  const confirmed = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await page.getByTestId("confirm-command").click();
  const receipt = await (await confirmed).json() as { result?: { orderId?: string } };
  expect(receipt.result?.orderId).toMatch(/^order_/);
  await expect(page.getByTestId("command-receipt")).toContainText("订单已在住");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 30_000 });
  return receipt.result!.orderId!;
}

async function recordWecomCollection(
  page: Page,
  amountYuan: string,
  transactionReference: string
): Promise<void> {
  await page.getByRole("button", { name: "收款", exact: true }).click();
  const form = page.getByRole("dialog", { name: "登记收款", exact: true });
  await expect(form).toBeVisible();
  await form.getByTestId("fact-amount-yuan").fill(amountYuan);
  await form.getByTestId("transaction-reference").fill(transactionReference);
  await form.getByTestId("collection-note").fill("阶段 15 分次收款");
  await form.getByRole("button", { name: "下一步", exact: true }).click();

  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 30_000 });
  await expect(effect).toContainText(transactionReference);
  await expect(effect).not.toContainText(forbiddenProtocol);
  await page.getByTestId("confirm-command").click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt).toContainText(transactionReference);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(receipt).toBeHidden();
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

async function recordReferencedWecomRefund(
  page: Page,
  transactionReference: string,
  amountYuan: string
): Promise<void> {
  await page.getByRole("button", { name: `为 ${transactionReference} 记录退款`, exact: true }).click();
  const form = page.getByRole("dialog", { name: "登记退款", exact: true });
  await expect(form).toBeVisible();
  await expect(form).toContainText(transactionReference);
  await expect(form).toContainText("企业微信原路退回");
  await expect(form.getByTestId("transaction-reference")).toHaveCount(0);
  await form.getByTestId("fact-amount-yuan").fill(amountYuan);
  await form.getByTestId("refund-reason").fill(`阶段 15 逐笔退回 ${transactionReference}`);
  await form.getByRole("button", { name: "下一步", exact: true }).click();

  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 30_000 });
  await expect(effect).toContainText("原路退回，沿用原收款交易单号");
  await expect(effect).toContainText("已选择同订单原收款");
  await expect(effect).not.toContainText(forbiddenProtocol);
  await page.getByTestId("confirm-command").click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(receipt).toBeHidden();
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

async function fulfill(page: Page, action: "入住" | "退房"): Promise<void> {
  const trigger = page.getByRole("button", { name: action, exact: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: `办理${action}`, exact: true });
  await expect(dialog.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).not.toContainText(forbiddenProtocol);
  await dialog.getByRole("button", { name: `确认办理${action}`, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

async function changeDeparture(
  page: Page,
  departureDate: string,
  expectedAmountMinor: number,
  reviewTitle: "延长住宿" | "缩短住宿"
): Promise<void> {
  await page.getByRole("button", { name: "调整退房日期", exact: true }).click();
  const form = page.getByRole("dialog", { name: "调整退房日期", exact: true });
  await expect(form).toBeVisible();
  await form.getByTestId("stay-date-departure").fill(departureDate);
  await form.getByTestId("stay-date-reason").fill(reviewTitle === "延长住宿" ? "阶段 15 住客确认续住" : "阶段 15 住客确认缩短住宿");
  const price = form.getByTestId("stay-date-price-preview");
  await expect(price).toBeVisible({ timeout: 30_000 });
  await expect(form.getByTestId("stay-date-new-amount")).toHaveText(yuanDisplay(expectedAmountMinor));
  const continueButton = form.getByRole("button", { name: "继续核对", exact: true });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  const review = page.getByRole("dialog", { name: reviewTitle, exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByTestId("command-effect")).toContainText(yuanDisplay(expectedAmountMinor));
  await expect(review).not.toContainText(forbiddenProtocol);
  await review.getByTestId("confirm-command").click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

async function moveStay(page: Page, fixture: Stage15CompleteJourneyFixture): Promise<void> {
  await page.getByRole("button", { name: "换房", exact: true }).click();
  const form = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(form).toBeVisible();
  await form.getByTestId("move-effective-date").fill(fixture.moveDate);
  await form.getByTestId("move-unit-target-search").fill(fixture.targetUnit.code);
  await form.getByTestId("move-unit-id").selectOption(fixture.targetUnit.id);
  await expect(form.getByTestId("move-unit-target-status")).toContainText("目标区间可用", { timeout: 30_000 });
  await form.getByTestId("move-unit-reason").fill("阶段 15 住客确认换房");
  await expect(form.getByTestId("move-unit-preview")).toBeVisible({ timeout: 30_000 });
  const continueButton = form.getByRole("button", { name: "继续核对", exact: true });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  const review = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByTestId("command-effect")).toContainText(fixture.sourceUnit.code);
  await expect(review.getByTestId("command-effect")).toContainText(fixture.targetUnit.code);
  await expect(review).not.toContainText(forbiddenProtocol);
  await review.getByTestId("confirm-command").click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

test("6.2 desktop ordinary WeCom order composes collections, in-house changes, referenced refunds, and checkout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "阶段 15 完整发布旅程只在桌面项目执行");
  test.slow();
  const fixture = await prepareStage15CompleteJourney(e2eDatabaseUrl, { reset: !preserveExistingDatabase });
  const nickname = "阶段15完整旅程";
  const firstReference = "WX-STAGE15-COLLECTION-001";
  const secondReference = "WX-STAGE15-COLLECTION-002";
  const firstCollectionMinor = Math.floor(fixture.expectedExtendedAmountMinor / 2);
  const secondCollectionMinor = fixture.expectedExtendedAmountMinor - firstCollectionMinor;
  const refundReferenceMinor = fixture.expectedExtendedAmountMinor - fixture.expectedShortenedAmountMinor;
  const firstRefundMinor = Math.floor(refundReferenceMinor / 2);
  const secondRefundMinor = refundReferenceMinor - firstRefundMinor;
  expect(firstRefundMinor).toBeGreaterThan(0);
  expect(secondRefundMinor).toBeGreaterThan(0);
  expect(firstRefundMinor).toBeLessThanOrEqual(firstCollectionMinor);
  expect(secondRefundMinor).toBeLessThanOrEqual(secondCollectionMinor);

  await login(page);
  const orderId = await createWecomInHouseBackfill(page, fixture, nickname);
  await page.goto(`/orders/${encodeURIComponent(orderId)}`);
  await waitForOrder(page, nickname);
  await expect(page.getByTestId("order-amounts")).toContainText(yuanDisplay(fixture.expectedInitialAmountMinor));
  await recordWecomCollection(page, yuanInput(firstCollectionMinor), firstReference);
  await recordWecomCollection(page, yuanInput(secondCollectionMinor), secondReference);
  await expect(page.getByTestId("order-amounts")).toContainText(yuanDisplay(fixture.expectedExtendedAmountMinor));

  await expect(page.locator(".order-title-row").getByText("在住", { exact: true })).toBeVisible();

  await changeDeparture(page, fixture.extendedDepartureDate, fixture.expectedExtendedAmountMinor, "延长住宿");
  await expect(page.getByRole("region", { name: "住宿状态", exact: true }))
    .toContainText(`${fixture.arrivalDate} 至 ${fixture.extendedDepartureDate}`);
  let evidence = await inspectStage15CompleteJourney(orderId, e2eDatabaseUrl);
  expect(evidence.currentContractAmountMinor).toBe(fixture.expectedExtendedAmountMinor);
  expect(evidence.pricingRevisionCount).toBe(2);
  expect(evidence.amendmentTypes).toEqual(["CREATE_ORDER", "CHECK_IN", "EXTEND_STAY"]);

  await moveStay(page, fixture);
  await expect(page.locator(".order-unit")).toContainText(fixture.targetUnit.code);
  evidence = await inspectStage15CompleteJourney(orderId, e2eDatabaseUrl);
  expect(evidence.currentContractAmountMinor).toBe(fixture.expectedExtendedAmountMinor);
  expect(evidence.pricingRevisionCount).toBe(3);
  expect(evidence.amendmentTypes).toEqual(["CREATE_ORDER", "CHECK_IN", "EXTEND_STAY", "MOVE_UNIT"]);
  expect(evidence.effectiveIntervals).toEqual([
    { inventoryUnitId: fixture.sourceUnit.id, arrivalDate: fixture.arrivalDate, departureDate: fixture.moveDate },
    { inventoryUnitId: fixture.targetUnit.id, arrivalDate: fixture.moveDate, departureDate: fixture.extendedDepartureDate }
  ]);
  expect(evidence.activeClaims).toEqual([
    ...serviceDates(fixture.arrivalDate, fixture.moveDate).map((serviceDate) => ({
      inventoryUnitId: fixture.sourceUnit.id,
      serviceDate
    })),
    ...serviceDates(fixture.moveDate, fixture.extendedDepartureDate).map((serviceDate) => ({
      inventoryUnitId: fixture.targetUnit.id,
      serviceDate
    }))
  ].sort((left, right) => left.serviceDate.localeCompare(right.serviceDate) || left.inventoryUnitId.localeCompare(right.inventoryUnitId)));

  await changeDeparture(page, fixture.shortenedDepartureDate, fixture.expectedShortenedAmountMinor, "缩短住宿");
  await expect(page.getByRole("region", { name: "住宿状态", exact: true }))
    .toContainText(`${fixture.arrivalDate} 至 ${fixture.shortenedDepartureDate}`);
  evidence = await inspectStage15CompleteJourney(orderId, e2eDatabaseUrl);
  expect(evidence.currentContractAmountMinor).toBe(fixture.expectedShortenedAmountMinor);
  expect(evidence.netRecordedCollectionMinor).toBe(fixture.expectedExtendedAmountMinor);
  expect(evidence.collectionDifferenceMinor).toBe(-refundReferenceMinor);
  expect(evidence.pricingRevisionCount).toBe(4);
  expect(evidence.amendmentTypes).toEqual(["CREATE_ORDER", "CHECK_IN", "EXTEND_STAY", "MOVE_UNIT", "SHORTEN_STAY"]);
  expect(evidence.effectiveIntervals).toEqual([
    { inventoryUnitId: fixture.sourceUnit.id, arrivalDate: fixture.arrivalDate, departureDate: fixture.moveDate },
    { inventoryUnitId: fixture.targetUnit.id, arrivalDate: fixture.moveDate, departureDate: fixture.shortenedDepartureDate }
  ]);
  expect(evidence.activeClaims).toEqual([
    ...serviceDates(fixture.arrivalDate, fixture.moveDate).map((serviceDate) => ({
      inventoryUnitId: fixture.sourceUnit.id,
      serviceDate
    })),
    ...serviceDates(fixture.moveDate, fixture.shortenedDepartureDate).map((serviceDate) => ({
      inventoryUnitId: fixture.targetUnit.id,
      serviceDate
    }))
  ].sort((left, right) => left.serviceDate.localeCompare(right.serviceDate) || left.inventoryUnitId.localeCompare(right.inventoryUnitId)));

  await recordReferencedWecomRefund(page, firstReference, yuanInput(firstRefundMinor));
  await recordReferencedWecomRefund(page, secondReference, yuanInput(secondRefundMinor));
  const funds = page.getByRole("region", { name: "收退款与冲销记录表格", exact: true });
  await expect(funds.locator("tbody tr")).toHaveCount(4);
  await expect(funds.getByRole("rowheader", { name: "退款", exact: true })).toHaveCount(2);

  await advanceStage15CompleteJourneyBusinessDate(fixture.checkoutBusinessDate, e2eDatabaseUrl);
  await page.reload();
  await waitForOrder(page, nickname);
  await fulfill(page, "退房");
  await expect(page.locator(".order-title-row").getByText("已退房", { exact: true })).toBeVisible();
  await assertScopedAxe(page, "main");

  evidence = await inspectStage15CompleteJourney(orderId, e2eDatabaseUrl);
  expect(evidence).toMatchObject({
    orderStatus: "CHECKED_OUT",
    stayStatus: "COMPLETED",
    currentContractAmountMinor: fixture.expectedShortenedAmountMinor,
    netRecordedCollectionMinor: fixture.expectedShortenedAmountMinor,
    collectionDifferenceMinor: 0,
    activeClaims: []
  });
  expect(evidence.pricingRevisionCount).toBe(4);
  expect(evidence.amendmentTypes).toEqual([
    "CREATE_ORDER",
    "CHECK_IN",
    "EXTEND_STAY",
    "MOVE_UNIT",
    "SHORTEN_STAY",
    "CHECK_OUT"
  ]);
  const collections = evidence.collectionFacts.filter((fact) => fact.factType === "COLLECTION");
  const refunds = evidence.collectionFacts.filter((fact) => fact.factType === "REFUND");
  expect(collections).toHaveLength(2);
  expect(refunds).toHaveLength(2);
  const firstCollection = collections.find((collection) => collection.transactionReference === firstReference);
  const secondCollection = collections.find((collection) => collection.transactionReference === secondReference);
  expect(firstCollection).toMatchObject({ amountMinor: firstCollectionMinor, method: "WECOM" });
  expect(secondCollection).toMatchObject({ amountMinor: secondCollectionMinor, method: "WECOM" });
  expect(refunds.find((refund) => refund.referencesFactId === firstCollection?.factId)).toMatchObject({
    amountMinor: firstRefundMinor,
    netEffectMinor: -firstRefundMinor
  });
  expect(refunds.find((refund) => refund.referencesFactId === secondCollection?.factId)).toMatchObject({
    amountMinor: secondRefundMinor,
    netEffectMinor: -secondRefundMinor
  });
  expect(refunds.every((refund) => refund.method === "WECOM" && refund.transactionReference === null)).toBe(true);
  expect(evidence.collectionFacts.reduce((sum, fact) => sum + fact.netEffectMinor, 0))
    .toBe(fixture.expectedShortenedAmountMinor);
});

test("6.2 desktop upgrade membership survives reload and keeps order-member traceability", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "阶段 15 升级会员发布旅程只在桌面项目执行");
  test.slow();
  const fixture = await prepareStage13Acceptance(e2eDatabaseUrl, {
    reset: true,
    suffix: `stage15-${testInfo.project.name}-${testInfo.workerIndex}`
  });
  const { conversion } = fixture;
  const remainingReference = "WX-STAGE15-CONVERSION-REMAINING";

  await login(page);
  await page.goto(`/orders/${encodeURIComponent(conversion.orderId)}`);
  await waitForOrder(page, conversion.nickname);
  const convertButton = page.getByTestId("convert-stay-collections-to-membership");
  await expect(convertButton).toBeEnabled();
  await convertButton.click();

  const form = page.getByRole("dialog", { name: "升级会员", exact: true });
  await expect(form).toBeVisible();
  await expect(form).toContainText("用于升级的住宿收款");
  await expect(form).toContainText("¥590.00");
  await expect(form).toContainText(conversion.sourceTransactionReference);
  await form.getByLabel("目标会员").selectOption(conversion.memberId);
  await form.getByLabel("会员产品").selectOption(conversion.membershipProductId);
  await form.getByLabel("会员成交价（元）").fill(String(conversion.agreedPriceMinor / 100));
  await form.getByTestId("conversion-remaining-payment-reference").fill(remainingReference);
  await assertScopedAxe(page, "dialog");
  await form.getByRole("button", { name: "下一步", exact: true }).click();

  const review = page.getByRole("dialog", { name: "升级会员", exact: true });
  const effect = review.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 30_000 });
  await expect(effect).toContainText(`${conversion.arrivalDate} 至 ${conversion.departureDate}`);
  await expect(effect).toContainText("¥590.00");
  await expect(effect).toContainText("¥1,620.00");
  await expect(effect).toContainText("¥1,030.00");
  await expect(effect).toContainText("7 间夜");
  await expect(effect).toContainText("23 间夜");
  await expect(effect).not.toContainText(forbiddenProtocol);
  await assertScopedAxe(page, "dialog");
  type ConversionReceipt = {
    receiptId: string;
    businessCommitted: boolean;
    result?: {
      membershipOrderId?: string;
      memberId?: string;
      remainingUnits?: number;
      transferredCollectionFactIds?: string[];
      lodgingReversalFactIds?: string[];
      membershipPaymentFactIds?: string[];
      transferIds?: string[];
      conversionLedgerFactIds?: string[];
    };
  };
  let capturedReceipt: ConversionReceipt | undefined;
  let confirmationUrl = "";
  let confirmationHeaders: Record<string, string> | undefined;
  let confirmationPayload: unknown;
  await page.route(/\/api\/v1\/command-previews\/[^/]+\/confirm$/, async (route) => {
    const request = route.request();
    const response = await route.fetch();
    confirmationUrl = request.url();
    confirmationHeaders = request.headers();
    confirmationPayload = request.postDataJSON();
    capturedReceipt = await response.json() as ConversionReceipt;
    await route.abort("failed");
  });
  await review.getByTestId("confirm-command").click();
  const recoverButton = review.getByRole("button", { name: "查询原操作结果", exact: true });
  await expect(recoverButton).toBeVisible({ timeout: 30_000 });
  await page.unroute(/\/api\/v1\/command-previews\/[^/]+\/confirm$/);
  expect(capturedReceipt).toBeDefined();
  expect(confirmationUrl).not.toBe("");
  expect(confirmationHeaders).toBeDefined();
  const receipt = capturedReceipt!;
  expect(receipt).toMatchObject({
    businessCommitted: true,
    result: { memberId: conversion.memberId, remainingUnits: 23 }
  });
  expect(receipt.result?.membershipOrderId).toMatch(/^membership_order_/);
  expect(receipt.result?.transferredCollectionFactIds).toEqual([conversion.collectionFactId]);
  expect(receipt.result?.lodgingReversalFactIds).toHaveLength(1);
  expect(receipt.result?.membershipPaymentFactIds).toHaveLength(2);
  expect(receipt.result?.transferIds).toHaveLength(1);
  expect(receipt.result?.conversionLedgerFactIds).toHaveLength(7);
  const resolved = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/command-results/resolve"
    && response.status() === 200);
  await recoverButton.click();
  expect(await (await resolved).json()).toEqual(receipt);
  await expect(review).toBeHidden({ timeout: 30_000 });
  const replay = await page.request.post(confirmationUrl, {
    headers: {
      "idempotency-key": confirmationHeaders!["idempotency-key"]!,
      "x-correlation-id": confirmationHeaders!["x-correlation-id"]!,
      origin: confirmationHeaders!.origin!
    },
    data: confirmationPayload
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  await expect(page.getByTestId("command-result-notice")).toContainText("升级会员已完成");

  await expect(page.getByTestId("order-amounts")).toContainText("¥0.00");
  const transferRow = page.getByRole("region", { name: "收退款与冲销记录表格", exact: true })
    .locator("tbody tr")
    .filter({ hasText: conversion.sourceTransactionReference });
  await expect(transferRow).toContainText("已用于升级会员");
  await expect(page.getByRole("region", { name: "升级会员核销", exact: true })).toContainText("7 间夜");
  await expect(page.getByRole("button", { name: "退款", exact: true })).toBeDisabled();
  await expect(convertButton).toHaveCount(0);

  const orderResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(conversion.orderId)}`);
  expect(orderResponse.ok()).toBe(true);
  const orderView = await orderResponse.json() as {
    amounts: { currentContractAmount: { minorUnits: number } };
    collectionFacts: Array<{
      fact_id: string;
      fact_type: string;
      amount_minor: number;
      net_effect_minor: number;
      reverses_fact_id: string | null;
      transfer?: { membershipOrderId: string } | null;
    }>;
    amendments: Array<{ amendment_type: string }>;
    pricingRevisions: Array<{ current_contract_amount_minor: number }>;
    allowedActions: Array<{ code: string; enabled: boolean }>;
  };
  expect(orderView.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(orderView.amendments.map((amendment) => amendment.amendment_type))
    .toEqual(["CREATE_ORDER", "CHECK_IN", "CHECK_OUT", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"]);
  expect(orderView.pricingRevisions.map((revision) => revision.current_contract_amount_minor))
    .toEqual([conversion.originalContractMinor, 0]);
  expect(orderView.collectionFacts).toHaveLength(2);
  expect(orderView.collectionFacts.find((fact) => fact.fact_id === conversion.collectionFactId)?.transfer?.membershipOrderId)
    .toBe(receipt.result!.membershipOrderId);
  const lodgingReversal = orderView.collectionFacts.find((fact) => fact.fact_type === "REVERSAL");
  expect(lodgingReversal).toMatchObject({
    fact_id: receipt.result!.lodgingReversalFactIds![0],
    amount_minor: conversion.recordedCollectionMinor,
    net_effect_minor: -conversion.recordedCollectionMinor,
    reverses_fact_id: conversion.collectionFactId
  });
  expect(orderView.allowedActions.find((action) => action.code === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")?.enabled).toBe(false);
  expect(orderView.allowedActions.find((action) => action.code === "RECORD_REFUND")?.enabled).toBe(false);

  await page.reload();
  await waitForOrder(page, conversion.nickname);
  await expect(page.getByRole("region", { name: "升级会员核销", exact: true })).toContainText("7 间夜");
  await expect(page.getByRole("button", { name: "退款", exact: true })).toBeDisabled();
  await expect(page.getByTestId("convert-stay-collections-to-membership")).toHaveCount(0);
  await transferRow.getByRole("link", { name: "查看会员订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/members\\?memberId=${conversion.memberId}`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: `住宿转会员匹配会员-stage15-${testInfo.project.name}-${testInfo.workerIndex}`, exact: true })).toBeVisible({ timeout: 30_000 });

  const membershipOrder = page.getByTestId("membership-order-target");
  await expect(membershipOrder).toHaveAttribute("data-membership-order-id", receipt.result!.membershipOrderId!);
  await expect(membershipOrder).toContainText("已生效");
  await expect(membershipOrder).toContainText("住宿收款转入");
  await expect(membershipOrder).toContainText("¥590.00");
  await expect(membershipOrder).toContainText("企微收款");
  await expect(membershipOrder).toContainText("¥1,030.00");
  await expect(membershipOrder).toContainText(remainingReference);
  await expect(page.getByTestId("member-balance-summary")).toContainText("23 间夜");
  const ledgerEntry = page.getByTestId("member-ledger-entry-conversion-consume");
  await expect(ledgerEntry).toHaveCount(1);
  await expect(ledgerEntry).toContainText("住宿升级会员");
  await expect(ledgerEntry).toContainText("本次核销 7 间夜");
  await expect(ledgerEntry).toContainText(`${conversion.arrivalDate} 至 ${conversion.departureDate}`);

  const memberResponse = await page.request.get(`/api/v1/members/${encodeURIComponent(conversion.memberId)}?propertyId=prop_qintopia_demo`);
  expect(memberResponse.ok()).toBe(true);
  const memberView = await memberResponse.json() as {
    availableBalance: { ROOM_NIGHT: number };
    lots: Array<{ id: string; total_units: number }>;
    ledger: Array<{
      fact_id: string;
      lot_id: string;
      entry_type: string;
      order_id: string | null;
      service_date: string | null;
      quantity_delta: number;
    }>;
    membershipOrders: Array<{
      order: { id: string; status: string; entitlement_lot_id: string | null; entitlement_units: number };
      paymentFacts: Array<{
        fact_id: string;
        amount_minor: number;
        net_effect_minor: number;
        source_type: string;
        source_order_id: string | null;
        source_collection_fact_id: string | null;
        transaction_reference: string | null;
      }>;
    }>;
  };
  expect(memberView.availableBalance.ROOM_NIGHT).toBe(23);
  const conversionLedger = memberView.ledger.filter((entry) => entry.entry_type === "CONVERSION_CONSUME" && entry.order_id === conversion.orderId);
  expect(conversionLedger).toHaveLength(7);
  expect(conversionLedger.map((entry) => entry.service_date).sort())
    .toEqual(serviceDates(conversion.arrivalDate, conversion.departureDate));
  expect(conversionLedger.every((entry) => entry.quantity_delta === -1)).toBe(true);
  expect(new Set(conversionLedger.map((entry) => entry.fact_id)).size).toBe(7);
  expect(new Set(conversionLedger.map((entry) => entry.fact_id)))
    .toEqual(new Set(receipt.result!.conversionLedgerFactIds));
  const membership = memberView.membershipOrders.find((summary) => summary.order.id === receipt.result!.membershipOrderId);
  expect(membership?.order.status).toBe("ACTIVE");
  expect(membership?.order.entitlement_units).toBe(30);
  expect(memberView.lots.find((lot) => lot.id === membership?.order.entitlement_lot_id)?.total_units).toBe(30);
  expect(membership?.paymentFacts).toHaveLength(2);
  expect(new Set(membership?.paymentFacts.map((fact) => fact.fact_id)))
    .toEqual(new Set(receipt.result!.membershipPaymentFactIds));
  const transferredPayment = membership?.paymentFacts.find((fact) => fact.source_type === "STAY_COLLECTION_TRANSFER");
  const directPayment = membership?.paymentFacts.find((fact) => fact.source_type === "DIRECT_WECOM");
  expect(transferredPayment).toMatchObject({
    amount_minor: conversion.recordedCollectionMinor,
    net_effect_minor: conversion.recordedCollectionMinor,
    source_order_id: conversion.orderId,
    source_collection_fact_id: conversion.collectionFactId,
    transaction_reference: null
  });
  expect(directPayment).toMatchObject({
    amount_minor: conversion.remainingPaymentMinor,
    net_effect_minor: conversion.remainingPaymentMinor,
    source_order_id: null,
    source_collection_fact_id: null,
    transaction_reference: remainingReference
  });

  await membershipOrder.getByRole("link", { name: "查看住宿订单", exact: true }).click();
  await expect(page).toHaveURL(`/orders/${conversion.orderId}`);
  await waitForOrder(page, conversion.nickname);
  await expect(page.getByRole("region", { name: "升级会员核销", exact: true })).toContainText("7 间夜");
});
