import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { todayInTimeZone } from "@qintopia/domain";

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
}

async function confirmCommand(page: Page, reason: string, expectedFactTexts: string[] = []) {
  const previewButton = page.getByTestId("create-command-preview");
  await expect(previewButton).toBeEnabled({ timeout: 15_000 });
  await previewButton.click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const text of expectedFactTexts) await expect(effect).toContainText(text);
  await page.getByTestId("reason-note").fill(reason);
  const confirmButton = page.getByTestId("confirm-command");
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
  await confirmButton.click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt.getByRole("heading")).toBeVisible();
  await expect(receipt).not.toContainText(/EXECUTED|Receipt|业务写入已提交/);
  for (const text of expectedFactTexts) await expect(receipt).toContainText(text);
}

async function closeReceipt(page: Page) {
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  if (/\/orders\/order_[^/?#]+$/.test(new URL(page.url()).pathname)) {
    await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 15_000 });
  }
}

async function assertOperatorReceipt(page: Page) {
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt.getByRole("heading")).toBeVisible();
  await expect(receipt).not.toContainText(/EXECUTED|Receipt|业务写入已提交/);
  return receipt;
}

async function navigateWithinApp(page: Page, pathname: string, heading: string) {
  await page.evaluate((target) => {
    history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, pathname);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible({ timeout: 15_000 });
}

async function confirmU1Command(page: Page, expectedFactTexts: string[] = []) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const text of expectedFactTexts) await expect(effect).toContainText(text);
  const confirmButton = page.getByTestId("confirm-command");
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
  const confirmed = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await confirmButton.click();
  const receipt = await (await confirmed).json() as {
    resourceRefs: string[];
    factRefs: string[];
    result?: { orderId?: string };
  };
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect(page.getByTestId("command-result-notice")).toBeVisible();
  return receipt;
}

async function selectRoomStatusRange(
  page: Page,
  unitCode: string,
  departureDate: string,
  arrivalDate = "2026-07-21"
): Promise<string> {
  const generatedCode = /^([DE])(0[1-5])$/.exec(unitCode);
  const unitId = generatedCode
    ? `unit_room_${generatedCode[1]!.toLowerCase()}_gen_${generatedCode[2]}`
    : `unit_room_${unitCode.toLowerCase()}`;
  await page.getByTestId("arrival-date").fill(arrivalDate);
  await page.getByTestId("departure-date").fill(departureDate);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  if ((page.viewportSize()?.width ?? 0) < 576) {
    const mobileCreate = page.getByRole("button", { name: "新建住宿或锁房", exact: true });
    await expect(mobileCreate).toBeVisible();
    await mobileCreate.click();
    const createDialog = page.getByRole("dialog", { name: "新建住宿或锁房" });
    await expect(createDialog).toBeVisible();
    const unitSelect = createDialog.getByTestId("room-status-unit-select");
    await unitSelect.selectOption(unitId);
    await expect(unitSelect).toHaveValue(unitId);
    await createDialog.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
    await createDialog.getByLabel("退房日期", { exact: true }).fill(departureDate);
    return unitId;
  }

  const cell = page.locator(
    `.room-status-day-available[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${arrivalDate}"]`
  );
  await expect(cell).toBeVisible();
  await cell.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await cell.click();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", unitId);
  await popover.getByRole("button", { name: "创建住宿", exact: true }).click();
  const writeDrawer = page.locator("dialog.room-status-write-drawer");
  await expect(writeDrawer).toBeVisible();
  await writeDrawer.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await writeDrawer.getByLabel("退房日期", { exact: true }).fill(departureDate);
  return unitId;
}

async function chooseDatesAndUnit(
  page: Page,
  unitCode: string,
  departureDate: string,
  arrivalDate = "2026-07-21",
  action: "NORMAL" | "FREE" = "NORMAL"
) {
  await selectRoomStatusRange(page, unitCode, departureDate, arrivalDate);
  const actionName = action === "FREE" ? "创建免费入住" : "创建正常住宿订单";
  const actionButton = page.getByRole("button", { name: actionName, exact: true });
  await expect(actionButton).toBeEnabled();
  await actionButton.click();
  await expect(page.getByRole("heading", { name: "住宿金额", exact: true })).toBeVisible();
}

async function createOrder(page: Page, options: {
  stayMode: "MEMBER" | "NORMAL" | "FREE";
  unitCode: string;
  guest: string;
  nickname?: string;
  departureDate: string;
  arrivalDate?: string;
  transientMember?: boolean;
  memberIdentityCardNumber?: string;
  expectedCoverageNights?: number;
  expectedQuoteAmount?: string;
  freeStayReason?: string;
  freeStayCategoryCode?: "VOLUNTEER" | "RECEPTION";
  bookingChannelCode?: "YOUMUDAO" | "CTRIP" | "MEITUAN" | "WECOM";
  channelOrderReference?: string;
  targetContractAmountYuan?: string;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
  additionalGuests?: Array<{
    fullName: string;
    nickname: string;
    phone?: string;
    documentNumber?: string;
  }>;
}) {
  const memberIdentityCardNumber = options.memberIdentityCardNumber
    ?? (options.transientMember ? "DEMO-ID-310000199001010001" : undefined);
  if (options.stayMode === "MEMBER") expect(memberIdentityCardNumber).toBeTruthy();
  else expect(memberIdentityCardNumber).toBeUndefined();
  await chooseDatesAndUnit(
    page,
    options.unitCode,
    options.departureDate,
    options.arrivalDate,
    options.stayMode === "FREE" ? "FREE" : "NORMAL"
  );
  const quoteResult = page.getByTestId("quote-result");
  await expect(quoteResult).toBeVisible({ timeout: 15_000 });
  if (options.stayMode === "MEMBER") {
    const memberIdentity = memberIdentityCardNumber!;
    await page.getByTestId("use-member-entitlement").check();
    await expect(page.getByTestId("use-member-entitlement")).toBeChecked();
    await page.getByTestId("member-search").fill(memberIdentity);
    const memberSelect = page.getByTestId("member-profile-select");
    const memberOption = memberSelect.locator("option").filter({ hasText: memberIdentity });
    await expect(memberOption).toHaveCount(1);
    const selectedMemberId = await memberOption.getAttribute("value");
    expect(selectedMemberId).toBeTruthy();
    await memberSelect.selectOption(selectedMemberId!);
  }
  await expect(quoteResult).toBeVisible({ timeout: 15_000 });
  if (options.expectedCoverageNights !== undefined) {
    await expect(quoteResult.getByText("覆盖晚数", { exact: true }).locator("..")).toContainText(`${options.expectedCoverageNights} 晚`);
  }
  if (options.expectedQuoteAmount) {
    await expect(quoteResult.locator(".quote-amounts")).toContainText(options.expectedQuoteAmount);
  }
  await page.getByTestId("primary-guest-name").fill(options.guest);
  if (options.stayMode === "FREE") {
    const categorySelect = page.getByTestId("free-stay-category-code");
    await expect(categorySelect).toHaveValue("");
    await categorySelect.selectOption(options.freeStayCategoryCode ?? "RECEPTION");
    await page.getByTestId("free-stay-reason").fill(options.freeStayReason ?? `Automated FREE stay fixture: ${options.guest}`);
  }
  const expectedFacts = [options.nickname ?? options.guest];
  if (options.stayMode === "FREE") {
    expectedFacts.push({ VOLUNTEER: "义工", RECEPTION: "接待" }[options.freeStayCategoryCode ?? "RECEPTION"]);
  }
  if (options.stayMode === "NORMAL") {
    const bookingChannelCode = options.bookingChannelCode ?? "YOUMUDAO";
    const channelSelect = page.getByTestId("booking-channel-code");
    await expect(channelSelect).toHaveValue("");
    await expect(page.getByTestId("create-order")).toBeDisabled();
    await channelSelect.selectOption(bookingChannelCode);
    const channelLabel = { YOUMUDAO: "游牧岛", CTRIP: "携程", MEITUAN: "美团", WECOM: "企业微信" }[bookingChannelCode];
    expectedFacts.push(channelLabel);
    if (bookingChannelCode === "WECOM") {
      await expect(page.getByTestId("channel-order-reference")).toHaveCount(0);
      expectedFacts.push("不适用");
    } else {
      const channelOrderReference = options.channelOrderReference ?? `TEST-E2E-ORDER-${options.guest.replaceAll(" ", "-")}`;
      await page.getByTestId("channel-order-reference").fill(channelOrderReference);
      expectedFacts.push(channelOrderReference);
    }
    const policyAmount = (await quoteResult.getByText("政策基础金额", { exact: true }).locator("..").locator("strong").innerText())
      .replace(/[¥,]/g, "")
      .replace(/\.00$/, "");
    await page.getByTestId("target-contract-amount").fill(options.targetContractAmountYuan ?? policyAmount);
    if (options.channelPriceDifferenceReason) {
      await page.getByTestId("channel-price-difference-reason").fill(options.channelPriceDifferenceReason);
      expectedFacts.push(options.channelPriceDifferenceReason);
    }
    if (options.manualPriceAdjustmentReason) {
      await page.getByTestId("manual-price-adjustment-reason").fill(options.manualPriceAdjustmentReason);
      expectedFacts.push(options.manualPriceAdjustmentReason);
    }
  } else {
    await expect(page.getByTestId("booking-channel-code")).toHaveCount(0);
  }
  const nickname = options.nickname ?? options.guest;
  if (options.stayMode !== "MEMBER") await expect(page.getByTestId("create-order")).toBeDisabled();
  await page.getByTestId("primary-guest-nickname").fill(nickname);
  await expect(page.getByTestId("primary-guest-name")).toHaveAttribute("maxlength", "200");
  for (const [index, guest] of (options.additionalGuests ?? []).entries()) {
    await page.getByTestId("add-additional-guest").click();
    await expect(page.getByTestId(`additional-guest-${index}-name`)).toHaveAttribute("maxlength", "200");
    await page.getByTestId(`additional-guest-${index}-nickname`).fill(guest.nickname);
    await page.getByTestId(`additional-guest-${index}-name`).fill(guest.fullName);
    if (guest.phone) await page.getByTestId(`additional-guest-${index}-phone`).fill(guest.phone);
    if (guest.documentNumber) await page.getByTestId(`additional-guest-${index}-document`).fill(guest.documentNumber);
    expectedFacts.push(guest.nickname);
  }
  await page.getByTestId("create-order").click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const text of expectedFacts) await expect(effect).toContainText(text);
  await expect(page.getByTestId("reason-code")).toHaveCount(0);
  await expect(page.getByTestId("reason-note")).toHaveCount(0);
  const confirmButton = page.getByTestId("confirm-command");
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
  const confirmed = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await confirmButton.click();
  const receipt = await (await confirmed).json() as { result?: { orderId?: string } };
  expect(receipt.result?.orderId).toMatch(/^order_/);
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿订单已创建");
  return receipt.result!.orderId!;
}

