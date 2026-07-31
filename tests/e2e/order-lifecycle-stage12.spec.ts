import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  prepareStage12Acceptance,
  type Stage12AcceptanceFixture,
  type Stage12StayFixture
} from "./setup-stage12-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const forbiddenOperatorText = /Preview|Confirm|Receipt|Command|CANCEL_ORDER|MARK_NO_SHOW|REVOKE_CHECK_IN|CHECK_IN_REVOKED|(?:order|stay|segment|amendment|revision|claim|coverage|fact)_[a-z0-9_-]+|raw payload/i;
let fixture: Stage12AcceptanceFixture;

test.describe.configure({ mode: "serial" });

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile";
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(fixture.operator.username);
  await page.getByTestId("login-password").fill(fixture.operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible({ timeout: 30_000 });
}

async function openOrder(page: Page, stay: Stage12StayFixture): Promise<void> {
  await page.goto(`/orders/${encodeURIComponent(stay.orderId)}`);
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".order-unit")).toContainText(stay.unitCode);
  await expect(page.locator("body")).not.toContainText(forbiddenOperatorText);
}

async function openLifecycleDrawer(
  page: Page,
  action: "取消订单" | "标记未到" | "撤销入住",
  stay: Stage12StayFixture
): Promise<Locator> {
  await page.getByRole("button", { name: action, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: action, exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("region", { name: "本次操作对象" })).toContainText(stay.nickname);
  await expect(drawer.getByRole("region", { name: "本次操作对象" })).toContainText(stay.unitCode);
  await expect(drawer).not.toContainText(forbiddenOperatorText);
  return drawer;
}

async function continueLifecycleReview(
  page: Page,
  drawer: Locator,
  action: "取消订单" | "标记未到" | "撤销入住",
  reason: string,
  options: { confirmUnusedRoom?: boolean } = {}
): Promise<Locator> {
  const reasonInput = drawer.getByTestId("lifecycle-reason");
  await expect(reasonInput).toHaveValue("");
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(reasonInput).toHaveAttribute("required", "");
  await reasonInput.fill(reason);
  if (options.confirmUnusedRoom) await drawer.getByTestId("unused-room-confirmed").check();
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const review = page.getByRole("dialog", { name: action, exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByTestId("command-review-heading")).toHaveText(`请核对${action}`);
  await expect(review).toContainText(reason);
  await expect(review).not.toContainText(forbiddenOperatorText);
  return review;
}

async function confirmLifecycle(page: Page, review: Locator, action: "取消订单" | "标记未到" | "撤销入住"): Promise<void> {
  await review.getByRole("button", { name: `确认${action}`, exact: true }).click();
  const recovery = review.getByRole("button", { name: "查询原操作结果", exact: true });
  const needsRecovery = await Promise.race([
    recovery.waitFor({ state: "visible", timeout: 10_000 }).then(() => true),
    review.waitFor({ state: "hidden", timeout: 10_000 }).then(() => false)
  ]);
  if (needsRecovery) {
    await expect(review).toContainText(`${action}结果需要查询`);
    await recovery.click();
  }
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("command-result-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("command-result-notice")).not.toContainText(forbiddenOperatorText);
  await expect(page.getByText("正在载入订单详情", { exact: true })).toBeHidden({ timeout: 30_000 });
}

async function orderView(page: Page, stay: Stage12StayFixture) {
  const response = await page.request.get(`/api/v1/orders/${encodeURIComponent(stay.orderId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{
    order: { status: string; current_revision_id: string };
    stay: { status: string };
    allowedActions: Array<{ code: string; enabled: boolean; disabledReason: string | null }>;
    pricingRevisions: Array<{
      id: string;
      revision_no: number;
      current_contract_amount_minor: number;
      policy_base_amount_minor: number;
    }>;
    coverageSet: Array<{ id: string; status: string }>;
    collectionFacts: Array<{ fact_type: string; amount_minor: number; net_effect_minor: number }>;
    amounts: {
      currentContractAmount: { minorUnits: number };
      netRecordedCollection: { minorUnits: number };
      refundReferenceAmount: { minorUnits: number };
    };
    fulfillment: {
      state: string;
      checkIn: null | { recordingMode: string; plannedBusinessDate: string; recordedBusinessDate: string };
      checkInRevocation: null | { recordingMode: string; plannedBusinessDate: string; recordedBusinessDate: string };
    };
  }>;
}

async function expectUnitAvailable(page: Page, stay: Stage12StayFixture, serviceDate: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "房态与可售", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("arrival-date").fill(serviceDate);
  await page.getByTestId("departure-date").fill(stay.departureDate);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.unitId}"][data-service-date="${serviceDate}"]`);
  await expect(cell).toBeVisible();
  await expect(cell).toHaveClass(/room-status-day-available/);
  await expect(cell).not.toContainText(stay.nickname);
}

test.beforeAll(async ({}, workerInfo) => {
  fixture = await prepareStage12Acceptance(e2eDatabaseUrl, {
    reset: true,
    suffix: `stage12-${workerInfo.project.name}-${workerInfo.workerIndex}`
  });
});

test("4.5 desktop cancellation keeps history, releases inventory and only shows a refund reference", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 12 cancellation coverage");
  await login(page);
  const stay = fixture.cancellation;
  await openOrder(page, stay);
  const before = await orderView(page, stay);
  expect(before.pricingRevisions).toHaveLength(1);
  const drawer = await openLifecycleDrawer(page, "取消订单", stay);
  await expect(drawer).toContainText("已登记收款仅生成退款参考，不会自动退款");
  const reason = "住客明确取消本次住宿并确认不再到店";
  const review = await continueLifecycleReview(page, drawer, "取消订单", reason);
  await expect(review).toContainText("已预订");
  await expect(review).toContainText("已取消");
  await expect(review).toContainText("当前及后续住宿库存立即恢复可售");
  await expect(review).toContainText("处理后订单金额");
  await expect(review).toContainText("¥0.00");
  await expect(review).toContainText("退款参考");
  await expect(review).toContainText("尚未登记退款");
  await expect(review).toContainText("本次操作不会自动退款");
  await confirmLifecycle(page, review, "取消订单");
  await expect(page.getByTestId("command-result-notice")).toContainText("订单已取消，订单和房态已刷新");
  await expect(page.locator(".order-title-row").getByText("已取消", { exact: true })).toBeVisible();

  const after = await orderView(page, stay);
  expect(after.order.status).toBe("CANCELLED");
  expect(after.stay.status).toBe("CANCELLED");
  expect(after.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(after.amounts.netRecordedCollection.minorUnits).toBe(stay.recordedCollectionMinor);
  expect(after.amounts.refundReferenceAmount.minorUnits).toBe(stay.recordedCollectionMinor);
  expect(after.pricingRevisions).toHaveLength(2);
  expect(after.pricingRevisions[0]?.current_contract_amount_minor).toBe(stay.originalContractMinor);
  expect(after.pricingRevisions.at(-1)?.current_contract_amount_minor).toBe(0);
  expect(after.order.current_revision_id).toBe(after.pricingRevisions.at(-1)?.id);
  expect(after.collectionFacts.some((fact) => fact.fact_type === "REFUND")).toBe(false);
  await expectUnitAvailable(page, stay, stay.arrivalDate);
});

test("4.5 desktop member and free cancellations keep their original facts and end at zero", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 12 member/free cancellation coverage");
  await login(page);

  const member = fixture.memberCancellation;
  const memberBefore = await orderView(page, member);
  expect(memberBefore.coverageSet.length).toBeGreaterThan(0);
  expect(memberBefore.coverageSet.every((item) => item.status === "HELD")).toBe(true);
  await openOrder(page, member);
  const memberDrawer = await openLifecycleDrawer(page, "取消订单", member);
  const memberReview = await continueLifecycleReview(page, memberDrawer, "取消订单", "会员调整行程并确认取消本次住宿");
  await expect(memberReview).toContainText(`释放 ${memberBefore.coverageSet.length} 晚已冻结权益`);
  await confirmLifecycle(page, memberReview, "取消订单");
  const memberAfter = await orderView(page, member);
  expect(memberAfter.order.status).toBe("CANCELLED");
  expect(memberAfter.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(memberAfter.coverageSet.every((item) => item.status === "RELEASED")).toBe(true);
  expect(memberAfter.collectionFacts).toEqual(memberBefore.collectionFacts);

  const free = fixture.freeCancellation;
  await openOrder(page, free);
  const freeDrawer = await openLifecycleDrawer(page, "取消订单", free);
  const freeReview = await continueLifecycleReview(page, freeDrawer, "取消订单", "免费接待行程取消");
  await expect(freeReview).toContainText("本次不涉及会员权益");
  await confirmLifecycle(page, freeReview, "取消订单");
  const freeAfter = await orderView(page, free);
  expect(freeAfter.order.status).toBe("CANCELLED");
  expect(freeAfter.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(freeAfter.pricingRevisions.at(-1)?.current_contract_amount_minor).toBe(0);
  expect(freeAfter.collectionFacts).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText(forbiddenOperatorText);
});

test("4.5 no-show uses the 20:00 gate, is operator initiated and becomes terminal", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 12 no-show coverage");
  expect(fixture.noShowBoundary).toEqual({ rejectedAt1959: true, acceptedAt2000: true });
  await login(page);

  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "今日履约", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: /异常/ }).click();
  const row = page.locator(".queue-row").filter({ hasText: fixture.noShow.nickname });
  await expect(row).toBeVisible();
  await expect(row).toContainText("已预订");
  await expect(row).not.toContainText(fixture.noShow.orderId);
  await row.getByRole("link", { name: "处理逾期到店", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.noShow.nickname, exact: true })).toBeVisible({ timeout: 30_000 });

  const drawer = await openLifecycleDrawer(page, "标记未到", fixture.noShow);
  await expect(drawer.getByTestId("lifecycle-reason")).toHaveAttribute("placeholder", "请填写确认住客未到店的依据");
  const reason = "电话与企业微信均确认住客今日不再到店";
  const review = await continueLifecycleReview(page, drawer, "标记未到", reason);
  await expect(review).toContainText("已预订");
  await expect(review).toContainText("未到");
  await expect(review).toContainText("当前及后续住宿库存立即恢复可售");
  await expect(review).toContainText("退款参考");
  await expect(review).toContainText("目前尚未登记退款");
  await confirmLifecycle(page, review, "标记未到");
  await expect(page.getByTestId("command-result-notice")).toContainText("订单已标记未到，订单和房态已刷新");
  await expect(page.locator(".order-title-row").getByText("未到", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "入住", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "调整预订日期", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "标记未到", exact: true })).toHaveCount(0);

  const after = await orderView(page, fixture.noShow);
  expect(after.order.status).toBe("NO_SHOW");
  expect(after.stay.status).toBe("NO_SHOW");
  expect(after.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(after.amounts.refundReferenceAmount.minorUnits).toBe(fixture.noShow.recordedCollectionMinor);
  expect(after.pricingRevisions).toHaveLength(2);
  expect(after.collectionFacts.some((fact) => fact.fact_type === "REFUND")).toBe(false);
  expect(after.allowedActions.filter((action) => action.enabled).map((action) => action.code)).not.toContain("CHECK_IN");
  await expectUnitAvailable(page, fixture.noShow, fixture.businessDate);
});

