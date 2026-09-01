import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";

type Channel = "YOUMUDAO" | "CTRIP" | "MEITUAN" | "WECOM";

interface OrderDraft {
  policyBaseMinor: number;
  targetInput: Locator;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayInPropertyTimeZone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function money(minorUnits: number): string {
  return `¥${(minorUnits / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function requestPath(request: Request): string {
  return new URL(request.url()).pathname;
}

function roomCell(page: Page, unitId: string, serviceDate: string): Locator {
  return page.locator(`.room-status-day-available[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`);
}

async function expectRoomStatusLanding(page: Page): Promise<void> {
  const mobile = (page.viewportSize()?.width ?? 0) < 576;
  await expect(page.getByRole("heading", {
    name: mobile ? "今日运营任务" : "房间与床位逐日房态",
    level: mobile ? 1 : 2
  })).toBeVisible({ timeout: 30_000 });
}

async function clickRoomStatusCell(page: Page, cell: Locator, unitId: string): Promise<void> {
  await cell.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await cell.click();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", unitId);
}

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-submit").click();
  await expectRoomStatusLanding(page);
}

async function openPaidOrderDraft(page: Page, options: {
  unitCode: "D03" | "D04" | "D05";
  arrivalDate: string;
  guest: string;
}): Promise<OrderDraft> {
  await page.goto("/");
  await expectRoomStatusLanding(page);
  const departureDate = addDays(options.arrivalDate, 1);
  const boardDepartureDate = addDays(options.arrivalDate, 30);
  const mobile = (page.viewportSize()?.width ?? 0) < 576;
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  if (!mobile) {
    const rangeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname.endsWith("/room-status")
        && url.searchParams.get("arrivalDate") === options.arrivalDate
        && url.searchParams.get("departureDate") === boardDepartureDate
        && response.ok();
    });
    await page.getByTestId("arrival-date").fill(options.arrivalDate);
    await rangeResponse;
    await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("room-status-board-range")).toHaveAttribute("data-range-arrival", options.arrivalDate);
    await expect(page.getByTestId("room-status-board-range")).toHaveAttribute("data-range-departure", boardDepartureDate);
    const restoredContext = page.locator("dialog.room-status-view-drawer");
    if (await restoredContext.isVisible()) {
      await restoredContext.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
      await expect(restoredContext).toBeHidden();
    }
    const refreshed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname.endsWith("/room-status")
        && url.searchParams.get("arrivalDate") === options.arrivalDate
        && url.searchParams.get("departureDate") === boardDepartureDate
        && response.ok();
    });
    await page.getByRole("button", { name: "刷新房态", exact: true }).click();
    await refreshed;
    await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  }

  const unitId = `unit_room_${options.unitCode[0]!.toLowerCase()}_gen_${options.unitCode.slice(1)}`;
  const quoteResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/v1/quotes"
      && response.ok()
  );
  if (mobile) {
    await page.getByRole("button", { name: "新建住宿或锁房", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "新建住宿或锁房", exact: true });
    await expect(createDialog).toBeVisible();
    await createDialog.getByTestId("room-status-unit-select").selectOption(unitId);
    await createDialog.getByLabel("入住日期", { exact: true }).fill(options.arrivalDate);
    await createDialog.getByLabel("退房日期", { exact: true }).fill(departureDate);
    await createDialog.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  } else {
    const cell = roomCell(page, unitId, options.arrivalDate);
    await expect(cell).toBeVisible();
    await clickRoomStatusCell(page, cell, unitId);
    const popover = page.getByTestId("room-status-quick-popover");
    await popover.getByRole("button", { name: "创建订单", exact: true }).click();

    const writeDrawer = page.locator("dialog.room-status-write-drawer");
    await expect(writeDrawer).toBeVisible();
    await expect(writeDrawer.getByLabel("入住日期", { exact: true })).toHaveValue(options.arrivalDate);
    await expect(writeDrawer.getByLabel("退房日期", { exact: true })).toHaveValue(departureDate);
  }
  const quote = (await (await quoteResponse).json()).quote as {
    currentContractAmount: { minorUnits: number };
  };
  await expect(page.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("primary-guest-name").fill(options.guest);
  await page.getByTestId("primary-guest-nickname").fill(options.guest);

  return {
    policyBaseMinor: quote.currentContractAmount.minorUnits,
    targetInput: page.getByTestId("target-contract-amount")
  };
}

async function selectChannel(page: Page, channel: Channel) {
  await page.getByTestId("booking-channel-code").selectOption(channel);
  await expect(page.getByTestId("target-contract-amount")).toBeVisible();
}

async function createOrderAndOpenDetail(page: Page, options: {
  expectedPolicyBaseMinor: number;
  expectedTargetMinor: number;
  expectedChannel: Channel;
  expectedReference: string | null;
  expectedReason?: string;
}) {
  const previewRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && requestPath(request) === "/api/v1/command-previews"
  );
  const previewResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && requestPath(response.request()) === "/api/v1/command-previews",
    { timeout: 60_000 }
  );
  await page.getByTestId("create-order").click();
  const previewRequest = await previewRequestPromise;
  const previewBody = previewRequest.postDataJSON() as {
    commandType: string;
    input: Record<string, unknown>;
  };
  expect(previewBody.commandType).toBe("CREATE_ORDER");
  expect(previewBody.input).toMatchObject({
    bookingChannelCode: options.expectedChannel,
    channelOrderReference: options.expectedReference,
    targetCurrentContractAmountMinor: options.expectedTargetMinor
  });
  if (options.expectedReason) {
    const reasonField = options.expectedChannel === "WECOM"
      ? "manualPriceAdjustmentReason"
      : "channelPriceDifferenceReason";
    expect(previewBody.input[reasonField]).toBe(options.expectedReason);
  } else {
    expect(previewBody.input).not.toHaveProperty("channelPriceDifferenceReason");
    expect(previewBody.input).not.toHaveProperty("manualPriceAdjustmentReason");
  }

  const previewResponse = await previewResponsePromise;
  expect(previewResponse.ok()).toBe(true);
  await expect(page.getByTestId("command-effect")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("preview-policy-base-amount")).toHaveText(money(options.expectedPolicyBaseMinor));
  await expect(page.getByTestId("preview-target-contract-amount")).toHaveText(money(options.expectedTargetMinor));
  if (options.expectedReason) await expect(page.getByTestId("command-effect")).toContainText(options.expectedReason);
  await expect(page.getByTestId("reason-code")).toHaveCount(0);
  await expect(page.getByTestId("reason-note")).toHaveCount(0);

  const confirmationResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(requestPath(response.request()))
      && response.status() === 200
  );
  await page.getByTestId("confirm-command").click();
  const confirmationResponse = await confirmationResponsePromise;
  const confirmationBody = confirmationResponse.request().postDataJSON() as {
    reason: { code: string; note: string };
  };
  expect(confirmationBody.reason).toEqual({ code: "CREATE_STANDARD_ORDER", note: "" });
  const receipt = await confirmationResponse.json() as { result?: { orderId?: string } };
  expect(receipt.result?.orderId).toMatch(/^order_/);
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await page.goto(`/orders/${encodeURIComponent(receipt.result!.orderId!)}`);
  await expect(page).toHaveURL(/\/orders\/order_[^/?#]+$/, { timeout: 15_000 });
  const stay = page.getByRole("region", { name: "住宿状态", exact: true });
  await expect(stay).toBeVisible({ timeout: 15_000 });
  await expect(stay).toContainText(options.expectedChannel === "WECOM" ? "企业微信" : { YOUMUDAO: "游牧岛", CTRIP: "携程", MEITUAN: "美团" }[options.expectedChannel]);
  await expect(stay).toContainText(options.expectedReference ?? "不适用");
  const revision = page.locator('.table-region[aria-label="计价记录表格"]');
  await expect(revision.locator("tbody tr")).toHaveCount(1);
  await expect(revision).toContainText(money(options.expectedPolicyBaseMinor));
  await expect(revision).toContainText(money(options.expectedTargetMinor));
  await expect(revision).toContainText(options.expectedChannel === "WECOM" && options.expectedTargetMinor !== options.expectedPolicyBaseMinor
    ? "人工调价"
    : options.expectedChannel === "WECOM" ? "政策价" : "本单渠道应结金额");
  await expect(revision).toContainText(options.expectedReason ?? "无需说明");
}

function scenarioDate(testInfo: TestInfo, scenarioOffset: number): string {
  const projectOffset = testInfo.project.name === "mobile" ? 70 : 40;
  return addDays(todayInPropertyTimeZone(), projectOffset + scenarioOffset);
}

test.describe("第 4 步阶段 2 / 渠道订单原子计价", () => {
  test("外部渠道订单号和金额必填，正好 15% 无需说明且首条计价可追溯", async ({ page }, testInfo) => {
    await login(page);
    const draft = await openPaidOrderDraft(page, {
      unitCode: "D03",
      arrivalDate: scenarioDate(testInfo, 0),
      guest: `${testInfo.project.name}-15边界`
    });
    await selectChannel(page, "YOUMUDAO");
    const reference = `E2E-${testInfo.project.name}-YOUMUDAO-15`;
    const targetMinor = draft.policyBaseMinor * 115 / 100;
    expect(Number.isInteger(targetMinor / 100)).toBe(true);

    await expect(page.getByTestId("channel-order-reference")).toHaveAttribute("required", "");
    await expect(draft.targetInput).toHaveAttribute("required", "");
    await expect(page.getByTestId("create-order")).toBeDisabled();
    await draft.targetInput.fill(String(targetMinor / 100));
    await expect(page.getByTestId("create-order")).toBeDisabled();
    await page.getByTestId("channel-order-reference").fill(reference);
    await expect(page.getByTestId("channel-price-difference-reason")).toHaveCount(0);
    await expect(page.getByTestId("create-order")).toBeEnabled();

    await createOrderAndOpenDetail(page, {
      expectedPolicyBaseMinor: draft.policyBaseMinor,
      expectedTargetMinor: targetMinor,
      expectedChannel: "YOUMUDAO",
      expectedReference: reference
    });
  });

  test("超过 15% 的渠道高价和低价都必须填写渠道价格差异说明", async ({ page }, testInfo) => {
    await login(page);
    for (const [index, direction] of (["HIGH", "LOW"] as const).entries()) {
      const draft = await openPaidOrderDraft(page, {
        unitCode: "D04",
        arrivalDate: scenarioDate(testInfo, 4 + index * 2),
        guest: `${testInfo.project.name}-超15-${direction}`
      });
      await selectChannel(page, direction === "HIGH" ? "CTRIP" : "MEITUAN");
      const boundaryMinor = direction === "HIGH"
        ? draft.policyBaseMinor * 1.15
        : draft.policyBaseMinor * 0.85;
      const targetMinor = direction === "HIGH"
        ? Math.floor(boundaryMinor / 100) * 100 + 100
        : Math.ceil(boundaryMinor / 100) * 100 - 100;
      const targetYuan = targetMinor / 100;
      const reference = `E2E-${testInfo.project.name}-${direction}`;
      const reason = direction === "HIGH" ? "渠道节假日加价" : "渠道专项促销价";
      await page.getByTestId("channel-order-reference").fill(reference);
      await draft.targetInput.fill(String(targetYuan));
      const reasonInput = page.getByTestId("channel-price-difference-reason");
      await expect(reasonInput).toBeVisible();
      await expect(page.getByTestId("create-order")).toBeDisabled();
      await reasonInput.fill(reason);
      await expect(page.getByTestId("create-order")).toBeEnabled();

      await createOrderAndOpenDetail(page, {
        expectedPolicyBaseMinor: draft.policyBaseMinor,
        expectedTargetMinor: targetMinor,
        expectedChannel: direction === "HIGH" ? "CTRIP" : "MEITUAN",
        expectedReference: reference,
        expectedReason: reason
      });
    }
  });

  test("企微默认政策价，主动偏价才要求人工调价原因", async ({ page }, testInfo) => {
    await login(page);
    const policyDraft = await openPaidOrderDraft(page, {
      unitCode: "D05",
      arrivalDate: scenarioDate(testInfo, 10),
      guest: `${testInfo.project.name}-企微政策价`
    });
    await selectChannel(page, "WECOM");
    await expect(page.getByTestId("channel-order-reference")).toHaveCount(0);
    await expect(policyDraft.targetInput).toHaveValue(String(policyDraft.policyBaseMinor / 100));
    await expect(page.getByTestId("manual-price-adjustment-reason")).toHaveCount(0);
    await expect(page.getByTestId("create-order")).toBeEnabled();
    await createOrderAndOpenDetail(page, {
      expectedPolicyBaseMinor: policyDraft.policyBaseMinor,
      expectedTargetMinor: policyDraft.policyBaseMinor,
      expectedChannel: "WECOM",
      expectedReference: null
    });

    const adjustedDraft = await openPaidOrderDraft(page, {
      unitCode: "D05",
      arrivalDate: scenarioDate(testInfo, 12),
      guest: `${testInfo.project.name}-企微主动偏价`
    });
    await selectChannel(page, "WECOM");
    const targetMinor = adjustedDraft.policyBaseMinor - 100;
    await adjustedDraft.targetInput.fill(String(targetMinor / 100));
    const reasonInput = page.getByTestId("manual-price-adjustment-reason");
    await expect(reasonInput).toBeVisible();
    await expect(page.getByTestId("channel-price-difference-reason")).toHaveCount(0);
    await expect(page.getByTestId("create-order")).toBeDisabled();
    const reason = "企微线下协商优惠";
    await reasonInput.fill(reason);
    await expect(page.getByTestId("create-order")).toBeEnabled();
    await createOrderAndOpenDetail(page, {
      expectedPolicyBaseMinor: adjustedDraft.policyBaseMinor,
      expectedTargetMinor: targetMinor,
      expectedChannel: "WECOM",
      expectedReference: null,
      expectedReason: reason
    });
  });
});