async function openFactFormAndSubmit(
  page: Page,
  actionName: "收款" | "退款",
  amountMinor: string,
  transactionReference: string,
  expectedInitialAmountMinor = ""
) {
  await page.getByRole("button", { name: actionName, exact: true }).click();
  const factDialog = page.getByRole("dialog", {
    name: actionName === "退款" ? "引用原收款退款" : "记录收款事实",
    exact: true
  });
  await expect(factDialog).toBeVisible();
  const amountInput = factDialog.getByTestId("fact-amount-minor");
  const continueButton = factDialog.getByRole("button", { name: "继续核对", exact: true });
  await expect(amountInput).toHaveValue(expectedInitialAmountMinor);
  if (!expectedInitialAmountMinor) {
    await continueButton.click();
    await expect(amountInput).toBeFocused();
    expect(await amountInput.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  }
  await amountInput.fill(amountMinor);
  const transactionInput = factDialog.getByTestId("transaction-reference");
  await continueButton.click();
  await expect(transactionInput).toBeFocused();
  expect(await transactionInput.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  await transactionInput.fill(transactionReference);
  await continueButton.click();
}

async function submitMemberRegistration(page: Page, options: {
  fullName: string;
  identityCardNumber: string;
  phone: string;
  wechat: string;
}) {
  await page.getByTestId("create-member").click();
  await page.getByTestId("member-full-name").fill(options.fullName);
  await page.getByTestId("member-identity-card").fill(options.identityCardNumber);
  await page.getByTestId("member-phone").fill(options.phone);
  await page.getByTestId("member-wechat").fill(options.wechat);
  await page.getByRole("button", { name: "核对并创建" }).click();
}

async function assertNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ["violations"] })
    .analyze();
  expect(results.violations).toEqual([]);
}

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
}

async function tabTo(page: Page, target: Locator, options: { reverse?: boolean; limit?: number } = {}) {
  await expect(target).toBeVisible({ timeout: 5_000 });
  const key = options.reverse ? "Shift+Tab" : "Tab";
  for (let index = 0; index < (options.limit ?? 60); index += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

async function assertShellDoesNotOverlap(page: Page, width: number) {
  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".workspace-header")?.getBoundingClientRect();
    return {
      sidebarBottom: sidebar?.bottom ?? -1,
      sidebarRight: sidebar?.right ?? -1,
      headerTop: header?.top ?? -1,
      headerLeft: header?.left ?? -1
    };
  });
  if (width <= 860) {
    expect(shell.headerTop, `workspace header top at ${width}px`).toBeGreaterThanOrEqual(shell.sidebarBottom - 1);
    expect(shell.headerTop, `workspace header top at ${width}px`).toBeLessThanOrEqual(shell.sidebarBottom + 1);
  } else {
    expect(shell.headerLeft, `workspace header left at ${width}px`).toBeGreaterThanOrEqual(shell.sidebarRight - 1);
    expect(shell.headerLeft, `workspace header left at ${width}px`).toBeLessThanOrEqual(shell.sidebarRight + 1);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function deferNextConfirmResponse(page: Page, delivery: "ORIGINAL" | "SERVER_ERROR" = "ORIGINAL") {
  const fetched = deferred();
  const release = deferred();
  const fulfilled = deferred();
  let confirmationKey = "";
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    confirmationKey = route.request().headers()["idempotency-key"] ?? "";
    const response = await route.fetch();
    fetched.resolve();
    await release.promise;
    if (delivery === "ORIGINAL") {
      await route.fulfill({ response });
    } else {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "REQUEST_FAILED", message: "Deferred response failed in transit", retryable: true })
      });
    }
    fulfilled.resolve();
  }, { times: 1 });
  return {
    fetched: fetched.promise,
    release: release.resolve,
    fulfilled: fulfilled.promise,
    confirmationKey: () => confirmationKey
  };
}

async function deferNextQuoteResponse(page: Page) {
  const fetched = deferred();
  const release = deferred();
  const fulfilled = deferred();
  const requestFinished = deferred();
  let interceptedUrl = "";
  let idempotencyKey = "";
  page.on("requestfinished", (request) => {
    if (request.url() === interceptedUrl && request.headers()["idempotency-key"] === idempotencyKey) requestFinished.resolve();
  });
  await page.route("**/api/v1/quotes", async (route) => {
    interceptedUrl = route.request().url();
    idempotencyKey = route.request().headers()["idempotency-key"] ?? "";
    const response = await route.fetch();
    fetched.resolve();
    await release.promise;
    await route.fulfill({ response });
    fulfilled.resolve();
  }, { times: 1 });
  return {
    fetched: fetched.promise,
    release: release.resolve,
    fulfilled: fulfilled.promise,
    requestFinished: requestFinished.promise,
    idempotencyKey: () => idempotencyKey
  };
}

async function releaseQuoteAndFlushOldCallback(
  page: Page,
  delayed: Awaited<ReturnType<typeof deferNextQuoteResponse>>
) {
  delayed.release();
  await delayed.fulfilled;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function forceNavigateAwayAndBackToTokens(page: Page) {
  await page.evaluate(() => {
    history.pushState({}, "", "/orders");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, "", "/tokens");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();
  await expect(page.getByText("正在载入 Token", { exact: true })).toBeHidden();
}

async function releaseConfirmAndFlushOldCallback(
  page: Page,
  delayed: Awaited<ReturnType<typeof deferNextConfirmResponse>>
) {
  delayed.release();
  await delayed.fulfilled;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  }));
}