test("4.5 overdue reserved order stays visible and can be checked in late without changing its dates", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 12 overdue reserved coverage");
  await login(page);
  const stay = fixture.overdueCheckIn;
  await page.goto("/today");
  await page.getByRole("tab", { name: /异常/ }).click();
  const row = page.locator(".queue-row").filter({ hasText: stay.nickname });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(stay.orderId);
  await row.getByRole("link", { name: "处理逾期到店", exact: true }).click();
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "入住", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "调整预订日期", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "标记未到", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "入住", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "办理入住", exact: true });
  await expect(dialog.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("迟录入住");
  await expect(dialog).toContainText(stay.arrivalDate);
  await expect(dialog).toContainText(fixture.businessDate);
  await expect(dialog).not.toContainText(forbiddenOperatorText);
  await dialog.getByTestId("reason-note").fill("工作人员补录住客实际到店入住");
  await dialog.getByRole("button", { name: "确认办理入住", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".order-title-row").getByText("在住", { exact: true })).toBeVisible();
  const result = page.getByTestId("check-in-result");
  await expect(result).toContainText("迟录入住");
  await expect(result).toContainText(stay.arrivalDate);
  await expect(result).toContainText(fixture.businessDate);

  const after = await orderView(page, stay);
  expect(after.order.status).toBe("CHECKED_IN");
  expect(after.fulfillment.checkIn).toMatchObject({
    recordingMode: "LATE_RECORDED",
    plannedBusinessDate: stay.arrivalDate,
    recordedBusinessDate: fixture.businessDate
  });
});