test("desktop logout distinguishes an unexecuted failure from a lost committed response", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only session failure coverage");
  await login(page);
  await page.route("**/api/v1/auth/logout", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SERVICE_NOT_READY",
        message: "Logout service is temporarily unavailable",
        correlationId: "e2e-logout-failure",
        retryable: true
      })
    });
  }, { times: 1 });

  await page.getByRole("button", { name: "退出登录" }).click();
  const failure = page.getByTestId("logout-error");
  await expect(failure).toBeFocused();
  await expect(failure).toContainText("退出未完成，会话仍保持登录");
  await expect(page.getByTestId("retry-logout")).toBeVisible();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeHidden();

  await page.reload();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeHidden();
  await assertNoA11yViolations(page);

  await page.route("**/api/v1/auth/logout", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByTestId("logout-error")).toBeHidden();
});

test("desktop session bootstrap exposes a focused retryable service failure", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only session bootstrap coverage");
  await login(page);
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SERVICE_NOT_READY",
        message: "Session lookup is temporarily unavailable",
        correlationId: "e2e-session-bootstrap",
        retryable: true
      })
    });
  });

  await page.reload();
  const failure = page.getByTestId("session-startup-error");
  await expect(failure).toBeFocused();
  await expect(failure).toContainText("无法确认登录状态");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeHidden();
  await assertNoA11yViolations(page);

  await page.unroute("**/api/v1/me");
  await page.getByTestId("session-startup-error-retry").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
});

test("desktop core operating journey", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only journey");
  await login(page);
  await assertNoA11yViolations(page);
  const businessDate = todayInTimeZone("Asia/Shanghai");
  const memberOrderId = await createOrder(page, {
    stayMode: "MEMBER",
    unitCode: "D01",
    guest: "E2E Member Guest",
    nickname: "风铃",
    arrivalDate: businessDate,
    departureDate: addDays(businessDate, 3),
    transientMember: true,
    expectedCoverageNights: 2,
    expectedQuoteAmount: "¥130"
  });
  await page.goto(`/orders/${encodeURIComponent(memberOrderId)}`);
  await expect(page).toHaveURL(/\/orders\/order_[^/?#]+$/, { timeout: 15_000 });
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "风铃" })).toBeVisible({ timeout: 15_000 });
  const stayRegion = page.getByRole("region", { name: "住宿状态" });
  await expect(stayRegion.getByText("住宿来源", { exact: true })).toBeVisible();
  await expect(stayRegion.getByText("会员权益", { exact: true })).toBeVisible();
  await expect(page.getByTestId("order-amounts")).toContainText("¥130.00");
  const coverageRegion = page.getByRole("region", { name: "会员覆盖" });
  await expect(coverageRegion.getByRole("columnheader", { name: "服务日期" })).toBeVisible();
  await expect(coverageRegion.getByText("已冻结", { exact: true })).toHaveCount(2);
  await expect(coverageRegion.getByText("已核销", { exact: true })).toHaveCount(0);

  await openFactFormAndSubmit(page, "收款", "6000", "TEST-E2E-TXN-COLLECTION-001");
  await confirmCommand(page, "First recorded collection", ["TEST-E2E-TXN-COLLECTION-001"]);
  await closeReceipt(page);
  await openFactFormAndSubmit(page, "收款", "6000", "TEST-E2E-TXN-COLLECTION-002");
  await confirmCommand(page, "Second recorded collection", ["TEST-E2E-TXN-COLLECTION-002"]);
  await closeReceipt(page);

  await page.getByTestId("reprice-order").click();
  await expect(page.getByTestId("reprice-target-yuan")).toHaveValue("130");
  await page.getByTestId("reprice-target-yuan").fill("110");
  await page.getByTestId("reprice-reason").fill("Set this revision final total to CNY 110");
  await page.getByRole("button", { name: "继续核对" }).click();
  await confirmU1Command(page, ["¥130.00", "¥110.00", "-¥20.00", "Set this revision final total to CNY 110"]);
  await expect(page.getByTestId("order-amounts")).toContainText("¥110.00");
  const revisionRegion = page.locator('.table-region[aria-label="计价记录表格"]');
  await expect(revisionRegion.getByRole("row")).toHaveCount(3);
  const manualRevision = revisionRegion.getByRole("row").filter({ hasText: "第 2 次计价" });
  await expect(manualRevision.locator("td").nth(3)).toHaveText("¥130.00");
  await expect(manualRevision.locator("td").nth(4).locator("strong")).toHaveText("-¥20.00");
  await expect(manualRevision.locator("td").nth(5)).toHaveText("¥110.00");

  await page.getByTestId("reprice-order").click();
  await expect(page.getByTestId("reprice-target-yuan")).toHaveValue("110");
  await page.getByRole("dialog", { name: "调整订单金额" }).getByRole("button", { name: "取消", exact: true }).click();

  await page.getByRole("button", { name: "调整预订日期", exact: true }).click();
  const dateChangeDrawer = page.getByRole("dialog", { name: "调整预订日期", exact: true });
  await dateChangeDrawer.getByTestId("stay-date-departure").fill(addDays(businessDate, 2));
  await dateChangeDrawer.getByTestId("stay-date-reason").fill("Guest leaves one night early");
  await expect(dateChangeDrawer.getByTestId("stay-date-new-amount")).toBeVisible({ timeout: 15_000 });
  const continueDateChange = dateChangeDrawer.getByRole("button", { name: "继续核对", exact: true });
  await expect(continueDateChange).toBeEnabled();
  await continueDateChange.click();
  await confirmU1Command(page, ["Guest leaves one night early"]);
  await expect(page.getByTestId("order-amounts")).toContainText("¥0.00");
  await expect(revisionRegion.getByRole("row")).toHaveCount(4);
  const shortenedRevision = revisionRegion.getByRole("row").filter({ hasText: "第 3 次计价" });
  await expect(shortenedRevision.locator("td").nth(3)).toHaveText("¥0.00");
  await expect(shortenedRevision.locator("td").nth(4).locator("strong")).toHaveText("¥0.00");
  await expect(shortenedRevision.locator("td").nth(5)).toHaveText("¥0.00");

  await openFactFormAndSubmit(page, "退款", "3000", "TEST-E2E-TXN-REFUND-001", "6000");
  await confirmCommand(page, "Partial refund references first collection", ["TEST-E2E-TXN-REFUND-001"]);
  await closeReceipt(page);
  const fundsRegion = page.locator('.table-region[aria-label="收退款与冲销记录表格"]');
  await expect(fundsRegion.getByRole("rowheader", { name: "退款", exact: true })).toBeVisible();
  await expect(fundsRegion).toContainText("TEST-E2E-TXN-COLLECTION-001");
  await expect(fundsRegion).toContainText("TEST-E2E-TXN-COLLECTION-002");
  await expect(fundsRegion).toContainText("TEST-E2E-TXN-REFUND-001");

  await page.getByTestId("check-in").click();
  const checkInEffect = page.getByTestId("command-effect");
  await expect(checkInEffect).toContainText("会员权益", { timeout: 15_000 });
  await expect(checkInEffect).toContainText("本次核销 2 晚已冻结权益");
  await page.getByTestId("reason-note").fill("Guest identity and room checked");
  const checkInReceipt = await confirmU1Command(page);
  expect(checkInReceipt.factRefs).toHaveLength(2);
  await expect(page.locator(".order-title-row").getByText("在住", { exact: true })).toBeVisible();
  await expect(coverageRegion.getByText("已冻结", { exact: true })).toHaveCount(0);
  await expect(coverageRegion.getByText("已核销", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("check-out")).toHaveCount(0);
  await expect(page.getByText("入住当天暂不办理缩短或提前退房", { exact: false })).toBeVisible();
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-order.png"), fullPage: true });
});

test("desktop whole-room order records every occupant and room status exposes nicknames only", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only whole-room occupant journey");
  const createOrderBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (new URL(request.url()).pathname === "/api/v1/command-previews" && body.commandType === "CREATE_ORDER") {
        createOrderBodies.push(body);
      }
    } catch {
      // Request parsing is asserted by the endpoint; this observer captures the successful browser path.
    }
  });
  await login(page);
  const wholeRoomOrderId = await createOrder(page, {
    stayMode: "NORMAL",
    unitCode: "A03",
    guest: "大床房主要入住人",
    nickname: "山峰",
    arrivalDate: "2026-10-01",
    departureDate: "2026-10-03",
    bookingChannelCode: "WECOM",
    additionalGuests: [{
      fullName: "大床房同行真实姓名",
      nickname: "小满",
      phone: "13800138000",
      documentNumber: "E2E-DOCUMENT-SECRET"
    }]
  });
  await expect.poll(() => createOrderBodies.length).toBe(1);
  expect((createOrderBodies[0]!.input as Record<string, unknown>).additionalGuests).toEqual([{
    fullName: "大床房同行真实姓名",
    nickname: "小满",
    phone: "13800138000",
    documentNumber: "E2E-DOCUMENT-SECRET"
  }]);

  await page.goto(`/orders/${encodeURIComponent(wholeRoomOrderId)}`);
  await expect(page).toHaveURL(/\/orders\/order_[^/?#]+$/, { timeout: 15_000 });
  await expect(page.getByTestId("order-occupant")).toHaveCount(2);
  const occupants = page.getByRole("region", { name: "住宿人", exact: true });
  await expect(occupants).toContainText("山峰");
  await expect(occupants).toContainText("小满");
  await expect(occupants).toContainText("大床房主要入住人");
  await expect(occupants).toContainText("大床房同行真实姓名");
  await expect(occupants).toContainText("13800138000");
  await expect(occupants).toContainText("E2E-DOCUMENT-SECRET");

  await page.getByRole("link", { name: "房态", exact: true }).click();
  await page.getByTestId("arrival-date").fill("2026-10-01");
  await page.getByTestId("departure-date").fill("2026-10-04");
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  const cell = page.locator('[data-room-status-cell="true"][data-unit-id="unit_room_a03"][data-service-date="2026-10-01"]');
  await expect(cell).toContainText("山峰、小满");
  await expect(cell).toContainText("2人");
  await expect(page.locator('[data-room-status-row="unit_room_a03"] .room-status-interval').filter({ hasText: /山峰|小满/ })).toHaveCount(0);
  const accessibleText = `${await cell.getAttribute("aria-label") ?? ""} ${await cell.getAttribute("title") ?? ""}`;
  expect(accessibleText).toContain("山峰");
  expect(accessibleText).toContain("小满");
  expect(accessibleText).not.toContain("大床房主要入住人");
  expect(accessibleText).not.toContain("大床房同行真实姓名");
  expect(accessibleText).not.toContain("13800138000");
  expect(accessibleText).not.toContain("E2E-DOCUMENT-SECRET");
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-whole-room-occupants.png"), fullPage: true });

});

test("mobile today check-in journey", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only journey");
  await login(page);
  const businessDate = todayInTimeZone("Asia/Shanghai");
  await createOrder(page, { stayMode: "NORMAL", unitCode: "102", guest: "Mobile Guest", arrivalDate: businessDate, departureDate: addDays(businessDate, 1), bookingChannelCode: "WECOM" });
  await page.getByRole("link", { name: "移动履约" }).click();
  await page.getByLabel("营业日期").fill(businessDate);
  await page.getByRole("tab", { name: /今日到店/ }).click();
  await expect(page.getByText("Mobile Guest", { exact: true })).toBeVisible();
  await page.getByRole("article").filter({ hasText: "Mobile Guest" }).getByRole("button", { name: "入住", exact: true }).click();
  await expect(page.getByTestId("reason-note")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("reason-note").fill("Mobile arrival verification");
  await confirmU1Command(page);
  await page.getByRole("tab", { name: /在住/ }).click();
  await expect(page.getByText("Mobile Guest", { exact: true })).toBeVisible();
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-today.png"), fullPage: true });
});

test("desktop stay changes and exception commands remain operable through Web", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only command coverage");
  await login(page);

  const changeOrderId = await createOrder(page, { stayMode: "NORMAL", unitCode: "101", guest: "E2E Change Guest", arrivalDate: "2026-09-10", departureDate: "2026-09-12", bookingChannelCode: "MEITUAN", channelOrderReference: "TEST-E2E-MEITUAN-001" });
  await page.goto(`/orders/${encodeURIComponent(changeOrderId)}`);
  await page.getByRole("button", { name: "调整预订日期", exact: true }).click();
  const stayDateDrawer = page.getByRole("dialog", { name: "调整预订日期", exact: true });
  await stayDateDrawer.getByTestId("stay-date-departure").fill("2026-09-13");
  await stayDateDrawer.getByTestId("stay-date-channel-amount").fill("696");
  await stayDateDrawer.getByTestId("stay-date-reason").fill("住客确认延长住宿一晚");
  await expect(stayDateDrawer.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  await stayDateDrawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const stayDateReview = page.getByRole("dialog", { name: "调整预订日期", exact: true });
  await expect(stayDateReview.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await stayDateReview.getByTestId("confirm-command").click();
  await expect(stayDateReview).toBeHidden({ timeout: 30_000 });
  await page.getByRole("button", { name: "换房", exact: true }).click();
  const moveDrawer = page.getByRole("dialog", { name: "换房", exact: true });
  await moveDrawer.getByTestId("move-unit-id").selectOption("unit_room_102");
  await moveDrawer.getByTestId("move-effective-date").fill("2026-09-11");
  await moveDrawer.getByTestId("move-unit-reason").fill("住客确认更换住宿房源");
  await moveDrawer.getByTestId("move-channel-amount").fill("696");
  await expect(moveDrawer.getByTestId("move-unit-preview")).toBeVisible({ timeout: 30_000 });
  await moveDrawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const moveReview = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(moveReview.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await moveReview.getByTestId("confirm-command").click();
  await expect(moveReview).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".order-unit")).toContainText("102 · 102 · 四人间（公卫）");

  await page.goto("/");
  const cancelOrderId = await createOrder(page, { stayMode: "NORMAL", unitCode: "101", guest: "E2E Cancel Guest", arrivalDate: "2026-09-15", departureDate: "2026-09-16", bookingChannelCode: "YOUMUDAO", channelOrderReference: "TEST-E2E-YOUMUDAO-001" });
  await page.goto(`/orders/${encodeURIComponent(cancelOrderId)}`);
  await page.getByRole("button", { name: "取消订单" }).click();
  const cancelDrawer = page.getByRole("dialog", { name: "取消订单", exact: true });
  await expect(cancelDrawer).toBeVisible();
  await expect(cancelDrawer.getByTestId("lifecycle-reason")).toHaveValue("");
  await cancelDrawer.getByTestId("lifecycle-reason").fill("住客确认取消本次住宿并释放库存");
  await cancelDrawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const cancelReview = page.getByRole("dialog", { name: "取消订单", exact: true });
  await expect(cancelReview.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(cancelReview).toContainText("处理后订单金额");
  await expect(cancelReview).toContainText("¥0.00");
  await expect(cancelReview).toContainText("本次操作不会自动退款");
  await expect(cancelReview).not.toContainText(/CANCEL_ORDER|Preview|Receipt|Command|order_[a-z0-9_-]+/i);
  await cancelReview.getByRole("button", { name: "确认取消订单", exact: true }).click();
  const cancelRecovery = cancelReview.getByRole("button", { name: "查询原操作结果", exact: true });
  const cancellationNeedsRecovery = await Promise.race([
    cancelRecovery.waitFor({ state: "visible", timeout: 10_000 }).then(() => true),
    cancelReview.waitFor({ state: "hidden", timeout: 10_000 }).then(() => false)
  ]);
  if (cancellationNeedsRecovery) await cancelRecovery.click();
  await expect(cancelReview).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".order-title-row").getByText("已取消", { exact: true })).toBeVisible();

  await page.goto("/");
  const noShowOrderId = await createOrder(page, { stayMode: "NORMAL", unitCode: "102", guest: "E2E No Show Guest", arrivalDate: "2026-09-15", departureDate: "2026-09-16", bookingChannelCode: "WECOM" });
  await page.goto(`/orders/${encodeURIComponent(noShowOrderId)}`);
  await expect(page.getByRole("button", { name: "标记未到", exact: true })).toHaveCount(0);
  const noShowView = await page.request.get(`/api/v1/orders/${encodeURIComponent(noShowOrderId)}`);
  expect(noShowView.ok()).toBe(true);
  const noShowActions = (await noShowView.json() as {
    allowedActions: Array<{ code: string; enabled: boolean; disabledReason: string | null }>;
  }).allowedActions;
  expect(noShowActions.find((action) => action.code === "MARK_NO_SHOW")).toMatchObject({
    enabled: false,
    disabledReason: "计划到店日 20:00 后才能标记未到"
  });
  await assertNoA11yViolations(page);
});