test("4.5 same-day revoke check-in requires both safeguards and keeps the original check-in record", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 12 revoke coverage");
  await login(page);
  const stay = fixture.revokeCheckIn;
  await openOrder(page, stay);
  const before = await orderView(page, stay);
  expect(before.fulfillment.checkIn).not.toBeNull();
  expect(before.fulfillment.checkInRevocation).toBeNull();
  const drawer = await openLifecycleDrawer(page, "撤销入住", stay);
  await expect(drawer).toContainText("仅适用于误办入住或住客看房后未入住");
  await drawer.getByTestId("lifecycle-reason").fill("工作人员误点入住，住客看房后确认未使用房间");
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  await expect(drawer.getByText("必须确认房间未被实际使用，才能撤销入住", { exact: true })).toBeVisible();
  await drawer.getByTestId("unused-room-confirmed").check();
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const review = page.getByRole("dialog", { name: "撤销入住", exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review).toContainText("在住");
  await expect(review).toContainText("入住已撤销");
  await expect(review).toContainText("当天及以后住宿库存立即恢复可售");
  await expect(review).toContainText("保留原入住记录");
  await expect(review).toContainText("退款参考");
  await expect(review).toContainText("尚未登记退款");
  await expect(review).not.toContainText(forbiddenOperatorText);
  await confirmLifecycle(page, review, "撤销入住");
  await expect(page.locator(".order-title-row").getByText("入住已撤销", { exact: true })).toBeVisible();
  await expect(page.getByTestId("check-in-result")).toContainText("按计划办理入住");
  await expect(page.getByTestId("check-in-revocation-result")).toContainText("撤销误办入住");

  const after = await orderView(page, stay);
  expect(after.order.status).toBe("CHECK_IN_REVOKED");
  expect(after.stay.status).toBe("CHECK_IN_REVOKED");
  expect(after.fulfillment.checkIn).toEqual(before.fulfillment.checkIn);
  expect(after.fulfillment.checkInRevocation).toMatchObject({
    recordingMode: "ON_SCHEDULE",
    plannedBusinessDate: fixture.businessDate,
    recordedBusinessDate: fixture.businessDate
  });
  expect(after.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(after.amounts.refundReferenceAmount.minorUnits).toBe(stay.recordedCollectionMinor);
  expect(after.pricingRevisions).toHaveLength(2);
  expect(after.collectionFacts.some((fact) => fact.fact_type === "REFUND")).toBe(false);
  await expectUnitAvailable(page, stay, fixture.businessDate);
});

test("4.5 member revoke restores consumed nights with immutable compensation records", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 12 member revoke coverage");
  await login(page);
  const stay = fixture.memberRevokeCheckIn;
  expect(stay.memberId).toBeTruthy();
  const memberBeforeResponse = await page.request.get(`/api/v1/members/${encodeURIComponent(stay.memberId!)}?propertyId=${propertyId}`);
  expect(memberBeforeResponse.ok()).toBe(true);
  const memberBefore = await memberBeforeResponse.json() as {
    availableBalance: Record<string, number>;
    ledger: Array<{ entry_type: string; quantity_delta: number; order_id: string | null; coverage_id: string | null }>;
  };
  const orderBefore = await orderView(page, stay);
  expect(orderBefore.coverageSet.length).toBeGreaterThan(0);
  expect(orderBefore.coverageSet.every((item) => item.status === "CONSUMED")).toBe(true);
  const originalConsumeFacts = memberBefore.ledger.filter((entry) => entry.order_id === stay.orderId && entry.entry_type === "CONSUME");
  expect(originalConsumeFacts).toHaveLength(orderBefore.coverageSet.length);

  await openOrder(page, stay);
  const drawer = await openLifecycleDrawer(page, "撤销入住", stay);
  const review = await continueLifecycleReview(page, drawer, "撤销入住", "误办会员入住，现场确认房间未被使用", { confirmUnusedRoom: true });
  await expect(review).toContainText(`补偿恢复本次入住已核销的 ${orderBefore.coverageSet.length} 晚权益`);
  await expect(review).toContainText("保留原入住记录和原会员核销历史");
  await confirmLifecycle(page, review, "撤销入住");

  const orderAfter = await orderView(page, stay);
  expect(orderAfter.coverageSet).toEqual(orderBefore.coverageSet);
  const memberAfterResponse = await page.request.get(`/api/v1/members/${encodeURIComponent(stay.memberId!)}?propertyId=${propertyId}`);
  expect(memberAfterResponse.ok()).toBe(true);
  const memberAfter = await memberAfterResponse.json() as typeof memberBefore;
  const consumeFactsAfter = memberAfter.ledger.filter((entry) => entry.order_id === stay.orderId && entry.entry_type === "CONSUME");
  const restoreFacts = memberAfter.ledger.filter((entry) => entry.order_id === stay.orderId && entry.entry_type === "RESTORE");
  expect(consumeFactsAfter).toEqual(originalConsumeFacts);
  expect(restoreFacts).toHaveLength(orderBefore.coverageSet.length);
  expect(restoreFacts.every((entry) => entry.quantity_delta === 1 && entry.coverage_id !== null)).toBe(true);
  expect(memberAfter.availableBalance).not.toEqual(memberBefore.availableBalance);
  await expect(page.locator("body")).not.toContainText(forbiddenOperatorText);
});

test("4.5 mobile cancellation uses the same Chinese preflight and review drawers", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 12 lifecycle coverage");
  await login(page);
  const stay = fixture.cancellation;
  await openOrder(page, stay);
  const drawer = await openLifecycleDrawer(page, "取消订单", stay);
  const box = await drawer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual((page.viewportSize()?.width ?? 0) - 2);
  expect(box!.height).toBeGreaterThanOrEqual((page.viewportSize()?.height ?? 0) - 2);
  const review = await continueLifecycleReview(page, drawer, "取消订单", "手机端确认住客取消住宿");
  await expect(review).toContainText("退款参考");
  await expect(review).toContainText("不会自动退款");
  await confirmLifecycle(page, review, "取消订单");
  await expect(page.locator(".order-title-row").getByText("已取消", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(forbiddenOperatorText);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