test("member directory creates a four-field profile, searches every field, and rejects duplicate identity", async ({ page }, testInfo: TestInfo) => {
  await login(page);
  await page.getByRole("link", { name: "会员" }).click();
  await expect(page.getByRole("heading", { name: "会员档案" })).toBeVisible();

  const initialSearch = page.getByRole("search", { name: "搜索会员" });
  await page.getByTestId("member-search-query").fill("Demo Member");
  await initialSearch.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByRole("heading", { name: "Demo Member" })).toBeVisible();

  const memberProfile = {
    fullName: testInfo.project.name === "desktop" ? "周明月" : "孙晓岚",
    identityCardNumber: testInfo.project.name === "desktop"
      ? "E2E-ID-310000199202020002"
      : "E2E-ID-310000199202020003",
    phone: testInfo.project.name === "desktop" ? "13900001111" : "13900001112",
    wechat: `qintopia-e2e-member-${testInfo.project.name}`
  };
  const automaticMemberPreview = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/command-previews");
  await submitMemberRegistration(page, memberProfile);
  expect((await automaticMemberPreview).status()).toBe(200);
  await expect(page.getByTestId("create-command-preview")).toBeHidden();
  const createMemberEffect = page.getByTestId("command-effect");
  await expect(createMemberEffect).toContainText("请核对会员资料", { timeout: 15_000 });
  await expect(createMemberEffect).toContainText(memberProfile.fullName);
  await expect(createMemberEffect).toContainText(memberProfile.identityCardNumber);
  await expect(createMemberEffect).toContainText(memberProfile.phone);
  await expect(createMemberEffect).toContainText(memberProfile.wechat);
  await expect(createMemberEffect).not.toContainText(/CREATE_MEMBER|contract_|member_|FEISHU|Preview|Receipt/);
  await page.getByRole("button", { name: "确认创建会员档案" }).click();
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-result-notice")).toContainText("会员档案已创建，会员列表已刷新");
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect(page.getByRole("heading", { name: memberProfile.fullName })).toBeVisible();
  await expect(page.getByTestId("member-search-query")).toHaveValue("");

  const memberSearch = page.getByRole("search", { name: "搜索会员" });
  const searchInput = page.getByTestId("member-search-query");
  for (const query of [
    memberProfile.fullName.slice(1),
    memberProfile.identityCardNumber.slice(-6),
    memberProfile.phone.slice(-6),
    `member-${testInfo.project.name}`
  ]) {
    await searchInput.fill(query);
    await memberSearch.getByRole("button", { name: "搜索" }).click();
    await expect(page.getByText("正在载入会员列表", { exact: true })).toBeHidden();
    await expect(page.getByRole("heading", { name: memberProfile.fullName })).toBeVisible();
    const detail = page.locator(".member-profile-fields");
    await expect(detail).toContainText(memberProfile.identityCardNumber);
    await expect(detail).toContainText(memberProfile.phone);
    await expect(detail).toContainText(memberProfile.wechat);
  }

  await page.route(/\/api\/v1\/members\?/, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "REQUEST_FAILED", message: "Member directory unavailable", retryable: true })
    });
  }, { times: 1 });
  await searchInput.fill("fail-closed-member-query");
  await memberSearch.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByRole("alert")).toContainText("Member directory unavailable");
  await expect(page.getByTestId("member-list-item")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: memberProfile.fullName })).toHaveCount(0);

  await submitMemberRegistration(page, { ...memberProfile, fullName: "重复身份证会员", identityCardNumber: ` ${memberProfile.identityCardNumber.toLowerCase()} ` });
  await expect(page.getByText("该身份证号已登记，不能重复创建会员档案", { exact: true })).toBeVisible();
  await page.getByTestId("command-return-to-edit").click();
  await expect(page.getByTestId("member-full-name")).toHaveValue("重复身份证会员");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog", { name: "新建会员" })).toBeHidden();

  if (testInfo.project.name === "desktop") {
    const recoveryProfile = {
      fullName: "恢复验收会员",
      identityCardNumber: "E2E-ID-MEMBER-RECOVERY-001",
      phone: "13900001119",
      wechat: "qintopia-e2e-member-recovery"
    };
    await submitMemberRegistration(page, recoveryProfile);
    await expect(page.getByTestId("command-effect")).toContainText(recoveryProfile.fullName);
    let originalConfirmationKey = "";
    await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
      originalConfirmationKey = route.request().headers()["idempotency-key"] ?? "";
      await route.fetch();
      await route.abort("failed");
    }, { times: 1 });
    await page.getByRole("button", { name: "确认创建会员档案" }).click();
    await expect(page.getByText("建档结果需要恢复查询", { exact: true })).toBeVisible();
    expect(originalConfirmationKey).toMatch(/^web-confirm-create_member-/);
    await page.getByTestId("command-close").click();

    let recovery = page.getByTestId("member-command-recovery");
    await expect(recovery).toContainText("会员建档结果需要恢复查询");
    await expect(recovery).not.toContainText(originalConfirmationKey);
    await page.reload();
    recovery = page.getByTestId("member-command-recovery");
    await expect(recovery).toBeVisible();
    await recovery.getByTestId("member-command-recovery-open").click();
    await page.getByRole("button", { name: "查询建档结果" }).click();
    await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("command-result-notice")).toContainText("会员档案已创建，会员列表已刷新");
    await expect(page.getByTestId("command-receipt")).toBeHidden();
    await expect(page.getByRole("heading", { name: recoveryProfile.fullName })).toBeVisible();
    await expect(page.getByTestId("member-command-recovery")).toBeHidden();
  }

  await expect(page.locator("main")).not.toContainText(/Member ID|合同周期|飞书申请|权益 Lot|权益 Ledger/);
  await assertNoA11yViolations(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("member-directory-2a.png"), fullPage: true });
});

test("desktop quote command recovers the committed Quote after response loss", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only direct command recovery");
  await login(page);
  let originalQuoteKey = "";
  let quotePostCount = 0;
  await page.route("**/api/v1/quotes", async (route) => {
    quotePostCount += 1;
    originalQuoteKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });

  await chooseDatesAndUnit(page, "101", "2026-10-12", "2026-10-10", "FREE");
  let recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价结果尚未确认", { timeout: 15_000 });
  await expect(recovery).not.toContainText(originalQuoteKey);
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);
  expect(quotePostCount).toBe(1);

  await page.reload();
  await selectRoomStatusRange(page, "101", "2026-10-12", "2026-10-10");
  recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价结果尚未确认", { timeout: 15_000 });
  await navigateWithinApp(page, "/orders", "订单");
  await navigateWithinApp(page, "/", "房态与可售");
  await selectRoomStatusRange(page, "101", "2026-10-12", "2026-10-10");
  recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价结果尚未确认", { timeout: 15_000 });

  const recoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  await recovery.getByRole("button", { name: "重新查询报价结果" }).click();
  const recoveredUrl = new URL((await recoveryRequest).url());
  expect(recoveredUrl.searchParams.get("commandType")).toBe("CREATE_QUOTE");
  expect(recoveredUrl.searchParams.get("idempotencyKey")).toBe(originalQuoteKey);
  await expect(page.getByTestId("quote-recovery")).toBeHidden();
  await expect(page.getByTestId("quote-result")).toBeVisible();
  await expect(page.getByText(/报价已恢复，但当前筛选条件已变化/)).toBeHidden();
  expect(quotePostCount).toBe(1);
  await assertNoA11yViolations(page);
});

test("desktop delayed Quote callback after navigation preserves SENDING recovery without a duplicate Quote", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Quote lifecycle recovery");
  let quotePostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") quotePostCount += 1;
  });
  await login(page);
  const delayed = await deferNextQuoteResponse(page);

  await chooseDatesAndUnit(page, "102", "2026-10-15", "2026-10-13", "FREE");
  await delayed.fetched;
  const originalQuoteKey = delayed.idempotencyKey();
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);
  await expect(page.getByText("正在计算住宿金额", { exact: true })).toBeVisible();

  await navigateWithinApp(page, "/orders", "订单");
  await releaseQuoteAndFlushOldCallback(page, delayed);
  expect(await page.evaluate((idempotencyKey) => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith("qintopia.quote-command-recovery.v1:")))
    .map((key) => JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: string; metadata?: { idempotencyKey?: string } })
    .some((record) => record.state === "SENDING" && record.metadata?.idempotencyKey === idempotencyKey), originalQuoteKey)).toBe(true);

  const recoveryRequest = page.waitForRequest((request) => request.method() === "GET"
    && new URL(request.url()).pathname === "/api/v1/command-results");
  await navigateWithinApp(page, "/", "房态与可售");
  await selectRoomStatusRange(page, "102", "2026-10-15", "2026-10-13");
  const recoveredUrl = new URL((await recoveryRequest).url());
  expect(recoveredUrl.searchParams.get("idempotencyKey")).toBe(originalQuoteKey);
  await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
  expect(quotePostCount).toBe(1);
});

test("desktop delayed Quote callback cannot cross a same-page property scope switch", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Quote property scope isolation");
  const originalPropertyId = "prop_qintopia_demo";
  const secondaryPropertyId = "property_e2e_quote_scope";
  await page.route("**/api/v1/meta", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      properties: Array<{ id: string; code: string; name: string; timezone: string; currency: string }>;
    };
    body.properties.push({
      id: secondaryPropertyId,
      code: "E2E-SCOPE",
      name: "Quote Scope Fixture",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/v1/properties/${secondaryPropertyId}/room-status?*`, async (route) => {
    const url = new URL(route.request().url());
    const arrivalDate = url.searchParams.get("arrivalDate")!;
    const departureDate = url.searchParams.get("departureDate")!;
    const dates: string[] = [];
    for (let cursor = arrivalDate; cursor < departureDate;) {
      dates.push(cursor);
      const next = new Date(`${cursor}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
    const asOf = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        propertyId: secondaryPropertyId,
        businessDate: arrivalDate,
        range: { arrivalDate, departureDate },
        dates,
        asOf,
        freshUntil: new Date(Date.parse(asOf) + 5_000).toISOString(),
        revision: "0",
        accessLevel: "WRITE",
        projectionState: "READY",
        filterOptions: { roomTypeCodes: [], salesModes: [], statuses: [], capacities: [], unitKinds: [] },
        page: { index: 0, size: 200, totalRooms: 0, totalPages: 0 },
        operationalTasks: [],
        rooms: []
      })
    });
  });
  let quotePostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") quotePostCount += 1;
  });

  await login(page);
  const delayed = await deferNextQuoteResponse(page);
  await chooseDatesAndUnit(page, "103", "2026-10-18", "2026-10-16", "FREE");
  await delayed.fetched;
  const originalQuoteKey = delayed.idempotencyKey();
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);

  await page.getByTestId("property-select").selectOption(secondaryPropertyId);
  await expect(page.getByTestId("property-select")).toHaveValue(secondaryPropertyId);
  await expect(page.getByText("当前页没有库存单元", { exact: true })).toBeVisible();
  await expect(page.getByTestId("quote-recovery")).toBeHidden();
  await releaseQuoteAndFlushOldCallback(page, delayed);
  await expect(page.getByText("本地报价恢复记录不可用", { exact: true })).toBeHidden();
  await expect(page.getByTestId("quote-result")).toBeHidden();
  expect(await page.evaluate((idempotencyKey) => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith("qintopia.quote-command-recovery.v1:")))
    .map((key) => JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: string; metadata?: { idempotencyKey?: string } })
    .some((record) => record.state === "SENDING" && record.metadata?.idempotencyKey === idempotencyKey), originalQuoteKey)).toBe(true);

  const recoveryRequest = page.waitForRequest((request) => request.method() === "GET"
    && new URL(request.url()).pathname === "/api/v1/command-results");
  await page.getByTestId("property-select").selectOption(originalPropertyId);
  const recoveredUrl = new URL((await recoveryRequest).url());
  expect(recoveredUrl.searchParams.get("idempotencyKey")).toBe(originalQuoteKey);
  await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
  expect(quotePostCount).toBe(1);
});

test("desktop order command recovery survives close refresh and navigation without a duplicate Fact", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only order command recovery");
  await login(page);
  const recoveryOrderId = await createOrder(page, {
    stayMode: "NORMAL",
    unitCode: "104",
    guest: "E2E Recovery Guest",
    arrivalDate: "2028-02-01",
    departureDate: "2028-02-02",
    bookingChannelCode: "YOUMUDAO",
    channelOrderReference: "TEST-E2E-RECOVERY-ORDER-001"
  });
  await page.goto(`/orders/${encodeURIComponent(recoveryOrderId)}`);
  await expect(page.getByRole("heading", { name: "E2E Recovery Guest" })).toBeVisible();
  const orderUrl = page.url();
  const transactionReference = "TEST-E2E-RECOVERY-COLLECTION-001";

  await openFactFormAndSubmit(page, "收款", "5800", transactionReference);
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toContainText(transactionReference);
  await page.getByTestId("reason-note").fill("Record collection while the Confirm response is lost");

  let originalConfirmationKey = "";
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    originalConfirmationKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
  await expect(page.getByTestId("confirm-command")).toHaveCount(0);
  await expect(page.getByTestId("regenerate-command-preview")).toHaveCount(0);
  expect(originalConfirmationKey).toMatch(/^web-confirm-record_collection-/);
  await page.getByRole("button", { name: "取消", exact: true }).click();

  let recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText("RECORD_COLLECTION");
  await expect(recovery).toContainText("UNKNOWN");
  await expect(recovery).toContainText(originalConfirmationKey);
  await expect(page.getByTestId("record-collection")).toBeDisabled();
  await expect(page.getByTestId("reprice-order")).toBeDisabled();
  const retainedBeforeReload = await page.evaluate(() => {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith("qintopia.command-recovery.v1:")));
    return keys.map((key) => sessionStorage.getItem(key) ?? "");
  });
  expect(retainedBeforeReload).toHaveLength(1);
  expect(retainedBeforeReload[0]).toContain(originalConfirmationKey);
  expect(retainedBeforeReload[0]).not.toContain(transactionReference);
  expect(retainedBeforeReload[0]).not.toContain("tokenSecret");

  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E Recovery Guest" })).toBeVisible();
  recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText(originalConfirmationKey);
  await expect(page.getByTestId("record-collection")).toBeDisabled();

  await page.getByRole("link", { name: "返回订单" }).click();
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();
  await page.goto(orderUrl);
  await expect(page.getByRole("heading", { name: "E2E Recovery Guest" })).toBeVisible();
  recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toContainText(originalConfirmationKey);
  await recovery.getByTestId("order-command-recovery-open").click();

  const recoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  await page.getByRole("button", { name: "查询命令结果" }).click();
  const recoveryUrl = new URL((await recoveryRequest).url());
  expect(recoveryUrl.searchParams.get("commandType")).toBe("RECORD_COLLECTION");
  expect(recoveryUrl.searchParams.get("idempotencyKey")).toBe(originalConfirmationKey);
  const receipt = await assertOperatorReceipt(page);
  await expect(receipt).toContainText(transactionReference);
  await expect(receipt.locator("code").filter({ hasText: /^command_/ })).toHaveCount(0);
  await closeReceipt(page);

  await expect(page.getByTestId("order-command-recovery")).toBeHidden();
  await expect(page.getByTestId("record-collection")).toBeEnabled();
  await expect(page.locator('.table-region[aria-label="收退款与冲销记录表格"]')
    .getByText(transactionReference, { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key) => key?.startsWith("qintopia.command-recovery.v1:")).length)).toBe(0);
  await assertNoA11yViolations(page);
});

test("desktop quote workbench only offers recovery after a real response interruption", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only interrupted quote response");
  await login(page);

  await page.route("**/api/v1/quotes", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });

  await chooseDatesAndUnit(page, "101", "2026-10-15", "2026-10-13", "FREE");
  const recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价结果尚未确认", { timeout: 15_000 });
  await expect(recovery).not.toContainText(/web-create-quote-|Quote|幂等/);
  await expect(recovery.getByRole("button", { name: "重新查询报价结果" })).toBeVisible();

  const recoveryRequest = page.waitForRequest((request) => request.method() === "GET"
    && new URL(request.url()).pathname === "/api/v1/command-results");
  await recovery.getByRole("button", { name: "重新查询报价结果" }).click();
  await recoveryRequest;
  await expect(recovery).toBeHidden();
  await expect(page.getByTestId("request-quote")).toHaveCount(0);
  await expect(page.getByText(/当前筛选条件已变化/)).toBeHidden();
  await expect(page.getByTestId("quote-result")).toBeVisible();
});

test("desktop Token lifecycle retains client secrets and uses Preview Confirm Receipt", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token lifecycle");
  await login(page);
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();

  await page.getByRole("button", { name: "签发 Token" }).click();
  await page.getByLabel("标签").fill("E2E external agent");
  await page.getByLabel("权限上限").selectOption("WRITE");
  const issueSecret = await page.getByLabel("一次性 Token secret").inputValue();
  expect(issueSecret).toMatch(/^qtp_[A-Za-z0-9_-]{43}$/);
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  const retainedIssueSecret = page.getByRole("region", { name: /尚未清除的一次性 secret/ });
  const issuePreviewIdempotencyKeys: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/command-previews") && request.method() === "POST") {
      issuePreviewIdempotencyKeys.push(request.headers()["idempotency-key"] ?? "");
    }
  });
  await page.route("**/api/v1/command-previews", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("create-command-preview").click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retainedIssueSecret).toContainText("PREVIEW UNKNOWN");
  await expect(retainedIssueSecret.getByRole("button", { name: "清除本地 secret" })).toBeDisabled();
  await retainedIssueSecret.getByRole("button", { name: "重试 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).not.toContainText(issueSecret);
  const previewId = (await retainedIssueSecret.locator(".retained-secret-meta dd code").filter({ hasText: /^preview_/ }).textContent())?.trim();
  expect(previewId).toMatch(/^preview_/);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retainedIssueSecret).toContainText("PREVIEWED");
  await expect(retainedIssueSecret.getByLabel("一次性 Token secret")).toHaveValue(issueSecret);
  await expect(retainedIssueSecret.getByRole("button", { name: "清除本地 secret" })).toBeDisabled();
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await retainedIssueSecret.getByRole("button", { name: "重试 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(retainedIssueSecret.locator(".retained-secret-meta dd code").filter({ hasText: /^preview_/ })).toHaveText(previewId!);
  expect(issuePreviewIdempotencyKeys.slice(0, 3)).toEqual([
    issuePreviewIdempotencyKeys[0],
    issuePreviewIdempotencyKeys[0],
    issuePreviewIdempotencyKeys[0]
  ]);
  await page.getByTestId("reason-note").fill("Issue a scoped external client credential");
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retainedIssueSecret.getByLabel("一次性 Token secret")).toHaveValue(issueSecret);
  await expect(retainedIssueSecret).toContainText("UNKNOWN");
  await expect(retainedIssueSecret.getByRole("button", { name: "清除本地 secret" })).toBeDisabled();
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await expect(retainedIssueSecret.getByLabel("一次性 Token secret")).toHaveValue(issueSecret);
  await retainedIssueSecret.getByRole("button", { name: "恢复命令结果" }).click();
  await page.getByRole("button", { name: "查询命令结果" }).click();
  await assertOperatorReceipt(page);
  await closeReceipt(page);
  await expect(retainedIssueSecret).toContainText("EXECUTED");

  let activeRow = page.getByRole("row").filter({ hasText: "E2E external agent" }).filter({ hasText: "ACTIVE" });
  await expect(activeRow).toHaveCount(1);
  const originalTokenId = (await activeRow.locator("code").first().textContent())?.trim();
  expect(originalTokenId).toMatch(/^token_/);
  await retainedIssueSecret.getByRole("button", { name: "清除本地 secret" }).click();

  await activeRow.getByRole("button", { name: "轮换", exact: true }).click();
  const rotationSecret = await page.getByLabel("一次性 Token secret").inputValue();
  expect(rotationSecret).toMatch(/^qtp_[A-Za-z0-9_-]{43}$/);
  expect(rotationSecret).not.toBe(issueSecret);
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).not.toContainText(rotationSecret);
  await page.getByTestId("reason-note").fill("Rotate the external client credential");
  await page.getByTestId("confirm-command").click();
  await assertOperatorReceipt(page);
  await closeReceipt(page);

  const originalRow = page.getByRole("row").filter({ has: page.locator("th code", { hasText: originalTokenId! }) });
  await expect(originalRow).toContainText("ROTATED");
  activeRow = page.getByRole("row").filter({ hasText: "E2E external agent" }).filter({ hasText: "ACTIVE" });
  await expect(activeRow).toHaveCount(1);
  const replacementTokenId = (await activeRow.locator("code").first().textContent())?.trim();
  expect(replacementTokenId).toMatch(/^token_/);
  expect(replacementTokenId).not.toBe(originalTokenId);
  await expect(originalRow).toContainText(replacementTokenId!);
  await page.getByRole("region", { name: /尚未清除的一次性 secret/ }).getByRole("button", { name: "清除本地 secret" }).click();

  await activeRow.getByRole("button", { name: `撤销 Token ${replacementTokenId}` }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill("Revoke the rotated external client credential");
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const pendingRevoke = page.getByRole("region", { name: "待处理 Token 命令" });
  await expect(pendingRevoke).toContainText("UNKNOWN");
  await pendingRevoke.getByRole("button", { name: "恢复命令结果" }).click();
  await page.getByRole("button", { name: "查询命令结果" }).click();
  await assertOperatorReceipt(page);
  await closeReceipt(page);
  await expect(page.getByRole("row").filter({ has: page.locator("th code", { hasText: replacementTokenId! }) })).toContainText("REVOKED");
  await assertNoA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("token-lifecycle.png"), fullPage: true });
});

test("desktop expired Token Preview rotates preview metadata without changing the retained secret", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token Preview expiry recovery");
  await page.clock.install();
  await login(page);
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await page.getByRole("button", { name: "签发 Token" }).click();
  await page.getByLabel("标签").fill("E2E expired preview agent");
  const secret = await page.getByLabel("一次性 Token secret").inputValue();
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();

  const previewKeys: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/command-previews") {
      previewKeys.push(request.headers()["idempotency-key"] ?? "");
    }
  });
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.clock.fastForward(601_000);
  await expect(page.getByTestId("regenerate-command-preview")).toBeVisible();

  await page.clock.setSystemTime(Date.now());
  await page.getByTestId("regenerate-command-preview").click();
  await expect.poll(() => previewKeys.length).toBe(2);
  expect(previewKeys[0]).toMatch(/^web-preview-issue_token-/);
  expect(previewKeys[1]).toMatch(/^web-preview-issue_token-/);
  expect(previewKeys[1]).not.toBe(previewKeys[0]);
  await expect(page.getByRole("region", { name: /尚未清除的一次性 secret/ }).getByLabel("一次性 Token secret")).toHaveValue(secret);
  await expect(page.getByTestId("confirm-command")).toBeVisible();
});

test("desktop Token lifecycle ignores deferred callbacks from unmounted command attempts", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Token callback ordering");
  let tokenListRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/tokens") tokenListRequests += 1;
  });

  await login(page);
  await page.getByRole("link", { name: "Token", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();

  await page.getByRole("button", { name: "签发 Token" }).click();
  await page.getByLabel("标签").fill("E2E deferred callback agent");
  await page.getByLabel(/我已将一次性 secret 安全保存/).check();
  await page.getByRole("button", { name: "继续生成 Preview" }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill("Issue while the original Confirm response is deferred");

  const delayedIssue = await deferNextConfirmResponse(page);
  await page.getByTestId("confirm-command").click();
  await delayedIssue.fetched;
  await forceNavigateAwayAndBackToTokens(page);

  const retained = page.getByRole("region", { name: /尚未清除的一次性 secret/ });
  await expect(retained).toContainText("CONFIRMING");
  await retained.getByRole("button", { name: "恢复命令结果" }).click();
  const issueRequestBaseline = tokenListRequests;
  const issueRecoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  const issueRefresh = page.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/tokens"
  ));
  await page.getByRole("button", { name: "查询命令结果" }).click();
  expect(new URL((await issueRecoveryRequest).url()).searchParams.get("idempotencyKey")).toBe(delayedIssue.confirmationKey());
  await assertOperatorReceipt(page);
  await issueRefresh;
  expect(tokenListRequests).toBe(issueRequestBaseline + 1);
  await closeReceipt(page);
  await expect(retained).toContainText("EXECUTED");

  const tokenRows = page.getByRole("row").filter({ hasText: "E2E deferred callback agent" });
  await expect(tokenRows).toHaveCount(1);
  await expect(tokenRows).toContainText("ACTIVE");
  const issuedTokenId = (await tokenRows.locator("th code").textContent())?.trim();
  expect(issuedTokenId).toMatch(/^token_/);

  const requestsBeforeOldIssueResponse = tokenListRequests;
  await releaseConfirmAndFlushOldCallback(page, delayedIssue);
  await expect(retained).toContainText("EXECUTED");
  await expect(tokenRows).toHaveCount(1);
  expect(tokenListRequests).toBe(requestsBeforeOldIssueResponse);

  await retained.getByRole("button", { name: "清除本地 secret" }).click();
  await tokenRows.getByRole("button", { name: `撤销 Token ${issuedTokenId}` }).click();
  await page.getByTestId("create-command-preview").click();
  await expect(page.getByTestId("command-effect")).toBeVisible();
  await page.getByTestId("reason-note").fill("Revoke while the original Confirm response is deferred");

  const delayedRevoke = await deferNextConfirmResponse(page, "SERVER_ERROR");
  await page.getByTestId("confirm-command").click();
  await delayedRevoke.fetched;
  await forceNavigateAwayAndBackToTokens(page);

  const pending = page.getByRole("region", { name: "待处理 Token 命令" });
  await expect(pending).toContainText("CONFIRMING");
  await pending.getByRole("button", { name: "恢复命令结果" }).click();
  const revokeRequestBaseline = tokenListRequests;
  const revokeRecoveryRequest = page.waitForRequest((request) => (
    request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/command-results"
  ));
  const revokeRefresh = page.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/tokens"
  ));
  await page.getByRole("button", { name: "查询命令结果" }).click();
  expect(new URL((await revokeRecoveryRequest).url()).searchParams.get("idempotencyKey")).toBe(delayedRevoke.confirmationKey());
  await assertOperatorReceipt(page);
  await revokeRefresh;
  expect(tokenListRequests).toBe(revokeRequestBaseline + 1);
  await closeReceipt(page);
  await expect(pending).toContainText("EXECUTED");
  await expect(tokenRows).toHaveCount(1);
  await expect(tokenRows).toContainText("REVOKED");

  const requestsBeforeOldRevokeResponse = tokenListRequests;
  await releaseConfirmAndFlushOldCallback(page, delayedRevoke);
  await expect(pending).toContainText("EXECUTED");
  await expect(tokenRows).toHaveCount(1);
  await expect(tokenRows).toContainText("REVOKED");
  expect(tokenListRequests).toBe(requestsBeforeOldRevokeResponse);
});

test("keyboard-only navigation reaches a business Preview and cancels without confirmation", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard assertion");
  await page.goto("/");
  await expect(page.getByTestId("login-username")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-password")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("login-submit")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();

  const ordersLink = page.getByRole("link", { name: "订单", exact: true });
  await tabTo(page, ordersLink);
  await expect(ordersLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "订单", exact: true })).toBeVisible();

  const inventoryLink = page.getByRole("link", { name: "房态", exact: true });
  await tabTo(page, inventoryLink, { reverse: true });
  await expect(inventoryLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();

  const firstCell = page.getByRole("gridcell").first();
  await tabTo(page, firstCell);
  const availableCell = page.getByRole("gridcell", { name: /可售，可以安排/ }).first();
  await expect(availableCell).toBeVisible({ timeout: 5_000 });
  const currentPosition = await firstCell.evaluate((element) => ({
    row: Number(element.getAttribute("aria-rowindex")),
    column: Number(element.getAttribute("aria-colindex"))
  }));
  const targetPosition = await availableCell.evaluate((element) => ({
    row: Number(element.getAttribute("aria-rowindex")),
    column: Number(element.getAttribute("aria-colindex"))
  }));
  const rowKey = targetPosition.row >= currentPosition.row ? "ArrowDown" : "ArrowUp";
  const columnKey = targetPosition.column >= currentPosition.column ? "ArrowRight" : "ArrowLeft";
  for (let index = 0; index < Math.abs(targetPosition.row - currentPosition.row); index += 1) await page.keyboard.press(rowKey);
  for (let index = 0; index < Math.abs(targetPosition.column - currentPosition.column); index += 1) await page.keyboard.press(columnKey);
  await expect(availableCell).toBeFocused();
  await page.keyboard.press("Space");
  const maintenanceButton = page.getByTestId("room-status-quick-popover")
    .getByRole("button", { name: "维修锁房", exact: true });
  await tabTo(page, maintenanceButton, { limit: 120 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^维修锁房 ·/ })).toBeVisible();
  const maintenanceReason = page.getByLabel("维修原因");
  await tabTo(page, maintenanceReason);
  await page.keyboard.type("Keyboard-only maintenance preview");
  const continueButton = page.getByRole("button", { name: "继续核对" });
  await tabTo(page, continueButton);
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("command-effect")).toBeVisible({ timeout: 15_000 });
  await assertNoA11yViolations(page);
  const cancelPreview = page.getByRole("button", { name: "返回修改", exact: true });
  await tabTo(page, cancelPreview);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-effect")).toBeHidden();
});

test("responsive shell and 200 percent zoom stay contiguous without page overflow", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single-browser responsive assertion");
  await login(page);

  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "今日履约" })).toBeVisible();
    await assertNoPageOverflow(page);
    await assertShellDoesNotOverlap(page, width);

    await page.goto("/tokens");
    await expect(page.getByRole("heading", { name: "Token 生命周期" })).toBeVisible();
    await assertNoPageOverflow(page);
    await assertShellDoesNotOverlap(page, width);
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
  await page.goto("/today");
  expect(await page.evaluate(() => ({ width: window.innerWidth, pixelRatio: window.devicePixelRatio }))).toEqual({ width: 720, pixelRatio: 2 });
  await assertNoPageOverflow(page);
  await assertShellDoesNotOverlap(page, 720);
  await assertNoA11yViolations(page);
});

test("property timezone controls default operating dates across local midnight", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single-browser timezone assertion");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
  await page.clock.install({ time: new Date("2026-07-20T16:30:00.000Z") });
  await login(page);

  const browserLocalDate = await page.evaluate(() => {
    const values = new Map(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  });
  expect(browserLocalDate).toBe("2026-07-20");
  await expect(page.getByTestId("arrival-date")).toHaveValue("2026-07-21");
  await expect(page.getByTestId("departure-date")).toHaveValue("2026-08-11");

  await page.getByRole("link", { name: "移动履约" }).click();
  await expect(page.getByLabel("营业日期")).toHaveValue("2026-07-21");
});

test("maintenance lock can be listed and released", async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop maintenance journey");
  await login(page);
  const unitId = await selectRoomStatusRange(page, "102", "2026-08-11", "2026-08-10");
  await page.getByRole("button", { name: "放置维修锁房", exact: true }).click();
  await page.getByLabel("维修原因").fill("E2E air conditioner service");
  await page.getByRole("button", { name: "继续核对" }).click();
  await confirmU1Command(page, ["E2E air conditioner service"]);

  const roomRow = page.locator(`[data-room-status-row="${unitId}"]`);
  const maintenanceInterval = roomRow.getByRole("button", { name: /维修\/锁房，/ }).first();
  await expect(maintenanceInterval).toBeVisible();
  await maintenanceInterval.click();
  const maintenancePopover = page.getByTestId("room-status-quick-popover");
  await expect(maintenancePopover).toBeVisible();
  await maintenancePopover.getByRole("button", { name: "查看房态记录", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  const sourceSection = page.locator("section.room-status-context-section").filter({
    has: page.getByRole("heading", { name: "住宿或锁房记录", exact: true })
  });
  await expect(sourceSection).toContainText("E2E air conditioner service");
  await page.getByRole("button", { name: "释放维修锁房", exact: true }).click();
  const releaseSummary = page.getByTestId("command-effect");
  await expect(releaseSummary).toContainText("目标房源");
  await expect(releaseSummary).toContainText("释放维修锁 · 102");
  await confirmU1Command(page, ["完整释放这条维修锁房"]);

  await selectRoomStatusRange(page, "102", "2026-08-11", "2026-08-10");
  await expect(page.getByRole("button", { name: "创建正常住宿订单", exact: true })).toBeEnabled();
  await assertNoA11yViolations(page);
});
